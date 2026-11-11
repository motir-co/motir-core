import { CliError } from '../errors.js';
import { info } from '../output.js';
import { planReviewUrl } from '../autoLoop.js';
import {
  childrenBelowClaimBar,
  classifyScopeTarget,
  dispositionOf,
  epicRefusal,
  parseScopeArgument,
  renderClaimedScope,
  renderEmptyScope,
  renderScopeRefusal,
  unexpandedRefusal,
  type ScopeTarget,
} from '../scopedRun.js';
import { readScopeEdges } from './scopeDrain.js';
import type { ScopeEdges } from '../scopedRun.js';
import type { DispatchItem, MotirClient, ScopeClaim, WorkItemDetail } from '../client.js';
import type { ProjectSession } from '../session.js';

// `motir run <scope>` — the FRONT HALF of the scoped run (Story MOTIR-3001 ·
// MOTIR-3198). Turn a scope a person named into a scope this run OWNS, print it,
// and stop.
//
// ── Where this file ends, on purpose ───────────────────────────────────────
// At the claim. No agent is launched, no session branch is created, no worktree
// exists and no pull request is opened — that is MOTIR-3199, which is
// `blocked_by` this card. The seam is the one `motir batch` already draws
// between `renderSnapshotPlan` ("here is exactly what I am about to do") and the
// drain that follows, and it is drawn here for the same reason: a person reads
// the plan of the run and can press Ctrl-C before anything is touched.
//
// ── What this file does NOT decide ─────────────────────────────────────────
// Validation, the shape rule, the lock order, the all-or-nothing transaction and
// the outcome vocabulary are ALL `scopeClaimService.claimScope`'s (MOTIR-3049).
// The CLI's whole job is to call it and to render what it says. Nothing here
// re-derives a verdict the server already reached, and nothing here claims
// card-by-card as the set is walked — one call covers the whole scope, which is
// the property the up-front claim exists for.

/** The options `motir run` carries into the SCOPED path. */
export interface ScopeRunOptions {
  /** `--disable-replan` / its `--no-replan` alias, already normalised. */
  disableReplan?: boolean;
  /** `--include-planning` — expand an unexpanded container instead of refusing. */
  includePlanning?: boolean;
  /** `--kinds` — registered in order to be REFUSED (see below). */
  kinds?: string;
  /** `--print` — leaf-only; refused on a scope. */
  print?: boolean;
  /** `--force` — leaf-only; refused on a scope. */
  force?: boolean;
  /**
   * `--allow-soft-block` (MOTIR-6355) — run past a SOFT block: an item held
   * only by an ANCESTOR's open blocker. Never past a HARD one, the item's own.
   * On a leaf it dispatches a soft-blocked card; on a container it widens the
   * ready read (`allowSoftBlock`) so the children held only by the container's
   * ancestor chain form the scope.
   */
  allowSoftBlock?: boolean;
}

/** The single-item verdict `get_work_item` returns, as the CLI reads it. */
export type ReadinessVerdict = WorkItemDetail['readiness'];

/**
 * The ancestor a SOFT block is owed to, or `null` when the block is not soft.
 *
 * The verdict tells the two blocks apart by itself (MOTIR-6354): a non-empty
 * `openBlockers` is HARD — the item's OWN `blocked_by` edge is open — while
 * `ready: false` with NO open blockers and a `blockedByAncestor` is SOFT: only
 * an ancestor's block holds it. A ready item has no block of either kind.
 */
export function softBlockAncestor(readiness: ReadinessVerdict): { identifier: string } | null {
  if (readiness.ready || readiness.openBlockers.length > 0) return null;
  return readiness.blockedByAncestor;
}

/**
 * The three flags that mean something on ONE CARD and nothing on a SET.
 *
 * Registered so they can be refused with a REASON rather than with commander's
 * `unknown option` — the MOTIR-1828 / MOTIR-1830 pattern `--auto-approve-replan`
 * already uses on this command. A reader who just saw the flag in `motir run`'s
 * own help and tried it on a story deserves the sentence, not the wall.
 */
