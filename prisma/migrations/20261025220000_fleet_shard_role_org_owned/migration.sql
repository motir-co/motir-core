-- MOTIR-9581 (Story MOTIR-9365): an account can belong to ONE Host organisation
-- — an `org_owned` account, outside every shared pool.
--
-- Expand-only: one enum member and no row change. Nothing in this file uses the
-- new value, which is what lets Postgres (>= 12) run `ADD VALUE` inside the
-- migration's transaction; the CHECK that names it is the next migration.
ALTER TYPE "fleet_shard_role" ADD VALUE IF NOT EXISTS 'org_owned';
