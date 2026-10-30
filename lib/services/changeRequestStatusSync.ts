import { Prisma, type GithubInstallation, type GithubRepo } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type {
  ChangeRequestLifecycle,
  GitProviderId,
  NormalizedChangeRequest,
} from '@/lib/git/types';
import { changeRequestNoun } from '@/lib/git/labels';
// The provider REGISTRY — `resyncLinkedPullRequest` asks the seam for the
// lifecycle its synthesized change request maps to, rather than stating one as a
// literal (MOTIR-5002).
import { getGitProvider } from '@/lib/git';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import {
  deliveryMembersOf,
  deliverySetShortfall,
  hasDeliverySetShortfall,
  EMPTY_DELIVERY_SHORTFALL,
  type DeliverySetShortfall,
} from '@/lib/workItems/deliverySet';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import {
  withdrawPullRequestApprovalGatesOnClose,
  withdrawPullRequestApprovalGatesOnDraft,
} from './pullRequestApprovalGates';
import { promoteDeliveredCardsOnGreen } from './ciPromotion';
import {
  resolveChangeRequestWorkItemSet,
  resolveDeliveredWorkItems,
  type ChangeRequestWorkItemSet,
} from './changeRequestWorkItems';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { commentsService } from './commentsService';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { CompleteSessionItemResultDto } from '@/lib/dto/workItems';
import {
  ContainerHasOpenChildrenError,
  ApprovalGatePendingError,
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  MarkedCardCannotReopenError,
  PlanTargetHeldError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { NO_ARTIFACT_MARKER } from '@/lib/workItems/artifactEvidence';
import {
  DeliveredItemsTransitionFailedError,
  type DeliveredItemTransitionFailure,
} from '@/lib/git/errors';

// The provider-agnostic change-request → work-item status-sync state machine
// (Story 7.10 · MOTIR-892, generalized for GitLab in Story 7.23 · MOTIR-1475).
// This is THE ONE status-sync path: both the GitHub webhook (`githubWebhookService`)
// and the GitLab webhook (`gitlabWebhookService`) normalize their host's
// merge/pull-request payload through the shared `GitProvider` seam and hand the
// resulting `NormalizedChangeRequest` here. Nothing below is host-specific — the
// two providers differ ONLY in how they resolve the connection + repo + author
// from their raw payload (GitHub keys on its App installation id; GitLab keys on
// the project id, and has no bound-identity table), which each provider supplies
// through the `resolveContext` callback. There is deliberately no second, divergent
// sync path (the MOTIR-1475 rule).
//
// Every status write goes through the shipped `workItemsService.updateStatus` (the
// write-authority rule) under `withSystemContext` (the webhook has no active
// workspace — the trusted-writer RLS escape), attributed to the change request's
// author when they are a bound workspace member, else the workspace owner (the
// automation-engine precedent). The transition itself runs AFTER the resolve tx,
// in its own transaction, exactly as the GitHub path always did.
//
// ⚠️ COMPLETION IS GATED THREE TIMES, and every gate says "a merge event is not proof the
// deliverable shipped" (they are the same lesson at three different scopes):
//   * MOTIR-1604 — the merge must be the item's LAST open linked change request,
//     else a cross-repo two-PR card completes on half its work.
//   * MOTIR-1873 — the merge must have landed on the repository's DEFAULT branch,
//     else a change request STACKED on a sibling's branch completes while its code
//     sits on a dead branch with no path to the trunk. GitHub reports MERGED for
//     that merge, truthfully; the trunk is the only witness that matters.
//   * MOTIR-3659 — every change request DELIVERING the item (its linked set) must
//     have merged onto its own repository's default branch.
// All three HOLD the item at In Review rather than transitioning, and all three
// report a distinct outcome — never a silent no-op, because invisibility was the
// whole cost of MOTIR-1873's incident.
//
// ⚠️ THE REPOSITORY-SET GATE (MOTIR-2729) IS NOT ASKED HERE ANY MORE (MOTIR-10135).
// It held the item until every repository on `work_item.targetRepos` had a merged
// linked change request, which read a planning guess — where the work MIGHT land —
// as a promise that each repository gets a pull request. Runs routinely find one
// listed repository needs nothing, and the item was then held at In Review after
// all of its real work had merged (MOTIR-7180, MOTIR-8811, MOTIR-9235 and
// MOTIR-10135 each met a different route into that hold). Completion now counts
// the item's LINKED change requests: once one has landed on its trunk, the
// delivery set decides alone (`hasLandedDelivery`). A merge this sync decides
// completion for is always such a delivery — the item is linked to it, and a
// merge that missed the trunk was already held above — so the repository set
// would always abstain here and is not read. The trade-off is accepted: a
// two-repository card whose run never opened its second pull request completes on
// the first merge (MOTIR-2664's shape). Opening every pull request the work needs
// is the run's job; the list is not a promise. `repoSetCompletionService` still
// asks the set for an item with NO landed delivery.
//
// ⚠️ A FOURTH HOLD IS DECIDED ELSEWHERE, and forgetting that cost a production
// incident (MOTIR-3364). MOTIR-2709's artifact-evidence gate lives inside
// `applyStatusTransition`, not up here, so it reaches this module only as a thrown
// error — and `classifyTransitionError` had no arm for it, so it RETHREW: a 500 on
// a successful merge delivery, and a `deploy` card parked at In Review with nothing
// on it to say why. The rule the three gates above state is not "these three are
// visible"; it is that EVERY hold is. `STATUS_TRANSITION_REFUSALS` is now the one
// list of what that authority can refuse, and both merge-driven consumers read it.

/** The concrete workflow target a canonical change-request lifecycle maps to.
 *  `key` is the CANONICAL status key we prefer; `category` is the fallback bucket
 *  when a custom workflow renamed the key — so we resolve BY category, never a
 *  hard-coded status id. Note the seam's canonical `todo` (closed-unmerged) maps
 *  to Motir's `in_progress`: the work was abandoned, not finished, AND the only
 *  LEGAL move from `in_review` (the default workflow has an `in_review →
 *  in_progress` edge but no `in_review → todo`). The seam emits the
 *  provider-agnostic signal; this consumer picks the concrete status. */
/** The default key the OPENED lifecycle writes, and the default statuses past it
 *  that MOTIR-5630's backfill gave an edge back into it. */
const IMPLEMENTED_KEY = 'implemented';
const PAST_IMPLEMENTED: ReadonlySet<string> = new Set(['in_review', 'approved']);

const LIFECYCLE_TARGET: Record<
  ChangeRequestLifecycle,
  { key: string; category: StatusCategoryDto }
> = {
  // OPENED (MOTIR-3005). The `category` fallback is what a CUSTOM workflow with
  // no `implemented` status lands on — the same in-progress bucket `in_review`
  // resolved to before, so such a project keeps exactly the behaviour it had.
  implemented: { key: 'implemented', category: 'in_progress' },
  done: { key: 'done', category: 'done' },
  todo: { key: 'in_progress', category: 'in_progress' },
};

/** The status-sync result — the canonical change-request outcome, shared by both
 *  providers. The `event: 'pull_request'` tag is the internal name for "a change
 *  request drove a status move" (a PR on GitHub, an MR on GitLab); it is for
 *  logging / test assertions, not a wire contract. */
export type ChangeRequestSyncResult = {
  event: 'pull_request';
  outcome:
    | 'transitioned'
    | 'session_closed' // a merged SESSION-branch delivery — every card on the branch closed (MOTIR-3007)
    | 'delivery_applied' // ONE pull request delivered SEVERAL cards — read `deliveredItems` (MOTIR-3721)
    | 'noop'
    | 'deferred_incomplete_delivery_set' // a pull request DELIVERING this item has not landed — item stays In Review (MOTIR-3659)
    | 'deferred_open_pr' // a merge that is NOT the item's last open linked change request — item stays In Review (MOTIR-1604)
    | 'deferred_non_default_base' // a merge into a NON-default base — the work never reached the trunk, item stays In Review (MOTIR-1873)
    | 'missing_artifact_evidence' // a `deploy` item whose comments record no published artifact — item stays where it is (MOTIR-2709 / MOTIR-3364)
    | 'no_work_item'
    | 'no_matching_status'
    | 'illegal_transition'
    | 'open_children' // the item is a CONTAINER whose own children are not landed — it stays where it is (MOTIR-3229)
    | 'approval_pending' // an `awaiting` approval gate owns the target status — the merge waits for the decision (MOTIR-5526)
    | 'plan_held' // an UNDECIDED plan holds the item at `planning` — the merge moves nothing until the plan is decided (MOTIR-6265)
    | 'marked_held' // the item carries an OBSOLESCENCE mark, and a marked card stays finished — the merge never reopens it (MOTIR-6672)
    | 'access_denied'
    | 'unknown_installation'
    | 'unknown_repo'
    | 'ignored_action'
    | 'no_lifecycle_change' // an OPEN DRAFT — the delivery is RECORDED, nothing is transitioned (MOTIR-4968)
    | 'malformed';
  workItemId?: string;
  toStatus?: string;
  /** The session branch a `session_closed` delivery closed out (MOTIR-3007). */
  sessionBranch?: string;
  /** How the session close-out went, per item: moved to done / already there /
   *  reported-and-skipped. Present only on `session_closed`, because a delivery
   *  that closes N cards has to SAY N — reporting one of them is what this
   *  outcome exists to stop. */
  sessionItems?: { completed: number; alreadyDone: number; failed: number };
  /** Every card this delivery decided, with that card's OWN outcome (MOTIR-3721).
   *
   *  Present only when the pull request delivers MORE THAN ONE card — a delivery
   *  that decides N cards has to SAY N, and reporting one of them is the defect
   *  the delivery table exists to remove. Absent on the ordinary one-card
   *  delivery, whose single outcome IS the result's own, so nothing that reads
   *  `outcome` / `workItemId` changes shape for the case that is nearly all of
   *  them. Same instrument as `sessionItems`, at the per-card grain the linked
   *  arm needs. */
  deliveredItems?: DeliveredItemResult[];
};

/** One delivered card's own verdict — its id, what happened to it, and the status
 *  it moved to when it moved. */
export interface DeliveredItemResult {
  workItemId: string;
  outcome: ChangeRequestSyncResult['outcome'];
  toStatus?: string;
}

/** One delivered card carried from the resolve transaction to the tail: its
 *  identity, its current status, and the two ITEM-SCOPED gate verdicts computed
 *  under the row lock. Everything pull-request-scoped (the base ref, the actor,
 *  whether the merge was already recorded) is shared and lives beside it. */
interface ItemDecision {
  workItemId: string;
  projectId: string;
  currentStatus: string;
  deliveryShortfall: DeliverySetShortfall;
  hasOtherOpenLinkedPr: boolean;
}

/** The connection + repo + resolved author a provider hands the shared sync, once
 *  it has resolved them from its own payload shape. The TENANT comes from
 *  `repo.workspaceId` (MOTIR-1931), never from `installation.workspaceId` — the
 *  installation selects which mirror rows a delivery may touch, the repo row says
 *  whose they are, and a shared provisioning installation has no workspace of its
 *  own. `authorBoundUserId` is the change-request author's Motir user id ONLY when
 *  they are a member of THAT workspace (so the edit gate passes) — null otherwise
 *  (the sync then attributes to the workspace owner). GitLab always passes null
 *  (it has no bound-identity table). */
export interface ChangeRequestSyncContext {
  installation: GithubInstallation;
  repo: GithubRepo;
  authorBoundUserId: string | null;
}

/** What a provider's `resolveContext` returns: the resolved context, or a typed
 *  "couldn't resolve" reason the sync surfaces as a clean no-op outcome. */
export type ChangeRequestContextResolution =
  | ({ kind: 'resolved' } & ChangeRequestSyncContext)
  | { kind: 'unknown_installation' }
  | { kind: 'unknown_repo' };

/**
 * Drive the linked work item's status from one normalized change-request event.
 * `resolveContext` runs INSIDE the resolve transaction and maps the provider's raw
 * payload to `{ installation, repo, authorBoundUserId }` (or a "couldn't resolve"
 * reason). Idempotent under redelivery: a re-applied transition is a no-op, and the
 * change-request row upsert converges (a concurrent-redelivery unique-constraint
 * race is caught and re-read).
 */
export async function syncChangeRequestStatus(
  cr: NormalizedChangeRequest,
  lifecycle: ChangeRequestLifecycle | null,
  resolveContext: (tx: Prisma.TransactionClient) => Promise<ChangeRequestContextResolution>,
): Promise<ChangeRequestSyncResult> {
  const effects: SyncEffects = { becameReady: null };
  const result = await syncOnce(cr, lifecycle, resolveContext, effects);

  // ⚠️ A DRAFT MARKED READY RE-ASKS THE MERGE QUESTION (MOTIR-5699). A draft is not a
  // merge candidate, so a draft that went green raised no gate — and marking it ready
  // brings no check event with it, because CI has already spoken for this head. So the
  // flip is itself the green verdict arriving, and it goes through the SAME door a
  // green check does: it promotes the delivered cards at `implemented` and re-raises
  // for the ones already in review, running the post-raise review evaluation either
  // way. Idempotent: a card the transition above already promoted holds its gate, and
  // a non-green pull request is a no-op there.
  //
  // AFTER the sync, never inside it — the promotion opens its own transactions, and a
  // failure in it must not turn a recorded delivery into one the host retries forever
  // (`notes.html` #39, the rule every post-commit effect in this file follows).
  if (effects.becameReady) {
    const { changeRequestId, workspaceId, actorUserId } = effects.becameReady;
    await promoteDeliveredCardsOnGreen({ changeRequestId, workspaceId, actorUserId }).catch(
      (err: unknown) => {
        console.error('[changeRequestStatusSync] re-ask on ready_for_review failed', {
          changeRequestId,
          error: err instanceof Error ? err.message : 'unknown',
        });
      },
    );
  }
  return result;
}

/** What {@link syncOnce} learned that the caller acts on after it has returned. */
interface SyncEffects {
  becameReady: { changeRequestId: string; workspaceId: string; actorUserId: string } | null;
}

async function syncOnce(
  cr: NormalizedChangeRequest,
  lifecycle: ChangeRequestLifecycle | null,
  resolveContext: (tx: Prisma.TransactionClient) => Promise<ChangeRequestContextResolution>,
  effects: SyncEffects,
): Promise<ChangeRequestSyncResult> {
  // Phase 1 — resolve + persist under system context (one transaction): the
  // connection + repo (via the provider's resolver), the linked work item (from
  // the STORED link — MOTIR-3674 retired the head-ref / title parse), the
  // change-request row upsert, and the actor.
  const resolved = await withSystemContext(async (tx) => {
    const ctx = await resolveContext(tx);
    if (ctx.kind === 'unknown_installation') return { kind: 'unknown_installation' as const };
    if (ctx.kind === 'unknown_repo') return { kind: 'unknown_repo' as const };
    const { installation, repo, authorBoundUserId } = ctx;

    // ⚠️ BIND THE TENANT NOW — every statement below this line reads a table with
    // no `system_admin` arm (MOTIR-2880). `resolveContext` reached the CONNECTION
    // tier (`github_installation` / `github_repo`, whose policies read the system
    // flag) and that is what the system context is for; `work_item` and
    // `workspace_membership` are not in that set, so before this call the work-item
    // resolve returned NULL under `motir_app` and the sync silently stopped driving
    // any status. The binding is additive — the flag stays set, so the
    // `github_pull_request` lock/upsert below keeps its own arm.
    //
    // `repo.workspaceId`, never `installation.workspaceId` — the same tenancy rule
    // MOTIR-1931 pinned for the resolve itself, applied one layer down.
    await bindWorkspaceContext(tx, repo.workspaceId);

    // Resolve the change request's delivered work items — THE STORED LINKS, and
    // nothing else (MOTIR-3674). Lock the row, read it, and use the cards its
    // delivery rows name. There is no second arm: a delivery for a pull request
    // that carries no link resolves to no work item, whatever its head ref or
    // title says.
    //
    // ⚠️ WHAT WAS DELETED HERE, so the absence reads as a decision. The `else`
    // arm parsed `MOTIR-<n>` out of `${cr.headRef} ${cr.title}` and linked the
    // first candidate that resolved. That is a DIFFERENT question from the one
    // `link_pull_request` answers: the parse says *this text mentions this card*,
    // the link says *this pull request delivers this card*, and they coincide only
    // when the title happens to name the thing being delivered and nothing else.
    // A title naming the parent, a sibling, the bug being fixed or a rule being
    // cited is ordinary good writing, and every one of them mis-linked.
    //
    // ⚠️ THE GRANDFATHERING DECISION, kept as a record because the mechanism it
    // was about is gone. MOTIR-3674 chose to honour a STORED link however it was
    // made rather than only a `linkedManually` one: gating on the flag would have
    // orphaned every row the parse ever wrote — on production 1026 of 1096 linked
    // rows (70 were `linked_manually`), 1007 of them already merged. A stored link
    // is a link, and MOTIR-3657's backfill carried all 1096 into
    // `work_item_delivery` for exactly this reason, which is why MOTIR-3757 could
    // drop the column without losing one of them. What was retired is the
    // INFERENCE, not the history it produced.
    //
    // `linkedManually` survived that card as the record of HOW a link was made,
    // read by nothing here, and this comment said retiring it was its own
    // decision. MOTIR-4894 is that decision: with the inference gone every link
    // is declared, so the flag was true of every live write and told a reader
    // nothing — least of all on the Development row, where it labelled an agent's
    // own `link_pull_request` call "linked manually". The COLUMN outlives this
    // release by design (`docs/decisions/delivery-reader-migration.md` §6a); what
    // is gone is every reader and writer of it in application code.
    await githubPullRequestRepository.lockByRepoAndNumber(repo.id, cr.number, tx);
    const existingPr = await githubPullRequestRepository.findByRepoAndNumber(
      repo.id,
      cr.number,
      tx,
    );
    // ⚠️ `existingPr` IS STILL READ, and the lock above is still taken, though
    // the derivation they were written for is gone (MOTIR-4894 — the preserved
    // manual-override flag). What derives from this read now is
    // `mergeAlreadyRecorded` further down, which asks what the row said BEFORE
    // this delivery; that is read-then-write on the same row and needs the lock
    // exactly as the old one did.

    // Upsert the change-request row — the change-request→work-item link entity.
    // Idempotent under concurrent redelivery: a lost unique-`(repo,number)` race
    // throws P2002; catch it and re-write (the row the winner wrote is the same
    // state). `provider` stamps the row so the Development surface renders the
    // right host mark.
    const prRow = {
      provider: installation.provider,
      repoId: repo.id,
      number: cr.number,
      state: cr.state,
      merged: cr.merged,
      headRef: cr.headRef,
      // The branch this change request TARGETS (MOTIR-2729). Read from the live
      // payload one screen below to decide THIS delivery; persisted here because
      // the repository-SET gate asks the same question about merges that already
      // happened in other repositories, whose only record is this row.
      baseRef: cr.baseRef,
      title: cr.title,
      // Whether this delivery says the pull request is a DRAFT (MOTIR-5002).
      // THIS is the authoritative writer of the column: a delivery is the only
      // thing that ever sees the payload field, and before it was persisted the
      // fact died with the request that carried it. The LINK door then had to
      // guess, and guessed `false`.
      //
      // Written on EVERY delivery, not only the draft ones — the value flips both
      // ways (`ready_for_review`, and a pull request converted back to a draft),
      // so a write conditioned on `cr.draft` being true would leave the row
      // asserting a draft-ness the host had already retracted.
      draft: cr.draft,
      // The host's head commit (MOTIR-7005), written on every delivery that names one
      // — `synchronize` included — so `pullRequestHead` reads the pull request's own
      // head rather than the newest check row's commit. `undefined` (not asserted)
      // when the payload names none, which leaves the stored head alone.
      headSha: cr.headSha ?? undefined,
      // ⚠️ NO LINK IS WRITTEN HERE, and there is no longer a field to omit
      // (MOTIR-3721 stopped writing it, MOTIR-3757 dropped it). A delivery says
      // what a pull request IS; only `link_pull_request` says which cards it
      // delivers, and those rows live in `work_item_delivery`, which this upsert
      // does not touch. Nor is any PROVENANCE written: `linkedManually` used to
      // be carried through here so a delivery could not clear it, and MOTIR-4894
      // retired the flag — an upsert that does not name the surviving column
      // leaves whatever the row already holds.
    };
    let prId: string;
    try {
      prId = (await githubPullRequestRepository.upsert(prRow, tx)).id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Converge: the concurrent winner wrote the same (repo, number); update to
      // reflect this delivery's state so the row is never left stale.
      prId = (await githubPullRequestRepository.upsert(prRow, tx)).id;
    }

    // A CLOSED pull request — merged or not — is a merge question nobody can answer
    // any more, so its awaiting merge gates are withdrawn in the transaction that
    // records the close (MOTIR-5515). This is also what retires a gate a crash left
    // awaiting between a merge and its decision: the merge delivery lands here.
    if (cr.state === 'closed') {
      // A closed member changes the set the card's one approve-to-merge gate asked
      // about (MOTIR-5482). The per-pull-request merge gate it used to withdraw
      // beside this retired with MOTIR-5611.
      await withdrawPullRequestApprovalGatesOnClose(prId, tx);
    } else if (cr.draft === true) {
      // An OPEN DRAFT is not a merge candidate (MOTIR-5699), so an awaiting
      // approve-and-merge gate over it asks a question the host cannot act on —
      // withdraw it, on `converted_to_draft` above all. Unconditional on the
      // previous row, so a gate raised before candidacy knew about drafts is
      // retired by the next delivery rather than living on.
      await withdrawPullRequestApprovalGatesOnDraft(prId, tx);
    }

    // MOTIR-3007 · MOTIR-3721 — WHICH ITEMS does this delivery carry? A `motir
    // auto` run integrates every card onto ONE session branch and opens ONE pull
    // request whose branch deliberately carries no `MOTIR-<n>`; and ANY pull
    // request may deliver several cards, which the link column could not express
    // at all. Both answers come from the one membership rule.
    //
    // ⚠️ THE SESSION ARM IS CONSULTED ONLY ON A `done` DELIVERY, and that is a
    // decision this card preserves rather than an accident of the old shape. Its
    // only consumer is the session CLOSE-OUT below, which is guarded by
    // `sessionBranch` and not by the lifecycle — so resolving the session arm on
    // an `opened` delivery would close a whole run's cards the moment its pull
    // request was created. The LINKED arm, by contrast, is consulted on EVERY
    // lifecycle, exactly as the link column was: that is the reader being moved.
    //
    // One indexed lookup inside the transaction already open, under the row lock
    // taken above, so a concurrent redelivery serializes on it as the gates do.
    const delivery: ChangeRequestWorkItemSet =
      lifecycle === 'done'
        ? await resolveChangeRequestWorkItemSet({
            workspaceId: repo.workspaceId,
            headRef: cr.headRef,
            githubPullRequestId: prId,
            tx,
          })
        : {
            kind: 'linked',
            sessionBranch: null,
            items: await resolveDeliveredWorkItems(prId, tx),
          };
    const sessionBranch = delivery.kind === 'session_branch' ? delivery.sessionBranch : null;
    // The per-card set. Empty on a session close-out: `completeSession` walks the
    // branch itself, so the item-scoped gates below have nothing to decide there.
    const delivered = delivery.kind === 'linked' ? delivery.items : [];

    // A delivery that resolves NEITHER a delivered item NOR a session branch is
    // the unchanged no-op it always was.
    if (delivered.length === 0 && !sessionBranch) return { kind: 'no_work_item' as const };

    // MOTIR-1873 — a merge only COMPLETES the item when it landed on the trunk.
    // Compare the change request's base against the MIRRORED default branch, never
    // a hard-coded `'main'`: a self-hoster's repo defaults to `master` / `trunk`
    // and must behave identically. Only a `done` delivery can complete, so this is
    // meaningless for any other lifecycle. PULL-REQUEST scoped — it is a fact
    // about this merge, so it holds every card the merge delivers alike.
    const mergedIntoNonDefaultBase = lifecycle === 'done' && cr.baseRef !== repo.defaultBranch;

    // ── THE TWO ITEM-SCOPED GATES, now evaluated PER DELIVERED CARD ──────────
    //
    // ⚠️ BOTH ARE SKIPPED ON A SESSION CLOSE-OUT, and that is a boundary
    // rather than an omission (MOTIR-3007): they answer "is THIS item finished",
    // and a session delivery closes N items whose delivery sets and sibling
    // change requests differ; `completeSession` walks the branch itself, so there
    // is no per-item exclusion to hand it. `delivered` is empty there, so the
    // loop below simply does not run. The branch-scoped gate above DOES still
    // run, and holds the whole close-out.
    //
    // Evaluating them per card is what MOTIR-3721 changes. They were always
    // per-card questions; there was only ever one card to ask them about, because
    // the resolve above was capped at one. The answers genuinely differ between
    // two cards on one pull request — different delivery sets, different
    // sibling pull requests — so each is decided on its own facts.
    const decisions: ItemDecision[] = [];
    for (const item of delivered) {
      // MOTIR-3659 — the item completes only when EVERY pull request DELIVERING
      // it has merged onto its own repository's default branch. Read from the
      // delivery link table, the one association the ADR settles on, inside THIS
      // transaction and under the row lock taken above.
      //
      // ⚠️ It ABSTAINS on an empty set, which is what keeps every card that
      // predates this table byte-identical: no links, no shortfall, no hold.
      const deliveryShortfall =
        lifecycle === 'done' && !mergedIntoNonDefaultBase
          ? deliverySetShortfall(
              deliveryMembersOf(await workItemDeliveryRepository.listByWorkItem(item.id, tx)),
            )
          : EMPTY_DELIVERY_SHORTFALL;

      // MOTIR-1604 — a merge only COMPLETES the item when it is the item's LAST
      // open delivering change request. A cross-repo (two-PR) card has >1; the
      // first merge must NOT flip Done while a sibling is still open. This row
      // was just upserted (closed, on a merge), so we count the item's OTHER open
      // DELIVERING change requests — non-zero means DEFER.
      const hasOtherOpenLinkedPr =
        lifecycle === 'done' && !mergedIntoNonDefaultBase
          ? (await workItemDeliveryRepository.countOtherOpenByWorkItem(item.id, prId, tx)) > 0
          : false;

      decisions.push({
        workItemId: item.id,
        projectId: item.projectId,
        currentStatus: item.status,
        deliveryShortfall,
        hasOtherOpenLinkedPr,
      });
    }

    const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(
      repo.workspaceId,
      tx,
    );
    // A draft MARKED READY — read against the row as it stood BEFORE this delivery,
    // under the lock above. `false` only: an unknown draft-ness is not a flip.
    const actor = authorBoundUserId ?? owner?.userId ?? null;
    if (cr.state === 'open' && cr.draft === false && existingPr?.draft === true && actor) {
      effects.becameReady = {
        changeRequestId: prId,
        workspaceId: repo.workspaceId,
        actorUserId: actor,
      };
    }
    return {
      kind: 'resolved' as const,
      workspaceId: repo.workspaceId,
      // EVERY card this delivery carries, each with its own three gate verdicts
      // (MOTIR-3721). Usually exactly one, which is why the tail below returns
      // that one card's result unchanged.
      decisions,
      // Non-null ⇒ this merge closes out a whole run's branch (MOTIR-3007).
      sessionBranch,
      provider: installation.provider as GitProviderId,
      defaultBranch: repo.defaultBranch,
      mergedIntoNonDefaultBase,
      // Whether the row ALREADY recorded this merge before this delivery — read
      // under the row lock taken above, so concurrent redeliveries serialize on it.
      // It is what keeps the stranded-merge note POSTED ONCE: the note describes a
      // merge event, and GitHub redelivers events freely.
      mergeAlreadyRecorded: existingPr?.state === 'closed' && existingPr.merged === true,
      actorUserId: authorBoundUserId ?? owner?.userId ?? null,
      ownerUserId: owner?.userId ?? null,
    };
  });

  if (resolved.kind === 'unknown_installation')
    return { event: 'pull_request', outcome: 'unknown_installation' };
  if (resolved.kind === 'unknown_repo') return { event: 'pull_request', outcome: 'unknown_repo' };
  if (resolved.kind === 'no_work_item') return { event: 'pull_request', outcome: 'no_work_item' };

  // ⚠️ NO LIFECYCLE TO APPLY — an OPEN DRAFT (MOTIR-4968). The seam returns `null`
  // for a pull request that exists and is explicitly not offered for review, and
  // this is where that answer is honoured.
  //
  // AFTER phase 1, never instead of it, and that ordering is the point: the
  // change-request row has ALREADY been upserted above, so the pull request is
  // recorded with its current state, head, base and title. That matters because a
  // draft is an OPEN LINKED pull request to every other reader — the
  // `deferred_open_pr` count that holds a multi-repository parent open, and the
  // Development surface — and skipping the delivery entirely would make it
  // invisible to both. What is skipped is the TRANSITION and everything downstream
  // of it.
  //
  // ⚠️ AND SKIPPING THE TRANSITION IS WHAT REMOVES THE SPURIOUS REFUSAL NOTE. A
  // draft opened by a scoped run is linked to its STORY, so the delivery used to
  // reach `applyTransition`, be refused by the container gate (`open_children` —
  // correctly, the children have not landed), and post a note through
  // `reportTransitionRefusal` describing a state that is entirely normal. There is
  // now nothing to refuse, so there is no note: a refusal note is worth something
  // only while it is rare.
  //
  // Not `noop`: that outcome means "already in the target status", which is a
  // different fact and is reached below with a `toStatus` this delivery has none of.
  if (lifecycle === null) return { event: 'pull_request', outcome: 'no_lifecycle_change' };

  // A merge that did NOT land on the default branch leaves the item where it is —
  // In Review, from its own PR-opened delivery (MOTIR-1873). The work merged
  // SOMEWHERE, so it is neither abandoned (which would be `todo`) nor complete;
  // the umbrella change request that eventually reaches the trunk fires its own
  // delivery and completes the item then.
  //
  // PULL-REQUEST scoped, so it is decided ONCE and holds every card the merge
  // delivers — and the note goes on EVERY one of them (MOTIR-3721): a card held
  // with nothing on it to say why is precisely the invisibility MOTIR-1873 paid
  // for, and it does not become acceptable for the second card of two.
  //
  // Checked BEFORE the actor gate and BEFORE MOTIR-1604's, on purpose. Before the
  // actor gate because holding the item must not depend on there being someone to
  // author a note — the note is the diagnosis, the hold is the correctness. Before
  // 1604's because this is the stronger statement: a merge with no path to the
  // trunk is not partial completion, it is none.
  if (resolved.mergedIntoNonDefaultBase) {
    // Never a silent no-op. Say WHICH base swallowed the merge, on the item
    // itself, where the next person to read the card (or the next `motir run`
    // that treats it as a prerequisite) will see it. Posted once per merge, and
    // best-effort: a failed note must not turn a correct hold into a 500 the host
    // retries forever.
    if (resolved.actorUserId && !resolved.mergeAlreadyRecorded) {
      for (const decision of resolved.decisions) {
        try {
          await commentsService.addComment(
            decision.workItemId,
            {
              bodyMd: strandedMergeCommentBody({
                noun: changeRequestNoun(resolved.provider),
                number: cr.number,
                baseRef: cr.baseRef,
                defaultBranch: resolved.defaultBranch,
              }),
            },
            { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
          );
        } catch (err) {
          console.error('[changeRequestStatusSync] stranded-merge note failed; item still held', {
            workItemId: decision.workItemId,
            number: cr.number,
            baseRef: cr.baseRef,
            error: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }
    return withDeliveredItems(resolved.decisions, {
      event: 'pull_request',
      outcome: 'deferred_non_default_base',
      ...(resolved.decisions[0] ? { workItemId: resolved.decisions[0].workItemId } : {}),
      ...(resolved.sessionBranch ? { sessionBranch: resolved.sessionBranch } : {}),
    });
  }

  if (!resolved.actorUserId)
    // No workspace owner and no bound author — nothing can author the move.
    return withDeliveredItems(resolved.decisions, {
      event: 'pull_request',
      outcome: 'access_denied',
      ...(resolved.decisions[0] ? { workItemId: resolved.decisions[0].workItemId } : {}),
    });
  const actorUserId = resolved.actorUserId;

  // ── The SESSION close-out (MOTIR-3007) ────────────────────────────────────
  // A merged delivery whose head ref is a session branch carrying work items
  // closes EVERY card on that branch, not the one a title happened to name.
  //
  // It runs through the shipped `completeSession` — the same authority
  // `motir done --session` calls — so every closure goes through
  // `applyStatusTransition` and records a revision, an item already `done` is an
  // idempotent no-op, and an item with no legal edge to `done` is REPORTED and
  // skipped rather than failing the delivery.
  //
  // IDEMPOTENT UNDER REDELIVERY by construction, with nothing added: the close-out
  // CLEARS `session_branch` as it goes, so a second delivery of the same merge
  // resolves an empty branch, falls through to the delivered-cards path, and finds
  // either no card at all or ones already in `done`. The same is true of a merge
  // that arrives after a human already ran `motir done --session`.
  //
  // ⚠️ IT MOVED ABOVE THE ITEM-SCOPED GATES (MOTIR-3721) and nothing changed by
  // it: `decisions` is EMPTY on a session resolution — the gates it used to sit
  // below all abstained there and returned early only for a delivered card — so
  // this branch was always the next thing a session delivery reached. Hoisting it
  // is what lets the loop below be unconditional.
  if (resolved.sessionBranch) {
    const summary = await closeOutSession(resolved.sessionBranch, {
      workspaceId: resolved.workspaceId,
      actorUserId,
      ownerUserId: resolved.ownerUserId,
    });
    return {
      event: 'pull_request',
      outcome: 'session_closed',
      sessionBranch: resolved.sessionBranch,
      sessionItems: summary,
    };
  }

  // ── EVERY DELIVERED CARD, one at a time (MOTIR-3721) ──────────────────────
  // Each card is decided on its OWN gate verdicts and moved through its OWN
  // project's workflow, so one card's hold, refusal or missing status never
  // decides another's. A pull request delivering one card — nearly every pull
  // request — takes exactly the path it always did and returns exactly the result
  // it always returned; the loop is what a second card costs.
  //
  // ⚠️ ONE CARD'S FAULT DOES NOT END THE LOOP (MOTIR-5587). Each card moves in its
  // own transaction, so a fault on card k — a transaction that could not start on a
  // starved pool, a connection reset — says nothing about card k+1. It used to
  // escape this loop, and every card after it was never attempted: `motir-ai#487`
  // delivered 36 cards, 11 moved and 25 stayed at In Review, with nothing on any of
  // them to say so. So a fault is caught PER CARD, reported ON that card, and the
  // loop goes on.
  //
  // ⚠️ AND THE DELIVERY STILL FAILS AFTERWARDS — that is not a leftover. A sync that
  // RETURNED lets the post-commit capture stamp `merged_at`, and a merged row with
  // `merged_at` is invisible to the open-delivery reconcile (MOTIR-5390), the one
  // thing that replays this delivery and finishes the job. Replaying is safe: a card
  // already in its target reads `noop`, and the failure note is posted once per merge.
  const perItem: DeliveredItemResult[] = [];
  const faults: DeliveredItemTransitionFailure[] = [];
  for (const decision of resolved.decisions) {
    try {
      perItem.push(
        await applyToDeliveredItem(cr, lifecycle, decision, {
          workspaceId: resolved.workspaceId,
          provider: resolved.provider,
          mergeAlreadyRecorded: resolved.mergeAlreadyRecorded,
          actorUserId,
          ownerUserId: resolved.ownerUserId,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      faults.push({ workItemId: decision.workItemId, message });
      console.error('[changeRequestStatusSync] transition faulted; continuing with the rest', {
        workItemId: decision.workItemId,
        number: cr.number,
        error: message,
      });
      if (!resolved.mergeAlreadyRecorded) {
        await noteTransitionFault(decision.workItemId, message, cr, {
          provider: resolved.provider,
          actorCtx: { userId: actorUserId, workspaceId: resolved.workspaceId },
        });
      }
    }
  }
  if (faults.length > 0) {
    throw new DeliveredItemsTransitionFailedError(cr.number, resolved.decisions.length, faults);
  }

  const [first, ...rest] = perItem;
  if (!first) return { event: 'pull_request', outcome: 'no_work_item' };
  if (rest.length === 0)
    return {
      event: 'pull_request',
      outcome: first.outcome,
      workItemId: first.workItemId,
      ...(first.toStatus ? { toStatus: first.toStatus } : {}),
    };

  // MORE THAN ONE, so there is no single outcome to report and reporting one of
  // them is the defect this card exists to remove. Same shape the session
  // close-out has used since MOTIR-3007: a delivery that decides N cards SAYS N.
  return {
    event: 'pull_request',
    outcome: 'delivery_applied',
    deliveredItems: perItem,
  };
}

/** Attach the per-card list to a shared, pull-request-scoped outcome — but only
 *  when there is more than one card to attach, so a single-card delivery reports
 *  exactly the shape it always did. */
function withDeliveredItems(
  decisions: readonly ItemDecision[],
  result: ChangeRequestSyncResult,
): ChangeRequestSyncResult {
  if (decisions.length < 2) return result;
  return {
    ...result,
    deliveredItems: decisions.map((d) => ({
      workItemId: d.workItemId,
      outcome: result.outcome,
    })),
  };
}

/**
 * Decide and apply ONE delivered card: the three item-scoped holds, then the
 * transition through the shipped authority.
 *
 * Extracted from the tail of `syncChangeRequestStatus` by MOTIR-3721 — every
 * gate, every note and every outcome is the shipped path's, unchanged. What
 * changed is that the caller can run it more than once, because a pull request
 * can deliver more than one card.
 */
async function applyToDeliveredItem(
  cr: NormalizedChangeRequest,
  lifecycle: ChangeRequestLifecycle,
  decision: ItemDecision,
  shared: {
    workspaceId: string;
    provider: GitProviderId;
    mergeAlreadyRecorded: boolean;
    actorUserId: string;
    ownerUserId: string | null;
  },
): Promise<DeliveredItemResult> {
  const { workItemId } = decision;
  const actorCtx = { userId: shared.actorUserId, workspaceId: shared.workspaceId };

  // MOTIR-3659 — a merge that leaves any pull request DELIVERING this item
  // unlanded holds the item In Review. FIRST of the three, because it is the most
  // specific answer available: a card that carries delivery links should be
  // decided by its links rather than fall through to a proxy for them.
  //
  // It abstains on a card with no links, so the two gates below are still the only
  // protection every card that predates this table has — which is nearly all of
  // them — and neither is weakened.
  if (lifecycle === 'done' && hasDeliverySetShortfall(decision.deliveryShortfall)) {
    // Never a silent hold, for the reason MOTIR-1873 already paid for. Posted once
    // per merge (the same `mergeAlreadyRecorded` read taken under the row lock) and
    // best-effort — a failed note must not turn a correct hold into a 500 the host
    // redelivers forever.
    if (!shared.mergeAlreadyRecorded) {
      try {
        await commentsService.addComment(
          workItemId,
          {
            bodyMd: incompleteDeliverySetCommentBody({
              noun: changeRequestNoun(shared.provider),
              number: cr.number,
              shortfall: decision.deliveryShortfall,
            }),
          },
          actorCtx,
        );
      } catch (err) {
        console.error('[changeRequestStatusSync] delivery-set note failed; item still held', {
          workItemId,
          number: cr.number,
          outstanding: decision.deliveryShortfall.outstanding,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return { workItemId, outcome: 'deferred_incomplete_delivery_set' };
  }

  // A merged change request that is NOT the item's last open delivering one leaves
  // the item In Review — a cross-repo (two-PR) card completes only when its LAST
  // delivering change request merges (MOTIR-1604).
  if (lifecycle === 'done' && decision.hasOtherOpenLinkedPr) {
    return { workItemId, outcome: 'deferred_open_pr' };
  }

  // Phase 2 — the status transition through the SHIPPED authority. Resolve the
  // concrete target status key by category against the project's live workflow.
  const targetKey = await workflowsService.resolveStatusKey(
    decision.projectId,
    shared.workspaceId,
    LIFECYCLE_TARGET[lifecycle],
  );
  if (!targetKey)
    // A custom workflow with no status in the target category — a logged no-op,
    // never a crash.
    return { workItemId, outcome: 'no_matching_status' };

  // Idempotent: already in the target (a redelivery) — updateStatus no-ops, but
  // short-circuit so the outcome reads `noop` rather than `transitioned`.
  if (decision.currentStatus === targetKey)
    return { workItemId, outcome: 'noop', toStatus: targetKey };

  // NEVER BACK OUT OF A VERDICT. `in_review → implemented` and
  // `approved → implemented` are declared edges since MOTIR-5630, for the
  // merge-queue ejection's system write and a person's hand move
  // (`approval-gates.md` §4 THIRD AMENDMENT, decision 7) — not for a pull request
  // being opened, reopened, marked ready or linked. Before those edges existed
  // the workflow refused this move, and the outcome stays the one it produced.
  if (targetKey === IMPLEMENTED_KEY && PAST_IMPLEMENTED.has(decision.currentStatus))
    return { workItemId, outcome: 'illegal_transition', toStatus: targetKey };

  const refusalContext = {
    workItemId,
    workspaceId: shared.workspaceId,
    actorUserId: shared.actorUserId,
    provider: shared.provider,
    mergeAlreadyRecorded: shared.mergeAlreadyRecorded,
  };

  try {
    await applyTransition(workItemId, targetKey, actorCtx);
  } catch (err) {
    // The bound author lacked edit rights (e.g. a viewer) — retry once as the
    // owner (a manager, always edit-capable). This keeps the sync working while
    // still PREFERRING the author for the activity-log attribution.
    if (
      err instanceof ProjectAccessDeniedError &&
      shared.ownerUserId &&
      shared.ownerUserId !== shared.actorUserId
    ) {
      try {
        await applyTransition(workItemId, targetKey, {
          userId: shared.ownerUserId,
          workspaceId: shared.workspaceId,
        });
      } catch (retryErr) {
        return toDeliveredItemResult(
          workItemId,
          await reportTransitionRefusal(retryErr, cr, refusalContext, targetKey),
        );
      }
      return { workItemId, outcome: 'transitioned', toStatus: targetKey };
    }
    return toDeliveredItemResult(
      workItemId,
      await reportTransitionRefusal(err, cr, refusalContext, targetKey),
    );
  }

  return { workItemId, outcome: 'transitioned', toStatus: targetKey };
}

/** Say ON the card that the merge could not move it (MOTIR-5587). Best-effort, like
 *  every note in this file: a note that fails must not stop the next card from
 *  being attempted. The fault is usually the database's, so this can fail for the
 *  same reason — the error the delivery throws afterwards still names the card. */
async function noteTransitionFault(
  workItemId: string,
  message: string,
  cr: NormalizedChangeRequest,
  shared: { provider: GitProviderId; actorCtx: { userId: string; workspaceId: string } },
): Promise<void> {
  try {
    await commentsService.addComment(
      workItemId,
      {
        bodyMd: transitionFaultCommentBody({
          noun: changeRequestNoun(shared.provider),
          number: cr.number,
          message,
        }),
      },
      shared.actorCtx,
    );
  } catch (noteErr) {
    console.error('[changeRequestStatusSync] transition-fault note failed', {
      workItemId,
      number: cr.number,
      error: noteErr instanceof Error ? noteErr.message : 'unknown',
    });
  }
}

/** The transition-fault note (MOTIR-5587) — posted on a delivered card whose move
 *  FAULTED, as opposed to one the workflow or a gate REFUSED (those have their own
 *  notes above). Same two obligations as its siblings: name the fact that answers
 *  *"why isn't this Done?"*, and state what will complete the item. It quotes the
 *  fault, so the reader is not sent to the server logs for it. */
function transitionFaultCommentBody(args: {
  noun: string;
  number: number;
  message: string;
}): string {
  // One line, and bounded: a Prisma message can carry a multi-line query dump.
  const fault = args.message.split('\n')[0]!.slice(0, 300);
  return (
    `⚠️ **Merged, but this item could not be moved** — ${args.noun} #${args.number} merged, ` +
    `and moving this item failed with an error, so its status is left unchanged:\n\n` +
    `> ${fault}\n\n` +
    `The other items this ${args.noun} delivers were still attempted. This one completes when ` +
    `the merge is replayed — Motir re-reads merged ${args.noun}s it could not finish, or the ` +
    `delivery can be redelivered from the provider — or when it is moved by hand.`
  );
}

/** Narrow a whole-delivery result back to the per-card slice — `reportTransitionRefusal`
 *  answers in the sync's own result shape, and a per-card refusal is one member of
 *  a delivery that may hold several. */
function toDeliveredItemResult(
  workItemId: string,
  result: ChangeRequestSyncResult,
): DeliveredItemResult {
  return {
    workItemId,
    outcome: result.outcome,
    ...(result.toStatus ? { toStatus: result.toStatus } : {}),
  };
}

/**
 * Classify a refused transition AND — for the refusals that leave no other trace
 * — say so ON THE CARD (MOTIR-3364).
 *
 * ⚠️ WHY THIS SITS BETWEEN THE CATCH AND `classifyTransitionError`. The two holds
 * decided BEFORE the transition (`deferred_non_default_base`,
 * `deferred_incomplete_delivery_set`) each post their own note inline, because the
 * facts they report — a base ref, a delivery list — are in hand there. The
 * artifact-evidence gate is decided INSIDE `applyStatusTransition`, so its refusal
 * only ever surfaces here, as an exception. Before this function it surfaced as a
 * rethrow: a 500 on a successful merge delivery, and a card silently parked at In
 * Review. The hold was right; only its shape was wrong.
 *
 * The note is posted under the SAME two conditions the other two use: once per
 * merge (`mergeAlreadyRecorded` — the host redelivers events freely), and
 * best-effort, because a failed comment must never turn a correct hold back into
 * the 500 this card exists to remove.
 */
async function reportTransitionRefusal(
  err: unknown,
  cr: NormalizedChangeRequest,
  resolved: {
    workItemId: string;
    workspaceId: string;
    actorUserId: string;
    provider: GitProviderId;
    mergeAlreadyRecorded: boolean;
  },
  targetKey: string,
): Promise<ChangeRequestSyncResult> {
  const result = classifyTransitionError(err, resolved.workItemId, targetKey);
  if (
    result.outcome === 'approval_pending' &&
    err instanceof ApprovalGatePendingError &&
    !resolved.mergeAlreadyRecorded
  ) {
    try {
      await commentsService.addComment(
        resolved.workItemId,
        {
          bodyMd: approvalPendingCommentBody({
            noun: changeRequestNoun(resolved.provider),
            number: cr.number,
            gateKind: err.gateKind,
          }),
        },
        { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
      );
    } catch (noteErr) {
      console.error('[changeRequestStatusSync] approval-pending note failed; item still held', {
        workItemId: resolved.workItemId,
        number: cr.number,
        error: noteErr instanceof Error ? noteErr.message : 'unknown',
      });
    }
  }
  if (result.outcome === 'plan_held' && !resolved.mergeAlreadyRecorded) {
    try {
      await commentsService.addComment(
        resolved.workItemId,
        {
          bodyMd: planHeldCommentBody({
            noun: changeRequestNoun(resolved.provider),
            number: cr.number,
          }),
        },
        { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
      );
    } catch (noteErr) {
      console.error('[changeRequestStatusSync] plan-held note failed; item still held', {
        workItemId: resolved.workItemId,
        number: cr.number,
        error: noteErr instanceof Error ? noteErr.message : 'unknown',
      });
    }
  }
  if (result.outcome === 'missing_artifact_evidence' && !resolved.mergeAlreadyRecorded) {
    try {
      await commentsService.addComment(
        resolved.workItemId,
        {
          bodyMd: missingArtifactEvidenceCommentBody({
            noun: changeRequestNoun(resolved.provider),
            number: cr.number,
          }),
        },
        { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
      );
    } catch (noteErr) {
      console.error('[changeRequestStatusSync] artifact-evidence note failed; item still held', {
        workItemId: resolved.workItemId,
        number: cr.number,
        error: noteErr instanceof Error ? noteErr.message : 'unknown',
      });
    }
  }
  return result;
}

/** The missing-artifact-evidence note (MOTIR-2709's gate, MOTIR-3364's note) —
 *  posted on the linked item when a merge cannot complete a `deploy` card because
 *  no comment on it records what was published.
 *
 *  It carries the same two obligations as its two siblings below: name the fact
 *  that turns *"why isn't this Done?"* into a one-minute answer, and state the
 *  condition that WILL complete the item, so the hold never reads as a stuck
 *  integration.
 *
 *  ⚠️ **THE NOTE MUST NOT SATISFY THE GATE IT EXPLAINS, and that is a live trap
 *  rather than a theoretical one.** The check is a string SCAN over every comment
 *  body on the card (`assessArtifactEvidence`), and this note is a comment on that
 *  card — so an illustrative `1.4.0` in the text is indistinguishable, to the
 *  scanner, from a version somebody recorded. Drafted that way it turned the
 *  second delivery of the same merge into a `done`: the hold posted its own way
 *  out, and a redelivery — which the host does freely — closed the card the gate
 *  had just refused. The examples here are therefore deliberately shaped to match
 *  NOTHING: the two prefixes carry no digest body (the matchers need 12+ hex / 20+
 *  base64 characters after them), and the version is named rather than shown.
 *  `NO_ARTIFACT_MARKER` is safe to quote inline because its own matcher is
 *  line-anchored for exactly this reason. `tests/github/changeRequestArtifactEvidenceGate.test.ts`
 *  asserts the rendered body scans as `missing`.
 *
 *  Like the others it describes what did NOT happen rather than asserting a
 *  status: the sync leaves the item exactly where it was. */
function missingArtifactEvidenceCommentBody(args: { noun: string; number: number }): string {
  return (
    `⚠️ **Merged, but this release recorded nothing** — ${args.noun} #${args.number} merged, ` +
    `and this is a \`deploy\` item whose deliverable lives outside the repository, so the merge ` +
    `is not proof it shipped. No comment here records an artifact, so the item's status is left ` +
    `unchanged.\n\n` +
    `It completes once a comment on this item carries the identifier a consumer would install — ` +
    `the published version number, a registry digest (\`sha256:\` followed by the digest) or an ` +
    `integrity hash (\`sha512-\` followed by the hash). If this deliverable genuinely has no ` +
    `identifier (a DNS cutover, a console toggle), say so in a comment beginning ` +
    `\`${NO_ARTIFACT_MARKER}\` followed by the reason.`
  );
}

/** The approval-pending note (MOTIR-5526) — posted on the linked item when a
 *  merge lands while an approval on it is still waiting, so the approval-gate
 *  guard holds the move to Done.
 *
 *  Same two obligations as its siblings: name the fact that answers *"why isn't
 *  this Done?"*, and state the condition that WILL complete the item. It
 *  describes what did NOT happen; the sync leaves the item where it was. */
/** The plan-held note (MOTIR-6265) — posted when a merge lands on an item an
 *  UNDECIDED plan holds at `planning`. Like every hold note here it describes what
 *  did NOT happen and names what will clear it, so the close-out sweep reads a
 *  decision rather than a stuck integration. */
function planHeldCommentBody(args: { noun: string; number: number }): string {
  return (
    `⚠️ **Merged, but a plan is open on this item** — ${args.noun} #${args.number} merged ` +
    `while an undecided plan was rewriting this item, so the merge does **not** move it — ` +
    `its status is left at **Planning**.\n\n` +
    `The plan decides what happens next: approving or declining it releases the item.`
  );
}

function approvalPendingCommentBody(args: {
  noun: string;
  number: number;
  gateKind: string;
}): string {
  return (
    `⚠️ **Merged, but an approval is still waiting** — ${args.noun} #${args.number} merged ` +
    `while a ${args.gateKind.replace(/_/g, ' ')} approval on this item had not been decided, ` +
    `so the merge does **not** move it to **Done** — its status is left unchanged.\n\n` +
    `It completes when that approval is approved in Motir: with the ${args.noun} merged, ` +
    `approving is what moves the item to Done.`
  );
}

/** The incomplete-DELIVERY-SET note (MOTIR-3659) — posted on the item when a merge
 *  lands while another pull request DELIVERING that item has not.
 *
 *  It names PULL REQUESTS that exist, never repositories the card lists: since
 *  MOTIR-10135 the repository list holds no merge, so the only thing a merged card
 *  can be waiting for is a delivery a reader can go and look at.
 *
 *  Like the stranded-merge note below it describes what did NOT happen rather than asserting
 *  a status: the sync leaves the item exactly where it was.
 *
 *  ⚠️ IT IS SILENT ABOUT AN ABANDONED DELIVERY, AND THAT IS A DECISION (MOTIR-5004).
 *  A closed, unmerged pull request no longer reaches any of the three lists, so it
 *  cannot be named here — and it should not be: this note's job is to say what the
 *  card is WAITING FOR, and the card is not waiting for it. Naming it would add a
 *  line to every note that cannot be acted on. The full delivery list, each row with
 *  its own state, is the Development section's job. Asserted in
 *  `changeRequestDeliverySetGate.test.ts` so the silence is a pinned decision rather
 *  than an omission a later reader has to guess at.
 *
 *  ⚠️ AND IT USED TO SAY "STILL OPEN" ABOUT A CLOSED PULL REQUEST, which is the
 *  defect MOTIR-5004 fixed one layer down. The sentence is unchanged; what changed is
 *  that `outstanding` now only ever contains genuinely open deliveries, so the words
 *  are true of every member it can be handed. */
function incompleteDeliverySetCommentBody(args: {
  noun: string;
  number: number;
  shortfall: DeliverySetShortfall;
}): string {
  const list = (names: string[]) => names.map((n) => `\`${n}\``).join(', ');
  const lines: string[] = [
    `⚠️ **Merged, but this item is not complete** — ${args.noun} ` +
      `#${args.number} merged, and another ${args.noun} delivering this item has not, ` +
      `so its status is left unchanged.`,
  ];
  if (args.shortfall.outstanding.length > 0) {
    lines.push(
      `Still open: ${list(args.shortfall.outstanding)} — ` +
        `${args.shortfall.outstanding.length === 1 ? 'it has' : 'they have'} not merged yet.`,
    );
  }
  if (args.shortfall.strandedBase.length > 0) {
    lines.push(
      `Merged, but not onto the trunk: ${list(args.shortfall.strandedBase)} — ` +
        `${args.shortfall.strandedBase.length === 1 ? 'it' : 'they'} landed on a base other ` +
        `than that repository's own default branch, so the work has not reached it. Merging ` +
        `that base forward is what completes this item.`,
    );
  }
  if (args.shortfall.unknownBase.length > 0) {
    lines.push(
      `No record of which branch the merge landed on for ${list(args.shortfall.unknownBase)} — ` +
        `Motir mirrored ${args.shortfall.unknownBase.length === 1 ? 'it' : 'them'} before it began ` +
        `recording base branches, so it cannot tell whether the work reached the trunk. An ` +
        `operator can repair this without a new merge — \`pnpm db:backfill:pr-base-ref\` reads ` +
        `the base back from the provider and re-runs this decision.`,
    );
  }
  lines.push(
    `The item completes when every ${args.noun} that delivers it has merged onto its own ` +
      `repository's default branch. If one of them does not in fact deliver this item, unlink it.`,
  );
  return lines.join('\n\n');
}

/** The stranded-merge note (MOTIR-1873) — posted on the linked item when a merge
 *  landed on a base other than the repository's default branch. It names the base
 *  that swallowed the merge, because that single fact is what turns "why isn't this
 *  Done?" into a one-minute answer, and states the condition that WILL complete the
 *  item so the hold never reads as a stuck integration.
 *
 *  It describes what did NOT happen rather than asserting a status: the sync leaves
 *  the item exactly where it was, and where that is depends on which of this change
 *  request's earlier deliveries were seen. */
function strandedMergeCommentBody(args: {
  noun: string;
  number: number;
  baseRef: string;
  defaultBranch: string;
}): string {
  return (
    `⚠️ **Merged, but not onto \`${args.defaultBranch}\`** — ${args.noun} #${args.number} ` +
    `merged into \`${args.baseRef}\`, which is not this repository's default branch. ` +
    `The code has not reached the trunk, so this merge does **not** move the item to ` +
    `**Done** — its status is left unchanged. It completes when a ${args.noun} carrying ` +
    `this work merges into \`${args.defaultBranch}\`; if \`${args.baseRef}\` has itself ` +
    `already been merged and deleted, the work is stranded and needs re-landing.`
  );
}

/** The work-item slice the change-request resolver returns — enough for the
 *  sync's transition decision and for the mirror's link column. */
export interface ResolvedChangeRequestWorkItem {
  id: string;
  /** `PROD-42` — carried so the shared delivery resolver (MOTIR-3007) can report
   *  the single-item path in the same shape as the session one. */
  identifier: string;
  projectId: string;
  status: string;
  /** The repositories this item lists — where its work may land. Since MOTIR-10135
   *  no merge reads it: completion counts the item's linked change requests. */
  targetRepos: string[];
}

/* ⚠️ `resolveChangeRequestWorkItem` — the head-ref / title PARSE — WAS HERE, and
 * is deleted by MOTIR-3674 along with `parseKeyCandidates` / `KEY_CANDIDATE_RE`.
 * Its MOTIR-1965 header argued that ONE resolver must serve both the live
 * delivery and the historical backfill, so the two could never drift. That
 * argument is kept and satisfied by removal: there is still exactly one rule, and
 * it is now `work_item_delivery` — a stored link, written by `link_pull_request`
 * or `mark_integrated`, never inferred from text. The backfill stops attributing rather than growing a parser of its own
 * (`historicalPullRequestBackfillService`, option A of the card).
 *
 * Recorded rather than silently deleted because the function was EXPORTED and its
 * absence is the decision: a reader who wants a title to link a pull request
 * again is re-opening MOTIR-3672, not filling a gap.
 */

/** Close out one session branch — every card a run integrated onto it (MOTIR-3007).
 *
 *  Attribution mirrors the single-item path exactly: the change request's author
 *  when they are a bound member with edit rights, else the workspace owner. The
 *  difference is HOW a denial surfaces — `completeSession` catches a per-item
 *  `ProjectAccessDeniedError` and reports the item as `failed` rather than
 *  throwing, so the single path's try/catch retry has nothing to catch. The retry
 *  is therefore driven off the RESULTS, and it is naturally scoped: a failed item
 *  still carries its branch (only a closed one is cleared), so the second pass
 *  sees exactly the items the first could not close and nothing else.
 *
 *  Returns the per-outcome counts, because a delivery that closes N cards has to
 *  say N — reporting one of them is the defect this whole card is about. */
async function closeOutSession(
  sessionBranch: string,
  actors: { workspaceId: string; actorUserId: string; ownerUserId: string | null },
): Promise<{ completed: number; alreadyDone: number; failed: number }> {
  const tally = (results: CompleteSessionItemResultDto[]) => ({
    completed: results.filter((r) => r.outcome === 'completed').length,
    alreadyDone: results.filter((r) => r.outcome === 'already_done').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
  });

  const first = await workItemsService.completeSession(sessionBranch, {
    userId: actors.actorUserId,
    workspaceId: actors.workspaceId,
  });
  const counts = tally(first.results);
  if (counts.failed === 0 || !actors.ownerUserId || actors.ownerUserId === actors.actorUserId) {
    return counts;
  }

  // The author could not close some of them (a viewer, typically). Retry as the
  // owner — a manager, always edit-capable — exactly as the single-item path does,
  // and merge the two passes: the second only ever sees the first's failures.
  const retry = await workItemsService.completeSession(sessionBranch, {
    userId: actors.ownerUserId,
    workspaceId: actors.workspaceId,
  });
  const retried = tally(retry.results);
  return {
    completed: counts.completed + retried.completed,
    alreadyDone: counts.alreadyDone + retried.alreadyDone,
    failed: retried.failed,
  };
}

/** The status write — through the shipped authority, never a raw update. */
async function applyTransition(
  workItemId: string,
  toStatusKey: string,
  ctx: { userId: string; workspaceId: string },
): Promise<void> {
  // `keepPendingQuestions`: a lifecycle move is not a person pulling the work back.
  // This sync withdraws the approve-to-merge gate BY SUBJECT
  // (`withdrawPullRequestApprovalGatesOnClose`), so the funnel's blanket rule-6
  // withdraw must not take a sibling pull request's question.
  await workItemsService.updateStatus(workItemId, toStatusKey, ctx, { keepPendingQuestions: true });
}

/** Map a transition failure to a logged no-op outcome — the webhook never crashes
 *  on a workflow that can't legally take the move. A truly unexpected error
 *  re-throws to the per-card loop in `syncOnce`, which records it, goes on to the
 *  next card, and fails the delivery once every card has been attempted
 *  (MOTIR-5587). GitHub does not redeliver a failed delivery by itself; the
 *  open-delivery reconcile (MOTIR-5390) is what replays it.
 *
 *  ⚠️ EVERY member of `STATUS_TRANSITION_REFUSALS` must have an arm here, and
 *  `tests/workItems/statusTransitionRefusals.test.ts` asserts it — the arms below
 *  are deliberately one-per-error rather than a single `isStatusTransitionRefusal`
 *  branch, because each refusal earns a DISTINCT outcome a log line can be read
 *  off. The predicate is what `completeSession` uses, where the reported shape is
 *  the same for all of them.
 *
 *  EXPORTED for that test, which needs to drive it with a constructed instance of
 *  each refusal; nothing else calls it from outside this module. */
export function classifyTransitionError(
  err: unknown,
  workItemId: string,
  toStatus: string,
): ChangeRequestSyncResult {
  if (err instanceof IllegalTransitionError)
    return { event: 'pull_request', outcome: 'illegal_transition', workItemId, toStatus };
  if (err instanceof UnknownStatusError)
    return { event: 'pull_request', outcome: 'no_matching_status', workItemId };
  if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError)
    return { event: 'pull_request', outcome: 'access_denied', workItemId };
  // The container-completeness gate (MOTIR-3229). A container whose own children
  // are not landed is a legitimate REFUSAL, not a fault: the sync leaves the item
  // where it is and says so, exactly as it does for a workflow with no legal edge.
  // Rethrowing would fail the webhook job and have the host retry it forever, on a
  // condition only a person adding work to the tree can clear. This is also the
  // shape MOTIR-1343 actually took — the PR-link automation moved the story to In
  // Review while two children sat at `todo`.
  if (err instanceof ContainerHasOpenChildrenError)
    return { event: 'pull_request', outcome: 'open_children', workItemId, toStatus };
  // The close-out artifact-evidence gate (MOTIR-2709). A `deploy` card whose
  // comments record no published artifact is a legitimate REFUSAL, like the two
  // above it: the merge happened, the release is unattested, and only a person can
  // clear that by recording what shipped. It reached this function as a RETHROW
  // until MOTIR-3364 — a 500 on a successful merge delivery, and a card left at In
  // Review with nothing on it to say why. `reportTransitionRefusal` posts that note.
  if (err instanceof MissingArtifactEvidenceError)
    return { event: 'pull_request', outcome: 'missing_artifact_evidence', workItemId, toStatus };
  // The approval-gate guard (MOTIR-5526; ADR `approval-gates.md` §6d AMENDMENT).
  // A merge that lands while a decision on the card is still `awaiting` is the
  // walk-around the guard exists to close: the sync is not `system` and is not
  // the deciding gate, so it is held like any other door. A REFUSAL, not a
  // fault — a person approving the gate clears it, and the approval then writes
  // the status itself, because no open pull request is left to defer to.
  if (err instanceof ApprovalGatePendingError)
    return { event: 'pull_request', outcome: 'approval_pending', workItemId, toStatus };
  // THE PLAN HOLD (MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21 §5(b)). The
  // merge derives a status from the card's OLD shape, which is exactly what an
  // undecided plan is replacing. A REFUSAL, recorded and never a failed delivery:
  // deciding the plan clears it, and the merge is already on the record.
  if (err instanceof PlanTargetHeldError)
    return { event: 'pull_request', outcome: 'plan_held', workItemId, toStatus };
  // A MARKED card stays finished (Story MOTIR-6575 · MOTIR-6672). A pull request
  // re-opened or re-pushed on a card someone has since marked outdated or
  // deprecated must not drag it back out of the done category. A REFUSAL,
  // recorded and never a failed delivery: a person clearing the mark clears it.
  if (err instanceof MarkedCardCannotReopenError)
    return { event: 'pull_request', outcome: 'marked_held', workItemId, toStatus };
  throw err;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Re-apply the sync for a pull request whose LINK has just arrived.
 *
 * ⚠️ WHY THIS EXISTS — the ordering the parse used to hide (Story MOTIR-3672).
 * A delivery resolves its card from the STORED link, and the link is written by
 * `link_pull_request` AFTER the pull request exists. In a real run those two
 * happen in this order: the agent runs `gh pr create`, GitHub delivers `opened`
 * within a second, and the agent's link call lands several seconds later. So the
 * `opened` delivery correctly finds no card and moves nothing — and under the
 * retired parse that never showed, because the title carried the key and the
 * delivery attributed itself.
 *
 * Without this, the card would sit in In Progress until the MERGE closed it,
 * silently skipping Implemented — the state MOTIR-2999 introduced to say "the
 * code is pushed and no build has spoken for it". The story's own acceptance
 * receipt asserts the card lands there from exactly this open-then-link
 * sequence, which is what surfaced the gap.
 *
 * So linking runs the sync the delivery could not: same function, same gates,
 * same outcomes. It is not a second status writer — every deferral, every repo-
 * and delivery-set check and every refusal comment is the shipped path's.
 *
 * ⚠️ ONLY WHERE A DELIVERY HAS ALREADY BEEN. The caller passes a pull request
 * whose row PRE-EXISTED the link; when the link is what created the row, no
 * delivery has arrived yet, there is nothing to catch up on, and the `opened`
 * delivery still to come does the transition itself. Resyncing there would move
 * the card early and leave that delivery reporting `noop` — a true statement
 * about a card that had already been moved by something other than the event
 * the outcome names.
 *
 * ⚠️ OPEN AND UNMERGED ONLY, and that is a decision rather than an omission. A
 * pull request that is already closed or merged reaches this through a `closed`
 * delivery, which carries the merge facts the completion gate reads; re-deriving
 * `done` from a link would let someone complete a card by attaching an old
 * merged pull request to it, which is a different feature and needs its own
 * argument. An open one asserts only what the link itself already says: this
 * code is being written for this card.
 *
 * Best-effort at the call site, like the check refresh beside it: the link is the
 * durable fact, this is a consequence of it, and a sync that cannot run must
 * never turn a recorded link into an error the caller sees.
 */
export async function resyncLinkedPullRequest(
  githubPullRequestId: string,
): Promise<ChangeRequestSyncResult | null> {
  const subject = await withSystemContext(async (tx: Prisma.TransactionClient) =>
    githubPullRequestRepository.findByIdWithInstallation(githubPullRequestId, tx),
  );
  if (!subject || subject.state !== 'open' || subject.merged) return null;
  // ⚠️ And a row with NO base ref does not resync. `baseRef` is nullable on the
  // stored row (rows written before it was captured) and REQUIRED on the
  // normalized shape, whose own contract is that a payload carrying no
  // destination does not normalize rather than defaulting to a guess. The
  // completion gate reads this field against the mirrored default branch, so a
  // guess here is not a cosmetic default — it is the difference between "reached
  // the trunk" and "merged onto a dead branch". `linkPullRequestByCoordinates`
  // always writes one, so this skips only rows an older delivery created.
  if (subject.baseRef === null) return null;
  // ⚠️ AND A ROW THAT DOES NOT KNOW ITS DRAFT-NESS DOES NOT RESYNC (MOTIR-5002) —
  // the same rule as the line above, for a column added for this reader.
  //
  // `draft` is nullable and never backfilled, so null means UNKNOWN: a row
  // mirrored before the column existed, or a placeholder this door's own create
  // arm wrote for a run that linked before any delivery arrived. Neither guess is
  // available. Reading it as `false` is the defect this card removes, and reading
  // it as `true` would strand a ready pull request's card. So the honest answer is
  // to decline, and it costs nothing where it fires: a placeholder row means no
  // delivery has landed yet, and the one still to come does the transition itself.
  if (subject.draft === null) return null;

  const cr: NormalizedChangeRequest = {
    providerRepoId: subject.repo.repoId,
    number: subject.number,
    state: 'open',
    merged: false,
    headRef: subject.headRef,
    baseRef: subject.baseRef,
    title: subject.title,
    // KNOWN, not assumed (MOTIR-5002). This field used to be pinned `false` with
    // a comment saying the stored row could not supply it — which was true, and
    // was the whole defect: a draft whose `opened` delivery had already landed (a
    // no-op, correctly) was flipped to `implemented` by a later
    // `link_pull_request`, asserting through the link door exactly what
    // MOTIR-4968 had just stopped the webhook door asserting. The row supplies it
    // now, and the null arm above is what keeps that supply honest.
    draft: subject.draft,
    // The stored head, echoed rather than guessed (MOTIR-7005); null writes nothing.
    headSha: subject.headSha,
  };

  // ROUTED THROUGH THE SEAM, not a literal (MOTIR-5002). The `'implemented'` this
  // used to pass was correct for as long as every open pull request meant
  // `implemented`, and it stopped being correct the moment a draft could mean
  // otherwise — with nothing connecting the two facts, because a literal consults
  // nothing. `changeRequestLifecycle` is the one place that mapping is decided,
  // and this door now asks it the same question the webhook door does, off a
  // `draft` it actually knows.
  //
  // Its answer here is exactly one of two, and both are wanted: `'implemented'`
  // for a ready pull request (the feature this function exists for, unchanged),
  // and `null` for a draft — which `syncChangeRequestStatus` honours by RECORDING
  // the delivery and transitioning nothing. The other two arms are unreachable
  // from here by the guards above (`merged` and `state: 'closed'` both return
  // early), so nothing about a merge is re-derived from a link.
  //
  // The provider comes off the REPO row, like every other per-repo read in this
  // file — a GitLab merge request reaches this door too if one is ever linked, and
  // its seam has its own draft arm.
  const lifecycle = getGitProvider(subject.repo.provider as GitProviderId).changeRequestLifecycle(
    cr,
  );

  return syncChangeRequestStatus(cr, lifecycle, async (tx) => {
    // The same bind the providers' own resolvers do, for the same reason: the
    // repo row is where the tenant is learned, and everything the sync reads
    // below it lives in tables with no `system_admin` arm (MOTIR-2880).
    await bindWorkspaceContext(tx, subject.repo.workspaceId);
    return {
      kind: 'resolved',
      installation: subject.repo.installation,
      repo: subject.repo,
      // The LINKER is not the pull request's author, and this argument names the
      // author. Passing null takes the documented owner-fallback attribution
      // rather than crediting the wrong person for opening the branch.
      authorBoundUserId: null,
    };
  });
}
