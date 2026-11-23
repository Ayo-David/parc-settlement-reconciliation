import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import knex from "knex";
import {
  createDatabase,
  withTenantTransaction,
} from "../src/database/client.js";
import {
  type AdjustmentRequest,
  type GlMapping,
  type LedgerGateway,
  LedgerRefusedError,
  LedgerUnavailableError,
} from "../src/runtime/ledger-client.js";
import {
  COLLECTION_CONFIRMED,
  ExpectedItemsConsumer,
  JOURNAL_POSTED,
  TRANSFER_COMPLETED,
} from "../src/services/expected-items.js";
import { ledgerKey, PostingService } from "../src/services/posting-service.js";
import { SettlementReadService } from "../src/services/read-service.js";
import { ReconciliationService } from "../src/services/reconciliation-service.js";
import { StatementService } from "../src/services/statement-service.js";
import {
  actor,
  adminUrl,
  appUrl,
  describeDatabase,
  memoryStore,
  paymentEvent,
  statement,
} from "./helpers.js";

const CLEARING = "aaaaaaaa-0000-4000-8000-000000000001";
const SUSPENSE = "aaaaaaaa-0000-4000-8000-000000000002";
const CHARGES = "aaaaaaaa-0000-4000-8000-000000000003";
const WRITE_OFF = "aaaaaaaa-0000-4000-8000-000000000004";
const RELEASE = "aaaaaaaa-0000-4000-8000-000000000005";

/**
 * A Ledger that posts each Ledger key once and replays it after, as the real
 * one does. `next` scripts the next post: refuse it, fail before posting, or
 * post and lose the response.
 */
class FakeLedger implements LedgerGateway {
  public mappings = new Map<string, GlMapping>([
    [
      "RECON_PAYSTACK_SUSPENSE",
      { debit_account_id: CLEARING, credit_account_id: SUSPENSE },
    ],
    [
      "RECON_PAYSTACK_PROVIDER_CHARGE",
      { debit_account_id: CHARGES, credit_account_id: CLEARING },
    ],
    [
      "RECON_PAYSTACK_WRITE_OFF",
      { debit_account_id: WRITE_OFF, credit_account_id: CLEARING },
    ],
    [
      "RECON_PAYSTACK_SUSPENSE_RELEASE",
      { debit_account_id: SUSPENSE, credit_account_id: RELEASE },
    ],
  ]);
  public posted = new Map<
    string,
    {
      request: AdjustmentRequest & { approvalId: string };
      transactionId: string;
      adjustmentId: string;
    }
  >();
  public postCalls = 0;
  public next: "refuse" | "unavailable" | "lose-response" | undefined;

  public mapping(_tenantId: string, code: string): Promise<GlMapping | null> {
    return Promise.resolve(this.mappings.get(code) ?? null);
  }
  public preview(request: AdjustmentRequest) {
    return Promise.resolve({
      action: "MANUAL_LEDGER_ADJUSTMENT",
      resource_type: "transaction_adjustment",
      resource_id: randomUUID(),
      payload_hash: JSON.stringify(request.entries).length.toString(),
      amount_minor: request.entries[0]!.amount_minor,
      currency: request.currency,
    });
  }
  public post(request: AdjustmentRequest & { approvalId: string }) {
    this.postCalls += 1;
    const script = this.next;
    this.next = undefined;
    if (script === "refuse")
      return Promise.reject(new LedgerRefusedError(403, "APPROVAL_FORBIDDEN"));
    if (script === "unavailable")
      return Promise.reject(new LedgerUnavailableError("503"));
    const prior = this.posted.get(request.idempotencyKey);
    if (!prior)
      this.posted.set(request.idempotencyKey, {
        request,
        transactionId: randomUUID(),
        adjustmentId: randomUUID(),
      });
    const record = this.posted.get(request.idempotencyKey)!;
    if (script === "lose-response")
      return Promise.reject(new LedgerUnavailableError("timeout"));
    return Promise.resolve({
      adjustment_id: record.adjustmentId,
      transaction_id: record.transactionId,
      replayed: prior !== undefined,
    });
  }
}

/**
 * CB-7 slice B acceptance (proposal §6.3): treatments, refusals, retries,
 * suspense release and clearing, guards and isolation. Breaks come from real
 * statement imports and runs. Each test has its own tenant.
 */
