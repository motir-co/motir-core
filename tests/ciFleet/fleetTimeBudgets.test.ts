import { describe, expect, it } from 'vitest';
import {
  FLEET_TIME_BUDGETS,
  pollWaitMs,
  ciRunnerBootService,
} from '@/lib/services/ciRunnerBootService';
import { RUNNER_JIT_REQUEST_TIMEOUT_MS } from '@/lib/github/runnerJitConfig';
import { ORCHESTRATOR_REQUEST_TIMEOUT_MS } from '@motir/orchestrator';

// THE FLEET'S TIME BUDGETS (MOTIR-2007; re-based by MOTIR-3418).
//
// ⚠️ THE CEILING THIS FILE WAS WRITTEN AGAINST NO LONGER EXISTS, and that is the
// change to read before the assertions. It used to IMPORT `maxDuration` from the
// serve route and compare every budget against it: supervision was allowed
// 3,600s inside an invocation capped at 300s, and nothing anywhere compared the
// two numbers. `maxDuration = 300` was a serverless platform's function timeout,
// and the whole stepped-supervisor shape existed to survive it.
//
// The job substrate is a long-lived worker process now (`scripts/worker.ts` on
// Fly), so there is no invocation to be killed and no ceiling to measure against.
// **What survives is the part that was never about the vendor**: the budgets are
// stated ONCE, in `FLEET_TIME_BUDGETS`, they are the CLIENTS' own numbers rather
// than copies of them, and they are ORDERED so that each deadline can fire before
// the next one does. Those are properties of the fleet, and they are what this
// file asserts now.
//
// ⚠️ DO NOT RE-INTRODUCE AN ABSOLUTE CEILING HERE. A hardcoded `300` would assert
// the constants against a number nothing enforces — which is worse than the gap
// it appears to close, because it reads as a live constraint.

