import { createHash } from "node:crypto";
import type { Knex } from "knex";

/** A refusal the API reports with its status and code. */
export class SettlementError extends Error {
  public constructor(
    public readonly status: 400 | 404 | 409 | 422 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "SettlementError";
  }
}

export interface Actor {
  administratorId: string;
  correlationId: string;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON (sorted keys), so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The calendar date in Africa/Lagos (UTC+1, no daylight saving). */
export function lagosDate(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);
}

/** Days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export interface OutboxFact {
  tenantId: string;
  aggregateType: "reconciliation_run" | "reconciliation_break";
  aggregateId: string;
  aggregateVersion: number;
  eventType: string;
  payload: Record<string, unknown>;
  correlationId: string;
}

/** Writes an event in the caller's transaction (transactional outbox). */
export async function enqueue(
  tx: Knex.Transaction,
  fact: OutboxFact,
): Promise<void> {
  await tx("outbox_events").insert({
    tenant_id: fact.tenantId,
    aggregate_type: fact.aggregateType,
    aggregate_id: fact.aggregateId,
    aggregate_version: fact.aggregateVersion,
    event_type: fact.eventType,
    event_version: 1,
    payload: fact.payload,
    correlation_id: fact.correlationId,
  });
}

/**
 * Replays a finished command: the same key with the same request returns the
 * first response; with a different request it is refused.
 */
export async function priorResponse<T>(
  tx: Knex.Transaction,
  tenantId: string,
  operation: string,
  key: string,
  requestHash: string,
): Promise<T | undefined> {
  const row = await tx("idempotency_keys")
    .where({ tenant_id: tenantId, operation, idempotency_key: key })
    .first<{ request_hash: string; response: T } | undefined>(
      "request_hash",
      "response",
    );
  if (!row) return undefined;
  if (row.request_hash !== requestHash)
    throw new SettlementError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was used for a different request",
    );
  return row.response;
}

export async function recordResponse(
  tx: Knex.Transaction,
  tenantId: string,
  operation: string,
  key: string,
  requestHash: string,
  response: unknown,
): Promise<void> {
  await tx("idempotency_keys").insert({
    tenant_id: tenantId,
    operation,
    idempotency_key: key,
    request_hash: requestHash,
    response: JSON.stringify(response),
  });
}

/** Opaque keyset cursor over (timestamp, id). */
export function encodeCursor(at: Date | string, id: string): string {
  const iso = at instanceof Date ? at.toISOString() : at;
  return Buffer.from(JSON.stringify([iso, id])).toString("base64url");
}

export function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      !Number.isNaN(Date.parse(value[0])) &&
      typeof value[1] === "string" &&
      /^[0-9a-f-]{36}$/i.test(value[1])
    )
      return { at: value[0], id: value[1] };
  } catch {
    // fall through
  }
  throw new SettlementError(
    400,
    "INVALID_CURSOR",
    "The page cursor is invalid",
  );
}
