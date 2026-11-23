/*
 * CB-7 slice D (D191): ported from parc-ledger
 * src/services/admin-export-service.ts (repositories cannot import from each
 * other); keep the two in step. Ledger's ADR-010 B design, in the settlement
 * schema.
 */
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { z } from "zod";
import { withTenantTransaction } from "../database/client.js";
import { maximumReportDays, reportDays } from "./report-window.js";

/** ADR-010 B: why an administrator takes data out of the console. */
export const exportReasonCodes = [
  "AUDIT_REQUEST",
  "RECONCILIATION",
  "REGULATORY_RETURN",
  "MANAGEMENT_REPORTING",
  "OTHER",
] as const;
export type ExportReasonCode = (typeof exportReasonCodes)[number];

export const maximumExportRows = 50_000;
const lifetimeHours = 24;

export interface ExportRequest {
  from: string;
  to: string;
  timezone?: string;
  status?: string;
}

export interface ExportKind {
  /** Rows about individual customers need report.export.customer as well. */
  customerLevel: boolean;
  /** The statuses the optional status filter accepts; none means no filter. */
  statuses?: readonly string[];
  columns: readonly string[];
  /** At most `limit` rows, each in column order. */
  rows: (
    tx: Knex.Transaction,
    tenantId: string,
    request: ExportRequest,
    limit: number,
  ) => Promise<(string | number | null)[][]>;
}

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
    "Invalid date",
  );

/** POST body: a kind, a period of whole days (at most 92) and a reason. */
export const exportBody = z
  .object({
    kind: z.string().min(1).max(64),
    from: date,
    to: date,
    timezone: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/)
      .optional(),
    status: z
      .string()
      .regex(/^[A-Z_]{1,40}$/)
      .optional(),
    reason_code: z.enum(exportReasonCodes),
  })
  .strict()
  .refine((value) => value.to >= value.from, {
    message: "to must not be before from",
    path: ["to"],
  })
  .refine((value) => reportDays(value.from, value.to) <= maximumReportDays, {
    message: `An export covers at most ${String(maximumReportDays)} days`,
    path: ["to"],
  });

/** How often the workers clear expired export files. */
export const exportPurgeIntervalMs = 60 * 60 * 1000;

/**
 * Clears the files of exports past their 24 hours (all tenants, through the
 * SECURITY DEFINER function granted to the worker role). Returns the count.
 */
export async function purgeExpiredExports(database: Knex): Promise<number> {
  const result = await database.raw<{ rows: { purged: number }[] }>(
    "SELECT settlement.purge_expired_admin_exports() AS purged",
  );
  return result.rows[0]?.purged ?? 0;
}

export class ExportError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

interface ExportRow {
  id: string;
  kind: string;
  parameters: ExportRequest;
  status: string;
  requested_by: string;
  reason_code: string;
  request_hash: string;
  row_count: number | null;
  byte_size: number | null;
  content_sha256: string | null;
  failure_code: string | null;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date;
  downloads?: number;
}

/**
 * A cell as CSV. Text a spreadsheet would run as a formula (=, +, -, @, tab,
 * carriage return) is prefixed with an apostrophe; plain integers, such as
 * minor-unit amounts, are left as numbers.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (!/^-?\d+$/.test(text) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * ADR-010 B administrator exports, kept in the database. An export is made
 * when it is requested (at most 50,000 rows, so it stays quick), stored with
 * its SHA-256, and downloadable for 24 hours; the worker then clears the file
 * (`purge_expired_admin_exports`). Every download is recorded. All under
 * tenant RLS.
 */
export class AdminExportService {
  public constructor(
    private readonly database: Knex,
    private readonly kinds: Readonly<Record<string, ExportKind>>,
    private readonly service: string,
  ) {}