describe('the fleet time budgets are stated once and stay internally consistent', () => {
  it('a step is shaped to a small, fixed amount of work — bounded on its own terms', () => {
    // The constraint MOTIR-2007 exists to make un-regressable. It used to be
    // expressed as `stepWorkBudgetMs <= maxDuration`, borrowing the platform's
    // number; with no platform number left, the property is stated directly. A
    // step does one mint or one provider call, so its budget stays in seconds —
    // and stays well under the whole run's, or the run is one step.
    expect(FLEET_TIME_BUDGETS.stepWorkBudgetMs).toBeGreaterThan(0);
    expect(FLEET_TIME_BUDGETS.stepWorkBudgetMs).toBeLessThan(FLEET_TIME_BUDGETS.jobTimeoutMs);
  });

  it('the RUN outlives any single step by a wide margin — the reason it is stepped at all', () => {
    // ⚠️ THE ASSERTION THAT LOOKS BACKWARDS, and still does. A supervised CI job
    // runs far longer than one step's budget. That was legal under the old
    // platform only because no single step spanned the invocation ceiling; it is
    // legal now because the worker simply stays up. Either way the tempting
    // non-fix was to shorten `jobTimeoutMs` to fit the step budget, which caps
    // every tenant's CI job at seconds. This line is what makes someone argue
    // with the comment before doing it.
    expect(FLEET_TIME_BUDGETS.jobTimeoutMs).toBeGreaterThan(
      FLEET_TIME_BUDGETS.stepWorkBudgetMs * 10,
    );
  });

  it('the deadlines are ordered: poll ≤ maxPoll < bootDeadline < idleTimeout < jobTimeout < reapAfter', () => {
    const b = FLEET_TIME_BUDGETS;
    // A boot deadline must be observable at poll granularity, or it is overshot
    // by a whole interval...
    expect(b.pollIntervalMs).toBeLessThanOrEqual(b.maxPollIntervalMs);
    expect(b.maxPollIntervalMs).toBeLessThan(b.bootDeadlineMs);
    // ...and must be able to fire before the job timeout does, or a container
    // that never started would be reported as one that ran over.
    expect(b.bootDeadlineMs).toBeLessThan(b.jobTimeoutMs);
    // THE IDLE TIMEOUT (MOTIR-11230) sits between the two: a runner that never
    // STARTED is a boot failure, not an idle one, so the boot deadline fires
    // first; and an idle runner must be retired long before the hour it used
    // to idle for. It must also be observable at poll granularity.
    expect(b.bootDeadlineMs).toBeLessThan(b.idleTimeoutMs);
    expect(b.maxPollIntervalMs).toBeLessThan(b.idleTimeoutMs);
    expect(b.idleTimeoutMs * 10).toBeLessThanOrEqual(b.jobTimeoutMs);
    // THE REAPER STAYS THE BACKSTOP. It may only ever meet containers
    // supervision has already given up on — never ones it is about to settle.
    expect(b.reapAfterMs).toBeGreaterThan(b.jobTimeoutMs);
  });

  it('a full-length job costs a bounded, sane number of poll steps', () => {
    // Each poll is a `step.sleep` + a `step.run`, i.e. two durable checkpoints.
    // At a flat 3s interval a 3,600s job would be 1,200 polls — 2,400 steps for
    // ONE CI job. The backoff is what keeps that in the low hundreds, so this
    // asserts the backoff is actually doing its job.
    let elapsed = 0;
    let polls = 0;
    while (
      elapsed < FLEET_TIME_BUDGETS.jobTimeoutMs &&
      polls < FLEET_TIME_BUDGETS.maxPollIterations
    ) {
      polls += 1;
      elapsed += pollWaitMs(polls);
    }
    expect(polls).toBeLessThan(200);
    // ...and the static ceiling is comfortably clear of what a real job needs,
    // so it can only ever bind on a clock that has gone wrong.
    expect(FLEET_TIME_BUDGETS.maxPollIterations).toBeGreaterThan(polls * 2);
  });

  it("RULE 3's inequality: the boot step's two deadlines SUM to less than one step's budget", () => {
    // ⚠️ THE ASSERTION MOTIR-2011 EXISTS FOR, and the one rule-2's shape
    // argument cannot make. `stepWorkBudgetMs` bounds what a step DOES — one
    // mint, one provision — which is a statement about the code. This bounds how
    // long those two calls may take, which is a statement about the CLOCK, and
    // an unbounded `fetch` satisfies the first while violating the second: a step
    // that makes one call still runs forever if the call does.
    const b = FLEET_TIME_BUDGETS;
    expect(b.mintDeadlineMs + b.containerCallDeadlineMs).toBeLessThanOrEqual(b.stepWorkBudgetMs);
  });

  it('the deadlines are the CLIENTS OWN numbers, not a copy of them', () => {
    // A budget that restates a client's timeout asserts the constants against
    // themselves and goes stale the first time a client is tuned. This is the
    // discipline the removed `maxDuration` import used to demonstrate, applied
    // where it still has a real second source to read from.
    expect(FLEET_TIME_BUDGETS.mintDeadlineMs).toBe(RUNNER_JIT_REQUEST_TIMEOUT_MS);
    expect(FLEET_TIME_BUDGETS.containerCallDeadlineMs).toBe(ORCHESTRATOR_REQUEST_TIMEOUT_MS);
    // Both must be real bounds — a zero or a NaN would satisfy every inequality
    // above while meaning "no deadline at all".
    expect(FLEET_TIME_BUDGETS.mintDeadlineMs).toBeGreaterThan(0);
    expect(FLEET_TIME_BUDGETS.containerCallDeadlineMs).toBeGreaterThan(0);
  });

  it('a POLL and a SETTLE step also fit — the two other steps that touch the provider', () => {
    // A poll is one provider read; a settle is a read plus a destroy plus a
    // de-registration. Enumerated per step rather than globally, because rule 3
    // is about the SLOWEST step, and the slowest one here is not the boot.
    const b = FLEET_TIME_BUDGETS;
    expect(b.containerCallDeadlineMs).toBeLessThanOrEqual(b.stepWorkBudgetMs);
    expect(b.containerCallDeadlineMs * 2 + b.mintDeadlineMs).toBeLessThanOrEqual(
      b.stepWorkBudgetMs,
    );
  });

  it('the service exposes the three bounded phases the job steps, and no long-running entrypoint of its own', () => {
    // A structural statement about the SURFACE: the job's supervision is
    // composed from these three, each of which returns after a fixed amount of
    // work. `runIntent` survives as the in-process composition for tests and
    // scripts (see its doc comment) and is asserted out of the handler in
    // `tests/jobs/ci-runner-fleet.test.ts`.
    expect(typeof ciRunnerBootService.bootIntent).toBe('function');
    expect(typeof ciRunnerBootService.pollOnce).toBe('function');
    expect(typeof ciRunnerBootService.settleSupervision).toBe('function');
    // The MOTIR-2002 memo entrypoint is GONE — the shape fix subsumed it.
    expect('superviseOnce' in ciRunnerBootService).toBe(false);
  });
});
