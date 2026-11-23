import { randomUUID } from "node:crypto";
import knex, { type Knex } from "knex";
import { createDatabase } from "../src/database/client.js";
import { outboxTenantsWithWork } from "../src/runtime/outbox-tenants.js";
import { SettlementReadService } from "../src/services/read-service.js";
import { ReconciliationService } from "../src/services/reconciliation-service.js";
import { StatementService } from "../src/services/statement-service.js";
import {
  actor,
  adminUrl,
  appUrl,
  describeDatabase,
  memoryStore,
  statement,
} from "./helpers.js";

const settlementRoles = [
  "parc_settlement_migrator",
  "parc_settlement_app",
  "parc_settlement_runtime",
  "parc_settlement_worker",
  "parc_settlement_readonly",
];
const treasuryRoles = settlementRoles.map((role) =>
  role.replace("settlement", "treasury"),
);

/**
 * ADR-023 and D178: the shared database's grant isolation, forced RLS on
 * every tenant table (CB1-10), tenant isolation through the service code,
 * and CB1-11 discovery.
 */
describeDatabase("settlement isolation", () => {
  let admin: Knex;
  const database = createDatabase(appUrl ?? "");

  beforeAll(() => {
    admin = knex({ client: "pg", connection: adminUrl ?? "" });
  });
  afterAll(async () => {
    await admin.destroy();
    await database.destroy();
  });

  it("gives no settlement role any right on the treasury schema, and the reverse", async () => {
    const check = async (roles: string[], schema: string) =>
      (
        await admin.raw<{
          rows: { role: string; usage: boolean; create: boolean }[];
        }>(
          `SELECT r AS role, has_schema_privilege(r, ?, 'USAGE') AS usage,
                  has_schema_privilege(r, ?, 'CREATE') AS create
             FROM unnest(?::text[]) AS r`,
          [schema, schema, roles],
        )
      ).rows.filter((row) => row.usage || row.create);
    expect(await check(settlementRoles, "treasury")).toEqual([]);
    expect(await check(treasuryRoles, "settlement")).toEqual([]);
    // Nobody can create objects in public either.
    expect(
      await check([...settlementRoles, ...treasuryRoles], "public"),
    ).toEqual([]);
  });

  it("refuses the settlement owner when it reaches into the treasury schema", async () => {
    await expect(
      admin.transaction(async (tx) => {
        await tx.raw("SET LOCAL ROLE parc_settlement_migrator");
        await tx.raw("CREATE TABLE treasury.probe (id int)");
      }),
    ).rejects.toThrow(/permission denied for schema treasury/);
    await expect(
      admin.transaction(async (tx) => {
        await tx.raw("SET LOCAL ROLE parc_treasury_migrator");
        await tx.raw("SELECT count(*) FROM settlement.expected_items");
      }),
    ).rejects.toThrow(/permission denied for schema settlement/);
  });

  it("keeps every settlement object in the settlement schema, owned by its migrator", async () => {
    const result = await admin.raw<{
      rows: { schema: string; owner: string }[];
    }>(
      `SELECT DISTINCT n.nspname AS schema, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('settlement', 'public') AND c.relkind IN ('r','p','v','S')`,
    );
    expect(result.rows).toEqual([
      { schema: "settlement", owner: "parc_settlement_migrator" },
    ]);
  });

  it("forces RLS with a policy on every tenant table", async () => {
    const result = await admin.raw<{
      rows: {
        table: string;
        enabled: boolean;
        forced: boolean;
        policies: number;
      }[];
    }>(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'settlement' AND c.relkind IN ('r','p')
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                       AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
    );
    expect(
      result.rows.filter(
        (row) => !row.enabled || !row.forced || row.policies === 0,
      ),
    ).toEqual([]);
    // 12 from SET-DB-001, plus posting_requests, suspense_investigations and
    // suspense_investigation_notes from SET-DB-002 (CB-7 slice B), plus
    // admin_exports and admin_export_downloads from SET-DB-003 (slice D).
    expect(result.rows.length).toBe(17);
  });

  it("grants no DELETE or TRUNCATE to the runtime, worker or read-only roles", async () => {
    const result = await admin.raw<{ rows: unknown[] }>(
      `SELECT table_name, grantee FROM information_schema.role_table_grants
        WHERE table_schema = 'settlement'
          AND grantee IN ('parc_settlement_runtime','parc_settlement_worker',
                          'parc_settlement_readonly','parc_settlement_app')
          AND privilege_type IN ('DELETE','TRUNCATE')`,
    );
    expect(result.rows).toEqual([]);
  });

  it("shows the app nothing without a tenant, and one tenant nothing of another's", async () => {
    const statements = new StatementService(database, memoryStore());
    const reconciliation = new ReconciliationService(database);
    const reads = new SettlementReadService(database);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const participant = await statements.createParticipant(
      tenantA,
      {
        code: "BANK1",
        name: "Bank",
        kind: "BANK",
        currency: "NGN",
        graceDays: 1,
      },
      actor(),
      randomUUID(),
    );
    const imported = await statements.importStatement(
      tenantA,
      {
        participantId: participant.id,
        statementDate: "2026-11-10",
        fileName: "a.csv",
        content: statement([
          { ref: "L1", direction: "IN", amount: "9", date: "2026-11-10" },
        ]),
        correction: false,
      },
      actor(),
      randomUUID(),
    );
    await reconciliation.startRun(
      tenantA,
      {
        participantId: participant.id,
        periodFrom: "2026-11-10",
        periodTo: "2026-11-10",
      },
      actor(),
      randomUUID(),
    );

    expect(await statements.listParticipants(tenantB)).toEqual([]);
    expect((await reads.listBreaks(tenantB, { pageSize: 10 })).items).toEqual(
      [],
    );
    await expect(reads.getImport(tenantB, imported.id)).rejects.toMatchObject({
      code: "IMPORT_NOT_FOUND",
    });
    // B cannot run against A's participant.
    await expect(
      reconciliation.startRun(
        tenantB,
        {
          participantId: participant.id,
          periodFrom: "2026-11-10",
          periodTo: "2026-11-10",
        },
        actor(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "PARTICIPANT_NOT_FOUND" });
    // Without a tenant context the app sees no rows at all.
    const seen = await database("reconciliation_breaks").count<
      { count: string }[]
    >("* as count");
    expect(Number(seen[0]?.count)).toBe(0);
    // And it cannot write a row for another tenant than its context.
    await expect(
      database.transaction(async (tx) => {
        await tx.raw("SELECT set_config('app.current_tenant_id', ?, true)", [
          tenantB,
        ]);
        await tx("settlement_participants").insert({
          tenant_id: tenantA,
          code: "X",
          name: "X",
          kind: "BANK",
          currency: "NGN",
          created_by: randomUUID(),
          updated_by: randomUUID(),
        });
      }),
    ).rejects.toThrow(/row-level security/);

    // CB1-11: the worker finds tenants with unpublished events, ids only.
    expect(await outboxTenantsWithWork(database)).toContain(tenantA);
  });

  it("lets only the worker call the SECURITY DEFINER functions", async () => {
    const result = await admin.raw<{
      rows: {
        fn: string;
        runtime: boolean;
        worker: boolean;
        readonly: boolean;
      }[];
    }>(
      `SELECT p.proname AS fn,
              has_function_privilege('parc_settlement_runtime', p.oid, 'EXECUTE') AS runtime,
              has_function_privilege('parc_settlement_worker', p.oid, 'EXECUTE') AS worker,
              has_function_privilege('parc_settlement_readonly', p.oid, 'EXECUTE') AS readonly
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'settlement' AND p.prosecdef
        ORDER BY p.proname`,
    );
    expect(result.rows).toEqual([
      {
        fn: "outbox_tenants_with_work",
        runtime: false,
        worker: true,
        readonly: false,
      },
      // CB-7 slice D (SET-DB-003): clears expired export files.
      {
        fn: "purge_expired_admin_exports",
        runtime: false,
        worker: true,
        readonly: false,
      },
    ]);
  });
});
