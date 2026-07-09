import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./utils/logger";

/**
 * Server entrypoint. Validates env (on import of ./config/env), builds the app,
 * and starts listening.
 */
function main(): void {
  const app = createApp();

  app.listen(env.PORT, () => {
    logger.info("hula-server started", {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
    });
  });
}

main();