describeDatabase("CB-7 slice B: posting resolutions and suspense", () => {
  const database = createDatabase(appUrl ?? "");
  let admin: Knex;
  const store = memoryStore();
  const statements = new StatementService(database, store);
  const consumer = new ExpectedItemsConsumer(database);
  const today = new Date("2026-11-15T12:00:00Z");
  const reconciliation = new ReconciliationService(database, () => today);
  const reads = new SettlementReadService(database, () => today);
  const at = "2026-11-10T10:00:00Z";
  let ledger: FakeLedger;
  let postings: PostingService;

  beforeAll(() => {
    admin = knex({
      client: "pg",
      connection: adminUrl ?? "",
      searchPath: ["settlement"],
    });
  });
  beforeEach(() => {
    ledger = new FakeLedger();
    postings = new PostingService(database, ledger, () => today);
  });
  afterAll(async () => {
    await database.destroy();
    await admin.destroy();
  });

  /**
   * One run over: a matched transfer; an unknown credit (UNMATCHED IN, a
   * gain); a transfer that took 2,000 more (AMOUNT_MISMATCH OUT, a loss); a
   * collection that never arrived (MISSING IN, a loss).
   */
  async function setup() {
    const tenantId = randomUUID();
    const participant = await statements.createParticipant(
      tenantId,
      {
        code: "PAYSTACK",
        name: "Paystack",
        kind: "PAYMENT_PROVIDER",
        currency: "NGN",
        graceDays: 2,
      },
      actor(),
      randomUUID(),
    );
    const transfer = (reference: string, amount: string) =>
      paymentEvent(
        tenantId,
        TRANSFER_COMPLETED,
        {
          payment_id: randomUUID(),
          ledger_transaction_id: randomUUID(),
          customer_id: randomUUID(),
          amount_minor: amount,
          currency: "NGN",
          transfer_type: "EXTERNAL",
          destination_customer_id: null,
          provider_code: "PAYSTACK",
          provider_reference: reference,
        },
        at,
      );
    for (const event of [
      transfer("REF-A", "100000"),
      transfer("REF-M", "50000"),
      paymentEvent(
        tenantId,
        COLLECTION_CONFIRMED,
        {
          payment_id: randomUUID(),
          provider_reference: "REF-C",
          provider_code: "PAYSTACK",
          amount_minor: "40000",
          currency: "NGN",
        },
        at,
      ),
    ])
      await consumer.handle(event);
    await statements.importStatement(
      tenantId,
      {
        participantId: participant.id,
        statementDate: "2026-11-14",
        fileName: "stmt.csv",
        content: statement([
          {
            ref: "L1",
            provider: "REF-A",
            direction: "OUT",
            amount: "100000",
            date: "2026-11-10",
          },
          {
            ref: "L2",
            provider: "REF-X",
            direction: "IN",
            amount: "25000",
            date: "2026-11-10",
          },
          {
            ref: "L3",
            provider: "REF-M",
            direction: "OUT",
            amount: "52000",
            date: "2026-11-10",
          },
        ]),
        correction: false,
      },
      actor(),
      randomUUID(),
    );
    await run(tenantId, participant.id);
    const items = (await reads.listBreaks(tenantId, { pageSize: 100 })).items;
    const byType = (type: string) => items.find((b) => b.break_type === type)!;
    return {
      tenantId,
      participantId: participant.id,
      unmatched: byType("UNMATCHED_EXTERNAL").id,
      mismatch: byType("AMOUNT_MISMATCH").id,
      missing: byType("MISSING_EXTERNAL").id,
    };
  }
  const run = (tenantId: string, participantId: string) =>
    reconciliation.startRun(
      tenantId,
      { participantId, periodFrom: "2026-11-01", periodTo: "2026-11-14" },
      actor(),
      randomUUID(),
    );
  const note = "Investigated with the provider";
  const approvalId = randomUUID();
  const outbox = (tenantId: string) =>
    withTenantTransaction(database, tenantId, (tx) =>
      tx("outbox_events")
        .where({ tenant_id: tenantId })
        .orderBy("occurred_at")
        .select<{ event_type: string; payload: Record<string, unknown> }[]>(
          "event_type",
          "payload",
        ),
    );
  const request = (tenantId: string, key: string) =>
    withTenantTransaction(database, tenantId, (tx) =>
      tx("posting_requests")
        .where({ tenant_id: tenantId, idempotency_key: key })
        .first<{ status: string; failure_code: string | null }>(
          "status",
          "failure_code",
        ),
    );

  it("allows only the treatments a break's effect permits", async () => {
    const { tenantId, unmatched, mismatch, missing } = await setup();
    const refuse = (
      breakId: string,
      treatment: "SUSPENSE" | "PROVIDER_CHARGE" | "WRITE_OFF",
    ) =>
      postings.previewBreak(
        tenantId,
        breakId,
        { treatment, note },
        actor(),
        randomUUID(),
      );
    await expect(refuse(unmatched, "WRITE_OFF")).rejects.toMatchObject({
      code: "TREATMENT_NOT_ALLOWED",
      details: { allowed: ["SUSPENSE"] },
    });
    await expect(refuse(mismatch, "SUSPENSE")).rejects.toMatchObject({
      details: { allowed: ["PROVIDER_CHARGE"] },
    });
    await expect(refuse(missing, "SUSPENSE")).rejects.toMatchObject({
      details: { allowed: ["WRITE_OFF"] },
    });
    ledger.mappings.delete("RECON_PAYSTACK_WRITE_OFF");
    await expect(refuse(missing, "WRITE_OFF")).rejects.toMatchObject({
      status: 422,
      code: "MAPPING_NOT_FOUND",
    });
    expect(ledger.postCalls).toBe(0);
  });

  it("previews and posts each treatment with the amount from the break", async () => {
    const { tenantId, unmatched, mismatch, missing } = await setup();
    const cases = [
      {
        breakId: unmatched,
        treatment: "SUSPENSE",
        amount: "25000",
        debit: CLEARING,
        credit: SUSPENSE,
      },
      {
        breakId: mismatch,
        treatment: "PROVIDER_CHARGE",
        amount: "2000",
        debit: CHARGES,
        credit: CLEARING,
      },
      {
        breakId: missing,
        treatment: "WRITE_OFF",
        amount: "40000",
        debit: WRITE_OFF,
        credit: CLEARING,
      },
    ] as const;
    for (const item of cases) {
      const key = randomUUID();
      const preview = await postings.previewBreak(
        tenantId,
        item.breakId,
        { treatment: item.treatment, note },
        actor(),
        key,
      );
      expect(preview).toMatchObject({
        break_id: item.breakId,
        amount_minor: item.amount,
        currency: "NGN",
        ledger_reference: `RECON-BRK-${item.breakId}`,
        entries: [
          {
            account_id: item.debit,
            direction: "DEBIT",
            amount_minor: item.amount,
          },
          {
            account_id: item.credit,
            direction: "CREDIT",
            amount_minor: item.amount,
          },
        ],
        approval_binding: { action: "MANUAL_LEDGER_ADJUSTMENT" },
      });
      const result = await postings.postBreak(
        tenantId,
        item.breakId,
        { treatment: item.treatment, note, approvalId },
        actor(),
        key,
      );
      expect(result).toMatchObject({
        resolution_type: "ADJUSTMENT_POSTED",
        treatment: item.treatment,
        amount_minor: item.amount,
        replayed: false,
      });
      // The post used the preview's Ledger key and journal, so the approval
      // requested from the preview binds to it.
      const posted = ledger.posted.get(ledgerKey("break", item.breakId, key))!;
      expect(posted.request.entries).toEqual(preview.entries);
      expect(posted.request.reason).toBe(preview.reason);
      expect(posted.request.approvalId).toBe(approvalId);
      const detail = await reads.getBreak(tenantId, item.breakId);
      expect(detail.status).toBe("RESOLVED");
      expect(detail.resolution).toMatchObject({
        resolution_type: "ADJUSTMENT_POSTED",
        treatment: item.treatment,
        amount_minor: item.amount,
        ledger_transaction_id: result.ledger_transaction_id,
        approval_id: approvalId,
        investigation_id: result.investigation_id,
      });
      // Replays answer the first result without calling Ledger again.
      const calls = ledger.postCalls;
      const replay = await postings.postBreak(
        tenantId,
        item.breakId,
        { treatment: item.treatment, note, approvalId },
        actor(),
        key,
      );
      expect(replay).toEqual({ ...result, replayed: true });
      expect(ledger.postCalls).toBe(calls);
    }
    const events = await outbox(tenantId);
    const resolved = events.filter(
      (e) =>
        e.event_type === "reconciliation.break-resolved.v1" &&
        e.payload.resolution_type === "ADJUSTMENT_POSTED",
    );
    expect(resolved.map((e) => e.payload.treatment).sort()).toEqual([
      "PROVIDER_CHARGE",
      "SUSPENSE",
      "WRITE_OFF",
    ]);
    const opened = events.filter(
      (e) => e.event_type === "reconciliation.suspense-opened.v1",
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toMatchObject({
      break_id: unmatched,
      side: "CREDIT",
      amount_minor: "25000",
      participant_code: "PAYSTACK",
    });
  });

  it("fails a refused posting without moving money or closing the break", async () => {
    const { tenantId, unmatched } = await setup();
    const key = randomUUID();
    const post = (k: string) =>
      postings.postBreak(
        tenantId,
        unmatched,
        { treatment: "SUSPENSE", note, approvalId },
        actor(),
        k,
      );
    ledger.next = "refuse";
    await expect(post(key)).rejects.toMatchObject({
      status: 409,
      code: "LEDGER_REFUSED",
      details: { ledger_code: "APPROVAL_FORBIDDEN" },
    });
    expect(await request(tenantId, key)).toEqual({
      status: "FAILED",
      failure_code: "APPROVAL_FORBIDDEN",
    });
    expect((await reads.getBreak(tenantId, unmatched)).status).toBe("OPEN");
    // The failed key stays failed; a new key may try again.
    await expect(post(key)).rejects.toMatchObject({ code: "LEDGER_REFUSED" });
    await expect(post(randomUUID())).resolves.toMatchObject({
      replayed: false,
    });
    expect(ledger.posted.size).toBe(1);
  });

  it("holds the break while Ledger's answer is unknown and posts once on retry", async () => {
    const { tenantId, participantId, unmatched } = await setup();
    const key = randomUUID();
    const post = (k: string) =>
      postings.postBreak(
        tenantId,
        unmatched,
        { treatment: "SUSPENSE", note, approvalId },
        actor(),
        k,
      );
    // Ledger posted, but the response was lost.
    ledger.next = "lose-response";
    await expect(post(key)).rejects.toMatchObject({
      status: 503,
      code: "LEDGER_UNAVAILABLE",
    });
    expect(await request(tenantId, key)).toMatchObject({ status: "PENDING" });
    // Nothing else may close or post the break meanwhile.
    await expect(
      reconciliation.resolveBreak(
        tenantId,
        unmatched,
        { resolutionType: "OTHER", note },
        actor(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "POSTING_IN_PROGRESS" });
    await expect(post(randomUUID())).rejects.toMatchObject({
      code: "POSTING_IN_PROGRESS",
    });
    // A run leaves the held line and break alone.
    await expect(run(tenantId, participantId)).resolves.toMatchObject({
      status: "COMPLETED",
    });
    expect((await reads.getBreak(tenantId, unmatched)).status).toBe("OPEN");
    // The retry replays in Ledger: one journal, one resolution.
    const result = await post(key);
    expect(result.replayed).toBe(false);
    expect(ledger.posted.size).toBe(1);
    expect(result.ledger_transaction_id).toBe(
      [...ledger.posted.values()][0]!.transactionId,
    );
    expect(await request(tenantId, key)).toMatchObject({ status: "COMPLETED" });
  });

  it("lets only one of two concurrent postings for a break proceed", async () => {
    const { tenantId, missing } = await setup();
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((key) =>
        postings.postBreak(
          tenantId,
          missing,
          { treatment: "WRITE_OFF", note, approvalId },
          actor(),
          key,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(["POSTING_IN_PROGRESS", "BREAK_ALREADY_RESOLVED"]).toContain(
      (refused?.reason as { code: string }).code,
    );
    expect(ledger.posted.size).toBe(1);
  });

  async function openInvestigation() {
    const context = await setup();
    const result = await postings.postBreak(
      context.tenantId,
      context.unmatched,
      { treatment: "SUSPENSE", note, approvalId },
      actor(),
      randomUUID(),
    );
    return {
      ...context,
      investigationId: result.investigation_id!,
      opening: result.ledger_transaction_id,
    };
  }

  it("releases an investigation once through an approved posting", async () => {
    const { tenantId, investigationId } = await openInvestigation();
    const key = randomUUID();
    const preview = await postings.previewRelease(
      tenantId,
      investigationId,
      { note: "Unclaimed after review" },
      actor(),
      key,
    );
    // A CREDIT investigation is released by debiting suspense.
    expect(preview).toMatchObject({
      investigation_id: investigationId,
      treatment: "SUSPENSE_RELEASE",
      amount_minor: "25000",
      ledger_reference: `RECON-SUS-${investigationId}`,
      entries: [
        { account_id: SUSPENSE, direction: "DEBIT" },
        { account_id: RELEASE, direction: "CREDIT" },
      ],
    });
    const released = await postings.release(
      tenantId,
      investigationId,
      { note: "Unclaimed after review", approvalId },
      actor(),
      key,
    );
    expect(released).toMatchObject({
      closure_type: "RELEASED",
      replayed: false,
    });
    const detail = await reads.getInvestigation(tenantId, investigationId);
    expect(detail).toMatchObject({
      status: "CLOSED",
      closure_type: "RELEASED",
      closing_ledger_transaction_id: released.closing_ledger_transaction_id,
      closing_note: "Unclaimed after review",
      age_days: 0,
    });
    await expect(
      postings.release(
        tenantId,
        investigationId,
        { note: "Unclaimed after review", approvalId },
        actor(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "INVESTIGATION_CLOSED" });
    const closed = (await outbox(tenantId)).filter(
      (e) => e.event_type === "reconciliation.suspense-closed.v1",
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.payload).toMatchObject({
      closure_type: "RELEASED",
      amount_minor: "25000",
    });
  });

  it("clears an investigation only with an exact, unused journal", async () => {
    const first = await openInvestigation();
    const { tenantId, investigationId, opening } = first;
    const journal = async (total: string, currency = "NGN") => {
      const id = randomUUID();
      await consumer.handle(
        paymentEvent(
          tenantId,
          JOURNAL_POSTED,
          {
            transaction_id: id,
            reference: `REFUND-${id}`,
            currency,
            total_debits_minor: total,
            total_credits_minor: total,
            posted_at: at,
            accounting_date: "2026-11-12",
            posting_type: "REVERSAL",
            source_service: "parc-payment",
          },
          at,
          "parc-ledger",
        ),
      );
      return id;
    };
    const clear = (
      journalId: string,
      id = investigationId,
      key = randomUUID(),
    ) =>
      postings.clearByJournal(
        tenantId,
        id,
        { journalId, note: "Refunded to the payer by Payment" },
        actor(),
        key,
      );
    await expect(clear(randomUUID())).rejects.toMatchObject({
      code: "JOURNAL_NOT_FOUND",
    });
    await expect(clear(await journal("24999"))).rejects.toMatchObject({
      code: "JOURNAL_MISMATCH",
    });
    const exact = await journal("25000");
    const key = randomUUID();
    const done = await clear(exact, investigationId, key);
    expect(done).toMatchObject({
      closure_type: "CLEARED_BY_JOURNAL",
      closing_ledger_transaction_id: exact,
      ledger_adjustment_id: null,
    });
    expect(await clear(exact, investigationId, key)).toEqual({
      ...done,
      replayed: true,
    });
    expect(opening).not.toBe(exact);

    // A second investigation in the same tenant cannot reuse the journal,
    // nor be cleared by the journal that opened it.
    await statements.importStatement(
      tenantId,
      {
        participantId: first.participantId,
        statementDate: "2026-11-13",
        fileName: "stmt-2.csv",
        content: statement([
          {
            ref: "L9",
            provider: "REF-Y",
            direction: "IN",
            amount: "25000",
            date: "2026-11-11",
          },
        ]),
        correction: false,
      },
      actor(),
      randomUUID(),
    );
    await run(tenantId, first.participantId);
    const second = (
      await reads.listBreaks(tenantId, { pageSize: 100, status: "OPEN" })
    ).items.find((b) => b.break_type === "UNMATCHED_EXTERNAL")!;
    const posted = await postings.postBreak(
      tenantId,
      second.id,
      { treatment: "SUSPENSE", note, approvalId },
      actor(),
      randomUUID(),
    );
    await expect(clear(exact, posted.investigation_id!)).rejects.toMatchObject({
      code: "JOURNAL_ALREADY_USED",
    });
    await consumer.handle(
      paymentEvent(
        tenantId,
        JOURNAL_POSTED,
        {
          transaction_id: posted.ledger_transaction_id,
          reference: `RECON-BRK-${second.id}`,
          currency: "NGN",
          total_debits_minor: "25000",
          total_credits_minor: "25000",
          posted_at: at,
          accounting_date: "2026-11-15",
          posting_type: "MANUAL_ADJUSTMENT",
          source_service: "parc-settlement-reconciliation",
        },
        at,
        "parc-ledger",
      ),
    );
    await expect(
      clear(posted.ledger_transaction_id, posted.investigation_id!),
    ).rejects.toMatchObject({ code: "JOURNAL_MISMATCH" });
    expect(ledger.postCalls).toBe(2);
  });

  it("keeps attributed notes and lists investigations by status", async () => {
    const { tenantId, investigationId } = await openInvestigation();
    const key = randomUUID();
    const added = await postings.addNote(
      tenantId,
      investigationId,
      "Asked Paystack for the payer's details",
      actor(),
      key,
    );
    expect(
      await postings.addNote(
        tenantId,
        investigationId,
        "Asked Paystack for the payer's details",
        actor(),
        key,
      ),
    ).toEqual({ ...added, replayed: true });
    const detail = await reads.getInvestigation(tenantId, investigationId);
    expect(detail.notes).toHaveLength(1);
    expect(detail).toMatchObject({
      status: "OPEN",
      side: "CREDIT",
      amount_minor: "25000",
      participant_code: "PAYSTACK",
    });
    expect(
      (
        await reads.listInvestigations(tenantId, {
          pageSize: 10,
          status: "OPEN",
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await reads.listInvestigations(tenantId, {
          pageSize: 10,
          status: "CLOSED",
        })
      ).items,
    ).toHaveLength(0);
    // Tenant isolation: another tenant sees nothing.
    await expect(
      reads.getInvestigation(randomUUID(), investigationId),
    ).rejects.toMatchObject({ code: "INVESTIGATION_NOT_FOUND" });
    await expect(
      postings.addNote(
        randomUUID(),
        investigationId,
        "x",
        actor(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "INVESTIGATION_NOT_FOUND" });
  });

  it("enforces the state machines in the database", async () => {
    const { tenantId, investigationId, unmatched } = await openInvestigation();
    const asApp = <T>(work: (tx: Knex.Transaction) => Promise<T>) =>
      withTenantTransaction(database, tenantId, work);
    await expect(
      asApp((tx) =>
        tx("posting_requests")
          .where({ tenant_id: tenantId, break_id: unmatched })
          .update({
            status: "PENDING",
            completed_at: null,
            ledger_adjustment_id: null,
            ledger_transaction_id: null,
          }),
      ),
    ).rejects.toThrow(/stays finished/);
    await expect(
      asApp((tx) =>
        tx("posting_requests")
          .where({ tenant_id: tenantId, break_id: unmatched })
          .update({ amount_minor: 1 }),
      ),
    ).rejects.toThrow(/Only/);
    await asApp((tx) =>
      tx("suspense_investigations")
        .where({ tenant_id: tenantId, id: investigationId })
        .update({
          status: "CLOSED",
          closure_type: "CLEARED_BY_JOURNAL",
          closing_ledger_transaction_id: randomUUID(),
          closing_note: "Closed for the guard test",
          closed_by: randomUUID(),
          closed_at: new Date(),
        }),
    );
    await expect(
      asApp((tx) =>
        tx("suspense_investigations")
          .where({ tenant_id: tenantId, id: investigationId })
          .update({ closing_note: "Reopened by hand, not allowed" }),
      ),
    ).rejects.toThrow(/stays closed/);
    await expect(
      asApp((tx) =>
        tx("suspense_investigation_notes").insert({
          id: randomUUID(),
          tenant_id: randomUUID(),
          investigation_id: investigationId,
          note: "Cross-tenant note",
          author_id: randomUUID(),
          correlation_id: randomUUID(),
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    // Forced RLS on every new table, as the owner sees it.
    const rls = await admin.raw<{
      rows: { relname: string; relforcerowsecurity: boolean }[];
    }>(
      `SELECT c.relname, c.relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'settlement'
          AND c.relname IN ('posting_requests','suspense_investigations','suspense_investigation_notes')`,
    );
    expect(rls.rows).toHaveLength(3);
    expect(rls.rows.every((row) => row.relforcerowsecurity)).toBe(true);
  });
});
