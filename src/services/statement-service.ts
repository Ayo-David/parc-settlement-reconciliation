import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { withTenantTransaction } from "../database/client.js";
import type { StatementStore } from "../runtime/statement-store.js";
import { parseStatement } from "./statement-format.js";
import {
  type Actor,
  canonicalJson,
  priorResponse,
  recordResponse,
  SettlementError,
  sha256,
} from "./support.js";

export const participantKinds = [
  "PAYMENT_PROVIDER",
  "BANK",
  "BILLER_AGGREGATOR",
] as const;

export interface ParticipantView {
  id: string;
  code: string;
  name: string;
  kind: (typeof participantKinds)[number];
  currency: string;
  grace_days: number;
  status: "ACTIVE" | "INACTIVE";
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ImportView {
  id: string;
  participant_id: string;
  statement_date: string;
  file_name: string;
  content_sha256: string;
  size_bytes: number;
  line_count: number;
  total_in_minor: string;
  total_out_minor: string;
  supersedes_import_id: string | null;
  superseded: boolean;
  imported_by: string;
  created_at: string;
}

type ImportRow = Omit<
  ImportView,
  "total_in_minor" | "total_out_minor" | "created_at" | "superseded"
> & {
  total_in_minor: string | number;
  total_out_minor: string | number;
  created_at: Date;
  superseded?: boolean;
};

const importColumns = [
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
];

export function importView(row: ImportRow): ImportView {
  return {
    ...row,
    total_in_minor: String(row.total_in_minor),
    total_out_minor: String(row.total_out_minor),
    superseded: row.superseded ?? false,
    created_at: row.created_at.toISOString(),
  };
}

function participantView(row: Record<string, unknown>): ParticipantView {
  return {
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    kind: row.kind as ParticipantView["kind"],
    currency: (row.currency as string).trim(),
    grace_days: row.grace_days as number,
    status: row.status as ParticipantView["status"],
    version: row.version as number,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}

/** A query of active (not superseded) imports. */
export function activeImports(tx: Knex.Transaction, tenantId: string) {
  return tx("bank_statement_imports as i")
    .where("i.tenant_id", tenantId)
    .whereNotExists(
      tx("bank_statement_imports as later")
        .select(tx.raw("1"))
        .whereRaw("later.tenant_id = i.tenant_id")
        .whereRaw("later.supersedes_import_id = i.id"),
    );
}

/**
 * CB-7 slice A: settlement participants and statement ingestion (D180).
 * Statements are immutable evidence: the same file for the same participant
 * and date imports once; a different file for an imported date is refused
 * unless it is a correction, which supersedes the earlier import while no
 * run has used it yet.
 */
export class StatementService {
  public constructor(
    private readonly database: Knex,
    private readonly store: StatementStore,
  ) {}

  public listParticipants(tenantId: string): Promise<ParticipantView[]> {
    return withTenantTransaction(this.database, tenantId, async (tx) =>
      (
        await tx("settlement_participants")
          .where({ tenant_id: tenantId })
          .orderBy("code")
      ).map(participantView),
    );
  }

  public async createParticipant(
    tenantId: string,
    input: {
      code: string;
      name: string;
      kind: ParticipantView["kind"];
      currency: string;
      graceDays: number;
    },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<ParticipantView & { replayed: boolean }> {
    const requestHash = sha256(canonicalJson(input));
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const prior = await priorResponse<ParticipantView>(
        tx,
        tenantId,
        "participant.create",
        idempotencyKey,
        requestHash,
      );
      if (prior) return { ...prior, replayed: true };
      const [row] = await tx("settlement_participants")
        .insert({
          tenant_id: tenantId,
          code: input.code,
          name: input.name,
          kind: input.kind,
          currency: input.currency,
          grace_days: input.graceDays,
          created_by: actor.administratorId,
          updated_by: actor.administratorId,
        })
        .onConflict(["tenant_id", "code"])
        .ignore()
        .returning<Record<string, unknown>[]>("*");
      if (!row)
        throw new SettlementError(
          409,
          "PARTICIPANT_EXISTS",
          "A participant with this code exists",
        );
      const view = participantView(row);
      await recordResponse(
        tx,
        tenantId,
        "participant.create",
        idempotencyKey,
        requestHash,
        view,
      );
      return { ...view, replayed: false };
    });
  }

  /** Optimistic update of name, grace days and status (expected version). */
  public updateParticipant(
    tenantId: string,
    participantId: string,
    input: {
      version: number;
      name?: string | undefined;
      graceDays?: number | undefined;
      status?: ParticipantView["status"] | undefined;
    },
    actor: Actor,
  ): Promise<ParticipantView> {
    return withTenantTransaction(this.database, tenantId, async (tx) => {
      const [row] = await tx("settlement_participants")
        .where({
          tenant_id: tenantId,
          id: participantId,
          version: input.version,
        })
        .update({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.graceDays === undefined
            ? {}
            : { grace_days: input.graceDays }),
          ...(input.status === undefined ? {} : { status: input.status }),
          version: input.version + 1,
          updated_by: actor.administratorId,
          updated_at: tx.fn.now(),
        })
        .returning<Record<string, unknown>[]>("*");
      if (row) return participantView(row);
      const exists = await tx("settlement_participants")
        .where({ tenant_id: tenantId, id: participantId })
        .first<Record<string, unknown> | undefined>("id");
      throw exists
        ? new SettlementError(
            409,
            "VERSION_CONFLICT",
            "The participant changed",
          )
        : new SettlementError(
            404,
            "PARTICIPANT_NOT_FOUND",
            "No such participant",
          );
    });
  }

