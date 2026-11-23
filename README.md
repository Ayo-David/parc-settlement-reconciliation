# parc-settlement-reconciliation

Provider and bank statement ingestion, matching, reconciliation breaks, posting resolutions through Ledger and suspense investigations. Settlement batches and clearing files follow in later slices.

- **Owned database:** `parc_treasury_settlement`, schema `settlement` only (ADR-023). The treasury schema belongs to `parc-treasury`; no settlement role can use it.
- **Introduced in:** Phase CB-7 of [parc-backend-development-plan.md](../parc-backend-development-plan.md) §25
- **Design:** [CB7-settlement-reconciliation.md](../parc-platform/docs/core-banking/proposals/CB7-settlement-reconciliation.md) (D177–D192)
- **Contract:** `parc-contracts/openapi/settlement-reconciliation/v1/openapi.yaml`; events `reconciliation.run-started.v1`, `reconciliation.break-detected.v1`, `reconciliation.break-resolved.v1`, `reconciliation.suspense-opened.v1`, `reconciliation.suspense-closed.v1`
- **Status:** CB-7 slices A (statements, matching, breaks), B (posting resolutions and suspense) and D (the console's reconciliation summary, report and export, in place of Ledger's).

## How reconciliation works (slice A)

| Topic                 | Rule                                                                                                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expected items (D179) | Projected from Payment's `transfer-completed` (external only), `collection-confirmed` and `bill-fulfilled`, keyed by Payment's id and valued on the Lagos date. `payment.reversed` marks an item. `ledger.transaction-posted` records journals. |
| Statements (D180)     | Parc's canonical CSV (header below), at most 1 MiB and 20,000 lines. The raw file is sealed with AES-256-GCM by this service and stored in MinIO; lines are stored parsed. The same file imports once; a changed file needs `correction`.       |
| Matching (D181)       | Participant code = provider code, then provider reference, direction, currency and exact amount. Breaks: `AMOUNT_MISMATCH`, `DUPLICATE_EXTERNAL`, `UNMATCHED_EXTERNAL`, `MISSING_EXTERNAL` (after the participant's grace days).                |
| Late arrivals (D182)  | A later match resolves the open unmatched or missing break as `LATE_MATCH`. An unmatched line that becomes a mismatch or duplicate is `RECLASSIFIED`.                                                                                           |
| Resolution (D183)     | An administrator with `settlement.reconciliation.manage` closes a break with a reason. No postings in slice A.                                                                                                                                  |

## Posting resolutions and suspense (slice B)

Money moves only through Ledger's approval-bound manual adjustment. Settlement calls it delegated as the administrator, and Ledger consumes the tenant-admin approval (D185).

1. `POST /internal/v1/reconciliation-breaks/{id}/posting-resolutions/preview` with a treatment, a note and an `Idempotency-Key`. Settlement builds the journal and returns Ledger's approval binding.
2. The console requests a tenant-admin approval with that binding. A checker other than the maker approves it.
3. `POST .../posting-resolutions` with the same `Idempotency-Key` and the `approval_id`. The break is resolved as `ADJUSTMENT_POSTED`, and a `SUSPENSE` treatment opens a suspense investigation.

| Topic                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treatments (D187)       | The amount always comes from the break. A break that leaves the provider account holding more than the books allows `SUSPENSE` only. One that leaves it holding less allows `PROVIDER_CHARGE` (amount mismatch), `WRITE_OFF` (missing credit) or `SUSPENSE` (unknown or duplicate debit).                                                                                                                                                                                                                                                                 |
| GL accounts (D186)      | Ledger mappings per tenant, participant and currency: `RECON_<PARTICIPANT>_SUSPENSE` (debit provider clearing, credit suspense), `RECON_<PARTICIPANT>_PROVIDER_CHARGE` (debit charges expense, credit clearing), `RECON_<PARTICIPANT>_WRITE_OFF` (debit write-off expense, credit clearing) and `RECON_<PARTICIPANT>_SUSPENSE_RELEASE` (debit suspense, credit the release account). Settlement swaps the sides for the opposite case. A `-` in the participant code becomes `_`. A missing mapping refuses the preview before any approval is requested. |
| Leaving suspense (D188) | An approved `release` posting for the full amount, or `clear-by-journal` with a Ledger journal posted elsewhere. The journal must be in settlement's projection, in the same currency, with the exact total, not the opening journal and not used before.                                                                                                                                                                                                                                                                                                 |
| Failures                | A Ledger refusal (bad approval, missing permission, unbalanced journal) answers `409 LEDGER_REFUSED`. Nothing was posted, and the key is spent. No answer from Ledger gives `503 LEDGER_UNAVAILABLE`. The request stays pending and holds its break or investigation; retry with the same key, which Ledger replays rather than posting twice.                                                                                                                                                                                                            |
| Permissions (D189)      | `settlement.reconciliation.manage`. To post, the administrator also needs Ledger's `ledger.adjustment.post`, which Auth checks when settlement exchanges the token.                                                                                                                                                                                                                                                                                                                                                                                       |

## Console figures, report and export (slice D)

Ledger's reconciliation tables were never written and are dropped (D190–D192). Settlement now serves what the console read from them:

| Route                                                            | Scope (permission)                           | Replaces                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /internal/v1/summary`                                       | `settlement.reconciliation.read`             | Home "Unmatched reconciliation items" (now open breaks and open suspense) |
| `GET /internal/v1/admin/reports/reconciliation-breaks`           | `settlement.reports.read` (`report.read`)    | Ledger's `reconciliation-exceptions` report                               |
| `POST`/`GET /internal/v1/admin/exports`, `GET .../{id}/download` | `settlement.exports.write` (`report.export`) | Ledger's `reconciliation-exceptions` export; kind `reconciliation-breaks` |

Exports follow Ledger's ADR-010 B design: at most 50,000 rows, kept 24 hours, every download recorded. The outbox worker clears expired files hourly.

Canonical CSV header:

```text
line_reference,provider_reference,direction,amount_minor,currency,value_date,narration
```

`direction` is from the participant account's side: `IN` credits it (a collection), `OUT` debits it (a transfer or bill paid).

## Running

| Process       | Command              | Purpose                                                      |
| ------------- | -------------------- | ------------------------------------------------------------ |
| API           | `yarn start`         | Port 3011                                                    |
| Outbox worker | `yarn worker:outbox` | Publishes the `reconciliation.*` events                      |
| Event worker  | `yarn worker:events` | Projects Payment's completions and Ledger's journals (inbox) |

Configuration is in `.env.example`. Slice B adds `LEDGER_URL`, `AUTH_TOKEN_URL`, `SERVICE_CLIENT_KEY_ID` and `SERVICE_CLIENT_PRIVATE_KEY_BASE64`. Auth must hold this service's public key in `SERVICE_CLIENT_KEYS_JSON` under `parc-settlement-reconciliation`.

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
