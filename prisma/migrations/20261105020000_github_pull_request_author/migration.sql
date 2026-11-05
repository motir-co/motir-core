-- The pull request's author on the host (Story MOTIR-10327 · MOTIR-10340). Nullable and not
-- backfilled: a row mirrored before these columns existed reads its author as unknown, and
-- the next `pull_request` delivery fills it in. Additive only — no reader of the previous
-- image selects these columns, so this is safe under fly's migrate-before-rollout.
ALTER TABLE "github_pull_request" ADD COLUMN     "author_github_user_id" TEXT,
ADD COLUMN     "author_login" TEXT;
