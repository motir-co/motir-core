-- MOTIR-9633 — an automatic hosted start refused for NO AGENT-RUN CAPACITY is recorded,
-- never retried: `no_capacity` joins both skip-reason enums.
--
-- `hostedRunService.preflight` refuses a launch whose model has no agent-run capacity
-- right now (`HostedRunNoCapacityError`, MOTIR-9628). Gate resume and the design auto
-- re-run start hosted runs with no person pressing a button, and until now an error
-- they could not map was rethrown so their jobs retried it. Like out of credits, it is
-- a reason a person can read on the To resume entry and the design card's line, and
-- start the run themselves once capacity returns.
--
-- ⚠️ NO RLS CLAUSE HERE, AND THAT IS NOT AN OMISSION. RLS is a per-TABLE policy; this
-- migration creates no table and touches no row.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent, so a re-applied migration is a no-op.

ALTER TYPE "gate_resume_skip_reason" ADD VALUE IF NOT EXISTS 'no_capacity';
ALTER TYPE "design_auto_rerun_skip_reason" ADD VALUE IF NOT EXISTS 'no_capacity';
