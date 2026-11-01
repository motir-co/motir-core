import type { ProjectDTO } from '@/lib/dto/projects';
import { resolveSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitleTranslationProvider,
  SurfaceTitlesNotice,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CircleDot } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { buttonVariants } from '@/components/ui/Button';
import { ReadyLanes } from './_components/ReadyLanes';
import { ReadyHelpPopover } from './_components/ReadyHelpPopover';
import { ExpansionNudgeBanner } from './_components/ExpansionNudgeBanner';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

// The Ready set — the AI dispatch surface (Story 7.0 · Subtask 7.0.6). A Server
// Component that resolves the active project (the established getActiveProject
// pattern, mirroring /items + /dashboard) and reads `workItemsService.listReady`
// + `countReady` DIRECTLY — the server-component 4-layer path; the HTTP endpoints
// (`GET /api/ready` 7.0.4 / `POST /api/ready/next` 7.0.5) are the BYOK CLI /
// external-agent contract, not this page's read.
//
// Renders exactly what design/ready specifies: header (serif title + neutral
// count chip + project subtitle + the "What is this?" predicate popover), then
// — since Story MOTIR-6829 (`ready--lanes.mock.html`) — the LANE SWITCH over one
// full-height pane: Ready to run (the leaves lane, grouped by runnable container)
// or Bugs, each a virtualized, cursor-streamed ReadyList; or the EmptyState
// (panel 3) when BOTH lanes are empty. The `?peek=<key>` quick-view peek
// reuses the SAME IssueQuickView surface /items + the board use (notes.html #7).

export default async function ReadyPage() {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('ready');
  const tShell = await getTranslations('shell');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  const svcCtx = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const heading = (
    <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
  );
  const subtitle = (
    <p className="text-sm text-(--el-text-muted)">
      {t('subtitle', { project: ctx.project.name, key: ctx.project.identifier })}
    </p>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* The lanes' reads stream in behind an in-page Suspense placed AFTER the
          gates above — never a `loading.tsx` (CLAUDE.md § A `loading.tsx` may NOT
          sit above a route that decides existence). The frame is design/ready
          ready--lanes panel 7: the REAL heading, then card-height blocks. */}
      <Suspense
        fallback={
          <ReadyFrame
            header={
              <header className="flex flex-col gap-1">
                {heading}
                {subtitle}
              </header>
            }
            loadingLabel={tShell('pageLoading')}
          />
        }
      >
        <ReadyBody project={ctx.project} svcCtx={svcCtx} heading={heading} subtitle={subtitle} />
      </Suspense>

      {/* Quick-view peek (notes.html #7; bug 8.8.2) — a client island that
          watches `?peek` and renders the modal frame + skeleton instantly, then
          client-fetches the item from /api/work-items/peek. Decoupled from this
          page's server render, so opening/closing is a pure shallow URL change
          with no underlying-list refetch. */}
      <IssueQuickViewController />
    </div>
  );
}

/** The part of /ready that waits on the lanes' reads — the header's count chip,
 *  the nudge, and the lanes (or the EmptyState when both are empty). */
async function ReadyBody({
  project,
  svcCtx,
  heading,
  subtitle,
}: {
  project: ProjectDTO;
  svcCtx: { userId: string; workspaceId: string };
  heading: React.ReactNode;
  subtitle: React.ReactNode;
}) {
  const t = await getTranslations('ready');
  const projectId = project.id;
  const [leaves, bugs, counts, titleTranslation] = await Promise.all([
    workItemsService.listReadyLanePage(projectId, 'leaf', {}, svcCtx),
    workItemsService.listReadyLanePage(projectId, 'bug', {}, svcCtx),
    workItemsService.countReadyLanes(projectId, svcCtx),
    // The reader's title-translation context (Story MOTIR-7738 · MOTIR-8833).
    resolveSurfaceTranslation(project, svcCtx),
  ]);

  const isEmpty = leaves.items.length === 0 && bugs.items.length === 0;
  const countLabel = counts.hasMore
    ? t('countCapped', { count: counts.leaves })
    : t('count', { count: counts.leaves });

  return (
    <SurfaceTitleTranslationProvider projectKey={project.identifier} context={titleTranslation}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            {heading}
            {isEmpty ? null : <Pill tone="neutral">{countLabel}</Pill>}
          </div>
          {subtitle}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SurfaceShowOriginalSwitch />
          <ReadyHelpPopover />
        </div>
      </header>

      <SurfaceTitlesNotice />

      <ExpansionNudgeBanner />

      {isEmpty ? (
        <EmptyState
          title={t('empty.title')}
          description={t('empty.body')}
          action={
            <Link href="/items" className={buttonVariants({ variant: 'secondary' })}>
              <CircleDot className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.action')}
            </Link>
          }
        />
      ) : (
        <ReadyLanes
          leaves={leaves}
          bugs={bugs}
          counts={{ leaves: counts.leaves, bugs: counts.bugs }}
        />
      )}
    </SurfaceTitleTranslationProvider>
  );
}

/** The lanes' pending frame (design/ready ready--lanes panel 7): the REAL heading,
 *  then the switch and card-height blocks. Drawn here rather than through the
 *  shared `PageSkeleton`, which MOTIR-3531 ships with no page consumer yet. */
function ReadyFrame({ header, loadingLabel }: { header: ReactNode; loadingLabel: string }) {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only">{loadingLabel}</span>
      {header}
      <div className="flex animate-pulse flex-col gap-6" aria-hidden="true">
        <div className="h-(--height-control) w-56 rounded-(--radius-btn) bg-(--el-muted)" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-11 rounded-(--radius-card) bg-(--el-muted)" />
          ))}
        </div>
      </div>
    </div>
  );
}
