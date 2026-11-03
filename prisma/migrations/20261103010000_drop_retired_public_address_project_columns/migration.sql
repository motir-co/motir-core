-- MOTIR-10280 — drop the retired `public_address.project_id` and
-- `project.primary_address_id` columns, the third and last release of their
-- removal (docs/decisions/delivery-reader-migration.md §6a).
--
-- 1. MOTIR-9523 made a customer domain a workspace asset bound to an
--    application, moved every reader and writer off both columns, dropped their
--    foreign keys and indexes, rewrote `public_address_public_read` so it no
--    longer reads `project_id`, and marked both fields `@ignore`
--    (20261030150000_customer_domain_workspace_scope), keeping the columns for
--    the build still serving during that rollout.
-- 2. That release reached every machine: motir-core #3885 (3ea5891) finished
--    `Deploy to Fly` and `AWS deploy` on 2026-11-02, and the next release
--    (3dd1452) deployed over it to both at 00:25Z and 00:13Z on 2026-11-03, so
--    nothing serving selects either column.
-- 3. This release drops them.
--
-- @client-stopped-selecting: MOTIR-9523
--
-- `IF EXISTS` keeps it idempotent against a database a repair already cleaned.
ALTER TABLE "public_address" DROP COLUMN IF EXISTS "project_id";

ALTER TABLE "project" DROP COLUMN IF EXISTS "primary_address_id";
