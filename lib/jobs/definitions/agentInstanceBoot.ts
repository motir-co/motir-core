import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import type { AgentInstanceBootData } from '../types';

// THE BOOT DRIVER (Story MOTIR-7393 · MOTIR-7398; `docs/decisions/agent-instances.md`
// AMENDMENT 6 §3). One run per boot attempt of an agent, sent by the create or
// wake that opened it. Each pass reads the agent and the attempt's step rows from
// the top (`agentInstanceBootService.advance`) — those rows are the durable state,
// as `deferRun` requires — does what is possible now, and DEFERS while the
// machine is coming up.
//
// THE LEASE HOLDER IS THIS RUN (`ctx.runId`): a defer keeps the same queue row,
// so a deferred pass renews the lease it already holds. A second delivery of the
// same attempt cannot take a live lease and ends at once, writing nothing.
//
// ⚠️ `retryPolicy: 'none'`: the job re-enters itself by `deferRun`, and a pass
// that throws leaves its lease to expire — the recovery is the sweep resending
// the event for that attempt, whose new holder resumes at the step in progress.
// A blind retry would only race that.
export const agentInstanceBoot = defineJob(
  {
    id: 'agent-instance/boot',
    retryPolicy: 'none',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as AgentInstanceBootData;
    const verdict = await services.agentInstanceBoot.advance(
      data.instanceId,
      data.attempt,
      ctx.runId,
    );
    if (verdict.next === 'defer') {
      // A boot waiting for room in the pool says so (MOTIR-9474).
      deferRun(
        verdict.deferUntil,
        verdict.waiting ? 'the agent is waiting for room' : 'the agent machine is starting',
      );
    }
    return verdict.next;
  },
);
