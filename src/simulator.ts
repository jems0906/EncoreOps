import cors from "cors";
import express, { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";

export type DeliveryMethod = "digital" | "shipping";
export type Actor = "customer" | "ops" | "system";
export type JobType = "fulfillment" | "refund" | "replacement";
export type OrderState =
  | "CREATED"
  | "PAYMENT_CONFIRMED"
  | "FULFILLMENT_IN_PROGRESS"
  | "DIGITAL_DELIVERED"
  | "SHIPPED"
  | "DELIVERED"
  | "REFUND_REQUESTED"
  | "REFUNDED"
  | "REPLACEMENT_REQUESTED"
  | "REPLACEMENT_FULFILLED";

export interface HistoryEvent {
  at: string;
  actor: Actor;
  type: string;
  message: string;
}

export interface Order {
  id: string;
  buyerName: string;
  eventName: string;
  ticketCount: number;
  totalPrice: number;
  deliveryMethod: DeliveryMethod;
  state: OrderState;
  createdAt: string;
  updatedAt: string;
  lastLatencyMs?: number;
  history: HistoryEvent[];
}

export interface Job {
  id: string;
  orderId: string;
  type: JobType;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
  scheduledAt: number;
  payload?: Record<string, unknown>;
  lastError?: string;
}

interface StoredResponse {
  status: number;
  body: unknown;
}

export interface SimulatorOptions {
  failureRate?: number;
  processingDelayMinMs?: number;
  processingDelayMaxMs?: number;
  seedDemoOrders?: boolean;
  loadPersistedState?: boolean;
  persistenceEnabled?: boolean;
}

interface SimulatorMetrics {
  acceptedEvents: number;
  processedJobs: number;
  failedJobCount: number;
  retriedJobs: number;
  totalProcessingMs: number;
  latencySamples: number[];
  completionTimestamps: number[];
}

interface PersistedState {
  savedAt: string;
  orders: Order[];
  jobQueue: Job[];
  failedJobs: Job[];
  idempotencyEntries: Array<[string, StoredResponse]>;
  metrics: SimulatorMetrics;
}

interface OpsAlert {
  code: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  detail: string;
}

const DEFAULT_FAILURE_RATE = Number.parseFloat(process.env.SIMULATED_FAILURE_RATE ?? "0.15");
const DEFAULT_MIN_DELAY_MS = Number.parseInt(process.env.SIMULATED_MIN_DELAY_MS ?? "200", 10);
const DEFAULT_MAX_DELAY_MS = Number.parseInt(process.env.SIMULATED_MAX_DELAY_MS ?? "700", 10);
const terminalStates = new Set<OrderState>(["DIGITAL_DELIVERED", "DELIVERED", "REFUNDED", "REPLACEMENT_FULFILLED"]);
const persistenceFilePath = path.join(process.cwd(), "data", "simulator-state.json");

const allowedTransitions: Record<OrderState, OrderState[]> = {
  CREATED: ["PAYMENT_CONFIRMED"],
  PAYMENT_CONFIRMED: ["FULFILLMENT_IN_PROGRESS", "SHIPPED", "DIGITAL_DELIVERED", "REFUND_REQUESTED"],
  FULFILLMENT_IN_PROGRESS: ["DIGITAL_DELIVERED", "SHIPPED", "REFUND_REQUESTED"],
  DIGITAL_DELIVERED: ["REFUND_REQUESTED", "REPLACEMENT_REQUESTED"],
  SHIPPED: ["DELIVERED", "REFUND_REQUESTED", "REPLACEMENT_REQUESTED"],
  DELIVERED: ["REFUND_REQUESTED", "REPLACEMENT_REQUESTED"],
  REFUND_REQUESTED: ["REFUNDED"],
  REFUNDED: [],
  REPLACEMENT_REQUESTED: ["REPLACEMENT_FULFILLED"],
  REPLACEMENT_FULFILLED: ["DELIVERED", "REFUND_REQUESTED"],
};

export const app = express();
const orders = new Map<string, Order>();
const jobQueue: Job[] = [];
const failedJobs: Job[] = [];
const idempotencyStore = new Map<string, StoredResponse>();

const metrics: SimulatorMetrics = {
  acceptedEvents: 0,
  processedJobs: 0,
  failedJobCount: 0,
  retriedJobs: 0,
  totalProcessingMs: 0,
  latencySamples: [] as number[],
  completionTimestamps: [] as number[],
};

let failureRate = DEFAULT_FAILURE_RATE;
let processingDelayMinMs = DEFAULT_MIN_DELAY_MS;
let processingDelayMaxMs = DEFAULT_MAX_DELAY_MS;
let persistenceEnabled = process.env.SIMULATOR_PERSISTENCE !== "0";
let workerBusy = false;
let workerTimer: NodeJS.Timeout | undefined;

function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}_${Date.now().toString(36)}`;
}

function getPersistedState(): PersistedState {
  return {
    savedAt: new Date().toISOString(),
    orders: [...orders.values()],
    jobQueue: [...jobQueue],
    failedJobs: [...failedJobs],
    idempotencyEntries: [...idempotencyStore.entries()],
    metrics: {
      acceptedEvents: metrics.acceptedEvents,
      processedJobs: metrics.processedJobs,
      failedJobCount: metrics.failedJobCount,
      retriedJobs: metrics.retriedJobs,
      totalProcessingMs: metrics.totalProcessingMs,
      latencySamples: [...metrics.latencySamples],
      completionTimestamps: [...metrics.completionTimestamps],
    },
  };
}

function hydratePersistedState(snapshot: PersistedState): void {
  orders.clear();
  for (const order of snapshot.orders ?? []) {
    orders.set(order.id, order);
  }

  jobQueue.length = 0;
  jobQueue.push(...(snapshot.jobQueue ?? []));

  failedJobs.length = 0;
  failedJobs.push(...(snapshot.failedJobs ?? []));

  idempotencyStore.clear();
  for (const [key, value] of snapshot.idempotencyEntries ?? []) {
    idempotencyStore.set(key, value);
  }

  metrics.acceptedEvents = snapshot.metrics?.acceptedEvents ?? 0;
  metrics.processedJobs = snapshot.metrics?.processedJobs ?? 0;
  metrics.failedJobCount = snapshot.metrics?.failedJobCount ?? 0;
  metrics.retriedJobs = snapshot.metrics?.retriedJobs ?? 0;
  metrics.totalProcessingMs = snapshot.metrics?.totalProcessingMs ?? 0;
  metrics.latencySamples.length = 0;
  metrics.latencySamples.push(...(snapshot.metrics?.latencySamples ?? []));
  metrics.completionTimestamps.length = 0;
  metrics.completionTimestamps.push(...(snapshot.metrics?.completionTimestamps ?? []));
}

function persistState(): void {
  if (!persistenceEnabled) {
    return;
  }

  const directory = path.dirname(persistenceFilePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempPath = `${persistenceFilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(getPersistedState(), null, 2), "utf8");
  fs.renameSync(tempPath, persistenceFilePath);
}

