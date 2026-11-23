import type { Knex } from "knex";

/**
 * CB-7 slice D (SET-DB-003; D191): administrator exports, as Ledger's
 * ADR-010 B design (parc-ledger 202611090011_admin_exports), in the
 * `settlement` schema. Additive only.
 *
 * - `admin_exports`: one CSV of at most 50,000 rows with its SHA-256, kept for
 *   24 hours; then `purge_expired_admin_exports()` clears the file.
 * - `admin_export_downloads` (insert-only): every download, attributed.
 * - Forced RLS on both. The purge function is SECURITY DEFINER and owned by
 *   the migrator, which forced RLS also binds, so an owner-only policy lets it
 *   see expired rows of every tenant (the CB1-11 discovery pattern).
 */
const S = "settlement";
const runtime = "parc_settlement_runtime";
const worker = "parc_settlement_worker";
const readonly = "parc_settlement_readonly";

const tenantPolicy = (table: string) => `
  ALTER TABLE ${S}.${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${S}.${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY ${table}_tenant_policy ON ${S}.${table}
    USING (tenant_id = (NULLIF(current_setting('app.current_tenant_id', true), ''))::uuid)
    WITH CHECK (tenant_id = (NULLIF(current_setting('app.current_tenant_id', true), ''))::uuid);
  GRANT SELECT ON ${S}.${table} TO ${readonly};
`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE ${S}.admin_exports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      kind varchar(100) NOT NULL,
      parameters jsonb NOT NULL,
      status varchar(20) NOT NULL CHECK (status IN ('READY','FAILED','EXPIRED')),
      requested_by uuid NOT NULL,
      reason_code varchar(50) NOT NULL,
      idempotency_key varchar(200) NOT NULL,
      request_hash character(64) NOT NULL,
      row_count integer CHECK (row_count IS NULL OR row_count BETWEEN 0 AND 50000),
      byte_size integer,
      content text,
      content_sha256 character(64),
      failure_code varchar(100),
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      expires_at timestamptz NOT NULL,
      CONSTRAINT uq_admin_export_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_admin_export_idempotency UNIQUE (tenant_id, idempotency_key),
      CONSTRAINT chk_admin_export_ready CHECK (
        status <> 'READY' OR (content IS NOT NULL AND content_sha256 IS NOT NULL AND row_count IS NOT NULL))
    );
    COMMENT ON TABLE ${S}.admin_exports IS
      'CB-7 slice D (D191): administrator CSV exports, kept 24 hours, then cleared by purge_expired_admin_exports().';
    CREATE INDEX idx_admin_exports_tenant ON ${S}.admin_exports (tenant_id, created_at DESC, id DESC);
    CREATE INDEX idx_admin_exports_expiry ON ${S}.admin_exports (expires_at) WHERE status = 'READY';
    ${tenantPolicy("admin_exports")}
    GRANT SELECT, INSERT ON ${S}.admin_exports TO ${runtime};

    CREATE TABLE ${S}.admin_export_downloads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      export_id uuid NOT NULL,
      downloaded_by uuid NOT NULL,
      correlation_id uuid,
      downloaded_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_admin_export_download FOREIGN KEY (tenant_id, export_id)
        REFERENCES ${S}.admin_exports (tenant_id, id)
    );
    CREATE INDEX idx_admin_export_downloads_export ON ${S}.admin_export_downloads (tenant_id, export_id, downloaded_at);
    ${tenantPolicy("admin_export_downloads")}
    GRANT SELECT, INSERT ON ${S}.admin_export_downloads TO ${runtime};
    CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON ${S}.admin_export_downloads
      FOR EACH ROW EXECUTE FUNCTION ${S}.reject_mutation();

    CREATE FUNCTION ${S}.purge_expired_admin_exports() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ${S} AS $fn$
    DECLARE purged integer;
    BEGIN
      UPDATE ${S}.admin_exports
         SET status = 'EXPIRED', content = NULL
       WHERE status = 'READY' AND expires_at <= now();
      GET DIAGNOSTICS purged = ROW_COUNT;
      RETURN purged;
    END $fn$;
    REVOKE ALL ON FUNCTION ${S}.purge_expired_admin_exports() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${S}.purge_expired_admin_exports() TO ${worker};
    -- The function's owner reads and clears expired files of every tenant.
    CREATE POLICY admin_exports_purge_owner ON ${S}.admin_exports
      FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
  `);
}

export function down(): Promise<never> {
  return Promise.reject(new Error("SET-DB-003 is forward-only"));
}
