import 'server-only';
import type { ItemGatedRunDto } from '@/lib/dto/home';
import { resumeRunDetailService } from '@/lib/services/resumeRunDetailService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { commentsService } from '@/lib/services/commentsService';
import { activityService } from '@/lib/services/activityService';
import { attachmentsService } from '@/lib/services/attachmentsService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import type {
  PullRequestApprovalMemberDTO,
  PullRequestStandingExitDTO,
} from '@/lib/dto/approvalGate';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { howToTestService } from '@/lib/services/howToTestService';
import { decisionDocumentService } from '@/lib/services/decisionDocumentService';
import { choiceGateService } from '@/lib/services/choiceGateService';
import { decisionConfirmationGateService } from '@/lib/services/decisionConfirmationGateService';
import type { ChoiceBodyDTO, DecisionConfirmationBodyDTO } from '@/lib/dto/approvalGate';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { asksTheDecisionQuestion } from '@/lib/approvalGates/decisionDocument';
import type { DecisionDocumentViewDTO } from '@/lib/dto/decisionDocument';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import type { WorkItemRepairViewDto } from '@/lib/dto/workItemRepair';
import { workItemContinueService } from '@/lib/services/workItemContinueService';
import type { ContinuePartView } from '@/components/github/ContinuePart';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { agentReviewViewService } from '@/lib/services/agentReviewViewService';
import type { AgentReviewViewDto } from '@/lib/dto/agentReview';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { ActivityHistoryPageDto, ActivityAllPageDto } from '@/lib/dto/activity';
import type { AttachmentsPageDTO } from '@/lib/dto/attachments';
import type { DesignGateSubjectDTO } from '@/lib/dto/designEvidence';
import type { HowToTestDto } from '@/lib/dto/howToTest';
import type { ActivityTab } from '@/lib/activity/tab';
import type { DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

// The item page's LATE-TIER reads, as ONE promise (Subtask MOTIR-3436).
//
// ── Why one promise and not one per section ────────────────────────────────
// `design/work-items/design-notes.md` § *THE PAGE SETTLES TWICE* decides the
// late stack arrives as a SINGLE settle. Two `<Suspense>` boundaries await this
// one promise (a tier-2 section sits between them in the page's order), so they
// resolve in the same tick and flush together — the reader sees one arrival.
// Giving each section its own promise would make the page arrive five times in
// whatever order the reads happen to finish.
//
// ⚠️ `listRepoDelivery` is NOT here, deliberately. The Development section uses
// it, but so does the rail's Repositories card — and the rail is TIER TWO. A
// value two tiers need is read once, in the earlier tier, and passed down; the
// alternative is reading it twice or making the rail late to keep them together.
//
// ── Every read here is IDENTICAL to the one it replaced ────────────────────
// Same service, same method, same arguments, same actor. This module MOVES the
// calls off the page's critical path; it does not change them, and nothing under
// `lib/` is touched by the card that introduced it.
//
// ── The try/catch containment travels WITH the read ────────────────────────
// The activity page and the attachments page resolve to `null` on failure, and
// their sections render their own ErrorState + retry — exactly as they did when
// these reads sat inline. A boundary must not convert a caught failure into a
// thrown one, so the catches live here rather than being left to an `error.tsx`
// that would replace the whole item with a failure the reader cannot act on.

export interface LateReads {
  pullRequests: Awaited<ReturnType<typeof workItemsService.listLinkedPullRequests>>;
  commentCaps: Awaited<ReturnType<typeof projectAccessService.getCommentCapabilities>>;
  attachmentCaps: Awaited<ReturnType<typeof projectAccessService.getAttachmentCapabilities>>;
  initialComments: CommentsPageDTO | null;
  initialHistory: ActivityHistoryPageDto | null;
  initialAll: ActivityAllPageDto | null;
  initialAttachments: AttachmentsPageDTO | null;
  acceptanceEligibility: Awaited<
    ReturnType<typeof acceptanceVideoEligibilityService.resolve>
  > | null;
  acceptanceEvidence: Awaited<
    ReturnType<typeof acceptanceEvidenceService.getCurrentForStory>
  > | null;
  /**
   * The story's AWAITING `acceptance_result` gate, whether THIS reader may decide it,
   * and the stamp they were shown (MOTIR-4950) — what the acceptance panel's verbs
   * press, through the contract's one decide door. `gate: null` when nothing awaits.
   */
  acceptanceGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>>;
  /**
   * Whether the Acceptance section renders at all (MOTIR-5790): a story in review or
   * done, as before — OR any story holding a receipt, because on a single-card run
   * the story can still be In Progress while the recording already waits on it
   * (`approval-gates.md` §1, the MOTIR-5787 amendment, point 3).
   */
  showAcceptance: boolean;
  /** The item's own project — the acceptance panel's Turn on flips THIS project's
   *  switch (MOTIR-5172). Already resolved for the page; carried, never re-read. */
  projectId: string;
  designEvidence: Awaited<ReturnType<typeof designEvidenceService.getCurrentForWorkItem>>;
  isDesignCard: boolean;
  /**
   * The `design_result` approval gate for this card WHATEVER ITS STATE, whether
   * THIS actor may decide it, and — once it is decided — the version it was
   * decided ABOUT (Story MOTIR-4778 · Subtasks MOTIR-4792, MOTIR-5033).
   * `gate: null` when the card has never had one, which is the ordinary case
   * and renders exactly what the section rendered before the frame existed.
   *
   * ⚠️ `subject` IS READ FROM THE GATE, NOT FROM THE CARD, and that is the
   * whole of state `E`. `designEvidence` above is the CURRENT design; a decided
   * gate is about the bytes its decider was looking at, and a republish makes a
   * different row current. Feeding the port the current row would silently
   * re-point a finished decision at a version nobody approved — and the screen
   * would look completely right.
   */
  designGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    subject: DesignGateSubjectDTO | null;
  };
  /**
   * This card's runs, newest first (MOTIR-1796). `null` on a failed read — the
   * section renders its own state, per this module's containment rule.
   *
   * ⚠️ THE FIRST ROW IS THE CURRENT RUN, and that is load-bearing rather than a
   * convenience: it is what lets the section decide whether to open a stream
   * BEFORE it renders anything, so an item page for a card nobody is working
   * opens no connection at all.
   */
  runs: Awaited<ReturnType<typeof dispatchRunService.listRunsForWorkItemKey>> | null;
  /**
   * The LATEST run this work item was the SCOPE of (Story MOTIR-5363 · design
   * MOTIR-5402 panels 1–2) — what the Run section's *Run as a scope* block shows.
   *
   * ⚠️ A DIFFERENT QUESTION FROM `runs` ABOVE. `runs` is every run that had a LEG
   * on this item; a scoped run's legs are the container's CHILDREN, so a story
   * that was run as a scope has no row there and used to read *No runs yet*.
   *
   * `null` when the item has never been a scope, when the read failed (the block
   * is simply absent — the leg history still renders), and WITHOUT A QUERY for an
   * item with no children, because only a container can be a scope.
   */
  scopeRun: DispatchRunListItemDto | null;
  /**
   * The run's HOW TO TEST for this card (Story MOTIR-4906 · MOTIR-5336) — the
   * Development block's second part, rendered inside the same card below the
   * rows. `null` on a failed read: the block then renders the rows alone, which
   * is what the card rendered before, rather than an error in a card whose rows
   * still read fine.
   */
  howToTest: HowToTestDto | null;
  /**
   * The card's approve-and-merge gate (`pull_request_approval`) WHATEVER ITS STATE, or
   * `gate: null` — read exactly as `designGate` is, the same service and the same
   * containment (Story MOTIR-4909 · MOTIR-5484). A decided gate keeps its frame: the
   * merging, queued, merged, refused and withdrawn states all come after the decision,
   * and an awaiting-only read made the frame vanish the moment it was pressed.
   *
   * `members` — once the gate is APPROVED — is what a reload still knows about each pull
   * request of its set: whether its merge gate awaits, and whether the press queued it.
   */
  /**
   * The card's DECISION gate (`decision_approval`) WHATEVER ITS STATE, and the document it
   * asks about (Story MOTIR-4907 · Subtask MOTIR-5678; `design/github/design-notes.md`
   * §27). Read ONLY for a card that asks the decision question — `type: decision` decided
   * by an agent (clause 10) — so every other card makes neither read.
   *
   * ⚠️ THE DOCUMENT IS READ HERE, ON THE SERVER, through the resolver — outside any
   * transaction, because the production resolver calls the Git host. `document: null` is a
   * card with nothing captured yet; a failed read degrades to the gate alone, never to an
   * error across the late stack.
   */
  decisionGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    document: DecisionDocumentViewDTO | null;
  };
  /**
   * A CHOICE work item's question (Story MOTIR-4914 · MOTIR-5896) — the gate, read
   * exactly as `designGate` is, and the BODY's parse, gate or no gate, so the page
   * can render the defect state. `body: null` for any card that is not a choice, and
   * on a failed read (the section then does not render).
   */
  choiceGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    body: ChoiceBodyDTO | null;
    /** The body's work-item links, resolved for the reader (bug MOTIR-10023). */
    workItemRefs: WorkItemRefMap;
  };
  /**
   * A `human` DECISION work item's confirm question (Story MOTIR-5871 · MOTIR-5954) —
   * the gate, read exactly as `choiceGate` is, and the BODY's parse with the record it
   * would stamp, gate or no gate, so the page can render the defect state. `body: null`
   * for any card that is not a `human` decision, and on a failed read.
   */
  confirmGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    body: DecisionConfirmationBodyDTO | null;
    /** The body's work-item links, resolved for the reader (bug MOTIR-10023). */
    workItemRefs: WorkItemRefMap;
  };
  mergeGate: Awaited<ReturnType<typeof approvalGatesService.getForWorkItem>> & {
    members: PullRequestApprovalMemberDTO[];
    /** An `auto` card's standing merge-queue exits, read only when there is no gate
     *  (MOTIR-5635). */
    autoQueueExits: PullRequestStandingExitDTO[];
  };
  /**
   * What the Development block says about a REPAIR (Story MOTIR-5460 ·
   * MOTIR-5466, design `design/github` § 21) — the copyable `motir fix`, who is
   * fixing the card, or that the last fix gave up. `null` on a failed read: the
   * block then renders WITHOUT the fix part, never an error, like `howToTest`.
   */
  repair: WorkItemRepairViewDto | null;
  /**
   * What the Development block and the run section say about a run that DIED
   * (Story MOTIR-6526 · MOTIR-6534, design `design/runs` § Run died) — read through
   * the continue claim's own evaluation. `{ state: 'error' }` on a failed read:
   * the part then says so and offers the retry (Panel D8).
   */
  continueView: ContinuePartView;
  /**
   * The card's monitor-ERROR links (Story MOTIR-4932 · MOTIR-5732, design
   * `design/monitoring` §14). `null` on a failed read — the Errors section then
   * renders its own ErrorState, and only in a project that HAS a connection.
   * Read from the store the reconciler wrote: NO provider call on page load.
   */
  monitorIssueLinks: MonitorIssueLinkDto[] | null;
  /**
   * Whether the project binds at least one monitored project (§14 Decision 5) —
   * the half of the door rule `canEdit` does not answer. `false` on a failed
   * read: an absent door is the honest fallback, never a door that searches
   * nothing.
   */
  monitorHasConnection: boolean;
  /**
   * The run target's LATEST `agent_review` gate (Story MOTIR-1626 · MOTIR-6825; design
   * `design/github` § 30) — its state, findings, decider, could-not-run reason and review
   * run, read beside the other gate reads. `null` for a card that never had one, and on a
   * failed read: the block then renders as it did before the review agent existed.
   */
  agentReview: AgentReviewViewDto | null;
  /**
   * The card's GATED run (Story MOTIR-7701 · MOTIR-7713; `design/runs` § _Stopped at a
   * gate_) — the run section's marker in the Run died line's slot: waiting, ready to
   * resume, or resuming. `null` when the card does not wait, and on a failed read (the
   * section then renders as it did before the marker existed).
   */
  gatedRun: ItemGatedRunDto | null;
}