function loadPersistedState(): boolean {
  if (!persistenceEnabled || !fs.existsSync(persistenceFilePath)) {
    return false;
  }

  try {
    const raw = fs.readFileSync(persistenceFilePath, "utf8");
    const snapshot = JSON.parse(raw) as PersistedState;
    hydratePersistedState(snapshot);
    return true;
  } catch (error) {
    console.warn("Unable to load persisted simulator state:", error);
    return false;
  }
}

function addHistory(order: Order, type: string, message: string, actor: Actor = "system"): void {
  order.history.unshift({
    at: new Date().toISOString(),
    actor,
    type,
    message,
  });
  order.updatedAt = new Date().toISOString();
}

function transitionOrder(order: Order, nextState: OrderState, message: string, actor: Actor = "system"): void {
  if (order.state === nextState) {
    addHistory(order, "noop", `Idempotent replay ignored for ${nextState}.`, actor);
    return;
  }

  const allowed = allowedTransitions[order.state] ?? [];
  if (!allowed.includes(nextState)) {
    throw new Error(`Invalid state transition: ${order.state} -> ${nextState}`);
  }

  order.state = nextState;
  addHistory(order, "state-change", message, actor);
  persistState();
}

function serializeOrder(order: Order): Order & { nextBestActions: string[] } {
  return {
    ...order,
    nextBestActions: getNextBestActions(order),
  };
}