  public async importStatement(
    tenantId: string,
    input: {
      participantId: string;
      statementDate: string;
      fileName: string;
      content: Buffer;
      correction: boolean;
    },
    actor: Actor,
    idempotencyKey: string,
  ): Promise<ImportView & { replayed: boolean }> {
    const parsed = parseStatement(input.content);
    if (!parsed.ok)
      throw new SettlementError(
        422,
        "INVALID_STATEMENT",
        "The statement file is not in the canonical format",
        { issues: parsed.issues },
      );
    const contentSha = sha256(input.content);
    const requestHash = sha256(
      canonicalJson({
        participant_id: input.participantId,
        statement_date: input.statementDate,
        file_name: input.fileName,
        content_sha256: contentSha,
        correction: input.correction,
      }),
    );

    type Plan =
      | { kind: "replay"; view: ImportView }
      | { kind: "insert"; supersedes: string | null };
    const plan = async (tx: Knex.Transaction): Promise<Plan> => {
      const prior = await priorResponse<ImportView>(
        tx,
        tenantId,
        "statement.import",
        idempotencyKey,
        requestHash,
      );
      if (prior) return { kind: "replay", view: prior };
      const participant = await tx("settlement_participants")
        .where({ tenant_id: tenantId, id: input.participantId })
        .first<{ status: string; currency: string } | undefined>(
          "status",
          "currency",
        );
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
      const wrongCurrency = parsed.lines.find(
        (line) => line.currency !== participant.currency.trim(),
      );
      if (wrongCurrency)
        throw new SettlementError(
          422,
          "INVALID_STATEMENT",
          "Every line must be in the participant's currency",
          {
            issues: [
              {
                line: wrongCurrency.lineNumber + 1,
                field: "currency",
                code: "PARTICIPANT_CURRENCY",
              },
            ],
          },
        );
      const same = await tx("bank_statement_imports as i")
        .where({
          "i.tenant_id": tenantId,
          "i.participant_id": input.participantId,
          "i.statement_date": input.statementDate,
          "i.content_sha256": contentSha,
        })
        .first<ImportRow | undefined>(importColumns);
      if (same) return { kind: "replay", view: importView(same) };
      const current = await activeImports(tx, tenantId)
        .where({
          "i.participant_id": input.participantId,
          "i.statement_date": input.statementDate,
        })
        .first<{ id: string } | undefined>("i.id");
      if (!current) return { kind: "insert", supersedes: null };
      if (!input.correction)
        throw new SettlementError(
          409,
          "STATEMENT_ALREADY_IMPORTED",
          "A different statement was imported for this date; send it as a correction",
          { import_id: current.id },
        );
      const used = await tx("bank_statement_lines as l")
        .where({ "l.tenant_id": tenantId, "l.import_id": current.id })
        .where((query) => {
          query
            .whereExists(
              tx("reconciliation_matches as m")
                .select(tx.raw("1"))
                .whereRaw("m.tenant_id = l.tenant_id")
                .whereRaw("m.statement_line_id = l.id"),
            )
            .orWhereExists(
              tx("reconciliation_breaks as b")
                .select(tx.raw("1"))
                .whereRaw("b.tenant_id = l.tenant_id")
                .whereRaw("b.statement_line_id = l.id"),
            );
        })
        .first<Record<string, unknown> | undefined>("l.id");
      if (used)
        throw new SettlementError(
          409,
          "STATEMENT_ALREADY_RECONCILED",
          "A run has already used the statement this would correct",
          { import_id: current.id },
        );
      return { kind: "insert", supersedes: current.id };
    };

    const first = await withTenantTransaction(this.database, tenantId, plan);
    if (first.kind === "replay") return { ...first.view, replayed: true };

    const importId = randomUUID();
    const objectKey = `settlement/${tenantId}/${input.participantId}/${input.statementDate}/${importId}.csv.sealed`;
    await this.store.put(objectKey, input.content);
    try {
      return await withTenantTransaction(
        this.database,
        tenantId,
        async (tx) => {
          await tx.raw("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", [
            `statement:${tenantId}:${input.participantId}:${input.statementDate}`,
          ]);
          const decided = await plan(tx);
          if (decided.kind === "replay") {
            await this.store.remove(objectKey);
            return { ...decided.view, replayed: true };
          }
          const [row] = await tx("bank_statement_imports as i")
            .insert({
              id: importId,
              tenant_id: tenantId,
              participant_id: input.participantId,
              statement_date: input.statementDate,
              file_name: input.fileName,
              content_sha256: contentSha,
              size_bytes: input.content.length,
              object_key: objectKey,
              encryption_key_id: this.store.keyId,
              line_count: parsed.lines.length,
              total_in_minor: parsed.totalIn.toString(),
              total_out_minor: parsed.totalOut.toString(),
              supersedes_import_id: decided.supersedes,
              imported_by: actor.administratorId,
              correlation_id: actor.correlationId,
            })
            .returning<ImportRow[]>(
              importColumns.map((column) => column.slice(2)),
            );
          const rows = parsed.lines.map((line) => ({
            tenant_id: tenantId,
            import_id: importId,
            participant_id: input.participantId,
            line_number: line.lineNumber,
            line_reference: line.lineReference,
            provider_reference: line.providerReference,
            direction: line.direction,
            amount_minor: line.amountMinor,
            currency: line.currency,
            value_date: line.valueDate,
            narration: line.narration,
            line_hash: line.lineHash,
          }));
          await tx.batchInsert("bank_statement_lines", rows, 1000);
          const view = importView(row!);
          await recordResponse(
            tx,
            tenantId,
            "statement.import",
            idempotencyKey,
            requestHash,
            view,
          );
          return { ...view, replayed: false };
        },
      );
    } catch (error) {
      await this.store.remove(objectKey);
      throw error;
    }
  }
}
