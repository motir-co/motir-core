-- MOTIR-9456 (Story MOTIR-9362): an account of a fleet kind can be its Motir
-- SPARE — active and running work, but only Motir's own exempt orgs' work.
--
-- Expand-only: one enum member and no row change. Nothing in this file uses the
-- new value, which is what lets Postgres (>= 12) run `ADD VALUE` inside the
-- migration's transaction; the index that names it is the next migration.
ALTER TYPE "fleet_shard_role" ADD VALUE IF NOT EXISTS 'spare';
