import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import {
  runView,
  type RunView,
  type BreakType,
} from "./reconciliation-service.js";
import { importView, type ImportView } from "./statement-service.js";
import { decodeCursor, encodeCursor, SettlementError } from "./support.js";

export interface Page<T> {
  items: T[];
  page: { has_more: boolean; next_cursor: string | null };
}
export interface PageQuery {
  pageSize: number;
  cursor?: string | undefined;
}

/**
 * CB-7 slice A: the administrator reads (D184: `settlement.reconciliation.read`).
 * Lists are newest first with an opaque keyset cursor. Narrations can name a
 * person; they are returned to administrators but never logged.
 */
export class SettlementReadService {
  public constructor(private readonly database: Knex) {}

  public listImports(
    tenantId: string,
    query: PageQuery & {
      participantId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
    },
  ): Promise<Page<ImportView>> {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const builder = this.importQuery(tx, tenantId);
      if (query.participantId)
        builder.where("i.participant_id", query.participantId);
      if (query.from) builder.where("i.statement_date", ">=", query.from);
      if (query.to) builder.where("i.statement_date", "<=", query.to);
      return page(builder, "i.created_at", "i.id", query, (row) =>
        importView(row as never),
      );
    });
  }

  public getImport(tenantId: string, importId: string): Promise<ImportView> {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const row = await this.importQuery(tx, tenantId)
        .where("i.id", importId)
        .first<Record<string, unknown> | undefined>();
      if (!row)
        throw new SettlementError(404, "IMPORT_NOT_FOUND", "No such import");
      return importView(row as never);
    });
  }

  public listLines(
    tenantId: string,
    importId: string,
    query: { pageSize: number; afterLine?: number | undefined },
  ) {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const exists = await tx("bank_statement_imports")
        .where({ tenant_id: tenantId, id: importId })
        .first<Record<string, unknown> | undefined>("id");
      if (!exists)
        throw new SettlementError(404, "IMPORT_NOT_FOUND", "No such import");
      const rows = await tx("bank_statement_lines as l")
        .leftJoin("reconciliation_matches as m", function () {
          this.on("m.tenant_id", "l.tenant_id").andOn(
            "m.statement_line_id",
            "l.id",
          );
        })
        .leftJoin("reconciliation_breaks as b", function () {
          this.on("b.tenant_id", "l.tenant_id")
            .andOn("b.statement_line_id", "l.id")
            .andOnVal("b.status", "OPEN");
        })
        .where({ "l.tenant_id": tenantId, "l.import_id": importId })
        .where("l.line_number", ">", query.afterLine ?? 0)
        .orderBy("l.line_number")
        .limit(query.pageSize + 1)
        .select<Record<string, unknown>[]>(
          "l.id",
          "l.line_number",
          "l.line_reference",
          "l.provider_reference",
          "l.direction",
          "l.amount_minor",
          "l.currency",
          "l.value_date",
          "l.narration",
          "m.id as match_id",
          "m.expected_item_id",
          "b.id as open_break_id",
          "b.break_type as open_break_type",
        );
      const more = rows.length > query.pageSize;
      const items = rows.slice(0, query.pageSize).map((row) => ({
        ...row,
        amount_minor: String(row.amount_minor),
        currency: (row.currency as string).trim(),
        state: row.match_id
          ? "MATCHED"
          : row.open_break_id
            ? "BREAK"
            : "UNRECONCILED",
      }));
      return {
        items,
        page: {
          has_more: more,
          next_cursor: more
            ? String(rows[query.pageSize - 1]!.line_number)
            : null,
        },
      };
    });
  }

  public listRuns(
    tenantId: string,
    query: PageQuery & { participantId?: string | undefined },
  ): Promise<Page<RunView>> {
    return withTenantTransaction(this.database, tenantId, (tx) => {
      const builder = tx("reconciliation_runs as r").where(
        "r.tenant_id",
        tenantId,
      );
      if (query.participantId)
        builder.where("r.participant_id", query.participantId);
      builder.select("r.*");
      return page(builder, "r.started_at", "r.id", query, (row) =>
        runView(row),
      );
    });
  }

  public getRun(tenantId: string, runId: string): Promise<RunView> {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const row = await tx("reconciliation_runs")
        .where({ tenant_id: tenantId, id: runId })
        .first<Record<string, unknown> | undefined>();
      if (!row) throw new SettlementError(404, "RUN_NOT_FOUND", "No such run");
      return runView(row);
    });
  }

  public listBreaks(
    tenantId: string,
    query: PageQuery & {
      status?: "OPEN" | "RESOLVED" | undefined;
      breakType?: BreakType | undefined;
      participantId?: string | undefined;
      runId?: string | undefined;
    },
  ) {
    return withTenantTransaction(this.database, tenantId, (tx) => {
      const builder = this.breakQuery(tx, tenantId);
      if (query.status) builder.where("b.status", query.status);
      if (query.breakType) builder.where("b.break_type", query.breakType);
      if (query.participantId)
        builder.where("b.participant_id", query.participantId);
      if (query.runId) builder.where("b.run_id", query.runId);
      return page(builder, "b.detected_at", "b.id", query, breakView);
    });
  }

  /** A break with its line, expected item, journal and resolution. */
  public getBreak(tenantId: string, breakId: string) {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const row = await this.breakQuery(tx, tenantId)
        .where("b.id", breakId)
        .first<Record<string, unknown> | undefined>();
      if (!row)
        throw new SettlementError(404, "BREAK_NOT_FOUND", "No such break");
      const view = breakView(row);
      const line = view.statement_line_id
        ? await tx("bank_statement_lines")
            .where({ tenant_id: tenantId, id: view.statement_line_id })
            .first<Record<string, unknown> | undefined>(
              "id",
              "import_id",
              "line_number",
              "line_reference",
              "provider_reference",
              "direction",
              "amount_minor",
              "value_date",
              "narration",
            )
        : null;
      const item = view.expected_item_id
        ? await tx("expected_items")
            .where({ tenant_id: tenantId, id: view.expected_item_id })
            .first<Record<string, unknown> | undefined>(
              "id",
              "source_service",
              "source_type",
              "source_id",
              "ledger_transaction_id",
              "provider_code",
              "provider_reference",
              "direction",
              "amount_minor",
              "value_date",
              "status",
              "reversed_at",
            )
        : null;
      const journalId = item?.ledger_transaction_id as
        string | null | undefined;
      const journal = journalId
        ? ((await tx("ledger_journal_refs")
            .where({ tenant_id: tenantId, journal_id: journalId })
            .first<Record<string, unknown> | undefined>(
              "journal_id",
              "reference",
              "posting_type",
              "accounting_date",
              "posted_at",
            )) ?? null)
        : null;
      const resolution =
        (await tx("reconciliation_resolutions")
          .where({ tenant_id: tenantId, break_id: breakId })
          .first<Record<string, unknown> | undefined>(
            "id",
            "resolution_type",
            "note",
            "match_id",
            "replacement_break_id",
            "run_id",
            "resolved_by",
            "resolved_at",
          )) ?? null;
      const money = (value: Record<string, unknown> | null | undefined) =>
        value ? { ...value, amount_minor: String(value.amount_minor) } : null;
      return {
        ...view,
        statement_line: money(line),
        expected_item: money(item),
        journal,
        resolution,
      };
    });
  }

  private importQuery(tx: Knex.Transaction, tenantId: string) {
    return tx("bank_statement_imports as i")
      .where("i.tenant_id", tenantId)
      .select(
        "i.id",
        "i.participant_id",
        "i.statement_date",
        "i.file_name",
        "i.content_sha256",
        "i.size_bytes",
        "i.line_count",
        "i.total_in_minor",
        "i.total_out_minor",
        "i.supersedes_import_id",
        "i.imported_by",
        "i.created_at",
        tx.raw(
          `EXISTS (SELECT 1 FROM bank_statement_imports s
                    WHERE s.tenant_id = i.tenant_id AND s.supersedes_import_id = i.id) AS superseded`,
        ),
      );
  }

  private breakQuery(tx: Knex.Transaction, tenantId: string) {
    return tx("reconciliation_breaks as b")
      .join("settlement_participants as p", function () {
        this.on("p.tenant_id", "b.tenant_id").andOn("p.id", "b.participant_id");
      })
      .where("b.tenant_id", tenantId)
      .select(
        "b.id",
        "b.run_id",
        "b.participant_id",
        "p.code as participant_code",
        "b.break_type",
        "b.statement_line_id",
        "b.expected_item_id",
        "b.provider_reference",
        "b.direction",
        "b.currency",
        "b.expected_amount_minor",
        "b.external_amount_minor",
        "b.difference_minor",
        "b.status",
        "b.detected_at",
        "b.resolved_at",
      );
  }
}

