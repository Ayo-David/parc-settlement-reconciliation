import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import {
  type ApprovalBinding,
  type JournalEntry,
  LedgerRefusedError,
  type LedgerGateway,
  LedgerUnavailableError,
} from "../runtime/ledger-client.js";
import { BREAK_RESOLVED, type BreakType } from "./reconciliation-service.js";
import {
  type Actor,
  canonicalJson,
  enqueue,
  priorResponse,
  recordResponse,
  SettlementError,
  sha256,
} from "./support.js";

export const SUSPENSE_OPENED = "reconciliation.suspense-opened.v1";
export const SUSPENSE_CLOSED = "reconciliation.suspense-closed.v1";

export const breakTreatments = [
  "SUSPENSE",
  "PROVIDER_CHARGE",
  "WRITE_OFF",
] as const;
export type BreakTreatment = (typeof breakTreatments)[number];
type Treatment = BreakTreatment | "SUSPENSE_RELEASE";
type Side = "CREDIT" | "DEBIT";

export interface BreakFacts {
  break_type: BreakType;
  direction: "IN" | "OUT";
  expected_amount_minor: string | null;
  external_amount_minor: string | null;
  difference_minor: string;
}

/**
 * D187: which treatments a break allows, and the amount, both derived from
 * the break. `gain` is true when the provider account holds more than
 * Parc's books show: an unknown or duplicate credit, more received or less
 * sent than expected, or an expected debit that never left. A gain can only
 * go to suspense. A loss goes to provider charges (an amount mismatch), to
 * write-off (a missing credit), or to suspense (an unknown or duplicate debit).
 */
export function planBreak(facts: BreakFacts): {
  amount: string;
  gain: boolean;
  allowed: BreakTreatment[];
} {
  const difference = BigInt(facts.difference_minor);
  const inbound = facts.direction === "IN";
  switch (facts.break_type) {
    case "UNMATCHED_EXTERNAL":
    case "DUPLICATE_EXTERNAL":
      return {
        amount: facts.external_amount_minor!,
        gain: inbound,
        allowed: ["SUSPENSE"],
      };
    case "AMOUNT_MISMATCH": {
      const gain = inbound ? difference > 0n : difference < 0n;
      return {
        amount: (difference < 0n ? -difference : difference).toString(),
        gain,
        allowed: gain ? ["SUSPENSE"] : ["PROVIDER_CHARGE"],
      };
    }
    case "MISSING_EXTERNAL":
      return {
        amount: facts.expected_amount_minor!,
        gain: !inbound,
        allowed: inbound ? ["WRITE_OFF"] : ["SUSPENSE"],
      };
  }
}

/** D186: the tenant's Ledger GL mapping for a participant and treatment. */
export function mappingCode(participantCode: string, treatment: Treatment) {
  return `RECON_${participantCode.replace(/-/g, "_")}_${treatment}`;
}

/**
 * The journal for a treatment. Each mapping is configured in its usual
 * orientation, and the sides swap for the opposite case:
 * - SUSPENSE: debit provider clearing, credit suspense (a gain); swapped
 *   for a loss.
 * - PROVIDER_CHARGE, WRITE_OFF: debit the expense, credit clearing (always
 *   a loss).
 * - SUSPENSE_RELEASE: debit suspense, credit the release account (releasing
 *   a CREDIT investigation); swapped for a DEBIT one.
 */
export function journal(
  mapping: { debit: string; credit: string },
  swap: boolean,
  amount: string,
): JournalEntry[] {
  const [debit, credit] = swap
    ? [mapping.credit, mapping.debit]
    : [mapping.debit, mapping.credit];
  return [
    { account_id: debit, direction: "DEBIT", amount_minor: amount },
    { account_id: credit, direction: "CREDIT", amount_minor: amount },
  ];
}

export interface PostingPreview {
  break_id?: string;
  investigation_id?: string;
  treatment: Treatment;
  amount_minor: string;
  currency: string;
  ledger_reference: string;
  reason: string;
  entries: JournalEntry[];
  approval_binding: ApprovalBinding;
}

interface Plan {
  purpose: "BREAK" | "SUSPENSE_RELEASE";
  targetId: string;
  treatment: Treatment;
  amount: string;
  currency: string;
  reference: string;
  reason: string;
  entries: JournalEntry[];
  ledgerKey: string;
}

