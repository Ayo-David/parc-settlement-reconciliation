import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import { activeImports } from "./statement-service.js";
import {
  type Actor,
  addDays,
  canonicalJson,
  enqueue,
  lagosDate,
  priorResponse,
  recordResponse,
  SettlementError,
  sha256,
} from "./support.js";

export const RUN_STARTED = "reconciliation.run-started.v1";
export const BREAK_DETECTED = "reconciliation.break-detected.v1";
export const BREAK_RESOLVED = "reconciliation.break-resolved.v1";
export const ruleSetVersion = "v1";

export const breakTypes = [
  "AMOUNT_MISMATCH",
  "DUPLICATE_EXTERNAL",
  "UNMATCHED_EXTERNAL",
  "MISSING_EXTERNAL",
] as const;
export type BreakType = (typeof breakTypes)[number];
/** D183: what an administrator may record in slice A (no postings). */
export const manualResolutions = [
  "WRITE_OFF_NO_IMPACT",
  "PROVIDER_CONFIRMED",
  "DUPLICATE_ACKNOWLEDGED",
  "OTHER",
] as const;

export interface RunView {
  id: string;
  participant_id: string;
  period_from: string;
  period_to: string;
  rule_set_version: string;
  trigger: "MANUAL";
  status: "RUNNING" | "COMPLETED" | "FAILED";
  requested_by: string | null;
  lines_considered: number;
  items_considered: number;
  matched_count: number;
  breaks_opened: number;
  breaks_resolved: number;
  failure_code: string | null;
  started_at: string;
  completed_at: string | null;
}

interface Line {
  id: string;
  provider_reference: string | null;
  direction: "IN" | "OUT";
  amount_minor: string;
  currency: string;
  open_break_id: string | null;
}

interface Item {
  id: string;
  source_type: string;
  source_id: string;
  ledger_transaction_id: string | null;
  provider_reference: string | null;
  direction: "IN" | "OUT";
  amount_minor: string;
  currency: string;
  status: "EXPECTED" | "MATCHED";
  reversed_at: Date | null;
  value_date: string;
  /** An open MISSING_EXTERNAL break a match resolves. */
  open_missing_id: string | null;
  /** Any break other than an open MISSING_EXTERNAL holds the item back. */
  held: boolean;
}

export function runView(row: Record<string, unknown>): RunView {
  const at = (value: unknown) =>
    value instanceof Date ? value.toISOString() : null;
  return {
    id: row.id as string,
    participant_id: row.participant_id as string,
    period_from: row.period_from as string,
    period_to: row.period_to as string,
    rule_set_version: row.rule_set_version as string,
    trigger: row.trigger as "MANUAL",
    status: row.status as RunView["status"],
    requested_by: (row.requested_by as string | null) ?? null,
    lines_considered: row.lines_considered as number,
    items_considered: row.items_considered as number,
    matched_count: row.matched_count as number,
    breaks_opened: row.breaks_opened as number,
    breaks_resolved: row.breaks_resolved as number,
    failure_code: (row.failure_code as string | null) ?? null,
    started_at: at(row.started_at)!,
    completed_at: at(row.completed_at),
  };
}

/**
 * CB-7 slice A: matching (D181), late arrivals (D182) and administrator
 * resolutions without a posting (D183).
 *
 * A run takes one participant and a period of value dates (at most 32 days)
 * and, in one transaction under a per-participant lock:
 * 1. considers the lines of active imports in the period that are unmatched
 *    and have no break other than an open UNMATCHED_EXTERNAL;
 * 2. matches each line by provider code (the participant's code), provider
 *    reference, direction, currency and exact amount to an expected item
 *    that is unmatched and has no break other than an open MISSING_EXTERNAL;
 * 3. otherwise opens AMOUNT_MISMATCH (same reference, different amount),
 *    DUPLICATE_EXTERNAL (the reference is already matched) or
 *    UNMATCHED_EXTERNAL;
 * 4. opens MISSING_EXTERNAL for each unmatched, unreversed item in the
 *    period whose value date plus the grace days has passed the latest
 *    imported statement date and today.
 * A match resolves the line's open UNMATCHED_EXTERNAL break and the item's
 * open MISSING_EXTERNAL break as LATE_MATCH. A line whose open
 * UNMATCHED_EXTERNAL becomes an AMOUNT_MISMATCH or DUPLICATE_EXTERNAL has the
 * old break resolved as RECLASSIFIED. Matching never changes Payment's or
 * Ledger's records: only settlement's own projection.
 */
