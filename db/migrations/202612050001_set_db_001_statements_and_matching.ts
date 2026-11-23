import type { Knex } from "knex";

/**
 * CB-7 slice A (SET-DB-001; ADR-023; D177–D184; parc-platform/docs/
 * core-banking/proposals/CB7-settlement-reconciliation.md §3): the
 * `settlement` schema's foundation, statement ingestion and matching.
 *
 * - Runs as parc_settlement_migrator, which owns the `settlement` schema
 *   created by the TS-DB-000 bootstrap (D178). Nothing is created outside it.
 * - `settlement_participants`: providers and banks whose statements are
 *   reconciled, with the grace period for missing lines (D181).
 * - `expected_items`: settlement's own projection of Payment's completed
 *   external money movements (D179). Never written by anyone else.
 * - `ledger_journal_refs` (insert-only): journals from
 *   `ledger.transaction-posted.v1`, so breaks trace to a journal.
 * - `bank_statement_imports` and `bank_statement_lines` (insert-only): the
 *   canonical statement (D180). The raw file is in MinIO, encrypted by the
 *   service; the row keeps its object key, key id and SHA-256.
 * - `reconciliation_rules` (platform, insert-only), `reconciliation_runs`
 *   (RUNNING -> COMPLETED | FAILED), `reconciliation_matches` (insert-only),
 *   `reconciliation_breaks` (OPEN -> RESOLVED), `reconciliation_resolutions`
 *   (insert-only).
 * - The standard outbox, inbox and idempotency tables; forced RLS on every
 *   tenant table; NOBYPASSRLS roles; SECURITY DEFINER discovery (CB1-11).
 * - Money is BIGINT minor units of at most 15 digits with an ISO currency.
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
const appendOnly = (table: string) => `
  CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON ${S}.${table}
    FOR EACH ROW EXECUTE FUNCTION ${S}.reject_mutation();
`;
/** Only the listed columns may change; deletes are refused. */
const guarded = (table: string, mutable: string[]) => `
  CREATE TRIGGER guard_columns BEFORE UPDATE OR DELETE ON ${S}.${table}
    FOR EACH ROW EXECUTE FUNCTION ${S}.guard_columns(${mutable
      .map((column) => `'${column}'`)
      .join(", ")});
`;
const amount = (column: string, nullable = false) =>
  `${column} bigint ${nullable ? "" : "NOT NULL "}CHECK (${column} BETWEEN 1 AND 999999999999999)`;
const currency =
  "currency character(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$')";

