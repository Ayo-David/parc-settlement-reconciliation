import type { Knex } from "knex";

/**
 * CB-7 slice B (SET-DB-002; D185–D189; parc-platform/docs/core-banking/
 * proposals/CB7-settlement-reconciliation.md §6): posting resolutions and
 * suspense investigations. Additive only.
 *
 * - `posting_requests`: one approved Ledger manual adjustment settlement asked
 *   for, per Idempotency-Key (PENDING -> COMPLETED | FAILED, guarded). The
 *   journal is stored when the request is made, so a retry posts exactly the
 *   same entries with the same Ledger key and never posts twice. At most one
 *   PENDING request per break and per investigation.
 * - `reconciliation_resolutions` gains ADJUSTMENT_POSTED, which carries the
 *   treatment, amount, approval and the Ledger adjustment and journal.
 * - `suspense_investigations` (OPEN -> CLOSED, guarded): money a SUSPENSE
 *   posting parked, closed by an approved release or by linking an exact,
 *   unused Ledger journal (D188). `suspense_investigation_notes` is
 *   insert-only.
 * - `guard_break` now refuses closing a break while a posting is pending for
 *   it. The service completes the request before it resolves the break, in
 *   the same transaction, so only the posting itself can close it.
 * - Forced RLS on every new table; runtime grants only.
 */
const S = "settlement";
const runtime = "parc_settlement_runtime";
const readonly = "parc_settlement_readonly";