interface RequestRow {
  id: string;
  purpose: "BREAK" | "SUSPENSE_RELEASE";
  break_id: string | null;
  investigation_id: string | null;
  treatment: Treatment;
  request_hash: string;
  ledger_idempotency_key: string;
  ledger_reference: string;
  reason: string;
  note: string;
  currency: string;
  amount_minor: string;
  entries: JournalEntry[];
  approval_id: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
  failure_code: string | null;
  requested_by: string;
  correlation_id: string;
}

export interface PostingResolution {
  break_id: string;
  resolution_id: string;
  resolution_type: "ADJUSTMENT_POSTED";
  treatment: BreakTreatment;
  amount_minor: string;
  currency: string;
  ledger_adjustment_id: string;
  ledger_transaction_id: string;
  investigation_id: string | null;
  resolved_at: string;
}

export interface SuspenseClosure {
  investigation_id: string;
  closure_type: "RELEASED" | "CLEARED_BY_JOURNAL";
  closing_ledger_transaction_id: string;
  ledger_adjustment_id: string | null;
  closed_at: string;
}

/**
 * CB-7 slice B (D185–D189): posting resolutions and suspense investigations.
 *
 * Money moves only through Ledger's approval-bound manual adjustment, called
 * delegated as the administrator; Ledger consumes the tenant-admin approval
 * (D185). A command runs in three steps:
 * 1. record a PENDING posting request with the exact journal (or pick up the
 *    pending one for the same Idempotency-Key);
 * 2. post it to Ledger under a Ledger key derived from the target and the
 *    caller's key, the same key the preview bound the approval to;
 * 3. in one transaction, complete the request and record its effect.
 * A Ledger refusal fails the request (nothing was posted); no answer leaves it
 * PENDING for a retry with the same key, which Ledger replays rather than
 * posting twice. While a request is PENDING no other request, run or
 * administrator can close its break or investigation.
 */
