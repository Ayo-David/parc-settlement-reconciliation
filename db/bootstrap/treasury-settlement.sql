-- TS-DB-000 (CB-7, ADR-023, D178): the shared parc_treasury_settlement
-- database, its two schemas and the roles of both services that use it.
--
-- Keep this file byte-identical to
-- parc-settlement-reconciliation/db/bootstrap/treasury-settlement.sql (and,
-- once it exists, parc-treasury's copy): repositories cannot import from each
-- other, and each service's CI bootstraps its test database with its copy.
--
-- Run once per PostgreSQL cluster as a superuser, or as an administrator with
-- CREATEROLE and CREATEDB whose createrole_self_grant includes 'set' (PG16), so
-- it can create each schema owned by its migrator. Re-running is safe: existing
-- roles keep their passwords, the database and schemas are left in place, and
-- grants are re-applied.
--
--   psql "postgresql://<admin>@<haproxy-host>:5000/postgres?sslmode=require" \
--     -v ON_ERROR_STOP=1 \
--     -v settlement_migrator_password="$SETTLEMENT_MIGRATOR_PASSWORD" \
--     -v settlement_app_password="$SETTLEMENT_APP_PASSWORD" \
--     -v treasury_migrator_password="$TREASURY_MIGRATOR_PASSWORD" \
--     -v treasury_app_password="$TREASURY_APP_PASSWORD" \
--     -f bootstrap-treasury-settlement.sql
--
-- Optional: -v database=<name> (default parc_treasury_settlement), for test
-- databases. Roles are cluster-wide, so every database shares them.
--
-- Per service <svc> (settlement, treasury) this creates:
--   parc_<svc>_runtime, _worker, _readonly  NOLOGIN group roles
--   parc_<svc>_migrator   LOGIN, owns schema <svc>  -> MIGRATION_DATABASE_URL
--   parc_<svc>_app        LOGIN, runtime + worker   -> DATABASE_URL
-- No role of one service is granted anything on the other's schema; the
-- settlement service's grant-isolation test proves it (ADR-023).

\set ON_ERROR_STOP on

\if :{?database} \else \set database parc_treasury_settlement \endif
\if :{?settlement_migrator_password} \else \set missing settlement_migrator_password \endif
\if :{?settlement_app_password} \else \set missing settlement_app_password \endif
\if :{?treasury_migrator_password} \else \set missing treasury_migrator_password \endif
\if :{?treasury_app_password} \else \set missing treasury_app_password \endif

\if :{?missing}
SELECT format('DO $x$ BEGIN RAISE EXCEPTION %L; END $x$',
              'Missing psql variable ' || :'missing' || '; pass every *_password with -v.')
\gexec
\endif

CREATE TEMP TABLE parc_ts_bootstrap (
  svc               text PRIMARY KEY CHECK (svc IN ('settlement', 'treasury')),
  migrator_password text NOT NULL CHECK (length(migrator_password) > 0),
  app_password      text NOT NULL CHECK (length(app_password) > 0)
);
INSERT INTO parc_ts_bootstrap (svc, migrator_password, app_password) VALUES
  ('settlement', :'settlement_migrator_password', :'settlement_app_password'),
  ('treasury',   :'treasury_migrator_password',   :'treasury_app_password');

-- 1. Group roles the migrations grant to and write RLS policies for.
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', r)
FROM parc_ts_bootstrap,
     unnest(ARRAY['parc_' || svc || '_runtime', 'parc_' || svc || '_worker',
                  'parc_' || svc || '_readonly']) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

-- 2. Migration logins: own their schema and everything created in it.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
              'parc_' || svc || '_migrator', migrator_password)
FROM parc_ts_bootstrap
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parc_' || svc || '_migrator')
\gexec

-- 3. Application logins: own nothing, rights only through the group roles.
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
              'parc_' || svc || '_app', app_password)
FROM parc_ts_bootstrap
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'parc_' || svc || '_app')
\gexec

SELECT format('GRANT %I, %I TO %I', 'parc_' || svc || '_runtime',
              'parc_' || svc || '_worker', 'parc_' || svc || '_app')
FROM parc_ts_bootstrap
\gexec

-- Passwords are no longer needed.
CREATE TEMP TABLE parc_ts_services AS SELECT svc FROM parc_ts_bootstrap;
DROP TABLE parc_ts_bootstrap;

-- 4. The database, owned by the administrator running this script: neither
-- service owns it, so neither can create schemas or change database settings.
SELECT format('CREATE DATABASE %I ENCODING ''UTF8'' TEMPLATE template0', :'database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', r)
FROM parc_ts_services,
     unnest(ARRAY['parc_' || svc || '_migrator', 'parc_' || svc || '_app',
                  'parc_' || svc || '_readonly']) AS r
\gexec
SELECT format('GRANT TEMPORARY ON DATABASE %I TO %I', :'database', 'parc_' || svc || '_app')
FROM parc_ts_services
\gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I',
              r, :'database', svc)
FROM parc_ts_services,
     unnest(ARRAY['parc_' || svc || '_migrator', 'parc_' || svc || '_app']) AS r
\gexec

\connect :database

-- 5. Nobody uses the public schema here; each service has its own.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

SELECT format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', svc, 'parc_' || svc || '_migrator')
FROM (VALUES ('settlement'), ('treasury')) AS s(svc)
\gexec
-- Re-applied on every run, in case an earlier run or an operator changed them.
SELECT format('ALTER SCHEMA %I OWNER TO %I', svc, 'parc_' || svc || '_migrator')
FROM (VALUES ('settlement'), ('treasury')) AS s(svc)
\gexec
SELECT format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', svc)
FROM (VALUES ('settlement'), ('treasury')) AS s(svc)
\gexec
