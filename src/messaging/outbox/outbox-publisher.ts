import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import type { Knex } from "knex";
import { withTenantTransaction } from "../../database/client.js";

const exchange = "parc.events";
const producer = "parc-settlement-reconciliation";
const batchSize = 50;
/** After this many failed attempts a row is dead-lettered (CB1-12). */
export const maxPublishAttempts = 10;

export interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  /** bigint in the table; pg returns it as a string. */
  aggregate_version: string | number;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  correlation_id: string;
  causation_id: string | null;
  retry_count: number;
  occurred_at: Date;
}

export interface PublisherLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The v1 event envelope (parc-contracts schemas/common/event-envelope.v1.json).
 * The event id is the outbox row id, so it stays the same on every retry,
 * and the idempotency key derives from it. Breaks carry provider references
 * and amounts: CONFIDENTIAL.
 */
export function toEnvelope(row: OutboxRow) {
  return {
    event_id: row.id,
    event_type: row.event_type,
    event_version: row.event_version,
    occurred_at: row.occurred_at.toISOString(),
    producer,
    tenant_id: row.tenant_id,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    // A per-aggregate sequence: small, so a JavaScript number is exact.
    aggregate_version: Number(row.aggregate_version),
    correlation_id: row.correlation_id,
    causation_id: row.causation_id,
    idempotency_key: `settlement-outbox:${row.id}`,
    data_classification: "CONFIDENTIAL",
    payload: row.payload,
  };
}

/**
 * Relays committed `outbox_events` rows to the `parc.events` topic
 * exchange, routed by event type, with publisher confirms (CB1-12).
 *
 * Rows are claimed per tenant with `FOR UPDATE SKIP LOCKED` and published
 * inside that transaction, so concurrent publishers never take the same row
 * and a crash before commit leaves the rows due again. Delivery is at least
 * once; consumers deduplicate on `event_id`.
 *
 * Per-aggregate order: a row is not claimed while an earlier version of the
 * same aggregate is backing off or in PROCESSING, so a failed event is never
 * overtaken by a later one; due versions are claimed together and published
 * in version order, and a failure stops the batch. A dead-lettered event no
 * longer blocks its successors. Ordering assumes one publisher per database
 * (the deployment runs a single worker:outbox container).
 */
export class SettlementOutboxPublisher {
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;

  public constructor(
    private readonly db: Knex,
    private readonly url: string,
    /** CB1-11: tenants to publish for, resolved on every batch. */
    private readonly tenants: () => Promise<readonly string[]>,
    private readonly logger: PublisherLogger,
    /** Test seam; defaults to a confirm channel on `url`. */
    private readonly openChannel?: () => Promise<ConfirmChannel>,
  ) {}

  /** Publishes one batch for every tenant with work; returns rows published. */
  public async runBatch(): Promise<number> {
    let tenantIds: readonly string[];
    try {
      tenantIds = await this.tenants();
    } catch (error) {
      this.logger.error("Outbox tenant discovery failed", {
        error: errorName(error),
      });
      return 0;
    }
    let published = 0;
    for (const tenantId of tenantIds) {
      try {
        published += await this.publishTenantBatch(tenantId);
      } catch (error) {
        await this.discardConnection();
        this.logger.error("Outbox publish failed", {
          error: errorName(error),
          tenantId,
        });
      }
    }
    return published;
  }

  public async close(): Promise<void> {
    await this.discardConnection();
  }

  private async publishTenantBatch(tenantId: string): Promise<number> {
    return withTenantTransaction(this.db, tenantId, async (tx) => {
      const rows = await this.claim(tx, tenantId);
      if (rows.length === 0) return 0;
      const channel = await this.connect();
      let published = 0;
      for (const row of rows) {
        try {
          channel.publish(
            exchange,
            row.event_type,
            Buffer.from(JSON.stringify(toEnvelope(row))),
            {
              persistent: true,
              contentType: "application/json",
              messageId: row.id,
              correlationId: row.correlation_id,
              type: row.event_type,
              // ADR-037: publication time travels as the AMQP timestamp.
              timestamp: Math.floor(Date.now() / 1000),
            },
          );
          await channel.waitForConfirms();
        } catch (error) {
          await this.discardConnection();
          await this.fail(tx, row, error);
          this.logger.warn("Outbox event not confirmed; backing off", {
            eventId: row.id,
            eventType: row.event_type,
            error: errorName(error),
          });
          // The rest of the batch stays due and is retried next run.
          break;
        }
        await tx("outbox_events").where({ id: row.id }).update({
          status: "PUBLISHED",
          published_at: tx.fn.now(),
          last_error: null,
          last_error_code: null,
        });
        published += 1;
      }
      return published;
    });
  }

