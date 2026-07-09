import { Router } from "express";

/**
 * Health route. Returns a tiny JSON payload so uptime checks and local dev can
 * confirm the server is running.
 */
export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({ ok: true, service: "hula-server" });
});
