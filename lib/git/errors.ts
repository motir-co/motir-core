// Typed errors for the Git provider seam (Story 7.10 · MOTIR-891), and in
// particular for the TARBALL-URL RESOLUTION capability (MOTIR-1989).
//
// ⚠️ WHY THESE ARE FOUR CLASSES AND NOT ONE STRING. The resolver's caller is the
// index DISPATCH path: it hands the resolved URL to a container that has no
// GitHub credential of its own (`docs/decisions/code-graph-index-fleet.md` §10),
// so a resolution that fails must fail LOUDLY and legibly. The four failures
// below have four different operator responses — re-dispatch, look at the App
// installation, look at GitHub's status, add the provider capability — and a
// single `Error("could not resolve")` collapses all of them into "something went
// wrong with indexing", which is exactly the diagnosis the whole story exists to
// stop producing.
//
// They also exist so no caller can EVER mistake a failure for a URL: every arm
// throws, and none returns a falsy string. A resolver that returned `''` on a
// missing `Location` would put an empty `MOTIR_INDEX_TARBALL_URL` in a container
// spec, and the container would fail with a `FETCH` exit code that blames the
// repo for a defect in the dispatcher.

/** Why a tarball URL could not be resolved. Stable — a consumer switches on it. */
export type RepoTarballUrlFailure =
  /** The host answered, but not with a redirect — so there is no signed URL. */
  | 'not_redirected'
  /** A redirect with no `Location` header. The host's contract broke. */
  | 'no_location'
  /** The host did not answer inside {@link REPO_TARBALL_TIMEOUT_MS}. */
  | 'timeout'
  /** The request never completed — DNS, TLS, connection reset. */
  | 'unreachable';

/**
 * The base every resolution failure extends, carrying the discriminator.
 *
 * Both forms are usable: `instanceof RepoTarballUrlTimeoutError` for the one
 * case a caller treats specially, and `err.failure` for a switch that must be
 * total. The subclasses are what make a stack trace say what happened.
 */
export class RepoTarballUrlError extends Error {
  readonly failure: RepoTarballUrlFailure;

  constructor(failure: RepoTarballUrlFailure, message: string) {
    super(message);
    this.name = 'RepoTarballUrlError';
    this.failure = failure;
  }
}

/** The host returned a non-redirect status (a 200, a 404, a 500 — anything that
 *  is not a 3xx). A 200 is the interesting one: it means the host served the
 *  BYTES, which is precisely what this path exists not to receive. */
export class RepoTarballUrlNotRedirectedError extends RepoTarballUrlError {
  readonly status: number;

  constructor(status: number) {
    super(
      'not_redirected',
      `the tarball endpoint answered ${status} instead of redirecting to a pre-signed URL`,
    );
    this.name = 'RepoTarballUrlNotRedirectedError';
    this.status = status;
  }
}

/** A 3xx with no `Location`. Nothing to hand a container. */
export class RepoTarballUrlMissingLocationError extends RepoTarballUrlError {
  readonly status: number;

  constructor(status: number) {
    super('no_location', `the tarball endpoint returned ${status} with no Location header`);
    this.name = 'RepoTarballUrlMissingLocationError';
    this.status = status;
  }
}

/** The host did not answer inside the deadline. RETRYABLE. */
export class RepoTarballUrlTimeoutError extends RepoTarballUrlError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super('timeout', `the tarball endpoint did not respond within ${timeoutMs}ms`);
    this.name = 'RepoTarballUrlTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The request failed at the transport layer. RETRYABLE. */
export class RepoTarballUrlUnreachableError extends RepoTarballUrlError {
  constructor(detail: string) {
    super('unreachable', `the tarball endpoint was unreachable (${detail})`);
    this.name = 'RepoTarballUrlUnreachableError';
  }
}

/**
 * The provider does not implement tarball-URL resolution at all.
 *
 * ⚠️ NOT a `RepoTarballUrlError` — deliberately. Those four say "this attempt
 * failed"; this says "this host cannot do the thing, and no retry will change
 * that." It is thrown by {@link requireRepoTarballUrlResolver} rather than by any
 * provider, and it exists so the refusal is LOUD: the alternative a caller would
 * otherwise reach for is falling back to `fetchRepoTarball` and buffering the
 * bytes, which re-introduces the OOM the container path removes.
 */
