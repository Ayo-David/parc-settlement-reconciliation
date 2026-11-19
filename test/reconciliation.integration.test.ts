import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import knex from "knex";
import {
  createDatabase,
  withTenantTransaction,
} from "../src/database/client.js";
import {
  BILL_FULFILLED,
  COLLECTION_CONFIRMED,
  ExpectedItemsConsumer,
  JOURNAL_POSTED,
  PAYMENT_REVERSED,
  TRANSFER_COMPLETED,
} from "../src/services/expected-items.js";
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

/**
 * CB-7 slice A acceptance (proposal §3.7, items 2–6): replay, matching, late
 * arrivals, traceability and duplicate events. Each test has its own tenant.
 * Value dates are Lagos dates of the events; "today" is fixed.
 */
describeDatabase("CB-7 slice A: statements and matching", () => {
  const database = createDatabase(appUrl ?? "");
  let admin: Knex;
  const store = memoryStore();
  const statements = new StatementService(database, store);
  const consumer = new ExpectedItemsConsumer(database);
  const today = new Date("2026-11-15T12:00:00Z");
  const reconciliation = new ReconciliationService(database, () => today);
  const reads = new SettlementReadService(database);
  const at = "2026-11-10T10:00:00Z"; // Lagos value date 2026-11-10

  beforeAll(() => {
    admin = knex({
      client: "pg",
      connection: adminUrl ?? "",
      searchPath: ["settlement"],
    });
  });
  afterAll(async () => {
    await database.destroy();
    await admin.destroy();
  });

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
    return { tenantId, participantId: participant.id };
  }
  const transfer = (
    tenantId: string,
    reference: string,
    amount: string,
    extra: Record<string, unknown> = {},
    occurredAt = at,
  ) => {
    const paymentId = randomUUID();
    const journalId = randomUUID();
    return {
      paymentId,
      journalId,
      event: paymentEvent(
        tenantId,
        TRANSFER_COMPLETED,
        {
          payment_id: paymentId,
          ledger_transaction_id: journalId,
          customer_id: randomUUID(),
          amount_minor: amount,
          currency: "NGN",
          transfer_type: "EXTERNAL",
          destination_customer_id: null,
          provider_code: "PAYSTACK",
          provider_reference: reference,
          ...extra,
        },
        occurredAt,
      ),
    };
  };
  const importFile = (
    tenantId: string,
    participantId: string,
    date: string,
    lines: Parameters<typeof statement>[0],
    correction = false,
    key = randomUUID(),
  ) =>
    statements.importStatement(
      tenantId,
      {
        participantId,
        statementDate: date,
        fileName: `stmt-${date}.csv`,
        content: statement(lines),
        correction,
      },
      actor(),
      key,
    );
  const run = (tenantId: string, participantId: string, key = randomUUID()) =>
    reconciliation.startRun(
      tenantId,
      { participantId, periodFrom: "2026-11-01", periodTo: "2026-11-14" },
      actor(),
      key,
    );
  const breaks = async (tenantId: string) =>
    (await reads.listBreaks(tenantId, { pageSize: 100 })).items;
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

  it("matches exactly and raises each kind of break once", async () => {
    const { tenantId, participantId } = await setup();
    const a = transfer(tenantId, "REF-A", "100000");
    const c = transfer(tenantId, "REF-C", "70000");
    const d = transfer(tenantId, "REF-D", "90000");
    const collectionId = randomUUID();
    const billId = randomUUID();
    for (const event of [
      a.event,
      c.event,
      d.event,
      paymentEvent(
        tenantId,
        COLLECTION_CONFIRMED,
        {
          payment_id: collectionId,
          provider_reference: "REF-B",
          provider_code: "PAYSTACK",
          amount_minor: "50000",
          currency: "NGN",
        },
        at,
      ),
      paymentEvent(
        tenantId,
        BILL_FULFILLED,
        {
          bill_transaction_id: billId,
          category: "airtime",
          amount_minor: "30000",
          currency: "NGN",
          provider_reference: "REF-E",
          provider_code: "PAYSTACK",
          ledger_transaction_id: randomUUID(),
        },
        at,
      ),
      paymentEvent(
        tenantId,
        JOURNAL_POSTED,
        {
          transaction_id: c.journalId,
          reference: "EXT-c",
          currency: "NGN",
          total_debits_minor: "70000",
          total_credits_minor: "70000",
          posted_at: at,
          accounting_date: "2026-11-10",
          posting_type: "TRANSFER",
          source_service: "parc-payment",
        },
        at,
        "parc-ledger",
      ),
    ])
      expect(await consumer.handle(event)).toBe("APPLIED");

    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "REF-A",
        direction: "OUT",
        amount: "100000",
        date: "2026-11-10",
      },
      {
        ref: "L2",
        provider: "REF-B",
        direction: "IN",
        amount: "50000",
        date: "2026-11-10",
      },
      {
        ref: "L3",
        provider: "REF-C",
        direction: "OUT",
        amount: "75000",
        date: "2026-11-10",
      },
      {
        ref: "L4",
        provider: "REF-A",
        direction: "OUT",
        amount: "100000",
        date: "2026-11-11",
      },
      {
        ref: "L5",
        provider: "REF-Z",
        direction: "OUT",
        amount: "5000",
        date: "2026-11-11",
      },
      {
        ref: "L6",
        provider: "REF-E",
        direction: "OUT",
        amount: "30000",
        date: "2026-11-11",
      },
      { ref: "L7", direction: "IN", amount: "100", date: "2026-11-12" },
    ]);
    const result = await run(tenantId, participantId);
    expect(result).toMatchObject({
      status: "COMPLETED",
      lines_considered: 7,
      matched_count: 3,
      breaks_opened: 5,
      breaks_resolved: 0,
      replayed: false,
    });

    const found = await breaks(tenantId);
    const byType = (type: string) => found.filter((b) => b.break_type === type);
    expect(byType("AMOUNT_MISMATCH")).toHaveLength(1);
    expect(byType("AMOUNT_MISMATCH")[0]).toMatchObject({
      provider_reference: "REF-C",
      expected_amount_minor: "70000",
      external_amount_minor: "75000",
      difference_minor: "5000",
    });
    expect(byType("DUPLICATE_EXTERNAL")[0]?.provider_reference).toBe("REF-A");
    expect(
      byType("UNMATCHED_EXTERNAL")
        .map((b) => b.provider_reference)
        .sort(),
    ).toEqual(["REF-Z", null].sort());
    // D181: missing once the grace days have passed the latest statement.
    expect(byType("MISSING_EXTERNAL")).toHaveLength(1);
    expect(byType("MISSING_EXTERNAL")[0]).toMatchObject({
      provider_reference: "REF-D",
      expected_amount_minor: "90000",
      difference_minor: "-90000",
    });

    // Traceability: the break leads to Payment's id and Ledger's journal.
    const detail = await reads.getBreak(
      tenantId,
      byType("AMOUNT_MISMATCH")[0]!.id,
    );
    expect(detail.expected_item).toMatchObject({
      source_service: "parc-payment",
      source_type: "EXTERNAL_TRANSFER",
      source_id: c.paymentId,
      ledger_transaction_id: c.journalId,
    });
    expect(detail.journal).toMatchObject({
      journal_id: c.journalId,
      reference: "EXT-c",
    });
    expect(detail.statement_line).toMatchObject({
      line_reference: "L3",
      amount_minor: "75000",
    });

    const events = await outbox(tenantId);
    // One transaction: order is guaranteed per aggregate only.
    expect(events.map((e) => e.event_type).sort()).toEqual([
      ...Array<string>(5).fill("reconciliation.break-detected.v1"),
      "reconciliation.run-started.v1",
    ]);
    const mismatchEvent = events.find(
      (e) => e.payload.break_type === "AMOUNT_MISMATCH",
    );
    expect(mismatchEvent?.payload).toMatchObject({
      source_type: "EXTERNAL_TRANSFER",
      source_id: c.paymentId,
      ledger_transaction_id: c.journalId,
    });

    // A second run over the same period finds nothing new.
    const again = await run(tenantId, participantId);
    expect(again).toMatchObject({
      matched_count: 0,
      breaks_opened: 0,
      breaks_resolved: 0,
    });
  });

  it("resolves missing and unmatched breaks when the other side arrives late (D182)", async () => {
    const { tenantId, participantId } = await setup();
    const early = transfer(tenantId, "REF-LATE-LINE", "4000");
    await consumer.handle(early.event);
    await importFile(tenantId, participantId, "2026-11-13", [
      {
        ref: "L1",
        provider: "REF-LATE-ITEM",
        direction: "OUT",
        amount: "2500",
        date: "2026-11-10",
      },
    ]);
    const first = await run(tenantId, participantId);
    expect(first.breaks_opened).toBe(2);
    const opened = await breaks(tenantId);
    expect(opened.map((b) => b.break_type).sort()).toEqual([
      "MISSING_EXTERNAL",
      "UNMATCHED_EXTERNAL",
    ]);

    // The completion arrives after the line; the line arrives after the item.
    await consumer.handle(transfer(tenantId, "REF-LATE-ITEM", "2500").event);
    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "REF-LATE-LINE",
        direction: "OUT",
        amount: "4000",
        date: "2026-11-12",
      },
    ]);
    const second = await run(tenantId, participantId);
    expect(second).toMatchObject({
      matched_count: 2,
      breaks_opened: 0,
      breaks_resolved: 2,
    });
    const after = await breaks(tenantId);
    expect(after.every((b) => b.status === "RESOLVED")).toBe(true);
    for (const b of after) {
      const detail = await reads.getBreak(tenantId, b.id);
      expect(detail.resolution).toMatchObject({
        resolution_type: "LATE_MATCH",
        resolved_by: null,
      });
      expect(detail.resolution?.match_id).toEqual(expect.any(String));
    }
    const resolved = (await outbox(tenantId)).filter(
      (e) => e.event_type === "reconciliation.break-resolved.v1",
    );
    expect(resolved.map((e) => e.payload.resolution_type)).toEqual([
      "LATE_MATCH",
      "LATE_MATCH",
    ]);
  });

  it("reclassifies an unmatched line when a different amount arrives", async () => {
    const { tenantId, participantId } = await setup();
    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "REF-R",
        direction: "OUT",
        amount: "6000",
        date: "2026-11-10",
      },
    ]);
    await run(tenantId, participantId);
    await consumer.handle(transfer(tenantId, "REF-R", "5000").event);
    const second = await run(tenantId, participantId);
    expect(second).toMatchObject({ breaks_opened: 1, breaks_resolved: 1 });
    const all = await breaks(tenantId);
    const open = all.find((b) => b.status === "OPEN")!;
    const old = all.find((b) => b.status === "RESOLVED")!;
    expect(open.break_type).toBe("AMOUNT_MISMATCH");
    expect((await reads.getBreak(tenantId, old.id)).resolution).toMatchObject({
      resolution_type: "RECLASSIFIED",
      replacement_break_id: open.id,
    });
  });

  it("imports a statement once and refuses a silent replacement", async () => {
    const { tenantId, participantId } = await setup();
    const lines = [
      {
        ref: "L1",
        provider: "R1",
        direction: "IN" as const,
        amount: "10",
        date: "2026-11-10",
      },
    ];
    const before = store.objects.size;
    const first = await importFile(
      tenantId,
      participantId,
      "2026-11-10",
      lines,
    );
    const replay = await importFile(
      tenantId,
      participantId,
      "2026-11-10",
      lines,
    );
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    expect(store.objects.size).toBe(before + 1);
    expect(first).toMatchObject({
      line_count: 1,
      total_in_minor: "10",
      total_out_minor: "0",
    });

    const changed = [{ ...lines[0]!, amount: "11" }];
    await expect(
      importFile(tenantId, participantId, "2026-11-10", changed),
    ).rejects.toMatchObject({
      code: "STATEMENT_ALREADY_IMPORTED",
    });
    const corrected = await importFile(
      tenantId,
      participantId,
      "2026-11-10",
      changed,
      true,
    );
    expect(corrected.supersedes_import_id).toBe(first.id);
    expect((await reads.getImport(tenantId, first.id)).superseded).toBe(true);

    // Once a run has used it, a correction is refused.
    await run(tenantId, participantId);
    await expect(
      importFile(
        tenantId,
        participantId,
        "2026-11-10",
        [{ ...lines[0]!, amount: "12" }],
        true,
      ),
    ).rejects.toMatchObject({ code: "STATEMENT_ALREADY_RECONCILED" });

    // The same idempotency key for a different file is refused.
    const key = randomUUID();
    await importFile(tenantId, participantId, "2026-11-11", lines, false, key);
    await expect(
      importFile(tenantId, participantId, "2026-11-12", lines, false, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("refuses lines in another currency and leaves nothing when the store fails", async () => {
    const { tenantId, participantId } = await setup();
    await expect(
      statements.importStatement(
        tenantId,
        {
          participantId,
          statementDate: "2026-11-10",
          fileName: "usd.csv",
          content: Buffer.from(
            "line_reference,provider_reference,direction,amount_minor,currency,value_date,narration\nL1,R,IN,5,USD,2026-11-10,",
          ),
          correction: false,
        },
        actor(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATEMENT" });
    store.failPuts = true;
    try {
      await expect(
        importFile(tenantId, participantId, "2026-11-10", [
          { ref: "L1", direction: "IN", amount: "5", date: "2026-11-10" },
        ]),
      ).rejects.toThrow("The statement store is unavailable");
    } finally {
      store.failPuts = false;
    }
    expect((await reads.listImports(tenantId, { pageSize: 10 })).items).toEqual(
      [],
    );
  });

  it("replays a run by its key without matching again", async () => {
    const { tenantId, participantId } = await setup();
    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "X",
        direction: "OUT",
        amount: "1",
        date: "2026-11-10",
      },
    ]);
    const key = randomUUID();
    const first = await run(tenantId, participantId, key);
    const replay = await run(tenantId, participantId, key);
    expect(replay).toMatchObject({
      id: first.id,
      replayed: true,
      breaks_opened: 1,
    });
    expect(await breaks(tenantId)).toHaveLength(1);
  });

  it("projects each event once, ignores internal transfers and spares reversed items", async () => {
    const { tenantId, participantId } = await setup();
    const reversed = transfer(tenantId, "REF-REV", "800");
    expect(await consumer.handle(reversed.event)).toBe("APPLIED");
    expect(await consumer.handle(reversed.event)).toBe("DUPLICATE");
    expect(
      await consumer.handle(
        transfer(tenantId, "REF-INT", "5", { transfer_type: "INTERNAL" }).event,
      ),
    ).toBe("IGNORED");
    expect(
      await consumer.handle(
        paymentEvent(
          tenantId,
          PAYMENT_REVERSED,
          {
            payment_id: reversed.paymentId,
            reversal_id: randomUUID(),
            ledger_transaction_id: randomUUID(),
          },
          at,
        ),
      ),
    ).toBe("APPLIED");
    // A Payment event claiming to come from Ledger is refused.
    expect(
      await consumer.handle({
        ...transfer(tenantId, "R", "1").event,
        producer: "parc-ledger",
      }),
    ).toBe("INVALID");

    const items = await withTenantTransaction(database, tenantId, (tx) =>
      tx("expected_items")
        .where({ tenant_id: tenantId })
        .select("provider_reference", "reversed_at"),
    );
    expect(items).toEqual([
      {
        provider_reference: "REF-REV",
        reversed_at: expect.any(Date) as unknown,
      },
    ]);
    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "OTHER",
        direction: "IN",
        amount: "1",
        date: "2026-11-13",
      },
    ]);
    await run(tenantId, participantId);
    expect((await breaks(tenantId)).map((b) => b.break_type)).toEqual([
      "UNMATCHED_EXTERNAL",
    ]);
  });

  it("lets an administrator close a break with a reason, once (D183)", async () => {
    const { tenantId, participantId } = await setup();
    await consumer.handle(transfer(tenantId, "REF-M", "1000").event);
    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "REF-M",
        direction: "OUT",
        amount: "1100",
        date: "2026-11-10",
      },
    ]);
    await run(tenantId, participantId);
    const [mismatch] = await breaks(tenantId);
    const who = actor();
    const key = randomUUID();
    await expect(
      reconciliation.resolveBreak(
        tenantId,
        mismatch!.id,
        {
          resolutionType: "DUPLICATE_ACKNOWLEDGED",
          note: "Not a duplicate at all",
        },
        who,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "RESOLUTION_NOT_ALLOWED" });
    const input = {
      resolutionType: "PROVIDER_CONFIRMED" as const,
      note: "Provider confirmed the fee was added on their side",
    };
    const done = await reconciliation.resolveBreak(
      tenantId,
      mismatch!.id,
      input,
      who,
      key,
    );
    expect(done.replayed).toBe(false);
    expect(
      await reconciliation.resolveBreak(
        tenantId,
        mismatch!.id,
        input,
        who,
        key,
      ),
    ).toMatchObject({
      resolution_id: done.resolution_id,
      replayed: true,
    });
    await expect(
      reconciliation.resolveBreak(
        tenantId,
        mismatch!.id,
        input,
        actor(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "BREAK_ALREADY_RESOLVED" });
    const detail = await reads.getBreak(tenantId, mismatch!.id);
    expect(detail).toMatchObject({ status: "RESOLVED" });
    expect(detail.resolution).toMatchObject({
      resolution_type: "PROVIDER_CONFIRMED",
      resolved_by: who.administratorId,
    });
    // The resolved line and item are not raised again.
    expect(await run(tenantId, participantId)).toMatchObject({
      breaks_opened: 0,
    });
  });

  it("keeps statements, matches and resolutions immutable in the database", async () => {
    const { tenantId, participantId } = await setup();
    await consumer.handle(transfer(tenantId, "REF-I", "10").event);
    await importFile(tenantId, participantId, "2026-11-14", [
      {
        ref: "L1",
        provider: "REF-I",
        direction: "OUT",
        amount: "10",
        date: "2026-11-10",
      },
    ]);
    await run(tenantId, participantId);
    const attempt = (work: (tx: Knex.Transaction) => Promise<unknown>) =>
      withTenantTransaction(database, tenantId, work);
    await expect(
      attempt((tx) =>
        tx("bank_statement_lines")
          .where({ tenant_id: tenantId })
          .update({ amount_minor: 11 }),
      ),
    ).rejects.toThrow();
    await expect(
      attempt((tx) =>
        tx("expected_items")
          .where({ tenant_id: tenantId })
          .update({ amount_minor: 11 }),
      ),
    ).rejects.toThrow(/Only/);
    await expect(
      attempt((tx) =>
        tx("expected_items")
          .where({ tenant_id: tenantId })
          .update({ status: "EXPECTED", matched_at: null }),
      ),
    ).rejects.toThrow(/stays matched/);
    await expect(
      attempt((tx) =>
        tx("reconciliation_runs")
          .where({ tenant_id: tenantId })
          .update({ status: "FAILED", failure_code: "X" }),
      ),
    ).rejects.toThrow(/does not change/);
    // The app login has no DELETE grant at all.
    await expect(
      attempt((tx) =>
        tx("reconciliation_matches").where({ tenant_id: tenantId }).delete(),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
