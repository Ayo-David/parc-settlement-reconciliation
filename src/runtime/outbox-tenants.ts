import type { Knex } from "knex";

/**
 * CB1-11: tenants with outbox rows not yet published, through the SECURITY
 * DEFINER function settlement.outbox_tenants_with_work(). Returns tenant
 * UUIDs only; the publisher still claims each tenant's rows under its RLS
 * context.
 */
export async function outboxTenantsWithWork(database: Knex): Promise<string[]> {
  const result = await database.raw<{ rows: { tenant_id: string }[] }>(
    "SELECT tenant_id FROM settlement.outbox_tenants_with_work() AS tenant_id",
  );
  return result.rows.map((row) => row.tenant_id);
}
