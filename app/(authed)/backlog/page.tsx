import { resolveSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitleTranslationProvider,
  SurfaceTitlesNotice,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ExternalLink } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import {
  parseIssueFilter,
  isFilterActive,
  appendFilterParams,
  type IssueFilterParams,
} from '@/lib/issues/issueListFilter';
import { parseAdvancedFilterParam } from '@/lib/issues/issueListAdvancedFilter';
import { collectFilterReferentIds } from '@/lib/filters/registry';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { estimationService } from '@/lib/services/estimationService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import { sprintsService } from '@/lib/services/sprintsService';
import { projectAiSettingsService } from '@/lib/services/projectAiSettingsService';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { customFieldsService } from '@/lib/services/customFieldsService';
import { componentsService } from '@/lib/services/componentsService';
import { labelsService } from '@/lib/services/labelsService';
import { foldersService } from '@/lib/services/foldersService';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { AdvancedFilterProvider } from '../items/_components/AdvancedFilterContext';
import { SavedFilterSessionProvider } from '../items/_components/SavedFilterContext';
import { NewIssueButton } from '../items/_components/NewIssueButton';
import { BacklogContainer } from './_components/BacklogContainer';
import { BacklogFilterControls } from './_components/BacklogFilterControls';
import { BacklogAppliedFilterBar } from './_components/BacklogAppliedFilterBar';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// The Backlog / sprint-planning surface (Story 4.2 · Subtask 4.2.3) — Motir's
// clone of the Jira backlog. The destination the new "Backlog" sidebar item +
// the ⌘K "Go to Backlog" entry open. Server Component: it resolves the active
// project, renders the page header + toolbar immediately, then hands off to the
// client `BacklogContainer`, which fetches the sprint list + the bounded backlog
// page and owns the region-level loading / error / empty states.
//
// The page resolves `workflow` (status key → label/category for the row status
// pills) and `members` (assignee id → name for the avatars) ONCE here — services
// only, never Prisma (4-layer) — and threads them to the client container; the
// bound `WorkItemSummaryDto` rows carry only the keys.
//
// FILTER (Story 8.8 · Subtask 8.8.18): the formerly-disabled `[Filter]` seam is
// now wired to the SAME shipped /items filter UI the board reuses (6.15.3) —
// quick popover + advanced builder + saved picker + applied summary — re-pointed
// at `/backlog` via `buildBacklogFilterHref`. The active filter lives in the URL
// (reload-safe), and its serialized params ride the client's `/api/backlog` +
// `/api/sprints/[id]/issues` fetches so BOTH regions re-project to the matching
// set (the 8.8.16 design; the sprint read became filter-aware in 8.8.20). The
// page parses the filter exactly as /items + the board and resolves the bounded
// filter referents (statuses · members · sprints · custom fields · components ·
// the AST's referenced labels) for the toolbar's value editors.
//
// Toolbar: a **View all issues** link deep-linking to the project's issue
// navigator (`/items`, Story 2.5), now CARRYING the active filter (Jira's "View
// in Issue Navigator" with the board's filter applied); the enabled `[Filter]`
// cluster; and `[+ New issue]`.

