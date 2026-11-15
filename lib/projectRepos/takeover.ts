import type { ProjectRepoTakeoverState } from '@/generated/prisma/client';

// The TAKE-IT-OVER state machine (Story MOTIR-1775 · MOTIR-711) — the handoff that
// moves a Motir-owned repository into the user's own GitHub account.
//
// Kept PURE and in its own module, exactly like `transitions.ts` next to it: the
// legality rule is unit-testable without a row, and there is ONE place a legal
// edge is declared. The service asks this table; it never re-implements the graph.
//
// ⚠️ WHY THE MIDDLE STATES EXIST AT ALL. Both `transfer_pending` and
// `awaiting_reinstall` are waits on a HUMAN doing something on github.com — the
// new owner accepting a transfer, someone installing the App — and neither has a
// bounded duration. A spinner cannot represent that, and inferring it from the
// mirror cannot either (the mirror says where the repo IS, never whether anyone
// still intends to finish). Recording them is what makes an abandoned handoff
// RE-PROMPTABLE rather than a wedged repository.

/** Every takeover state, in lifecycle order. */
export const PROJECT_REPO_TAKEOVER_STATES = [
  'requested',
  'transfer_pending',
  'awaiting_reinstall',
  'done',
  'failed',
] as const satisfies readonly ProjectRepoTakeoverState[];

/**
 * The takeover states in which the repository has been TRANSFERRED out of
 * Motir's organisation — `awaiting_reinstall` onwards to `done`. Before them
 * (NULL, `requested`, `transfer_pending`, or a `failed` attempt) the repository
 * is still Motir's: the same line `runGitAppFor` (`lib/github/runGitCredential.ts`)
 * draws for which App reaches it, and the one the tenant-subdomain eligibility
 * test reads (§8 Amendment 5, `projectRepoRepository.hasMotirRepositoryInWorkspace`).
 */
export const TRANSFERRED_TAKEOVER_STATES = [
  'awaiting_reinstall',
  'done',
] as const satisfies readonly ProjectRepoTakeoverState[];

/**
 * The legal outgoing edges of every takeover state.
 *
 * `Record<ProjectRepoTakeoverState, …>` makes this TOTAL: adding a state to the
 * Prisma enum without declaring its edges is a compile error, not a silently
 * unreachable state.
 *
 * ⚠️ EVERY NON-`done` STATE CAN REACH `failed`, AND `failed` CAN REACH
 * `requested`. That is the re-promptability requirement expressed as edges: a
 * transfer nobody accepted and a re-install nobody finished are the two most
 * likely real-world outcomes, and both must be recoverable by asking again
 * rather than by an operator editing a row.
 *
 * ⚠️ `done` IS THE ONLY SETTLED STATE, and it is settled on purpose. Once the
 * repository is under the user's account and the App is installed there, Motir's
 * provisioning credential no longer reaches it — so there is no operation left
 * for this machine to perform. A user who wants to move it AGAIN does so from
 * their own GitHub, which is precisely the freedom the handoff was for.
 */
export const PROJECT_REPO_TAKEOVER_TRANSITIONS: Record<
  ProjectRepoTakeoverState,
  readonly ProjectRepoTakeoverState[]
> = {
  // The transfer POST landed (pending accept), or the whole attempt failed.
  requested: ['transfer_pending', 'awaiting_reinstall', 'failed'],
  // The new owner accepted (the `transferred` webhook), or it was abandoned.
  transfer_pending: ['awaiting_reinstall', 'failed'],
  // An installation appeared under the new owner — or never did.
  awaiting_reinstall: ['done', 'failed'],
  // Settled: the repository is theirs and the loop survived.
  done: [],
  // RESUMABLE: asking again restarts the saga from the top.
  failed: ['requested'],
};

/** Whether `from → to` is a legal edge of the takeover machine. */
export function canTakeover(from: ProjectRepoTakeoverState, to: ProjectRepoTakeoverState): boolean {
  return PROJECT_REPO_TAKEOVER_TRANSITIONS[from].includes(to);
}

/** The legal targets from `from` — what a rejection names, so a caller can
 *  self-correct instead of guessing. */
export function allowedTakeoverTransitions(
  from: ProjectRepoTakeoverState,
): readonly ProjectRepoTakeoverState[] {
  return PROJECT_REPO_TAKEOVER_TRANSITIONS[from];
}

/**
 * Whether a takeover may be STARTED from this state.
 *
 * `null` (never requested) and `failed` (retry) are the two starts. Every other
 * state means one is already in flight or finished, and re-requesting must not
 * silently re-issue a transfer for a repository that has already moved.
 */
export function canStartTakeover(state: ProjectRepoTakeoverState | null): boolean {
  return state === null || state === 'failed';
}

/**
 * Whether the saga has finished with this row — used to keep a completed handoff
 * out of every sweep that only concerns repositories Motir still hosts.
 */
export function isTakeoverSettled(state: ProjectRepoTakeoverState | null): boolean {
  return state !== null && PROJECT_REPO_TAKEOVER_TRANSITIONS[state].length === 0;
}
