-- A plan being approved reads as being approved (Bug MOTIR-9006). Approve used to
-- materialize inside ONE long transaction and write `approved` at its end, so every
-- other reader saw `planned` until the commit. The claim now writes `approving` in a
-- short transaction of its own, and `approving_at` is both its clock (the
-- stalled-approval sweep releases a claim older than its bound) and its token.
--
-- Additive: no existing row is `approving`, and the column is nullable. The plan
-- table's RLS policies are unchanged.
ALTER TYPE "plan_status" ADD VALUE IF NOT EXISTS 'approving' AFTER 'planned';

ALTER TABLE "plan" ADD COLUMN "approving_at" TIMESTAMP(3);