  public async create(input: {
    tenantId: string;
    administratorId: string;
    kind: string;
    request: ExportRequest;
    reasonCode: ExportReasonCode;
    idempotencyKey: string;
    customerExportsAllowed: boolean;
  }) {
    const kind = this.kinds[input.kind];
    if (kind === undefined) throw new ExportError(422, "UNKNOWN_EXPORT");
    if (kind.customerLevel && !input.customerExportsAllowed)
      throw new ExportError(403, "CUSTOMER_EXPORT_FORBIDDEN");
    if (
      input.request.status !== undefined &&
      !(kind.statuses ?? []).includes(input.request.status)
    )
      throw new ExportError(422, "EXPORT_STATUS_INVALID");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          kind: input.kind,
          request: input.request,
          reason: input.reasonCode,
        }),
      )
      .digest("hex");
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [
        `${input.tenantId}:admin-export:${input.idempotencyKey}`,
      ]);
      const existing = await tx("admin_exports")
        .where({
          tenant_id: input.tenantId,
          idempotency_key: input.idempotencyKey,
        })
        .first<ExportRow | undefined>(this.columns());
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash)
          throw new ExportError(409, "IDEMPOTENCY_CONFLICT");
        return { ...this.view(existing), replayed: true };
      }
      const rows = await kind.rows(
        tx,
        input.tenantId,
        input.request,
        maximumExportRows + 1,
      );
      const tooMany = rows.length > maximumExportRows;
      const content = tooMany
        ? null
        : [kind.columns, ...rows]
            .map((row) => row.map(csvCell).join(","))
            .join("\r\n") + "\r\n";
      const [row] = await tx("admin_exports")
        .insert({
          tenant_id: input.tenantId,
          kind: input.kind,
          parameters: JSON.stringify(input.request),
          status: tooMany ? "FAILED" : "READY",
          requested_by: input.administratorId,
          reason_code: input.reasonCode,
          idempotency_key: input.idempotencyKey,
          request_hash: requestHash,
          row_count: tooMany ? null : rows.length,
          byte_size: content === null ? null : Buffer.byteLength(content),
          content,
          content_sha256:
            content === null
              ? null
              : createHash("sha256").update(content).digest("hex"),
          failure_code: tooMany ? "TOO_MANY_ROWS" : null,
          completed_at: tx.fn.now(),
          expires_at: tx.raw(`now() + interval '${lifetimeHours} hours'`),
        })
        .returning<ExportRow[]>(this.columns());
      if (row === undefined) throw new Error("Export insert returned no row");
      return { ...this.view({ ...row, downloads: 0 }), replayed: false };
    });
  }

  /** The 100 most recent exports, newest first; never the file. */
  public list(tenantId: string) {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const rows = await tx("admin_exports as e")
        .where("e.tenant_id", tenantId)
        .orderBy([
          { column: "e.created_at", order: "desc" },
          { column: "e.id", order: "desc" },
        ])
        .limit(100)
        .select<ExportRow[]>([
          ...this.columns().map((column) => `e.${column}`),
          tx.raw(
            "(SELECT count(*)::int FROM admin_export_downloads d WHERE d.export_id = e.id) AS downloads",
          ),
        ]);
      return {
        service: this.service,
        tenant_id: tenantId,
        items: rows.map((row) => this.view(row)),
      };
    });
  }

  /** The CSV, once per call, recorded with who downloaded it. */
  public download(input: {
    tenantId: string;
    exportId: string;
    administratorId: string;
    correlationId: string;
  }) {
    return withTenantTransaction(this.database, input.tenantId, async (tx) => {
      const row = await tx("admin_exports")
        .where({ tenant_id: input.tenantId, id: input.exportId })
        .first<
          | {
              kind: string;
              status: string;
              content: string | null;
              content_sha256: string | null;
              expires_at: Date;
              created_at: Date;
            }
          | undefined
        >(
          "kind",
          "status",
          "content",
          "content_sha256",
          "expires_at",
          "created_at",
        );
      if (row === undefined) throw new ExportError(404, "EXPORT_NOT_FOUND");
      if (row.status === "FAILED") throw new ExportError(409, "EXPORT_FAILED");
      if (
        row.status === "EXPIRED" ||
        row.content === null ||
        row.expires_at.getTime() <= Date.now()
      )
        throw new ExportError(410, "EXPORT_EXPIRED");
      await tx("admin_export_downloads").insert({
        tenant_id: input.tenantId,
        export_id: input.exportId,
        downloaded_by: input.administratorId,
        correlation_id: input.correlationId,
      });
      return {
        filename: `${this.service}-${row.kind}-${row.created_at.toISOString().slice(0, 10)}.csv`,
        content: row.content,
        sha256: row.content_sha256 ?? "",
      };
    });
  }

  private columns() {
    return [
      "id",
      "kind",
      "parameters",
      "status",
      "requested_by",
      "reason_code",
      "request_hash",
      "row_count",
      "byte_size",
      "content_sha256",
      "failure_code",
      "created_at",
      "completed_at",
      "expires_at",
    ];
  }

  private view(row: ExportRow) {
    return {
      id: row.id,
      service: this.service,
      kind: row.kind,
      customer_level: this.kinds[row.kind]?.customerLevel ?? false,
      parameters: row.parameters,
      status:
        row.status === "READY" && row.expires_at.getTime() <= Date.now()
          ? "EXPIRED"
          : row.status,
      requested_by: row.requested_by,
      reason_code: row.reason_code,
      row_count: row.row_count,
      byte_size: row.byte_size,
      sha256: row.content_sha256,
      failure_code: row.failure_code,
      downloads: row.downloads ?? 0,
      created_at: row.created_at.toISOString(),
      expires_at: row.expires_at.toISOString(),
    };
  }
}