export interface LateReadsInput {
  itemId: string;
  itemType: string | null;
  /** Who decides the card — with `itemType`, whether it asks the decision question.
   *  Absent is a card that does not: no decision read is made. */
  itemExecutor?: string | null;
  itemStatus: string;
  itemKind: string;
  projectId: string;
  ctx: ServiceContext;
  /**
   * The reader the ACTIVITY reads (comments, history, all) take: the member's
   * `ctx`, or a Visitor's read context (MOTIR-6648), which withholds a private
   * epic's descendants from every entry and chip. Defaults to `ctx`.
   */
  activityReader?: ServiceContext | VisitorReadContext;
  /** The full dispatch context the repo-delivery + PR reads take verbatim. */
  fullCtx: Parameters<typeof workItemsService.listLinkedPullRequests>[1];
  activityTab: ActivityTab;
  canEdit: boolean;
  /** The card's `MOTIR-<n>`, which the run history is keyed by. */
  itemIdentifier: string;
  /** The project's key — the scoped run read is addressed by it. */
  projectKey: string;
  /**
   * Whether the item has children. Only a container can be a run's scope — the
   * CLI records one only on its `run_scope` path, which claims a container — so a
   * leaf makes no scope read at all.
   */
  hasChildren: boolean;
}

const NO_DECISION_GATE: LateReads['decisionGate'] = {
  gate: null,
  canDecide: false,
  routedToLabel: null,
  earlierApproval: null,
  settingsDoor: null,
  stamp: null,
  movedSince: [],
  document: null,
};