export class PostingService {
  public constructor(
    private readonly database: Knex,
    private readonly ledger: LedgerGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async previewBreak(
    tenantId: string,
    breakId: string,
    input: { treatment: BreakTreatment; note: string },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<PostingPreview> {
    const plan = await this.planBreak(tenantId, breakId, input, idempotencyKey);
    return {
      break_id: breakId,
      ...(await this.preview(tenantId, plan, actor)),
    };
  }

  public async postBreak(
    tenantId: string,
    breakId: string,
    input: { treatment: BreakTreatment; note: string; approvalId: string },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<PostingResolution & { replayed: boolean }> {
    const requestHash = sha256(
      canonicalJson({
        target: "break",
        break_id: breakId,
        treatment: input.treatment,
        note: input.note,
        approval_id: input.approvalId,
      }),
    );
    return this.execute<PostingResolution>({
      tenantId,
      operation: "break.posting",
      idempotencyKey,
      requestHash,
      plan: () => this.planBreak(tenantId, breakId, input, idempotencyKey),
      note: input.note,
      approvalId: input.approvalId,
      actor,
      finalize: (tx, request, posted) =>
        this.finalizeBreak(tx, tenantId, request, posted),
    });
  }

  public async previewRelease(
    tenantId: string,
    investigationId: string,
    input: { note: string },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<PostingPreview> {
    const plan = await this.planRelease(
      tenantId,
      investigationId,
      input.note,
      idempotencyKey,
    );
    return {
      investigation_id: investigationId,
      ...(await this.preview(tenantId, plan, actor)),
    };
  }

  public async release(
    tenantId: string,
    investigationId: string,
    input: { note: string; approvalId: string },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<SuspenseClosure & { replayed: boolean }> {
    const requestHash = sha256(
      canonicalJson({
        target: "investigation",
        investigation_id: investigationId,
        note: input.note,
        approval_id: input.approvalId,
      }),
    );
    return this.execute<SuspenseClosure>({
      tenantId,
      operation: "suspense.release",
      idempotencyKey,
      requestHash,
      plan: () =>
        this.planRelease(tenantId, investigationId, input.note, idempotencyKey),
      note: input.note,
      approvalId: input.approvalId,
      actor,
      finalize: (tx, request, posted) =>
        this.finalizeRelease(tx, tenantId, request, posted),
    });
  }

  /**
   * D188: closes an investigation by an exact Ledger journal posted elsewhere,
   * for example a Payment refund. The journal must be in settlement's
   * projection, in the same currency, with total debits equal to the open
   * amount, not the opening journal and not used by another investigation.
   */
  public async clearByJournal(
    tenantId: string,
    investigationId: string,
    input: { journalId: string; note: string },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<SuspenseClosure & { replayed: boolean }> {
    const requestHash = sha256(
      canonicalJson({ investigation_id: investigationId, ...input }),
    );
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const prior = await priorResponse<SuspenseClosure>(
        tx,
        tenantId,
        "suspense.clear",
        idempotencyKey,
        requestHash,
      );
      if (prior) return { ...prior, replayed: true };
      const investigation = await this.openInvestigation(
        tx,
        tenantId,
        investigationId,
      );
      await this.refusePending(tx, tenantId, { investigationId });
      const journalRow = await tx("ledger_journal_refs")
        .where({ tenant_id: tenantId, journal_id: input.journalId })
        .first<
          { currency: string; total_debits_minor: string | number } | undefined
        >("currency", "total_debits_minor");
      if (!journalRow)
        throw new SettlementError(
          422,
          "JOURNAL_NOT_FOUND",
          "Settlement has not seen this Ledger journal",
        );
      if (
        journalRow.currency.trim() !== investigation.currency ||
        String(journalRow.total_debits_minor) !== investigation.amount_minor
      )
        throw new SettlementError(
          422,
          "JOURNAL_MISMATCH",
          "The journal's currency or total differs from the open amount",
        );
      if (input.journalId === investigation.opening_ledger_transaction_id)
        throw new SettlementError(
          422,
          "JOURNAL_MISMATCH",
          "The opening journal cannot clear its own investigation",
        );
      const used = await tx("suspense_investigations")
        .where({
          tenant_id: tenantId,
          closing_ledger_transaction_id: input.journalId,
        })
        .first<{ id: string } | undefined>("id");
      if (used)
        throw new SettlementError(
          409,
          "JOURNAL_ALREADY_USED",
          "The journal already cleared another investigation",
        );
      const closedAt = this.now();
      await tx("suspense_investigations")
        .where({ tenant_id: tenantId, id: investigationId })
        .update({
          status: "CLOSED",
          closure_type: "CLEARED_BY_JOURNAL",
          closing_ledger_transaction_id: input.journalId,
          closing_note: input.note,
          closed_by: actor.administratorId,
          closed_at: closedAt,
        });
      const result: SuspenseClosure = {
        investigation_id: investigationId,
        closure_type: "CLEARED_BY_JOURNAL",
        closing_ledger_transaction_id: input.journalId,
        ledger_adjustment_id: null,
        closed_at: closedAt.toISOString(),
      };
      await this.publishClosed(tx, tenantId, investigation, result, actor);
      await recordResponse(
        tx,
        tenantId,
        "suspense.clear",
        idempotencyKey,
        requestHash,
        result,
      );
      return { ...result, replayed: false };
    });
  }

  public async addNote(
    tenantId: string,
    investigationId: string,
    note: string,
    actor: Actor,
    idempotencyKey: string,
  ) {
    const requestHash = sha256(
      canonicalJson({ investigation_id: investigationId, note }),
    );
    type Added = {
      investigation_id: string;
      note_id: string;
      created_at: string;
    };
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const prior = await priorResponse<Added>(
        tx,
        tenantId,
        "suspense.note",
        idempotencyKey,
        requestHash,
      );
      if (prior) return { ...prior, replayed: true };
      const exists = await tx("suspense_investigations")
        .where({ tenant_id: tenantId, id: investigationId })
        .first<{ id: string } | undefined>("id");
      if (!exists)
        throw new SettlementError(
          404,
          "INVESTIGATION_NOT_FOUND",
          "No such investigation",
        );
      const noteId = randomUUID();
      const createdAt = this.now();
      await tx("suspense_investigation_notes").insert({
        id: noteId,
        tenant_id: tenantId,
        investigation_id: investigationId,
        note,
        author_id: actor.administratorId,
        correlation_id: actor.correlationId,
        created_at: createdAt,
      });
      const result: Added = {
        investigation_id: investigationId,
        note_id: noteId,
        created_at: createdAt.toISOString(),
      };
      await recordResponse(
        tx,
        tenantId,
        "suspense.note",
        idempotencyKey,
        requestHash,
        result,
      );
      return { ...result, replayed: false };
    });
  }

  private async preview(
    tenantId: string,
    plan: Plan,
    actor: Actor,
  ): Promise<Omit<PostingPreview, "break_id" | "investigation_id">> {
    const binding = await this.ledgerCall(() =>
      this.ledger.preview(this.adjustment(tenantId, plan, actor)),
    );
    return {
      treatment: plan.treatment,
      amount_minor: plan.amount,
      currency: plan.currency,
      ledger_reference: plan.reference,
      reason: plan.reason,
      entries: plan.entries,
      approval_binding: binding,
    };
  }

  private async execute<R>(input: {
    tenantId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    plan: () => Promise<Plan>;
    note: string;
    approvalId: string;
    actor: Actor;
    finalize: (
      tx: Knex.Transaction,
      request: RequestRow,
      posted: { adjustment_id: string; transaction_id: string },
    ) => Promise<R>;
  }): Promise<R & { replayed: boolean }> {
    const { tenantId, idempotencyKey, requestHash } = input;
    const state = await withTenantTransaction(
      this.database,
      tenantId,
      async (tx) => {
        const prior = await priorResponse<R>(
          tx,
          tenantId,
          input.operation,
          idempotencyKey,
          requestHash,
        );
        if (prior) return { prior };
        return {
          request: await this.existing(
            tx,
            tenantId,
            idempotencyKey,
            requestHash,
          ),
        };
      },
    );
    if ("prior" in state && state.prior)
      return { ...state.prior, replayed: true };
    let request = "request" in state ? state.request : undefined;
    if (!request) {
      const plan = await input.plan();
      request = await this.record(
        tenantId,
        plan,
        input.note,
        input.approvalId,
        idempotencyKey,
        requestHash,
        input.actor,
      );
    }

    let posted: { adjustment_id: string; transaction_id: string };
    try {
      posted = await this.ledger.post({
        tenantId,
        idempotencyKey: request.ledger_idempotency_key,
        correlationId: input.actor.correlationId,
        reference: request.ledger_reference,
        currency: request.currency,
        reason: request.reason,
        entries: request.entries,
        approvalId: request.approval_id,
      });
    } catch (error) {
      if (error instanceof LedgerRefusedError) {
        await withTenantTransaction(this.database, tenantId, (tx) =>
          tx("posting_requests")
            .where({ tenant_id: tenantId, id: request.id, status: "PENDING" })
            .update({
              status: "FAILED",
              failure_code: error.code.slice(0, 100),
              completed_at: tx.fn.now(),
            }),
        );
        throw new SettlementError(
          409,
          "LEDGER_REFUSED",
          "Ledger refused the adjustment; nothing was posted. Use a new Idempotency-Key after fixing the cause",
          { ledger_status: error.status, ledger_code: error.code },
        );
      }
      throw new SettlementError(
        503,
        "LEDGER_UNAVAILABLE",
        "Ledger did not confirm the adjustment; retry with the same Idempotency-Key",
      );
    }

    const pending = request;
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const current = await tx("posting_requests")
        .where({ tenant_id: tenantId, id: pending.id })
        .forUpdate()
        .first<{ status: string } | undefined>("status");
      // A concurrent retry with the same key finished first.
      if (current?.status === "COMPLETED") {
        const prior = await priorResponse<R>(
          tx,
          tenantId,
          input.operation,
          idempotencyKey,
          requestHash,
        );
        if (prior) return { ...prior, replayed: true };
      }
      await tx("posting_requests")
        .where({ tenant_id: tenantId, id: pending.id, status: "PENDING" })
        .update({
          status: "COMPLETED",
          ledger_adjustment_id: posted.adjustment_id,
          ledger_transaction_id: posted.transaction_id,
          completed_at: tx.fn.now(),
        });
      const result = await input.finalize(tx, pending, posted);
      await recordResponse(
        tx,
        tenantId,
        input.operation,
        idempotencyKey,
        requestHash,
        result,
      );
      return { ...result, replayed: false };
    });
  }

