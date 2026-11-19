import type { Knex } from "knex";
const compiledMigrations = process.env.KNEX_MIGRATIONS_COMPILED === "true";
/**
 * ADR-023, D178: this service owns only the `settlement` schema of the shared
 * `parc_treasury_settlement` database. The schema and roles come from the
 * TS-DB-000 bootstrap (db/bootstrap/treasury-settlement.sql); migrations run as
 * parc_settlement_migrator and keep Knex's bookkeeping in the same schema.
 */
const config: Knex.Config = {
  client: "pg",
  connection:
    process.env.DATABASE_URL ?? "postgresql:///parc_treasury_settlement",
  searchPath: ["settlement"],
  migrations: {
    // The knex CLI changes into the knexfile's directory (dist/ when compiled).
    directory: "./db/migrations",
    schemaName: "settlement",
    extension: compiledMigrations ? "js" : "ts",
    // Only load runnable files; the build also emits .d.ts declarations here.
    loadExtensions: compiledMigrations ? [".js"] : [".ts"],
  },
};
export default config;