export function refuseLeafOnlyFlag(opts: ScopeRunOptions): void {
  if (opts.print) {
    throw new CliError('`--print` needs one prompt; a scoped run has one per leaf.', {
      hint: 'Print a single work item with `motir run <leaf-key> --print`.',
    });
  }
  if (opts.force) {
    throw new CliError('`--force` applies to a single work item, not to a scope.', {
      hint: 'A scope that cannot be finished needs a re-plan, not a forced run.',
    });
  }
  if (opts.kinds !== undefined) {
    throw new CliError('`--kinds` filters a ready-set PICK; a scoped run drains a claimed set.', {
      hint: 'The claim is all-or-nothing over the whole scope, so a filtered run would hold work items it never worked.',
    });
  }
}

/** What a scoped run resolved to, so the drain (MOTIR-3199) can consume it. */
export interface ClaimedScope {
  claim: ScopeClaim;
  /** The ready leaves, in the server's dispatch rank — what the run works. */
  ready: DispatchItem[];
  /**
   * `key → the keys it is blocked by`, read ONCE, before the first agent.
   *
   * ⚠️ READ HERE AND NOT IN THE DRAIN, so the whole drain provably makes no
   * query that could re-derive an order. It is the same `get_work_item` the
   * shape check already made for a container scope.
   */
  edges: ScopeEdges;
}

/**
 * Resolve, validate, shape-check and CLAIM a scope. Returns the claimed set on
 * the happy path, or `null` when the run stopped — for any of the six typed
 * outcomes, for an empty scope, or after submitting a re-plan.
 *
 * ⚠️ A STOP IS `null` AND EXIT 0, NEVER A THROW. Four of the six outcomes are
 * ordinary states a dispatcher meets, and two (`wrong_shape`, `not_finishable`)
 * are FINDINGS whose correct answer is a re-plan. The server made all six a 200
 * for exactly this reason; a CLI that threw would put the error back one layer
 * up. The two things that DO throw are a malformed request — an epic, a
 * leaf-only flag — because those the caller can fix from the message alone.
 */
export async function claimScopeForRun(
  session: ProjectSession,
  target: ScopeTarget,
  opts: ScopeRunOptions,
  ownerId: string,
  /** The TARGET's own verdict, from the `getWorkItem` `resolveScopeTarget`
   *  already made — never re-read. Absent for a sprint scope. */
  targetReadiness?: ReadinessVerdict,
  /**
   * Items to run BESIDES the ready set — `motir continue <PARENT>`'s in-flight
   * legs (MOTIR-6535). The ready set lists only To Do leaves, so a resumed run's
   * In Progress children would otherwise never be dispatched again.
   */
  resume?: readonly DispatchItem[],
): Promise<ClaimedScope | null> {
  const { client, projectKey, serverUrl } = session;

  // 0 ── `--allow-soft-block` overrides a SOFT block only (MOTIR-6355). A
  // container whose OWN blockers are open is HARD-blocked, and the flag never
  // reaches past that: refused before anything is read or claimed. A container
  // held only by its ancestor's block — or not held at all — goes on, and the
  // ready read is widened so its soft-blocked children form the scope. A child
  // with its OWN open blocker stays out of that read either way.
  if (opts.allowSoftBlock && targetReadiness && targetReadiness.openBlockers.length > 0) {
    const blockers = targetReadiness.openBlockers
      .map((b) => `${b.identifier} (${b.title})`)
      .join(', ');
    throw new CliError(
      `${label(target)} has its own open blocker — --allow-soft-block overrides only an ancestor's block. Waiting on: ${blockers}.`,
      { hint: 'Finish the blocker first, or re-plan the dependency.' },
    );
  }

  // 1 ── the READY SET, fetched ONCE, up front.
  //
  // A scoped run is snapshot-shaped by design: it will own every card in the
  // scope, so it never needs the ready set to unblock its own dependents as it
  // goes. The walk follows the cursor to exhaustion inside `listReadyForDispatch`
  // — a run that silently took only the first page would claim a set it had not
  // enumerated.
  const listed = await client.listReadyForDispatch({
    projectKey,
    ownerId,
    ...(target.kind === 'work_item' ? { ancestor: [target.key] } : { sprintId: 'active' }),
    ...(opts.allowSoftBlock ? { allowSoftBlock: true } : {}),
  });
  const ready = [...listed, ...(resume ?? []).filter((r) => !listed.some((l) => l.key === r.key))];

  if (ready.length === 0) {
    // ⚠️ NOT an error, and distinguishable in the output from a refusal. A story
    // whose leaves are all in flight is a plan state; nothing was claimed.
    info(renderEmptyScope(label(target)));
    return null;
  }

  // 2 ── the CLAIM. ONE call, covering the whole scope.
  const claim = await client.claimScope(
    target.kind === 'work_item'
      ? // A RESUME leaves the dead run's landed children out of the claim (MOTIR-6535).
        { kind: 'work_item', key: target.key, ...(resume ? { exceptLanded: true } : {}) }
      : { kind: 'sprint', projectKey },
  );

  const disposition = dispositionOf(claim.outcome);
  if (disposition === 'replan') {
    info(renderScopeRefusal(claim));
    await submitShapeReplan(client, serverUrl, projectKey, target, opts);
    return null;
  }
  if (disposition === 'stop') {
    info(renderScopeRefusal(claim));
    return null;
  }

  // 3 ── the ORDER, from edges rather than from readiness, read ONCE.
  const edges = await readScopeEdges(
    client,
    target.kind === 'work_item'
      ? { kind: 'work_item', key: target.key }
      : { kind: 'sprint', sprintId: claim.scope.sprintId ?? '' },
    projectKey,
  );

  info(renderClaimedScope(claim, ready));
  return { claim, ready, edges };
}

