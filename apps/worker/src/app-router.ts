/**
 * Every HTTP route of the Worker, in one place, so tests can inspect the real registrations (for
 * example: the only CSRF-exempt route is the signed Revolut webhook).
 */
import { registerAuthRoutes } from "./auth/routes";
import { registerUserRoutes } from "./auth/users-routes";
import { registerExactRoutes } from "./exact/routes";
import { registerSyncRoutes } from "./exact/sync-routes";
import { registerJobRoutes } from "./jobs/routes";
import { registerApprovalsRoutes } from "./read/approvals-routes";
import { registerBankRoutes } from "./read/bank-routes";
import { registerFxRoutes } from "./read/fx-routes";
import { registerLedgerRoutes } from "./read/ledger-routes";
import { registerReadRoutes } from "./read/routes";
import { registerRevolutRoutes } from "./revolut/routes";
import { registerRevolutWebhookRoute } from "./revolut/webhook-route";
import { Router } from "./router";

export function buildRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerUserRoutes(router);
  registerExactRoutes(router);
  registerRevolutRoutes(router);
  registerRevolutWebhookRoute(router);
  registerBankRoutes(router);
  registerSyncRoutes(router);
  registerReadRoutes(router);
  registerLedgerRoutes(router);
  registerFxRoutes(router);
  registerApprovalsRoutes(router);
  registerJobRoutes(router);
  return router;
}
