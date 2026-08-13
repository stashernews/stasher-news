-- pg-boss job-queue schema (pg-boss 9.0.3 / schema version 20).
--
-- Why this exists: pg-boss creates its own schema on boss.start() (worker/
-- index.js), but the worker only starts AFTER the app container has run
-- `prisma migrate deploy` (worker depends_on app healthy), and several later
-- migrations INSERT INTO pgboss.schedule / DELETE FROM pgboss.job (earliest is
-- 20260806093632_schedule_streak_job). On a fresh database those migrations
-- failed with "relation pgboss.schedule does not exist". Pre-creating the
-- schema here makes migrations the sole, deterministic schema source so a
-- clean clone boots end-to-end without the worker running first.
--
-- Fidelity: this mirrors pg-boss 9.0.3's plans.create('pgboss', 20) exactly
-- (generated from node_modules/pg-boss/src/plans.js, schemaVersion 20 in
-- node_modules/pg-boss/version.json). boss.start() reads version 20 from
-- pgboss.version and treats the schema as already installed (contractor.js
-- start() -> isInstalled()/version()), so the worker is a no-op at runtime —
-- no double-creation, no conflicting re-migration.
--
-- Idempotency: every statement is re-runnable (IF NOT EXISTS / ON CONFLICT;
-- the ENUM has no IF NOT EXISTS so it is guarded by a DO block). This keeps
-- `prisma migrate deploy` safe on databases where pg-boss already created the
-- schema (e.g. the legacy dev dump, or an install where the worker started
-- before this migration was added).

CREATE SCHEMA IF NOT EXISTS pgboss;

-- CREATE TYPE ... AS ENUM has no IF NOT EXISTS clause; guard with a DO block.
DO $$ BEGIN
  CREATE TYPE pgboss.job_state AS ENUM (
    'created', 'retry', 'active', 'completed', 'expired', 'cancelled', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS pgboss.version (
  version int primary key,
  maintained_on timestamp with time zone,
  cron_on timestamp with time zone
);

CREATE TABLE IF NOT EXISTS pgboss.job (
  id uuid primary key not null default gen_random_uuid(),
  name text not null,
  priority integer not null default(0),
  data jsonb,
  state pgboss.job_state not null default('created'),
  retryLimit integer not null default(0),
  retryCount integer not null default(0),
  retryDelay integer not null default(0),
  retryBackoff boolean not null default false,
  startAfter timestamp with time zone not null default now(),
  startedOn timestamp with time zone,
  singletonKey text,
  singletonOn timestamp without time zone,
  expireIn interval not null default interval '15 minutes',
  createdOn timestamp with time zone not null default now(),
  completedOn timestamp with time zone,
  keepUntil timestamp with time zone NOT NULL default now() + interval '14 days',
  on_complete boolean not null default false,
  output jsonb
);

CREATE TABLE IF NOT EXISTS pgboss.archive (LIKE pgboss.job);

CREATE TABLE IF NOT EXISTS pgboss.schedule (
  name text primary key,
  cron text not null,
  timezone text,
  data jsonb,
  options jsonb,
  created_on timestamp with time zone not null default now(),
  updated_on timestamp with time zone not null default now()
);

CREATE TABLE IF NOT EXISTS pgboss.subscription (
  event text not null,
  name text not null,
  created_on timestamp with time zone not null default now(),
  updated_on timestamp with time zone not null default now(),
  PRIMARY KEY(event, name)
);

CREATE INDEX IF NOT EXISTS archive_id_idx ON pgboss.archive(id);
ALTER TABLE pgboss.archive ADD COLUMN IF NOT EXISTS archivedOn timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS archive_archivedon_idx ON pgboss.archive(archivedon);

CREATE INDEX IF NOT EXISTS job_name ON pgboss.job (name text_pattern_ops);
CREATE INDEX IF NOT EXISTS job_fetch ON pgboss.job (name text_pattern_ops, startAfter) WHERE state < 'active';
CREATE UNIQUE INDEX IF NOT EXISTS job_singletonOn ON pgboss.job (name, singletonOn) WHERE state < 'expired' AND singletonKey IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS job_singletonKeyOn ON pgboss.job (name, singletonOn, singletonKey) WHERE state < 'expired';
CREATE UNIQUE INDEX IF NOT EXISTS job_singletonKey ON pgboss.job (name, singletonKey) WHERE state < 'completed' AND singletonOn IS NULL AND NOT singletonKey LIKE '\_\_pgboss\_\_singleton\_queue%';
CREATE UNIQUE INDEX IF NOT EXISTS job_singleton_queue ON pgboss.job (name, singletonKey) WHERE state < 'active' AND singletonOn IS NULL AND singletonKey LIKE '\_\_pgboss\_\_singleton\_queue%';

INSERT INTO pgboss.version (version) VALUES (20) ON CONFLICT (version) DO NOTHING;