export default async function BacklogPage({
  searchParams,
}: {
  searchParams: Promise<IssueFilterParams>;
}) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('backlog');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // Parse the URL filter exactly as /items + the board (6.15.3): the quick
  // facets + the decoded advanced AST. A malformed/forged `?filter=` degrades to
  // facets-only (the page never emits a bad param).
  const sp = await searchParams;
  let filter = parseIssueFilter(sp);
  const advanced = parseAdvancedFilterParam(filter.advanced);
  if (advanced.state !== 'active') filter = { ...filter, advanced: null };
  const ast = advanced.state === 'active' ? advanced.ast : null;
  const filterActive = isFilterActive(filter) || ast !== null;

  // The serialized filter querystring the client appends to its region fetches
  // (`/api/backlog?…` + `/api/sprints/[id]/issues?…`), so both regions re-project
  // to the matching set. The SAME canonical params the URL carries — the routes
  // parse them with `parseIssueFilter` (8.8.17/8.8.20). Empty → '' (unfiltered).
  const filterParams = new URLSearchParams();
  appendFilterParams(filterParams, filter);
  const filterQuery = filterParams.toString();

  // "View all issues" carries the active filter into the navigator (the Jira
  // "View in Issue Navigator with the filter applied" behaviour the backlog
  // design-notes anticipated): /items parses the same params.
  const viewAllHref = filterQuery ? `/items?${filterQuery}` : '/items';

  const accessCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const referencedLabelIds = ast ? collectFilterReferentIds(ast).labelIds : [];
  const [
    workflow,
    members,
    estimationConfig,
    caps,
    assignableMembers,
    sprints,
    customFields,
    components,
    folders,
    referencedLabels,
    savedFilterCaps,
    aiSettings,
    titleTranslation,
  ] = await Promise.all([
    workflowsService.getWorkflow(ctx.projectId, ctx.workspaceId),
    workspacesService.listMembers(ctx.workspaceId, ctx.userId),
    // The estimation config (Subtask 4.3.4) + edit capability, read once here so
    // every inline EstimateBadge on the backlog shares them (no per-row fetch).
    estimationService.getEstimationConfig(ctx.projectId, accessCtx),
    projectAccessService.getCapabilities(ctx.projectId, accessCtx),
    // The filter referents (Subtask 8.8.18) — the SAME bounded reads the /items
    // + board toolbars resolve (finding #57: never load-all). Assignable users
    // are access-scoped (6.4.6): a private project lists only its members.
    assignableMembersService.list({
      projectId: ctx.projectId,
      accessMode: ctx.project.accessMode,
      ctx: accessCtx,
    }),
    sprintsService.listByProject(ctx.projectId, accessCtx),
    customFieldsService.listFields({
      key: ctx.project.identifier,
      actorUserId: ctx.userId,
      ctx: accessCtx,
    }),
    componentsService.listComponents(ctx.project.identifier, accessCtx),
    // The builder's Folder field and the applied bar's folder paths
    // (MOTIR-11668) — the same browse-gated read /items makes, bounded at
    // FOLDER_PICKER_MAX.
    foldersService.listProjectFolders({ projectId: ctx.projectId }, accessCtx),
    labelsService.resolveByIds(ctx.project.identifier, referencedLabelIds, accessCtx),
    projectAccessService.getSavedFilterCapabilities(ctx.projectId, accessCtx),
    // The AI sprint-planning switch (Subtask MOTIR-1750) — browse-gated, so it
    // resolves for every member who can see the backlog. It drives whether the
    // strip's AI door is live or renders disabled with the fix hint; the submit
    // re-checks it server-side (`SprintPlanningDisabledError`), so this only
    // governs the affordance, never the permission.
    projectAiSettingsService.getAiSettings(ctx.project.identifier, accessCtx),
    // The reader's title-translation context (Story MOTIR-7738 · MOTIR-8833).
    resolveSurfaceTranslation(ctx.project, accessCtx),
  ]);

  const viewer = { userId: ctx.userId, ...savedFilterCaps };
  // Whether Motir AI is wired at all (a server-only env probe). Not wired ⇒ the
  // AI door and its hint are both absent: there is nothing for the user to
  // switch on, so promising the capability would be a lie.
  const aiAvailable = isMotirAiConfigured();

  return (
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
              {/* `flex-wrap`: the cluster wraps onto a second row before the
                link's longer translations squeeze it (MOTIR-7759). */}
              <div className="flex flex-wrap items-center gap-2">
                {/* View all issues — Jira's "View in Issue Navigator": deep-links to
                  the project's /items List/Tree (every issue across the backlog
                  AND all sprints), CARRYING the active filter (8.8.18). */}
                <Link
                  href={viewAllHref}
                  className="inline-flex h-(--height-btn-md) items-center gap-2 rounded-(--radius-btn) whitespace-nowrap border border-(--el-border) px-(--spacing-btn-x) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  {t('viewAllIssues')}
                </Link>
                {/* The backlog filter cluster (Subtask 8.8.18) — the enabled
                  `[Filter]` quick popover + `[Advanced]` builder + `[Saved]`
                  picker, the SAME /items components the board reuses (6.15.3). */}
                <BacklogFilterControls
                  filter={filter}
                  ast={ast}
                  statuses={workflow.statuses}
                  members={assignableMembers}
                  sprints={sprints}
                  customFields={customFields}
                  components={components}
                  folders={folders}
                  referencedLabels={referencedLabels}
                  projectKey={ctx.project.identifier}
                  viewer={viewer}
                />
                <SurfaceShowOriginalSwitch />
                <NewIssueButton />
              </div>
            </header>

            <SurfaceTitlesNotice />

            {/* The applied-filter summary row (name chip + condition chips +
              Save/Discard), above the regions; renders nothing when unfiltered. */}
            <BacklogAppliedFilterBar
              projectKey={ctx.project.identifier}
              viewer={viewer}
              filter={filter}
              ast={ast}
              statuses={workflow.statuses}
              members={assignableMembers}
              sprints={sprints}
              customFields={customFields}
              components={components}
              folders={folders}
              referencedLabels={referencedLabels}
            />

            <EstimationConfigProvider config={estimationConfig} canEdit={caps.canEdit}>
              <BacklogContainer
                workflow={workflow}
                members={members}
                projectName={ctx.project.name}
                filterQuery={filterQuery}
                filterActive={filterActive}
                aiSprintPlanningEnabled={aiSettings.aiSprintPlanningEnabled}
                aiAvailable={aiAvailable}
              />
            </EstimationConfigProvider>
          </div>
        </SurfaceTitleTranslationProvider>
      </SavedFilterSessionProvider>
    </AdvancedFilterProvider>
  );
}
