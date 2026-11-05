-- MOTIR-10332 (Story MOTIR-10327) — the review agent's SOURCE and the bot-posting
-- switch (`docs/decisions/approval-gates.md` §12.10 and §12.16).
--
-- Both columns default to today's behaviour: a hosted review run answers the gate,
-- and posting is on (nothing posted before this, and nothing posts until the
-- bot-posting card ships). So no row needs a backfill; the defaults fill every
-- existing project. `project` already carries its tenancy and RLS policy.

CREATE TYPE "review_agent_source" AS ENUM ('hosted', 'own');

ALTER TABLE "project"
  ADD COLUMN "review_agent_source" "review_agent_source" NOT NULL DEFAULT 'hosted',
  ADD COLUMN "review_bot_posts_enabled" BOOLEAN NOT NULL DEFAULT true;
