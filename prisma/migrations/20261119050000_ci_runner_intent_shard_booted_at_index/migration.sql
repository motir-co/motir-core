-- The Fleet status page's CI Spot read (MOTIR-11729): the CI runners each
-- account booted in the last 7 days, counted by capacity and by Spot
-- interruption. Without it the per-account count reads every intent the account
-- ever had (`[fleet_shard_id]` alone). A plain index: no column, no policy and
-- no row changes.
CREATE INDEX "ci_runner_provisioning_intent_fleet_shard_id_booted_at_idx"
  ON "ci_runner_provisioning_intent"("fleet_shard_id", "booted_at");
