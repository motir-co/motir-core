-- MOTIR-9581 (Story MOTIR-9365): the owning organisation of an `org_owned`
-- account, the times it entered each state, and AWS uniqueness per fleet kind.
--
-- Expand-only: four nullable columns, a foreign key, two indexes and a CHECK no
-- existing row can fail (no row is `org_owned` and none names an owner).

ALTER TABLE "fleet_shard" ADD COLUMN "owner_organization_id" TEXT;
ALTER TABLE "fleet_shard" ADD COLUMN "quota_requested_at" TIMESTAMP(3);
ALTER TABLE "fleet_shard" ADD COLUMN "granted_at" TIMESTAMP(3);
ALTER TABLE "fleet_shard" ADD COLUMN "live_at" TIMESTAMP(3);

-- Restrict: an organisation with accounts of its own is never deleted from under
-- them. Closing an AWS account is irreversible and a person's decision.
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_owner_organization_id_fkey"
  FOREIGN KEY ("owner_organization_id") REFERENCES "organization"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- An owner exactly on an `org_owned` account: a shared account or a spare has
-- none, and an own account always names its organisation.
ALTER TABLE "fleet_shard" ADD CONSTRAINT "fleet_shard_owner_iff_org_owned_check"
  CHECK (("role" = 'org_owned') = ("owner_organization_id" IS NOT NULL));

-- One AWS account serves a fleet kind once. The merged indexer + agent hoster
-- account is ONE AWS account written as two rows, one per kind; a Fly row has a
-- NULL account id, which a unique index never compares.
CREATE UNIQUE INDEX "fleet_shard_aws_account_id_fleet_kind_key"
  ON "fleet_shard" ("aws_account_id", "fleet_kind");

-- An organisation's own accounts.
CREATE INDEX "fleet_shard_owner_organization_id_idx"
  ON "fleet_shard" ("owner_organization_id");
