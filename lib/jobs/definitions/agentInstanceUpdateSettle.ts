import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import type { AgentInstanceUpdateSettleData } from '../types';

// THE UPDATE DRIVER (MOTIR-8954; `docs/decisions/agent-image-update.md` Q6). One
// run per image update of an agent, sent by the Update — or the wake that applies
// a pinned update — once the machine has been asked to move. Each pass asks the
// lifecycle to settle the update (`agentInstanceLifecycleService.driveUpdate`),
// which re-reads the agent and its machine from the top: the agent row and the
// machine ARE the durable state, as `deferRun` requires, and nothing is
// remembered between passes. While the new image is still pulling or starting,
// the pass DEFERS `AGENT_UPDATE_POLL_MS`, so the update lands within one poll of
// its liveness check passing — not at the sweep's ten-minute mark, which is
// where every update slower than the old 20-second inline wait used to land.
//
// ⚠️ `retryPolicy: 'idempotent'`: the settle is a guarded compare-and-set on the
// agent's state, so a pass that threw mid-way is safe to run again — a second
// settle of a settled update is a `noop`. And the driver is bounded: past
// `UPDATE_SWEEP_AFTER_MS` it stops deferring and leaves the update to the sweep.
export const agentInstanceUpdateSettle = defineJob(
  {
    id: 'agent-instance/update-settle',
    retryPolicy: 'idempotent',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as AgentInstanceUpdateSettleData;
    const verdict = await services.agentInstanceLifecycle.driveUpdate(data.instanceId);
    if (verdict.next === 'defer') deferRun(verdict.deferUntil, 'the agent is updating');
    return verdict.result;
  },
);
