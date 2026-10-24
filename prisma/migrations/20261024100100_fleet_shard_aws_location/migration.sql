-- MOTIR-9276 (Story MOTIR-9270): where an `aws` account's runners boot — its
-- member account id and the region its tagged network is in. The per-account
-- orchestrator builds its EC2 client for that region.
--
-- Expand-only: two nullable columns, and a CHECK no existing row can fail (every
-- row is `fly` until add-shard writes the first `aws` one, MOTIR-9278).
ALTER TABLE "fleet_shard" ADD COLUMN "aws_account_id" TEXT;
ALTER TABLE "fleet_shard" ADD COLUMN "aws_region" TEXT;

-- An AWS account names its account id and region, as a Fly account names its app.
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_aws_location_check"
  CHECK (
    "provider" <> 'aws'
    OR ("aws_account_id" IS NOT NULL AND "aws_region" IS NOT NULL)
  );