function createOrder(input: {
  buyerName?: string;
  eventName?: string;
  ticketCount?: number;
  totalPrice?: number;
  deliveryMethod?: DeliveryMethod;
}): Order {
  const now = new Date().toISOString();
  const ticketCount = Math.max(1, Number(input.ticketCount ?? 2));
  const order: Order = {
    id: randomId("ord"),
    buyerName: input.buyerName?.trim() || "Guest Buyer",
    eventName: input.eventName?.trim() || "Live Event",
    ticketCount,
    totalPrice: Number(input.totalPrice ?? ticketCount * 85),
    deliveryMethod: input.deliveryMethod === "shipping" ? "shipping" : "digital",
    state: "CREATED",
    createdAt: now,
    updatedAt: now,
    history: [],
  };

  addHistory(order, "order-created", "Order created and awaiting payment confirmation.", "customer");
  orders.set(order.id, order);
  persistState();
  return order;
}

function enqueueJob(orderId: string, type: JobType, payload?: Record<string, unknown>): Job {
  const job: Job = {
    id: randomId("job"),
    orderId,
    type,
    attempt: 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    scheduledAt: Date.now(),
    payload,
  };

  jobQueue.push(job);
  metrics.acceptedEvents += 1;

  const order = orders.get(orderId);
  if (order) {
    addHistory(order, "job-enqueued", `Background job queued for ${type}.`, "system");
  }

  persistState();
  return job;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[Math.min(position, sorted.length - 1)];
}

function pruneCompletions(): void {
  const cutoff = Date.now() - 60_000;
  metrics.completionTimestamps = metrics.completionTimestamps.filter((timestamp) => timestamp >= cutoff);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getProcessingDelay(): number {
  const min = Math.max(0, processingDelayMinMs);
  const max = Math.max(min, processingDelayMaxMs);
  return min + Math.floor(Math.random() * (max - min + 1));
}

function getOpsAlerts(): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  const customerImpactOrders = [...orders.values()].filter(
    (order) => order.state === "REFUND_REQUESTED" || order.state === "REPLACEMENT_REQUESTED",
  );
  const slowOrders = [...orders.values()].filter((order) => {
    const awaitingOps = order.state === "PAYMENT_CONFIRMED" || order.state === "FULFILLMENT_IN_PROGRESS";
    return awaitingOps && Date.now() - Date.parse(order.updatedAt) > 15_000;
  });

  if (failedJobs.length > 0) {
    alerts.push({
      code: "DLQ_BACKLOG",
      severity: "critical",
      summary: `${failedJobs.length} dead-letter job(s) need intervention`,
      detail: "Review failed tasks and retry or clear them from the ops console.",
    });
  }

  if (customerImpactOrders.length > 0) {
    alerts.push({
      code: "CUSTOMER_IMPACT",
      severity: "critical",
      summary: `${customerImpactOrders.length} customer-impacting order(s) await action`,
      detail: "Refund or replacement requests are open and should be prioritized.",
    });
  }

  if (jobQueue.length >= 3) {
    alerts.push({
      code: "QUEUE_BACKLOG",
      severity: "warning",
      summary: `Queue backlog is elevated (${jobQueue.length} jobs)`,
      detail: "Worker throughput may need attention before the queue breaches SLA.",
    });
  }

  if (slowOrders.length > 0) {
    alerts.push({
      code: "SLOW_FULFILLMENT",
      severity: "warning",
      summary: `${slowOrders.length} order(s) are waiting longer than expected`,
      detail: "Investigate fulfillment latency or payment-to-delivery stalls.",
    });
  }

  return alerts;
}

function getMetricsSnapshot(): Record<string, unknown> {
  pruneCompletions();
  const orderList = [...orders.values()];
  const activeOrders = orderList.filter((order) => !terminalStates.has(order.state)).length;
  const averages = metrics.processedJobs === 0 ? 0 : metrics.totalProcessingMs / metrics.processedJobs;
  const alerts = getOpsAlerts();

  return {
    activeOrders,
    totalOrders: orderList.length,
    queueDepth: jobQueue.length,
    failedJobs: failedJobs.length,
    deadLetterDepth: failedJobs.length,
    alertCount: alerts.length,
    acceptedEvents: metrics.acceptedEvents,
    processedJobs: metrics.processedJobs,
    retriedJobs: metrics.retriedJobs,
    avgProcessingMs: Number(averages.toFixed(1)),
    p95ProcessingMs: percentile(metrics.latencySamples, 95),
    throughputPerMinute: metrics.completionTimestamps.length,
    simulatedFailureRate: failureRate,
    persistenceEnabled,
    persistedStatePath: persistenceFilePath,
  };
}