  /** The request already made with this key, if any. */
  private async existing(
    tx: Knex.Transaction,
    tenantId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RequestRow | undefined> {
    const row = await tx("posting_requests")
      .where({ tenant_id: tenantId, idempotency_key: idempotencyKey })
      .first<RequestRow | undefined>();
    if (!row) return undefined;
    if (row.request_hash !== requestHash)
      throw new SettlementError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key was used for a different request",
      );
    if (row.status === "FAILED")
      throw new SettlementError(
        409,
        "LEDGER_REFUSED",
        "This request was refused by Ledger; nothing was posted. Use a new Idempotency-Key",
        { ledger_code: row.failure_code },
      );
    return normalize(row);
  }

  private async record(
    tenantId: string,
    plan: Plan,
    note: string,
    approvalId: string,
    idempotencyKey: string,
    requestHash: string,
    actor: Actor,
  ): Promise<RequestRow> {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      if (plan.purpose === "BREAK") {
        const row = await tx("reconciliation_breaks")
          .where({ tenant_id: tenantId, id: plan.targetId })
          .forUpdate()
          .first<{ status: string } | undefined>("status");
        if (row?.status !== "OPEN")
          throw new SettlementError(
            409,
            "BREAK_ALREADY_RESOLVED",
            "The break is already resolved",
          );
        await this.refusePending(tx, tenantId, { breakId: plan.targetId });
      } else {
        await this.openInvestigation(tx, tenantId, plan.targetId);
        await this.refusePending(tx, tenantId, {
          investigationId: plan.targetId,
        });
      }
      const [row] = await tx("posting_requests")
        .insert({
          id: randomUUID(),
          tenant_id: tenantId,
          purpose: plan.purpose,
          break_id: plan.purpose === "BREAK" ? plan.targetId : null,
          investigation_id:
            plan.purpose === "SUSPENSE_RELEASE" ? plan.targetId : null,
          treatment: plan.treatment,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          ledger_idempotency_key: plan.ledgerKey,
          ledger_reference: plan.reference,
          reason: plan.reason,
          note,
          currency: plan.currency,
          amount_minor: plan.amount,
          entries: JSON.stringify(plan.entries),
          approval_id: approvalId,
          requested_by: actor.administratorId,
          correlation_id: actor.correlationId,
        })
        .returning<RequestRow[]>("*")
        .catch((error: unknown) => {
          // A concurrent request for the same key or target won the race.
          if ((error as { code?: unknown }).code === "23505")
            throw new SettlementError(
              409,
              "POSTING_IN_PROGRESS",
              "A posting is pending; retry it with its Idempotency-Key",
            );
          throw error;
        });
      return normalize(row!);
    });
  }

  private async refusePending(
    tx: Knex.Transaction,
    tenantId: string,
    target: { breakId?: string; investigationId?: string },
  ): Promise<void> {
    const query = tx("posting_requests").where({
      tenant_id: tenantId,
      status: "PENDING",
    });
    if (target.breakId) query.where("break_id", target.breakId);
    if (target.investigationId)
      query.where("investigation_id", target.investigationId);
    if (await query.first<{ id: string } | undefined>("id"))
      throw new SettlementError(
        409,
        "POSTING_IN_PROGRESS",
        "A posting is pending; retry it with its Idempotency-Key",
      );
  }

  private async planBreak(
    tenantId: string,
    breakId: string,
    input: { treatment: BreakTreatment; note: string },
    idempotencyKey: string,
  ): Promise<Plan> {
    const row = await withTenantTransaction(this.database, tenantId, (tx) =>
      tx("reconciliation_breaks as b")
        .join("settlement_participants as p", function () {
          this.on("p.tenant_id", "b.tenant_id").andOn(
            "p.id",
            "b.participant_id",
          );
        })
        .where({ "b.tenant_id": tenantId, "b.id": breakId })
        .first<
          | (BreakFacts & {
              status: string;
              currency: string;
              participant_code: string;
            })
          | undefined
        >(
          "b.status",
          "b.break_type",
          "b.direction",
          "b.currency",
          "b.expected_amount_minor",
          "b.external_amount_minor",
          "b.difference_minor",
          "p.code as participant_code",
        ),
    );
    if (!row)
      throw new SettlementError(404, "BREAK_NOT_FOUND", "No such break");
    if (row.status !== "OPEN")
      throw new SettlementError(
        409,
        "BREAK_ALREADY_RESOLVED",
        "The break is already resolved",
      );
    const plan = planBreak({
      ...row,
      expected_amount_minor: nullableString(row.expected_amount_minor),
      external_amount_minor: nullableString(row.external_amount_minor),
      difference_minor: String(row.difference_minor),
    });
    if (!plan.allowed.includes(input.treatment))
      throw new SettlementError(
        409,
        "TREATMENT_NOT_ALLOWED",
        `This break allows ${plan.allowed.join(", ")}`,
        { allowed: plan.allowed },
      );
    const currency = row.currency.trim();
    const mapping = await this.mapping(
      tenantId,
      mappingCode(row.participant_code, input.treatment),
      currency,
    );
    return {
      purpose: "BREAK",
      targetId: breakId,
      treatment: input.treatment,
      amount: plan.amount,
      currency,
      reference: `RECON-BRK-${breakId}`,
      reason: `Settlement ${input.treatment} for break ${breakId}: ${input.note}`,
      entries: journal(
        mapping,
        input.treatment === "SUSPENSE" && !plan.gain,
        plan.amount,
      ),
      ledgerKey: ledgerKey("break", breakId, idempotencyKey),
    };
  }

  private async planRelease(
    tenantId: string,
    investigationId: string,
    note: string,
    idempotencyKey: string,
  ): Promise<Plan> {
    const investigation = await withTenantTransaction(
      this.database,
      tenantId,
      (tx) => this.openInvestigation(tx, tenantId, investigationId, false),
    );
    const mapping = await this.mapping(
      tenantId,
      mappingCode(investigation.participant_code, "SUSPENSE_RELEASE"),
      investigation.currency,
    );
    return {
      purpose: "SUSPENSE_RELEASE",
      targetId: investigationId,
      treatment: "SUSPENSE_RELEASE",
      amount: investigation.amount_minor,
      currency: investigation.currency,
      reference: `RECON-SUS-${investigationId}`,
      reason: `Settlement SUSPENSE_RELEASE for investigation ${investigationId}: ${note}`,
      entries: journal(
        mapping,
        investigation.side === "DEBIT",
        investigation.amount_minor,
      ),
      ledgerKey: ledgerKey("investigation", investigationId, idempotencyKey),
    };
  }

  private async mapping(
    tenantId: string,
    code: string,
    currency: string,
  ): Promise<{ debit: string; credit: string }> {
    const mapping = await this.ledgerCall(() =>
      this.ledger.mapping(tenantId, code, currency),
    );
    if (!mapping)
      throw new SettlementError(
        422,
        "MAPPING_NOT_FOUND",
        `Ledger has no active ${code} mapping in ${currency}`,
        { event_code: code, currency },
      );
    if (
      !mapping.debit_account_id ||
      !mapping.credit_account_id ||
      mapping.debit_account_id === mapping.credit_account_id
    )
      throw new SettlementError(
        422,
        "MAPPING_INCOMPLETE",
        `The ${code} mapping needs two different accounts`,
        { event_code: code, currency },
      );
    return {
      debit: mapping.debit_account_id,
      credit: mapping.credit_account_id,
    };
  }

  /** Preview and mapping reads: a refusal or no answer is reported as such. */
  private async ledgerCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LedgerRefusedError)
        throw new SettlementError(
          409,
          "LEDGER_REFUSED",
          "Ledger refused the request",
          { ledger_status: error.status, ledger_code: error.code },
        );
      if (error instanceof LedgerUnavailableError)
        throw new SettlementError(
          503,
          "LEDGER_UNAVAILABLE",
          "Ledger could not be reached",
        );
      throw error;
    }
  }

  private adjustment(tenantId: string, plan: Plan, actor: Actor) {
    return {
      tenantId,
      idempotencyKey: plan.ledgerKey,
      correlationId: actor.correlationId,
      reference: plan.reference,
      currency: plan.currency,
      reason: plan.reason,
      entries: plan.entries,
    };
  }

  private async openInvestigation(
    tx: Knex.Transaction,
    tenantId: string,
    investigationId: string,
    lock = true,
  ) {
    const query = tx("suspense_investigations as s")
      .join("settlement_participants as p", function () {
        this.on("p.tenant_id", "s.tenant_id").andOn("p.id", "s.participant_id");
      })
      .where({ "s.tenant_id": tenantId, "s.id": investigationId });
    if (lock) query.forUpdate("s");
    const row = await query.first<
      | {
          id: string;
          status: string;
          side: Side;
          amount_minor: string | number;
          currency: string;
          opening_ledger_transaction_id: string;
          participant_code: string;
        }
      | undefined
    >(
      "s.id",
      "s.status",
      "s.side",
      "s.amount_minor",
      "s.currency",
      "s.opening_ledger_transaction_id",
      "p.code as participant_code",
    );
    if (!row)
      throw new SettlementError(
        404,
        "INVESTIGATION_NOT_FOUND",
        "No such investigation",
      );
    if (row.status !== "OPEN")
      throw new SettlementError(
        409,
        "INVESTIGATION_CLOSED",
        "The investigation is already closed",
      );
    return {
      ...row,
      amount_minor: String(row.amount_minor),
      currency: row.currency.trim(),
    };
  }

  private async finalizeBreak(
    tx: Knex.Transaction,
    tenantId: string,
    request: RequestRow,
    posted: { adjustment_id: string; transaction_id: string },
  ): Promise<PostingResolution> {
    const breakId = request.break_id!;
    const row = await tx("reconciliation_breaks as b")
      .join("settlement_participants as p", function () {
        this.on("p.tenant_id", "b.tenant_id").andOn("p.id", "b.participant_id");
      })
      .where({ "b.tenant_id": tenantId, "b.id": breakId })
      .forUpdate("b")
      .first<BreakFacts & { participant_id: string; participant_code: string }>(
        "b.break_type",
        "b.direction",
        "b.expected_amount_minor",
        "b.external_amount_minor",
        "b.difference_minor",
        "b.participant_id",
        "p.code as participant_code",
      );
    const treatment = request.treatment as BreakTreatment;
    const resolvedAt = this.now();
    const resolutionId = randomUUID();
    await tx("reconciliation_resolutions").insert({
      id: resolutionId,
      tenant_id: tenantId,
      break_id: breakId,
      resolution_type: "ADJUSTMENT_POSTED",
      note: request.note,
      resolved_by: request.requested_by,
      correlation_id: request.correlation_id,
      resolved_at: resolvedAt,
      treatment,
      amount_minor: request.amount_minor,
      currency: request.currency,
      approval_id: request.approval_id,
      posting_request_id: request.id,
      ledger_adjustment_id: posted.adjustment_id,
      ledger_transaction_id: posted.transaction_id,
    });
    await tx("reconciliation_breaks")
      .where({ tenant_id: tenantId, id: breakId })
      .update({ status: "RESOLVED", resolved_at: resolvedAt });

    let investigationId: string | null = null;
    if (treatment === "SUSPENSE") {
      const facts = {
        ...row,
        expected_amount_minor: nullableString(row.expected_amount_minor),
        external_amount_minor: nullableString(row.external_amount_minor),
        difference_minor: String(row.difference_minor),
      };
      const side: Side = planBreak(facts).gain ? "CREDIT" : "DEBIT";
      investigationId = randomUUID();
      await tx("suspense_investigations").insert({
        id: investigationId,
        tenant_id: tenantId,
        participant_id: row.participant_id,
        break_id: breakId,
        opening_resolution_id: resolutionId,
        opening_posting_request_id: request.id,
        side,
        amount_minor: request.amount_minor,
        currency: request.currency,
        opening_ledger_transaction_id: posted.transaction_id,
        opened_by: request.requested_by,
        opened_at: resolvedAt,
      });
      await enqueue(tx, {
        tenantId,
        aggregateType: "suspense_investigation",
        aggregateId: investigationId,
        aggregateVersion: 1,
        eventType: SUSPENSE_OPENED,
        correlationId: request.correlation_id,
        payload: {
          investigation_id: investigationId,
          break_id: breakId,
          participant_code: row.participant_code,
          side,
          amount_minor: request.amount_minor,
          currency: request.currency,
          ledger_transaction_id: posted.transaction_id,
          opened_by: request.requested_by,
          opened_at: resolvedAt.toISOString(),
        },
      });
    }
    await enqueue(tx, {
      tenantId,
      aggregateType: "reconciliation_break",
      aggregateId: breakId,
      aggregateVersion: 2,
      eventType: BREAK_RESOLVED,
      correlationId: request.correlation_id,
      payload: {
        break_id: breakId,
        resolution_id: resolutionId,
        break_type: row.break_type,
        resolution_type: "ADJUSTMENT_POSTED",
        match_id: null,
        replacement_break_id: null,
        resolved_by: request.requested_by,
        resolved_at: resolvedAt.toISOString(),
        treatment,
        amount_minor: request.amount_minor,
        currency: request.currency,
        ledger_transaction_id: posted.transaction_id,
        investigation_id: investigationId,
      },
    });
    return {
      break_id: breakId,
      resolution_id: resolutionId,
      resolution_type: "ADJUSTMENT_POSTED",
      treatment,
      amount_minor: String(request.amount_minor),
      currency: request.currency,
      ledger_adjustment_id: posted.adjustment_id,
      ledger_transaction_id: posted.transaction_id,
      investigation_id: investigationId,
      resolved_at: resolvedAt.toISOString(),
    };
  }

  private async finalizeRelease(
    tx: Knex.Transaction,
    tenantId: string,
    request: RequestRow,
    posted: { adjustment_id: string; transaction_id: string },
  ): Promise<SuspenseClosure> {
    const investigation = await this.openInvestigation(
      tx,
      tenantId,
      request.investigation_id!,
    );
    const closedAt = this.now();
    await tx("suspense_investigations")
      .where({ tenant_id: tenantId, id: investigation.id })
      .update({
        status: "CLOSED",
        closure_type: "RELEASED",
        closing_posting_request_id: request.id,
        closing_ledger_transaction_id: posted.transaction_id,
        closing_note: request.note,
        closed_by: request.requested_by,
        closed_at: closedAt,
      });
    const result: SuspenseClosure = {
      investigation_id: investigation.id,
      closure_type: "RELEASED",
      closing_ledger_transaction_id: posted.transaction_id,
      ledger_adjustment_id: posted.adjustment_id,
      closed_at: closedAt.toISOString(),
    };
    await this.publishClosed(tx, tenantId, investigation, result, {
      administratorId: request.requested_by,
      correlationId: request.correlation_id,
    });
    return result;
  }

  private publishClosed(
    tx: Knex.Transaction,
    tenantId: string,
    investigation: { id: string; amount_minor: string; currency: string },
    result: SuspenseClosure,
    actor: Actor,
  ) {
    return enqueue(tx, {
      tenantId,
      aggregateType: "suspense_investigation",
      aggregateId: investigation.id,
      aggregateVersion: 2,
      eventType: SUSPENSE_CLOSED,
      correlationId: actor.correlationId,
      payload: {
        investigation_id: investigation.id,
        closure_type: result.closure_type,
        amount_minor: investigation.amount_minor,
        currency: investigation.currency,
        closing_ledger_transaction_id: result.closing_ledger_transaction_id,
        closed_by: actor.administratorId,
        closed_at: result.closed_at,
      },
    });
  }
}

/**
 * Ledger's key for a target and the caller's key. Preview and post derive the
 * same one, and Ledger derives the approval binding's resource id from it, so
 * an approval requested from a preview can only be used by that post.
 */
export function ledgerKey(
  kind: "break" | "investigation",
  targetId: string,
  idempotencyKey: string,
): string {
  return `settlement-${kind}-${sha256(`${targetId}\u0000${idempotencyKey}`)}`;
}

function normalize(
  row: Omit<RequestRow, "amount_minor"> & { amount_minor: string | number },
): RequestRow {
  return {
    ...row,
    amount_minor: String(row.amount_minor),
    currency: row.currency.trim(),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? String(value)
    : null;
}
