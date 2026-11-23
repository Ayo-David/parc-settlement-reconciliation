import type { Knex } from "knex";
import { z } from "zod";
import { withTenantTransaction } from "../database/client.js";
import { canonicalJson, lagosDate, sha256 } from "./support.js";

export const TRANSFER_COMPLETED = "payment.transfer-completed.v1";
export const COLLECTION_CONFIRMED = "payment.collection-confirmed.v1";
export const BILL_FULFILLED = "payment.bill-fulfilled.v1";
// The contracted name (parc-contracts events/payment/payment-reversed/v1.json)
// and what Payment emits. Until CB-7 slice B this subscribed to a name nothing
// publishes, so reversals never reached the projection.
export const PAYMENT_REVERSED = "payment.reversed.v1";
export const JOURNAL_POSTED = "ledger.transaction-posted.v1";
export const consumedEvents = [
  TRANSFER_COMPLETED,
  COLLECTION_CONFIRMED,
  BILL_FULFILLED,
  PAYMENT_REVERSED,
  JOURNAL_POSTED,
] as const;
export const CONSUMER = "settlement-expected-items";

const uuid = z.string().uuid();
const minor = z.string().regex(/^[1-9][0-9]{0,14}$/);
const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional();

const envelope = z.object({
  event_id: uuid,
  event_type: z.enum(consumedEvents),
  event_version: z.literal(1),
  occurred_at: z.string().datetime({ offset: true }),
  producer: z.enum(["parc-payment", "parc-ledger"]),
  tenant_id: uuid,
  aggregate_id: uuid.optional(),
  correlation_id: uuid.optional(),
  payload: z.record(z.unknown()),
});

const transfer = z.object({
  payment_id: uuid,
  ledger_transaction_id: uuid,
  amount_minor: minor.optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  transfer_type: z.enum(["EXTERNAL", "INTERNAL"]).optional(),
  provider_code: optionalText(50),
  provider_reference: optionalText(200),
});
const collection = z.object({
  payment_id: uuid,
  provider_reference: z.string().trim().min(1).max(200),
  amount_minor: minor,
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider_code: optionalText(50),
});
const bill = z.object({
  bill_transaction_id: uuid,
  ledger_transaction_id: uuid,
  amount_minor: minor,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  provider_reference: z.string().trim().min(1).max(200),
  provider_code: optionalText(50),
});
const reversal = z.object({
  payment_id: uuid,
  reversal_id: uuid,
  ledger_transaction_id: uuid,
});
const journal = z.object({
  transaction_id: uuid,
  reference: z.string().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  total_debits_minor: z.string().regex(/^[0-9]{1,18}$/),
  posted_at: z.string().datetime({ offset: true }),
  accounting_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  posting_type: z.string().max(50).optional(),
  source_service: z.string().max(100).optional(),
});

export type Outcome = "APPLIED" | "IGNORED" | "DUPLICATE" | "INVALID";

/**
 * D179: settlement's own record of what should appear on statements.
 *
 * - An external transfer, a collection and a bill payment each become one
 *   expected item, keyed by Payment's id, valued on the Lagos date the event
 *   occurred. Internal transfers never reach a provider and are ignored, as
 *   are transfers published before the amount was added (CB-4 D170).
 * - Items published before CB-7 have no provider code or reference; they are
 *   kept but only an operator can match them.
 * - A reversal marks the item; a reversed item never raises a missing break.
 * - Journals are recorded so breaks trace to Ledger.
 * Every event is deduplicated through the inbox in the same transaction.
 * Payloads are not kept; amounts, references and ids are.
 */
export class ExpectedItemsConsumer {
  public constructor(private readonly database: Knex) {}

  public async handle(raw: unknown): Promise<Outcome> {
    const parsed = envelope.safeParse(raw);
    if (!parsed.success) return "INVALID";
    const event = parsed.data;
    const expectedProducer =
      event.event_type === JOURNAL_POSTED ? "parc-ledger" : "parc-payment";
    if (event.producer !== expectedProducer) return "INVALID";
    const fact = this.fact(event);
    if (fact === "INVALID") return "INVALID";
    return withTenantTransaction(this.database, event.tenant_id, async (tx) => {
      const inserted = await tx("inbox_events")
        .insert({
          tenant_id: event.tenant_id,
          source_service: event.producer,
          event_id: event.event_id,
          consumer_name: CONSUMER,
          event_type: event.event_type,
          event_version: event.event_version,
          aggregate_id: event.aggregate_id ?? null,
          correlation_id: event.correlation_id ?? event.event_id,
          payload_hash: sha256(canonicalJson(event.payload)),
          outcome: fact === "IGNORED" ? "IGNORED" : "APPLIED",
          occurred_at: event.occurred_at,
        })
        .onConflict([
          "tenant_id",
          "source_service",
          "event_id",
          "consumer_name",
        ])
        .ignore()
        .returning("id");
      if (inserted.length === 0) return "DUPLICATE";
      if (fact === "IGNORED") return "IGNORED";
      await fact(tx);
      return "APPLIED";
    });
  }

