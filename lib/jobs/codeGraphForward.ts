import { sendSystemEvent } from './sendEvent';
import type { CodeGraphForwardData } from './types';

// THE CODE-GRAPH FORWARD ENQUEUE (MOTIR-12055 · story MOTIR-11870) — the one door
// the pull-request and push webhooks and the one-time open-pull-request report use
// to relay a branch's state to motir-codegraph. The job is
// `system.code-graph-forward` (`definitions/codeGraphForward.ts`).
//
// ⚠️ IT NEVER THROWS INTO ITS CALLER. A webhook delivery must answer its ack whatever
// happens here. `sendSystemEvent` already swallows and logs a transport failure;
// this door also catches whatever else the enqueue throws (a bad argument, an engine
// refusal) and logs it, because a forward that is lost is re-sent by the next event
// for the branch, and an ack that fails makes the host re-deliver everything else.

/** Enqueue ONE forward, carrying exactly `event`. Resolves whatever happens. */
export async function enqueueCodeGraphForward(event: CodeGraphForwardData): Promise<void> {
  const kind = (event as { kind?: unknown } | null | undefined)?.kind;
  if (kind !== 'pull_request_state' && kind !== 'retire') {
    console.error(`[code-graph-forward] refused to enqueue a forward of kind ${String(kind)}`);
    return;
  }
  try {
    await sendSystemEvent('system.code-graph-forward', event);
  } catch (err) {
    console.error(
      '[code-graph-forward] could not enqueue a forward:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
