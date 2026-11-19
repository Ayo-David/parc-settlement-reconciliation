# parc-settlement-reconciliation

Provider and bank statement ingestion, matching, and reconciliation breaks. Settlement batches, clearing files, suspense and posting resolutions follow in later slices.

- **Owned database:** `parc_treasury_settlement`, schema `settlement` only (ADR-023). The treasury schema belongs to `parc-treasury`; no settlement role can use it.
- **Introduced in:** Phase CB-7 of [parc-backend-development-plan.md](../parc-backend-development-plan.md) §25
- **Design:** [CB7-settlement-reconciliation.md](../parc-platform/docs/core-banking/proposals/CB7-settlement-reconciliation.md) (D177–D184)
- **Contract:** `parc-contracts/openapi/settlement-reconciliation/v1/openapi.yaml`; events `reconciliation.run-started.v1`, `reconciliation.break-detected.v1`, `reconciliation.break-resolved.v1`
- **Status:** CB-7 slice A: statements, matching and breaks without postings.

## How reconciliation works (slice A)

| Topic                     | Rule                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expected items (D179)     | Projected from Payment's `transfer-completed` (external only), `collection-confirmed` and `bill-fulfilled`, keyed by Payment's id and valued on the Lagos date. `payment-reversed` marks an item. `ledger.transaction-posted` records journals. |
| Statements (D180)         | Parc's canonical CSV (header below), at most 1 MiB and 20,000 lines. The raw file is sealed with AES-256-GCM by this service and stored in MinIO; lines are stored parsed. The same file imports once; a changed file needs `correction`.    |
| Matching (D181)           | Participant code = provider code, then provider reference, direction, currency and exact amount. Breaks: `AMOUNT_MISMATCH`, `DUPLICATE_EXTERNAL`, `UNMATCHED_EXTERNAL`, `MISSING_EXTERNAL` (after the participant's grace days).            |
| Late arrivals (D182)      | A later match resolves the open unmatched or missing break as `LATE_MATCH`. An unmatched line that becomes a mismatch or duplicate is `RECLASSIFIED`.                                                                                        |
| Resolution (D183)         | An administrator with `settlement.reconciliation.manage` closes a break with a reason. No postings in slice A.                                                                                                                              |

Canonical CSV header:

```text
line_reference,provider_reference,direction,amount_minor,currency,value_date,narration
```

`direction` is from the participant account's side: `IN` credits it (a collection), `OUT` debits it (a transfer or bill paid).

## Running

| Process       | Command              | Purpose                                                       |
| ------------- | -------------------- | ------------------------------------------------------------- |
| API           | `yarn start`         | Port 3011                                                     |
| Outbox worker | `yarn worker:outbox` | Publishes the `reconciliation.*` events                       |
| Event worker  | `yarn worker:events` | Projects Payment's completions and Ledger's journals (inbox) |

Configuration is in `.env.example`.

### Database

The schema and roles come from the TS-DB-000 bootstrap, kept identical in `parc-platform/scripts/bootstrap-treasury-settlement.sql` and `db/bootstrap/treasury-settlement.sql`. Run it once per cluster as an administrator, then migrate as the schema owner:

```sh
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
  -v settlement_migrator_password=... -v settlement_app_password=... \
  -v treasury_migrator_password=... -v treasury_app_password=... \
  -f db/bootstrap/treasury-settlement.sql
DATABASE_URL="$MIGRATION_DATABASE_URL" yarn migrate:latest
```

### Tests

```sh
TEST_DATABASE_URL=postgresql://postgres:...@localhost:5432/parc_treasury_settlement_test \
TEST_APP_DATABASE_URL=postgresql://parc_settlement_app:...@localhost:5432/parc_treasury_settlement_test \
yarn validate
```

Integration tests run the service as `parc_settlement_app` so forced RLS applies. The MinIO round trip runs when `TEST_MINIO_URL`, `TEST_MINIO_ACCESS_KEY` and `TEST_MINIO_SECRET_KEY` are set.

Deployment follows the other services: `ci-cd.yml` validates, builds the GHCR image, migrates and deploys, and `rollback.yml` restores the previous image. Runtime secrets live in `/opt/parc/parc-settlement-reconciliation/.env` on the server.
