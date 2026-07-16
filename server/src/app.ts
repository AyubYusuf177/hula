import express, { type Express } from "express";

import { asanaRouter } from "./routes/asana";

import { gmailRouter } from "./routes/gmail";
import { googleCalendarRouter } from "./routes/googleCalendar";
import { healthRouter } from "./routes/health";
import { linkSessionsRouter } from "./routes/linkSessions";
import { meRouter } from "./routes/me";
import { todoistRouter } from "./routes/todoist";
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
  app.use(linkSessionsRouter);
  // Provider-specific Google Calendar + Gmail + Todoist routes must precede the
  // generic `/v1/me/integrations/:provider*` routes in meRouter so they aren't
  // captured as a provider slug.
  app.use(googleCalendarRouter);
  app.use(gmailRouter);
  app.use(todoistRouter);
  app.use(asanaRouter);
  app.use(meRouter);
  app.use(sendblueWebhookRouter);

  return app;
}
