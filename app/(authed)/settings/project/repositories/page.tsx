import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Pause } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { hostedRunRepoAccessService } from '@/lib/services/hostedRunRepoAccessService';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';
import { summarizeRepositories } from '@/lib/projectRepos/roomSections';
import { GitConnectBanner } from '@/components/settings/GitConnectBanner';
import { RepositoriesRoom } from './_components/RepositoriesRoom';
import { guardSettingsPage } from '../_guard';
import { allSettledOrThrow } from '@/lib/async/allSettledOrThrow';
import { isOrgAdminForWorkspace } from '@/lib/services/organizationAccessService';
import { organizationsService } from '@/lib/services/organizationsService';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';

/** The member's own git account (MOTIR-4682) — where the room's connect prompt
 *  hands off. It was `/settings/workspace/github`, a page MOTIR-4680 redirects
 *  away; the credential is the member's and lives at the ACCOUNT tier. */
const GIT_ACCOUNT_PATH = '/settings/account/git';

/** The ORGANISATION's own inventory — `See every repository in <org>`. The
 *  footer link stopped being a hand-off ("choose which repositories Motir can
 *  see") and became a VIEW, which is the tier move in one line (§17.2). */
const ORGANIZATION_GIT_PATH = '/settings/organization/git';

// THE TAKE-IT-OVER ROOM (Story MOTIR-1775 · MOTIR-1939) — the surface behind the
// ownership promise's `How moving it works` door, the billing panel's
// `Move repositories` button, and the project-settings `Repositories` rail row.
// Layout source of truth: `design/repository-set/takeover.mock.html` §14.
//
// A SERVER component over a client island, split along the page-state contract:
// the header summary and the paused banner are server-rendered so
// `router.refresh()` updates them after a takeover, while the ROWS are a client
// island with its own refetch (which `router.refresh()` provably cannot reach).
// Getting that split wrong is the recurring bug the contract exists to stop.
//
// ⚠️ THE HEADER SPEAKS FOR THE PROJECT'S LINKS (MOTIR-3126, RE-SCOPED BY
// MOTIR-4954 · design §18.4). The room draws the repositories LINKED to this
// project, so the lead sentence and the summary count are computed over those and
// nothing else. A summary seeded from the layered registry reported
// `0 moving · 0 hosted by Motir · 6 yours` on a project holding NO links at all
// (§18.2, observed) — a number above a list must count the things in that list.
//
// ⚠️ AND THERE IS ONE LEAD NOW, NOT TWO. `leadConnected` existed because the old
// lead ("Motir hosts the repositories it created for you") described something a
// project with no hosted rows could not see, so the page chose between two
// sentences on `view.rows.length`. The replacement — "Only the repositories
// {projectName} works on — whether Motir hosts them or {org} does" — is true of
// every non-loading state, and a branch that always resolves the same way is a
// branch a reader has to check before trusting either arm.
//
// ⚠️ THE ORG→PROJECT SCOPE GAP IS DRAWN, NOT PAPERED OVER. The billing door is
// org-scoped while a takeover is per ROW, so the banner names the OTHER projects
// Motir still hosts, each a link, and says that moving this project's
// repositories does not move theirs (§14.4).

// ⚠️ A GIT CONNECT FLOW CAN NOW RETURN HERE (MOTIR-4676). This room is one of
// the surfaces that STARTS a connect (`GITHUB_RETURN_SURFACES.projectRepositories`),
// so it renders the `?github=<status>` outcome exactly as the workspace Git page
// does — through the shared `GitConnectBanner`, which owns the status → tone map
// so the two surfaces cannot disagree about what an outcome means.
interface ProjectRepositoriesPageProps {
  searchParams: Promise<{ github?: string }>;
}

export default async function ProjectRepositoriesPage({
  searchParams,
}: ProjectRepositoriesPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const t = await getTranslations('repositoryTakeover');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469). Hiding is presentation and never
  // protection: this page is still one typed URL away once its rail row is
  // gone. The key comes from the registry entry `repositories`, never re-declared here.
  const refused = await guardSettingsPage('repositories', ctx);
  if (refused) return refused;

  // MOTIR-3558 — allocation row 5: THE FRAME ONLY. One read, so there is nothing
  // to make concurrent.
  //
  // ⚠️ ONLY the <h1> is tier 1 here, and that is the asset's call rather than a
  // convenience: the lead line chooses between two strings on
  // `view.rows.length`, and the summary line renders at all only when the view
  // has something in it. Both are therefore ABOUT the pending read and cannot be
  // painted ahead of it — so the header is SPLIT, with the title above the
  // boundary and its two paragraphs below. Every other pane in this card paints
  // its whole header from the gate.
  const sp = await searchParams;

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
      </header>

      {/* ABOVE the Suspense boundary, deliberately: the banner is about the round
          trip the reader just took, it needs none of the room read, and a
          confirmation that waits for a database is a confirmation that arrives
          after the reader has started wondering. */}
      <GitConnectBanner status={sp.github} />

      <Suspense fallback={<SettingsPaneFrame />}>
        <RepositoriesPaneBody
          projectId={ctx.projectId}
          projectKey={ctx.project.identifier}
          projectName={ctx.project.name}
          userId={ctx.userId}
          workspaceId={ctx.workspaceId}
        />
      </Suspense>
    </div>
  );
}

/** The room read and everything that depends on it — the lead line, the summary
 *  line, the CI-paused banner and the rows. */
