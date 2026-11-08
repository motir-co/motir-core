// CLI error types. A thrown `CliError` is a clean, user-facing failure: the
// top-level runner (src/index.ts) prints its message to stderr and exits with
// its `exitCode`. Anything else bubbles up as an unexpected crash (stack
// printed), which is the right distinction — a missing link is a CliError, a
// programming bug is not.

export class CliError extends Error {
  readonly exitCode: number;
  /** An optional one-line hint shown under the error (e.g. how to recover). */
  readonly hint: string | undefined;
  /**
   * `cause` is here so a catch that RE-WORDS a failure can keep the original
   * instead of destroying it. Nothing prints it — `src/index.ts` shows the
   * message and the hint — but a rewrite that drops the underlying error leaves
   * no way back to it, and `motir link` proved what that costs (MOTIR-2492).
   * A catch that must re-word: narrow first, then chain.
   */
  constructor(message: string, opts: { exitCode?: number; hint?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? {} : { cause: opts.cause });
    this.name = 'CliError';
    this.exitCode = opts.exitCode ?? 1;
    this.hint = opts.hint;
  }
}

/**
 * The single auth-failure path: an absent / invalid / revoked / expired token.
 * Every MCP call that comes back unauthorized maps HERE, with a uniform
 * re-login hint — the CLI never distinguishes the reason (matching the server's
 * uniform 401, lib/mcp/auth.ts).
 */
export class AuthError extends CliError {
  constructor(message = 'Token invalid or expired.') {
    super(message, { exitCode: 1, hint: 'Run `motir auth login` to authenticate.' });
    this.name = 'AuthError';
  }
}

/**
 * 403 — a valid token whose GRANT does not include this operation's permission.
 *
 * The permission NAME comes from the generated operation table
 * (`x-motir-permission`, which the server emits from its own operation
 * declarations — MOTIR-2583 checks the two agree), never from parsing
 * the server's English sentence. Re-reading it out of prose would be
 * `isUnauthorized`'s message regex all over again, one status down.
 *
 * Pinned by `docs/decisions/cli-v1-client.md` Q5.
 */
export class PermissionError extends CliError {
  constructor(permission: string, operationId: string) {
    super(`This token is not granted the '${permission}' permission required for ${operationId}.`, {
      exitCode: 1,
      hint: `Grant the '${permission}' permission on a token: Settings → Account → Tokens.`,
    });
    this.name = 'PermissionError';
  }
}

/** 404 with a v1 error envelope — the server's own sentence, kept verbatim. */
export class NotFoundError extends CliError {
  constructor(message: string) {
    super(message, {
      exitCode: 1,
      hint: 'Check the identifier, or run `motir ready` to list what you can reach.',
    });
    this.name = 'NotFoundError';
  }
}

/**
 * 429 — the per-token budget is spent, and the transport has stopped waiting.
 *
 * `x-ratelimit-reset` is Unix epoch SECONDS, and the absolute instant is what the
 * message reports. v1 has ALSO sent `Retry-After` and a body `retryAfterSeconds`
 * since the retryable refusal contract (MOTIR-8600); the transport prefers the
 * body field when it decides how long to wait (`readRetryAfterSeconds`). Since
 * MOTIR-8602 `V1Transport.request` waits a refusal out and re-sends, so this
 * error means the bounded total ran out — `waitedSeconds` says how long it tried.
 */
