import { startSurfaceTranslation } from '@/lib/pages/surfaceTranslation';
import { SurfaceTitleHost } from '@/components/workItems/titleTranslation/SurfaceTitleHost';
import {
  SurfaceShowOriginalSwitch,
  SurfaceTitlesNotice,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Circle, CircleCheck, CircleDot, CirclePause, Inbox, Star, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { HOME_FINISHED_WINDOW_DAYS, HOME_PAGE_SIZE, homeService } from '@/lib/services/homeService';
import { workbenchWindowService } from '@/lib/services/workbenchWindowService';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonVariants } from '@/components/ui/Button';
import type { WorkbenchTab } from '@/lib/workbench/tab';
import { parseWorkbenchTab, workbenchTabHref } from '@/lib/workbench/tab';
import { resolveWorkbenchLanding, workbenchLandingHref } from '@/lib/workbench/landing';
import { parsePage } from '@/lib/issues/issueListView';
import { IssueQuickViewController } from '../items/_components/IssueQuickViewController';
import { WorkbenchLiveView } from './_components/WorkbenchLiveView';
import { ApprovalsTab } from './_components/ApprovalsTab';
import { PlanningTab } from './_components/PlanningTab';
import { toWorkbenchRowViews } from './_components/workbenchRows';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { withRequestLabel } from '@/lib/monitoring/requestLabel';
import { ReviewFindingsInPlace } from '@/components/approvals/ReviewFindingsInPlace';

// `/workbench` — the signed-in landing surface (Story MOTIR-2649 · MOTIR-2653,
// renamed and split by lifecycle in Story MOTIR-4777 · MOTIR-4782), per
// `design/workbench/`. A Server Component that resolves the session + the ACTIVE
// PROJECT and reads `homeService` directly (the server-component 4-layer path).
//
// ⚠️ THE ROUTE MOVED, and `/home` still answers — a 308 in `next.config.ts`'s
// `LANDING_REDIRECTS`, preserving the query string so a link to somebody's
// Watching tab survives. `AUTHED_LANDING_PATH` (`lib/navigation/landing.ts`) is
// the ONE owner of the new address; MOTIR-3373 built that constant and its guard
// precisely so this rename would be one edit rather than the nine-literal sweep
// MOTIR-3171 / MOTIR-3173 each found a survivor of.
//
// ⚠️ IT RESOLVES THE ACTIVE PROJECT, exactly like `/items`, `/ready` and
// `/boards` (MOTIR-2761). It did not until 2026-08-17, and the shell said
// otherwise the whole time: the rail's primary section is built inside
// `if (hasProject)` with this row as its FIRST entry, under a project switcher
// the top bar renders on every authed page. A switcher that changes nothing on
// the first screen after sign-in is a control that lies. The cross-project
// question is retained at the workspace tier as MOTIR-2920, not dropped
// (`docs/decisions/home-scope.md`).
//
// ⚠️ AND IT MOUNTS NO NOTIFICATIONS. An earlier shape of this story put a
// "Needs you" widget here — a second mount of the notification stream. It was
// removed (Yue, 2026-08-11) as a duplicate of the bell drawer, which is already
// on every page and carries the unread badge. Two copies of one dataset is two
// things to keep in agreement and a second answer to "where do I read these".
// This page touches nothing about notifications; do not add it back without
// reopening that decision.

// The post-auth settle target — for BOTH credential flows. `_helpers/
// shell-session.ts` waits on a RENDERED Workbench rather than on a URL that
// merely reads right (MOTIR-2645's contract: an authoritative signal, never an
// interval), so BOTH branches below carry it: a reader with no project lands on
// the create-first branch, everyone else on the list.
const WORKBENCH_TESTID = 'workbench-page';

/** The tab's own label, reused as the list's accessible name. */
const TAB_LABEL_KEY: Readonly<Record<WorkbenchTab, string>> = {
  todo: 'tabs.toDo',
  'in-progress': 'tabs.inProgress',
  'to-fix': 'tabs.toFix',
  'to-resume': 'tabs.toResume',
  finished: 'tabs.recentlyFinished',
  watching: 'tabs.watching',
  approvals: 'tabs.toApprove',
  planning: 'tabs.planning',
};

