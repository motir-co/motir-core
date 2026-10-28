import { RelatedTitles } from './_components/translation/RelatedTitles';
import { Suspense } from 'react';
import { personDisplayName } from '@/lib/people/personLabel';
import { notFound, permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Archive } from 'lucide-react';
import { pageMembers, pageScope, type ProjectPageContext } from '@/lib/pages/projectPageContext';
import { workItemsService } from '@/lib/services/workItemsService';
import { pagesService } from '@/lib/services/pagesService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { sprintsService } from '@/lib/services/sprintsService';
import { plansService } from '@/lib/services/plansService';
import { estimationService } from '@/lib/services/estimationService';
import { componentsService } from '@/lib/services/componentsService';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { OptimisticStatusProvider } from './_components/OptimisticStatusProvider';
import { ParentRollupBadge } from '@/components/issues/ParentRollupBadge';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { resolveAliasedIssueKey } from '@/lib/issues/aliasRedirect';
import type { IssueType } from '@/lib/issues/parentRules';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemPlanEntrance } from '@/components/planning/WorkItemPlanEntrance';
import { parseWorkItemRefs } from '@/lib/mentions/workItemRefs';
import { parsePageTokenIds } from '@/lib/mentions/pageRefs';
import { Pill } from '@/components/ui/Pill';
import { formatDate } from '@/lib/utils/datetime';
import type { Locale } from '@/lib/i18n/locales';
import { ArchivedBanner } from './_components/ArchivedBanner';
import { PendingPlanNotice } from './_components/PendingPlanNotice';
import { ToFixBanner } from './_components/ToFixBanner';
import { isReviewSentBack } from '@/lib/workItems/reviewSentBack';
import { ToFixHostedDoor } from './_components/ToFixHostedDoor';
import { workItemRepairService } from '@/lib/services/workItemRepairService';
import { PlanHistorySection } from './_components/PlanHistorySection';
import { PLAN_HISTORY_FIRST_PAGE } from './_components/planHistoryPaging';
import { CoreFieldsPanel } from './_components/CoreFieldsPanel';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { WorkItemDetailActions } from './_components/WorkItemDetailActions';
import { MonitorErrorsDoorProvider } from './_components/MonitorErrorsLinkControl';
import { EpicPrivacyControl } from './_components/EpicPrivacyControl';
import { isVisitorContext } from '@/lib/visitor/readScope';
import { readerRoutes } from '@/lib/visitor/routes';
import { WatchControl } from './_components/WatchControl';
import { ContentSectionCard } from './_components/ContentSectionCard';
import { readLateSections } from './_components/lateReads';
import {
  LateUpperSections,
  LateLowerSections,
  LateUpperFallback,
  LateLowerFallback,
} from './_components/LateSections';
import { IssueExplanation } from './_components/IssueExplanation';
import { PlacementBreadcrumb } from './_components/PlacementBreadcrumb';
import { DecisionWaitingHeaderLink } from './_components/DecisionWaitingHeaderLink';
import {
  OptimisticMarkProvider,
  OptimisticObsolescenceHeaderLink,
} from './_components/OptimisticMarkProvider';
import { PlacementProvider } from './_components/PlacementProvider';
import { TranslationProvider } from './_components/translation/TranslationProvider';
import { TranslateControl } from './_components/translation/TranslateControl';
import { FieldTranslationMark } from './_components/translation/FieldTranslationMark';
import {
  TranslatableMarkdown,
  TranslatableTitle,
} from './_components/translation/TranslatableFields';
import { fieldRef } from '@/lib/translation/fieldRefs';
import type { TranslationOfferInput } from '@/lib/services/workItemTranslationReadService';
import { readerTranslationContextService } from '@/lib/services/readerTranslationContextService';
import type { ReaderTranslationDTO } from '@/lib/dto/workItemTranslation';
import type { ProjectDTO } from '@/lib/dto/projects';
import { ChildList } from './_components/ChildList';
import { ChildPanel } from './_components/ChildPanel';
import { EpicNotPublicBlock, EpicNotPublicPill } from './_components/EpicNotPublic';
import { RelationshipsPanel } from './_components/RelationshipsPanel';
import { TodoListSection } from './_components/TodoListSection';
import { IssueQuickViewController } from '../_components/IssueQuickViewController';
import { parseActivityTab } from '@/lib/activity/tab';
import { isManualReadyItem } from '@/lib/dto/ready';
import { isMotirAiConfigured } from '@/lib/ai/availability';

// The issue DETAIL route (Story 2.4 · Subtask 2.4.1). Server Component:
// resolves the active project (the shipped active-project model — finding #50,
// no /projects/[key] tree; sibling of 2.3.6's edit route), loads the aggregate
// `getIssueDetail` by the [key] identifier (e.g. "PROD-7"), and renders the page
// SHELL — header (type icon · identifier · title · status) + the rendered
// description + an "Edit" link to 2.3.6's form. The two-column body reserves the
// regions later subtasks fill (2.4.2 core-fields panel · 2.4.3 breadcrumb +
// child list · 2.4.4 inline status/assignee controls · 2.4.5 relationships +
// readiness) and the Epic-5 extension slots (comments · attachments · custom
// fields · activity). Cross-workspace / missing → 404 (no existence leak);
// unauthenticated → /sign-in; no active project → a hint, not a crash.

/**
 * The translation half of the page read (Story MOTIR-7735 · MOTIR-8121). It
 * CHAINS on two reads the tier-two wave already holds — the locale and the
 * to-do list — and is awaited inside that same wave, so it adds no round trip.
 * A function of its own so the page body shows ONE wave to the serial-read
 * guard (`tests/navigation/loading-boundary-guard.test.ts`), which counts a
 * `Promise.all` in the body as an awaited wave whether or not it is awaited
 * there. A failed read degrades to no offer rather than rejecting the wave.
 */
