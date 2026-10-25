import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import { HOSTED_RUN_ADMIT_RETRY_MS, type HostedRunAdmitData } from '../types';

// A HELD HOSTED RUN'S ADMISSION (Story MOTIR-9363 · MOTIR-9381) — one pass per
// run of the queue, asking the fleet for a slot ONCE and deferring while the run
// is still held, until it boots, is cancelled, or meets a deferral that does not
// clear by itself (`hostedRunService.admit` says which).
//
// Emitted by the start path when its first try was held at the org's plan
// figure (`plan_cap`), an unreadable plan (`plan_unknown`), or a full
// agent-runner pool (`shard_capacity`, MOTIR-9425). It is NOT a poll
// aimed at a state change: each pass is one `reserve` under the fleet admission
// lock, so the run boots only when a slot has really been released, and a pass
// still held writes nothing. The interval bounds how soon it asks again.
//
// ⚠️ `retryPolicy: 'none'`, as `hosted-run/supervise`'s: `admit` never throws —
// a failure after the run opened ends the run — and `idempotency` keeps a double
// emit to ONE admission per run. A second pass that races one already booting
// finds the run's slot held and boots nothing.
export const hostedRunAdmit = defineJob(
  {
    id: 'hosted-run/admit',
    retryPolicy: 'none',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as HostedRunAdmitData;
    const result = await services.hostedRun.admit(data);
    if (result.kind === 'waiting') {
      deferRun(
        new Date(Date.now() + HOSTED_RUN_ADMIT_RETRY_MS),
        `hosted run ${data.dispatchRunId} is waiting for room: ${result.detail}`,
      );
    }
    return result;
  },
);
