import { randomUUID } from "node:crypto";
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";
import {
  ParcAuthError,
  principalOf,
  type AccessPolicy,
} from "../security/parc-service-auth.js";
import {
  type SettlementAdminService,
  settlementReports,
} from "../services/admin-reports.js";
import {
  type AdminExportService,
  exportBody,
} from "../services/export-service.js";
import {
  maximumReportDays,
  reportDays,
  reportGranularities,
} from "../services/report-window.js";
import { SettlementError } from "../services/support.js";

/**
 * CB-7 slice D (D191): the Home overview figures, the operations report and
 * the breaks export, for delegated administrator tokens through the Admin BFF.
 * The summary needs settlement.reconciliation.read, the report
 * settlement.reports.read (report.read) and exports settlement.exports.write
 * (report.export), as Ledger's equivalents did.
 */
const admin = (scope: string): AccessPolicy => ({
  scopes: [scope],
  kinds: ["delegated"],
  subjectTypes: ["ADMINISTRATOR"],
  actors: ["parc-admin-bff"],
});
export const settlementAdminPolicies = {
  summary: admin("settlement.reconciliation.read"),
  reports: admin("settlement.reports.read"),
  exports: admin("settlement.exports.write"),
} satisfies Record<string, AccessPolicy>;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    message: "Invalid date",
  });
const reportQuery = z
  .object({
    from: date,
    to: date,
    granularity: z.enum(reportGranularities).default("DAY"),
    timezone: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/)
      .optional(),
  })
  .strict()
  .refine((value) => value.to >= value.from, {
    message: "to must not be before from",
    path: ["to"],
  })
  .refine((value) => reportDays(value.from, value.to) <= maximumReportDays, {
    message: `A report covers at most ${String(maximumReportDays)} days`,
    path: ["to"],
  });

export function createAdminRouter(input: {
  admin: SettlementAdminService;
  exports: AdminExportService;
  require: (policy: AccessPolicy) => RequestHandler;
}): Router {
  const router = Router();
  const { require } = input;

  router.get(
    "/internal/v1/summary",
    require(settlementAdminPolicies.summary),
    route(async (request, response) => {
      response.json(await input.admin.summary(tenant(request)));
    }),
  );
  router.get(
    "/internal/v1/admin/reports/:report",
    require(settlementAdminPolicies.reports),
    route(async (request, response) => {
      const report = z.enum(settlementReports).safeParse(request.params.report);
      if (!report.success)
        throw new SettlementError(404, "REPORT_NOT_FOUND", "No such report");
      const query = reportQuery.parse(request.query);
      response.json(
        await input.admin.report(report.data, {
          tenantId: tenant(request),
          from: query.from,
          to: query.to,
          granularity: query.granularity,
          ...(query.timezone ? { timezone: query.timezone } : {}),
        }),
      );
    }),
  );
  router.post(
    "/internal/v1/admin/exports",
    require(settlementAdminPolicies.exports),
    route(async (request, response) => {
      const body = exportBody.parse(request.body);
      const result = await input.exports.create({
        tenantId: tenant(request),
        administratorId: administrator(request),
        kind: body.kind,
        request: {
          from: body.from,
          to: body.to,
          ...(body.timezone ? { timezone: body.timezone } : {}),
          ...(body.status ? { status: body.status } : {}),
        },
        reasonCode: body.reason_code,
        idempotencyKey: idempotencyKey(request),
        // No settlement export is customer-level.
        customerExportsAllowed: false,
      });
      response.status(result.replayed ? 200 : 201).json(result);
    }),
  );
  router.get(
    "/internal/v1/admin/exports",
    require(settlementAdminPolicies.exports),
    route(async (request, response) => {
      z.object({}).strict().parse(request.query);
      response.json(await input.exports.list(tenant(request)));
    }),
  );
  router.get(
    "/internal/v1/admin/exports/:id/download",
    require(settlementAdminPolicies.exports),
    route(async (request, response) => {
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success)
        throw new SettlementError(404, "EXPORT_NOT_FOUND", "No such export");
      const header = request.header("x-correlation-id");
      const file = await input.exports.download({
        tenantId: tenant(request),
        exportId: id.data,
        administratorId: administrator(request),
        correlationId:
          header && z.string().uuid().safeParse(header).success
            ? header
            : randomUUID(),
      });
      response
        .type("text/csv; charset=utf-8")
        .setHeader(
          "Content-Disposition",
          `attachment; filename="${file.filename}"`,
        )
        .setHeader("X-Content-SHA256", file.sha256)
        .send(file.content);
    }),
  );
  return router;
}

function tenant(request: Request): string {
  const principal = principalOf(request);
  if (principal.tenantId === null)
    throw new ParcAuthError(
      403,
      "TENANT_REQUIRED",
      "A tenant-bound token is required",
    );
  return principal.tenantId;
}

function administrator(request: Request): string {
  const subject = principalOf(request).subject;
  if (!subject)
    throw new ParcAuthError(
      403,
      "SUBJECT_REQUIRED",
      "An administrator is required",
    );
  return subject.id;
}

function idempotencyKey(request: Request): string {
  const key = request.header("idempotency-key");
  if (!key || key.length > 200)
    throw new SettlementError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key is required",
    );
  return key;
}

function route(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store");
    void handler(request, response).catch(next);
  };
}
