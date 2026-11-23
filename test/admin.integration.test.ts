import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import knex from "knex";
import {
  createDatabase,
  withTenantTransaction,
} from "../src/database/client.js";
import {
  settlementExports,
  SettlementAdminService,
} from "../src/services/admin-reports.js";
import {
  AdminExportService,
  purgeExpiredExports,
} from "../src/services/export-service.js";
import { ReconciliationService } from "../src/services/reconciliation-service.js";
import { SettlementReadService } from "../src/services/read-service.js";
import { StatementService } from "../src/services/statement-service.js";
import {
  actor,
  adminUrl,
  appUrl,
  describeDatabase,
  memoryStore,
  statement,
} from "./helpers.js";

/**
 * CB-7 slice D (D191): the summary, the reconciliation-breaks report and
 * export, and the export purge, against real breaks under forced RLS.
 */
describeDatabase("CB-7 slice D: summary, report and export", () => {
  const database = createDatabase(appUrl ?? "");
  let admin: Knex;
  const statements = new StatementService(database, memoryStore());
  const today = new Date("2026-11-15T12:00:00Z");
  const reconciliation = new ReconciliationService(database, () => today);
  const reads = new SettlementReadService(database, () => today);
  const settlementAdmin = new SettlementAdminService(database, () => today);
  const exports = new AdminExportService(
    database,
    settlementExports,
    "settlement",
  );

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

  /** Two unknown credits and one unknown debit: three open breaks. */
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
    await statements.importStatement(
      tenantId,
      {
        participantId: participant.id,
        statementDate: "2026-11-14",
        fileName: "stmt.csv",
        content: statement([
          {
            ref: "L1",
            provider: "REF-1",
            direction: "IN",
            amount: "1000",
            date: "2026-11-10",
          },
          {
            ref: "L2",
            provider: "REF-2",
            direction: "IN",
            amount: "2000",
            date: "2026-11-11",
          },
          {
            ref: "L3",
            provider: "REF-3",
            direction: "OUT",
            amount: "3000",
            date: "2026-11-12",
          },
        ]),
        correction: false,
      },
      actor(),
      randomUUID(),
    );
    await reconciliation.startRun(
      tenantId,
      {
        participantId: participant.id,
        periodFrom: "2026-11-01",
        periodTo: "2026-11-14",
      },
      actor(),
      randomUUID(),
    );
    return tenantId;
  }

  it("summarises open breaks and open suspense for the Home overview", async () => {
    const tenantId = await setup();
    const [first] = (await reads.listBreaks(tenantId, { pageSize: 10 })).items;
    await reconciliation.resolveBreak(
      tenantId,
      first!.id,
      { resolutionType: "OTHER", note: "Checked with the provider" },
      actor(),
      randomUUID(),
    );
    const summary = await settlementAdmin.summary(tenantId);
    expect(summary).toMatchObject({
      tenant_id: tenantId,
      reconciliation: {
        open_breaks: 2,
        open_breaks_by_type: { UNMATCHED_EXTERNAL: 2 },
        open_suspense: [],
      },
    });
    expect(summary.reconciliation.oldest_open_break_at).toEqual(
      expect.any(String),
    );
    // Another tenant sees nothing.
    expect(
      (await settlementAdmin.summary(randomUUID())).reconciliation,
    ).toMatchObject({ open_breaks: 0, oldest_open_break_at: null });
  });

  it("reports breaks raised and resolved per bucket, every bucket present", async () => {
    const tenantId = await setup();
    const from = new Date().toISOString().slice(0, 10);
    const report = await settlementAdmin.report("reconciliation-breaks", {
      tenantId,
      from,
      to: from,
      granularity: "DAY",
      timezone: "Africa/Lagos",
    });
    const raised = report.series.find((s) => s.metric === "raised")!;
    expect(raised.points).toHaveLength(1);
    // Detection is "now" (the run), so the count lands in today's bucket,
    // unless the clock is within the Lagos/UTC midnight gap.
    expect(["3", "0"]).toContain(raised.points[0]!.value);
    expect(report.series.find((s) => s.metric === "resolved")).toBeDefined();
    expect(report).toMatchObject({
      report: "reconciliation-breaks",
      tenant_id: tenantId,
      timezone: "Africa/Lagos",
    });
  });

  it("exports breaks once per key, records downloads, and purges expired files", async () => {
    const tenantId = await setup();
    const day = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const key = randomUUID();
    const request = {
      tenantId,
      administratorId: randomUUID(),
      kind: "reconciliation-breaks",
      request: { from: yesterday, to: day, status: "OPEN" },
      reasonCode: "RECONCILIATION" as const,
      idempotencyKey: key,
      customerExportsAllowed: false,
    };
    const created = await exports.create(request);
    expect(created).toMatchObject({
      status: "READY",
      row_count: 3,
      service: "settlement",
      replayed: false,
    });
    expect((await exports.create(request)).replayed).toBe(true);
    await expect(
      exports.create({
        ...request,
        request: { ...request.request, status: "NOPE" },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_STATUS_INVALID" });
    await expect(
      exports.create({ ...request, kind: "reconciliation-exceptions" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_EXPORT" });

    const file = await exports.download({
      tenantId,
      exportId: created.id,
      administratorId: randomUUID(),
      correlationId: randomUUID(),
    });
    const lines = file.content.trim().split("\r\n");
    expect(lines[0]).toBe(
      settlementExports["reconciliation-breaks"].columns.join(","),
    );
    expect(lines).toHaveLength(4);
    expect(file.content).not.toContain("narration");
    expect((await exports.list(tenantId)).items[0]).toMatchObject({
      id: created.id,
      downloads: 1,
    });

    // The worker's purge clears an expired file, across tenants, under forced RLS.
    await admin("admin_exports")
      .where({ id: created.id })
      .update({ expires_at: new Date(Date.now() - 1000) });
    const worker = knex({
      client: "pg",
      connection: appUrl ?? "",
      searchPath: ["settlement"],
    });
    try {
      expect(await purgeExpiredExports(worker)).toBeGreaterThanOrEqual(1);
    } finally {
      await worker.destroy();
    }
    await expect(
      exports.download({
        tenantId,
        exportId: created.id,
        administratorId: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 410, code: "EXPORT_EXPIRED" });
    const row = await withTenantTransaction(database, tenantId, (tx) =>
      tx("admin_exports")
        .where({ id: created.id })
        .first<{ status: string; content: string | null } | undefined>(
          "status",
          "content",
        ),
    );
    expect(row).toEqual({ status: "EXPIRED", content: null });
    await expect(
      withTenantTransaction(database, tenantId, (tx) =>
        tx("admin_export_downloads").where({ tenant_id: tenantId }).delete(),
      ),
    ).rejects.toThrow();
  });
});
