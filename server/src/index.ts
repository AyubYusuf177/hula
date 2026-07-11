import { createApp } from "./app";
import { env } from "./config/env";
import { startReminderWorker } from "./reminders/worker";
import { logger } from "./utils/logger";

/**
 * Server entrypoint. Validates env (on import of ./config/env), builds the app,
 * starts listening, and starts the background reminder worker (Section 9).
 */
function main(): void {
  const app = createApp();

  app.listen(env.PORT, () => {
    logger.info("hula-server started", {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
    });
    // Begin delivering due reminders proactively. No-op when DATABASE_URL is
    // unset; safe to call once here on boot.
    startReminderWorker();
  });
}

main();
