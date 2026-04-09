import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import request from "supertest";

import { app, processJobsUntilIdle, resetSimulatorState, stopBackgroundWorker } from "./simulator.js";

beforeEach(() => {
  stopBackgroundWorker();
  resetSimulatorState({
    failureRate: 0,
    processingDelayMinMs: 0,
    processingDelayMaxMs: 0,
    seedDemoOrders: false,
    loadPersistedState: false,
    persistenceEnabled: false,
  });
});

test("creates an order and supports idempotent replay", async () => {
  const response = await request(app)
    .post("/api/orders")
    .set("X-Idempotency-Key", "same-create-key")
    .send({
      buyerName: "Test Buyer",
      eventName: "Verification Tour",
      ticketCount: 2,
      deliveryMethod: "digital",
    })
    .expect(201);

  assert.equal(response.body.order.buyerName, "Test Buyer");
  assert.equal(response.body.order.state, "CREATED");

  const replay = await request(app)
    .post("/api/orders")
    .set("X-Idempotency-Key", "same-create-key")
    .send({
      buyerName: "Ignored Replay",
      eventName: "Ignored Replay",
    })
    .expect(201);

  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.order.id, response.body.order.id);
});

test("processes payment confirmation into digital delivery", async () => {
  const created = await request(app)
    .post("/api/orders")
    .send({
      buyerName: "Workflow Buyer",
      eventName: "Ops Finals",
      ticketCount: 1,
      deliveryMethod: "digital",
    })
    .expect(201);

  const orderId = created.body.order.id;

  await request(app)
    .post(`/api/orders/${orderId}/payment-confirmed`)
    .send({})
    .expect(202);

  const processedCount = await processJobsUntilIdle();
  assert.ok(processedCount >= 1);

  const fetched = await request(app).get(`/api/orders/${orderId}`).expect(200);
  assert.equal(fetched.body.order.state, "DIGITAL_DELIVERED");

  const metrics = await request(app).get("/api/metrics").expect(200);
  assert.equal(metrics.body.queueDepth, 0);
  assert.ok(metrics.body.processedJobs >= 1);
});

test("supports refund workflow and assistant guidance", async () => {
  const created = await request(app)
    .post("/api/orders")
    .send({
      buyerName: "Refund Buyer",
      eventName: "Support Night",
      ticketCount: 2,
      deliveryMethod: "shipping",
    })
    .expect(201);

  const orderId = created.body.order.id;

  await request(app).post(`/api/orders/${orderId}/payment-confirmed`).send({}).expect(202);
  await processJobsUntilIdle();

  await request(app)
    .post(`/api/orders/${orderId}/refund-request`)
    .send({ reason: "Customer cannot attend." })
    .expect(202);

  await processJobsUntilIdle();

  const order = await request(app).get(`/api/orders/${orderId}`).expect(200);
  assert.equal(order.body.order.state, "REFUNDED");

  const assistant = await request(app).get(`/api/ops/assistant/${orderId}`).expect(200);
  assert.equal(assistant.body.orderId, orderId);
  assert.ok(Array.isArray(assistant.body.suggestion.nextBestActions));
});

test("restores persisted orders after a simulated restart", async () => {
  resetSimulatorState({
    failureRate: 0,
    processingDelayMinMs: 0,
    processingDelayMaxMs: 0,
    seedDemoOrders: false,
    loadPersistedState: false,
    persistenceEnabled: true,
  });

  const created = await request(app)
    .post("/api/orders")
    .send({
      buyerName: "Persistent Buyer",
      eventName: "Saved State Tour",
      ticketCount: 3,
      deliveryMethod: "digital",
    })
    .expect(201);

  const orderId = created.body.order.id;

  resetSimulatorState({
    failureRate: 0,
    processingDelayMinMs: 0,
    processingDelayMaxMs: 0,
    seedDemoOrders: false,
    loadPersistedState: true,
    persistenceEnabled: true,
  });

  const restored = await request(app).get(`/api/orders/${orderId}`).expect(200);
  assert.equal(restored.body.order.id, orderId);
  assert.equal(restored.body.order.buyerName, "Persistent Buyer");

  resetSimulatorState({
    failureRate: 0,
    processingDelayMinMs: 0,
    processingDelayMaxMs: 0,
    seedDemoOrders: false,
    loadPersistedState: false,
    persistenceEnabled: false,
  });
});

test("exposes ops alerts and Prometheus metrics", async () => {
  const created = await request(app)
    .post("/api/orders")
    .send({
      buyerName: "Alert Buyer",
      eventName: "Replacement Watch",
      ticketCount: 2,
      deliveryMethod: "digital",
    })
    .expect(201);

  const orderId = created.body.order.id;

  await request(app).post(`/api/orders/${orderId}/payment-confirmed`).send({}).expect(202);
  await processJobsUntilIdle();
  await request(app)
    .post(`/api/orders/${orderId}/replacement-request`)
    .send({ reason: "Customer needs a replacement." })
    .expect(202);

  const alerts = await request(app).get("/api/ops/alerts").expect(200);
  assert.ok(alerts.body.alerts.some((alert: { code: string }) => alert.code === "CUSTOMER_IMPACT"));

  const metrics = await request(app).get("/api/metrics/prometheus").expect(200);
  assert.match(metrics.headers["content-type"], /text\/plain/);
  assert.match(metrics.text, /encoreops_active_orders/);
  assert.match(metrics.text, /encoreops_alert_count/);
});