/** The decision gate and its document (MOTIR-5678) — contained like every late read. */
async function readDecisionGate(input: LateReadsInput): Promise<LateReads['decisionGate']> {
  if (
    !asksTheDecisionQuestion({
      type: input.itemType as Parameters<typeof asksTheDecisionQuestion>[0]['type'],
      executor: (input.itemExecutor ?? null) as Parameters<
        typeof asksTheDecisionQuestion
      >[0]['executor'],
    })
  ) {
    return NO_DECISION_GATE;
  }
  try {
    const [read, document] = await Promise.all([
      approvalGatesService.getForWorkItem(
        { workItemId: input.itemId, kind: 'decision_approval' },
        input.ctx,
      ),
      decisionDocumentService.readViewForWorkItem(input.itemId, input.ctx).catch(() => null),
    ]);
    return { ...read, document };
  } catch {
    return NO_DECISION_GATE;
  }
}

const NO_CHOICE_GATE: LateReads['choiceGate'] = {
  gate: null,
  canDecide: false,
  routedToLabel: null,
  earlierApproval: null,
  settingsDoor: null,
  stamp: null,
  movedSince: [],
  body: null,
  workItemRefs: {},
};

/** A choice's gate and body (MOTIR-5896) — only for `type: choice`, contained. */
async function readChoiceGate(input: LateReadsInput): Promise<LateReads['choiceGate']> {
  if (input.itemType !== 'choice') return NO_CHOICE_GATE;
  try {
    const [read, { body, workItemRefs }] = await Promise.all([
      approvalGatesService.getForWorkItem(
        { workItemId: input.itemId, kind: 'decision_choice' },
        input.ctx,
      ),
      choiceGateService.readBodyWithRefs(input.itemId, input.ctx),
    ]);
    return { ...read, body, workItemRefs };
  } catch {
    return NO_CHOICE_GATE;
  }
}

