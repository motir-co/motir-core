'use server';

import { revalidatePath } from 'next/cache';
import { POST as postBugKeyRemove } from '@/app/api/platform/planner-findings/[findingId]/bug-key/remove/route';
import { POST as postBugKey } from '@/app/api/platform/planner-findings/[findingId]/bug-key/route';
import type { RawPlannerFinding } from '@/lib/ai/motirAiClient';

/**
 * The record page's ONE write — each finding's own planning-bug key, linked and
 * removed from that finding's row (Story MOTIR-11455 · MOTIR-11463, design
 * MOTIR-11591). Two Server Actions, each POSTing `{ key }` to the platform route
 * the key rule settled (MOTIR-11590):
 *
 *   linkKey   → POST /api/platform/planner-findings/[findingId]/bug-key
 *   removeKey → POST /api/platform/planner-findings/[findingId]/bug-key/remove
 *
 * ⚠️ THE ROUTE IS THE CONTRACT, so the action posts to it rather than calling
 * the service beside it: the gate, the body schema, the level, the audit row and
 * the refusal map all stay the route's, and the row draws exactly what the route
 * answered. The post is made IN-PROCESS — the route's own `POST` handler is
 * called with a `Request` — rather than over the network: a loopback fetch would
 * need the deployment's own origin and a forwarded session cookie, while the
 * handler, called inside this action, reads the same session the action runs
 * under (no bearer header, so the gate takes the console session).
 *
 * ⚠️ A RESULT, NOT A THROW (the `actions.ts` rule): a thrown error reaches the
 * browser as a stripped digest, and the row draws a different line per refusal.
 *
 * ⚠️ SUCCESS REVALIDATES the console layout, so the record page re-reads the
 * record and the row's key renders from the store, never from a patched set.
 * A refusal revalidates nothing: every other row stays exactly as it was.
 *
 * This module is separate from `../actions.ts` (the triage write path) so the
 * record page's module graph reaches no other action.
 */

export type FindingKeyRefusal = 'not_a_work_item' | 'record_open';

export type FindingKeyResult =
  | { ok: true; finding: { id: string; bugKey: string | null } }
  | { ok: false; code: 'REFUSED'; reason: FindingKeyRefusal }
  | { ok: false; code: 'INVALID' | 'GONE' | 'FAILED' };

type Handler = typeof postBugKey;

/** A placeholder origin: the handlers read the path params and the body, never the host. */
const INTERNAL_ORIGIN = 'http://motir-core.internal';

async function post(
  handler: Handler,
  path: string,
  findingId: string,
  key: string,
  act: string,
): Promise<FindingKeyResult> {
  let res: Response;
  try {
    res = await handler(
      new Request(
        `${INTERNAL_ORIGIN}/api/platform/planner-findings/${encodeURIComponent(findingId)}${path}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        },
      ),
      { params: Promise.resolve({ findingId }) },
    );
  } catch (err) {
    // The route re-throws what its map does not know: a defect, drawn as the
    // unexpected failure with Try again.
    console.error(`[admin] planner finding key ${act} failed`, { findingId }, err);
    return { ok: false, code: 'FAILED' };
  }
  const body = (await res.json().catch(() => null)) as {
    code?: string;
    reason?: string;
    finding?: RawPlannerFinding;
  } | null;

  if (res.ok && body?.finding && typeof body.finding.id === 'string') {
    revalidatePath('/admin/planner-findings', 'layout');
    return { ok: true, finding: { id: body.finding.id, bugKey: body.finding.bugKey ?? null } };
  }
  if (
    body?.code === 'FINDING_KEY_REFUSED' &&
    (body.reason === 'not_a_work_item' || body.reason === 'record_open')
  ) {
    return { ok: false, code: 'REFUSED', reason: body.reason };
  }
  if (res.status === 400 && body?.code === 'INVALID_REQUEST') return { ok: false, code: 'INVALID' };
  if (res.status === 404) return { ok: false, code: 'GONE' };
  console.error(`[admin] planner finding key ${act} was not saved`, {
    findingId,
    status: res.status,
    code: body?.code,
  });
  return { ok: false, code: 'FAILED' };
}

/** Link (set or replace) a finding's planning-bug key. */
export async function linkKey(findingId: string, key: string): Promise<FindingKeyResult> {
  return post(postBugKey, '/bug-key', findingId, key, 'link');
}

/** Remove a finding's planning-bug key; `key` is the one the row shows (a stale-tab guard). */
export async function removeKey(findingId: string, key: string): Promise<FindingKeyResult> {
  return post(postBugKeyRemove, '/bug-key/remove', findingId, key, 'remove');
}
