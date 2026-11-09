-- THE MERGEABILITY READING A PUSH ANSWERED (Bug MOTIR-10791).
--
-- `mergeable_state` / `mergeable_state_head_sha` hold ONE reading, and a push
-- replaces it (`unknown` at the new head, then the host's answer there). So a
-- conflict, or an out-of-date base, that a push was made to answer was gone from
-- the pull request's row as soon as the push landed, and the card's stored To fix
-- answer was the only other record of it. GitHub delivers a push's checks one at a
-- time and in no order: a quick check finishing green at the new head, before
-- anything running is recorded there, reads the head green and stores nothing to
-- fix, and the card lost its Fixing tag for the rest of its CI.
--
-- These two columns keep the last DECIDED reading taken at an EARLIER head. Both
-- writers (`setMergeability`, `markMergeabilityPending`) carry the stored pair here
-- in the same statement when the new reading is about a different commit and the
-- stored one was decided (not null, not `unknown`). Nullable, no backfill: a row
-- whose stored reading is at another head already says what that head was.

ALTER TABLE "github_pull_request"
    ADD COLUMN "previous_mergeable_state" TEXT,
    ADD COLUMN "previous_mergeable_state_head_sha" TEXT;