function breakView(row: Record<string, unknown>) {
  const money = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : null;
  const at = (value: unknown) =>
    value instanceof Date ? value.toISOString() : null;
  return {
    id: row.id as string,
    run_id: row.run_id as string,
    participant_id: row.participant_id as string,
    participant_code: row.participant_code as string,
    break_type: row.break_type as BreakType,
    statement_line_id: (row.statement_line_id as string | null) ?? null,
    expected_item_id: (row.expected_item_id as string | null) ?? null,
    provider_reference: (row.provider_reference as string | null) ?? null,
    direction: row.direction as "IN" | "OUT",
    currency: (row.currency as string).trim(),
    expected_amount_minor: money(row.expected_amount_minor),
    external_amount_minor: money(row.external_amount_minor),
    difference_minor: String(row.difference_minor),
    status: row.status as "OPEN" | "RESOLVED",
    detected_at: at(row.detected_at)!,
    resolved_at: at(row.resolved_at),
  };
}

async function page<T>(
  builder: Knex.QueryBuilder,
  timeColumn: string,
  idColumn: string,
  query: PageQuery,
  view: (row: Record<string, unknown>) => T,
): Promise<Page<T>> {
  if (query.cursor) {
    const { at, id } = decodeCursor(query.cursor);
    // Cursors carry milliseconds; PostgreSQL keeps microseconds.
    builder.whereRaw(
      `(date_trunc('milliseconds', ${timeColumn}), ${idColumn}) < (?::timestamptz, ?::uuid)`,
      [at, id],
    );
  }
  const rows = (await builder
    .orderByRaw(
      `date_trunc('milliseconds', ${timeColumn}) DESC, ${idColumn} DESC`,
    )
    .limit(query.pageSize + 1)) as Record<string, unknown>[];
  const more = rows.length > query.pageSize;
  const kept = rows.slice(0, query.pageSize);
  const last = kept[kept.length - 1];
  const timeKey = timeColumn.split(".")[1]!;
  return {
    items: kept.map(view),
    page: {
      has_more: more,
      next_cursor:
        more && last
          ? encodeCursor(last[timeKey] as Date, last.id as string)
          : null,
    },
  };
}
