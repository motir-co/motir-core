-- MOTIR-10819: the catch-up sweep re-dispatches a repository whose claimed index
-- or refresh run ended terminal for a reason other than size. These two columns
-- bound it: how many automatic re-dispatches it made since the last successful
-- index, and when it made the last one. Every existing row starts at zero.
ALTER TABLE "github_repo" ADD COLUMN "index_retry_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "index_retry_dispatched_at" TIMESTAMP(3);
