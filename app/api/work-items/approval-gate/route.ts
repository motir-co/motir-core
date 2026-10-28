import { NextResponse } from 'next/server';
import { getActiveProject } from '@/lib/projects';
import { refuseIfNonCompliant } from '@/lib/auth/requireCompliantSession';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { acceptanceEvidenceService } from '@/lib/services/acceptanceEvidenceService';
import { designEvidenceService } from '@/lib/services/designEvidenceService';
import { decisionDocumentService } from '@/lib/services/decisionDocumentService';
import { choiceGateService } from '@/lib/services/choiceGateService';
import { decisionConfirmationGateService } from '@/lib/services/decisionConfirmationGateService';
import { howToTestService } from '@/lib/services/howToTestService';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { pullRequestMergeService } from '@/lib/services/pullRequestMergeService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { agentReviewViewService } from '@/lib/services/agentReviewViewService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { isManualReadyItem } from '@/lib/dto/ready';
import type { ExecutorDto, WorkItemTypeDto } from '@/lib/dto/workItems';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import {
  APPROVAL_GATE_HANDLERS,
  UNREGISTERED_GATE_KINDS,
  isRegisteredGateKind,
} from '@/lib/approvalGates/registry';
import type {
  ApprovalGateDTO,
  ApprovalGateKindDTO,
  ApprovalGateOverlayReadDTO,
  ApprovalGateOverlaySubjectDTO,
} from '@/lib/dto/approvalGate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// GET /api/work-items/approval-gate?key=<identifier>&kind=<gate kind>
// (Story MOTIR-5214 · Subtask MOTIR-5223) — the approval OVERLAY's only read.
//
// The overlay is mounted in the authed shell and opened by its URL, so it is a
// client island, and no client component may reach the service layer
// (CLAUDE.md's 4-layer rule) — the same reason `peek` and `planning-anchor` are
// routes. The in-list disclosure's server action (deleted by MOTIR-5225) could
// not serve it: that action was handed a `(workItemId, subjectId)` off a queue
// row the browser already held, and an overlay address can be pasted into a cold
// tab with no row anywhere.
//
// Built in the exact shape of `app/api/work-items/planning-anchor/route.ts`:
// resolve against the actor's ACTIVE project, the 2FA hold AFTER the no-project
// arm, and the no-existence-leak 404. Thin HTTP over SHIPPED service reads and no
// new one:
//
//   1. `workItemsService.getWorkItemByIdentifier` — the key → item resolution,
//      and the BROWSE gate. `getForWorkItem` binds the workspace but asserts no
//      browse permission, so without this read a reader could ask about a gate
//      on a card in a private project they are not in.
//   2. `approvalGatesService.getForWorkItem` — the frame's own read: the gate of
//      that kind in whatever state, `canDecide` as the AUTHORITY answer, and the
//      live *waiting on* name. Nothing here re-derives any of it.
//   3. THE PORT, per kind, only for a kind this build registers:
//      - `design_result` — `designEvidenceService.getForGateSubject`, read by the
//        gate's own `subjectId`;
//      - `pull_request_approval` (MOTIR-5439) — the Development block, read by the
//        SAME calls the item page's late stack makes (`lateReads.ts`):
//        `workItemsService.listLinkedPullRequests` + `getDeliveryView`,
//        `howToTestService.getForWorkItem`, `designEvidenceService.getCurrentForWorkItem`,
//        and — for an approved OR AWAITING gate (MOTIR-5806: the re-asked gate's members
//        carry the row's verb) — `pullRequestMergeService.listApprovalMembers`;
//      - `agent_review` — the same Development block over its delivery set, with
//        `agentReviewViewService.readForWorkItem` beside it (the review's state).
//
// No `db` / no `$transaction` here.
//
// A stale / deleted / cross-workspace / forbidden key is the same 404 (never a
// 403, which would leak "it exists but you can't see it"). A card with no gate
// of that kind is NOT a 404 — it is a card with nothing to decide, and the
// overlay says so.

/** Every gate kind the enum carries — registered and not — read from the
 *  registry rather than written out, so a new kind cannot be refused here while
 *  the registry classifies it. */
