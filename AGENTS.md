# Settlement-reconciliation service instructions

## Ownership

Own settlement participants, settlement batches and items, clearing files, settlement acknowledgements, bank/provider statement imports and lines, reconciliation rules, runs, matches, breaks and resolutions, suspense investigations, source watermarks and the settlement EOD steps.

## Database

`parc_treasury_settlement` is shared with `parc-treasury` (ADR-023). This service owns only the `settlement` schema and connects with its own runtime and migration roles. Never read or write the `treasury` schema.

## Domain rules

- Ingested statements are immutable evidence with exact source hashes; re-import is idempotent.
- Matching never mutates source payment, card or journal records. Breaks are traceable to source transactions and journals.
- Adjustments go to ledger through controlled, approval-bound posting APIs.
- A provider timeout is never treated as success or failure; unresolved items stay open until inquiry or settlement evidence resolves them.

## Delivery

- Canonical migrations: `db/migrations/` (scoped to the `settlement` schema); generated snapshot: `db/schema/current.sql`.
- Money in `BIGINT` minor units with ISO currency.
- Test duplicate statement lines, partial and amount-mismatched matches, late arrivals, grant isolation and tenant isolation.