/**
 * An empty tab's drawn state — glyph, copy, and an action only where one helps.
 *
 * ⚠️ **ONLY TWO OF THE SEVEN DRAWN HERE CARRY AN ACTION, and that is a decision
 * rather than an omission** (`design/workbench/design-notes.md` § Empty states;
 * Planning's own, § 36.9, is drawn by `<PlanningTab>` and DOES carry one, for that
 * same rule's reason — starting a plan is what puts a row on that tab). To do sends
 * you to Ready; In progress sends you to the To do TAB rather than mounting a
 * second Ready button one screen from the first. Nothing finishes work on your
 * behalf, nothing makes you watch an item, and nothing conjures an approval, so
 * those three offer no button rather than inventing one. Written as explicit arms
 * rather than a table for exactly that reason: whether a state has a button is
 * visible where the state is, not a column somebody fills in.
 */
async function EmptyTab({ tab }: { tab: WorkbenchTab }): Promise<ReactNode> {
  const t = await getTranslations('workbench');
  // `--el-icon-muted` and the primitive's own type scale come from `EmptyState`;
  // the glyph is `aria-hidden` because the title carries the meaning.
  switch (tab) {
    case 'todo':
      return (
        <EmptyState
          icon={<Circle className="h-12 w-12" aria-hidden />}
          title={t('empty.toDo.title')}
          description={t('empty.toDo.body')}
          action={
            <Link href="/ready" className={buttonVariants({ variant: 'secondary' })}>
              <CircleDot className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.toDo.action')}
            </Link>
          }
        />
      );
    case 'in-progress':
      return (
        <EmptyState
          icon={<CircleDot className="h-12 w-12" aria-hidden />}
          title={t('empty.inProgress.title')}
          description={t('empty.inProgress.body')}
          action={
            <Link
              href={workbenchTabHref('todo')}
              className={buttonVariants({ variant: 'secondary' })}
            >
              <Circle className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
              {t('empty.inProgress.action')}
            </Link>
          }
        />
      );
    case 'to-fix':
      // § 30 Panel 4 — no action: nothing on this page repairs a card for you.
      return (
        <EmptyState
          icon={<Wrench className="h-12 w-12" aria-hidden />}
          title={t('empty.toFix.title')}
          description={t('empty.toFix.body')}
        />
      );
    case 'to-resume':
      // § 35 — no action: an approval, not this page, moves a waiting run.
      return (
        <EmptyState
          icon={<CirclePause className="h-12 w-12" aria-hidden />}
          title={t('empty.toResume.title')}
          description={t('empty.toResume.body')}
        />
      );
    case 'finished':
      return (
        <EmptyState
          icon={<CircleCheck className="h-12 w-12" aria-hidden />}
          title={t('empty.recentlyFinished.title')}
          description={t('empty.recentlyFinished.body')}
        />
      );
    case 'watching':
      return (
        <EmptyState
          icon={<Star className="h-12 w-12" aria-hidden />}
          title={t('empty.watching.title')}
          description={t('empty.watching.body')}
        />
      );
    case 'approvals':
      return (
        <EmptyState
          icon={<Inbox className="h-12 w-12" aria-hidden />}
          title={t('empty.approvals.title')}
          description={t('empty.approvals.body')}
        />
      );
    case 'planning':
      // ⚠️ DRAWN BY `<PlanningTab>` INSTEAD (§ 36.9), because its action is gated
      // on who the reader is: *Plan with AI* renders only for somebody who can
      // actually start a plan in the active project. This arm is unreachable — the
      // render branches on the tab before mounting the list that would ask for it —
      // and it is kept so this switch stays TOTAL over the union, which is what
      // makes an eighth tab a compile error here rather than a blank screen.
      return null;
  }
}

/**
 * A LIST TAB's pending FRAME — window 2's drawing, at the list's own shape so
 * nothing shifts when the rows arrive. Shared by the two tabs that read inside
 * their own component (Approvals and Planning): both become a bordered card with a
 * 40px column-header band over rows, so one frame is the shape both are about to
 * take, and drawing two would be two things to keep in agreement.
 *
 * It reuses the list's container and its 40px header band rather than a bespoke
 * skeleton: `design/shell/design-notes.md` is explicit that the shell must not
 * guess a destination's shape, and the corollary for a page drawing its own
 * frame is that the frame should be the shape it is about to become.
 */
