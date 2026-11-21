import { createHash } from 'node:crypto';

// WHICH GATE A REVIEW RUN ANSWERS, spelled on the run itself (Story MOTIR-1626 ·
// MOTIR-6820; `hosted-agent-run.md` §8.1, `approval-gates.md` §12.6).
//
// ⚠️ THE GATE ID RIDES THE RUN'S IDEMPOTENCY KEY, AND THAT IS THE RECORD. A review run is
// opened by the server, once per PRESS for a gate (MOTIR-11944, `approval-gates.md` §12.18),
// and the press's own key is the run's `idempotencyKey`:
//
//   agent-review:<gateId>:press:<attempt>    a person's press, its attempt counted from 1
//
// (Runs of the retired automatic start carry `…:raise` and `…:again:<uuid>`; they sit under
// the same prefix and count as attempts.) So a retried press opens nothing twice
// (`dispatch_run`'s `(workspace_id, idempotency_key)` unique), the next press after a run
// ended is a NEW attempt, and "the review running for this gate" is a prefix read — without a column
// on `dispatch_run` that only one command would ever fill. The run's `run_opened` event
// carries the gate id and version as well, for a reader of the run page.
//
// ⚠️ A REVIEW WITH NO GATE HAS A NAMESPACE OF ITS OWN (Story MOTIR-11941 · MOTIR-11952;
// `approval-gates.md` §12.18). With Review off a person can still start a hosted review of
// an item, and there is no gate to name. Its key names the ITEM and the VERSION instead:
//
//   agent-review-item:<workItemId>:<versionDigest>:<requestId>
//
// `versionDigest` is the SHA-256 hex of the delivery-set version, not the version itself: a
// version grows with every pull request of the set, and a raw one could pass the btree size
// limit of the `(workspace_id, idempotency_key)` unique index. The key is deterministic for
// a given `requestId`, so the door's attempt number collapses a double press onto one run.
// It does not start with `agent-review:`, so {@link gateIdOfReviewRunKey} answers null for
// it, and every gate-keyed read (the end's reason, the supersede cancel) leaves it alone.

const PREFIX = 'agent-review:';

/** Every review run of `gateId` has a key starting with this. */
export function reviewRunKeyPrefix(gateId: string): string {
  return `${PREFIX}${gateId}:`;
}

/**
 * The key of a person's press for `gateId`'s review — its `attempt`-th run, counted from 1
 * over every review run already opened under {@link reviewRunKeyPrefix} (MOTIR-11944). It is
 * DETERMINISTIC, so two presses racing past the in-flight check compute the same key and
 * `dispatch_run`'s unique index collapses them onto ONE run.
 */
export function reviewPressKey(gateId: string, attempt: number): string {
  return `${reviewRunKeyPrefix(gateId)}press:${attempt}`;
}

/**
 * The key of a review run opened in one of the person's OWN agents for `gateId`
 * (*Review in my agent*, Story MOTIR-11941 · MOTIR-11945) — the press's own request key
 * under {@link reviewRunKeyPrefix}, so the hosted door's prefix read, the marker and the
 * supersede cancel see an own-agent review exactly as they see a hosted one. The `agent:`
 * segment keeps a client's request key from ever spelling a hosted press's `press:<n>`.
 */
export function reviewAgentRunKey(gateId: string, requestKey: string): string {
  return `${reviewRunKeyPrefix(gateId)}agent:${requestKey}`;
}

const ITEM_PREFIX = 'agent-review-item:';

function versionDigest(subjectVersion: string): string {
  return createHash('sha256').update(subjectVersion).digest('hex');
}

/** Every gate-off review run of `workItemId` at `subjectVersion` has a key starting with this. */
export function reviewItemRunKeyPrefix(workItemId: string, subjectVersion: string): string {
  return `${ITEM_PREFIX}${workItemId}:${versionDigest(subjectVersion)}:`;
}

/** The key of ONE gate-off review request — deterministic for its `requestId`. */
export function reviewItemRunKey(
  workItemId: string,
  subjectVersion: string,
  requestId: string,
): string {
  return `${reviewItemRunKeyPrefix(workItemId, subjectVersion)}${requestId}`;
}

/**
 * The key of an own-agent review run (*Review in my agent*, MOTIR-11945) for what it
 * reviews: under the gate's prefix ({@link reviewAgentRunKey}) with Review on, else the
 * item's gate-off key ({@link reviewItemRunKey}) at the version, its request id carrying
 * the same `agent:` segment.
 */
export function reviewOwnAgentRunKey(
  workItemId: string,
  target: { gateId: string | null; subjectVersion: string },
  requestKey: string,
): string {
  return target.gateId !== null
    ? reviewAgentRunKey(target.gateId, requestKey)
    : reviewItemRunKey(workItemId, target.subjectVersion, `agent:${requestKey}`);
}

/** The gate a review run's idempotency key names, or null for any other key. */
export function gateIdOfReviewRunKey(key: string | null | undefined): string | null {
  if (!key?.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const colon = rest.indexOf(':');
  return colon > 0 ? rest.slice(0, colon) : null;
}
