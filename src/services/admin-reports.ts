import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import type { ExportKind } from "./export-service.js";
import {
  bucketOf,
  buildReport,
  type MetricRow,
  type ReportMetric,
  type ReportRequest,
  reportWindow,
} from "./report-window.js";

/**
 * CB-7 slice D (D191): what settlement-reconciliation contributes to the
 * console in place of Ledger's never-written reconciliation tables: the Home
 * overview figures, the operations report and the breaks export. Totals only
 * in the summary and report; the export has one row per break, with no
 * statement narration (it can name a person).
 */
export const settlementReports = ["reconciliation-breaks"] as const;
export type SettlementReport = (typeof settlementReports)[number];

function breaks(metric: string, column: "detected_at" | "resolved_at") {
  return {
    metric,
    unit: "COUNT",
    rows: (tx, window) =>
      tx("reconciliation_breaks")
        .where("tenant_id", window.tenantId)
        .where(column, ">=", window.start)
        .where(column, "<", window.end)
        .groupByRaw("1")
        .select<MetricRow[]>(
          tx.raw(`${bucketOf(column, window)} AS bucket`),
          tx.raw("count(*)::text AS value"),
        ),
  } satisfies ReportMetric;
}

/** Money moved by approved break postings, by treatment and currency. */
const posted: ReportMetric = {
  metric: "adjustments_posted",
  unit: "MINOR",
  rows: (tx, window) =>
    tx("reconciliation_resolutions")
      .where("tenant_id", window.tenantId)
      .where("resolution_type", "ADJUSTMENT_POSTED")
      .where("resolved_at", ">=", window.start)
      .where("resolved_at", "<", window.end)
      .groupByRaw("1, 2, 3")
      .select<MetricRow[]>(
        tx.raw(`${bucketOf("resolved_at", window)} AS bucket`),
        tx.raw("currency::text AS currency"),
        "treatment as dimension",
        tx.raw("sum(amount_minor)::text AS value"),
      ),
};

const definitions: Record<SettlementReport, ReportMetric[]> = {
  "reconciliation-breaks": [
    breaks("raised", "detected_at"),
    breaks("resolved", "resolved_at"),
    posted,
  ],
};

export const settlementExports: Record<"reconciliation-breaks", ExportKind> = {
  "reconciliation-breaks": {
    customerLevel: false,
    statuses: ["OPEN", "RESOLVED"],
    columns: [
      "break_id",
      "detected_at",
      "participant_code",
      "break_type",
      "status",
      "direction",
      "provider_reference",
      "expected_amount_minor",
      "external_amount_minor",
      "difference_minor",
      "currency",
      "resolution_type",
      "treatment",
      "ledger_transaction_id",
      "resolved_at",
    ],
    rows: async (tx, tenantId, request, limit) => {
      const window = await reportWindow(tx, {
        tenantId,
        ...request,
        granularity: "DAY",
      });
      const local = (column: string, name: string) =>
        tx.raw(
          `to_char(${column} AT TIME ZONE '${window.timezone}', 'YYYY-MM-DD"T"HH24:MI:SS') AS ${name}`,
        );
      const query = tx("reconciliation_breaks as b")
        .join("settlement_participants as p", function () {
          this.on("p.tenant_id", "b.tenant_id").andOn(
            "p.id",
            "b.participant_id",
          );
        })
        .leftJoin("reconciliation_resolutions as r", function () {
          this.on("r.tenant_id", "b.tenant_id").andOn("r.break_id", "b.id");
        })
        .where("b.tenant_id", tenantId)
        .where("b.detected_at", ">=", window.start)
        .where("b.detected_at", "<", window.end);
      if (request.status !== undefined) query.where("b.status", request.status);
      const rows = await query
        .orderBy([
          { column: "b.detected_at", order: "asc" },
          { column: "b.id", order: "asc" },
        ])
        .limit(limit)
        .select<Record<string, string | null>[]>(
          "b.id",
          local("b.detected_at", "detected_at"),
          "p.code",
          "b.break_type",
          "b.status",
          "b.direction",
          "b.provider_reference",
          tx.raw("b.expected_amount_minor::text AS expected"),
          tx.raw("b.external_amount_minor::text AS external"),
          tx.raw("b.difference_minor::text AS difference"),
          tx.raw("b.currency::text AS currency"),
          "r.resolution_type",
          "r.treatment",
          "r.ledger_transaction_id",
          local("b.resolved_at", "resolved_at"),
        );
      return rows.map((row) => [
        row.id ?? null,
        row.detected_at ?? null,
        row.code ?? null,
        row.break_type ?? null,
        row.status ?? null,
        row.direction ?? null,
        row.provider_reference ?? null,
        row.expected ?? null,
        row.external ?? null,
        row.difference ?? null,
        row.currency ?? null,
        row.resolution_type ?? null,
        row.treatment ?? null,
        row.ledger_transaction_id ?? null,
        row.resolved_at ?? null,
      ]);
    },
  },
};

export class SettlementAdminService {
  public constructor(
    private readonly database: Knex,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public report(report: SettlementReport, request: ReportRequest) {
    return withTenantTransaction(this.database, request.tenantId, (tx) =>
      buildReport(tx, report, request, definitions[report]),
    );
  }

  /**
   * The Home overview's reconciliation figures (ADR-002 P2): open breaks by
   * type, the oldest open break and open suspense by currency.
   */
  public summary(tenantId: string) {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const open = await tx("reconciliation_breaks")
        .where({ tenant_id: tenantId, status: "OPEN" })
        .groupBy("break_type")
        .select<{ break_type: string; count: number; oldest: Date }[]>(
          "break_type",
          tx.raw("count(*)::int AS count"),
          tx.raw("min(detected_at) AS oldest"),
        );
      const suspense = await tx("suspense_investigations")
        .where({ tenant_id: tenantId, status: "OPEN" })
        .groupBy("currency")
        .orderBy("currency")
        .select<{ currency: string; investigations: number; amount: string }[]>(
          tx.raw("currency::text AS currency"),
          tx.raw("count(*)::int AS investigations"),
          tx.raw("sum(amount_minor)::text AS amount"),
        );
      const oldest = open
        .map((row) => row.oldest)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return {
        tenant_id: tenantId,
        generated_at: this.now().toISOString(),
        reconciliation: {
          open_breaks: open.reduce((sum, row) => sum + row.count, 0),
          open_breaks_by_type: Object.fromEntries(
            open.map((row) => [row.break_type, row.count]),
          ),
          oldest_open_break_at: oldest ? oldest.toISOString() : null,
          open_suspense: suspense.map((row) => ({
            currency: row.currency.trim(),
            investigations: row.investigations,
            amount_minor: row.amount,
          })),
        },
      };
    });
  }
}
