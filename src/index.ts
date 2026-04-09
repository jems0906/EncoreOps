import { resetSimulatorState, startServer } from "./simulator.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

resetSimulatorState({
  seedDemoOrders: true,
  failureRate: Number.parseFloat(process.env.SIMULATED_FAILURE_RATE ?? "0.15"),
  processingDelayMinMs: Number.parseInt(process.env.SIMULATED_MIN_DELAY_MS ?? "200", 10),
  processingDelayMaxMs: Number.parseInt(process.env.SIMULATED_MAX_DELAY_MS ?? "700", 10),
});

startServer(port);
