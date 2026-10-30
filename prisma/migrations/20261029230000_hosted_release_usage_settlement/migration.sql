-- A production release's USAGE SETTLEMENT (Story MOTIR-9797 · Subtask
-- MOTIR-10034): the end of the last running-time window added to its
-- `usage_seconds`, so the next settle reads only the time after it, and the
-- deploy port's `providerRef` for the release (a Fly Machine id), which the
-- port's `usageSince` needs and `provider_release_id` alone does not carry.
-- ADDITIVE, nullable columns; the table's RLS (`hosted_release_workspace_or_system`)
-- already covers them.

-- AlterTable
ALTER TABLE "hosted_release" ADD COLUMN     "provider_ref" TEXT,
ADD COLUMN     "usage_settled_until" TIMESTAMPTZ(3);
