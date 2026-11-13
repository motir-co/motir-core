-- A CI runner of the install's own org boots on the install fleet, in core's own
-- account (MOTIR-11232). The install fleet has no `fleet_shard` row, so an
-- install-fleet intent keeps `fleet_shard_id` NULL (MOTIR-10858) and this flag
-- says where its container lives. Every existing row was booted on a pool
-- account or the process-wide fleet, so the default is the truth for all of them.

-- AlterTable
ALTER TABLE "ci_runner_provisioning_intent" ADD COLUMN "install_fleet" BOOLEAN NOT NULL DEFAULT false;