export class RateLimitError extends CliError {
  constructor(resetAtEpochSeconds: number | undefined, now: Date = new Date(), waitedSeconds = 0) {
    const resetAt =
      resetAtEpochSeconds === undefined ? undefined : new Date(resetAtEpochSeconds * 1000);
    const when = resetAt ? resetAt.toLocaleTimeString() : 'an unreported time';
    const seconds =
      resetAt === undefined
        ? undefined
        : Math.max(0, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
    const gaveUp =
      waitedSeconds > 0
        ? `; gave up after waiting ${waitedSeconds} second${waitedSeconds === 1 ? '' : 's'}`
        : '';
    super(`Rate limit exceeded${gaveUp}. The budget refills at ${when}.`, {
      exitCode: 1,
      hint: seconds === undefined ? 'Retry shortly.' : `Retry in ${seconds} seconds.`,
    });
    this.name = 'RateLimitError';
  }
}

/** What the transport reports each time it waits out a 429 (MOTIR-8602). */
export interface RateLimitWaitNotice {
  operationId: string;
  /** The whole seconds this wait is for (before jitter). */
  waitSeconds: number;
  /** 1 for the first retry, 2 for the second, … */
  attempt: number;
  /** Seconds already waited on this call, before this wait. */
  waitedSeconds: number;
  /** The bounded total this call may wait. */
  maxWaitSeconds: number;
}

/**
 * A 2xx body the generated validator rejected — the failure the MCP-era cast
 * could not produce.
 *
 * ⚠️ The field is NOT `instancePath` alone. Ajv reports a MISSING property on
 * the PARENT's path with the name in `params.missingProperty`, and an
 * unexpected one the same way via `params.additionalProperty` — so a message
 * built from `instancePath` would say "` ` must have required property" for a
 * renamed server field, which is the single case this whole migration exists to
 * catch. `describeField` below is what makes it name the field.
 */
export class ResponseShapeError extends CliError {
  constructor(serverUrl: string, operationId: string, field: string, detail: string) {
    super(`Unexpected response from ${serverUrl} for ${operationId}: ${field} ${detail}.`, {
      exitCode: 1,
      hint: 'Your CLI and this server may be out of step — run `motir doctor`.',
    });
    this.name = 'ResponseShapeError';
  }
}

/**
 * The CLI and the server speak different `/api/v1` contracts.
 *
 * ONE message per invocation, replacing the per-field defensive branches the
 * MCP era accumulated. See `docs/decisions/cli-v1-client.md` Q3 for what
 * "incompatible" means and why a NEWER minor is silent (ADR §8 is additive-only
 * within a major, so a newer server cannot break a client generated earlier).
 */
export class IncompatibleServerError extends CliError {
  constructor(message: string, hint: string) {
    super(message, { exitCode: 1, hint });
    this.name = 'IncompatibleServerError';
  }
}

/** No `.motir.json` binding was found walking up from the cwd. */
export class NotLinkedError extends CliError {
  constructor() {
    super('No Motir project link found in this directory or any parent.', {
      exitCode: 1,
      hint: 'Run `motir link` at your workspace root to bind a project.',
    });
    this.name = 'NotLinkedError';
  }
}

/**
 * A plan-approval refused because the plan is not in the status the action
 * needs — carrying WHICH status it is in (MOTIR-3025).
 *
 * ⚠️ IT EXISTS SO A LOOP CAN TELL "NOT YET" FROM "ALREADY DECIDED". An agent
 * submits its re-plan with `--detach` and exits within milliseconds, so an
 * unattended run reaches the approval while the planner is often still writing:
 * `generating` means wait, and `approved` / `declined` mean somebody has already
 * decided and the run must stop. The two are one word apart in the sentence and
 * a caller must not be parsing sentences (`public-api-conventions.md` §8), so
 * the server carries the status as DATA and this is where it lands.
 *
 * A `CliError` in every other respect: printed the same way, exits the same way.
 */
export class PlanNotDecidableError extends CliError {
  readonly planStatus: string;
  constructor(message: string, planStatus: string, opts: { hint?: string } = {}) {
    super(message, opts);
    this.name = 'PlanNotDecidableError';
    this.planStatus = planStatus;
  }
}

/**
 * 422 `CONTAINER_HAS_OPEN_CHILDREN` — a container was moved to a status that
 * CLAIMS its own work is built while a child of its own is not (Bug MOTIR-3229,
 * server side; this is Bug MOTIR-3268's client half).
 *
 * ⚠️ IT EXISTS SO A RUN CAN NAME THE REFUSAL INSTEAD OF DYING ON IT. The
 * transition happens deep inside the loop — after the agent has exited and its
 * work is on the remote — and an unhandled throw there escapes before the
 * close-out, abandoning every other repository's finished work (the shape
 * `autoCommand.test.ts` already pins for a different throw). The run's own
 * close-out gate narrows the window this arrives in; it cannot close it, because
 * a child can be filed between the re-read and the transition.
 *
 * ⚠️ IT CARRIES THE SERVER'S SENTENCE AND NOT A PARSED CHILD LIST. The message
 * NAMES the open children and the wire envelope does not publish them as a field
 * — and `public-api-conventions.md` §8 is explicit that a client reads fields,
 * never sentences. So the run quotes the server verbatim, which is also the only
 * way the two surfaces cannot disagree about what is open.
 */
export class ContainerHasOpenChildrenError extends CliError {
  constructor(message: string) {
    super(message, {
      exitCode: 1,
      hint: 'Land the open children, re-parent them out of the container, or move it to Done.',
    });
    this.name = 'ContainerHasOpenChildrenError';
  }
}

/**
 * 409 `DISPATCH_RUN_TERMINAL` — the run this process is reporting into was
 * already CLOSED on the server (MOTIR-6530). Most often by the lapse reap: the
 * machine went silent for five minutes, the server read the run as dead and
 * closed it `abandoned`. Typed on the CODE, like the refusal above, because the
 * reporter's answer to it — stop beating, say so once — differs from its answer
 * to every other failure, which is to keep going silently.
 */
export class DispatchRunClosedError extends CliError {
  constructor(message: string) {
    super(message, { exitCode: 1 });
    this.name = 'DispatchRunClosedError';
  }
}

/**
 * 409 `REVIEW_STALE` — a hosted review run's verdict arrived LATE (MOTIR-6824;
 * `approval-gates.md` §12.5): the version it names is no longer the one the review
 * asks about, or the review was withdrawn or already decided. The server RECORDED it
 * on the run and decided nothing. Typed on the CODE, because `motir review` answers
 * it with a clean exit — the code moved, which is expected — rather than a failure.
 */
export class ReviewStaleError extends CliError {
  constructor(message: string) {
    super(message, { exitCode: 0 });
    this.name = 'ReviewStaleError';
  }
}

/**
 * An agent-mode run (MOTIR-7024) whose agent's profile has no unattended
 * command — `agent_profile_cannot_run`, the refusal
 * `docs/decisions/agent-instance-run.md` §3–§4 names. Raised before anything is
 * claimed or cloned, naming the profile, so the run ends in words rather than
 * at a prompt nobody will answer.
 */
export class AgentProfileCannotRunError extends CliError {
  readonly code = 'agent_profile_cannot_run' as const;
  readonly profile: string;
  constructor(profile: string) {
    super(`The ${profile} agent has no unattended mode, so it cannot run a card.`, {
      hint: 'Run the card in an agent created with Claude Code, Codex or another profile that can.',
    });
    this.name = 'AgentProfileCannotRunError';
    this.profile = profile;
  }
}

// ── THE THREE FAILURES A CALLER MAY WANT TO TELL APART (MOTIR-10705) ────────
//
// They print and exit exactly as the plain `CliError` they replace — same message,
// same hint — so no command's output changes. What they add is the CLASS, for the one
// caller that has to answer "is this worth retrying?" without reading a sentence: the
// run reporter. A hosted run is ended as a stall after fifteen minutes with no event,
// so a reporter that answers a transient 5xx, a refused batch and a revoked credential
// the same way — by going silent for the rest of the run — kills runs that are working.

/**
 * The request never got an answer: DNS, a refused connection, a reset, a timeout.
 * TRANSIENT by nature — the same request may succeed a moment later.
 */
export class NetworkError extends CliError {
  constructor(message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message, opts);
    this.name = 'NetworkError';
  }
}

/** A 5xx — the server failed. TRANSIENT: the request itself was not at fault. */
export class ServerFailureError extends CliError {
  readonly status: number;
  constructor(message: string, status: number, opts: { hint?: string } = {}) {
    super(message, opts);
    this.name = 'ServerFailureError';
    this.status = status;
  }
}

/**
 * Any other 4xx the server answered for THIS request — 402, 409, 412, 413, 422 and the
 * rest the map has no dedicated type for. It carries the status and the envelope's
 * machine `code` (`null` when the body had no envelope) as DATA, so a caller branches on
 * fields, never on the sentence (`public-api-conventions.md` §8). The message is the
 * server's own, verbatim, as before.
 */
export class ApiRefusalError extends CliError {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiRefusalError';
    this.status = status;
    this.code = code;
  }
}
