-- MOTIR-10500: a per-claim FENCING TOKEN on the queue row. `claimDueRuns`
-- increments it on every claim and every settle write matches it, so a pass
-- whose lease was reclaimed — even by the SAME worker, which a `claimed_by`
-- fence cannot tell apart — writes nothing over the claim that replaced it.
-- A constant default is a catalogue-only change (no table rewrite); existing
-- rows start at 0 and their next claim takes 1.
ALTER TABLE "job_queue" ADD COLUMN "claim_token" INTEGER NOT NULL DEFAULT 0;