async function RepositoriesPaneBody({
  projectId,
  projectKey,
  projectName,
  userId,
  workspaceId,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
  userId: string;
  workspaceId: string;
}) {
  const t = await getTranslations('repositoryTakeover');
  // THREE reads, made concurrent: the room, the actor's ORG-admin answer, and the
  // organisation's name. The last two are MOTIR-4681's — the room draws its add
  // door or the sentence that says who can, and names the organisation in both
  // the section heading and the picker.
  //
  // ⚠️ THE ORGANISATION COMES FROM THE WORKSPACE, NOT FROM THE ACTOR (MOTIR-4801).
  // This read once asked the ACTOR-scoped resolve with no preference, which
  // falls through to the caller's FIRST org membership in row order — right for a
  // member of one organisation and a coin flip for a member of two, while the
  // question ("whose repositories does this project draw on?") is about the
  // PROJECT. `resolveWorkspaceOrganization` reads it off `workspace.organizationId`,
  // which is the same source `projectRepoRoomService` and every add path already
  // resolve against, so the heading, the hint, the picker segment and the
  // inventory link cannot name a tenant the rows do not belong to.
  //
  // ⚠️ `isOrgAdminForWorkspace` is a RENDERING question, not a gate. The gate is
  // `organizationRepoService`'s `assertOrgAdmin`, inside the transaction that
  // performs the add — this only decides which affordance is drawn, which is why
  // it returns a boolean rather than throwing.
  // `allSettledOrThrow`, never a bare `Promise.all` (MOTIR-3066): each arm opens
  // its own transaction, and `Promise.all` abandons the others' connections on the
  // first rejection rather than letting them settle.
  const [view, canAddRepositories, organization] = await allSettledOrThrow([
    projectRepoRoomService.getRoomView(projectId, { userId, workspaceId }, { projectKey }),
    isOrgAdminForWorkspace(userId, workspaceId),
    organizationsService.resolveWorkspaceOrganization(userId, workspaceId),
  ]);
  const organizationName = organization?.name ?? '';

  // WHETHER MOTIR'S APP CAN WRITE EACH ORGANISATION REPOSITORY (MOTIR-1895 ·
  // design §18.1) — after the room read, because it is asked of the room's own
  // rows. It is a PROP of the island, never seeded into its state: the island's
  // add and remove already call `router.refresh()`, and a prop is what a refresh
  // re-renders (a `useState` initializer would ignore it, which is the recurring
  // page-state bug). A failed or slow GitHub read draws no line rather than a
  // warning — see the service.
  const hostedRunAccess = await hostedRunRepoAccessService.forRoomRows(view.rows, {
    installHref: view.installHref,
  });

  // ONE timestamp for the whole render, threaded into the rows: `Date.now()` in
  // a client render would disagree with the server's by the round-trip and the
  // "days later" copy would hydrate differently — this repo's known relative-time
  // hydration-flake class, avoided at the root rather than patched at the leaf.
  const nowIso = new Date().toISOString();
  const counts = summarizeRepositories(view.rows);
  // ⚠️ THE SUMMARY RENDERS WHENEVER THE ROOM DOES (MOTIR-4954). `hasAny` used to
  // ask whether there was anything to show ACROSS BOTH registries, because a
  // summary of all zeroes above two absent sections is noise. There is one
  // registry now and `0 moving · 0 hosted by Motir · 0 yours` is Panel 9's own
  // drawn state: it is the honest answer for a project with no links, it sits
  // above sections that DO render (the add door, the inventory route), and
  // suppressing it would leave a reader unable to tell "none" from "not loaded".
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="font-sans text-sm text-(--el-text-muted)">
          {t('lead', { projectName, org: organizationName })}
        </p>
        <p className="font-sans text-sm text-(--el-text-helper)">{t('summary', counts)}</p>
      </div>

      {view.ciPaused ? (
        <div
          role="status"
          className="flex gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-warning-surface) p-(--spacing-card-padding)"
        >
          <Pause className="mt-0.5 size-5 shrink-0 text-(--el-warning)" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1 text-sm leading-relaxed text-(--el-warning-text)">
            <p className="min-w-0">
              <span className="font-semibold">{t('pausedTitle')}</span> {t('pausedBody')}
            </p>
            {view.otherHostedProjects.length > 0 ? (
              <p className="min-w-0">
                {t.rich('pausedOtherProjects', {
                  projects: () => (
                    <>
                      {view.otherHostedProjects.map((project, index) => (
                        <span key={project.id}>
                          {index > 0 ? ', ' : null}
                          <Link
                            href={`/projects/${project.identifier}`}
                            className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
                          >
                            {project.name}
                          </Link>
                        </span>
                      ))}
                    </>
                  ),
                })}
              </p>
            ) : null}
            <p className="min-w-0">
              <Link
                href="/settings/organization/billing"
                className="font-medium text-(--el-link) hover:text-(--el-link-pressed)"
              >
                {t('addCreditsInstead')}
              </Link>
            </p>
          </div>
        </div>
      ) : null}

      <RepositoriesRoom
        projectKey={projectKey}
        view={view}
        connectHref={GIT_ACCOUNT_PATH}
        canAddRepositories={canAddRepositories}
        organizationName={organizationName}
        projectName={projectName}
        organizationInventoryHref={ORGANIZATION_GIT_PATH}
        nowIso={nowIso}
        hostedRunAccess={hostedRunAccess}
      />
    </>
  );
}
