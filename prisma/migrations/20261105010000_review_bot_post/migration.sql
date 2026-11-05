-- Story MOTIR-10327 · MOTIR-10335 — what Motir's GitHub App bot POSTED for each agent
-- review verdict on each pull request (`approval-gates.md` §12 rules 7 and 8). The unique
-- (pull request, verdict record) pair is the post job's idempotency record.

-- CreateEnum
CREATE TYPE "review_bot_post_kind" AS ENUM ('request_changes', 'comment');

-- CreateEnum
CREATE TYPE "review_bot_post_state" AS ENUM ('posted', 'dismissed');

-- CreateTable
CREATE TABLE "review_bot_post" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "review_verdict_record_id" TEXT NOT NULL,
    "github_pull_request_id" TEXT NOT NULL,
    "kind" "review_bot_post_kind" NOT NULL,
    "state" "review_bot_post_state" NOT NULL DEFAULT 'posted',
    "github_review_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_bot_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_bot_post_workspace_id_idx" ON "review_bot_post"("workspace_id");

-- CreateIndex
CREATE INDEX "review_bot_post_project_id_idx" ON "review_bot_post"("project_id");

-- CreateIndex
CREATE INDEX "review_bot_post_work_item_id_state_idx" ON "review_bot_post"("work_item_id", "state");

-- CreateIndex
CREATE INDEX "review_bot_post_review_verdict_record_id_idx" ON "review_bot_post"("review_verdict_record_id");

-- CreateIndex
CREATE INDEX "review_bot_post_github_review_id_idx" ON "review_bot_post"("github_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_bot_post_github_pull_request_id_review_verdict_recor_key" ON "review_bot_post"("github_pull_request_id", "review_verdict_record_id");

-- AddForeignKey
ALTER TABLE "review_bot_post" ADD CONSTRAINT "review_bot_post_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bot_post" ADD CONSTRAINT "review_bot_post_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bot_post" ADD CONSTRAINT "review_bot_post_work_item_id_fkey" FOREIGN KEY ("work_item_id") REFERENCES "work_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bot_post" ADD CONSTRAINT "review_bot_post_review_verdict_record_id_fkey" FOREIGN KEY ("review_verdict_record_id") REFERENCES "review_verdict_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bot_post" ADD CONSTRAINT "review_bot_post_github_pull_request_id_fkey" FOREIGN KEY ("github_pull_request_id") REFERENCES "github_pull_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenancy: the row carries its own workspace and its own policy (RLS does not traverse
-- FKs).
ALTER TABLE "review_bot_post" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "review_bot_post" FORCE ROW LEVEL SECURITY;

CREATE POLICY "review_bot_post_active_workspace" ON "review_bot_post"
  FOR ALL
  USING ("workspace_id" = current_setting('app.workspace_id', true))
  WITH CHECK ("workspace_id" = current_setting('app.workspace_id', true));