function renderPrometheusMetrics(): string {
  const snapshot = getMetricsSnapshot() as {
    activeOrders: number;
    totalOrders: number;
    queueDepth: number;
    failedJobs: number;
    deadLetterDepth: number;
    alertCount: number;
    processedJobs: number;
    retriedJobs: number;
    avgProcessingMs: number;
    p95ProcessingMs: number;
    throughputPerMinute: number;
  };

  const orderList = [...orders.values()];
  const stateLines = (Object.keys(allowedTransitions) as OrderState[])
    .map((state) => `encoreops_orders_by_state{state="${state}"} ${orderList.filter((order) => order.state === state).length}`)
    .join("\n");

  return [
    "# HELP encoreops_active_orders Number of active non-terminal orders.",
    "# TYPE encoreops_active_orders gauge",
    `encoreops_active_orders ${snapshot.activeOrders}`,
    "# HELP encoreops_total_orders Total orders tracked by the simulator.",
    "# TYPE encoreops_total_orders gauge",
    `encoreops_total_orders ${snapshot.totalOrders}`,
    "# HELP encoreops_queue_depth Current background job queue depth.",
    "# TYPE encoreops_queue_depth gauge",
    `encoreops_queue_depth ${snapshot.queueDepth}`,
    "# HELP encoreops_dead_letter_jobs Failed jobs in the dead-letter queue.",
    "# TYPE encoreops_dead_letter_jobs gauge",
    `encoreops_dead_letter_jobs ${snapshot.deadLetterDepth}`,
    "# HELP encoreops_alert_count Active operational alerts.",
    "# TYPE encoreops_alert_count gauge",
    `encoreops_alert_count ${snapshot.alertCount}`,
    "# HELP encoreops_processed_jobs Total processed background jobs.",
    "# TYPE encoreops_processed_jobs counter",
    `encoreops_processed_jobs ${snapshot.processedJobs}`,
    "# HELP encoreops_retried_jobs Total retried jobs.",
    "# TYPE encoreops_retried_jobs counter",
    `encoreops_retried_jobs ${snapshot.retriedJobs}`,
    "# HELP encoreops_avg_processing_ms Average processing latency in milliseconds.",
    "# TYPE encoreops_avg_processing_ms gauge",
    `encoreops_avg_processing_ms ${snapshot.avgProcessingMs}`,
    "# HELP encoreops_p95_processing_ms 95th percentile processing latency in milliseconds.",
    "# TYPE encoreops_p95_processing_ms gauge",
    `encoreops_p95_processing_ms ${snapshot.p95ProcessingMs}`,
    "# HELP encoreops_throughput_per_minute Background jobs completed in the last minute.",
    "# TYPE encoreops_throughput_per_minute gauge",
    `encoreops_throughput_per_minute ${snapshot.throughputPerMinute}`,
    "# HELP encoreops_orders_by_state Orders grouped by workflow state.",
    "# TYPE encoreops_orders_by_state gauge",
    stateLines,
    "",
  ].join("\n");
}

export function configureSimulator(options: SimulatorOptions = {}): void {
  if (typeof options.failureRate === "number" && Number.isFinite(options.failureRate)) {
    failureRate = Math.min(1, Math.max(0, options.failureRate));
  }

  if (typeof options.processingDelayMinMs === "number" && Number.isFinite(options.processingDelayMinMs)) {
    processingDelayMinMs = Math.max(0, options.processingDelayMinMs);
  }

  if (typeof options.processingDelayMaxMs === "number" && Number.isFinite(options.processingDelayMaxMs)) {
    processingDelayMaxMs = Math.max(processingDelayMinMs, options.processingDelayMaxMs);
  }
}

