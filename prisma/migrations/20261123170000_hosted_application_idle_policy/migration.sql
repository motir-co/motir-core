-- MOTIR-12107: a hosted application's IDLE POLICY — whether its production
-- release stays always on or suspends when idle, and after how many idle
-- seconds. Production passed a hard-coded `always_on` to the deploy port until
-- now, so every existing row is backfilled to `always_on`: the policy it really
-- runs today. A NEW application is seeded by its target's shape in the service
-- (suspend with an idle window, except an AWS container, which runs always on
-- only), never by this default.
--
-- Changing the policy of a serving application redeploys the serving release's
-- own commit and image as a NEW release, through the one release path, so the
-- provider's release history and the application's pointers stay in step (a
-- rollback still restores what it names). That release's cause is the new
-- `idle_policy` value of `hosted_release_cause`; nothing uses it in this
-- migration's transaction.
--
-- ADDITIVE: an enum value, an enum, a NOT NULL column whose default fills the
-- existing rows in the same statement, a nullable column, and a CHECK that the
-- seconds are set exactly when the mode is `suspend`. The table's RLS policy
-- (`hosted_application_workspace_or_system`) covers the new columns; no policy
-- changes.

-- AlterEnum
ALTER TYPE "hosted_release_cause" ADD VALUE 'idle_policy';

-- CreateEnum
CREATE TYPE "hosted_idle_mode" AS ENUM ('always_on', 'suspend');

-- AlterTable
ALTER TABLE "hosted_application"
  ADD COLUMN "idle_mode" "hosted_idle_mode" NOT NULL DEFAULT 'always_on',
  ADD COLUMN "idle_seconds" INTEGER;

ALTER TABLE "hosted_application"
  ADD CONSTRAINT "hosted_application_idle_seconds_iff_suspend"
  CHECK (
    ("idle_mode" = 'suspend' AND "idle_seconds" IS NOT NULL AND "idle_seconds" > 0)
    OR ("idle_mode" = 'always_on' AND "idle_seconds" IS NULL)
  );
