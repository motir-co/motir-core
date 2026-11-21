import { randomUUID } from 'node:crypto';

// WHICH GATE A REVIEW RUN ANSWERS, spelled on the run itself (Story MOTIR-1626 ·
// MOTIR-6820; `hosted-agent-run.md` §8.1, `approval-gates.md` §12.6).
//
// ⚠️ THE GATE ID RIDES THE RUN'S IDEMPOTENCY KEY, AND THAT IS THE RECORD. A review run is
// opened by the server, once per REQUEST for a gate — the raise's, or one *Review again*
// press's — and the request's own key is the run's `idempotencyKey`:
//
//   agent-review:<gateId>:raise              the gate's raise (MOTIR-6819's emit)
//   agent-review:<gateId>:again:<uuid>       one *Review again* press
//
// So a redelivered event opens nothing twice (`dispatch_run`'s
// `(workspace_id, idempotency_key)` unique), a *Review again* is a NEW attempt with a key
// of its own, and "the review running for this gate" is a prefix read — without a column
// on `dispatch_run` that only one command would ever fill. The run's `run_opened` event
// carries the gate id and version as well, for a reader of the run page.

const PREFIX = 'agent-review:';

/** Every review run of `gateId` has a key starting with this. */
export function reviewRunKeyPrefix(gateId: string): string {
  return `${PREFIX}${gateId}:`;
}

/** The request key of the gate's RAISE — what MOTIR-6819's emit carries. */
export function reviewRaiseKey(gateId: string): string {
  return `${reviewRunKeyPrefix(gateId)}raise`;
}

/** A fresh request key for ONE *Review again* press. */
export function reviewAgainKey(gateId: string): string {
  return `${reviewRunKeyPrefix(gateId)}again:${randomUUID()}`;
}

/** The gate a review run's idempotency key names, or null for any other key. */
export function gateIdOfReviewRunKey(key: string | null | undefined): string | null {
  if (!key?.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  return colon > 0 ? rest.slice(0, colon) : null;
}
