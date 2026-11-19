-- The capacity a CI runner's container ran on (MOTIR-11716): `spot` when the
-- launch asked for Spot and got it, `on_demand` otherwise. Written with the
-- container handle at boot. ADDITIVE and NULLABLE: every existing row stays NULL
-- (booted before Spot existed), nothing is backfilled, and no policy changes —
-- the table's RLS covers the new column.
CREATE TYPE "ci_runner_capacity" AS ENUM ('spot', 'on_demand');

ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN "capacity" "ci_runner_capacity";
