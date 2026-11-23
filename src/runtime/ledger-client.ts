import {
  ParcTokenError,
  type ParcTokenClient,
  type TokenRequest,
} from "../security/parc-service-auth.js";

export interface JournalEntry {
  account_id: string;
  direction: "DEBIT" | "CREDIT";
  amount_minor: string;
}

export interface AdjustmentRequest {
  tenantId: string;
  /** Ledger's key: it fixes the approval binding's resource id. */
  idempotencyKey: string;
  correlationId: string;
  reference: string;
  currency: string;
  reason: string;
  entries: JournalEntry[];
}

export interface ApprovalBinding {
  action: string;
  resource_type: string;
  resource_id: string;
  payload_hash: string;
  amount_minor: string;
  currency: string;
}

export interface GlMapping {
  debit_account_id: string | null;
  credit_account_id: string | null;
}

/** Ledger answered and refused: nothing was posted (Ledger posts atomically). */
export class LedgerRefusedError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Ledger refused the request with ${status} ${code}`);
    this.name = "LedgerRefusedError";
  }
}

/** No definitive answer (unreachable, timeout or 5xx): the outcome is unknown. */
export class LedgerUnavailableError extends Error {
  public constructor(cause?: string) {
    super(`Ledger did not answer${cause ? `: ${cause}` : ""}`);
    this.name = "LedgerUnavailableError";
  }
}

/**
 * CB-7 slice B (D185, D186): what settlement needs from Ledger. GL mappings
 * are read as this service; adjustments are previewed and posted delegated
 * as the administrator, and Ledger consumes the tenant-admin approval.
 */
export interface LedgerGateway {
  /** Null when the tenant has no active mapping for the code and currency. */
  mapping(
    tenantId: string,
    eventCode: string,
    currency: string,
  ): Promise<GlMapping | null>;
  preview(request: AdjustmentRequest): Promise<ApprovalBinding>;
  post(request: AdjustmentRequest & { approvalId: string }): Promise<{
    adjustment_id: string;
    transaction_id: string;
    replayed: boolean;
  }>;
}

export class HttpLedgerGateway implements LedgerGateway {
  public constructor(
    private readonly baseUrl: string,
    private readonly tokens: Pick<ParcTokenClient, "authorization">,
    private readonly timeoutMs = 10_000,
  ) {}

  public async mapping(
    tenantId: string,
    eventCode: string,
    currency: string,
  ): Promise<GlMapping | null> {
    const url = new URL(
      `/internal/v1/account-mappings/${encodeURIComponent(eventCode)}`,
      this.baseUrl,
    );
    url.searchParams.set("currency", currency);
    const response = await this.send(url, {
      method: "GET",
      headers: {
        authorization: await this.token({
          audience: "parc-ledger",
          scopes: ["ledger.mappings.read"],
          tenantId,
          mode: "service",
        }),
        "x-tenant-id": tenantId,
        "x-calling-service": "parc-settlement-reconciliation",
      },
    });
    if (response.status === 404) return null;
    const body = await this.body(response);
    return {
      debit_account_id: stringOrNull(body.debit_account_id),
      credit_account_id: stringOrNull(body.credit_account_id),
    };
  }

  public async preview(request: AdjustmentRequest): Promise<ApprovalBinding> {
    const response = await this.send(
      new URL("/internal/v1/manual-adjustments/preview", this.baseUrl),
      await this.adjustment(request),
    );
    const body = await this.body(response);
    return {
      action: String(body.action),
      resource_type: String(body.resource_type),
      resource_id: String(body.resource_id),
      payload_hash: String(body.payload_hash),
      amount_minor: String(body.amount_minor),
      currency: String(body.currency),
    };
  }

  public async post(request: AdjustmentRequest & { approvalId: string }) {
    const response = await this.send(
      new URL("/internal/v1/manual-adjustments", this.baseUrl),
      await this.adjustment(request, request.approvalId),
    );
    const body = await this.body(response);
    if (
      typeof body.adjustment_id !== "string" ||
      typeof body.transaction_id !== "string"
    )
      throw new LedgerUnavailableError("malformed adjustment response");
    return {
      adjustment_id: body.adjustment_id,
      transaction_id: body.transaction_id,
      replayed: body.replayed === true,
    };
  }

  private async adjustment(
    request: AdjustmentRequest,
    approvalId?: string,
  ): Promise<RequestInit> {
    return {
      method: "POST",
      headers: {
        authorization: await this.token({
          audience: "parc-ledger",
          scopes: ["ledger.adjustments.write"],
          tenantId: request.tenantId,
          mode: "delegated",
        }),
        "content-type": "application/json",
        "x-tenant-id": request.tenantId,
        "x-calling-service": "parc-settlement-reconciliation",
        "x-correlation-id": request.correlationId,
        "idempotency-key": request.idempotencyKey,
      },
      body: JSON.stringify({
        ...(approvalId ? { approval_id: approvalId } : {}),
        reference: request.reference,
        currency: request.currency,
        reason: request.reason,
        entries: request.entries,
      }),
    };
  }

  /**
   * Auth refuses the exchange when the administrator lacks the Ledger
   * permission (ledger.adjustment.post) or the session ended: a definitive
   * refusal before anything reached Ledger. Other token failures are unknown.
   */
  private async token(request: TokenRequest): Promise<string> {
    try {
      return await this.tokens.authorization(request);
    } catch (error) {
      if (
        error instanceof ParcTokenError &&
        (error.status === 0 || (error.status >= 400 && error.status < 500))
      )
        throw new LedgerRefusedError(403, "LEDGER_PERMISSION_REQUIRED");
      throw new LedgerUnavailableError("token");
    }
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new LedgerUnavailableError(
        error instanceof Error ? error.name : "network",
      );
    }
  }

  private async body(response: Response): Promise<Record<string, unknown>> {
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (response.ok) return body;
    if (response.status >= 400 && response.status < 500)
      throw new LedgerRefusedError(
        response.status,
        typeof body.code === "string" ? body.code : "LEDGER_REFUSED",
      );
    throw new LedgerUnavailableError(String(response.status));
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