const GATE_KINDS: ReadonlySet<string> = new Set<string>([
  ...Object.keys(APPROVAL_GATE_HANDLERS),
  ...UNREGISTERED_GATE_KINDS,
]);

function parseKind(raw: string | null | undefined): ApprovalGateKindDTO | null {
  const kind = raw?.trim();
  return kind && GATE_KINDS.has(kind) ? (kind as ApprovalGateKindDTO) : null;
}

/** The three ways the key can say "there is nothing here for you" — one answer. */
function isNotAvailable(err: unknown): boolean {
  /* v8 ignore else -- the fall-through below is unreachable; see its note. */
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectAccessDeniedError) return true;
  /* v8 ignore next -- unreachable FROM HERE: `getWorkItemByIdentifier` resolves
     the item inside the active project and rejects a foreign workspace with
     `WorkItemNotFoundError` before `assertCanBrowse` runs. Kept because this
     handler is the peek route's twin, and a leak-sensitive catch is the wrong
     place to narrow on a reading of another module's call order. */
  return err instanceof ProjectNotFoundError;
}

/**
 * What the port renders. TOTAL over `ApprovalGateKind`: a kind the registry
 * leaves unregistered is a real row with a drawn not-built-yet arm, never a
 * throw and never an empty body.
 */
async function readSubject(
  kind: ApprovalGateKindDTO,
  gate: ApprovalGateDTO | null,
  item: {
    id: string;
    type: WorkItemTypeDto | null;
    executor: ExecutorDto | null;
    targetRepos: readonly string[];
  },
  ctx: ServiceContext,
): Promise<ApprovalGateOverlaySubjectDTO> {
  // ⚠️ A PLAN GATE IS NEVER PORTED HERE, registered or not (Story MOTIR-6012 ·
  // MOTIR-6034; ADR `approval-gates.md` §11.5b). It belongs to no card, so an address
  // naming a card can never find one — and `no_gate` would tell the reader this card
  // simply has nothing to decide. The overlay has no frame for the kind at all, so it
  // answers `kind_not_built` before the gate is looked at, and keeps answering it once
  // MOTIR-6035 registers the handler; forwarding such a link to the planning surface
  // is MOTIR-6037's.
  // A card-less kind has no work item to read a port from (`plan_approval`, ADR §11.5b; and
  // `planning_session`, MOTIR-7913 — its row opens the planning overlay through the
  // plan-overlay door, never this port).
  if (kind === 'plan_approval' || kind === 'planning_session') return { state: 'kind_not_built' };
  if (!gate) return { state: 'no_gate' };
  if (!isRegisteredGateKind(kind)) return { state: 'kind_not_built' };
  switch (kind) {
    case 'design_result': {
      // ⚠️ A DESIGN GATE THAT CARRIES A MERGE GATE IS PORTED BY THE DEVELOPMENT BLOCK
      // (Bug MOTIR-5712; `design-result.md` AMENDMENT 6 Q1). While the design question
      // is open on a card whose pull requests await a merge decision, one press answers
      // both — so the reader must see what that press MERGES, exactly as the item page's
      // frame shows it (MOTIR-5667): the design result first, its pull requests and How
      // to test beneath. The To-approve queue lists such a card by this gate only, so
      // this port is the one place the queue's reader meets those pull requests.
      if (gate.state === 'awaiting') {
        const merge = await approvalGatesService.getForWorkItem(
          { workItemId: item.id, kind: 'pull_request_approval' },
          ctx,
        );
        if (merge.gate?.state === 'awaiting') {
          return readDevelopmentBlock(gate, item, ctx, merge.gate);
        }
      }
      const { evidence, filesKept } = await designEvidenceService.getForGateSubject(
        { workItemId: item.id, subjectId: gate.subjectId },
        ctx,
      );
      return evidence
        ? { state: 'resolved', kind: 'design_result', evidence, filesKept }
        : { state: 'gone' };
    }
    // ⚠️ `pull_request_merge` HAS NO ARM, and needs none: MOTIR-5616 moved the kind to
    // `UNREGISTERED_GATE_KINDS`, so `isRegisteredGateKind` above answers it with
    // `kind_not_built` before this switch is reached. MOTIR-5615 recorded why the arm
    // could not go earlier — this switch is total over the REGISTERED kinds, so the case
    // could only be deleted in the same diff that unregisters the kind.
    //
    // ⚠️ MERGE RESOLUTION, 2026-09-16: MOTIR-5437 (#2920) landed on `main` in between and
    // gave `pull_request_approval` the real port below, while keeping a merge arm that
    // returned `kind_not_built`. Both halves are kept — 5437's port, and no merge arm —
    // because the kind that arm answered for is no longer registered to reach it.
    // ⚠️ AND THE REVIEW THAT PASSED THESE COMMITS (Story MOTIR-1626; `design/github`
    // § 30 Panels 2a/2b, `approve-and-merge--agent-review.mock.html`). When the review
    // agent passed the SAME version this gate asks about, its *Reviewed by the review
    // agent · Passed* band sits above Approve and merge — in the overlay as on the item
    // page, both read by `agentReviewViewService`. A review at another version, or one a
    // person continued past, is not this gate's; the frame draws what it is handed.
    case 'pull_request_approval': {
      const [block, agentReview] = await Promise.all([
        readDevelopmentBlock(gate, item, ctx),
        agentReviewViewService.readForWorkItem(item.id, ctx),
      ]);
      const passedThisVersion =
        agentReview !== null &&
        agentReview.gate.state === 'approved' &&
        agentReview.gate.subjectVersion !== null &&
        agentReview.gate.subjectVersion === gate.subjectVersion;
      return passedThisVersion &&
        block.state === 'resolved' &&
        block.kind === 'pull_request_approval'
        ? { ...block, agentReview }
        : block;
    }
    // MOTIR-4950 — the acceptance port is the RECORDING the gate asks about, read by
    // the gate's own `subjectId` exactly as the design arm reads its evidence.
    case 'acceptance_result': {
      // ⚠️ A STORY RUN'S ACCEPTANCE IS PORTED BY THE DEVELOPMENT BLOCK (MOTIR-5790), for
      // the design arm's reason above: while it awaits beside an awaiting merge question,
      // one press answers both, so the reader must see what that press merges.
      if (gate.state === 'awaiting') {
        const merge = await approvalGatesService.getForWorkItem(
          { workItemId: item.id, kind: 'pull_request_approval' },
          ctx,
        );
        if (merge.gate?.state === 'awaiting') {
          return readDevelopmentBlock(gate, item, ctx, merge.gate);
        }
      }
      const evidence = await acceptanceEvidenceService.getForGateSubject(
        { workItemId: item.id, subjectId: gate.subjectId },
        ctx,
      );
      return evidence
        ? { state: 'resolved', kind: 'acceptance_result', evidence }
        : { state: 'gone' };
    }

    // THE DECISION PORT (MOTIR-5678; design §27 Panel 7): the Development block with the
    // decision document FIRST — read here, on the server, through the resolver — and the
    // pull requests one press merges beneath it. The document is read beside the block,
    // never inside a transaction, because the production resolver calls the Git host.
    //
    // ⚠️ AND IT HANDS THE BLOCK THE CARD'S MERGE GATE, WHATEVER ITS STATE (Bug MOTIR-6080):
    // the members and the version the press merges are that gate's, exactly as the item
    // page's `frameGateFor` reads them for a decision-led frame. A card with no merge
    // question hands none, and the block reads its own gate as it always did.
    case 'decision_approval': {
      const [merge, document] = await Promise.all([
        approvalGatesService.getForWorkItem(
          { workItemId: item.id, kind: 'pull_request_approval' },
          ctx,
        ),
        decisionDocumentService.readViewForWorkItem(item.id, ctx).catch(() => null),
      ]);
      // A PAGE DECISION HAS NO DELIVERY SET (Story MOTIR-5761): its subject is the published
      // page version, so the port resolves over an empty set rather than reading `gone`.
      const block = await readDevelopmentBlock(
        gate,
        item,
        ctx,
        merge.gate,
        document?.outcome === 'page',
      );
      return block.state === 'resolved' && block.kind === 'pull_request_approval'
        ? { ...block, decision: { document } }
        : block;
    }
    // THE CHOICE PORT (Story MOTIR-4914 · MOTIR-5891): the options parsed from the work
    // item's own body — which IS the subject. A body that no longer parses has nothing
    // left to pick from, so the port answers `gone`, exactly as a vanished design does.
    case 'decision_choice': {
      const choice = await choiceGateService.readPort(item.id, ctx);
      return choice ? { state: 'resolved', kind: 'decision_choice', choice } : { state: 'gone' };
    }
    // THE CONFIRM PORT (Story MOTIR-5871 · MOTIR-5954): the decision's four sections,
    // parsed from the work item's own body — which IS the subject — with the record it
    // would stamp. A body that no longer parses is `gone`, as a choice's is.
    case 'decision_confirmation': {
      const confirm = await decisionConfirmationGateService.readPort(item.id, ctx);
      return confirm
        ? { state: 'resolved', kind: 'decision_confirmation', confirm }
        : { state: 'gone' };
    }
    // THE AGENT REVIEW'S PORT (Story MOTIR-1626; ADR `approval-gates.md` §12.3). It is never
    // on a To-approve row (§12.1), but its ONE person's decision — *Continue without the
    // review* — is made here, like every decision (MOTIR-6323): the item page's frame hands
    // it over. Its subject is the approve-and-merge gate's, the delivery SET at the reviewed
    // version (§12.1: one stamp, one function), so the port is that gate's Development
    // block; beside it, the review's own state — why it could not run, and its run — read
    // by the SAME service the item page reads it with.
    case 'agent_review': {
      const [block, agentReview] = await Promise.all([
        readDevelopmentBlock(gate, item, ctx),
        agentReviewViewService.readForWorkItem(item.id, ctx),
      ]);
      return block.state === 'resolved' && block.kind === 'pull_request_approval'
        ? { ...block, agentReview }
        : block;
    }
    // A RUN'S MANUAL CARD (Story MOTIR-7460 · MOTIR-7478; design `design/workbench/
    // design-notes.md` § 33.3). The subject IS the card, so the port is the card's to-do
    // list — read by the SAME service the item page reads it with — and whether the card
    // has an open delivering pull request, which is what decides Mark done's consequence
    // line (`merge_writes_done`, `manualWorkHandler.approve`). Every state resolves: a
    // withdrawn gate's frame draws its own cause over the card it was about. An AWAITING
    // gate on a card that is no longer manual asks about work nobody owes a person, so it
    // is `gone` — the same answer `manualWorkHandler.resolveSubject` gives, which is what
    // lets the open withdraw it (MOTIR-7146) rather than draw Mark done over it.
    case 'manual_work': {
      if (gate.state === 'awaiting' && !isManualReadyItem(item)) return { state: 'gone' };
      const [todoList, deliveries] = await Promise.all([
        workItemTodosService.listTodos(item.id, ctx),
        workItemsService.listDeliverySet(item.id, ctx),
      ]);
      return {
        state: 'resolved',
        kind: 'manual_work',
        manualWork: {
          todos: todoList.items,
          progress: todoList.progress,
          workItemRefs: await workItemTodosService.resolveNotesRefs(todoList.items, ctx),
          mergeWritesDone: deliveries.some((delivery) => delivery.pullRequest.state === 'open'),
        },
      };
    }
    /* v8 ignore next 4 -- unreachable by construction: `kind` is narrowed to
       `RegisteredGateKind`, and registering a second kind is a compile error
       here until it has its own arm. */
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/**
 * THE DEVELOPMENT BLOCK as a port — the approve-to-merge gate's own, and a design or
 * acceptance gate's while it carries one (see those arms).
 *
 * ⚠️ `members` is read against the MERGE gate: the gate handed in when it is one, else
 * the `merge` gate a primary arm read beside it (Bug MOTIR-6079). Member facts are
 * recorded on the merge gate only, so a primary's own id answers none — the item page's
 * late stack reads `r.mergeGate.members` whichever gate leads its frame, and this is that.
 *
 * A primary's `merge` gate also hands back its VERSION as `mergeSubjectVersion`: no
 * primary's own version is a delivery set — a design's is its published commit, a
 * decision's its document blob, an acceptance's its recording — so the frame counts what
 * one press merges only through it (Bug MOTIR-6080; `LateSections`' `frameGateFor`).
 */
async function readDevelopmentBlock(
  gate: ApprovalGateDTO,
  item: { id: string; type: string | null; targetRepos: readonly string[] },
  ctx: ServiceContext,
  merge: ApprovalGateDTO | null = null,
  /** A decision published as a PAGE (MOTIR-5761) delivers nothing, so an empty set is its normal shape. */
  emptySetResolves = false,
): Promise<ApprovalGateOverlaySubjectDTO> {
  const membersGate = merge ?? gate;
  // THE DEVELOPMENT BLOCK as the port (Story MOTIR-5437 · MOTIR-5439). The subject
  // is the card's DELIVERY SET (`pullRequestApprovalHandler.resolveSubject`), so a
  // set that has emptied — every pull request unlinked — is GONE, exactly as the
  // handler answers null for it. Nothing is read by `subjectId` beyond that: the
  // gate's `subjectId` IS the work item's id.
  const [
    pullRequests,
    deliveryView,
    howToTest,
    designEvidence,
    members,
    repair,
    acceptanceEvidence,
    acceptanceRead,
  ] = await Promise.all([
    workItemsService.listLinkedPullRequests(item.id, ctx),
    workItemsService.getDeliveryView(item.id, item.targetRepos, ctx),
    howToTestService.getForWorkItem(item.id, ctx),
    designEvidenceService.getCurrentForWorkItem(item.id, ctx),
    // ⚠️ READ FOR AN AWAITING GATE TOO (MOTIR-5802 · MOTIR-5806). The RE-ASKED gate is
    // awaiting, and its members are what carry the row's verb — *Queue again* /
    // *Retry merge*, whose press decides that very gate. The item page's late stack
    // reads both for the same reason, and `approval-gate-route.test.ts` COMPARES them.
    membersGate.state === 'approved' || membersGate.state === 'awaiting'
      ? pullRequestMergeService.listApprovalMembers(
          { workItemId: item.id, approvalGateId: membersGate.id },
          ctx,
        )
      : Promise.resolve([]),
    // ⚠️ `motir fix` BELONGS IN THE OVERLAY TOO (MOTIR-5806; § 28 panel 7). The page
    // has offered it since MOTIR-5721; the overlay is where most approvals are
    // actually decided, and a person deciding there saw only the approve.
    workItemRepairService.getRepairView(item.id, ctx),
    // A story run's receipt and its gate (MOTIR-5790) — the subject when acceptance leads.
    acceptanceEvidenceService.getCurrentForStory(item.id, ctx),
    approvalGatesService.getForWorkItem({ workItemId: item.id, kind: 'acceptance_result' }, ctx),
  ]);
  if (deliveryView.deliveries.length === 0 && !emptySetResolves) return { state: 'gone' };
  return {
    state: 'resolved',
    kind: 'pull_request_approval',
    pullRequests,
    repoDelivery: deliveryView.repos,
    deliveries: deliveryView.deliveries,
    howToTest,
    designEvidence,
    isDesignCard: item.type === 'design',
    members,
    ...(merge ? { mergeSubjectVersion: merge.subjectVersion } : {}),
    repair,
    acceptanceEvidence,
    acceptanceGate: acceptanceRead.gate,
  };
}

export async function GET(req: Request): Promise<Response> {
  const active = await getActiveProject();
  if (!active) {
    return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });
  }

  // The 2FA hold (MOTIR-3653) — AFTER the no-project arm, exactly where the
  // peek and the planning anchor place it.
  const hold = await refuseIfNonCompliant(active.userId);
  if (hold) return hold;

  const params = new URL(req.url).searchParams;
  const key = params.get('key')?.trim();
  if (!key) {
    return NextResponse.json({ code: 'BAD_REQUEST', error: '`key` is required.' }, { status: 400 });
  }
  const kind = parseKind(params.get('kind'));
  if (!kind) {
    return NextResponse.json(
      { code: 'BAD_REQUEST', error: '`kind` must be an approval-gate kind.' },
      { status: 400 },
    );
  }

  const ctx: ServiceContext = { userId: active.userId, workspaceId: active.workspaceId };

  try {
    const item = await workItemsService.getWorkItemByIdentifier(active.projectId, key, ctx);
    // ⚠️ `?since=` IS A QUESTION, NOT A CURSOR. A reader who has been holding
    // this approval open hands back the stamp they were shown, and the read
    // answers what has moved since — through the decide door's own comparison
    // (Story MOTIR-5238 · Subtask MOTIR-5243). Absent, the answer is empty and
    // this route behaves exactly as it did.
    const since = params.get('since');
    const readGate = () =>
      approvalGatesService.getForWorkItem({ workItemId: item.id, kind, since }, ctx);
    const [first, held, statuses, parent] = await Promise.all([
      readGate(),
      // WHETHER A REFUSED DECISION'S RECORD OFFERS RE-PLAN WITH AI (MOTIR-6211): the item
      // page's own `canEdit` (`work_item:edit`) and a card that is not archived — exactly
      // what `WorkItemPlanEntrance` is drawn under, so the two doors cannot disagree.
      projectAccessService.getPermissions(item.projectId, ctx),
      // THE HEADER'S STATUS CHIP (MOTIR-6427; design panel 5b) — labelled from the project's
      // own workflow, and repainted from what a press wrote.
      workflowsService.listStatusesByProject(item.projectId, ctx.workspaceId),
      // WHERE A DESIGN'S RE-PLAN OPENS (MOTIR-6427; §10h) — the parent, which the ask and the
      // door name. Only a design anchors there (`refusalSeedAnchorsOnParent`).
      kind === 'design_result' && item.parentId
        ? workItemsService.getWorkItem(item.parentId, ctx)
        : Promise.resolve(null),
    ]);
    let read = first;
    let subject = await readSubject(kind, read.gate, item, ctx);
    // A QUESTION WHOSE SUBJECT IS GONE IS WITHDRAWN, NOT LEFT AS PANEL 4b (Bug MOTIR-7146).
    // Opening it is what retires it: the card's awaiting gates whose subject no longer
    // resolves are superseded `subject_gone`, each re-checked under its lock through its
    // kind's own handler, and the gate is read again — so the reader meets the withdrawn
    // frame (state `G`) instead of a dead end with nothing to press. A decided gate over
    // a gone subject is somebody's answer and stays Panel 4b. A failed withdrawal leaves
    // the read exactly as it was; the next open observes it again.
    if (subject.state === 'gone' && read.gate?.state === 'awaiting') {
      const withdrawn = await approvalGatesService.withdrawGoneQuestionsOnWorkItem(item.id, ctx);
      if (withdrawn.size > 0) {
        read = await readGate();
        subject = await readSubject(kind, read.gate, item, ctx);
      }
    }
    const body: ApprovalGateOverlayReadDTO = {
      workItem: {
        id: item.id,
        identifier: item.identifier,
        title: item.title,
        status: item.status,
        parentIdentifier: parent?.identifier ?? null,
      },
      statuses: statuses.map((s) => ({
        key: s.key,
        label: s.label,
        category: s.category,
        isInitial: s.isInitial,
      })),
      gate: read.gate,
      canDecide: read.canDecide,
      canReplan: held.has('work_item:edit') && item.archivedAt === null,
      routedToLabel: read.routedToLabel,
      stamp: read.stamp,
      movedSince: read.movedSince,
      earlierApproval: read.earlierApproval,
      subject,
    };
    return NextResponse.json(body, {
      // A gate's state changes under the reader by design — never serve a
      // decision that has since been made.
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    /* v8 ignore else -- the RE-THROW arm, unreachable for the same reason: every
       class the key resolution raises is answered here; anything else is a real
       fault for Next's error boundary, never a 404. */
    if (isNotAvailable(err)) {
      return NextResponse.json(
        { code: 'NOT_FOUND', error: 'Work item not available.' },
        { status: 404 },
      );
    }
    /* v8 ignore next -- the RE-THROW: every class the key resolution raises is
       answered above; anything else is a real fault for Next's error boundary. */
    throw err;
  }
}