  private fact(
    event: z.infer<typeof envelope>,
  ): "INVALID" | "IGNORED" | ((tx: Knex.Transaction) => Promise<unknown>) {
    const tenantId = event.tenant_id;
    const valueDate = lagosDate(new Date(event.occurred_at));
    const item =
      (values: {
        source_type: string;
        source_id: string;
        ledger_transaction_id: string | null;
        provider_code: string | null | undefined;
        provider_reference: string | null | undefined;
        direction: "IN" | "OUT";
        amount_minor: string;
        currency: string;
      }) =>
      (tx: Knex.Transaction) =>
        tx("expected_items")
          .insert({
            tenant_id: tenantId,
            source_service: "parc-payment",
            ...values,
            provider_code: values.provider_code ?? null,
            provider_reference: values.provider_reference ?? null,
            value_date: valueDate,
            source_event_id: event.event_id,
            occurred_at: event.occurred_at,
          })
          .onConflict([
            "tenant_id",
            "source_service",
            "source_type",
            "source_id",
          ])
          .ignore();

    switch (event.event_type) {
      case TRANSFER_COMPLETED: {
        const payload = transfer.safeParse(event.payload);
        if (!payload.success) return "INVALID";
        const value = payload.data;
        if (
          value.transfer_type !== "EXTERNAL" ||
          value.amount_minor === undefined
        )
          return "IGNORED";
        return item({
          source_type: "EXTERNAL_TRANSFER",
          source_id: value.payment_id,
          ledger_transaction_id: value.ledger_transaction_id,
          provider_code: value.provider_code,
          provider_reference: value.provider_reference,
          direction: "OUT",
          amount_minor: value.amount_minor,
          currency: value.currency ?? "NGN",
        });
      }
      case COLLECTION_CONFIRMED: {
        const payload = collection.safeParse(event.payload);
        if (!payload.success) return "INVALID";
        const value = payload.data;
        return item({
          source_type: "COLLECTION",
          source_id: value.payment_id,
          ledger_transaction_id: null,
          provider_code: value.provider_code,
          provider_reference: value.provider_reference,
          direction: "IN",
          amount_minor: value.amount_minor,
          currency: value.currency,
        });
      }
      case BILL_FULFILLED: {
        const payload = bill.safeParse(event.payload);
        if (!payload.success) return "INVALID";
        const value = payload.data;
        return item({
          source_type: "BILL_PAYMENT",
          source_id: value.bill_transaction_id,
          ledger_transaction_id: value.ledger_transaction_id,
          provider_code: value.provider_code,
          provider_reference: value.provider_reference,
          direction: "OUT",
          amount_minor: value.amount_minor,
          currency: value.currency ?? "NGN",
        });
      }
      case PAYMENT_REVERSED: {
        const payload = reversal.safeParse(event.payload);
        if (!payload.success) return "INVALID";
        const value = payload.data;
        return (tx) =>
          tx("expected_items")
            .where({
              tenant_id: tenantId,
              source_service: "parc-payment",
              source_id: value.payment_id,
            })
            .whereIn("source_type", ["EXTERNAL_TRANSFER", "COLLECTION"])
            .whereNull("reversed_at")
            .update({
              reversed_at: event.occurred_at,
              reversal_ledger_transaction_id: value.ledger_transaction_id,
              updated_at: tx.fn.now(),
            });
      }
      case JOURNAL_POSTED: {
        const payload = journal.safeParse(event.payload);
        if (!payload.success) return "INVALID";
        const value = payload.data;
        return (tx) =>
          tx("ledger_journal_refs")
            .insert({
              tenant_id: tenantId,
              journal_id: value.transaction_id,
              reference: value.reference,
              currency: value.currency,
              total_debits_minor: value.total_debits_minor,
              posting_type: value.posting_type ?? null,
              source_service: value.source_service ?? null,
              accounting_date: value.accounting_date ?? null,
              posted_at: value.posted_at,
              source_event_id: event.event_id,
            })
            .onConflict(["tenant_id", "journal_id"])
            .ignore();
      }
    }
  }
}