const NO_CONFIRM_GATE: LateReads['confirmGate'] = { ...NO_CHOICE_GATE, body: null };

/** A `human` decision's gate and body (MOTIR-5954) — only for that card, contained. */
async function readConfirmGate(input: LateReadsInput): Promise<LateReads['confirmGate']> {
  if (input.itemType !== 'decision' || input.itemExecutor !== 'human') return NO_CONFIRM_GATE;
  try {
    const [read, { body, workItemRefs }] = await Promise.all([
      approvalGatesService.getForWorkItem(
        { workItemId: input.itemId, kind: 'decision_confirmation' },
        input.ctx,
      ),
      decisionConfirmationGateService.readBodyWithRefs(input.itemId, input.ctx),
    ]);
    return { ...read, body, workItemRefs };
  } catch {
    return NO_CONFIRM_GATE;
  }
}

/** One page of a card's run history — the same default the route serves. */
export const RUN_HISTORY_PAGE = 20;

export function readLateSections(input: LateReadsInput): Promise<LateReads> {
  const { itemId, ctx, projectId, activityTab } = input;
  const activityReader = input.activityReader ?? ctx;
  // A story at in_review / done is the only shape that has an acceptance panel.
  // The ternaries stay: skipping a query is cheaper than parallelising it.
  const inReviewBand = input.itemStatus === 'in_review' || input.itemStatus === 'done';
  const readAcceptance = input.itemKind === 'story';
  // A Visitor (MOTIR-6648) turns nothing on, and the eligibility read resolves
  // the actor's ORGANISATION access — which a reader outside the organisation
  // does not have, so it throws `OrganizationNotFoundError` and takes the whole
  // story page down. The panel renders without the verb, as for a non-story.
  const readEligibility = readAcceptance && !isVisitorContext(activityReader);

  return (async (): Promise<LateReads> => {
    const [
      pullRequests,
      commentCaps,
      activity,
      attachmentCaps,
      initialAttachments,
      acceptanceEligibility,
      acceptanceEvidence,
      acceptanceGate,
      designEvidence,
      designGate,
      runs,
      scopeRun,
      howToTest,
      mergeGate,
      repair,
      continueView,
      monitorIssueLinks,
      monitorHasConnection,
      decisionGate,
      choiceGate,
      confirmGate,
      agentReview,
      gatedRun,
    ] = await Promise.all([
      workItemsService.listLinkedPullRequests(itemId, input.fullCtx),
      projectAccessService.getCommentCapabilities(projectId, ctx),
      (async () => {
        try {
          if (activityTab === 'comments') {
            return {
              comments: await commentsService.listComments(
                itemId,
                { order: 'desc' },
                activityReader,
              ),
              history: null,
              all: null,
            };
          }
          if (activityTab === 'history') {
            return {
              comments: null,
              history: await activityService.listHistory(itemId, { order: 'desc' }, activityReader),
              all: null,
            };
          }
          return {
            comments: null,
            history: null,
            all: await activityService.listAll(itemId, { order: 'desc' }, activityReader),
          };
        } catch {
          return { comments: null, history: null, all: null };
        }
      })(),
      projectAccessService.getAttachmentCapabilities(projectId, ctx),
      (async () => {
        try {
          return await attachmentsService.listForWorkItem(itemId, {}, ctx);
        } catch {
          return null;
        }
      })(),
      readEligibility
        ? acceptanceVideoEligibilityService.resolve({
            actorUserId: ctx.userId,
            workspaceId: ctx.workspaceId,
            // The gate is the STORY'S OWN project's (MOTIR-5168) — `projectId` is
            // the item's, already resolved for this page's other reads.
            projectId,
          })
        : null,
      readAcceptance ? acceptanceEvidenceService.getCurrentForStory(itemId, ctx) : null,
      // Contained like the design gate's read: a failed read renders the panel
      // without verbs, never an error the reader cannot act on.
      (async () => {
        const none = {
          gate: null,
          canDecide: false,
          routedToLabel: null,
          earlierApproval: null,
          settingsDoor: null,
          stamp: null,
          movedSince: [],
        };
        if (!readAcceptance) return none;
        try {
          return await approvalGatesService.getForWorkItem(
            { workItemId: itemId, kind: 'acceptance_result' },
            ctx,
          );
        } catch {
          return none;
        }
      })(),
      designEvidenceService.getCurrentForWorkItem(itemId, ctx),
      // Contained like its neighbours: a failed gate read must not take the
      // whole late stack down, and "nothing awaiting" is the honest fallback —
      // it renders the section without verbs rather than an error the reader
      // cannot act on.
      (async () => {
        try {
          const read = await approvalGatesService.getForWorkItem(
            { workItemId: itemId, kind: 'design_result' },
            ctx,
          );
          // The subject is read ONLY for a DECIDED gate, and the two states it
          // is skipped for are skipped for opposite reasons. `awaiting` renders
          // the CURRENT design as its port — that is the question — so the
          // pinned row would be the same row and the read is waste.
          // `superseded` renders a DEAD port that shows no subject at all, so
          // fetching one would be a query for something nothing draws.
          const decided =
            read.gate?.state === 'approved' || read.gate?.state === 'changes_requested';
          const subject =
            decided && read.gate
              ? await designEvidenceService.getForGateSubject(
                  { workItemId: itemId, subjectId: read.gate.subjectId },
                  ctx,
                )
              : null;
          return { ...read, subject };
        } catch {
          return {
            gate: null,
            canDecide: false,
            routedToLabel: null,
            earlierApproval: null,
            settingsDoor: null,
            stamp: null,
            movedSince: [],
            subject: null,
          };
        }
      })(),
      (async () => {
        try {
          return await dispatchRunService.listRunsForWorkItemKey(
            input.itemIdentifier,
            { take: RUN_HISTORY_PAGE },
            ctx,
          );
        } catch {
          return null;
        }
      })(),
      // ⚠️ ONE ROW, AND ONLY FOR A CONTAINER. The block shows the latest scoped
      // run and a door to the rest, so a page is one row; a leaf — the item
      // page's commonest case — cannot be a scope and makes no query here.
      input.hasChildren
        ? (async () => {
            try {
              const {
                runs: [latest],
              } = await dispatchRunService.listRunsForProject(
                input.projectKey,
                { take: 1, scopeWorkItemKey: input.itemIdentifier },
                ctx,
              );
              return latest ?? null;
            } catch {
              return null;
            }
          })()
        : null,
      (async () => {
        try {
          return await howToTestService.getForWorkItem(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          const read = await approvalGatesService.getForWorkItem(
            { workItemId: itemId, kind: 'pull_request_approval' },
            ctx,
          );
          // ⚠️ AN AWAITING GATE IS READ TOO, BECAUSE IT MAY BE THE RE-ASKED ONE (Story
          // MOTIR-5799 · MOTIR-5806; § 4 FOURTH AMENDMENT, point 4). This said *ONLY for
          // an APPROVED gate: before the press there is nothing a merge could have done* —
          // true until a press that did NOT land started raising a fresh question over the
          // same commits. On that gate the member facts are the whole of what the row draws
          // (the class pill, the verb, the reason band), so reading `[]` for it left the
          // item page showing a plain *Checks passing* row on a card Motir had just asked
          // again — with `motir fix` beside it saying the pull request left the merge
          // queue. The approval-gate ROUTE (the overlay's read) already reads both.
          // A withdrawn or decided-other-way question still merged nothing.
          const members =
            read.gate?.state === 'approved' || read.gate?.state === 'awaiting'
              ? await pullRequestMergeService.listApprovalMembers(
                  { workItemId: itemId, approvalGateId: read.gate.id },
                  ctx,
                )
              : [];
          // An `auto` card has no gate to read its exits through (MOTIR-5635, § 22 E5).
          const autoQueueExits = read.gate
            ? []
            : await pullRequestMergeService.listStandingQueueExits({ workItemId: itemId }, ctx);
          return { ...read, members, autoQueueExits };
        } catch {
          return {
            gate: null,
            canDecide: false,
            routedToLabel: null,
            earlierApproval: null,
            settingsDoor: null,
            stamp: null,
            movedSince: [],
            members: [],
            autoQueueExits: [],
          };
        }
      })(),
      (async () => {
        try {
          return await workItemRepairService.getRepairView(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async (): Promise<ContinuePartView> => {
        try {
          return await workItemContinueService.getContinueView(itemId, ctx);
        } catch {
          return { state: 'error' };
        }
      })(),
      (async () => {
        try {
          return await monitorIssueService.listForWorkItem(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          return await monitorIssueService.projectHasConnection(projectId, ctx);
        } catch {
          return false;
        }
      })(),
      readDecisionGate(input),
      readChoiceGate(input),
      readConfirmGate(input),
      (async () => {
        try {
          return await agentReviewViewService.readForWorkItem(itemId, ctx);
        } catch {
          return null;
        }
      })(),
      (async () => {
        try {
          return await resumeRunDetailService.readForWorkItem(itemId, ctx);
        } catch {
          return null;
        }
      })(),
    ]);

    return {
      pullRequests,
      commentCaps,
      attachmentCaps,
      initialComments: activity.comments,
      initialHistory: activity.history,
      initialAll: activity.all,
      initialAttachments,
      acceptanceEligibility,
      acceptanceEvidence,
      acceptanceGate,
      showAcceptance: readAcceptance && (inReviewBand || acceptanceEvidence !== null),
      projectId,
      designEvidence,
      isDesignCard: input.itemType === 'design',
      designGate,
      runs,
      scopeRun,
      howToTest,
      mergeGate,
      repair,
      continueView,
      monitorIssueLinks,
      monitorHasConnection,
      decisionGate,
      choiceGate,
      confirmGate,
      agentReview,
      gatedRun,
    };
  })();
}
