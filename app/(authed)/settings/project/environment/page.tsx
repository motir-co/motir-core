import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FolderX } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { motirRepositories } from '@/lib/environmentConfig/motirRepositories';
import { isEnvironmentName, type EnvironmentName } from '@/lib/environmentConfig/vocabulary';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import { guardSettingsPage, settingsEntryKeys } from '../_guard';
import { EnvironmentRoom, type EnvironmentRepositoryOption } from './_components/EnvironmentRoom';

// The Environment settings room (Story MOTIR-9795 · MOTIR-9966), drawn by MOTIR-9959
// (`design/environment/environment.mock.html` · `design/environment/design-notes.md`).
// Mounted through its registry entry `environment` (General, under Repositories).
//
// THREE questions, answered here on the server, in order:
//   1. may this actor STAND in it — the entry's VIEW key (`project:browse`), asked
//      by the destination guard;
//   2. which repositories it offers — the project's repositories Motir hosts, read
//      through `projectRepoSetService` (browse-gated) and filtered here, so a
//      customer repository never reaches the island. A `?repository=` naming one,
//      or naming nothing in the set, renders the not-found state (panel 18);
//   3. may they CHANGE anything — the entry's WRITE key, read off the registry
//      through `settingsEntryKeys`, never typed here, and handed to the island.
//
// ⚠️ THE RELEASE TAB IS NEVER SHOWN YET. It needs two facts — the project is live
// (MOTIR-7137) and the repository is in a release train (MOTIR-7136) — and neither
// has a source on main. `showReleaseTab` is therefore false, and the island's tab
// code takes it as a prop, so wiring it is a change to this one line.
const SHOW_RELEASE_TAB = false;

const ROOM_HREF = '/settings/project/environment';

interface EnvironmentPageProps {
  searchParams: Promise<{ repository?: string; environment?: string }>;
}

export default async function ProjectEnvironmentPage({ searchParams }: EnvironmentPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469) on the entry's VIEW key.
  const refused = await guardSettingsPage('environment', ctx);
  if (refused) return refused;

  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [t, held, rows, sp] = await Promise.all([
    getTranslations('settings.environment'),
    projectAccessService.getPermissions(ctx.projectId, actor),
    projectRepoSetService.listByProject(ctx.projectId, actor),
    searchParams,
  ]);
  const canEdit = held.has(settingsEntryKeys('environment').write);

  const repositories: EnvironmentRepositoryOption[] = motirRepositories(rows).map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    label: row.label,
  }));
  const selected = sp.repository
    ? repositories.find((repo) => repo.id === sp.repository)
    : repositories[0];

  const header = (
    <header className="flex flex-col gap-1">
      <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
      <p className="font-sans text-sm text-(--el-text-secondary)">{t('lede')}</p>
    </header>
  );

  if (!selected) {
    return (
      <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
        {header}
        <Card data-testid="environment-not-found">
          <EmptyState
            icon={<FolderX aria-hidden />}
            title={t('notFound.title')}
            description={t('notFound.body')}
            action={
              repositories.length > 0 ? (
                <Link
                  href={ROOM_HREF}
                  className="font-sans text-sm font-medium text-(--el-link) underline"
                >
                  {t('notFound.back')}
                </Link>
              ) : undefined
            }
          />
        </Card>
      </div>
    );
  }

  const requested = sp.environment && isEnvironmentName(sp.environment) ? sp.environment : null;
  const environment: EnvironmentName =
    requested && (requested !== 'release' || SHOW_RELEASE_TAB) ? requested : 'production';

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      {header}
      <EnvironmentRoom
        projectKey={ctx.project.identifier}
        repositories={repositories}
        initialRepositoryId={selected.id}
        initialEnvironment={environment}
        canEdit={canEdit}
        showReleaseTab={SHOW_RELEASE_TAB}
      />
    </div>
  );
}
