-- MOTIR-9276 (Story MOTIR-9270): an account of the fleet can be an AWS account.
--
-- Expand-only: one enum member and no row change. Nothing in this file uses the
-- new value, which is what lets Postgres (>= 12) run `ADD VALUE` inside the
-- migration's transaction; the CHECK that names it is the next migration.
ALTER TYPE "fleet_shard_provider" ADD VALUE IF NOT EXISTS 'aws';
