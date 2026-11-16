import { vi } from 'vitest';
import * as jobDispatcher from '@/lib/jobs/engine/dispatcher';
import type { AgentInstanceBootData, AgentInstanceUpdateSettleData } from '@/lib/jobs/types';
import { AGENT_BOOT_POLL_MS, AGENT_UPDATE_POLL_MS } from '@/lib/agentInstances/config';
import { agentInstanceBootService } from '@/lib/services/agentInstanceBootService';
import {
  agentInstanceClock,
  agentInstanceLifecycleService,
} from '@/lib/services/agentInstanceLifecycleService';
import { adminDb } from './adminDb';

// THE BOOT DRIVER, IN PROCESS (Story MOTIR-7393 · MOTIR-7404). Since the cutover a
// create or wake answers at `starting` / `waking` and hands the boot to the
// `agent-instance/boot` job. A test has no job worker, so this spy on the emit
// seam stands in for one: it runs the job's passes inline, one per
// `AGENT_BOOT_POLL_MS` of the virtual clock, for as long as the request used to
// wait inline (20 s) — so a suite that expects a create to come back `running`
// still does, and a boot whose machine never starts is left deferred for the
// test to drive with {@link driveBoot}, exactly as the old sweep settled it.
// Every other event passes through to the real dispatcher.
//
// THE UPDATE DRIVER, IN PROCESS (MOTIR-8954) — the same stand-in for the
// `agent-instance/update-settle` job: an Update (or a wake applying a pinned one)
// answers at `updating`, and this runs the driver's passes inline, one per
// `AGENT_UPDATE_POLL_MS`, for the same 20-second window — so a suite whose fake
// machine starts at once still sees `running`, and a test that wants the answer
// itself turns {@link updateDriver}.inline off and runs the job's passes itself
// (`agentInstanceUpdateSettle.test.ts`).

/** The lease holder the in-process driver passes as `ctx.runId`. */
export const INLINE_BOOT_HOLDER = 'inline-worker';
const INLINE_WINDOW_MS = 20_000;

export const bootDriver = {
  /** Off → a boot event is only RECORDED, so a test sees the answer at `starting`. */
  inline: true,
  sent: [] as AgentInstanceBootData[],
};

export const updateDriver = {
  /** Off → an update event is only RECORDED, so a test sees the answer at `updating`. */
  inline: true,
  sent: [] as AgentInstanceUpdateSettleData[],
};

export function installInlineBootDriver(): void {
  bootDriver.inline = true;
  bootDriver.sent = [];
  updateDriver.inline = true;
  updateDriver.sent = [];
  const original = jobDispatcher.dispatchEventToEngine;
  vi.spyOn(jobDispatcher, 'dispatchEventToEngine').mockImplementation(async (name, data, opts) => {
    if (name === 'agent-instance/boot') {
      await deliverBootEvent(data as AgentInstanceBootData);
    } else if (name === 'agent-instance/update-settle') {
      await deliverUpdateEvent(data as AgentInstanceUpdateSettleData);
    } else {
      return original(name, data, opts);
    }
    return { eventId: null, enqueued: [], alreadyEnqueued: [], coalesced: [], failed: [] };
  });
}

/** What the in-process worker does with one `agent-instance/update-settle` event. */
export async function deliverUpdateEvent(event: AgentInstanceUpdateSettleData): Promise<void> {
  updateDriver.sent.push(event);
  if (!updateDriver.inline) return;
  let waited = 0;
  for (;;) {
    const verdict = await agentInstanceLifecycleService.driveUpdate(event.instanceId);
    if (verdict.next === 'done' || waited >= INLINE_WINDOW_MS) return;
    await agentInstanceClock.sleep(AGENT_UPDATE_POLL_MS);
    waited += AGENT_UPDATE_POLL_MS;
  }
}

/**
 * What the in-process worker does with one `agent-instance/boot` event — for a
 * suite that mocks `sendEvent` itself and so never reaches the dispatcher spy.
 */
export async function deliverBootEvent(event: AgentInstanceBootData): Promise<void> {
  bootDriver.sent.push(event);
  if (!bootDriver.inline) return;
  let waited = 0;
  for (;;) {
    const verdict = await agentInstanceBootService.advance(
      event.instanceId,
      event.attempt,
      INLINE_BOOT_HOLDER,
    );
    if (verdict.next === 'done' || waited >= INLINE_WINDOW_MS) return;
    await agentInstanceClock.sleep(AGENT_BOOT_POLL_MS);
    waited += AGENT_BOOT_POLL_MS;
  }
}

/**
 * One pass of the driver over the agent's current attempt, as the job's next
 * delivery would make it: `pending` while the boot waits, else where it moved
 * the agent (`running` / `failed`), or `noop` when it moved nothing — no open
 * boot to drive, or a delete that got there first.
 */
export async function driveBoot(
  instanceId: string,
): Promise<'running' | 'failed' | 'pending' | 'noop'> {
  const current = await adminDb.agentInstanceBootAttempt.findFirst({
    where: { agentInstanceId: instanceId },
    orderBy: { attempt: 'desc' },
  });
  if (!current || current.endedAt) return 'noop';
  const verdict = await agentInstanceBootService.advance(
    instanceId,
    current.attempt,
    INLINE_BOOT_HOLDER,
  );
  if (verdict.next === 'defer') return 'pending';
  const agent = await adminDb.agentInstance.findUniqueOrThrow({ where: { id: instanceId } });
  return agent.state === 'running' ? 'running' : agent.state === 'failed' ? 'failed' : 'noop';
}