/** How a scope is named in a sentence. */
function label(target: ScopeTarget): string {
  return target.kind === 'sprint' ? 'The active sprint' : target.key;
}

/**
 * Re-read the container's CURRENT children, immediately before the close-out
 * opens its pull request (Bug MOTIR-3268).
 *
 * ⚠️ THIS IS NOT A READY QUERY, AND THE DISTINCTION IS THE WHOLE INVARIANT. The
 * drain never asks what is ready after the claim, because a mid-flight ready read
 * would reintroduce the interleaving the up-front claim exists to prevent. This
 * asks something the claim never promised and never could: whether the CONTAINER
 * still has the children it had at t=0. `motir run` can file a bug under exactly
 * this container while the drain is running (MOTIR-3017), so the t=0 snapshot is
 * a statement about the past by the time the pull request is opened.
 *
 * ⚠️ ONE CALL, AFTER THE DRAIN. `get_work_item` returns every child row with its
 * status, so the whole answer costs one round-trip at a moment the run is already
 * talking to the server — and it happens where no agent is running, so it cannot
 * perturb the order the drain computed.
 *
 * A SPRINT scope has no container to re-read: it spans several parents at mixed
 * depths, and its pull request claims nothing about any one of them. It answers
 * `null` — "there is no container here", which is a different statement from "the
 * container has no open children" and must not be collapsed into it.
 */
export async function readOpenChildren(
  client: MotirClient,
  target: ScopeTarget,
): Promise<{ containerKey: string; openChildren: string[] } | null> {
  if (target.kind !== 'work_item') return null;
  const detail = await client.getWorkItem(target.key);
  return {
    containerKey: detail.item.identifier,
    openChildren: childrenBelowClaimBar(detail.children),
  };
}

/**
 * A `wrong_shape` story is RE-PLANNED, once, and the run stops.
 *
 * ⚠️ SUBMITTED ONCE, AND DETACHED. The plan job runs server-side and its output
 * is a set of PROPOSALS a human approves in Motir; a run that waited would be
 * waiting on a person, which is precisely what MOTIR-3001's boundary says a
 * scoped run never does. Once, because retrying against a shape the server just
 * refused would submit the same plan repeatedly.
 *
 * ⚠️ `--disable-replan` SUPPRESSES THE WRITE, NOT THE DIAGNOSIS. The offending
 * child and its depth are printed either way (the caller has already done that):
 * the operator asked not to have a plan submitted on their behalf, not to be
 * kept in the dark. Same meaning MOTIR-3017 gave the flag on the per-card path.
 *
 * A failed submit is REPORTED and does not become the run's problem — the shape
 * finding is the valuable thing here and it has already been printed.
 */