  private claim(tx: Knex.Transaction, tenantId: string): Promise<OutboxRow[]> {
    return tx("outbox_events as e")
      .where("e.tenant_id", tenantId)
      .whereIn("e.status", ["PENDING", "FAILED"])
      .where("e.available_at", "<=", tx.fn.now())
      .whereNotExists(
        tx("outbox_events as earlier")
          .select(tx.raw("1"))
          .whereRaw("earlier.tenant_id = e.tenant_id")
          .whereRaw("earlier.aggregate_type = e.aggregate_type")
          .whereRaw("earlier.aggregate_id = e.aggregate_id")
          .whereRaw("earlier.aggregate_version < e.aggregate_version")
          // Only an earlier version that cannot be published now blocks:
          // one backing off, or one marked PROCESSING. A due earlier version
          // is claimed in this same batch and sorts first.
          .whereRaw(
            `(earlier.status = 'PROCESSING'
              OR (earlier.status IN ('PENDING', 'FAILED')
                  AND earlier.available_at > now()))`,
          ),
      )
      .orderBy([
        { column: "e.occurred_at", order: "asc" },
        { column: "e.aggregate_version", order: "asc" },
        { column: "e.id", order: "asc" },
      ])
      .forUpdate()
      .skipLocked()
      .limit(batchSize)
      .select<OutboxRow[]>(
        "e.id",
        "e.tenant_id",
        "e.aggregate_type",
        "e.aggregate_id",
        "e.aggregate_version",
        "e.event_type",
        "e.event_version",
        "e.payload",
        "e.correlation_id",
        "e.causation_id",
        "e.retry_count",
        "e.occurred_at",
      );
  }

  private async fail(
    tx: Knex.Transaction,
    row: OutboxRow,
    error: unknown,
  ): Promise<void> {
    const attempts = row.retry_count + 1;
    const lastError =
      error instanceof Error ? error.message.slice(0, 1000) : "Publish failed";
    if (attempts >= maxPublishAttempts) {
      await tx("outbox_events")
        .where({ id: row.id })
        .update({
          status: "DEAD_LETTER",
          retry_count: attempts,
          dead_lettered_at: tx.fn.now(),
          last_error: lastError,
          last_error_code: publishErrorCode(error),
        });
      this.logger.error("Outbox event dead-lettered", {
        eventId: row.id,
        eventType: row.event_type,
        attempts,
      });
      return;
    }
    await tx("outbox_events")
      .where({ id: row.id })
      .update({
        status: "FAILED",
        retry_count: attempts,
        // 2^9 seconds already exceeds the cap; a larger exponent would overflow.
        available_at: tx.raw(
          "now() + least(interval '5 minutes', interval '1 second' * power(2, least(?, 9)))",
          [row.retry_count],
        ),
        last_error: lastError,
        last_error_code: publishErrorCode(error),
      });
  }

  /** Drops a failed channel so the next run reconnects instead of reusing it. */
  private async discardConnection(): Promise<void> {
    const { channel, connection } = this;
    this.channel = undefined;
    this.connection = undefined;
    await channel?.close().catch(() => undefined);
    await connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<ConfirmChannel> {
    if (this.channel) return this.channel;
    if (this.openChannel) {
      this.channel = await this.openChannel();
      return this.channel;
    }
    const connection = await amqp.connect(this.url);
    const reset = () => {
      if (this.connection === connection) {
        this.connection = undefined;
        this.channel = undefined;
      }
    };
    connection.on("error", reset);
    connection.on("close", reset);
    try {
      const channel = await connection.createConfirmChannel();
      channel.on("error", reset);
      channel.on("close", reset);
      await channel.assertExchange(exchange, "topic", { durable: true });
      this.connection = connection;
      this.channel = channel;
      return channel;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }
}

/** Short category stored beside the free-text error (ADR-010 C). */
function publishErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection|socket|channel (closed|ended)/i.test(
    message,
  )
    ? "BROKER_UNAVAILABLE"
    : "PUBLISH_NOT_CONFIRMED";
}

/** Error class name only: messages can carry broker or connection detail. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