export class RepoTarballUrlUnsupportedError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `the ${providerId} provider cannot resolve a pre-signed tarball URL; ` +
        'container indexing requires a host that redirects to a self-authorizing archive URL',
    );
    this.name = 'RepoTarballUrlUnsupportedError';
    this.providerId = providerId;
  }
}

// ─── File READ at a ref (Story MOTIR-4585 · MOTIR-4586) ──────────────────────
//
// ⚠️ ONE class, not four, and it is thrown in ONE case — deliberately the
// inverse of the tarball errors above. There the CALLER is a dispatcher that
// must fail loudly; here the caller is a planning session, and every ordinary
// answer (no such path, no such ref, too large, credential refused, host
// unreachable) is a NAMED RESULT it can reason about (`RepoFileReadResult`).
// What is left over is a host status no arm names — a 500, a 502, a body that
// is not what the endpoint documents — and that is the one thing a model cannot
// do anything sensible with. It gets a typed error so the stack says what
// happened and a retry is the operator's obvious next move.
//
// So: a transport failure is a typed error HERE, and a named result at the
// boundary the model reads. The two are not in tension — they are the same fact
// stated to two different readers.

/** The host answered with a status this capability does not name. RETRYABLE. */
export class RepoFileReadError extends Error {
  readonly code = 'REPO_FILE_READ_FAILED' as const;
  readonly status: number;
  readonly providerId: string;

  constructor(providerId: string, status: number, detail?: string) {
    super(
      `the ${providerId} file-contents endpoint answered ${status}` +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'RepoFileReadError';
    this.providerId = providerId;
    this.status = status;
  }
}

// ── MERGE (MOTIR-5514) ────────────────────────────────────────────────────────
// A merge's REFUSALS are results (`MergeChangeRequestResult`), because each is an
// answer a person can act on. This is the one thing that is NOT an answer: the host
// did not respond in time, could not be reached, or replied with a status no
// refusal names. It stays loud on purpose — a timeout reported as "the host
// refused" would send a person off to satisfy a rule that does not exist.

/** A merge call that produced no answer the seam can name. RETRYABLE. */
export class MergeChangeRequestError extends Error {
  readonly code = 'MERGE_CHANGE_REQUEST_FAILED' as const;
  readonly providerId: string;
  readonly reason: 'timeout' | 'unreachable' | 'unexpected_status';
  readonly status: number | null;

  constructor(
    providerId: string,
    reason: 'timeout' | 'unreachable' | 'unexpected_status',
    detail: { status?: number; message?: string } = {},
  ) {
    const what =
      reason === 'timeout'
        ? 'did not answer in time'
        : reason === 'unreachable'
          ? 'could not be reached'
          : `answered ${detail.status ?? 'an unexpected status'}`;
    super(`the ${providerId} merge ${what}` + (detail.message ? ` (${detail.message})` : ''));
    this.name = 'MergeChangeRequestError';
    this.providerId = providerId;
    this.reason = reason;
    this.status = detail.status ?? null;
  }
}

// ── A repository-permission read that produced no answer (Story MOTIR-4910 ·
//    MOTIR-5595; `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decision 2)
//
// ⚠️ A 404 IS NOT THIS ERROR. GitHub answers 404 for a user with no access at all,
// which is a real, usable answer (`none`) rather than a failure — so it is mapped,
// not thrown. This error is for the cases where the host did not tell us: a 403, a
// 500, a timeout. The consumer records `unknown` on it and the review then counts
// for nothing, which is the safe direction: a person can still approve in Motir.

/** A repository-permission read that could not be answered. The consumer records
 *  `unknown` rather than guessing a permission. */
export class ProviderPermissionReadError extends Error {
  readonly code = 'PROVIDER_PERMISSION_READ_FAILED' as const;
  readonly providerId: string;
  readonly reason: 'unreachable' | 'unexpected_status';
  readonly status: number | null;

