# Live Event Order Ops Simulator

A lightweight backend system that simulates ticket order operations after checkout for a marketplace like StubHub.

## What is included

- **Order state machine** for payment, fulfillment, shipping, refunds, and replacements
- **Event-driven processing** with a background job queue and restart-safe JSON persistence
- **Retry logic + idempotency** for safe replayable operations
- **Operational dashboard** for active orders, failed tasks, latency, throughput, and live alerts
- **Prometheus-compatible metrics endpoint** for external observability tooling
- **Optional support assistant endpoint** that suggests next-best actions for ops teams

## Tech stack

- Node.js
- TypeScript
- Express
- Static HTML dashboard

## Run locally

```bash
npm install
npm run dev
```

Then open:

- `http://localhost:3000` for the dashboard
- `http://localhost:3000/api/metrics` for JSON metrics

## Environment options

- `PORT` - server port (default `3000`)
- `SIMULATED_FAILURE_RATE` - transient background-job failure rate from `0` to `1` (default `0.15`)
- `SIMULATED_MIN_DELAY_MS` - minimum processing latency for background jobs (default `200`)
- `SIMULATED_MAX_DELAY_MS` - maximum processing latency for background jobs (default `700`)
- `SIMULATOR_PERSISTENCE` - set to `0` to disable disk-backed state snapshots

Example:

```bash
$env:SIMULATED_FAILURE_RATE=0.05
npm run dev
```

## Test the project

```bash
npm test
```

## Clean generated files

```bash
npm run clean
```

This removes compiled output in `dist/` and the local runtime snapshot at `data/simulator-state.json`.

The regression tests cover:

- order creation
- idempotent replay behavior
- payment to delivery workflow
- refund workflow and assistant guidance

## Deploy on Render

This repo includes `render.yaml` for one-click deployment.

### Render settings

- **Runtime:** Node
- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/api/health`

### Quick deploy

Open:

```text
https://render.com/deploy?repo=https://github.com/jems0906/EncoreOps
```

> `SIMULATOR_PERSISTENCE` is set to `0` for Render because the default web-service filesystem is ephemeral.

## Docker

```bash
docker build -t encoreops .
docker run -p 3000:3000 encoreops
```

## Main API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/orders` | Create a new simulated order |
| `GET` | `/api/orders` | List orders |
| `GET` | `/api/orders/:orderId` | Fetch a single order |
| `POST` | `/api/orders/:orderId/payment-confirmed` | Confirm payment and queue fulfillment |
| `POST` | `/api/orders/:orderId/delivery-update` | Apply shipping or delivery ops updates |
| `POST` | `/api/orders/:orderId/refund-request` | Queue a refund workflow |
| `POST` | `/api/orders/:orderId/replacement-request` | Queue a replacement workflow |
| `GET` | `/api/ops/failed-jobs` | Inspect failed background jobs |
| `GET` | `/api/ops/dead-letters` | Inspect dead-letter queue contents |
| `DELETE` | `/api/ops/dead-letters` | Clear the dead-letter queue |
| `GET` | `/api/ops/alerts` | View active operational alerts |
| `POST` | `/api/ops/jobs/:jobId/retry` | Retry a failed job |
| `GET` | `/api/ops/assistant/:orderId` | Get next-best support guidance |
| `GET` | `/api/metrics` | View throughput, latency, and failure metrics |
| `GET` | `/api/metrics/prometheus` | Export metrics in Prometheus text format |

## Design notes

- Orders are kept in memory and snapshotted to `data/simulator-state.json` so the simulator can recover after a restart.
- Background jobs simulate asynchronous ops workflows.
- `X-Idempotency-Key` is supported on `POST` requests.
- Demo orders are seeded only when no persisted state is present.

## Example flow

1. Create an order.
2. Confirm payment.
3. The worker asynchronously fulfills digital or shipped delivery.
4. Trigger a refund or replacement request if support intervention is needed.
5. Observe retry behavior, failed jobs, and metrics in the dashboard.