const tenantPolicy = (table: string) => `
  ALTER TABLE ${S}.${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${S}.${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY ${table}_tenant_policy ON ${S}.${table}
    USING (tenant_id = (NULLIF(current_setting('app.current_tenant_id', true), ''))::uuid)
    WITH CHECK (tenant_id = (NULLIF(current_setting('app.current_tenant_id', true), ''))::uuid);
  GRANT SELECT ON ${S}.${table} TO ${readonly};
`;
const amount = (column: string, nullable = false) =>
  `${column} bigint ${nullable ? "" : "NOT NULL "}CHECK (${column} BETWEEN 1 AND 999999999999999)`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE ${S}.posting_requests (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('BREAK','SUSPENSE_RELEASE')),
      break_id uuid,
      investigation_id uuid,
      treatment text NOT NULL CHECK (treatment IN ('SUSPENSE','PROVIDER_CHARGE','WRITE_OFF','SUSPENSE_RELEASE')),
      idempotency_key varchar(255) NOT NULL CHECK (length(idempotency_key) > 0),
      request_hash character(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
      ledger_idempotency_key varchar(255) NOT NULL,
      ledger_reference varchar(100) NOT NULL,
      reason varchar(1500) NOT NULL,
      note varchar(1000) NOT NULL CHECK (length(trim(note)) >= 10),
      currency character(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      ${amount("amount_minor")},
      entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) = 2),
      approval_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
      failure_code varchar(100),
      ledger_adjustment_id uuid,
      ledger_transaction_id uuid,
      requested_by uuid NOT NULL,
      correlation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT uq_posting_request_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_posting_request_key UNIQUE (tenant_id, idempotency_key),
      CONSTRAINT uq_posting_request_ledger_key UNIQUE (tenant_id, ledger_idempotency_key),
      CONSTRAINT fk_posting_request_break FOREIGN KEY (tenant_id, break_id)
        REFERENCES ${S}.reconciliation_breaks (tenant_id, id),
      CONSTRAINT chk_posting_request_target CHECK (
        CASE purpose
          WHEN 'BREAK' THEN break_id IS NOT NULL AND investigation_id IS NULL AND treatment <> 'SUSPENSE_RELEASE'
          WHEN 'SUSPENSE_RELEASE' THEN investigation_id IS NOT NULL AND break_id IS NULL AND treatment = 'SUSPENSE_RELEASE'
        END),
      CONSTRAINT chk_posting_request_outcome CHECK (
        CASE status
          WHEN 'PENDING' THEN completed_at IS NULL AND failure_code IS NULL
            AND ledger_adjustment_id IS NULL AND ledger_transaction_id IS NULL
          WHEN 'COMPLETED' THEN completed_at IS NOT NULL AND failure_code IS NULL
            AND ledger_adjustment_id IS NOT NULL AND ledger_transaction_id IS NOT NULL
          WHEN 'FAILED' THEN completed_at IS NOT NULL AND failure_code IS NOT NULL
            AND ledger_adjustment_id IS NULL AND ledger_transaction_id IS NULL
        END)
    );
    COMMENT ON TABLE ${S}.posting_requests IS
      'CB-7 slice B (D185): an approved Ledger manual adjustment settlement requested. The stored journal is what every retry posts, under the same Ledger key.';
    CREATE UNIQUE INDEX uq_posting_request_pending_break ON ${S}.posting_requests
      (tenant_id, break_id) WHERE status = 'PENDING' AND break_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_posting_request_pending_investigation ON ${S}.posting_requests
      (tenant_id, investigation_id) WHERE status = 'PENDING' AND investigation_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_posting_request_completed_break ON ${S}.posting_requests
      (tenant_id, break_id) WHERE status = 'COMPLETED' AND break_id IS NOT NULL;
    CREATE UNIQUE INDEX uq_posting_request_completed_investigation ON ${S}.posting_requests
      (tenant_id, investigation_id) WHERE status = 'COMPLETED' AND investigation_id IS NOT NULL;
    ${tenantPolicy("posting_requests")}
    GRANT SELECT, INSERT, UPDATE ON ${S}.posting_requests TO ${runtime};
    CREATE TRIGGER guard_columns BEFORE UPDATE OR DELETE ON ${S}.posting_requests
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_columns('status', 'failure_code',
        'ledger_adjustment_id', 'ledger_transaction_id', 'completed_at');
    CREATE FUNCTION ${S}.guard_posting_request() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'A finished posting request stays finished' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER guard_transition BEFORE UPDATE ON ${S}.posting_requests
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_posting_request();

    ALTER TABLE ${S}.reconciliation_resolutions
      DROP CONSTRAINT reconciliation_resolutions_resolution_type_check,
      DROP CONSTRAINT chk_reconciliation_resolution_shape,
      ADD COLUMN treatment text CHECK (treatment IN ('SUSPENSE','PROVIDER_CHARGE','WRITE_OFF')),
      ADD COLUMN ${amount("amount_minor", true)},
      ADD COLUMN currency character(3) CHECK (currency ~ '^[A-Z]{3}$'),
      ADD COLUMN approval_id uuid,
      ADD COLUMN posting_request_id uuid,
      ADD COLUMN ledger_adjustment_id uuid,
      ADD COLUMN ledger_transaction_id uuid,
      ADD CONSTRAINT reconciliation_resolutions_resolution_type_check CHECK (resolution_type IN
        ('LATE_MATCH','RECLASSIFIED','WRITE_OFF_NO_IMPACT','PROVIDER_CONFIRMED','DUPLICATE_ACKNOWLEDGED','OTHER','ADJUSTMENT_POSTED')),
      ADD CONSTRAINT fk_reconciliation_resolution_posting FOREIGN KEY (tenant_id, posting_request_id)
        REFERENCES ${S}.posting_requests (tenant_id, id),
      ADD CONSTRAINT uq_reconciliation_resolution_posting UNIQUE (tenant_id, posting_request_id),
      ADD CONSTRAINT chk_reconciliation_resolution_shape CHECK (
        CASE resolution_type
          WHEN 'LATE_MATCH' THEN match_id IS NOT NULL AND run_id IS NOT NULL AND resolved_by IS NULL
          WHEN 'RECLASSIFIED' THEN replacement_break_id IS NOT NULL AND run_id IS NOT NULL AND resolved_by IS NULL
          ELSE resolved_by IS NOT NULL AND note IS NOT NULL AND length(trim(note)) >= 10
            AND match_id IS NULL AND replacement_break_id IS NULL
        END),
      ADD CONSTRAINT chk_reconciliation_resolution_posting CHECK (
        (resolution_type = 'ADJUSTMENT_POSTED') = (posting_request_id IS NOT NULL)
        AND (resolution_type <> 'ADJUSTMENT_POSTED' OR (treatment IS NOT NULL
          AND amount_minor IS NOT NULL AND currency IS NOT NULL AND approval_id IS NOT NULL
          AND ledger_adjustment_id IS NOT NULL AND ledger_transaction_id IS NOT NULL))
        AND (resolution_type = 'ADJUSTMENT_POSTED' OR (treatment IS NULL
          AND amount_minor IS NULL AND currency IS NULL AND approval_id IS NULL
          AND ledger_adjustment_id IS NULL AND ledger_transaction_id IS NULL)));
    COMMENT ON TABLE ${S}.reconciliation_resolutions IS
      'CB-7 slices A and B (D182, D183, D185): how a break was closed. Automatic (late match, reclassified), by an administrator with a reason and no posting, or ADJUSTMENT_POSTED through an approved Ledger adjustment.';

    CREATE TABLE ${S}.suspense_investigations (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      participant_id uuid NOT NULL,
      break_id uuid NOT NULL,
      opening_resolution_id uuid NOT NULL,
      opening_posting_request_id uuid NOT NULL,
      side text NOT NULL CHECK (side IN ('CREDIT','DEBIT')),
      ${amount("amount_minor")},
      currency character(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      opening_ledger_transaction_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
      closure_type text CHECK (closure_type IN ('RELEASED','CLEARED_BY_JOURNAL')),
      closing_posting_request_id uuid,
      closing_ledger_transaction_id uuid,
      closing_note varchar(1000),
      closed_by uuid,
      closed_at timestamptz,
      opened_by uuid NOT NULL,
      opened_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_suspense_investigation_tenant_id UNIQUE (tenant_id, id),
      CONSTRAINT uq_suspense_investigation_break UNIQUE (tenant_id, break_id),
      CONSTRAINT uq_suspense_investigation_closing_journal UNIQUE (tenant_id, closing_ledger_transaction_id),
      CONSTRAINT fk_suspense_investigation_participant FOREIGN KEY (tenant_id, participant_id)
        REFERENCES ${S}.settlement_participants (tenant_id, id),
      CONSTRAINT fk_suspense_investigation_break FOREIGN KEY (tenant_id, break_id)
        REFERENCES ${S}.reconciliation_breaks (tenant_id, id),
      CONSTRAINT fk_suspense_investigation_resolution FOREIGN KEY (tenant_id, opening_resolution_id)
        REFERENCES ${S}.reconciliation_resolutions (tenant_id, id),
      CONSTRAINT fk_suspense_investigation_opening FOREIGN KEY (tenant_id, opening_posting_request_id)
        REFERENCES ${S}.posting_requests (tenant_id, id),
      CONSTRAINT fk_suspense_investigation_closing FOREIGN KEY (tenant_id, closing_posting_request_id)
        REFERENCES ${S}.posting_requests (tenant_id, id),
      CONSTRAINT chk_suspense_investigation_closing_journal CHECK (
        closing_ledger_transaction_id IS DISTINCT FROM opening_ledger_transaction_id),
      CONSTRAINT chk_suspense_investigation_closed CHECK (
        CASE status
          WHEN 'OPEN' THEN closure_type IS NULL AND closing_posting_request_id IS NULL
            AND closing_ledger_transaction_id IS NULL AND closing_note IS NULL
            AND closed_by IS NULL AND closed_at IS NULL
          WHEN 'CLOSED' THEN closure_type IS NOT NULL AND closing_ledger_transaction_id IS NOT NULL
            AND closing_note IS NOT NULL AND length(trim(closing_note)) >= 10
            AND closed_by IS NOT NULL AND closed_at IS NOT NULL
            AND (closure_type = 'RELEASED') = (closing_posting_request_id IS NOT NULL)
        END)
    );
    COMMENT ON TABLE ${S}.suspense_investigations IS
      'CB-7 slice B (D188): money a SUSPENSE posting parked. CREDIT when suspense was credited. Closed by an approved release posting or by linking an exact Ledger journal posted elsewhere.';
    CREATE INDEX idx_suspense_investigation_status ON ${S}.suspense_investigations
      (tenant_id, status, opened_at DESC);
    ${tenantPolicy("suspense_investigations")}
    GRANT SELECT, INSERT, UPDATE ON ${S}.suspense_investigations TO ${runtime};
    CREATE TRIGGER guard_columns BEFORE UPDATE OR DELETE ON ${S}.suspense_investigations
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_columns('status', 'closure_type',
        'closing_posting_request_id', 'closing_ledger_transaction_id', 'closing_note',
        'closed_by', 'closed_at');
    CREATE FUNCTION ${S}.guard_suspense_investigation() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'A closed investigation stays closed' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER guard_transition BEFORE UPDATE ON ${S}.suspense_investigations
      FOR EACH ROW EXECUTE FUNCTION ${S}.guard_suspense_investigation();

    CREATE TABLE ${S}.suspense_investigation_notes (
      id uuid PRIMARY KEY,
      tenant_id uuid NOT NULL,
      investigation_id uuid NOT NULL,
      note varchar(2000) NOT NULL CHECK (length(trim(note)) > 0),
      author_id uuid NOT NULL,
      correlation_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_suspense_note_investigation FOREIGN KEY (tenant_id, investigation_id)
        REFERENCES ${S}.suspense_investigations (tenant_id, id)
    );
    CREATE INDEX idx_suspense_note_investigation ON ${S}.suspense_investigation_notes
      (tenant_id, investigation_id, created_at);
    ${tenantPolicy("suspense_investigation_notes")}
    GRANT SELECT, INSERT ON ${S}.suspense_investigation_notes TO ${runtime};
    CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON ${S}.suspense_investigation_notes
      FOR EACH ROW EXECUTE FUNCTION ${S}.reject_mutation();

    -- A pending posting holds its break until it completes or fails.
    CREATE OR REPLACE FUNCTION ${S}.guard_break() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'A resolved break stays resolved' USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM ${S}.posting_requests p
         WHERE p.tenant_id = OLD.tenant_id AND p.break_id = OLD.id AND p.status = 'PENDING'
      ) THEN
        RAISE EXCEPTION 'A posting is pending for this break' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $fn$;
  `);
}

export function down(): Promise<never> {
  return Promise.reject(new Error("SET-DB-002 is forward-only"));
}
