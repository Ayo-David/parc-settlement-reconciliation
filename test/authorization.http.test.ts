import { randomUUID } from "node:crypto";
import { jest } from "@jest/globals";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { StatementStoreUnavailableError } from "../src/runtime/statement-store.js";
import { createParcAuth } from "../src/security/parc-service-auth.js";
import type { SettlementReadService } from "../src/services/read-service.js";
import type { ReconciliationService } from "../src/services/reconciliation-service.js";
import type { StatementService } from "../src/services/statement-service.js";
import { SettlementError } from "../src/services/support.js";

const issuer = "https://auth.parc.invalid";
const tenantId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

/**
 * CB-7 slice A (D183, D184): reads need settlement.reconciliation.read and
 * commands settlement.reconciliation.manage, on a delegated administrator
 * token through the Admin BFF, for the token's tenant. Commands need an
 * Idempotency-Key. Signed tokens, real verification.
 */
describe("settlement-reconciliation routes", () => {
  let sign: (claims: Record<string, unknown>) => Promise<string>;
  const ok = (value: Record<string, unknown> = {}) =>
    Promise.resolve({ replayed: false, ...value });
  const page = () =>
    Promise.resolve({
      items: [],
      page: { has_more: false, next_cursor: null },
    });
  const statements = {
    listParticipants: jest.fn(() => Promise.resolve([])),
    createParticipant: jest.fn(() => ok({ id })),
    updateParticipant: jest.fn(() => ok({ id })),
    importStatement: jest.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      ok({ id }),
    ),
  };
  const reconciliation = {
    startRun: jest.fn(() => ok({ id })),
    resolveBreak: jest.fn(() => ok({ break_id: id })),
  };
  const reads = {
    listImports: jest.fn(page),
    getImport: jest.fn(() => ok()),
    listLines: jest.fn(page),
    listRuns: jest.fn(page),
    getRun: jest.fn(() => ok()),
    listBreaks: jest.fn(page),
    getBreak: jest.fn(() => ok()),
  };
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" }],
    });
    sign = (claims) =>
      new SignJWT({ ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience("parc-settlement-reconciliation")
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    app = createApp({
      access: createParcAuth({
        issuer,
        audience: "parc-settlement-reconciliation",
        keys: jwks,
      }),
      statements: statements as unknown as StatementService,
      reconciliation: reconciliation as unknown as ReconciliationService,
      reads: reads as unknown as SettlementReadService,
    });
  });
  beforeEach(() => jest.clearAllMocks());

  const administrator = (
    scope: string,
    overrides: Record<string, unknown> = {},
  ) =>
    sign({
      sub: "33333333-3333-4333-8333-333333333333",
      client_id: "parc-admin-bff",
      token_use: "delegated",
      subject_type: "ADMINISTRATOR",
      session_id: randomUUID(),
      act: { sub: "parc-admin-bff" },
      tenant_id: tenantId,
      scope,
      ...overrides,
    });
  const READ = "settlement.reconciliation.read";
  const MANAGE = "settlement.reconciliation.manage";
  const csv = Buffer.from("x").toString("base64");

  const reads_ = [
    "/internal/v1/settlement-participants",
    "/internal/v1/statement-imports",
    `/internal/v1/statement-imports/${id}`,
    `/internal/v1/statement-imports/${id}/lines`,
    "/internal/v1/reconciliation-runs",
    `/internal/v1/reconciliation-runs/${id}`,
    "/internal/v1/reconciliation-breaks",
    `/internal/v1/reconciliation-breaks/${id}`,
  ];
  const commands: [string, string, object][] = [
    [
      "post",
      "/internal/v1/settlement-participants",
      { code: "PAYSTACK", name: "Paystack", kind: "PAYMENT_PROVIDER" },
    ],
    [
      "put",
      `/internal/v1/settlement-participants/${id}`,
      { version: 1, grace_days: 3 },
    ],
    [
      "post",
      "/internal/v1/statement-imports",
      {
        participant_id: id,
        statement_date: "2026-11-10",
        file_name: "a.csv",
        content_base64: csv,
      },
    ],
    [
      "post",
      "/internal/v1/reconciliation-runs",
      {
        participant_id: id,
        period_from: "2026-11-01",
        period_to: "2026-11-10",
      },
    ],
    [
      "post",
      `/internal/v1/reconciliation-breaks/${id}/resolve`,
      { resolution_type: "OTHER", note: "Checked with the provider" },
    ],
  ];
  const send = (
    method: string,
    path: string,
    token: string,
    body?: object,
    key = "k-1",
  ) => {
    const call =
      method === "get"
        ? request(app).get(path)
        : (method === "put"
            ? request(app).put(path)
            : request(app).post(path)
          ).set("idempotency-key", key);
    return call.set("authorization", `Bearer ${token}`).send(body);
  };

  it.each(reads_)("GET %s needs the read scope", async (path) => {
    expect((await send("get", path, await administrator(READ))).status).toBe(
      200,
    );
    const denied = await send("get", path, await administrator(MANAGE));
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
    expect((await request(app).get(path)).status).toBe(401);
  });

  it.each(commands)(
    "%s %s needs the manage scope",
    async (method, path, body) => {
      const done = await send(method, path, await administrator(MANAGE), body);
      expect([200, 201]).toContain(done.status);
      const denied = await send(method, path, await administrator(READ), body);
      expect(denied.status).toBe(403);
    },
  );

  it("accepts only administrators through the Admin BFF, for their tenant", async () => {
    const path = "/internal/v1/reconciliation-breaks";
    const fromMobile = await administrator(READ, {
      client_id: "parc-mobile-bff",
      act: { sub: "parc-mobile-bff" },
    });
    expect((await send("get", path, fromMobile)).body).toMatchObject({
      code: "CALLER_FORBIDDEN",
    });
    const customer = await administrator(READ, { subject_type: "CUSTOMER" });
    expect((await send("get", path, customer)).body).toMatchObject({
      code: "SUBJECT_FORBIDDEN",
    });
    const service = await sign({
      sub: "parc-admin-bff",
      client_id: "parc-admin-bff",
      token_use: "service",
      tenant_id: tenantId,
      scope: READ,
    });
    expect((await send("get", path, service)).body).toMatchObject({
      code: "TOKEN_KIND_FORBIDDEN",
    });
    const other = await request(app)
      .get(path)
      .set("authorization", `Bearer ${await administrator(READ)}`)
      .set("x-tenant-id", randomUUID());
    expect(other.body).toMatchObject({ code: "TENANT_MISMATCH" });
    expect(reads.listBreaks).not.toHaveBeenCalled();
  });

  it("passes the token's tenant and administrator to the service", async () => {
    await send(
      "post",
      ...([
        commands[3]![1],
        await administrator(MANAGE),
        commands[3]![2],
      ] as const),
    );
    expect(reconciliation.startRun).toHaveBeenCalledWith(
      tenantId,
      { participantId: id, periodFrom: "2026-11-01", periodTo: "2026-11-10" },
      expect.objectContaining({
        administratorId: "33333333-3333-4333-8333-333333333333",
      }),
      "k-1",
    );
  });

  it("requires an Idempotency-Key on commands", async () => {
    const response = await request(app)
      .post("/internal/v1/reconciliation-runs")
      .set("authorization", `Bearer ${await administrator(MANAGE)}`)
      .send(commands[3]![2]);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("validates bodies strictly and refuses non-canonical base64", async () => {
    const token = await administrator(MANAGE);
    const extra = await send(
      "post",
      "/internal/v1/reconciliation-runs",
      token,
      {
        ...commands[3]![2],
        tolerance: 5,
      },
    );
    expect(extra.status).toBe(400);
    const badDate = await send(
      "post",
      "/internal/v1/reconciliation-runs",
      token,
      {
        participant_id: id,
        period_from: "2026-02-30",
        period_to: "2026-03-01",
      },
    );
    expect(badDate.status).toBe(400);
    const shortNote = await send(
      "post",
      `/internal/v1/reconciliation-breaks/${id}/resolve`,
      token,
      {
        resolution_type: "OTHER",
        note: "short",
      },
    );
    expect(shortNote.status).toBe(400);
    const base64 = await send("post", "/internal/v1/statement-imports", token, {
      ...commands[2]![2],
      content_base64: "eA",
    });
    expect(base64.body).toMatchObject({ code: "INVALID_REQUEST" });
    expect(statements.importStatement).not.toHaveBeenCalled();
  });

  it("maps statement refusals and store outages", async () => {
    const token = await administrator(MANAGE);
    statements.importStatement.mockRejectedValueOnce(
      new SettlementError(422, "INVALID_STATEMENT", "bad", {
        issues: [{ line: 2, code: "IN_OR_OUT" }],
      }),
    );
    const invalid = await send(
      "post",
      "/internal/v1/statement-imports",
      token,
      commands[2]![2],
    );
    expect(invalid.status).toBe(422);
    expect(invalid.body).toMatchObject({
      code: "INVALID_STATEMENT",
      details: { issues: [{ line: 2, code: "IN_OR_OUT" }] },
    });
    statements.importStatement.mockRejectedValueOnce(
      new StatementStoreUnavailableError(),
    );
    const down = await send(
      "post",
      "/internal/v1/statement-imports",
      token,
      commands[2]![2],
    );
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({ code: "STATEMENT_STORE_UNAVAILABLE" });
  });

  it("answers 404 for a malformed id and never caches", async () => {
    const response = await send(
      "get",
      "/internal/v1/reconciliation-breaks/not-a-uuid",
      await administrator(READ),
    );
    expect(response.status).toBe(404);
    const listed = await send(
      "get",
      "/internal/v1/reconciliation-breaks",
      await administrator(READ),
    );
    expect(listed.headers["cache-control"]).toBe("no-store");
  });
});
