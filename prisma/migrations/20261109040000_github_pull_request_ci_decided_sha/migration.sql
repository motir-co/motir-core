-- THE HEAD WHOSE WHOLE CHECK SET CI DECIDED (Bug MOTIR-10797).
--
-- A card whose fix went green went back onto To fix, Fixing, when a check STARTED
-- later at the same head (a workflow on `labeled` or a review, a third-party suite,
-- a re-run). The To fix rebuild (MOTIR-10747 · MOTIR-10791) cannot tell a head CI
-- has decided from the quick green on a push it is meant to keep Fixing: both are a
-- set of terminal rows. Only the HOST knows whether that set was whole, and the
-- check-set reconcile is where Motir asks it.
--
-- This column records the head at which the host confirmed it: every check run and
-- workflow run reported there finished, and no recorded row there still running.
-- Written only while the commit is the pull request's head. Nullable, no backfill:
-- null means "never confirmed", and the readers fall back to the check rows' times.

ALTER TABLE "github_pull_request"
    ADD COLUMN "ci_decided_sha" TEXT;