function ListPending() {
  return (
    <div
      data-surface="card"
      aria-busy="true"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div className="h-10 border-b border-(--el-border) bg-(--el-surface-soft)" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-11 border-b border-(--el-border) last:border-b-0" />
      ))}
    </div>
  );
}

type WorkbenchPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Every transaction the page's own reads open is recorded as `workbench`
 * (MOTIR-8553). The tabs that read inside their own `<Suspense>` render after
 * this function returns, outside its async context, so `<ApprovalsTab>` and
 * `<PlanningTab>` set the same label themselves.
 */
export default async function WorkbenchPage(props: WorkbenchPageProps) {
  return withRequestLabel({ route: 'workbench' }, () => renderWorkbenchPage(props));
}

async function renderWorkbenchPage({ searchParams }: WorkbenchPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // The reader's title-translation context (Story MOTIR-7738 · MOTIR-8834),
  // started beside the page's own reads and awaited by the host that mounts it.
  const titleContext = startSurfaceTranslation(ctx.project, ctx);

  const params = await searchParams;
  const tab = parseWorkbenchTab(params['tab']);

  // ⚠️ THE BARE PATH IS A RESOLVER, NOT A VIEW (MOTIR-5221, `design/workbench/
  // design-notes.md` § 21). A request that names no known tab — absent,
  // misspelled, hand-edited — reads the counts and FORWARDS to the first of To
  // approve · In progress · To do with anything in it, To do being terminal. An
  // explicit, known `?tab=` never reaches this branch, so it always wins.
  //
  // ⚠️ IT REDIRECTS RATHER THAN RENDERING IN PLACE — decided, not incidental.
  // Rendering in place would keep `/workbench` in the address bar while the
  // content varied per reader and per day: one spelling naming many views, the
  // ambiguity `lib/workbench/tab.ts` just retired. And it would force the counts
  // to be read BEFORE the list on EVERY request, because the page cannot pick a
  // tab until it knows them — serialising the `Promise.all` below for a decision
  // only the paramless request needs. Redirecting keeps both: the address tells
  // the truth, a link shared after landing names a tab, and every concrete-tab
  // request keeps its parallel read exactly as it shipped. Only this branch pays a
  // hop, and it reads the counts and nothing else — no list, no members, no
  // workflow.
  //
  // ⚠️ AND THE HOP IS AN HTTP REDIRECT, NOT A SECOND NAVIGATION. `redirect()`
  // here runs before this page renders anything, and nothing above `children` in
  // `app/(authed)/layout.tsx` is a Suspense boundary, so no byte has been flushed
  // and Next answers 307: the browser follows it inside the SAME navigation.
  // `tests/e2e/auth-post-auth-landing.spec.ts` pins exactly one navigation to the
  // landing (MOTIR-2645's race), and counts the followed hop as part of it.
  if (tab === null) {
    const landingCounts = await homeService.tabCounts(ctx);
    redirect(workbenchLandingHref(resolveWorkbenchLanding(landingCounts), params));
  }
  // The page rides the URL beside `?tab=`, read with the SHIPPED `parsePage`,
  // which already answers 1 for absent, non-numeric, zero and negative — the
  // four degenerate spellings a hand-edited URL or a stale bookmark produces.
  // The UPPER bound is deliberately NOT clamped here: the parser is scope-blind,
  // so `homeService` clamps it once it knows the tab's real total, which is the
  // same division of labour `/items` uses.
  //
  // `?cursor=` is neither read nor emitted any more — MOTIR-4852 retired the
  // keyset and this card took the last reader of the token off the route.
  // ⚠️ IGNORED on `?tab=approvals`: that tab lists its whole set with no pager
  // (MOTIR-5998), so a stale `&page=2` renders the same rows as page one.
  const page = parsePage(params['page']);

  const t = await getTranslations('workbench');

  const isApprovals = tab === 'approvals';
  // The second tab that reads inside its own `<Suspense>` (MOTIR-7831). Its rows
  // are plans, so the page's work-item window stays empty for it, exactly as it
  // does for Approvals.
  const isPlanning = tab === 'planning';

  // ⚠️ ONE PAIRING (Story MOTIR-8539 · MOTIR-8573): a work-item tab's window and
  // the strip's counts come from `workbenchWindowService.read`, the same call
  // `GET /api/workbench/window` answers from, so the first paint and a client
  // re-read cannot be paired differently. To approve and Planning read their
  // first paint inside their own `<Suspense>` below (MOTIR-4794), so here they
  // need the counts alone; after it, their rows ride the same client re-read as
  // the strip (MOTIR-8581).
  const { counts, window } = await workbenchWindowService.readFirstPaint(ctx, { tab, page });

  const rows = window
    ? toWorkbenchRowViews(window.page.items, window.workflow, window.members, tab === 'watching')
    : [];

  return (
    <SurfaceTitleHost projectKey={ctx.project.identifier} contextRead={titleContext}>
      <div data-testid={WORKBENCH_TESTID} className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
            <p className="text-sm text-(--el-text-muted)">
              {t('subtitle', { project: ctx.project.name })}
            </p>
          </div>
          <SurfaceShowOriginalSwitch />
        </header>

        <SurfaceTitlesNotice />

        {/* ⚠️ THE STRIP AND THE LIST ARE LIVE FROM CLIENT STATE (Story MOTIR-8539 ·
          MOTIR-8574). `<WorkbenchLiveView>` is seeded with this render's window
          and counts and, on a nudge, re-reads both from `GET
          /api/workbench/window` — the same `workbenchWindowService.read` above —
          and sets them in one update, so they never disagree (§ 21, § 26) and
          nothing refreshes the route. The host that holds the stream is in the
          shell (`app/(authed)/layout.tsx`, MOTIR-5242 / MOTIR-5245).

          ⚠️ AN EMPTY TAB RENDERS ITS EMPTY STATE AND NOTHING ELSE — no list box
          and NO PAGER (`design/workbench/` Panel 10). The list draws it as one
          of its states, because a component that did not exist until the first
          row landed could not know the row had ARRIVED (MOTIR-5245, § 26
          Panel 1). */}
        <WorkbenchLiveView
          tab={tab}
          page={page}
          rows={rows}
          pagination={{
            total: window?.page.total ?? 0,
            page: window?.page.page ?? 1,
            pageSize: window?.page.pageSize ?? HOME_PAGE_SIZE,
          }}
          planningSessions={tab === 'to-resume' ? (window?.page.planningSessions ?? []) : []}
          counts={counts}
          label={t(TAB_LABEL_KEY[tab])}
          caption={
            /* The window caption — a bounded list that does not say what bounds it
             reads as a list that is missing things. It sits above the EMPTY state
             too: "nothing finished this week" is the same claim about the same
             window. */
            tab === 'finished' ? (
              <p className="text-xs text-(--el-text-secondary)">
                {t('finishedWindow', { days: HOME_FINISHED_WINDOW_DAYS })}
              </p>
            ) : null
          }
          empty={<EmptyTab tab={tab} />}
          viewerId={ctx.userId}
        >
          {isApprovals ? (
            /* ⚠️ WINDOW 2, and it is INSIDE the page rather than a `loading.tsx`.
             `design/shell/design-notes.md`'s navigation-pending grammar is
             explicit that a route boundary can flush the response head before
             the page's gate has run — which is why this repo has none, and why
             the boundary sits here, below the session and active-project reads
             that decide who may see this page. The fallback is the list's own
             shape so the frame does not shift when the rows arrive. */
            <Suspense fallback={<ListPending />}>
              <ApprovalsTab ctx={ctx} />
            </Suspense>
          ) : isPlanning ? (
            /* PLANNING (§ 36) — the same instrument for the same reason: the read is
             inside the tab, so the boundary sits between the page's gate and it.
             No `page` is passed, because the tab has no pager: it reads page 1 at
             its 50-row ceiling (§ 36.10) and the note under the last row says when
             the set is larger. */
            <Suspense fallback={<ListPending />}>
              <PlanningTab ctx={ctx} projectName={ctx.project.name} />
            </Suspense>
          ) : null}
        </WorkbenchLiveView>

        {/* *Findings and checklist* opens IN PLACE here (MOTIR-10460; § 42.3): the review
          line, the Reviewed badge's card and the approval overlay's review line open the
          review over the list instead of navigating to the card page. */}
        <ReviewFindingsInPlace />

        {/* The quick-view peek — the SAME `?peek=` island /items, /ready and the
          board mount. Opening a row here is not a different interaction, so it
          is not a different surface. */}
        <IssueQuickViewController />
      </div>
    </SurfaceTitleHost>
  );
}