export async function processNextJob(): Promise<void> {
  if (workerBusy) {
    return;
  }

  const nextIndex = jobQueue.findIndex((job) => job.scheduledAt <= Date.now());
  if (nextIndex === -1) {
    return;
  }

  workerBusy = true;
  const [job] = jobQueue.splice(nextIndex, 1);
  const startedAt = Date.now();

  try {
    const order = orders.get(job.orderId);
    if (!order) {
      throw new Error(`Order ${job.orderId} no longer exists.`);
    }

    await wait(getProcessingDelay());

    if (Math.random() < failureRate) {
      throw new Error(`Simulated transient ${job.type} failure.`);
    }

    if (job.type === "fulfillment") {
      if (order.state === "PAYMENT_CONFIRMED") {
        transitionOrder(order, "FULFILLMENT_IN_PROGRESS", "Ops picked up the order for fulfillment.", "system");
      }

      if (order.deliveryMethod === "digital") {
        transitionOrder(order, "DIGITAL_DELIVERED", "Digital tickets were delivered to the buyer.", "system");
      } else {
        transitionOrder(order, "SHIPPED", "Physical ticket package was shipped.", "ops");
      }
    }

    if (job.type === "refund") {
      transitionOrder(order, "REFUNDED", "Refund completed and customer notified.", "ops");
    }

    if (job.type === "replacement") {
      transitionOrder(order, "REPLACEMENT_FULFILLED", "Replacement tickets were fulfilled.", "ops");
    }

    const latency = Date.now() - startedAt;
    order.lastLatencyMs = latency;
    addHistory(order, "job-completed", `${job.type} completed in ${latency} ms.`, "system");

    metrics.processedJobs += 1;
    metrics.totalProcessingMs += latency;
    metrics.latencySamples.push(latency);
    metrics.completionTimestamps.push(Date.now());

    if (metrics.latencySamples.length > 250) {
      metrics.latencySamples.shift();
    }

    pruneCompletions();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error";
    job.lastError = message;

    const order = orders.get(job.orderId);
    if (order) {
      addHistory(order, "job-error", `${job.type} failed on attempt ${job.attempt}: ${message}`, "system");
    }

    if (job.attempt < job.maxAttempts) {
      job.attempt += 1;
      job.scheduledAt = Date.now() + job.attempt * 1_000;
      jobQueue.push(job);
      metrics.retriedJobs += 1;
    } else {
      failedJobs.unshift(job);
      metrics.failedJobCount += 1;
    }
  } finally {
    persistState();
    workerBusy = false;
  }
}

export async function processJobsUntilIdle(maxIterations = 20): Promise<number> {
  let processed = 0;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const hasDueJob = jobQueue.some((job) => job.scheduledAt <= Date.now());
    if (!hasDueJob) {
      break;
    }

    await processNextJob();
    processed += 1;
  }

  return processed;
}

function sendJsonWithIdempotency(req: Request, res: Response, status: number, body: Record<string, unknown>): Response {
  const key = req.header("x-idempotency-key");
  if (key) {
    idempotencyStore.set(key, { status, body });
    persistState();
  }

  return res.status(status).json(body);
}

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function getOrderOr404(req: Request, res: Response): Order | undefined {
  const order = orders.get(getRouteParam(req.params.orderId));
  if (!order) {
    res.status(404).json({ error: "Order not found." });
    return undefined;
  }
  return order;
}

function getNextBestActions(order: Order): string[] {
  switch (order.state) {
    case "CREATED":
      return ["Confirm payment", "Queue fulfillment"];
    case "PAYMENT_CONFIRMED":
      return ["Monitor fulfillment worker", "Watch for queue latency"];
    case "FULFILLMENT_IN_PROGRESS":
      return ["Track delivery ETA", "Escalate if it stalls"];
    case "SHIPPED":
      return ["Mark as delivered on confirmation", "Offer replacement if package is lost"];
    case "DIGITAL_DELIVERED":
      return ["Monitor buyer confirmation", "Open refund flow if inventory issue appears"];
    case "DELIVERED":
      return ["Handle post-delivery support only if needed"];
    case "REFUND_REQUESTED":
      return ["Prioritize refund queue", "Notify support if SLA is breached"];
    case "REPLACEMENT_REQUESTED":
      return ["Fulfill replacement inventory", "Keep original order visible for audit"];
    case "REPLACEMENT_FULFILLED":
      return ["Confirm buyer received replacement"];
    case "REFUNDED":
      return ["No action needed"];
    default:
      return ["Review manually"];
  }
}

