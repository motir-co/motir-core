import { type ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { NoAccessState } from '@/components/projects/NoAccessState';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { ProjectLinkGate } from './_components/ProjectLinkGate';

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
//     active project is. ProjectLinkGate, wrapped around every answer below,
//     switches to a project they can enter that is not the active one, and
//     answers one they cannot enter, or a key no project carries, with the same
//     no-access state as a non-browser.
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

export default async function ProjectSettingsAreaLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  // No active project: the reader can enter none of the workspace's projects
  // (MOTIR-6548) — the no-project landing, never `/sign-in`, which would
  // bounce a signed-in reader straight back.
  if (!ctx) redirect(NO_PROJECT_PATH);

  const { canBrowse } = await projectAccessService.getCapabilities(ctx.projectId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  const refused = await noAccess();
  // Every answer is wrapped in the link gate (MOTIR-12169): a client navigation
  // re-renders only the room below this layout, so the gate — not this
  // function — is what sees a `?project=` the reader opens from inside the area.
  if (!canBrowse) return <ProjectLinkGate refused={refused}>{refused}</ProjectLinkGate>;

  return <ProjectLinkGate refused={refused}>{children}</ProjectLinkGate>;
}