export async function up(knex: Knex): Promise<void> {
  const schema = await knex.raw<{ rows: unknown[] }>(
    "SELECT 1 FROM pg_namespace WHERE nspname = ?",
    [S],
  );
  if (schema.rows.length === 0)
    throw new Error(
      "Schema settlement does not exist: run the TS-DB-000 bootstrap (db/bootstrap/treasury-settlement.sql) first",
    );

  await knex.raw(`
    GRANT USAGE ON SCHEMA ${S} TO ${runtime}, ${worker}, ${readonly};

    CREATE FUNCTION ${S}.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $fn$;

    CREATE FUNCTION ${S}.guard_columns() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    DECLARE
      mutable text[] := TG_ARGV::text[];
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = '55000';
      END IF;
      IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
        RAISE EXCEPTION 'Only % may change on %', mutable, TG_TABLE_NAME USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
  `);

  await knex.raw(`
    CREATE TABLE ${S}.settlement_participants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      code varchar(50) NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,49}$'),
      name varchar(150) NOT NULL CHECK (length(trim(name)) > 0),
      kind text NOT NULL CHECK (kind IN ('PAYMENT_PROVIDER','BANK','BILLER_AGGREGATOR')),
      ${currency},
      grace_days integer NOT NULL DEFAULT 2 CHECK (grace_days BETWEEN 0 AND 30),
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_by uuid NOT NULL,
      updated_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_participant_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_participant_code UNIQUE (tenant_id, code)
    );
    COMMENT ON TABLE ${S}.settlement_participants IS
      'CB-7 slice A (D181): providers and banks whose statements are reconciled. The code is the Payment provider code.';
    ${tenantPolicy("settlement_participants")}
    GRANT SELECT, INSERT, UPDATE ON ${S}.settlement_participants TO ${runtime};
    GRANT SELECT ON ${S}.settlement_participants TO ${worker};
    ${guarded("settlement_participants", ["name", "grace_days", "status", "version", "updated_by", "updated_at"])}

    CREATE TABLE ${S}.expected_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      source_service text NOT NULL CHECK (source_service = 'parc-payment'),
      source_type text NOT NULL CHECK (source_type IN ('EXTERNAL_TRANSFER','COLLECTION','BILL_PAYMENT')),
      source_id uuid NOT NULL,
      ledger_transaction_id uuid,
      provider_code varchar(50),
      provider_reference varchar(200),
      direction text NOT NULL CHECK (direction IN ('IN','OUT')),
      ${amount("amount_minor")},
      ${currency},
      value_date date NOT NULL,
      status text NOT NULL DEFAULT 'EXPECTED' CHECK (status IN ('EXPECTED','MATCHED')),
      matched_at timestamptz,
      reversed_at timestamptz,
      reversal_ledger_transaction_id uuid,
      source_event_id uuid NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_expected_item_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_expected_item_source UNIQUE (tenant_id, source_service, source_type, source_id),
      CONSTRAINT chk_expected_item_matched CHECK ((status = 'MATCHED') = (matched_at IS NOT NULL)),
      CONSTRAINT chk_expected_item_reversal CHECK (reversal_ledger_transaction_id IS NULL OR reversed_at IS NOT NULL),
      CONSTRAINT chk_expected_item_direction CHECK (
        (source_type = 'COLLECTION') = (direction = 'IN'))
    );
    COMMENT ON TABLE ${S}.expected_items IS
      'CB-7 slice A (D179): what should appear on provider and bank statements, projected from Payment''s completion events. Items without a provider code or reference are matched only by an operator.';
    CREATE INDEX idx_expected_item_reference ON ${S}.expected_items
      (tenant_id, provider_code, provider_reference) WHERE provider_reference IS NOT NULL;
    CREATE INDEX idx_expected_item_open ON ${S}.expected_items
      (tenant_id, provider_code, value_date) WHERE status = 'EXPECTED';
    ${tenantPolicy("expected_items")}
    GRANT SELECT, INSERT, UPDATE ON ${S}.expected_items TO ${worker};
    GRANT SELECT, UPDATE ON ${S}.expected_items TO ${runtime};
    ${guarded("expected_items", ["status", "matched_at", "reversed_at", "reversal_ledger_transaction_id", "updated_at"])}

    CREATE FUNCTION ${S}.guard_expected_item() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status = 'MATCHED' AND NEW.status <> 'MATCHED' THEN
        RAISE EXCEPTION 'A matched expected item stays matched' USING ERRCODE = '55000';
      END IF;
      IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
        RAISE EXCEPTION 'An expected item is reversed once' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER guard_transition BEFORE UPDATE ON ${S}.expected_items
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_expected_item();

    CREATE TABLE ${S}.ledger_journal_refs (
      tenant_id uuid NOT NULL,
      journal_id uuid NOT NULL,
      reference varchar(200) NOT NULL,
      ${currency},
      total_debits_minor bigint NOT NULL CHECK (total_debits_minor >= 0),
      posting_type text,
      source_service text,
      accounting_date date,
      posted_at timestamptz NOT NULL,
      source_event_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, journal_id)
    );
    COMMENT ON TABLE ${S}.ledger_journal_refs IS
      'CB-7 slice A: journals from ledger.transaction-posted.v1, so every match and break traces to a journal.';
    ${tenantPolicy("ledger_journal_refs")}
    GRANT SELECT, INSERT ON ${S}.ledger_journal_refs TO ${worker};
    GRANT SELECT ON ${S}.ledger_journal_refs TO ${runtime};
    ${appendOnly("ledger_journal_refs")}

    CREATE TABLE ${S}.bank_statement_imports (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      statement_date date NOT NULL,
      file_name varchar(255) NOT NULL CHECK (length(trim(file_name)) > 0),
      content_sha256 character(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
      object_key text NOT NULL,
      encryption_key_id varchar(100) NOT NULL,
      line_count integer NOT NULL CHECK (line_count BETWEEN 1 AND 20000),
      total_in_minor bigint NOT NULL CHECK (total_in_minor >= 0),
      total_out_minor bigint NOT NULL CHECK (total_out_minor >= 0),
      supersedes_import_id uuid,
      imported_by uuid NOT NULL,
      correlation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_statement_import_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_statement_import_content UNIQUE (tenant_id, participant_id, statement_date, content_sha256),
      CONSTRAINT uq_statement_import_object UNIQUE (object_key),
      CONSTRAINT uq_statement_import_supersedes UNIQUE (tenant_id, supersedes_import_id),
      CONSTRAINT fk_statement_import_participant FOREIGN KEY (tenant_id, participant_id)
        REFERENCES ${S}.settlement_participants (tenant_id, id),
      CONSTRAINT fk_statement_import_supersedes FOREIGN KEY (tenant_id, supersedes_import_id)
        REFERENCES ${S}.bank_statement_imports (tenant_id, id)
    );
    COMMENT ON TABLE ${S}.bank_statement_imports IS
      'CB-7 slice A (D180): imported statements. Immutable evidence; a correction supersedes an import instead of changing it.';
    CREATE INDEX idx_statement_import_date ON ${S}.bank_statement_imports
      (tenant_id, participant_id, statement_date);
    ${tenantPolicy("bank_statement_imports")}
    GRANT SELECT, INSERT ON ${S}.bank_statement_imports TO ${runtime};
    ${appendOnly("bank_statement_imports")}

    CREATE TABLE ${S}.bank_statement_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      import_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      line_number integer NOT NULL CHECK (line_number > 0),
      line_reference varchar(200) NOT NULL CHECK (length(trim(line_reference)) > 0),
      provider_reference varchar(200),
      direction text NOT NULL CHECK (direction IN ('IN','OUT')),
      ${amount("amount_minor")},
      ${currency},
      value_date date NOT NULL,
      narration varchar(500),
      line_hash character(64) NOT NULL CHECK (line_hash ~ '^[a-f0-9]{64}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_statement_line_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_statement_line_number UNIQUE (tenant_id, import_id, line_number),
      CONSTRAINT uq_statement_line_reference UNIQUE (tenant_id, import_id, line_reference),
      CONSTRAINT fk_statement_line_import FOREIGN KEY (tenant_id, import_id)
        REFERENCES ${S}.bank_statement_imports (tenant_id, id),
      CONSTRAINT fk_statement_line_participant FOREIGN KEY (tenant_id, participant_id)
        REFERENCES ${S}.settlement_participants (tenant_id, id)
    );
    COMMENT ON TABLE ${S}.bank_statement_lines IS
      'CB-7 slice A (D180): the lines of an import, in the canonical form. Narration may name a person: CONFIDENTIAL.';
    CREATE INDEX idx_statement_line_value_date ON ${S}.bank_statement_lines
      (tenant_id, participant_id, value_date);
    ${tenantPolicy("bank_statement_lines")}
    GRANT SELECT, INSERT ON ${S}.bank_statement_lines TO ${runtime};
    ${appendOnly("bank_statement_lines")}

    CREATE TABLE ${S}.reconciliation_rules (
      version varchar(20) PRIMARY KEY,
      description text NOT NULL,
      definition jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE ${S}.reconciliation_rules IS
      'CB-7 slice A (D181): platform-fixed rule sets. Runs record the version they used.';
    INSERT INTO ${S}.reconciliation_rules (version, description, definition) VALUES (
      'v1',
      'Exact provider reference, direction, amount and currency; zero tolerance; missing after the participant''s grace days.',
      '{"match":["provider_code","provider_reference","direction","amount_minor","currency"],
        "tolerance_minor":0,
        "breaks":["AMOUNT_MISMATCH","DUPLICATE_EXTERNAL","UNMATCHED_EXTERNAL","MISSING_EXTERNAL"],
        "late_match":"auto_resolve"}'::jsonb);
    GRANT SELECT ON ${S}.reconciliation_rules TO ${runtime}, ${worker}, ${readonly};
    ${appendOnly("reconciliation_rules")}

    CREATE TABLE ${S}.reconciliation_runs (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      period_from date NOT NULL,
      period_to date NOT NULL,
      rule_set_version varchar(20) NOT NULL REFERENCES ${S}.reconciliation_rules (version),
      trigger text NOT NULL CHECK (trigger IN ('MANUAL')),
      status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
      requested_by uuid,
      idempotency_key varchar(255) NOT NULL CHECK (length(idempotency_key) > 0),
      request_hash character(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      lines_considered integer NOT NULL DEFAULT 0 CHECK (lines_considered >= 0),
      items_considered integer NOT NULL DEFAULT 0 CHECK (items_considered >= 0),
      matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
      breaks_opened integer NOT NULL DEFAULT 0 CHECK (breaks_opened >= 0),
      breaks_resolved integer NOT NULL DEFAULT 0 CHECK (breaks_resolved >= 0),
      failure_code varchar(100),
      correlation_id uuid NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT uq_reconciliation_run_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_reconciliation_run_idempotency UNIQUE (tenant_id, idempotency_key),
      CONSTRAINT fk_reconciliation_run_participant FOREIGN KEY (tenant_id, participant_id)
        REFERENCES ${S}.settlement_participants (tenant_id, id),
      CONSTRAINT chk_reconciliation_run_period CHECK (
        period_from <= period_to AND period_to - period_from <= 31),
      CONSTRAINT chk_reconciliation_run_done CHECK ((status = 'RUNNING') = (completed_at IS NULL)),
      CONSTRAINT chk_reconciliation_run_failure CHECK ((status = 'FAILED') = (failure_code IS NOT NULL))
    );
    COMMENT ON TABLE ${S}.reconciliation_runs IS
      'CB-7 slice A (D181): one matching pass over a participant''s statement lines and expected items for a period of value dates.';
    CREATE INDEX idx_reconciliation_run_participant ON ${S}.reconciliation_runs
      (tenant_id, participant_id, started_at DESC);
    ${tenantPolicy("reconciliation_runs")}
    GRANT SELECT, INSERT, UPDATE ON ${S}.reconciliation_runs TO ${runtime};
    ${guarded("reconciliation_runs", ["status", "lines_considered", "items_considered", "matched_count", "breaks_opened", "breaks_resolved", "failure_code", "completed_at"])}

    CREATE FUNCTION ${S}.guard_run() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'A finished reconciliation run does not change' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER guard_transition BEFORE UPDATE ON ${S}.reconciliation_runs
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_run();

    CREATE TABLE ${S}.reconciliation_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      run_id uuid NOT NULL,
      statement_line_id uuid NOT NULL,
      expected_item_id uuid NOT NULL,
      rule text NOT NULL CHECK (rule IN ('EXACT')),
      matched_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_reconciliation_match_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_reconciliation_match_line UNIQUE (tenant_id, statement_line_id),
      CONSTRAINT uq_reconciliation_match_item UNIQUE (tenant_id, expected_item_id),
      CONSTRAINT fk_reconciliation_match_run FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${S}.reconciliation_runs (tenant_id, id),
      CONSTRAINT fk_reconciliation_match_line FOREIGN KEY (tenant_id, statement_line_id)
        REFERENCES ${S}.bank_statement_lines (tenant_id, id),
      CONSTRAINT fk_reconciliation_match_item FOREIGN KEY (tenant_id, expected_item_id)
        REFERENCES ${S}.expected_items (tenant_id, id)
    );
    COMMENT ON TABLE ${S}.reconciliation_matches IS
      'CB-7 slice A (D181): one statement line matched to one expected item. Matching never changes the source records.';
    ${tenantPolicy("reconciliation_matches")}
    GRANT SELECT, INSERT ON ${S}.reconciliation_matches TO ${runtime};
    ${appendOnly("reconciliation_matches")}

    CREATE TABLE ${S}.reconciliation_breaks (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      run_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      break_type text NOT NULL CHECK (break_type IN
        ('AMOUNT_MISMATCH','DUPLICATE_EXTERNAL','UNMATCHED_EXTERNAL','MISSING_EXTERNAL')),
      statement_line_id uuid,
      expected_item_id uuid,
      provider_reference varchar(200),
      direction text NOT NULL CHECK (direction IN ('IN','OUT')),
      ${currency},
      ${amount("expected_amount_minor", true)},
      ${amount("external_amount_minor", true)},
      difference_minor bigint NOT NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
      resolved_at timestamptz,
      detected_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_reconciliation_break_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT fk_reconciliation_break_run FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${S}.reconciliation_runs (tenant_id, id),
      CONSTRAINT fk_reconciliation_break_participant FOREIGN KEY (tenant_id, participant_id)
        REFERENCES ${S}.settlement_participants (tenant_id, id),
      CONSTRAINT fk_reconciliation_break_line FOREIGN KEY (tenant_id, statement_line_id)
        REFERENCES ${S}.bank_statement_lines (tenant_id, id),
      CONSTRAINT fk_reconciliation_break_item FOREIGN KEY (tenant_id, expected_item_id)
        REFERENCES ${S}.expected_items (tenant_id, id),
      CONSTRAINT chk_reconciliation_break_resolved CHECK ((status = 'RESOLVED') = (resolved_at IS NOT NULL)),
      CONSTRAINT chk_reconciliation_break_shape CHECK (
        CASE break_type
          WHEN 'AMOUNT_MISMATCH' THEN statement_line_id IS NOT NULL AND expected_item_id IS NOT NULL
            AND expected_amount_minor IS NOT NULL AND external_amount_minor IS NOT NULL
          WHEN 'DUPLICATE_EXTERNAL' THEN statement_line_id IS NOT NULL AND external_amount_minor IS NOT NULL
          WHEN 'UNMATCHED_EXTERNAL' THEN statement_line_id IS NOT NULL AND expected_item_id IS NULL
            AND external_amount_minor IS NOT NULL AND expected_amount_minor IS NULL
          WHEN 'MISSING_EXTERNAL' THEN statement_line_id IS NULL AND expected_item_id IS NOT NULL
            AND expected_amount_minor IS NOT NULL AND external_amount_minor IS NULL
        END),
      CONSTRAINT chk_reconciliation_break_difference CHECK (
        difference_minor = coalesce(external_amount_minor, 0) - coalesce(expected_amount_minor, 0))
    );
    COMMENT ON TABLE ${S}.reconciliation_breaks IS
      'CB-7 slice A (D181, D182): an exception a run found. At most one open break per statement line and per expected item.';
    CREATE UNIQUE INDEX uq_reconciliation_break_open_line ON ${S}.reconciliation_breaks
      (tenant_id, statement_line_id) WHERE status = 'OPEN' AND statement_line_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_reconciliation_break_open_item ON ${S}.reconciliation_breaks
      (tenant_id, expected_item_id)
      WHERE status = 'OPEN' AND break_type IN ('AMOUNT_MISMATCH','MISSING_EXTERNAL');
    CREATE INDEX idx_reconciliation_break_status ON ${S}.reconciliation_breaks
      (tenant_id, status, detected_at DESC);
    ${tenantPolicy("reconciliation_breaks")}
    GRANT SELECT, INSERT, UPDATE ON ${S}.reconciliation_breaks TO ${runtime};
    ${guarded("reconciliation_breaks", ["status", "resolved_at"])}

    CREATE FUNCTION ${S}.guard_break() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'A resolved break stays resolved' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER guard_transition BEFORE UPDATE ON ${S}.reconciliation_breaks
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_break();

    CREATE TABLE ${S}.reconciliation_resolutions (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      break_id uuid NOT NULL,
      resolution_type text NOT NULL CHECK (resolution_type IN
        ('LATE_MATCH','RECLASSIFIED','WRITE_OFF_NO_IMPACT','PROVIDER_CONFIRMED','DUPLICATE_ACKNOWLEDGED','OTHER')),
      note varchar(2000),
      match_id uuid,
      replacement_break_id uuid,
      run_id uuid,
      resolved_by uuid,
      correlation_id uuid NOT NULL,
      resolved_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_reconciliation_resolution_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_reconciliation_resolution_break UNIQUE (tenant_id, break_id),
      CONSTRAINT fk_reconciliation_resolution_break FOREIGN KEY (tenant_id, break_id)
        REFERENCES ${S}.reconciliation_breaks (tenant_id, id),
      CONSTRAINT fk_reconciliation_resolution_match FOREIGN KEY (tenant_id, match_id)
        REFERENCES ${S}.reconciliation_matches (tenant_id, id),
      CONSTRAINT fk_reconciliation_resolution_replacement FOREIGN KEY (tenant_id, replacement_break_id)
        REFERENCES ${S}.reconciliation_breaks (tenant_id, id),
      CONSTRAINT fk_reconciliation_resolution_run FOREIGN KEY (tenant_id, run_id)
        REFERENCES ${S}.reconciliation_runs (tenant_id, id),
      CONSTRAINT chk_reconciliation_resolution_shape CHECK (
        CASE resolution_type
          WHEN 'LATE_MATCH' THEN match_id IS NOT NULL AND run_id IS NOT NULL AND resolved_by IS NULL
          WHEN 'RECLASSIFIED' THEN replacement_break_id IS NOT NULL AND run_id IS NOT NULL AND resolved_by IS NULL
          ELSE resolved_by IS NOT NULL AND note IS NOT NULL AND length(trim(note)) >= 10
            AND match_id IS NULL AND replacement_break_id IS NULL
        END)
    );
    COMMENT ON TABLE ${S}.reconciliation_resolutions IS
      'CB-7 slice A (D182, D183): how a break was closed. Automatic (late match, reclassified by a later run) or by an administrator with a reason; no postings in slice A.';
    ${tenantPolicy("reconciliation_resolutions")}
    GRANT SELECT, INSERT ON ${S}.reconciliation_resolutions TO ${runtime};
    ${appendOnly("reconciliation_resolutions")}

    CREATE TABLE ${S}.idempotency_keys (
      tenant_id uuid NOT NULL,
      operation varchar(100) NOT NULL,
      idempotency_key varchar(255) NOT NULL CHECK (length(idempotency_key) > 0),
      request_hash character(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, operation, idempotency_key)
    );
    ${tenantPolicy("idempotency_keys")}
    GRANT SELECT, INSERT ON ${S}.idempotency_keys TO ${runtime};
    ${appendOnly("idempotency_keys")}

    CREATE TABLE ${S}.outbox_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      aggregate_type varchar(100) NOT NULL,
      aggregate_id uuid NOT NULL,
      aggregate_version bigint NOT NULL CHECK (aggregate_version > 0),
      event_type varchar(150) NOT NULL,
      event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
      payload jsonb NOT NULL,
      status varchar(30) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','PROCESSING','PUBLISHED','FAILED','DEAD_LETTER')),
      retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      available_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      last_error text,
      last_error_code varchar(100),
      correlation_id uuid NOT NULL,
      causation_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      dead_lettered_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_outbox_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT chk_outbox_published CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX uq_outbox_aggregate_fact
      ON ${S}.outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, aggregate_version);
    CREATE INDEX idx_outbox_retry ON ${S}.outbox_events (tenant_id, available_at)
      WHERE status IN ('PENDING','FAILED');
    ${tenantPolicy("outbox_events")}
    GRANT SELECT, INSERT ON ${S}.outbox_events TO ${runtime};
    GRANT SELECT, INSERT, UPDATE ON ${S}.outbox_events TO ${worker};

    CREATE TABLE ${S}.inbox_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      source_service text NOT NULL,
      event_id uuid NOT NULL,
      consumer_name text NOT NULL,
      event_type text NOT NULL,
      event_version integer NOT NULL CHECK (event_version > 0),
      aggregate_id uuid,
      correlation_id uuid NOT NULL,
      payload_hash character(64) NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('APPLIED','IGNORED')),
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_inbox_event UNIQUE (tenant_id, source_service, event_id, consumer_name)
    );
    COMMENT ON TABLE ${S}.inbox_events IS
      'Deduplication of consumed events. Payloads are not kept: the projection rows are the record.';
    ${tenantPolicy("inbox_events")}
    GRANT SELECT, INSERT ON ${S}.inbox_events TO ${worker};
    ${appendOnly("inbox_events")}
  `);

  // CB1-11 discovery: tenant ids only, through SECURITY DEFINER functions.
  await knex.raw(`
    CREATE FUNCTION ${S}.outbox_tenants_with_work() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, ${S} AS $fn$
      SELECT DISTINCT tenant_id FROM ${S}.outbox_events
       WHERE status NOT IN ('PUBLISHED','DEAD_LETTER') ORDER BY tenant_id
    $fn$;
    REVOKE ALL ON FUNCTION ${S}.outbox_tenants_with_work() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION ${S}.outbox_tenants_with_work() TO ${worker};
    -- The function's owner reads through it; forced RLS applies to owners too.
    CREATE POLICY outbox_tenant_discovery_owner_read ON ${S}.outbox_events
      FOR SELECT TO CURRENT_USER USING (true);
  `);
}

export function down(): Promise<never> {
  return Promise.reject(new Error("SET-DB-001 is forward-only"));
}