function getAssistantSuggestion(order: Order): { priority: string; summary: string; nextBestActions: string[] } {
  const ageMs = Date.now() - Date.parse(order.updatedAt);

  if (order.state === "REFUND_REQUESTED") {
    return {
      priority: ageMs > 15_000 ? "high" : "normal",
      summary: "Customer is waiting on a refund. Keep the refund worker healthy and communicate status clearly.",
      nextBestActions: getNextBestActions(order),
    };
  }

  if (order.state === "REPLACEMENT_REQUESTED") {
    return {
      priority: "high",
      summary: "Replacement inventory is needed. Fulfill quickly to avoid missing the event date.",
      nextBestActions: getNextBestActions(order),
    };
  }

  return {
    priority: terminalStates.has(order.state) ? "low" : "normal",
    summary: "Order is progressing through the ops workflow normally.",
    nextBestActions: getNextBestActions(order),
  };
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));
app.use((req, res, next) => {
  if (req.method !== "POST") {
    next();
    return;
  }

  const key = req.header("x-idempotency-key");
  if (!key || !idempotencyStore.has(key)) {
    next();
    return;
  }

  const previous = idempotencyStore.get(key)!;
  const replayBody =
    typeof previous.body === "object" && previous.body !== null
      ? { ...(previous.body as Record<string, unknown>), idempotentReplay: true }
      : { data: previous.body, idempotentReplay: true };

  res.status(previous.status).json(replayBody);
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
});

app.get("/api/orders", (req, res) => {
  const stateFilter = typeof req.query.state === "string" ? req.query.state : undefined;
  const results = [...orders.values()]
    .filter((order) => !stateFilter || order.state === stateFilter)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(serializeOrder);

  res.json({ orders: results });
});

app.get("/api/orders/:orderId", (req, res) => {
  const order = getOrderOr404(req, res);
  if (!order) {
    return;
  }

  res.json({ order: serializeOrder(order) });
});

app.post("/api/orders", (req, res) => {
  const order = createOrder({
    buyerName: typeof req.body?.buyerName === "string" ? req.body.buyerName : undefined,
    eventName: typeof req.body?.eventName === "string" ? req.body.eventName : undefined,
    ticketCount: typeof req.body?.ticketCount === "number" ? req.body.ticketCount : undefined,
    totalPrice: typeof req.body?.totalPrice === "number" ? req.body.totalPrice : undefined,
    deliveryMethod: req.body?.deliveryMethod === "shipping" ? "shipping" : "digital",
  });

  sendJsonWithIdempotency(req, res, 201, { message: "Order created.", order: serializeOrder(order) });
});

