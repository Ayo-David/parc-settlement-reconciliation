import { randomBytes, randomUUID } from "node:crypto";
import {
  MemoryStatementStore,
  statementKey,
} from "../src/runtime/statement-store.js";
import { statementHeader } from "../src/services/statement-format.js";

/**
 * Integration tests need the TS-DB-000 bootstrap and SET-DB-001 applied:
 * - TEST_DATABASE_URL: an administrator (catalogue checks, SET ROLE);
 * - TEST_APP_DATABASE_URL: parc_settlement_app, NOBYPASSRLS, so the service
 *   code runs under forced RLS exactly as deployed.
 */
export const adminUrl = process.env.TEST_DATABASE_URL;
export const appUrl = process.env.TEST_APP_DATABASE_URL;
export const describeDatabase =
  adminUrl !== undefined && appUrl !== undefined ? describe : describe.skip;

export const memoryStore = () =>
  new MemoryStatementStore(
    statementKey("test-key", randomBytes(32).toString("base64")),
  );

export const actor = () => ({
  administratorId: randomUUID(),
  correlationId: randomUUID(),
});

export function statement(
  lines: {
    ref: string;
    provider?: string;
    direction: "IN" | "OUT";
    amount: string;
    date: string;
  }[],
): Buffer {
  return Buffer.from(
    [
      statementHeader.join(","),
      ...lines.map(
        (line) =>
          `${line.ref},${line.provider ?? ""},${line.direction},${line.amount},NGN,${line.date},`,
      ),
    ].join("\n"),
  );
}

/** Payment and Ledger events as they arrive on parc.events. */
export function paymentEvent(
  tenantId: string,
  type: string,
  payload: Record<string, unknown>,
  occurredAt: string,
  producer = "parc-payment",
) {
  return {
    event_id: randomUUID(),
    event_type: type,
    event_version: 1,
    occurred_at: occurredAt,
    producer,
    tenant_id: tenantId,
    aggregate_type: "payment_transaction",
    aggregate_id: randomUUID(),
    aggregate_version: 1,
    correlation_id: randomUUID(),
    causation_id: null,
    data_classification: "CONFIDENTIAL",
    payload,
  };
}
