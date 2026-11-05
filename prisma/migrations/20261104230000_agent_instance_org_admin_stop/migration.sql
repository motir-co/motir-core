-- An organisation owner or admin can stop the org's agent instances from the
-- org's Fleet page (`docs/decisions/agent-instances.md` §8 AMENDMENT 8), so a
-- closed interval needs a reason that says so rather than borrowing the
-- platform's `admin_stop` or `credits`.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy;
-- this migration creates no table and touches no row. `agent_instance_interval`
-- keeps the policies it was created with.
--
-- `ADD VALUE IF NOT EXISTS` is additive and idempotent, so a database already
-- holding intervals is untouched and a re-applied migration is a no-op. Postgres
-- appends the value at the end of the enum's sort order; nothing orders
-- intervals by their end reason, so the position carries no meaning.

ALTER TYPE "agent_instance_interval_end_reason" ADD VALUE IF NOT EXISTS 'org_admin_stop';
