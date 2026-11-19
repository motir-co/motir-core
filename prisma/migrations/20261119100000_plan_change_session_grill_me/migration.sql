-- MOTIR-11801 — the GRILL ME switch is stored on the planning session (Story
-- MOTIR-11799), so a reload, another tab and a reopened conversation read the same
-- value, and every job the session submits carries it to the planner.
--
-- Three columns on an existing table: the table's own `FOR ALL` workspace policy
-- (`plan_change_session_active_workspace`) already covers them, so no policy changes.
-- Every existing session reads OFF, exactly as it did while the choice lived in the
-- browser alone.

-- AlterTable
ALTER TABLE "plan_change_session" ADD COLUMN     "grill_me" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "grill_me_changed_at" TIMESTAMP(3),
ADD COLUMN     "grill_me_changed_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "plan_change_session" ADD CONSTRAINT "plan_change_session_grill_me_changed_by_id_fkey" FOREIGN KEY ("grill_me_changed_by_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
