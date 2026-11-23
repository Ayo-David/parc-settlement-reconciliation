--
-- PostgreSQL database dump
--

\restrict parcschemasnapshot

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: settlement; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA settlement;


--
-- Name: guard_break(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.guard_break() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'A resolved break stays resolved' USING ERRCODE = '55000';
      END IF;
      IF EXISTS (
        SELECT 1 FROM settlement.posting_requests p
         WHERE p.tenant_id = OLD.tenant_id AND p.break_id = OLD.id AND p.status = 'PENDING'
      ) THEN
        RAISE EXCEPTION 'A posting is pending for this break' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;


--
-- Name: guard_columns(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.guard_columns() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    END $$;


--
-- Name: guard_expected_item(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.guard_expected_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status = 'MATCHED' AND NEW.status <> 'MATCHED' THEN
        RAISE EXCEPTION 'A matched expected item stays matched' USING ERRCODE = '55000';
      END IF;
      IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
        RAISE EXCEPTION 'An expected item is reversed once' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;


--
-- Name: guard_posting_request(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.guard_posting_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status <> 'PENDING' THEN
        RAISE EXCEPTION 'A finished posting request stays finished' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;


--
-- Name: guard_run(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.guard_run() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'A finished reconciliation run does not change' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;


--
-- Name: guard_suspense_investigation(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.guard_suspense_investigation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status <> 'OPEN' THEN
        RAISE EXCEPTION 'A closed investigation stays closed' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END $$;


--
-- Name: outbox_tenants_with_work(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.outbox_tenants_with_work() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'settlement'
    AS $$
      SELECT DISTINCT tenant_id FROM settlement.outbox_events
       WHERE status NOT IN ('PUBLISHED','DEAD_LETTER') ORDER BY tenant_id
    $$;


--
-- Name: purge_expired_admin_exports(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.purge_expired_admin_exports() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'settlement'
    AS $$
    DECLARE purged integer;
    BEGIN
      UPDATE settlement.admin_exports
         SET status = 'EXPIRED', content = NULL
       WHERE status = 'READY' AND expires_at <= now();
      GET DIAGNOSTICS purged = ROW_COUNT;
      RETURN purged;
    END $$;


--
-- Name: reject_mutation(); Type: FUNCTION; Schema: settlement; Owner: -
--

CREATE FUNCTION settlement.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_export_downloads; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.admin_export_downloads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    export_id uuid NOT NULL,
    downloaded_by uuid NOT NULL,
    correlation_id uuid,
    downloaded_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY settlement.admin_export_downloads FORCE ROW LEVEL SECURITY;


--
-- Name: admin_exports; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.admin_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind character varying(100) NOT NULL,
    parameters jsonb NOT NULL,
    status character varying(20) NOT NULL,
    requested_by uuid NOT NULL,
    reason_code character varying(50) NOT NULL,
    idempotency_key character varying(200) NOT NULL,
    request_hash character(64) NOT NULL,
    row_count integer,
    byte_size integer,
    content text,
    content_sha256 character(64),
    failure_code character varying(100),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT admin_exports_row_count_check CHECK (((row_count IS NULL) OR ((row_count >= 0) AND (row_count <= 50000)))),
    CONSTRAINT admin_exports_status_check CHECK (((status)::text = ANY ((ARRAY['READY'::character varying, 'FAILED'::character varying, 'EXPIRED'::character varying])::text[]))),
    CONSTRAINT chk_admin_export_ready CHECK ((((status)::text <> 'READY'::text) OR ((content IS NOT NULL) AND (content_sha256 IS NOT NULL) AND (row_count IS NOT NULL))))
);

ALTER TABLE ONLY settlement.admin_exports FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE admin_exports; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.admin_exports IS 'CB-7 slice D (D191): administrator CSV exports, kept 24 hours, then cleared by purge_expired_admin_exports().';


--
-- Name: bank_statement_imports; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.bank_statement_imports (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    statement_date date NOT NULL,
    file_name character varying(255) NOT NULL,
    content_sha256 character(64) NOT NULL,
    size_bytes integer NOT NULL,
    object_key text NOT NULL,
    encryption_key_id character varying(100) NOT NULL,
    line_count integer NOT NULL,
    total_in_minor bigint NOT NULL,
    total_out_minor bigint NOT NULL,
    supersedes_import_id uuid,
    imported_by uuid NOT NULL,
    correlation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bank_statement_imports_content_sha256_check CHECK ((content_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT bank_statement_imports_file_name_check CHECK ((length(TRIM(BOTH FROM file_name)) > 0)),
    CONSTRAINT bank_statement_imports_line_count_check CHECK (((line_count >= 1) AND (line_count <= 20000))),
    CONSTRAINT bank_statement_imports_size_bytes_check CHECK (((size_bytes >= 1) AND (size_bytes <= 1048576))),
    CONSTRAINT bank_statement_imports_total_in_minor_check CHECK ((total_in_minor >= 0)),
    CONSTRAINT bank_statement_imports_total_out_minor_check CHECK ((total_out_minor >= 0))
);

ALTER TABLE ONLY settlement.bank_statement_imports FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE bank_statement_imports; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.bank_statement_imports IS 'CB-7 slice A (D180): imported statements. Immutable evidence; a correction supersedes an import instead of changing it.';


--
-- Name: bank_statement_lines; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.bank_statement_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    import_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    line_number integer NOT NULL,
    line_reference character varying(200) NOT NULL,
    provider_reference character varying(200),
    direction text NOT NULL,
    amount_minor bigint NOT NULL,
    currency character(3) NOT NULL,
    value_date date NOT NULL,
    narration character varying(500),
    line_hash character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bank_statement_lines_amount_minor_check CHECK (((amount_minor >= 1) AND (amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT bank_statement_lines_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT bank_statement_lines_direction_check CHECK ((direction = ANY (ARRAY['IN'::text, 'OUT'::text]))),
    CONSTRAINT bank_statement_lines_line_hash_check CHECK ((line_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT bank_statement_lines_line_number_check CHECK ((line_number > 0)),
    CONSTRAINT bank_statement_lines_line_reference_check CHECK ((length(TRIM(BOTH FROM line_reference)) > 0))
);

ALTER TABLE ONLY settlement.bank_statement_lines FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE bank_statement_lines; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.bank_statement_lines IS 'CB-7 slice A (D180): the lines of an import, in the canonical form. Narration may name a person: CONFIDENTIAL.';


--
-- Name: expected_items; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.expected_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    source_service text NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    ledger_transaction_id uuid,
    provider_code character varying(50),
    provider_reference character varying(200),
    direction text NOT NULL,
    amount_minor bigint NOT NULL,
    currency character(3) NOT NULL,
    value_date date NOT NULL,
    status text DEFAULT 'EXPECTED'::text NOT NULL,
    matched_at timestamp with time zone,
    reversed_at timestamp with time zone,
    reversal_ledger_transaction_id uuid,
    source_event_id uuid NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_expected_item_direction CHECK (((source_type = 'COLLECTION'::text) = (direction = 'IN'::text))),
    CONSTRAINT chk_expected_item_matched CHECK (((status = 'MATCHED'::text) = (matched_at IS NOT NULL))),
    CONSTRAINT chk_expected_item_reversal CHECK (((reversal_ledger_transaction_id IS NULL) OR (reversed_at IS NOT NULL))),
    CONSTRAINT expected_items_amount_minor_check CHECK (((amount_minor >= 1) AND (amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT expected_items_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT expected_items_direction_check CHECK ((direction = ANY (ARRAY['IN'::text, 'OUT'::text]))),
    CONSTRAINT expected_items_source_service_check CHECK ((source_service = 'parc-payment'::text)),
    CONSTRAINT expected_items_source_type_check CHECK ((source_type = ANY (ARRAY['EXTERNAL_TRANSFER'::text, 'COLLECTION'::text, 'BILL_PAYMENT'::text]))),
    CONSTRAINT expected_items_status_check CHECK ((status = ANY (ARRAY['EXPECTED'::text, 'MATCHED'::text])))
);

ALTER TABLE ONLY settlement.expected_items FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE expected_items; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.expected_items IS 'CB-7 slice A (D179): what should appear on provider and bank statements, projected from Payment''s completion events. Items without a provider code or reference are matched only by an operator.';


--
-- Name: idempotency_keys; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.idempotency_keys (
    tenant_id uuid NOT NULL,
    operation character varying(100) NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    request_hash character(64) NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT idempotency_keys_idempotency_key_check CHECK ((length((idempotency_key)::text) > 0)),
    CONSTRAINT idempotency_keys_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY settlement.idempotency_keys FORCE ROW LEVEL SECURITY;


--
-- Name: inbox_events; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.inbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    source_service text NOT NULL,
    event_id uuid NOT NULL,
    consumer_name text NOT NULL,
    event_type text NOT NULL,
    event_version integer NOT NULL,
    aggregate_id uuid,
    correlation_id uuid NOT NULL,
    payload_hash character(64) NOT NULL,
    outcome text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inbox_events_event_version_check CHECK ((event_version > 0)),
    CONSTRAINT inbox_events_outcome_check CHECK ((outcome = ANY (ARRAY['APPLIED'::text, 'IGNORED'::text])))
);

ALTER TABLE ONLY settlement.inbox_events FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE inbox_events; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.inbox_events IS 'Deduplication of consumed events. Payloads are not kept: the projection rows are the record.';


--
-- Name: ledger_journal_refs; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.ledger_journal_refs (
    tenant_id uuid NOT NULL,
    journal_id uuid NOT NULL,
    reference character varying(200) NOT NULL,
    currency character(3) NOT NULL,
    total_debits_minor bigint NOT NULL,
    posting_type text,
    source_service text,
    accounting_date date,
    posted_at timestamp with time zone NOT NULL,
    source_event_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_journal_refs_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT ledger_journal_refs_total_debits_minor_check CHECK ((total_debits_minor >= 0))
);

ALTER TABLE ONLY settlement.ledger_journal_refs FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE ledger_journal_refs; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.ledger_journal_refs IS 'CB-7 slice A: journals from ledger.transaction-posted.v1, so every match and break traces to a journal.';


--
-- Name: outbox_events; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.outbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    aggregate_type character varying(100) NOT NULL,
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL,
    event_type character varying(150) NOT NULL,
    event_version integer DEFAULT 1 NOT NULL,
    payload jsonb NOT NULL,
    status character varying(30) DEFAULT 'PENDING'::character varying NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    last_error text,
    last_error_code character varying(100),
    correlation_id uuid NOT NULL,
    causation_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    dead_lettered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_outbox_published CHECK ((((status)::text <> 'PUBLISHED'::text) OR (published_at IS NOT NULL))),
    CONSTRAINT outbox_events_aggregate_version_check CHECK ((aggregate_version > 0)),
    CONSTRAINT outbox_events_event_version_check CHECK ((event_version > 0)),
    CONSTRAINT outbox_events_retry_count_check CHECK ((retry_count >= 0)),
    CONSTRAINT outbox_events_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'PUBLISHED'::character varying, 'FAILED'::character varying, 'DEAD_LETTER'::character varying])::text[])))
);

ALTER TABLE ONLY settlement.outbox_events FORCE ROW LEVEL SECURITY;


--
-- Name: posting_requests; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.posting_requests (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    purpose text NOT NULL,
    break_id uuid,
    investigation_id uuid,
    treatment text NOT NULL,
    idempotency_key character varying(255) NOT NULL,
    request_hash character(64) NOT NULL,
    ledger_idempotency_key character varying(255) NOT NULL,
    ledger_reference character varying(100) NOT NULL,
    reason character varying(1500) NOT NULL,
    note character varying(1000) NOT NULL,
    currency character(3) NOT NULL,
    amount_minor bigint NOT NULL,
    entries jsonb NOT NULL,
    approval_id uuid NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    failure_code character varying(100),
    ledger_adjustment_id uuid,
    ledger_transaction_id uuid,
    requested_by uuid NOT NULL,
    correlation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_posting_request_outcome CHECK (
CASE status
    WHEN 'PENDING'::text THEN ((completed_at IS NULL) AND (failure_code IS NULL) AND (ledger_adjustment_id IS NULL) AND (ledger_transaction_id IS NULL))
    WHEN 'COMPLETED'::text THEN ((completed_at IS NOT NULL) AND (failure_code IS NULL) AND (ledger_adjustment_id IS NOT NULL) AND (ledger_transaction_id IS NOT NULL))
    WHEN 'FAILED'::text THEN ((completed_at IS NOT NULL) AND (failure_code IS NOT NULL) AND (ledger_adjustment_id IS NULL) AND (ledger_transaction_id IS NULL))
    ELSE NULL::boolean
END),
    CONSTRAINT chk_posting_request_target CHECK (
CASE purpose
    WHEN 'BREAK'::text THEN ((break_id IS NOT NULL) AND (investigation_id IS NULL) AND (treatment <> 'SUSPENSE_RELEASE'::text))
    WHEN 'SUSPENSE_RELEASE'::text THEN ((investigation_id IS NOT NULL) AND (break_id IS NULL) AND (treatment = 'SUSPENSE_RELEASE'::text))
    ELSE NULL::boolean
END),
    CONSTRAINT posting_requests_amount_minor_check CHECK (((amount_minor >= 1) AND (amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT posting_requests_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT posting_requests_entries_check CHECK (((jsonb_typeof(entries) = 'array'::text) AND (jsonb_array_length(entries) = 2))),
    CONSTRAINT posting_requests_idempotency_key_check CHECK ((length((idempotency_key)::text) > 0)),
    CONSTRAINT posting_requests_note_check CHECK ((length(TRIM(BOTH FROM note)) >= 10)),
    CONSTRAINT posting_requests_purpose_check CHECK ((purpose = ANY (ARRAY['BREAK'::text, 'SUSPENSE_RELEASE'::text]))),
    CONSTRAINT posting_requests_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT posting_requests_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'FAILED'::text]))),
    CONSTRAINT posting_requests_treatment_check CHECK ((treatment = ANY (ARRAY['SUSPENSE'::text, 'PROVIDER_CHARGE'::text, 'WRITE_OFF'::text, 'SUSPENSE_RELEASE'::text])))
);

ALTER TABLE ONLY settlement.posting_requests FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE posting_requests; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.posting_requests IS 'CB-7 slice B (D185): an approved Ledger manual adjustment settlement requested. The stored journal is what every retry posts, under the same Ledger key.';


--
-- Name: reconciliation_breaks; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.reconciliation_breaks (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    break_type text NOT NULL,
    statement_line_id uuid,
    expected_item_id uuid,
    provider_reference character varying(200),
    direction text NOT NULL,
    currency character(3) NOT NULL,
    expected_amount_minor bigint,
    external_amount_minor bigint,
    difference_minor bigint NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    resolved_at timestamp with time zone,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_reconciliation_break_difference CHECK ((difference_minor = (COALESCE(external_amount_minor, (0)::bigint) - COALESCE(expected_amount_minor, (0)::bigint)))),
    CONSTRAINT chk_reconciliation_break_resolved CHECK (((status = 'RESOLVED'::text) = (resolved_at IS NOT NULL))),
    CONSTRAINT chk_reconciliation_break_shape CHECK (
CASE break_type
    WHEN 'AMOUNT_MISMATCH'::text THEN ((statement_line_id IS NOT NULL) AND (expected_item_id IS NOT NULL) AND (expected_amount_minor IS NOT NULL) AND (external_amount_minor IS NOT NULL))
    WHEN 'DUPLICATE_EXTERNAL'::text THEN ((statement_line_id IS NOT NULL) AND (external_amount_minor IS NOT NULL))
    WHEN 'UNMATCHED_EXTERNAL'::text THEN ((statement_line_id IS NOT NULL) AND (expected_item_id IS NULL) AND (external_amount_minor IS NOT NULL) AND (expected_amount_minor IS NULL))
    WHEN 'MISSING_EXTERNAL'::text THEN ((statement_line_id IS NULL) AND (expected_item_id IS NOT NULL) AND (expected_amount_minor IS NOT NULL) AND (external_amount_minor IS NULL))
    ELSE NULL::boolean
END),
    CONSTRAINT reconciliation_breaks_break_type_check CHECK ((break_type = ANY (ARRAY['AMOUNT_MISMATCH'::text, 'DUPLICATE_EXTERNAL'::text, 'UNMATCHED_EXTERNAL'::text, 'MISSING_EXTERNAL'::text]))),
    CONSTRAINT reconciliation_breaks_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT reconciliation_breaks_direction_check CHECK ((direction = ANY (ARRAY['IN'::text, 'OUT'::text]))),
    CONSTRAINT reconciliation_breaks_expected_amount_minor_check CHECK (((expected_amount_minor >= 1) AND (expected_amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT reconciliation_breaks_external_amount_minor_check CHECK (((external_amount_minor >= 1) AND (external_amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT reconciliation_breaks_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'RESOLVED'::text])))
);

ALTER TABLE ONLY settlement.reconciliation_breaks FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE reconciliation_breaks; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.reconciliation_breaks IS 'CB-7 slice A (D181, D182): an exception a run found. At most one open break per statement line and per expected item.';


--
-- Name: reconciliation_matches; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.reconciliation_matches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    statement_line_id uuid NOT NULL,
    expected_item_id uuid NOT NULL,
    rule text NOT NULL,
    matched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reconciliation_matches_rule_check CHECK ((rule = 'EXACT'::text))
);

ALTER TABLE ONLY settlement.reconciliation_matches FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE reconciliation_matches; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.reconciliation_matches IS 'CB-7 slice A (D181): one statement line matched to one expected item. Matching never changes the source records.';


--
-- Name: reconciliation_resolutions; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.reconciliation_resolutions (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    break_id uuid NOT NULL,
    resolution_type text NOT NULL,
    note character varying(2000),
    match_id uuid,
    replacement_break_id uuid,
    run_id uuid,
    resolved_by uuid,
    correlation_id uuid NOT NULL,
    resolved_at timestamp with time zone DEFAULT now() NOT NULL,
    treatment text,
    amount_minor bigint,
    currency character(3),
    approval_id uuid,
    posting_request_id uuid,
    ledger_adjustment_id uuid,
    ledger_transaction_id uuid,
    CONSTRAINT chk_reconciliation_resolution_posting CHECK ((((resolution_type = 'ADJUSTMENT_POSTED'::text) = (posting_request_id IS NOT NULL)) AND ((resolution_type <> 'ADJUSTMENT_POSTED'::text) OR ((treatment IS NOT NULL) AND (amount_minor IS NOT NULL) AND (currency IS NOT NULL) AND (approval_id IS NOT NULL) AND (ledger_adjustment_id IS NOT NULL) AND (ledger_transaction_id IS NOT NULL))) AND ((resolution_type = 'ADJUSTMENT_POSTED'::text) OR ((treatment IS NULL) AND (amount_minor IS NULL) AND (currency IS NULL) AND (approval_id IS NULL) AND (ledger_adjustment_id IS NULL) AND (ledger_transaction_id IS NULL))))),
    CONSTRAINT chk_reconciliation_resolution_shape CHECK (
CASE resolution_type
    WHEN 'LATE_MATCH'::text THEN ((match_id IS NOT NULL) AND (run_id IS NOT NULL) AND (resolved_by IS NULL))
    WHEN 'RECLASSIFIED'::text THEN ((replacement_break_id IS NOT NULL) AND (run_id IS NOT NULL) AND (resolved_by IS NULL))
    ELSE ((resolved_by IS NOT NULL) AND (note IS NOT NULL) AND (length(TRIM(BOTH FROM note)) >= 10) AND (match_id IS NULL) AND (replacement_break_id IS NULL))
END),
    CONSTRAINT reconciliation_resolutions_amount_minor_check CHECK (((amount_minor >= 1) AND (amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT reconciliation_resolutions_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT reconciliation_resolutions_resolution_type_check CHECK ((resolution_type = ANY (ARRAY['LATE_MATCH'::text, 'RECLASSIFIED'::text, 'WRITE_OFF_NO_IMPACT'::text, 'PROVIDER_CONFIRMED'::text, 'DUPLICATE_ACKNOWLEDGED'::text, 'OTHER'::text, 'ADJUSTMENT_POSTED'::text]))),
    CONSTRAINT reconciliation_resolutions_treatment_check CHECK ((treatment = ANY (ARRAY['SUSPENSE'::text, 'PROVIDER_CHARGE'::text, 'WRITE_OFF'::text])))
);

ALTER TABLE ONLY settlement.reconciliation_resolutions FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE reconciliation_resolutions; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.reconciliation_resolutions IS 'CB-7 slices A and B (D182, D183, D185): how a break was closed. Automatic (late match, reclassified), by an administrator with a reason and no posting, or ADJUSTMENT_POSTED through an approved Ledger adjustment.';


--
-- Name: reconciliation_rules; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.reconciliation_rules (
    version character varying(20) NOT NULL,
    description text NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE reconciliation_rules; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.reconciliation_rules IS 'CB-7 slice A (D181): platform-fixed rule sets. Runs record the version they used.';


--
-- Name: reconciliation_runs; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.reconciliation_runs (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    period_from date NOT NULL,
    period_to date NOT NULL,
    rule_set_version character varying(20) NOT NULL,
    trigger text NOT NULL,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    requested_by uuid,
    idempotency_key character varying(255) NOT NULL,
    request_hash character(64) NOT NULL,
    lines_considered integer DEFAULT 0 NOT NULL,
    items_considered integer DEFAULT 0 NOT NULL,
    matched_count integer DEFAULT 0 NOT NULL,
    breaks_opened integer DEFAULT 0 NOT NULL,
    breaks_resolved integer DEFAULT 0 NOT NULL,
    failure_code character varying(100),
    correlation_id uuid NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT chk_reconciliation_run_done CHECK (((status = 'RUNNING'::text) = (completed_at IS NULL))),
    CONSTRAINT chk_reconciliation_run_failure CHECK (((status = 'FAILED'::text) = (failure_code IS NOT NULL))),
    CONSTRAINT chk_reconciliation_run_period CHECK (((period_from <= period_to) AND ((period_to - period_from) <= 31))),
    CONSTRAINT reconciliation_runs_breaks_opened_check CHECK ((breaks_opened >= 0)),
    CONSTRAINT reconciliation_runs_breaks_resolved_check CHECK ((breaks_resolved >= 0)),
    CONSTRAINT reconciliation_runs_idempotency_key_check CHECK ((length((idempotency_key)::text) > 0)),
    CONSTRAINT reconciliation_runs_items_considered_check CHECK ((items_considered >= 0)),
    CONSTRAINT reconciliation_runs_lines_considered_check CHECK ((lines_considered >= 0)),
    CONSTRAINT reconciliation_runs_matched_count_check CHECK ((matched_count >= 0)),
    CONSTRAINT reconciliation_runs_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT reconciliation_runs_status_check CHECK ((status = ANY (ARRAY['RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text]))),
    CONSTRAINT reconciliation_runs_trigger_check CHECK ((trigger = 'MANUAL'::text))
);

ALTER TABLE ONLY settlement.reconciliation_runs FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE reconciliation_runs; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.reconciliation_runs IS 'CB-7 slice A (D181): one matching pass over a participant''s statement lines and expected items for a period of value dates.';


--
-- Name: settlement_participants; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.settlement_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(150) NOT NULL,
    kind text NOT NULL,
    currency character(3) NOT NULL,
    grace_days integer DEFAULT 2 NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_participants_code_check CHECK (((code)::text ~ '^[A-Z0-9][A-Z0-9_-]{0,49}$'::text)),
    CONSTRAINT settlement_participants_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT settlement_participants_grace_days_check CHECK (((grace_days >= 0) AND (grace_days <= 30))),
    CONSTRAINT settlement_participants_kind_check CHECK ((kind = ANY (ARRAY['PAYMENT_PROVIDER'::text, 'BANK'::text, 'BILLER_AGGREGATOR'::text]))),
    CONSTRAINT settlement_participants_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT settlement_participants_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text]))),
    CONSTRAINT settlement_participants_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY settlement.settlement_participants FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE settlement_participants; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.settlement_participants IS 'CB-7 slice A (D181): providers and banks whose statements are reconciled. The code is the Payment provider code.';


--
-- Name: suspense_investigation_notes; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.suspense_investigation_notes (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    investigation_id uuid NOT NULL,
    note character varying(2000) NOT NULL,
    author_id uuid NOT NULL,
    correlation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suspense_investigation_notes_note_check CHECK ((length(TRIM(BOTH FROM note)) > 0))
);

ALTER TABLE ONLY settlement.suspense_investigation_notes FORCE ROW LEVEL SECURITY;


--
-- Name: suspense_investigations; Type: TABLE; Schema: settlement; Owner: -
--

CREATE TABLE settlement.suspense_investigations (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    break_id uuid NOT NULL,
    opening_resolution_id uuid NOT NULL,
    opening_posting_request_id uuid NOT NULL,
    side text NOT NULL,
    amount_minor bigint NOT NULL,
    currency character(3) NOT NULL,
    opening_ledger_transaction_id uuid NOT NULL,
    status text DEFAULT 'OPEN'::text NOT NULL,
    closure_type text,
    closing_posting_request_id uuid,
    closing_ledger_transaction_id uuid,
    closing_note character varying(1000),
    closed_by uuid,
    closed_at timestamp with time zone,
    opened_by uuid NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_suspense_investigation_closed CHECK (
CASE status
    WHEN 'OPEN'::text THEN ((closure_type IS NULL) AND (closing_posting_request_id IS NULL) AND (closing_ledger_transaction_id IS NULL) AND (closing_note IS NULL) AND (closed_by IS NULL) AND (closed_at IS NULL))
    WHEN 'CLOSED'::text THEN ((closure_type IS NOT NULL) AND (closing_ledger_transaction_id IS NOT NULL) AND (closing_note IS NOT NULL) AND (length(TRIM(BOTH FROM closing_note)) >= 10) AND (closed_by IS NOT NULL) AND (closed_at IS NOT NULL) AND ((closure_type = 'RELEASED'::text) = (closing_posting_request_id IS NOT NULL)))
    ELSE NULL::boolean
END),
    CONSTRAINT chk_suspense_investigation_closing_journal CHECK ((closing_ledger_transaction_id IS DISTINCT FROM opening_ledger_transaction_id)),
    CONSTRAINT suspense_investigations_amount_minor_check CHECK (((amount_minor >= 1) AND (amount_minor <= '999999999999999'::bigint))),
    CONSTRAINT suspense_investigations_closure_type_check CHECK ((closure_type = ANY (ARRAY['RELEASED'::text, 'CLEARED_BY_JOURNAL'::text]))),
    CONSTRAINT suspense_investigations_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT suspense_investigations_side_check CHECK ((side = ANY (ARRAY['CREDIT'::text, 'DEBIT'::text]))),
    CONSTRAINT suspense_investigations_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])))
);

ALTER TABLE ONLY settlement.suspense_investigations FORCE ROW LEVEL SECURITY;


--
-- Name: TABLE suspense_investigations; Type: COMMENT; Schema: settlement; Owner: -
--

COMMENT ON TABLE settlement.suspense_investigations IS 'CB-7 slice B (D188): money a SUSPENSE posting parked. CREDIT when suspense was credited. Closed by an approved release posting or by linking an exact Ledger journal posted elsewhere.';


--
-- Name: admin_export_downloads admin_export_downloads_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.admin_export_downloads
    ADD CONSTRAINT admin_export_downloads_pkey PRIMARY KEY (id);


--
-- Name: admin_exports admin_exports_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.admin_exports
    ADD CONSTRAINT admin_exports_pkey PRIMARY KEY (id);


--
-- Name: bank_statement_imports bank_statement_imports_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT bank_statement_imports_pkey PRIMARY KEY (id);


--
-- Name: bank_statement_lines bank_statement_lines_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_lines
    ADD CONSTRAINT bank_statement_lines_pkey PRIMARY KEY (id);


--
-- Name: expected_items expected_items_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.expected_items
    ADD CONSTRAINT expected_items_pkey PRIMARY KEY (id);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, operation, idempotency_key);


--
-- Name: inbox_events inbox_events_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.inbox_events
    ADD CONSTRAINT inbox_events_pkey PRIMARY KEY (id);


--
-- Name: ledger_journal_refs ledger_journal_refs_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.ledger_journal_refs
    ADD CONSTRAINT ledger_journal_refs_pkey PRIMARY KEY (tenant_id, journal_id);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (id);


--
-- Name: posting_requests posting_requests_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.posting_requests
    ADD CONSTRAINT posting_requests_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_breaks reconciliation_breaks_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_breaks
    ADD CONSTRAINT reconciliation_breaks_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_matches reconciliation_matches_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT reconciliation_matches_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_resolutions reconciliation_resolutions_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT reconciliation_resolutions_pkey PRIMARY KEY (id);


--
-- Name: reconciliation_rules reconciliation_rules_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_rules
    ADD CONSTRAINT reconciliation_rules_pkey PRIMARY KEY (version);


--
-- Name: reconciliation_runs reconciliation_runs_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_runs
    ADD CONSTRAINT reconciliation_runs_pkey PRIMARY KEY (id);


--
-- Name: settlement_participants settlement_participants_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.settlement_participants
    ADD CONSTRAINT settlement_participants_pkey PRIMARY KEY (id);


--
-- Name: suspense_investigation_notes suspense_investigation_notes_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigation_notes
    ADD CONSTRAINT suspense_investigation_notes_pkey PRIMARY KEY (id);


--
-- Name: suspense_investigations suspense_investigations_pkey; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT suspense_investigations_pkey PRIMARY KEY (id);


--
-- Name: admin_exports uq_admin_export_idempotency; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.admin_exports
    ADD CONSTRAINT uq_admin_export_idempotency UNIQUE (tenant_id, idempotency_key);


--
-- Name: admin_exports uq_admin_export_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.admin_exports
    ADD CONSTRAINT uq_admin_export_tenant_id UNIQUE (tenant_id, id);


--
-- Name: expected_items uq_expected_item_source; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.expected_items
    ADD CONSTRAINT uq_expected_item_source UNIQUE (tenant_id, source_service, source_type, source_id);


--
-- Name: expected_items uq_expected_item_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.expected_items
    ADD CONSTRAINT uq_expected_item_tenant_id UNIQUE (tenant_id, id);


--
-- Name: inbox_events uq_inbox_event; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.inbox_events
    ADD CONSTRAINT uq_inbox_event UNIQUE (tenant_id, source_service, event_id, consumer_name);


--
-- Name: outbox_events uq_outbox_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.outbox_events
    ADD CONSTRAINT uq_outbox_tenant_id UNIQUE (tenant_id, id);


--
-- Name: settlement_participants uq_participant_code; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.settlement_participants
    ADD CONSTRAINT uq_participant_code UNIQUE (tenant_id, code);


--
-- Name: settlement_participants uq_participant_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.settlement_participants
    ADD CONSTRAINT uq_participant_tenant_id UNIQUE (tenant_id, id);


--
-- Name: posting_requests uq_posting_request_key; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.posting_requests
    ADD CONSTRAINT uq_posting_request_key UNIQUE (tenant_id, idempotency_key);


--
-- Name: posting_requests uq_posting_request_ledger_key; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.posting_requests
    ADD CONSTRAINT uq_posting_request_ledger_key UNIQUE (tenant_id, ledger_idempotency_key);


--
-- Name: posting_requests uq_posting_request_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.posting_requests
    ADD CONSTRAINT uq_posting_request_tenant_id UNIQUE (tenant_id, id);


--
-- Name: reconciliation_breaks uq_reconciliation_break_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_breaks
    ADD CONSTRAINT uq_reconciliation_break_tenant_id UNIQUE (tenant_id, id);


--
-- Name: reconciliation_matches uq_reconciliation_match_item; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT uq_reconciliation_match_item UNIQUE (tenant_id, expected_item_id);


--
-- Name: reconciliation_matches uq_reconciliation_match_line; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT uq_reconciliation_match_line UNIQUE (tenant_id, statement_line_id);


--
-- Name: reconciliation_matches uq_reconciliation_match_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT uq_reconciliation_match_tenant_id UNIQUE (tenant_id, id);


--
-- Name: reconciliation_resolutions uq_reconciliation_resolution_break; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT uq_reconciliation_resolution_break UNIQUE (tenant_id, break_id);


--
-- Name: reconciliation_resolutions uq_reconciliation_resolution_posting; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT uq_reconciliation_resolution_posting UNIQUE (tenant_id, posting_request_id);


--
-- Name: reconciliation_resolutions uq_reconciliation_resolution_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT uq_reconciliation_resolution_tenant_id UNIQUE (tenant_id, id);


--
-- Name: reconciliation_runs uq_reconciliation_run_idempotency; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_runs
    ADD CONSTRAINT uq_reconciliation_run_idempotency UNIQUE (tenant_id, idempotency_key);


--
-- Name: reconciliation_runs uq_reconciliation_run_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_runs
    ADD CONSTRAINT uq_reconciliation_run_tenant_id UNIQUE (tenant_id, id);


--
-- Name: bank_statement_imports uq_statement_import_content; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT uq_statement_import_content UNIQUE (tenant_id, participant_id, statement_date, content_sha256);


--
-- Name: bank_statement_imports uq_statement_import_object; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT uq_statement_import_object UNIQUE (object_key);


--
-- Name: bank_statement_imports uq_statement_import_supersedes; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT uq_statement_import_supersedes UNIQUE (tenant_id, supersedes_import_id);


--
-- Name: bank_statement_imports uq_statement_import_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT uq_statement_import_tenant_id UNIQUE (tenant_id, id);


--
-- Name: bank_statement_lines uq_statement_line_number; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_lines
    ADD CONSTRAINT uq_statement_line_number UNIQUE (tenant_id, import_id, line_number);


--
-- Name: bank_statement_lines uq_statement_line_reference; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_lines
    ADD CONSTRAINT uq_statement_line_reference UNIQUE (tenant_id, import_id, line_reference);


--
-- Name: bank_statement_lines uq_statement_line_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_lines
    ADD CONSTRAINT uq_statement_line_tenant_id UNIQUE (tenant_id, id);


--
-- Name: suspense_investigations uq_suspense_investigation_break; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT uq_suspense_investigation_break UNIQUE (tenant_id, break_id);


--
-- Name: suspense_investigations uq_suspense_investigation_closing_journal; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT uq_suspense_investigation_closing_journal UNIQUE (tenant_id, closing_ledger_transaction_id);


--
-- Name: suspense_investigations uq_suspense_investigation_tenant_id; Type: CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT uq_suspense_investigation_tenant_id UNIQUE (tenant_id, id);


--
-- Name: idx_admin_export_downloads_export; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_admin_export_downloads_export ON settlement.admin_export_downloads USING btree (tenant_id, export_id, downloaded_at);


--
-- Name: idx_admin_exports_expiry; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_admin_exports_expiry ON settlement.admin_exports USING btree (expires_at) WHERE ((status)::text = 'READY'::text);


--
-- Name: idx_admin_exports_tenant; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_admin_exports_tenant ON settlement.admin_exports USING btree (tenant_id, created_at DESC, id DESC);


--
-- Name: idx_expected_item_open; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_expected_item_open ON settlement.expected_items USING btree (tenant_id, provider_code, value_date) WHERE (status = 'EXPECTED'::text);


--
-- Name: idx_expected_item_reference; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_expected_item_reference ON settlement.expected_items USING btree (tenant_id, provider_code, provider_reference) WHERE (provider_reference IS NOT NULL);


--
-- Name: idx_outbox_retry; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_outbox_retry ON settlement.outbox_events USING btree (tenant_id, available_at) WHERE ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'FAILED'::character varying])::text[]));


--
-- Name: idx_reconciliation_break_status; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_reconciliation_break_status ON settlement.reconciliation_breaks USING btree (tenant_id, status, detected_at DESC);


--
-- Name: idx_reconciliation_run_participant; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_reconciliation_run_participant ON settlement.reconciliation_runs USING btree (tenant_id, participant_id, started_at DESC);


--
-- Name: idx_statement_import_date; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_statement_import_date ON settlement.bank_statement_imports USING btree (tenant_id, participant_id, statement_date);


--
-- Name: idx_statement_line_value_date; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_statement_line_value_date ON settlement.bank_statement_lines USING btree (tenant_id, participant_id, value_date);


--
-- Name: idx_suspense_investigation_status; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_suspense_investigation_status ON settlement.suspense_investigations USING btree (tenant_id, status, opened_at DESC);


--
-- Name: idx_suspense_note_investigation; Type: INDEX; Schema: settlement; Owner: -
--

CREATE INDEX idx_suspense_note_investigation ON settlement.suspense_investigation_notes USING btree (tenant_id, investigation_id, created_at);


--
-- Name: uq_outbox_aggregate_fact; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_outbox_aggregate_fact ON settlement.outbox_events USING btree (tenant_id, aggregate_type, aggregate_id, event_type, aggregate_version);


--
-- Name: uq_posting_request_completed_break; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_posting_request_completed_break ON settlement.posting_requests USING btree (tenant_id, break_id) WHERE ((status = 'COMPLETED'::text) AND (break_id IS NOT NULL));


--
-- Name: uq_posting_request_completed_investigation; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_posting_request_completed_investigation ON settlement.posting_requests USING btree (tenant_id, investigation_id) WHERE ((status = 'COMPLETED'::text) AND (investigation_id IS NOT NULL));


--
-- Name: uq_posting_request_pending_break; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_posting_request_pending_break ON settlement.posting_requests USING btree (tenant_id, break_id) WHERE ((status = 'PENDING'::text) AND (break_id IS NOT NULL));


--
-- Name: uq_posting_request_pending_investigation; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_posting_request_pending_investigation ON settlement.posting_requests USING btree (tenant_id, investigation_id) WHERE ((status = 'PENDING'::text) AND (investigation_id IS NOT NULL));


--
-- Name: uq_reconciliation_break_open_item; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_reconciliation_break_open_item ON settlement.reconciliation_breaks USING btree (tenant_id, expected_item_id) WHERE ((status = 'OPEN'::text) AND (break_type = ANY (ARRAY['AMOUNT_MISMATCH'::text, 'MISSING_EXTERNAL'::text])));


--
-- Name: uq_reconciliation_break_open_line; Type: INDEX; Schema: settlement; Owner: -
--

CREATE UNIQUE INDEX uq_reconciliation_break_open_line ON settlement.reconciliation_breaks USING btree (tenant_id, statement_line_id) WHERE ((status = 'OPEN'::text) AND (statement_line_id IS NOT NULL));


--
-- Name: admin_export_downloads append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.admin_export_downloads FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: bank_statement_imports append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.bank_statement_imports FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: bank_statement_lines append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.bank_statement_lines FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: idempotency_keys append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.idempotency_keys FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: inbox_events append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.inbox_events FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: ledger_journal_refs append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.ledger_journal_refs FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: reconciliation_matches append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.reconciliation_matches FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: reconciliation_resolutions append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.reconciliation_resolutions FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: reconciliation_rules append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.reconciliation_rules FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: suspense_investigation_notes append_only; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER append_only BEFORE DELETE OR UPDATE ON settlement.suspense_investigation_notes FOR EACH ROW EXECUTE FUNCTION settlement.reject_mutation();


--
-- Name: expected_items guard_columns; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_columns BEFORE DELETE OR UPDATE ON settlement.expected_items FOR EACH ROW EXECUTE FUNCTION settlement.guard_columns('status', 'matched_at', 'reversed_at', 'reversal_ledger_transaction_id', 'updated_at');


--
-- Name: posting_requests guard_columns; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_columns BEFORE DELETE OR UPDATE ON settlement.posting_requests FOR EACH ROW EXECUTE FUNCTION settlement.guard_columns('status', 'failure_code', 'ledger_adjustment_id', 'ledger_transaction_id', 'completed_at');


--
-- Name: reconciliation_breaks guard_columns; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_columns BEFORE DELETE OR UPDATE ON settlement.reconciliation_breaks FOR EACH ROW EXECUTE FUNCTION settlement.guard_columns('status', 'resolved_at');


--
-- Name: reconciliation_runs guard_columns; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_columns BEFORE DELETE OR UPDATE ON settlement.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION settlement.guard_columns('status', 'lines_considered', 'items_considered', 'matched_count', 'breaks_opened', 'breaks_resolved', 'failure_code', 'completed_at');


--
-- Name: settlement_participants guard_columns; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_columns BEFORE DELETE OR UPDATE ON settlement.settlement_participants FOR EACH ROW EXECUTE FUNCTION settlement.guard_columns('name', 'grace_days', 'status', 'version', 'updated_by', 'updated_at');


--
-- Name: suspense_investigations guard_columns; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_columns BEFORE DELETE OR UPDATE ON settlement.suspense_investigations FOR EACH ROW EXECUTE FUNCTION settlement.guard_columns('status', 'closure_type', 'closing_posting_request_id', 'closing_ledger_transaction_id', 'closing_note', 'closed_by', 'closed_at');


--
-- Name: expected_items guard_transition; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_transition BEFORE UPDATE ON settlement.expected_items FOR EACH ROW EXECUTE FUNCTION settlement.guard_expected_item();


--
-- Name: posting_requests guard_transition; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_transition BEFORE UPDATE ON settlement.posting_requests FOR EACH ROW EXECUTE FUNCTION settlement.guard_posting_request();


--
-- Name: reconciliation_breaks guard_transition; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_transition BEFORE UPDATE ON settlement.reconciliation_breaks FOR EACH ROW EXECUTE FUNCTION settlement.guard_break();


--
-- Name: reconciliation_runs guard_transition; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_transition BEFORE UPDATE ON settlement.reconciliation_runs FOR EACH ROW EXECUTE FUNCTION settlement.guard_run();


--
-- Name: suspense_investigations guard_transition; Type: TRIGGER; Schema: settlement; Owner: -
--

CREATE TRIGGER guard_transition BEFORE UPDATE ON settlement.suspense_investigations FOR EACH ROW EXECUTE FUNCTION settlement.guard_suspense_investigation();


--
-- Name: admin_export_downloads fk_admin_export_download; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.admin_export_downloads
    ADD CONSTRAINT fk_admin_export_download FOREIGN KEY (tenant_id, export_id) REFERENCES settlement.admin_exports(tenant_id, id);


--
-- Name: posting_requests fk_posting_request_break; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.posting_requests
    ADD CONSTRAINT fk_posting_request_break FOREIGN KEY (tenant_id, break_id) REFERENCES settlement.reconciliation_breaks(tenant_id, id);


--
-- Name: reconciliation_breaks fk_reconciliation_break_item; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_breaks
    ADD CONSTRAINT fk_reconciliation_break_item FOREIGN KEY (tenant_id, expected_item_id) REFERENCES settlement.expected_items(tenant_id, id);


--
-- Name: reconciliation_breaks fk_reconciliation_break_line; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_breaks
    ADD CONSTRAINT fk_reconciliation_break_line FOREIGN KEY (tenant_id, statement_line_id) REFERENCES settlement.bank_statement_lines(tenant_id, id);


--
-- Name: reconciliation_breaks fk_reconciliation_break_participant; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_breaks
    ADD CONSTRAINT fk_reconciliation_break_participant FOREIGN KEY (tenant_id, participant_id) REFERENCES settlement.settlement_participants(tenant_id, id);


--
-- Name: reconciliation_breaks fk_reconciliation_break_run; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_breaks
    ADD CONSTRAINT fk_reconciliation_break_run FOREIGN KEY (tenant_id, run_id) REFERENCES settlement.reconciliation_runs(tenant_id, id);


--
-- Name: reconciliation_matches fk_reconciliation_match_item; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT fk_reconciliation_match_item FOREIGN KEY (tenant_id, expected_item_id) REFERENCES settlement.expected_items(tenant_id, id);


--
-- Name: reconciliation_matches fk_reconciliation_match_line; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT fk_reconciliation_match_line FOREIGN KEY (tenant_id, statement_line_id) REFERENCES settlement.bank_statement_lines(tenant_id, id);


--
-- Name: reconciliation_matches fk_reconciliation_match_run; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_matches
    ADD CONSTRAINT fk_reconciliation_match_run FOREIGN KEY (tenant_id, run_id) REFERENCES settlement.reconciliation_runs(tenant_id, id);


--
-- Name: reconciliation_resolutions fk_reconciliation_resolution_break; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT fk_reconciliation_resolution_break FOREIGN KEY (tenant_id, break_id) REFERENCES settlement.reconciliation_breaks(tenant_id, id);


--
-- Name: reconciliation_resolutions fk_reconciliation_resolution_match; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT fk_reconciliation_resolution_match FOREIGN KEY (tenant_id, match_id) REFERENCES settlement.reconciliation_matches(tenant_id, id);


--
-- Name: reconciliation_resolutions fk_reconciliation_resolution_posting; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT fk_reconciliation_resolution_posting FOREIGN KEY (tenant_id, posting_request_id) REFERENCES settlement.posting_requests(tenant_id, id);


--
-- Name: reconciliation_resolutions fk_reconciliation_resolution_replacement; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT fk_reconciliation_resolution_replacement FOREIGN KEY (tenant_id, replacement_break_id) REFERENCES settlement.reconciliation_breaks(tenant_id, id);


--
-- Name: reconciliation_resolutions fk_reconciliation_resolution_run; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_resolutions
    ADD CONSTRAINT fk_reconciliation_resolution_run FOREIGN KEY (tenant_id, run_id) REFERENCES settlement.reconciliation_runs(tenant_id, id);


--
-- Name: reconciliation_runs fk_reconciliation_run_participant; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_runs
    ADD CONSTRAINT fk_reconciliation_run_participant FOREIGN KEY (tenant_id, participant_id) REFERENCES settlement.settlement_participants(tenant_id, id);


--
-- Name: bank_statement_imports fk_statement_import_participant; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT fk_statement_import_participant FOREIGN KEY (tenant_id, participant_id) REFERENCES settlement.settlement_participants(tenant_id, id);


--
-- Name: bank_statement_imports fk_statement_import_supersedes; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_imports
    ADD CONSTRAINT fk_statement_import_supersedes FOREIGN KEY (tenant_id, supersedes_import_id) REFERENCES settlement.bank_statement_imports(tenant_id, id);


--
-- Name: bank_statement_lines fk_statement_line_import; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_lines
    ADD CONSTRAINT fk_statement_line_import FOREIGN KEY (tenant_id, import_id) REFERENCES settlement.bank_statement_imports(tenant_id, id);


--
-- Name: bank_statement_lines fk_statement_line_participant; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.bank_statement_lines
    ADD CONSTRAINT fk_statement_line_participant FOREIGN KEY (tenant_id, participant_id) REFERENCES settlement.settlement_participants(tenant_id, id);


--
-- Name: suspense_investigations fk_suspense_investigation_break; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT fk_suspense_investigation_break FOREIGN KEY (tenant_id, break_id) REFERENCES settlement.reconciliation_breaks(tenant_id, id);


--
-- Name: suspense_investigations fk_suspense_investigation_closing; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT fk_suspense_investigation_closing FOREIGN KEY (tenant_id, closing_posting_request_id) REFERENCES settlement.posting_requests(tenant_id, id);


--
-- Name: suspense_investigations fk_suspense_investigation_opening; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT fk_suspense_investigation_opening FOREIGN KEY (tenant_id, opening_posting_request_id) REFERENCES settlement.posting_requests(tenant_id, id);


--
-- Name: suspense_investigations fk_suspense_investigation_participant; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT fk_suspense_investigation_participant FOREIGN KEY (tenant_id, participant_id) REFERENCES settlement.settlement_participants(tenant_id, id);


--
-- Name: suspense_investigations fk_suspense_investigation_resolution; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigations
    ADD CONSTRAINT fk_suspense_investigation_resolution FOREIGN KEY (tenant_id, opening_resolution_id) REFERENCES settlement.reconciliation_resolutions(tenant_id, id);


--
-- Name: suspense_investigation_notes fk_suspense_note_investigation; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.suspense_investigation_notes
    ADD CONSTRAINT fk_suspense_note_investigation FOREIGN KEY (tenant_id, investigation_id) REFERENCES settlement.suspense_investigations(tenant_id, id);


--
-- Name: reconciliation_runs reconciliation_runs_rule_set_version_fkey; Type: FK CONSTRAINT; Schema: settlement; Owner: -
--

ALTER TABLE ONLY settlement.reconciliation_runs
    ADD CONSTRAINT reconciliation_runs_rule_set_version_fkey FOREIGN KEY (rule_set_version) REFERENCES settlement.reconciliation_rules(version);


--
-- Name: admin_export_downloads; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.admin_export_downloads ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_export_downloads admin_export_downloads_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY admin_export_downloads_tenant_policy ON settlement.admin_export_downloads USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: admin_exports; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.admin_exports ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_exports admin_exports_purge_owner; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY admin_exports_purge_owner ON settlement.admin_exports TO parc_settlement_migrator USING (true) WITH CHECK (true);


--
-- Name: admin_exports admin_exports_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY admin_exports_tenant_policy ON settlement.admin_exports USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: bank_statement_imports; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.bank_statement_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_statement_imports bank_statement_imports_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY bank_statement_imports_tenant_policy ON settlement.bank_statement_imports USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: bank_statement_lines; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.bank_statement_lines ENABLE ROW LEVEL SECURITY;

--
-- Name: bank_statement_lines bank_statement_lines_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY bank_statement_lines_tenant_policy ON settlement.bank_statement_lines USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: expected_items; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.expected_items ENABLE ROW LEVEL SECURITY;

--
-- Name: expected_items expected_items_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY expected_items_tenant_policy ON settlement.expected_items USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: idempotency_keys; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.idempotency_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: idempotency_keys idempotency_keys_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY idempotency_keys_tenant_policy ON settlement.idempotency_keys USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: inbox_events; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.inbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: inbox_events inbox_events_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY inbox_events_tenant_policy ON settlement.inbox_events USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: ledger_journal_refs; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.ledger_journal_refs ENABLE ROW LEVEL SECURITY;

--
-- Name: ledger_journal_refs ledger_journal_refs_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY ledger_journal_refs_tenant_policy ON settlement.ledger_journal_refs USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: outbox_events; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.outbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: outbox_events outbox_events_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY outbox_events_tenant_policy ON settlement.outbox_events USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: outbox_events outbox_tenant_discovery_owner_read; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY outbox_tenant_discovery_owner_read ON settlement.outbox_events FOR SELECT TO parc_settlement_migrator USING (true);


--
-- Name: posting_requests; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.posting_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: posting_requests posting_requests_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY posting_requests_tenant_policy ON settlement.posting_requests USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: reconciliation_breaks; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.reconciliation_breaks ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_breaks reconciliation_breaks_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY reconciliation_breaks_tenant_policy ON settlement.reconciliation_breaks USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: reconciliation_matches; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.reconciliation_matches ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_matches reconciliation_matches_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY reconciliation_matches_tenant_policy ON settlement.reconciliation_matches USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: reconciliation_resolutions; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.reconciliation_resolutions ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_resolutions reconciliation_resolutions_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY reconciliation_resolutions_tenant_policy ON settlement.reconciliation_resolutions USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: reconciliation_runs; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.reconciliation_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: reconciliation_runs reconciliation_runs_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY reconciliation_runs_tenant_policy ON settlement.reconciliation_runs USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: settlement_participants; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.settlement_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: settlement_participants settlement_participants_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY settlement_participants_tenant_policy ON settlement.settlement_participants USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: suspense_investigation_notes; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.suspense_investigation_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: suspense_investigation_notes suspense_investigation_notes_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY suspense_investigation_notes_tenant_policy ON settlement.suspense_investigation_notes USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: suspense_investigations; Type: ROW SECURITY; Schema: settlement; Owner: -
--

ALTER TABLE settlement.suspense_investigations ENABLE ROW LEVEL SECURITY;

--
-- Name: suspense_investigations suspense_investigations_tenant_policy; Type: POLICY; Schema: settlement; Owner: -
--

CREATE POLICY suspense_investigations_tenant_policy ON settlement.suspense_investigations USING ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)) WITH CHECK ((tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid));


--
-- Name: SCHEMA settlement; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA settlement TO parc_settlement_runtime;
GRANT USAGE ON SCHEMA settlement TO parc_settlement_worker;
GRANT USAGE ON SCHEMA settlement TO parc_settlement_readonly;


--
-- Name: FUNCTION outbox_tenants_with_work(); Type: ACL; Schema: settlement; Owner: -
--

REVOKE ALL ON FUNCTION settlement.outbox_tenants_with_work() FROM PUBLIC;
GRANT ALL ON FUNCTION settlement.outbox_tenants_with_work() TO parc_settlement_worker;


--
-- Name: FUNCTION purge_expired_admin_exports(); Type: ACL; Schema: settlement; Owner: -
--

REVOKE ALL ON FUNCTION settlement.purge_expired_admin_exports() FROM PUBLIC;
GRANT ALL ON FUNCTION settlement.purge_expired_admin_exports() TO parc_settlement_worker;


--
-- Name: TABLE admin_export_downloads; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.admin_export_downloads TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.admin_export_downloads TO parc_settlement_runtime;


--
-- Name: TABLE admin_exports; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.admin_exports TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.admin_exports TO parc_settlement_runtime;


--
-- Name: TABLE bank_statement_imports; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.bank_statement_imports TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.bank_statement_imports TO parc_settlement_runtime;


--
-- Name: TABLE bank_statement_lines; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.bank_statement_lines TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.bank_statement_lines TO parc_settlement_runtime;


--
-- Name: TABLE expected_items; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.expected_items TO parc_settlement_readonly;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.expected_items TO parc_settlement_worker;
GRANT SELECT,UPDATE ON TABLE settlement.expected_items TO parc_settlement_runtime;


--
-- Name: TABLE idempotency_keys; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.idempotency_keys TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.idempotency_keys TO parc_settlement_runtime;


--
-- Name: TABLE inbox_events; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.inbox_events TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.inbox_events TO parc_settlement_worker;


--
-- Name: TABLE ledger_journal_refs; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.ledger_journal_refs TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.ledger_journal_refs TO parc_settlement_worker;
GRANT SELECT ON TABLE settlement.ledger_journal_refs TO parc_settlement_runtime;


--
-- Name: TABLE outbox_events; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.outbox_events TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.outbox_events TO parc_settlement_runtime;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.outbox_events TO parc_settlement_worker;


--
-- Name: TABLE posting_requests; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.posting_requests TO parc_settlement_readonly;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.posting_requests TO parc_settlement_runtime;


--
-- Name: TABLE reconciliation_breaks; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.reconciliation_breaks TO parc_settlement_readonly;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.reconciliation_breaks TO parc_settlement_runtime;


--
-- Name: TABLE reconciliation_matches; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.reconciliation_matches TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.reconciliation_matches TO parc_settlement_runtime;


--
-- Name: TABLE reconciliation_resolutions; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.reconciliation_resolutions TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.reconciliation_resolutions TO parc_settlement_runtime;


--
-- Name: TABLE reconciliation_rules; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.reconciliation_rules TO parc_settlement_runtime;
GRANT SELECT ON TABLE settlement.reconciliation_rules TO parc_settlement_worker;
GRANT SELECT ON TABLE settlement.reconciliation_rules TO parc_settlement_readonly;


--
-- Name: TABLE reconciliation_runs; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.reconciliation_runs TO parc_settlement_readonly;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.reconciliation_runs TO parc_settlement_runtime;


--
-- Name: TABLE settlement_participants; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.settlement_participants TO parc_settlement_readonly;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.settlement_participants TO parc_settlement_runtime;
GRANT SELECT ON TABLE settlement.settlement_participants TO parc_settlement_worker;


--
-- Name: TABLE suspense_investigation_notes; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.suspense_investigation_notes TO parc_settlement_readonly;
GRANT SELECT,INSERT ON TABLE settlement.suspense_investigation_notes TO parc_settlement_runtime;


--
-- Name: TABLE suspense_investigations; Type: ACL; Schema: settlement; Owner: -
--

GRANT SELECT ON TABLE settlement.suspense_investigations TO parc_settlement_readonly;
GRANT SELECT,INSERT,UPDATE ON TABLE settlement.suspense_investigations TO parc_settlement_runtime;


--
-- PostgreSQL database dump complete
--

\unrestrict parcschemasnapshot