export class ReconciliationService {
  public constructor(
    private readonly database: Knex,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async startRun(
    tenantId: string,
    input: { participantId: string; periodFrom: string; periodTo: string },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<RunView & { replayed: boolean }> {
    if (input.periodFrom > input.periodTo)
      throw new SettlementError(
        400,
        "INVALID_PERIOD",
        "period_from is after period_to",
      );
    if (addDays(input.periodFrom, 31) < input.periodTo)
      throw new SettlementError(
        400,
        "PERIOD_TOO_LONG",
        "A run covers at most 32 days",
      );
    const requestHash = sha256(
      canonicalJson({
        participant_id: input.participantId,
        period_from: input.periodFrom,
        period_to: input.periodTo,
      }),
    );
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [
        `reconciliation:${tenantId}:${input.participantId}`,
      ]);
      const prior = await tx("reconciliation_runs")
        .where({ tenant_id: tenantId, idempotency_key: idempotencyKey })
        .first<Record<string, unknown> | undefined>();
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new SettlementError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was used for a different request",
          );
        return { ...runView(prior), replayed: true };
      }
      const participant = await tx("settlement_participants")
        .where({ tenant_id: tenantId, id: input.participantId })
        .first<
          { code: string; grace_days: number; status: string } | undefined
        >("code", "grace_days", "status");
      if (!participant)
        throw new SettlementError(
          404,
          "PARTICIPANT_NOT_FOUND",
          "No such participant",
        );
      if (participant.status !== "ACTIVE")
        throw new SettlementError(
          409,
          "PARTICIPANT_INACTIVE",
          "The participant is inactive",
        );

      const runId = randomUUID();
      await tx("reconciliation_runs").insert({
        id: runId,
        tenant_id: tenantId,
        participant_id: input.participantId,
        period_from: input.periodFrom,
        period_to: input.periodTo,
        rule_set_version: ruleSetVersion,
        trigger: "MANUAL",
        requested_by: actor.administratorId,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        correlation_id: actor.correlationId,
      });
      await enqueue(tx, {
        tenantId,
        aggregateType: "reconciliation_run",
        aggregateId: runId,
        aggregateVersion: 1,
        eventType: RUN_STARTED,
        correlationId: actor.correlationId,
        payload: {
          run_id: runId,
          participant_id: input.participantId,
          participant_code: participant.code,
          period_from: input.periodFrom,
          period_to: input.periodTo,
          rule_set_version: ruleSetVersion,
          trigger: "MANUAL",
          requested_by: actor.administratorId,
          started_at: this.now().toISOString(),
        },
      });

      const context: RunContext = {
        tx,
        tenantId,
        runId,
        participantId: input.participantId,
        participantCode: participant.code,
        correlationId: actor.correlationId,
        opened: 0,
        resolved: 0,
      };
      const lines = await this.lines(tx, tenantId, input);
      const items = await this.items(
        tx,
        tenantId,
        participant.code,
        lines,
        input,
      );
      const byReference = new Map<string, Item[]>();
      for (const item of items.values())
        if (item.provider_reference !== null) {
          const key = referenceKey(item.provider_reference, item.direction);
          byReference.set(key, [...(byReference.get(key) ?? []), item]);
        }

