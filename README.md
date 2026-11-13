# parc-settlement-reconciliation

Settlement batches, clearing files, bank/provider statement ingestion, matching, reconciliation breaks and suspense investigations.

- **Owned database:** `parc_treasury_settlement (schema `settlement`)`
- **Introduced in:** Phase CB-7 of [parc-backend-development-plan.md](../parc-backend-development-plan.md) §25
- **Architecture baseline:** [parc-core-banking-technical-architecture.md](../parc-core-banking-technical-architecture.md)
- **Status:** Directory scaffold only. No package, schema, contract or runtime exists yet.

Before any code lands: publish the OpenAPI/AsyncAPI contracts in `parc-contracts`, get the schema proposal approved, then follow the foundation conventions shared by every Parc service (Yarn, Express, strict TypeScript, Knex migrations, forced RLS, outbox/inbox, Auth-issued service tokens and `src/security/parc-service-auth.ts`).
