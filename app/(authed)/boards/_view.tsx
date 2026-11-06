import { resolveSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitleTranslationProvider,
  SurfaceTitlesNotice,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { getTranslations } from 'next-intl/server';
import { pageMembers, pageScope, type ProjectPageContext } from '@/lib/pages/projectPageContext';
import {
  parseIssueFilter,
  isFilterActive,
  type IssueFilterParams,
} from '@/lib/issues/issueListFilter';
import {
  parseAdvancedFilterParam,
  upgradeFacetsIntoAst,
} from '@/lib/issues/issueListAdvancedFilter';
import { encodeFilterParam } from '@/lib/filters/ast';
import { collectFilterReferentIds } from '@/lib/filters/registry';
import { savedFilterCapabilitiesFromPermissions } from '@/lib/savedFilters/access';
import { workflowsService } from '@/lib/services/workflowsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { labelsService } from '@/lib/services/labelsService';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { AdvancedFilterProvider } from '../items/_components/AdvancedFilterContext';
import { SavedFilterSessionProvider } from '../items/_components/SavedFilterContext';
import { NewIssueButton } from '../items/_components/NewIssueButton';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { BoardContainer } from './_components/BoardContainer';
import { BoardSwitcher } from './_components/BoardSwitcher';
import { BoardFilterControls } from './_components/BoardFilterControls';
import { BoardAppliedFilterBar } from './_components/BoardAppliedFilterBar';

// The Kanban board surface (Story 3.2 · Subtask 3.2.2) — the surface the sidebar
// "Boards" link + the Cmd-K "Go to Boards" entry open (Story 1.5; no nav wiring
// changes). Replaces the old `ProjectStubPage … comingIn="Epic 3"` placeholder.
// Server Component: it resolves the active project, renders the page header +
// toolbar immediately, then hands off to the client `BoardContainer`, which
// fetches the Story-3.1.6 projection (`GET /api/board`) and owns the board-level
// loading / error / no-board states. The page itself does NO data access for the
// board (it's a pure consumer) — the only reads here are the workspace members
// for the quick-view peek + cards, and the filter facet data (Subtask 6.15.3).
//
// Quick-view peek (mirrors /items, Subtask 2.5.19): a board card click pushes
// `?peek=<identifier>` (via the shared usePeekOpen hook in BoardContainer); when
// that param is present this page mounts the SAME IssueQuickView modal the issue
// list uses — reused, not rebuilt — with the item's fields streamed behind a
// <Suspense>. Closing clears the param. Unauthenticated → /sign-in; no active
// project → a hint.
//
// Board filtering (Story 6.15 · Subtask 6.15.3): the toolbar's `[Filter]` seam is
// now the working board filter — the SAME shipped /items primitives
// (IssueFilterBar quick popover · IssueAdvancedFilter builder · SavedFilterDropdown
// picker · the applied summary bar), re-pointed at the board via a board-scoped
// `buildHref` (BoardFilterControls / BoardAppliedFilterBar). The active filter
// lives in the URL (the `kind`/`type`/`status`/`assignee`/`q` facets + the
// advanced `?filter=v1:` AST) composing with `?board=`, so it's shareable,
// reload-safe, and per board. This page parses that filter, MERGES the facets +
// advanced into one AST (the board read takes a single predicate, unlike the
// /items read which threads facets + AST separately), and passes the encoded
// param + an `isActive` flag to BoardContainer, whose `/api/board` fetch carries
// it so the server (6.15.2) re-projects to the matching set.

export default async function BoardView({
  ctx: pageCtx,
  searchParams,
}: {
  ctx: ProjectPageContext;
  searchParams: Promise<{ peek?: string; board?: string } & IssueFilterParams>;
}) {
  const t = await getTranslations('boards');
  const ctx = pageScope(pageCtx);

  // Story 6.4.6 — the active project may be one the actor can no longer browse
  // (e.g. it was made private while pinned). Gate the board read on canBrowse and
  // render the no-access state instead of crashing; canEdit drives the board's
  // read-only (drag-disabled) mode below. Both read the reader's permission SET
  // (MOTIR-6643), so a Visitor's keys reach them too.
  const held = await pageCtx.permissions();
  const caps = { canBrowse: held.has('project:browse'), canEdit: held.has('work_item:edit') };
  if (!caps.canBrowse) {
    const ta = await getTranslations('projectAccess');
    return (
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
        </header>
        <NoAccessState
          title={ta('noAccessTitle')}
          description={ta('noAccessDescription')}
          backHref="/dashboard"
          backLabel={ta('backToProjects')}
        />
      </div>
    );
  }

  const sp = await searchParams;
  // The selected board (Subtask 3.7.5) — `?board=<id>` picks which of the
  // project's boards to show; absent → the project's default board. URL-driven
  // (mirrors `?peek`) so it's shareable / reload-safe; the 3.7.4 switcher writes
  // it. Passed to the client BoardContainer, which fetches that board's
  // projection (`GET /api/board?boardId=`); a stale / cross-project id resolves
  // to a 404 board-not-found, surfaced as the board error state.
  const selectedBoardId = sp.board?.trim() || undefined;

  // The board FILTER (Story 6.15.3) — parsed from the URL exactly as /items:
  // the facets (`kind`/`type`/`status`/`assignee`/`q`) + the advanced `?filter=v1:`
  // AST. A malformed/forged advanced param is the recoverable state — it's nulled
  // before threading so no navigation re-carries it (mirrors /items), and the
  // board reads facets-only / unfiltered.
  let filter = parseIssueFilter(sp);
  const advanced = parseAdvancedFilterParam(filter.advanced);
  if (advanced.state !== 'active') filter = { ...filter, advanced: null };
  const ast = advanced.state === 'active' ? advanced.ast : null;
  const filterActive = isFilterActive(filter) || ast !== null;

  // The board read (6.15.2) takes a SINGLE predicate, so merge the facets + the
  // advanced AST into one AST (the lossless AND-merge the facet→advanced upgrade
  // uses) and encode it as the `?filter=v1:` codec param the `/api/board` route
  // decodes. Empty (nothing selected) → no param → the unfiltered projection.
  const effectiveAst = upgradeFacetsIntoAst(filter, ast);
  const filterParam = effectiveAst.conditions.length > 0 ? encodeFilterParam(effectiveAst) : '';

  // Members resolve assignee / reporter ids to display names — for the board
  // cards' assignee avatars (the projection carries only `assigneeId`, Story
  // 3.1.4) AND for the quick-view panel when a peek is open. The filter facet
  // data (Subtask 6.15.3) mirrors the /items toolbar reads: the workflow's
  // statuses (the Status facet), the project's sprints + custom-field defs +
  // components (the advanced builder's value editors), and — for a shared/saved
  // URL — the advanced AST's referenced labels resolved to names (the only ids
  // the URL carries; the resolve is skipped when the AST has no label condition;
  // never load-all, finding #57). `workflow` ALSO resolves `statusByKey` for the
  // scrum header's Complete-sprint dialog. All BOUNDED reads; the page calls
  // services only (never Prisma) per the 4-layer rule. Assignable users are
  // scoped by access level (6.4.6): a private project lists only its project
  // members; open/limited list the whole workspace.
  const referencedLabelIds = ast ? collectFilterReferentIds(ast).labelIds : [];
  // `ctx.service` / `ctx.read` are the reader's contexts — a member's own, or a
  // Visitor's (MOTIR-6648): the component list takes `read`, so a Visitor gets its
  // default assignees by name only; the members are name-only for a Visitor too.
  const wsCtx = ctx.service;
  const [members, workflow, sprints, customFields, components, referencedLabels, titleTranslation] =
    await Promise.all([
      pageMembers(ctx),
      workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
      sprintsService.listByProject(ctx.projectId, wsCtx),
      customFieldsService.listFields({
        key: ctx.project.identifier,
        actorUserId: wsCtx.userId,
        ctx: wsCtx,
      }),
      componentsService.listComponents(ctx.project.identifier, ctx.read),
      labelsService.resolveByIds(ctx.project.identifier, referencedLabelIds, wsCtx),
      // The reader's title-translation context (Story MOTIR-7738 · MOTIR-8833).
      resolveSurfaceTranslation(ctx.project, ctx.read),
    ]);

  // The saved-filter tier (Subtask 6.2.3) — { canBrowse, canShare, canManageAny },
  // distinct from the drag-edit `caps` above. Powers the [Saved] dropdown + the
  // applied bar's save dialog (the same `Viewer` shape /items uses).
  const savedFilterCaps = savedFilterCapabilitiesFromPermissions(held);

  const viewer = { userId: ctx.userId, ...savedFilterCaps };

  return (
    // The filter UI providers (shared with /items): the advanced-popover open
    // state and the saved-filter session (applied chip + dropdown open). They
    // wrap BOTH the header controls AND the body's applied bar so those separate
    // subtrees share the one set of flags.
    <AdvancedFilterProvider>
      <SavedFilterSessionProvider>
        <SurfaceTitleTranslationProvider
          projectKey={ctx.project.identifier}
          context={titleTranslation}
        >
          <div className="flex flex-col gap-6">
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h1 className="font-serif text-2xl font-semibold text-(--el-text)">
                  {t('heading')}
                </h1>
                <p className="text-sm text-(--el-text-muted)">
                  {t('subtitle', { project: ctx.project.name })}
                </p>
              </div>
              {/* `flex-wrap`: the toolbar is wider than the header in a long or CJK
                  language (fr "Changer de Tableau", ja デフォルト / グループ化),
                  and a squeezed control clipped its label or broke it across
                  lines. The cluster wraps onto a second row instead, so every
                  control keeps its own width (MOTIR-7761's walk; remedy 2). */}
              <div className="flex flex-wrap items-center gap-2">
                {/* The board switcher (Subtask 3.7.4) — left of the filter
                    affordances + [+ New issue]. Owns its own board-list fetch +
                    the `?board=` selection, so it stays present across the
                    board's loading / error / empty states. */}
                <BoardSwitcher />
                {/* Group-by slot — BoardContainer portals its GroupByControl here
                    so the control sits in this header row, while its state stays
                    with the board projection. `display:contents` so the portaled
                    control is a direct flex child. */}
                <div id="board-toolbar-groupby-slot" className="contents" />
                {/* The board filter (Subtask 6.15.3) — the SAME shipped /items
                    [Filter] · [Advanced] · [Saved] primitives, re-pointed at the
                    board via a board-scoped buildHref. Replaces the old disabled
                    [Filter] seam. */}
                <BoardFilterControls
                  selectedBoardId={selectedBoardId}
                  filter={filter}
                  ast={ast}
                  statuses={workflow.statuses}
                  members={members}
                  sprints={sprints}
                  customFields={customFields}
                  components={components}
                  referencedLabels={referencedLabels}
                  projectKey={ctx.project.identifier}
                  viewer={viewer}
                />
                <SurfaceShowOriginalSwitch />
                <NewIssueButton />
              </div>
            </header>

            <SurfaceTitlesNotice />

            {/* The applied-filter summary row (Subtask 6.15.3) — the saved-filter
                name chip + the condition chips + Clear, between the toolbar and
                the board. Renders nothing when no filter is applied. */}
            <BoardAppliedFilterBar
              selectedBoardId={selectedBoardId}
              projectKey={ctx.project.identifier}
              viewer={viewer}
              filter={filter}
              ast={ast}
              statuses={workflow.statuses}
              members={members}
              sprints={sprints}
              customFields={customFields}
              components={components}
              referencedLabels={referencedLabels}
            />

            <BoardContainer
              members={members}
              activeProjectId={ctx.projectId}
              selectedBoardId={selectedBoardId}
              canEdit={caps.canEdit}
              projectName={ctx.project.name}
              workflow={workflow}
              filterParam={filterParam}
              filterActive={filterActive}
            />

            {/* Quick-view peek (Subtask 2.5.19; bug 8.8.2) — a client island that
                watches `?peek` and renders the modal frame + skeleton instantly,
                then client-fetches the item from /api/work-items/peek. Decoupled from
                this page's server render, so opening/closing is a pure shallow URL
                change with no board refetch. */}
            <IssueQuickViewController />
          </div>
        </SurfaceTitleTranslationProvider>
      </SavedFilterSessionProvider>
    </AdvancedFilterProvider>
  );
}
