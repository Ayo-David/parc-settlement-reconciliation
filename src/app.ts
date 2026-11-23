import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import helmet from "helmet";
import { z } from "zod";
import { createAdminRouter } from "./http/admin-router.js";
import { createSettlementRouter } from "./http/settlement-router.js";
import { StatementStoreUnavailableError } from "./runtime/statement-store.js";
import {
  ParcAuthError,
  type AccessPolicy,
} from "./security/parc-service-auth.js";
import type { SettlementReadService } from "./services/read-service.js";
import type { SettlementAdminService } from "./services/admin-reports.js";
import {
  type AdminExportService,
  ExportError,
} from "./services/export-service.js";
import type { PostingService } from "./services/posting-service.js";
import type { ReconciliationService } from "./services/reconciliation-service.js";
import type { StatementService } from "./services/statement-service.js";
import { SettlementError } from "./services/support.js";

export interface SettlementAccess {
  require(policy: AccessPolicy): RequestHandler;
}

export interface SettlementAppInput {
  access: SettlementAccess;
  statements: StatementService;
  reconciliation: ReconciliationService;
  postings: PostingService;
  reads: SettlementReadService;
  /** CB-7 slice D (D191): summary, report and exports. */
  admin: SettlementAdminService;
  exports: AdminExportService;
  /** Readiness: the database answers. */
  ready?: () => Promise<void>;
}

export function createApp(input: SettlementAppInput) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  // A statement is at most 1 MiB, so at most ~1.4 MB as base64 (D180).
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "parc-settlement-reconciliation" });
  });
  app.get("/ready", (_request, response) => {
    void (input.ready ?? (() => Promise.resolve()))().then(
      () => response.json({ status: "ready" }),
      () => response.status(503).json({ status: "unavailable" }),
    );
  });
  app.use(
    createSettlementRouter({
      statements: input.statements,
      reconciliation: input.reconciliation,
      postings: input.postings,
      reads: input.reads,
      require: (policy) => input.access.require(policy),
    }),
  );
  app.use(
    createAdminRouter({
      admin: input.admin,
      exports: input.exports,
      require: (policy) => input.access.require(policy),
    }),
  );
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      // Express identifies error handlers by arity.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: NextFunction,
    ) => {
      if (error instanceof z.ZodError)
        return response
          .status(400)
          .json({ code: "INVALID_REQUEST", details: error.flatten() });
      if (error instanceof ParcAuthError)
        return response
          .status(error.status)
          .json({ code: error.code, message: error.message });
      if (error instanceof ExportError)
        return response.status(error.status).json({
          code: error.code,
          message: "The export request was refused",
        });
      if (error instanceof SettlementError)
        return response.status(error.status).json({
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      if (error instanceof StatementStoreUnavailableError)
        return response
          .status(503)
          .json({ code: "STATEMENT_STORE_UNAVAILABLE" });
      const status = (error as { status?: unknown; type?: unknown }).status;
      if (status === 413)
        return response.status(413).json({ code: "PAYLOAD_TOO_LARGE" });
      if (
        status === 400 &&
        (error as { type?: unknown }).type === "entity.parse.failed"
      )
        return response.status(400).json({ code: "INVALID_JSON" });
      console.error(
        JSON.stringify({
          level: "error",
          message: "Unhandled request error",
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return response.status(500).json({ code: "INTERNAL_ERROR" });
    },
  );
  return app;
}