async function submitShapeReplan(
  client: MotirClient,
  serverUrl: string,
  projectKey: string,
  target: ScopeTarget,
  opts: ScopeRunOptions,
): Promise<void> {
  if (opts.disableReplan || target.kind !== 'work_item') {
    info('No re-plan was submitted (--disable-replan). Re-shape the story yourself, then re-run.');
    return;
  }
  try {
    const { planId } = await client.submitPlanSession({ projectKey, targetKeys: [target.key] });
    const url = planReviewUrl(serverUrl, planId);
    info(
      [
        `Submitted a re-plan of ${target.key} — it is waiting for you in Motir.`,
        `  ${url ?? planId}`,
        'Nothing was claimed and nothing was built. Approve the plan, then re-run the story.',
      ].join('\n'),
    );
  } catch (err) {
    info(
      [
        `The re-plan could not be submitted: ${err instanceof Error ? err.message : String(err)}`,
        'The shape finding above still stands — re-shape the story by hand, then re-run it.',
      ].join('\n'),
    );
  }
}

/**
 * What `motir run <scope>` should do with the argument it was handed.
 *
 * ⚠️ THREE OUTCOMES, NOT TWO. An earlier shape returned the scope target or
 * `null`, with `null` meaning "fall through to the leaf path" — and then
 * `--include-planning`, which triggers an expansion and is DONE, had no way to
 * say so. It returned `null` too, and the run went on to claim and dispatch the
 * childless container it had just decided not to run. `stop` is the third
 * answer, spelled out so it cannot be confused with the first again.
 */
export type ScopeDecision =
  /**
   * Not a scope — the caller runs today's single-card path, unchanged.
   *
   * ⚠️ IT CARRIES THE DETAIL IT READ. The leaf path needs the same
   * `getWorkItem` this decision was made from, and re-reading it would put a
   * second round-trip on the COMMON path — the one every dispatched card takes
   * — to save threading one value through one signature. Handing it back is
   * what makes the branch genuinely free.
   */
  | { action: 'leaf'; detail: WorkItemDetail }
  /** Run these leaves. A work-item scope carries the target's own verdict
   *  from the same read, so `--allow-soft-block` never re-fetches it — and its
   *  TITLE, which the session pull request is named for (MOTIR-10985). */
  | {
      action: 'scope';
      target: ScopeTarget;
      readiness?: WorkItemDetail['readiness'];
      title?: string;
    }
  /** Handled here; the run is over and nothing further should happen. */
  | { action: 'stop' };

/**
 * Decide whether `motir run <key>` is a scoped run or today's single-card
 * dispatch, and refuse the two shapes that are neither.
 *
 * The one read it makes — `getWorkItem` — is the read `runCommand` already makes
 * first, so the branch costs nothing.
 */
export async function resolveScopeTarget(
  client: MotirClient,
  raw: string,
  opts: ScopeRunOptions,
  serverUrl: string,
): Promise<ScopeDecision> {
  const target = parseScopeArgument(raw);
  if (target.kind === 'sprint') return { action: 'scope', target };

  const detail = await client.getWorkItem(target.key);
  const shape = classifyScopeTarget({
    kind: detail.item.kind,
    childCount: detail.children.length,
  });

  if (shape.kind === 'leaf') return { action: 'leaf', detail };
  if (shape.kind === 'scope') {
    return { action: 'scope', target, readiness: detail.readiness, title: detail.item.title };
  }
  if (shape.kind === 'refuse_epic') {
    const { message, hint } = epicRefusal(detail.item.identifier);
    throw new CliError(message, { hint });
  }

  // A childless container. `--include-planning` turns the refusal into the one
  // action that could fix it — the SAME meaning the flag has in `motir auto`:
  // trigger the expansion, say so, and never wait, because what comes back is a
  // plan a human must approve. Then STOP: there is still nothing under this
  // container to run, and the plan is not this run's to approve.
  if (opts.includePlanning) {
    await triggerScopeExpansion(client, serverUrl, detail.item.identifier);
    return { action: 'stop' };
  }
  const { message, hint } = unexpandedRefusal(detail.item.identifier);
  throw new CliError(message, { hint });
}

/** Fire an expansion for a childless container and report where to review it. */
async function triggerScopeExpansion(
  client: MotirClient,
  serverUrl: string,
  key: string,
): Promise<void> {
  try {
    const { planId } = await client.expandItem(key);
    const url = planReviewUrl(serverUrl, planId);
    info(
      [
        `${key} had no children — an expansion was triggered instead of running it.`,
        `  ${url ?? planId}`,
        'Nothing waits for it: the plan needs your approval before there is anything to run.',
      ].join('\n'),
    );
  } catch (err) {
    info(
      `${key} had no children, and the expansion could not be submitted: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