  constructor(
    providerId: string,
    reason: 'unreachable' | 'unexpected_status',
    detail: { status?: number; message?: string } = {},
  ) {
    const what =
      reason === 'unreachable'
        ? 'could not be reached'
        : `answered ${detail.status ?? 'an unexpected status'}`;
    super(
      `the ${providerId} repository-permission read ${what}` +
        (detail.message ? ` (${detail.message})` : ''),
    );
    this.name = 'ProviderPermissionReadError';
    this.providerId = providerId;
    this.reason = reason;
    this.status = detail.status ?? null;
  }
}

// ── A BOT REVIEW THE HOST WOULD NOT TAKE (MOTIR-10335) ──
// A post or dismiss of Motir's own App review that failed for a reason other than the
// two answers the seam types (`own_pull_request`, `gone`). The job retries it; it never
// touches the verdict it was posting.

/** A review post or dismissal the host did not take. */
export class ProviderReviewWriteError extends Error {
  readonly code = 'PROVIDER_REVIEW_WRITE_FAILED' as const;
  readonly providerId: string;
  readonly operation: 'post' | 'dismiss';
  readonly status: number | null;

  constructor(
    providerId: string,
    operation: 'post' | 'dismiss',
    detail: { status?: number; message?: string } = {},
  ) {
    super(
      `the ${providerId} review ${operation === 'post' ? 'post' : 'dismissal'} ` +
        (detail.status === undefined ? 'could not be reached' : `answered ${detail.status}`) +
        (detail.message ? ` (${detail.message})` : ''),
    );
    this.name = 'ProviderReviewWriteError';
    this.providerId = providerId;
    this.operation = operation;
    this.status = detail.status ?? null;
  }
}

// ── A MERGE DELIVERY THAT COULD NOT MOVE EVERY CARD IT DELIVERS (MOTIR-5587) ──
// The status sync moves each delivered card in its own transaction, so one card's
// FAULT — a transaction that could not start, a connection reset — says nothing
// about the next card. It used to escape the per-card loop, which left every card
// after it untouched: `motir-ai#487` delivered 36 cards and 25 of them never moved.
// The sync now attempts EVERY card and throws this afterwards, naming the ones it
// could not move. It still throws, on purpose: a delivery that returned would let
// the post-commit capture stamp `merged_at`, and a merged row WITH `merged_at` is
// invisible to the open-delivery reconcile (MOTIR-5390) — the one thing that
// replays the delivery and finishes the job.

/** One delivered card whose transition faulted, and the fault's own message. */
export interface DeliveredItemTransitionFailure {
  workItemId: string;
  message: string;
}

/** A merge delivery that attempted every delivered card and could not move some. */
export class DeliveredItemsTransitionFailedError extends Error {
  readonly code = 'DELIVERED_ITEMS_TRANSITION_FAILED' as const;
  readonly changeRequestNumber: number;
  /** How many delivered cards the sync ATTEMPTED — every one of them. */
  readonly attempted: number;
  readonly failed: readonly DeliveredItemTransitionFailure[];

  constructor(
    changeRequestNumber: number,
    attempted: number,
    failed: readonly DeliveredItemTransitionFailure[],
  ) {
    super(
      `change request #${changeRequestNumber}: ${failed.length} of ${attempted} delivered ` +
        `work items could not be moved (${failed.map((f) => f.workItemId).join(', ')}); ` +
        `first fault: ${failed[0]?.message ?? 'unknown'}`,
    );
    this.name = 'DeliveredItemsTransitionFailedError';
    this.changeRequestNumber = changeRequestNumber;
    this.attempted = attempted;
    this.failed = failed;
  }
}

/**
 * The repository a changed-files listing named is not in the JOB's project set
 * (Story MOTIR-6617 · MOTIR-6619) — not connected to the organisation at all, or
 * connected but not realized by any `ProjectRepo` row of the token's project.
 * The route answers 404 and the provider is never called.
 *
 * ⚠️ ONE CLASS FOR BOTH CASES, on purpose: a job must not be able to tell a
 * repository connected elsewhere in the organisation from one that exists
 * nowhere, which is `repo-file`'s no-existence-leak rule one scope tighter.
 */
export class RepoNotInProjectError extends Error {
  readonly code = 'REPO_NOT_IN_PROJECT' as const;
  constructor(readonly repoRef: string) {
    super(`The repository ${repoRef} is not in this project's repository set.`);
    this.name = 'RepoNotInProjectError';
  }
}