function translationReadFor(
  workItem: TranslationOfferInput['workItem'],
  localeRead: Promise<Locale>,
  todoListRead: ReturnType<typeof workItemTodosService.listTodos>,
  ctx: TranslationOfferInput['ctx'],
  project: ProjectDTO,
): Promise<ReaderTranslationDTO | null> {
  // The reader's translation context (Story MOTIR-7738 · MOTIR-8832) layers the
  // project's switch and the can-pay verdict over the shipped offer, so the host
  // can start on mount. The project is already on the page context: no extra read.
  return Promise.all([localeRead, todoListRead])
    .then(([readerLocale, todos]) =>
      readerTranslationContextService.resolveForItem({
        project,
        reader: ctx,
        readerLocale,
        workItem,
        todos: todos.items,
      }),
    )
    .then((resolved) =>
      resolved
        ? { offer: resolved.offer, canAddCredits: resolved.canAddCredits, auto: resolved.context }
        : null,
    )
    .catch(() => null);
}

export default async function ItemView({
  ctx: pageCtx,
  params,
  searchParams,
}: {
  ctx: ProjectPageContext;
  params: Promise<{ key: string }>;
  searchParams: Promise<{ activity?: string }>;
}) {
  const t = await getTranslations('issueViews');
  // The reader's contexts (MOTIR-6648) — a member's own, or a Visitor's: `read`
  // for the reads that withhold a private epic's descendants (the detail, the
  // rollup, the chips, the activity), `service` for the rest.
  const ctx = pageScope(pageCtx);
  const svc = ctx.service;
  // A Visitor (MOTIR-6648) acts on nothing, so the page draws no Watch control
  // and makes no plan-history read (below) for one.
  const isVisitor = isVisitorContext(ctx.read);
  // The reader's addresses (MOTIR-6888): the Visitor path on the Visitor tree.
  const routes = readerRoutes(ctx.visitor?.project.identifier ?? null);

  const { key } = await params;
  let detail;
  try {
    detail = await workItemsService.getIssueDetail(ctx.projectId, key, ctx.read);
  } catch (err) {
    // A browse denial (6.4.3) means the project is hidden from this actor — it
    // must be indistinguishable from a missing issue (404, no existence leak).
    if (err instanceof WorkItemNotFoundError || err instanceof ProjectAccessDeniedError) {
      // Story 6.8.2 — old-key link: if `key` addresses an issue under a RETIRED
      // project key (PROD-7 after PROD→NIF), 308-redirect to the canonical
      // identifier (NIF-7) so old bookmarks keep working; otherwise a real 404.
      // A Visitor follows no renamed-key alias: a hidden item and a missing one
      // must read the same (`epic-privacy.md` §3), and an alias could tell them
      // apart (MOTIR-6648).
      const canonical = ctx.visitor ? null : await resolveAliasedIssueKey(key, svc);
      if (canonical) permanentRedirect(routes.item(canonical));
      notFound();
    }
    throw err;
  }

  const { item } = detail;

  // The actor's PERMISSION SET (MOTIR-2473) — ONE round trip feeding three
  // affordance decisions that used to be two booleans and a private admin check:
  //
  //   * `canEdit` (`work_item:edit`) — a read-only actor sees NO edit
  //     affordances: the "Edit" link is hidden and the edit route is blocked
  //     (edit/page.tsx). Inline field controls render disabled (6.4.6).
  //   * `canArchive` (`work_item:archive`) — the ⋯ menu's Archive / Restore rows
  //     and the delete dialog's "Archive instead" escape-hatch (MOTIR-3629).
  //     A MEMBER holds this and not `work_item:delete`, which is the split the
  //     comment below used to describe as an unfixable 403.
  //   * `canDelete` (`work_item:delete`) — the ⋯ menu's Delete row alone.
  //     NOT the same people as `canEdit`: a member holds edit and not delete.
  //     ⚠️ It used to gate Archive too, on the reading that "a member holds edit
  //     and not delete, so the Archive row it used to offer them was an
  //     affordance that 403'd" — a correct diagnosis whose only available remedy
  //     was to hide Archive from every member, because one key spanned the
  //     reversible hide and the irreversible subtree destroy. MOTIR-3629 split
  //     the key instead, so the row is offered to exactly the actors the service
  //     admits.
  //   * `canManageProject` (`project:administer`) — the epic-privacy control.
  // The reader's permission SET (MOTIR-6643), read only now: the detail read
  // above has already decided not-found, so a missing item never starts it.
  const held = await pageCtx.permissions();
  const canEdit = held.has('work_item:edit');
  const canArchive = held.has('work_item:archive');
  const canDelete = held.has('work_item:delete');
  const canManageProject = held.has('project:administer');
  // `canViewPlans` (`plan:view_any`) — whether the PENDING-PLAN indicator may
  // render at all (bug MOTIR-4197 AC 4). It is a READ, so it takes the Plans
  // room's VIEW key (MOTIR-6328), not `ai:view_plan`, which gates plan
  // AUTHORING. The Plans nav door opens on this key too (MOTIR-6332 re-keys
  // that row in `lib/settings/projectNavAccess.ts`), so the indicator never
  // points at a room the navigation does not offer. An actor without it gets no
  // indicator AND no read: an indicator naming a plan the viewer cannot open is
  // worse than none, and skipping the query keeps its cost off the actor least
  // able to benefit from it.
  // A Visitor holds `plan:view_any` but not the `ai:view_plan` the item's plan
  // history asserts, and that history is not filtered for a private epic's
  // descendants; the Plans room is the Visitor's plan surface (MOTIR-6645).
  const canViewPlans = held.has('plan:view_any') && !isVisitor;
  // `canViewPages` (`page:view`) — whether the Pages section (Story MOTIR-7565 ·
  // MOTIR-7575) mounts at all, and whether the late fallback reserves its card.
  // ABSENT, not disabled, for a reader without it and for every Visitor (design
  // § *The Pages section* panel 6): even an empty section would tell them whether
  // pages point here, and the section's read is never made.
  const canViewPages = held.has('page:view') && !isVisitor;

  // The Activity tab (Story 5.5 · 5.5.4): URL-driven via `?activity=`
  // (default Comments — the Jira default); the server fetches ONLY the
  // active tab's first cursor page (finding #57 — the other tabs fetch when
  // switched to, via a URL replace that re-renders this page). Read BEFORE the
  // group below because it selects which of the three reads that group runs;
  // `searchParams` is Next's own promise, not a round trip.
  const activityTab = parseActivityTab((await searchParams).activity);

  // ── EVERY REMAINING READ, CONCURRENTLY (Subtask MOTIR-3435) ───────────────
  //
  // This page used to await 29 times, almost all of them in sequence, before it
  // returned a single element — which is what a reader pays when they paste a
  // key into the address bar and watch the PREVIOUS page for as long as the SUM
  // of those reads takes. Everything below is independent of everything else
  // once `ctx`, `detail`, `item` and `held` exist, so the page's wait is now the
  // SLOWEST single read rather than their total.
  //
  // ⚠️ THE GATE ABOVE IS DELIBERATELY NOT IN HERE, and must never be moved in.
  // The session and active-project reads (in the page's context), then the
  // detail read and the permission set, stay
  // sequential and ahead of this, because they decide whether this actor may see
  // the item AT ALL: a browse denial and a missing item are the same 404 (no
  // existence leak), a retired project key 308-redirects, and `held` decides
  // whether edit affordances render. Parallelising a page whose first job is to
  // decide whether you may look at it is exactly how a hidden item becomes
  // visible for a frame. `tests/components/item-detail-reads.test.tsx` asserts
  // the ordering and this group's membership rather than leaving it to a
  // reviewer to notice.
  //
  // ⚠️ A CONDITIONAL READ STAYS CONDITIONAL. Skipping a query is cheaper than
  // parallelising one, so `acceptance*` still runs only for a story at
  // in_review / done, and `rollupForParent` only when the item has children —
  // the ternaries are inside the group, not replaced by it.
  //
  // Each `try` that used to wrap a read is now inside its own arm, so a section
  // whose read fails still degrades to its own ErrorState + retry instead of
  // rejecting the whole group.
  // ── THE LATE STACK'S READS, STARTED BUT NOT AWAITED (Subtask MOTIR-3436) ──
  //
  // `design/work-items/design-notes.md` § *The item page at ARRIVAL, and while
  // it STREAMS* allocates every region to a tier. The THIRD tier — Development,
  // Acceptance, Design result, Attachments, Activity — is everything below the
  // fold, and this page no longer waits for any of it: the promise is created
  // here and awaited inside the two `<Suspense>` boundaries below, which share
  // it so they flush together and the reader sees ONE settle rather than five
  // arrivals. `_components/lateReads.ts` carries the reads verbatim.
  const lateReads = readLateSections({
    itemId: item.id,
    itemType: item.type,
    itemExecutor: item.executor,
    itemStatus: item.status,
    itemKind: item.kind,
    projectId: ctx.projectId,
    ctx: svc,
    activityReader: ctx.read,
    fullCtx: svc,
    activityTab,
    canEdit,
    itemIdentifier: item.identifier,
    projectKey: ctx.project.identifier,
    hasChildren: detail.children.length > 0,
  });

  // A card a REVIEW sent back (MOTIR-6930) — decides the To fix banner's hosted door and
  // whether its open repair is read in the tier-two group below.
  const reviewSentBack = isReviewSentBack(detail.fixReason, detail.fixDetail);

  // ── TIER TWO: what the reader came for, awaited before the first flush ─────
  //
  // The title, both prose bodies, the children list and the core-fields rail.
  // Still ONE round trip rather than eight, and still conditional where it was:
  // `rollupForParent` only when the item has children.
  //
  // ⚠️ THE ROLL-UP stays here rather than moving to its component's lazy path.
  // The tier table calls it "late, IN PLACE", and `ParentRollupBadge` does ship
  // that path — but it renders NOTHING while pending, so the slot is not
  // reserved and its neighbours shift when it fills, which is what the in-place
  // rule exists to prevent. This group already has the figure at no marginal
  // cost, so it is cheaper to not be late at all.
  // The locale and the to-do list are each read ONCE and shared: the tier-two
  // group below renders them, and the translation offer is built from both.
  const localeRead = getLocale() as Promise<Locale>;
  const todoListRead = workItemTodosService.listTodos(item.id, svc);
  // The steps' NOTES draw through `MarkdownView` too (bug MOTIR-10023): their card
  // links, resolved off the same list read — no query when no note links anything.
  const todoRefsRead = todoListRead.then((list) =>
    workItemTodosService.resolveNotesRefs(list.items, ctx.read),
  );
  // THE TRANSLATION OFFER (Story MOTIR-7735 · MOTIR-8121 / MOTIR-8122): for a
  // signed-in reader, which fields differ from their interface language and which
  // already have a kept translation — computed from the item's CURRENT text, no
  // AI call, no write — and whether the no-credit message may link to adding
  // credit. A Visitor (the public project host) gets none: customers' text is
  // shown as written. A failed read degrades to no offer rather than rejecting
  // the group; the page then renders exactly as it did before the feature.
  const translationRead = isVisitor
    ? null
    : translationReadFor(item, localeRead, todoListRead, svc, ctx.project);
  const [
    members,
    sprints,
    deliveryView,
    projectComponents,
    estimationConfig,
    parentRollup,
    locale,
    workItemRefs,
    pageRefs,
    todoList,
    pendingPlans,
    planHistory,
    heldTransitions,
    pendingDecisions,
    planHold,
    repairRun,
    readerTranslation,
    todoRefs,
  ] = await Promise.all([
    // Members back the inline assignee picker + reporter display, and the
    // Activity section's mention candidates. Assignable users are scoped by
    // access level (6.4.6): private → project members.
    // A Visitor's are name-only (MOTIR-6646).
    pageMembers(ctx),
    // Sprints (Subtask 2.4.14) back the inline Sprint field's picker + the ⋯
    // menu's "Add to active sprint" quick action.
    sprintsService.listByProject(ctx.projectId, svc),
    // Per-repository DELIVERY (Story MOTIR-2725 · MOTIR-2415). TIER TWO because
    // the rail's Repositories card renders it — the Development section below
    // uses the same value, passed down rather than read twice.
    // The rail's glyph AND the Development section's rows, from ONE call
    // (MOTIR-3660): `getDeliveryView` returns the repository set already amended
    // by the delivery set, plus the set itself. Combining them at the host is
    // what let this page and the quick view disagree (MOTIR-3036), so neither
    // does it.
    workItemsService.getDeliveryView(item.id, item.targetRepos, svc),
    // The project taxonomy behind the rail's Components picker (Story 5.4 ·
    // Subtask 5.4.8) — browse-gated, name-ordered, admin-bounded (finding #57).
    componentsService.listComponents(ctx.project.identifier, ctx.read),
    // The project estimation config (Subtask 4.3.4) — the rail's inline
    // story-points EstimateBadge reads the scale deck from it via context.
    estimationService.getEstimationConfig(ctx.projectId, svc),
    // Epic/parent subtree roll-up (Subtask 4.3.5) — one bounded recursive-CTE
    // aggregate, ONLY when the item has children. A leaf shows none.
    detail.children.length > 0 ? estimationService.rollupForParent(item.id, ctx.read) : null,
    localeRead,
    // Work-item references (Story 5.8 · 5.8.6) — every `[KEY](motir:<id>)` in
    // the description / explanation and every bare `MOTIR-N` in the title,
    // resolved to its LIVE summary so the body chips render live and open the
    // peek. TIER TWO because the prose bodies are, and a chip that arrives
    // after its paragraph is a reflow inside text the reader is already reading.
    workItemsService.resolveReferenceSummaries(
      parseWorkItemRefs(
        // The obsolescence note rides the same resolve (bug MOTIR-10023): it usually
        // names the cards that superseded this one, and the field draws its chips.
        [item.title, item.descriptionMd, item.explanationMd, item.obsolescenceNoteMd]
          .filter(Boolean)
          .join('\n'),
        ctx.project.identifier,
      ),
      ctx.projectId,
      ctx.read,
    ),
    // Page tags (Story MOTIR-7694 · MOTIR-7698) — every `[<title>](motir-page:<id>)`
    // in the two bodies, resolved to the page's CURRENT title or an unavailable
    // state (no `page:view`, archived, deleted, Visitor). TIER TWO beside the
    // work-item refs, for the same no-reflow reason.
    pagesService.resolvePageRefSummaries(
      parsePageTokenIds([item.descriptionMd, item.explanationMd].filter(Boolean).join('\n')),
      ctx.projectId,
      ctx.read,
    ),
    // The card's own TO-DO LIST (Story MOTIR-3808 · MOTIR-3815). TIER TWO, in
    // THIS group rather than the late stack, and that placement is measured
    // rather than assumed: at 1280x900 the section sits above the fold
    // (`design/work-items/design-notes.md` § *Placement*), and on a card whose
    // work IS the list it is what the reader came for. One small ordered read
    // on the same card, so it costs the group nothing and adds no serial await.
    todoListRead,
    // The UNDECIDED plans that name this card (bug MOTIR-4197 · design
    // MOTIR-4256 §2–§3). TIER TWO, IN THIS GROUP: the element is the first
    // child of the content column, so arriving late would push Description down, and it
    // renders on well under 1% of item pages, so it cannot reserve a box. A
    // read in this group costs max(), not sum(); a serial await here would
    // re-introduce exactly the shape MOTIR-3435 removed from this page. ONE
    // indexed lookup (`plan_item [workItemId, workspaceId]`, the reverse index)
    // with the plan's id / title / status on the same row — its own read, not
    // MOTIR-4106's project-scoped boundary seam, which cannot answer *which
    // plans name THIS card*. CONDITIONAL, like the roll-up: skipped outright
    // for an actor without `plan:view_any`.
    canViewPlans ? plansService.listPendingProposalsForWorkItem(ctx.projectId, item.id, svc) : null,
    // The PLAN HISTORY — every plan that created, changed, archived or expanded
    // this card (Story MOTIR-5542 · MOTIR-5547 · design MOTIR-5545 § Plan
    // history 1). TIER TWO, IN THIS GROUP: the section renders with the first
    // content, after Children, so it moves nothing on arrival — and a tier-three
    // read would re-run on every activity-tab switch (the lower boundary is keyed
    // on it). One page of at most 5 plans over the two `plan_item` indexes; a card
    // with no related plan pays the index probe only. CONDITIONAL on
    // `plan:view_any`, exactly as the pending read above. The CATCH is the page's
    // own rule: a section whose read fails degrades to its own error and retry,
    // it does not reject the group.
    canViewPlans
      ? plansService
          .listPlanHistoryForWorkItem(
            ctx.projectId,
            item.id,
            { limit: PLAN_HISTORY_FIRST_PAGE },
            svc,
          )
          .catch(() => 'failed' as const)
      : null,
    // The moves an approval HOLDS (Story MOTIR-4887 · MOTIR-5528). TIER TWO, in
    // THIS group: the status control is in the rail the reader lands on, and its
    // held message sits UNDER the value — arriving late would push the rail down.
    // Empty on almost every card; one small read that costs the group nothing.
    approvalGatesService.listHeldTransitions(item.id, svc),
    // THE HEADER'S DECISION-WAITING MARKER (Story MOTIR-4908 · MOTIR-5878). In THIS
    // group for the held-transitions reason above: the header is what the reader
    // lands on, and a marker arriving late would shift it. The late sections it
    // points at stream in afterwards; the marker waits for them on a press.
    approvalGatesService.pendingDecisionsFor(
      { projectId: item.projectId, workItemIds: [item.id] },
      svc,
    ),
    // THE PLAN HOLD (Story MOTIR-6017 · MOTIR-6267) — beside the held moves, for
    // their reason: an undecided plan holding the card at Planning locks every
    // move, and the status control says so under its value. `null` on almost every
    // card (anything not at Planning stops after the item row).
    planTargetLockService.readPlanHold(item.id, svc),
    // FIX ON THE HOSTED AGENT ON THE TO FIX BANNER (MOTIR-6930; `design/workbench` § 32
    // Panel 4) — a card a REVIEW sent back. Its open repair, if any, is read ONLY for such
    // a card, so every other page pays nothing for it; in THIS group, because the banner
    // sits at the top of the content column and it adds no serial await.
    reviewSentBack && !isVisitor
      ? workItemRepairService
          .findOpenRepairRuns([item.id], svc)
          .then((runs) => runs.get(item.id) ?? null)
      : null,
    translationRead,
    todoRefsRead,
  ]);

  const activeSprint = sprints.find((s) => s.state === 'active') ?? null;
  // The marker's entry for THIS item, and the routed person named the way the
  // board names members (`name || email`); a routee outside the member list falls
  // back to the marker's own *this work item's assignee*.
  const pendingDecision = pendingDecisions.get(item.id) ?? null;
  const routedMember = pendingDecision?.routedToId
    ? members.find((m) => m.userId === pendingDecision.routedToId)
    : undefined;
  // Named by display name only — never the email (MOTIR-6646).
  const routedToName = routedMember ? personDisplayName(routedMember) : null;
  // The pickers' CANDIDATE lists exist only for a reader who holds the key the
  // picker's control writes with — `watcher:manage` for adding watchers,
  // `comment:add` for the composer's mentions. A reader without it (a Viewer, and
  // every Visitor) is handed none, so no roster of people crosses the wire for a
  // control they do not have (MOTIR-6646).
  const candidateRoster = members.map((m) => ({ id: m.userId, name: m.name, email: m.email }));
  const watcherCandidates = held.has('watcher:manage') ? candidateRoster : [];
  const mentionCandidates = held.has('comment:add') ? candidateRoster : [];

  // Archived state (Story 2.9 · Subtask 2.9.6) — an archived item's detail page
  // renders (the read doesn't filter `archivedAt`), so it gets a top-of-main
  // banner + an eyebrow chip as the archived-state signal. The WHEN is formatted
  // server-side (locale-aware, the same `formatDate` the 2.9.3 list view uses);
  // the WHO rides `detail.archivedBy` (latest `'archived'` revision).
  const isArchived = item.archivedAt != null;
  // The item's status CATEGORY (bug MOTIR-2084) — resolved through the workflow
  // the detail bundle already carries, the same lookup `CoreFieldsPanel` does for
  // the Sprint field's empty label. The category, never the `'done'` KEY: this
  // project's workflow already has two done-category statuses (Done, Cancelled)
  // and a project may define more.
  const statusCategory =
    detail.workflow.statuses.find((s) => s.key === item.status)?.category ?? null;
  const archivedAtLabel = item.archivedAt ? formatDate(item.archivedAt, locale) : '';
  // THE RUN HOSTED RULE (MOTIR-691) — who may start a hosted run on this card: the Run
  // section's door, Continue hosted and *Fix on the hosted agent* all follow it.
  // ⚠️ NEVER on a MANUAL card (Story MOTIR-7459 · MOTIR-7467): nothing runs one, so
  // no hosted door may render for it through any path — its slot is Guide me through.
  const isManual = isManualReadyItem({ type: item.type, executor: item.executor });
  const canRunHosted = !isManual && canEdit && !isArchived && statusCategory !== 'done';
  // GUIDE ME THROUGH'S DOOR (A2.7): a manual card not Done or archived, a reader who
  // may edit it, and Motir AI available to them — the shell's `showPlanWithAi`
  // predicate (`app/(authed)/layout.tsx`; `ai:plan` is its AI_PLANNING_REQUIREMENT).
  // Out of credits is not an absence: the overlay shows the paywall on the turn.
  const showGuideDoor =
    isManual &&
    canEdit &&
    !isArchived &&
    statusCategory !== 'done' &&
    isMotirAiConfigured() &&
    held.has('ai:plan');
  const firstUnticked = todoList.items.findIndex((todo) => !todo.done);
  const guideProgress =
    todoList.progress.total > 0
      ? {
          done: todoList.progress.done,
          total: todoList.progress.total,
          next: firstUnticked >= 0 ? firstUnticked + 1 : null,
        }
      : null;
  // SEND TO MY AGENT (Story MOTIR-6864 · MOTIR-7028) — the start bar's second
  // option, beside Run: the Run rule AND the right to use agents on the project
  // (`instance:use`, the gate My agents and the agents read both enforce). A
  // Visitor holds neither.
  const canSendToAgent = canRunHosted && !isVisitor && held.has('instance:use');

  const page = (
    <EstimationConfigProvider config={estimationConfig} canEdit={canEdit}>
      {/* THE ERRORS DOOR (MOTIR-5744): the ⋯ menu (header) and the Errors section
          (late stack) are two page tiers; this is the one channel between them. */}
      <MonitorErrorsDoorProvider>
        {/* THE PAGE'S OPTIMISTIC STATUS CHANNEL (Bug MOTIR-5212) — the one way a
        decision taken in the approval frame can reach the core-fields rail
        before a server render lands. It wraps BOTH islands because that is the
        whole point: the writer is in `LateLowerSections`, the reader is in the
        `aside`, and they are siblings with no other channel between them.
        Seeded with the status THIS render read, which is also what reconciles
        the override the moment a fresher one arrives. */}
        <OptimisticStatusProvider serverStatus={item.status}>
          <OptimisticMarkProvider serverMark={item.obsolescence}>
            {/* THE PAGE'S PLACEMENT CHANNEL (Story MOTIR-5309 · MOTIR-5381) — where the
        item sits, seeded from THIS render's placement read. The rail's Parent and
        Folder fields report a move; the eyebrow's breadcrumb repaints from the
        server's answer without a reload. */}
            <PlacementProvider
              serverPlacement={{
                folderId: detail.folderId,
                parent: detail.parent,
                ancestors: detail.ancestors,
                placementFolder: detail.placementFolder,
              }}
            >
              <div className="flex flex-col gap-6">
                {/* Header — type icon · identifier · parent breadcrumb · title +
          Edit link. The breadcrumb (2.4.3) renders the ancestor chain right
          after the identifier, per the detail.png eyebrow. (Status lives in the
          core-fields rail's StatusPicker, not the eyebrow — 2.4.13.) */}
                <header className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <IssueTypeIcon type={item.kind as IssueType} className="h-5 w-5 shrink-0" />
                    {/* data-testid: the header identifier is asserted by several E2E
              journeys; the bare text is no longer unique on the page (the
              Development empty-state copy also names the key — MOTIR-1579). */}
                    <span
                      data-testid="item-identifier"
                      className="text-(--el-text-muted) font-mono text-sm"
                    >
                      {item.identifier}
                    </span>
                    {/* bug-issue-detail-eyebrow-overflows-viewport: the breadcrumb sits in
              a `min-w-0 flex-1` cell so it has a BOUNDED track to truncate against
              — its inner `<span className="truncate">` (ParentBreadcrumb) only
              fires inside a bounded parent. Without this cell the breadcrumb sits
              as a bare flex child and resolves to its min-content width (a flex
              item defaults to `min-width:auto`), so a long ancestor chain pushes
              the whole page wider than the viewport and clips the right cluster +
              core-fields rail. Short / no-ancestor items render exactly as before
              (the cell collapses to content width at the left). */}
                    {/* `flex-wrap gap-y-2` (MOTIR-5878): the decision-waiting marker joins
              this cell after the breadcrumb, and at 390px it takes its own line
              rather than squeezing the breadcrumb (design panel 6). */}
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">
                      <PlacementBreadcrumb />
                      {/* 2.9.6: the always-visible "Archived" chip follows the breadcrumb
                so the archived state stays legible when the page is scrolled past
                the banner. Neutral register (NOT a colored Pill tone) — the only
                eyebrow tag (the status Pill was removed in 2.4.13). */}
                      {isArchived ? (
                        <Pill className="shrink-0 border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)">
                          <Archive className="size-3 text-(--el-text-muted)" aria-hidden />
                          {t('archivedEntry')}
                        </Pill>
                      ) : null}
                      {/* A Visitor's PRIVATE EPIC (MOTIR-6648, design MOTIR-6641 panel
                8): the epic's own row stays, marked with the shipped public
                marker. `childrenHidden` is set only on a Visitor's read. */}
                      {detail.childrenHidden ? <EpicNotPublicPill /> : null}
                      {/* THE DECISION-WAITING MARKER (MOTIR-5878): loud when the decision
                is the reader's, quiet naming who it waits on, nothing otherwise.
                A pointer to the gate's section — never a Review & approve door. */}
                      {pendingDecision ? (
                        <DecisionWaitingHeaderLink
                          decision={pendingDecision}
                          routedToName={routedToName}
                        />
                      ) : null}
                      {/* THE OBSOLESCENCE BADGE (MOTIR-6674): the cell's LAST member,
                a pointer that scrolls to the rail's Obsolescence field. Nothing at
                all on an unmarked item. */}
                      <OptimisticObsolescenceHeaderLink serverMark={item.obsolescence} />
                    </div>
                    <div className="ml-auto flex items-center gap-3">
                      {/* Epic/parent subtree roll-up (4.3.5) — labelled so it never reads
                as the parent's OWN estimate; shown only when it has descendants. */}
                      {parentRollup ? (
                        <ParentRollupBadge
                          itemId={item.id}
                          initialTotal={parentRollup.total}
                          variant="header"
                        />
                      ) : null}
                      {/* MOTIR-910: the per-item Plan / Re-plan door — FIRST in the
                right cluster, before Watch / ⋯ (the plan-replan-entrance
                mockup's panel-1 placement). Plan when the item has no children
                yet, Re-plan when it does. BOTH whether it renders and which face
                it wears are the entrance's own call (`planEntranceFace`,
                MOTIR-2084 + MOTIR-2097) — this page just hands over the item
                state: the actor's capability, the archived flag (MOTIR-2050),
                the terminal status category, and the kind + children/description
                the face is picked from. */}
                      <WorkItemPlanEntrance
                        itemKey={item.identifier}
                        hasChildren={detail.children.length > 0}
                        kind={item.kind}
                        hasDescription={(item.descriptionMd ?? '').trim().length > 0}
                        canPlan={canEdit}
                        archived={isArchived}
                        statusCategory={statusCategory}
                      />
                      {/* 5.4.9: the watch control + watchers popover — BEFORE Edit,
                beside the roll-up badge (the labels-components-watch mockup's
                panel-0 placement). Every viewer gets it: watching is not
                editing (the verified permission split). */}
                      {isVisitor ? null : (
                        <WatchControl
                          workItemId={item.id}
                          initialCount={detail.watcherCount}
                          initialWatching={detail.viewerIsWatching}
                          currentUserId={ctx.userId}
                          candidates={watcherCandidates}
                        />
                      )}
                      {/* 2.8.4: the ⋯ actions menu — Edit details · Copy link · Archive
                · Delete… (Edit folded in here). Permission-gated: Edit/Archive
                on canEdit, Archive + Delete on canDelete. 2.9.11: on an archived
                item the menu swaps Archive→Restore and Delete… opens the
                archived confirm. */}
                      <WorkItemDetailActions
                        itemId={item.id}
                        identifier={item.identifier}
                        title={item.title}
                        canEdit={canEdit}
                        canArchive={canArchive}
                        canDelete={canDelete}
                        archived={isArchived}
                        activeSprintId={activeSprint?.id ?? null}
                        activeSprintName={activeSprint?.name ?? null}
                        inActiveSprint={activeSprint != null && item.sprintId === activeSprint.id}
                      />
                    </div>
                  </div>
                  {/* The title row and the TRANSLATION BAR (MOTIR-8122; design MOTIR-8112
                  § Entry and access path): the mark sits beside the h1, outside it, so
                  the heading's name stays the title; the bar sits directly under it. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="text-(--el-text) font-serif text-2xl font-semibold">
                      <TranslatableTitle
                        title={item.title}
                        projectIdentifier={ctx.project.identifier}
                        workItemRefs={workItemRefs}
                      />
                    </h1>
                    <FieldTranslationMark fieldRef={fieldRef.title()} field="title" />
                  </div>
                  <TranslateControl />
                </header>

                {/* Body — two columns; later subtasks fill the regions. The `1fr` track is
          `minmax(auto, 1fr)`, so `min-w-0` on the content column floors its min-content to
          0 — otherwise a wide markdown child (a long unbroken URL, a code block, a
          wide table) blows the track past the viewport. The code block itself
          scrolls inside its own `.motir-prose pre` (overflow-x:auto), but only once
          this track is bounded. Sibling of the eyebrow fix above —
          bug-issue-detail-eyebrow-overflows-viewport.
          The content column is a `<div>`, NOT a `<main>`: `AppLayout` already renders
          this document's one `main` landmark around the page, and a second nested
          inside it gave assistive tech two main regions (MOTIR-5432, guarded by
          `tests/navigation/shell-single-main-landmark.test.ts`). */}
                <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_18rem]">
                  <div className="flex min-w-0 flex-col gap-6">
                    {/* 2.9.6: the archived banner is the FIRST element of the main column,
              above Description — the page's archived-state signal + Restore. */}
                    {isArchived ? (
                      <ArchivedBanner
                        itemId={item.id}
                        identifier={item.identifier}
                        archivedByName={detail.archivedBy?.name ?? null}
                        archivedAtLabel={archivedAtLabel}
                        canEdit={canEdit}
                      />
                    ) : null}
                    {/* MOTIR-6611: the To fix banner — after the archived banner and
              BEFORE the pending-plan notice (present before future: what the card
              IS, what holds it now, what a plan proposes it become). Renders
              nothing when nothing is waiting on a repair, which is nearly every
              card, or on a done card. */}
                    <ToFixBanner
                      identifier={item.identifier}
                      fixReason={detail.fixReason}
                      fixDetail={detail.fixDetail}
                      fixGroup={detail.fixGroup}
                      statusCategory={statusCategory}
                      repairRun={repairRun}
                      hostedDoor={
                        reviewSentBack && canRunHosted ? (
                          <ToFixHostedDoor itemKey={item.identifier} viewerId={ctx.userId} />
                        ) : null
                      }
                    />
                    {/* MOTIR-4197: the pending-plan indicator — LAST in the slot,
              after the archived banner and the To fix banner when they render (present before
              future: what this card IS, then what a plan proposes it BECOME).
              Nothing renders — no reserved box — when no undecided plan names
              this card, which is nearly every card, or when the actor lacks
              `plan:view_any` (then `pendingPlans` is null: the read was skipped). */}
                    {pendingPlans && pendingPlans.length > 0 ? (
                      <PendingPlanNotice identifier={item.identifier} proposals={pendingPlans} />
                    ) : null}
                    <ContentSectionCard
                      title={t('description')}
                      subtitle={t('descriptionGloss')}
                      headerExtra={
                        <FieldTranslationMark
                          fieldRef={fieldRef.description()}
                          field="description"
                        />
                      }
                      editHref={
                        canEdit
                          ? (routes.path(`/items/${item.identifier}/edit`) ?? undefined)
                          : undefined
                      }
                    >
                      {item.descriptionMd ? (
                        <TranslatableMarkdown
                          fieldRef={fieldRef.description()}
                          value={item.descriptionMd}
                          aria-label={t('issueDescriptionAria')}
                          workItemRefs={workItemRefs}
                          pageRefs={pageRefs}
                        />
                      ) : (
                        <p className="font-sans text-sm text-(--el-text-secondary) italic">
                          {t('noDescription')}
                        </p>
                      )}
                    </ContentSectionCard>
                    <IssueExplanation
                      explanationMd={item.explanationMd}
                      explanationSource={item.explanationSource}
                      editHref={
                        canEdit
                          ? (routes.path(`/items/${item.identifier}/edit`) ?? undefined)
                          : undefined
                      }
                      workItemRefs={workItemRefs}
                      pageRefs={pageRefs}
                    />
                    {/* MOTIR-3815: the to-do list — after Explanation and BEFORE
              Relationships, the slot `design/work-items/todo-list.mock.html`
              panel 0 measures. `canEdit` is the same `work_item:edit` the rest
              of this page reads; the section hides its controls without it and
              every action re-checks server-side, because a hidden control is
              not an authorization. */}
                    <TodoListSection
                      workItemId={item.id}
                      initialTodos={todoList.items}
                      initialProgress={todoList.progress}
                      initialWorkItemRefs={todoRefs}
                      canEdit={canEdit}
                    />
                    {/* 2.4.5: the relationships section + ready/blocked banner — a left-
              column section card (per the approved mockup), after Explanation.
              2.4.9: editable here (add control + per-row remove). */}
                    <RelationshipsPanel
                      blockedBy={detail.blockedBy}
                      blocks={detail.blocks}
                      relatesTo={detail.relatesTo}
                      duplicates={detail.duplicates}
                      clones={detail.clones}
                      supersedes={detail.supersedes}
                      supersededBy={detail.supersededBy}
                      readiness={detail.readiness}
                      currentStatus={item.status}
                      // MOTIR-2050: the page already knows the archived state (the banner
                      // above renders off it) — pass it down so the readiness badge is
                      // suppressed too, instead of contradicting the banner.
                      archived={isArchived}
                      workflow={detail.workflow}
                      editable={canEdit}
                      currentItemId={item.id}
                      identifier={item.identifier}
                    />
                    {/* 7.10.11 (MOTIR-1579): the Development section — linked PRs with
              PR/CI state, per design/github Panel 5a: a ContentSectionCard after
              Relationships (the linkage cluster), same shared body as the peek.
              7.10.14 (MOTIR-1596): the explicit-link affordance — the "+ Link
              pull request" door (header) + inline picker (body) share state via
              the provider; gated on canEdit (a read-only actor sees no door and
              the caption drops the "or linked by hand" clause). The peek stays
              read-only (no door). */}
                    {/* THE LATE STACK, upper half — Development · Acceptance · Design
              result (Subtask MOTIR-3436). Both halves await the SAME
              `lateReads` promise, so they resolve in one tick and the page
              settles ONCE for the whole stack, as the design decided. They are
              two boundaries only because `ChildPanel` below is TIER TWO and the
              page renders it between them. */}
                    <Suspense fallback={<LateUpperFallback />}>
                      <LateUpperSections
                        reads={lateReads}
                        itemId={item.id}
                        itemIdentifier={item.identifier}
                        currentUserId={ctx.userId}
                        canEdit={canEdit}
                        repoDelivery={deliveryView.repos}
                        deliveries={deliveryView.deliveries}
                        statusCategory={statusCategory}
                        statusLabel={
                          detail.workflow.statuses.find((s) => s.key === item.status)?.label ?? null
                        }
                        canReplan={canEdit && !isArchived}
                        parentIdentifier={detail.parent?.identifier ?? null}
                        manual={
                          isManual
                            ? { door: showGuideDoor ? { progress: guideProgress } : null }
                            : null
                        }
                        hostedDoor={
                          canRunHosted
                            ? {
                                ready: detail.readiness.ready,
                                openBlockers: detail.readiness.openBlockers.length,
                                agents: canSendToAgent ? { projectName: ctx.project.name } : null,
                              }
                            : null
                        }
                      />
                    </Suspense>
                    {detail.childrenHidden ? (
                      // The children panel REPLACED for a Visitor's private epic
                      // (design MOTIR-6641 panel 8) — no count, no rows.
                      <EpicNotPublicBlock />
                    ) : (
                      <ChildPanel
                        count={detail.children.length}
                        itemId={item.id}
                        itemIdentifier={item.identifier}
                        projectKey={ctx.project.identifier}
                      >
                        <ChildList
                          items={detail.children}
                          workflow={detail.workflow}
                          members={members}
                        />
                      </ChildPanel>
                    )}
                    {/* MOTIR-5547: the plan history — after Children (a plan that added
              work items under this card reads right under them), before the late
              stack's lower half. Renders nothing for an actor without
              `plan:view_any` (then `planHistory` is null: the read was skipped)
              and nothing for a card no plan ever touched. */}
                    {planHistory ? (
                      <PlanHistorySection
                        itemId={item.id}
                        identifier={item.identifier}
                        initial={planHistory}
                      />
                    ) : null}
                    {/* 5.2.5: the Attachments panel — after Children, before Activity
              (the reserved Epic-5 slot, per the attachments mockup's panel 0;
              content-width and multi-row, so the left column — the rail is
              for scalars). */}
                    {/* THE LATE STACK, lower half — Pages · Attachments · Activity. KEYED on the
              activity tab so switching `?activity=` re-shows the fallback
              instead of freezing on the previous tab's content (the shipped
              `/items` pattern). */}
                    <Suspense
                      key={activityTab}
                      fallback={<LateLowerFallback withPages={canViewPages} />}
                    >
                      <LateLowerSections
                        reads={lateReads}
                        itemId={item.id}
                        itemIdentifier={item.identifier}
                        canViewPages={canViewPages}
                        canEditWorkItem={canEdit}
                        currentUserId={ctx.userId}
                        currentUserName={pageCtx.actorName ?? ''}
                        workflowStatuses={detail.workflow.statuses}
                        mentionCandidates={mentionCandidates}
                        activityTab={activityTab}
                      />
                    </Suspense>
                  </div>

                  <aside className="flex flex-col gap-4">
                    <CoreFieldsPanel
                      item={item}
                      heldTransitions={heldTransitions}
                      planHold={planHold}
                      workItemRefs={workItemRefs}
                      members={members}
                      workflow={detail.workflow}
                      parent={detail.parent}
                      reporterIsSelf={item.reporterId === ctx.userId}
                      customFields={detail.customFields}
                      repoDelivery={deliveryView.repos}
                      deliveries={deliveryView.deliveries}
                      labelsComponents={{
                        projectKey: ctx.project.identifier,
                        labels: detail.labels,
                        components: detail.components,
                        projectComponents,
                        canManageComponents: held.has('component:manage'),
                      }}
                      sprints={sprints}
                    />
                    {/* Epic-level privacy (Story 6.14 · 6.14.7) — the project-admin
              set/unset control, EPIC-kind only. A non-admin member sees it
              read-only (design invariant #4); public-read hiding is enforced
              server-side (6.14.4). */}
                    {item.kind === 'epic' ? (
                      <EpicPrivacyControl
                        workItemId={item.id}
                        initialHidden={item.publicChildrenHidden}
                        canManageProject={canManageProject}
                      />
                    ) : null}
                    {/* The 2.4.3 parent breadcrumb lives in the header (per detail.png),
              not here. Epic 5: custom fields · attachments. */}
                  </aside>
                </div>
              </div>
              {/* The shared quick-view (peek) modal — driven by `?peek=<identifier>`.
        Mounted here so the RelationshipsPanel rows can open a linked item in
        the same peek used on the list/board/ready surfaces (8.8.31), without
        navigating away from this detail page. */}
              <IssueQuickViewController />
            </PlacementProvider>
          </OptimisticMarkProvider>
        </OptimisticStatusProvider>
      </MonitorErrorsDoorProvider>
    </EstimationConfigProvider>
  );
  // THE TRANSLATION PROVIDER (MOTIR-8122) wraps the view only when there is an
  // offer: the public page (and a failed offer read) renders exactly as before,
  // with no provider and no control. The tree above is bound to `page` so the
  // wrap does not re-indent four hundred lines.
  return readerTranslation ? (
    <TranslationProvider itemId={item.id} translation={readerTranslation} liveRefresh>
      <RelatedTitles projectKey={ctx.project.identifier}>{page}</RelatedTitles>
    </TranslationProvider>
  ) : (
    page
  );
}