      let matched = 0;
      for (const line of lines) {
        const candidates =
          line.provider_reference === null
            ? []
            : (
                byReference.get(
                  referenceKey(line.provider_reference, line.direction),
                ) ?? []
              ).filter((item) => item.currency === line.currency);
        const open = candidates.filter(
          (item) => item.status === "EXPECTED" && !item.held,
        );
        const exact = open.find(
          (item) => item.amount_minor === line.amount_minor,
        );
        if (exact) {
          await this.match(context, line, exact);
          matched += 1;
          continue;
        }
        const mismatch = open[0];
        if (mismatch) {
          await this.openBreak(context, line, {
            breakType: "AMOUNT_MISMATCH",
            item: mismatch,
          });
          mismatch.held = true;
          continue;
        }
        const taken = candidates.find((item) => item.status === "MATCHED");
        if (taken) {
          await this.openBreak(context, line, {
            breakType: "DUPLICATE_EXTERNAL",
            item: taken,
          });
          continue;
        }
        if (line.open_break_id === null)
          await this.openBreak(context, line, {
            breakType: "UNMATCHED_EXTERNAL",
          });
      }

      // D181: missing only once statements are in for the grace period.
      const latest = await activeImports(tx, tenantId)
        .where("i.participant_id", input.participantId)
        .max<{ latest: string | null }[]>("i.statement_date as latest");
      const latestStatement = latest[0]?.latest ?? null;
      const today = lagosDate(this.now());
      if (latestStatement !== null)
        for (const item of items.values()) {
          if (
            item.status !== "EXPECTED" ||
            item.held ||
            item.open_missing_id !== null ||
            item.reversed_at !== null ||
            item.value_date < input.periodFrom ||
            item.value_date > input.periodTo
          )
            continue;
          const due = addDays(item.value_date, participant.grace_days);
          if (due > latestStatement || due >= today) continue;
          await this.openBreak(context, null, {
            breakType: "MISSING_EXTERNAL",
            item,
          });
        }

