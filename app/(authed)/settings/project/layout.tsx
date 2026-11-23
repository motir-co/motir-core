import { type ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject, type ProjectContext } from '@/lib/projects';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectsService } from '@/lib/services/projectsService';
import { readProjectSettingsLink } from '@/lib/settings/projectSettingsLink';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { CURRENT_PATH_HEADER } from '@/proxy';
import { ProjectLinkSwitch } from './_components/ProjectLinkSwitch';

// The project-settings AREA layout (Story 6.5 · Subtask 6.5.2). The grouped
// settings NAV itself lives in the app rail — SidebarNav swaps to it when the
// route is inside this area (the design's "same rail" decision; the App Router
// keeps the rail in the parent (authed) layout, not a nested one under <main>).
//
// This layout owns the CONTENT-side guards every settings page shares, so the
// area enforces them at ONE chokepoint rather than re-deriving per page:
//   * no active project → the area's "No project selected" empty state. The
//     route still resolves (never 404s) — the retiring hub's empty state, kept.
//   * the active project isn't browsable (e.g. it was made private while pinned)
//     → the 6.4.4 NoAccessState. The rail's registry filter has already removed
//     every settings entry (no nav leak); this is the matching page state.
//   * the link names a project (`?project=<KEY>`, Bug MOTIR-12169) — a
//     notification about a project opens its settings room whatever the reader's
//     active project is. A project they can enter that is not the active one is
//     switched to first (ProjectLinkSwitch); one they cannot enter, or a key no
//     project carries, answers the same no-access state as a non-browser.
// When all pass, the page renders normally inside the rail's area chrome.

async function noAccess(): Promise<ReactNode> {
  const ta = await getTranslations('projectAccess');
  return (
    <div className="mx-auto max-w-[42rem]">
      <NoAccessState
        title={ta('noAccessTitle')}
        description={ta('noAccessDescription')}
        backHref="/dashboard"
        backLabel={ta('backToProjects')}
      />
    </div>
  );
}

/**
 * The project a settings link names, as an id — or `null` when the reader cannot
 * enter it or no project carries the key. The resolver is the browse-gated,
 * alias-aware one the project routes use, and it answers a project the reader
 * may not browse exactly as a missing one, so the two refusals cannot be told
 * apart from here either.
 */
async function linkedProjectId(projectKey: string, ctx: ProjectContext): Promise<string | null> {
  try {
    const { project } = await projectsService.resolveByKey(projectKey, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return project.id;
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return null;
    throw err;
  }
}

export default async function ProjectSettingsAreaLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  // A link that names its project (MOTIR-12169). The path is the proxy's
  // advisory header: it only says which project the reader asked for, and the
  // resolver and the switch each re-check that they may enter it.
  const link = readProjectSettingsLink((await headers()).get(CURRENT_PATH_HEADER));
  if (link) {
    const projectId = await linkedProjectId(link.projectKey, ctx);
    if (projectId === null) return noAccess();
    if (projectId !== ctx.projectId) {
      return (
        <ProjectLinkSwitch projectId={projectId} href={link.href} refused={await noAccess()} />
      );
    }
  }

  const { canBrowse } = await projectAccessService.getCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!canBrowse) return noAccess();

  return children;
}