app.post("/api/orders/:orderId/payment-confirmed", (req, res) => {
  const order = getOrderOr404(req, res);
  if (!order) {
    return;
  }

  try {
    transitionOrder(order, "PAYMENT_CONFIRMED", "Payment confirmation received from checkout.", "system");
    const job = enqueueJob(order.id, "fulfillment");
    sendJsonWithIdempotency(req, res, 202, {
      message: "Payment confirmed and fulfillment queued.",
      order: serializeOrder(order),
      job,
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to confirm payment." });
  }
});

app.post("/api/orders/:orderId/delivery-update", (req, res) => {
  const order = getOrderOr404(req, res);
  if (!order) {
    return;
  }

  const status = typeof req.body?.status === "string" ? req.body.status : "";
  const statusMap: Record<string, OrderState> = {
    shipped: "SHIPPED",
    delivered: "DELIVERED",
    digital_delivered: "DIGITAL_DELIVERED",
  };

  const nextState = statusMap[status];
  if (!nextState) {
    res.status(400).json({ error: "status must be shipped, delivered, or digital_delivered." });
    return;
  }

  try {
    transitionOrder(order, nextState, `Ops delivery update applied: ${status}.`, "ops");
    sendJsonWithIdempotency(req, res, 200, {
      message: "Delivery update applied.",
      order: serializeOrder(order),
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to update delivery status." });
  }
});

app.post("/api/orders/:orderId/refund-request", (req, res) => {
  const order = getOrderOr404(req, res);
  if (!order) {
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Customer requested a refund.";

  try {
    transitionOrder(order, "REFUND_REQUESTED", reason, "customer");
    const job = enqueueJob(order.id, "refund", { reason });
    sendJsonWithIdempotency(req, res, 202, {
      message: "Refund request accepted and queued.",
      order: serializeOrder(order),
      job,
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to request a refund." });
  }
});

app.post("/api/orders/:orderId/replacement-request", (req, res) => {
  const order = getOrderOr404(req, res);
  if (!order) {
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason : "Replacement requested by support.";

  try {
    transitionOrder(order, "REPLACEMENT_REQUESTED", reason, "ops");
    const job = enqueueJob(order.id, "replacement", { reason });
    sendJsonWithIdempotency(req, res, 202, {
      message: "Replacement request accepted and queued.",
      order: serializeOrder(order),
      job,
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Unable to request a replacement." });
  }
});

app.get("/api/ops/failed-jobs", (_req, res) => {
  res.json({ failedJobs, deadLetterDepth: failedJobs.length });
});

app.get("/api/ops/dead-letters", (_req, res) => {
  res.json({ deadLetters: failedJobs, count: failedJobs.length });
});

app.delete("/api/ops/dead-letters", (_req, res) => {
  const cleared = failedJobs.length;
  failedJobs.length = 0;
  persistState();
  res.json({ message: `Cleared ${cleared} dead-letter job(s).`, cleared });
});

app.get("/api/ops/alerts", (_req, res) => {
  res.json({ alerts: getOpsAlerts() });
});

app.post("/api/ops/jobs/:jobId/retry", (req, res) => {
  const jobId = getRouteParam(req.params.jobId);
  const jobIndex = failedJobs.findIndex((job) => job.id === jobId);
  if (jobIndex === -1) {
    res.status(404).json({ error: "Failed job not found." });
    return;
  }

  const [job] = failedJobs.splice(jobIndex, 1);
  job.attempt = 1;
  job.lastError = undefined;
  job.scheduledAt = Date.now();
  jobQueue.push(job);
  persistState();

  sendJsonWithIdempotency(req, res, 202, {
    message: "Failed job requeued.",
    job,
  });
});

app.get("/api/ops/assistant/:orderId", (req, res) => {
  const order = getOrderOr404(req, res);
  if (!order) {
    return;
  }

  res.json({
    orderId: order.id,
    suggestion: getAssistantSuggestion(order),
  });
});

app.get("/api/metrics", (_req, res) => {
  res.json(getMetricsSnapshot());
});

app.get("/api/metrics/prometheus", (_req, res) => {
  res.type("text/plain").send(renderPrometheusMetrics());
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

export function bootstrapDemoOrders(): void {
  if (orders.size > 0) {
    return;
  }

  const seeded = [
    createOrder({ buyerName: "Taylor", eventName: "Indie Night Live", ticketCount: 2, deliveryMethod: "digital", totalPrice: 190 }),
    createOrder({ buyerName: "Jordan", eventName: "Championship Finals", ticketCount: 4, deliveryMethod: "shipping", totalPrice: 640 }),
    createOrder({ buyerName: "Morgan", eventName: "Comedy Arena", ticketCount: 1, deliveryMethod: "digital", totalPrice: 95 }),
  ];

  for (const order of seeded) {
    transitionOrder(order, "PAYMENT_CONFIRMED", "Seeded demo payment confirmation.", "system");
    enqueueJob(order.id, "fulfillment");
  }
}

export function resetSimulatorState(options: SimulatorOptions = {}): void {
  orders.clear();
  jobQueue.length = 0;
  failedJobs.length = 0;
  idempotencyStore.clear();

  metrics.acceptedEvents = 0;
  metrics.processedJobs = 0;
  metrics.failedJobCount = 0;
  metrics.retriedJobs = 0;
  metrics.totalProcessingMs = 0;
  metrics.latencySamples.length = 0;
  metrics.completionTimestamps.length = 0;

  workerBusy = false;
  failureRate = DEFAULT_FAILURE_RATE;
  processingDelayMinMs = DEFAULT_MIN_DELAY_MS;
  processingDelayMaxMs = DEFAULT_MAX_DELAY_MS;
  persistenceEnabled = process.env.SIMULATOR_PERSISTENCE !== "0";

  if (typeof options.persistenceEnabled === "boolean") {
    persistenceEnabled = options.persistenceEnabled;
  }

  configureSimulator(options);

  const restored = options.loadPersistedState !== false && loadPersistedState();
  if (!restored && options.seedDemoOrders) {
    bootstrapDemoOrders();
  }

  persistState();
}

export function startBackgroundWorker(intervalMs = 250): void {
  if (workerTimer) {
    return;
  }

  workerTimer = setInterval(() => {
    void processNextJob();
  }, intervalMs);
}

export function stopBackgroundWorker(): void {
  if (!workerTimer) {
    return;
  }

  clearInterval(workerTimer);
  workerTimer = undefined;
}

export function startServer(port: number): void {
  startBackgroundWorker();
  app.listen(port, () => {
    console.log(`Live Event Order Ops Simulator running on http://localhost:${port}`);
  });
}