      const [done] = await tx("reconciliation_runs")
        .where({ tenant_id: tenantId, id: runId })
        .update({
          status: "COMPLETED",
          lines_considered: lines.length,
          items_considered: items.size,
          matched_count: matched,
          breaks_opened: context.opened,
          breaks_resolved: context.resolved,
          completed_at: tx.fn.now(),
        })
        .returning<Record<string, unknown>[]>("*");
      return { ...runView(done!), replayed: false };
    });
  }

  /** D183: an administrator closes a break that needs no posting. */
  public async resolveBreak(
    tenantId: string,
    breakId: string,
    input: {
      resolutionType: (typeof manualResolutions)[number];
      note: string;
    },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<{
    break_id: string;
    resolution_id: string;
    resolution_type: string;
    resolved_at: string;
    replayed: boolean;
  }> {
    const requestHash = sha256(canonicalJson({ break_id: breakId, ...input }));
    type Resolved = {
      break_id: string;
      resolution_id: string;
      resolution_type: string;
      resolved_at: string;
    };
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const prior = await priorResponse<Resolved>(
        tx,
        tenantId,
        "break.resolve",
        idempotencyKey,
        requestHash,
      );
      if (prior) return { ...prior, replayed: true };
      const row = await tx("reconciliation_breaks")
        .where({ tenant_id: tenantId, id: breakId })
        .forUpdate()
        .first<{ status: string; break_type: string } | undefined>(
          "status",
          "break_type",
        );
      if (!row)
        throw new SettlementError(404, "BREAK_NOT_FOUND", "No such break");
      if (row.status !== "OPEN")
        throw new SettlementError(
          409,
          "BREAK_ALREADY_RESOLVED",
          "The break is already resolved",
        );
      if (
        input.resolutionType === "DUPLICATE_ACKNOWLEDGED" &&
        row.break_type !== "DUPLICATE_EXTERNAL"
      )
        throw new SettlementError(
          409,
          "RESOLUTION_NOT_ALLOWED",
          "DUPLICATE_ACKNOWLEDGED applies only to a duplicate",
        );
      const resolutionId = randomUUID();
      const resolvedAt = this.now();
      await tx("reconciliation_resolutions").insert({
        id: resolutionId,
        tenant_id: tenantId,
        break_id: breakId,
        resolution_type: input.resolutionType,
        note: input.note,
        resolved_by: actor.administratorId,
        correlation_id: actor.correlationId,
        resolved_at: resolvedAt,
      });
      await tx("reconciliation_breaks")
        .where({ tenant_id: tenantId, id: breakId })
        .update({ status: "RESOLVED", resolved_at: resolvedAt });
      await enqueue(tx, {
        tenantId,
        aggregateType: "reconciliation_break",
        aggregateId: breakId,
        aggregateVersion: 2,
        eventType: BREAK_RESOLVED,
        correlationId: actor.correlationId,
        payload: {
          break_id: breakId,
          resolution_id: resolutionId,
          break_type: row.break_type,
          resolution_type: input.resolutionType,
          match_id: null,
          replacement_break_id: null,
          resolved_by: actor.administratorId,
          resolved_at: resolvedAt.toISOString(),
        },
      });
      const response: Resolved = {
        break_id: breakId,
        resolution_id: resolutionId,
        resolution_type: input.resolutionType,
        resolved_at: resolvedAt.toISOString(),
      };
      await recordResponse(
        tx,
        tenantId,
        "break.resolve",
        idempotencyKey,
        requestHash,
        response,
      );
      return { ...response, replayed: false };
    });
  }

  private async lines(
    tx: Knex.Transaction,
    tenantId: string,
    input: { participantId: string; periodFrom: string; periodTo: string },
  ): Promise<Line[]> {
    const rows = await activeImports(tx, tenantId)
      .join("bank_statement_lines as l", function () {
        this.on("l.tenant_id", "i.tenant_id").andOn("l.import_id", "i.id");
      })
      .leftJoin("reconciliation_breaks as b", function () {
        this.on("b.tenant_id", "l.tenant_id")
          .andOn("b.statement_line_id", "l.id")
          .andOnVal("b.status", "OPEN");
      })
      .where("i.participant_id", input.participantId)
      .whereBetween("l.value_date", [input.periodFrom, input.periodTo])
      .whereNotExists(
        tx("reconciliation_matches as m")
          .select(tx.raw("1"))
          .whereRaw("m.tenant_id = l.tenant_id")
          .whereRaw("m.statement_line_id = l.id"),
      )
      // Only an open UNMATCHED_EXTERNAL lets a line be tried again.
      .where((query) => {
        query.whereNull("b.id").orWhere("b.break_type", "UNMATCHED_EXTERNAL");
      })
      .whereNotExists(
        tx("reconciliation_breaks as closed")
          .select(tx.raw("1"))
          .whereRaw("closed.tenant_id = l.tenant_id")
          .whereRaw("closed.statement_line_id = l.id")
          .where("closed.status", "RESOLVED")
          .whereNotExists(
            tx("reconciliation_resolutions as r")
              .select(tx.raw("1"))
              .whereRaw("r.tenant_id = closed.tenant_id")
              .whereRaw("r.break_id = closed.id")
              .where("r.resolution_type", "RECLASSIFIED"),
          ),
      )
      .orderBy([
        { column: "l.value_date" },
        { column: "i.created_at" },
        { column: "l.line_number" },
      ])
      .select<
        (Omit<Line, "amount_minor" | "currency"> & {
          amount_minor: string | number;
          currency: string;
        })[]
      >(
        "l.id",
        "l.provider_reference",
        "l.direction",
        "l.amount_minor",
        "l.currency",
        "b.id as open_break_id",
      );
    return rows.map((row) => ({
      ...row,
      amount_minor: String(row.amount_minor),
      currency: row.currency.trim(),
    }));
  }

  /**
   * The participant's items whose reference a considered line carries, and
   * its unmatched items in the period (for MISSING_EXTERNAL).
   */
  private async items(
    tx: Knex.Transaction,
    tenantId: string,
    providerCode: string,
    lines: Line[],
    input: { periodFrom: string; periodTo: string },
  ): Promise<Map<string, Item>> {
    const references = [
      ...new Set(
        lines
          .map((line) => line.provider_reference)
          .filter((value): value is string => value !== null),
      ),
    ];
    const rows = await tx("expected_items as e")
      .where({ "e.tenant_id": tenantId, "e.provider_code": providerCode })
      .where((query) => {
        query.where((period) => {
          period
            .where("e.status", "EXPECTED")
            .whereBetween("e.value_date", [input.periodFrom, input.periodTo]);
        });
        if (references.length > 0)
          query.orWhereIn("e.provider_reference", references);
      })
      .select<
        (Omit<
          Item,
          "amount_minor" | "currency" | "held" | "open_missing_id"
        > & {
          amount_minor: string | number;
          currency: string;
          open_missing_id: string | null;
          held: boolean;
        })[]
      >(
        "e.id",
        "e.source_type",
        "e.source_id",
        "e.ledger_transaction_id",
        "e.provider_reference",
        "e.direction",
        "e.amount_minor",
        "e.currency",
        "e.status",
        "e.reversed_at",
        "e.value_date",
        tx.raw(
          `(SELECT b.id FROM reconciliation_breaks b
             WHERE b.tenant_id = e.tenant_id AND b.expected_item_id = e.id
               AND b.status = 'OPEN' AND b.break_type = 'MISSING_EXTERNAL') AS open_missing_id`,
        ),
        tx.raw(
          `EXISTS (SELECT 1 FROM reconciliation_breaks b
                    WHERE b.tenant_id = e.tenant_id AND b.expected_item_id = e.id
                      AND NOT (b.status = 'OPEN' AND b.break_type = 'MISSING_EXTERNAL')
                      AND b.break_type IN ('AMOUNT_MISMATCH','MISSING_EXTERNAL')) AS held`,
        ),
      );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          ...row,
          amount_minor: String(row.amount_minor),
          currency: row.currency.trim(),
        },
      ]),
    );
  }

  private async match(context: RunContext, line: Line, item: Item) {
    const { tx, tenantId } = context;
    const [match] = await tx("reconciliation_matches")
      .insert({
        tenant_id: tenantId,
        run_id: context.runId,
        statement_line_id: line.id,
        expected_item_id: item.id,
        rule: "EXACT",
      })
      .returning<{ id: string }[]>("id");
    await tx("expected_items")
      .where({ tenant_id: tenantId, id: item.id })
      .update({
        status: "MATCHED",
        matched_at: tx.fn.now(),
        updated_at: tx.fn.now(),
      });
    item.status = "MATCHED";
    // D182: a late line or a late completion closes what was open.
    for (const breakId of [line.open_break_id, item.open_missing_id])
      if (breakId !== null)
        await this.autoResolve(context, breakId, "LATE_MATCH", {
          matchId: match!.id,
        });
    item.open_missing_id = null;
  }

  private async openBreak(
    context: RunContext,
    line: Line | null,
    input: { breakType: BreakType; item?: Item },
  ): Promise<void> {
    const { tx, tenantId } = context;
    const item = input.item;
    const linked =
      input.breakType === "AMOUNT_MISMATCH" ||
      input.breakType === "MISSING_EXTERNAL" ||
      input.breakType === "DUPLICATE_EXTERNAL";
    const expected =
      input.breakType === "AMOUNT_MISMATCH" ||
      input.breakType === "MISSING_EXTERNAL"
        ? item!.amount_minor
        : null;
    const external = line?.amount_minor ?? null;
    const difference = (
      BigInt(external ?? 0) - BigInt(expected ?? 0)
    ).toString();
    const breakId = randomUUID();
    const direction = line?.direction ?? item!.direction;
    const currency = line?.currency ?? item!.currency;
    const providerReference =
      line?.provider_reference ?? item?.provider_reference ?? null;
    // An open UNMATCHED_EXTERNAL on the line, and an open MISSING_EXTERNAL on
    // the item an amount mismatch names, are replaced rather than kept beside.
    const replaced: [string, BreakType][] = [];
    if (line?.open_break_id)
      replaced.push([line.open_break_id, "UNMATCHED_EXTERNAL"]);
    if (input.breakType === "AMOUNT_MISMATCH" && item?.open_missing_id)
      replaced.push([item.open_missing_id, "MISSING_EXTERNAL"]);
    for (const [id] of replaced)
      await tx("reconciliation_breaks")
        .where({ tenant_id: tenantId, id })
        .update({ status: "RESOLVED", resolved_at: tx.fn.now() });
    await tx("reconciliation_breaks").insert({
      id: breakId,
      tenant_id: tenantId,
      run_id: context.runId,
      participant_id: context.participantId,
      break_type: input.breakType,
      statement_line_id: line?.id ?? null,
      expected_item_id: linked && item ? item.id : null,
      provider_reference: providerReference,
      direction,
      currency,
      expected_amount_minor: expected,
      external_amount_minor: external,
      difference_minor: difference,
    });
    for (const [id, type] of replaced)
      await this.publishResolution(context, id, type, "RECLASSIFIED", {
        replacementBreakId: breakId,
      });
    if (line) line.open_break_id = null;
    if (input.breakType === "AMOUNT_MISMATCH" && item)
      item.open_missing_id = null;
    context.opened += 1;
    await enqueue(tx, {
      tenantId,
      aggregateType: "reconciliation_break",
      aggregateId: breakId,
      aggregateVersion: 1,
      eventType: BREAK_DETECTED,
      correlationId: context.correlationId,
      payload: {
        break_id: breakId,
        run_id: context.runId,
        participant_code: context.participantCode,
        break_type: input.breakType,
        source_type: linked && item ? item.source_type : null,
        source_id: linked && item ? item.source_id : null,
        ledger_transaction_id:
          linked && item ? item.ledger_transaction_id : null,
        statement_line_id: line?.id ?? null,
        provider_reference: providerReference,
        direction,
        currency,
        expected_amount_minor: expected,
        external_amount_minor: external,
        difference_minor: difference,
        detected_at: new Date().toISOString(),
      },
    });
  }

  private async autoResolve(
    context: RunContext,
    breakId: string,
    resolutionType: "LATE_MATCH",
    link: { matchId: string },
  ): Promise<void> {
    const [row] = await context
      .tx("reconciliation_breaks")
      .where({ tenant_id: context.tenantId, id: breakId, status: "OPEN" })
      .update({ status: "RESOLVED", resolved_at: context.tx.fn.now() })
      .returning<{ break_type: string }[]>("break_type");
    if (!row) return;
    await this.publishResolution(
      context,
      breakId,
      row.break_type,
      resolutionType,
      link,
    );
  }

  private async publishResolution(
    context: RunContext,
    breakId: string,
    breakType: string,
    resolutionType: "LATE_MATCH" | "RECLASSIFIED",
    link: { matchId?: string; replacementBreakId?: string },
  ): Promise<void> {
    const { tx, tenantId } = context;
    const resolutionId = randomUUID();
    const resolvedAt = new Date();
    await tx("reconciliation_resolutions").insert({
      id: resolutionId,
      tenant_id: tenantId,
      break_id: breakId,
      resolution_type: resolutionType,
      match_id: link.matchId ?? null,
      replacement_break_id: link.replacementBreakId ?? null,
      run_id: context.runId,
      correlation_id: context.correlationId,
      resolved_at: resolvedAt,
    });
    context.resolved += 1;
    await enqueue(tx, {
      tenantId,
      aggregateType: "reconciliation_break",
      aggregateId: breakId,
      aggregateVersion: 2,
      eventType: BREAK_RESOLVED,
      correlationId: context.correlationId,
      payload: {
        break_id: breakId,
        resolution_id: resolutionId,
        break_type: breakType,
        resolution_type: resolutionType,
        match_id: link.matchId ?? null,
        replacement_break_id: link.replacementBreakId ?? null,
        resolved_by: null,
        resolved_at: resolvedAt.toISOString(),
      },
    });
  }
}

interface RunContext {
  tx: Knex.Transaction;
  tenantId: string;
  runId: string;
  participantId: string;
  participantCode: string;
  correlationId: string;
  opened: number;
  resolved: number;
}

function referenceKey(reference: string, direction: string): string {
  return `${direction}\u0000${reference}`;
}
