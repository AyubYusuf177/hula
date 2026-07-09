import express, { type Express } from "express";

import { healthRouter } from "./routes/health";
import { sendblueWebhookRouter } from "./routes/webhooks";

/**
 * Builds the Express application. Kept separate from `index.ts` so the app can
 * be imported for tests without starting a listener.
 */
export function createApp(): Express {
  const app = express();

  app.use(express.json());

  // Routes
  app.use(healthRouter);
  app.use(sendblueWebhookRouter);

  return app;
}
