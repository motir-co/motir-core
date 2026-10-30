import { Suspense } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FolderGit2 } from 'lucide-react';
import { getSession } from '@/lib/auth';
import { getActiveProject } from '@/lib/projects';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { motirRepositories } from '@/lib/environmentConfig/motirRepositories';
import { NO_PROJECT_PATH } from '@/lib/navigation/landing';
import {
  ProductionRepositoryPicker,
  type ProductionRepositoryOption,
} from '@/components/hosting/ProductionRepositoryPicker';
import { ProductionSkeleton } from '@/components/hosting/ProductionSkeleton';
import { guardSettingsPage } from '../_guard';
import { ProductionHeader } from './_components/ProductionHeader';
import { ProductionPanelSection } from './_components/ProductionPanelSection';

// The Production settings room (Story MOTIR-9797 · MOTIR-10037), drawn by
// MOTIR-10024 (`design/hosting/production.mock.html` · `design/hosting/
// design-notes.md`). Mounted through its registry entry `production` (General,
// under Environment).
//
// THE STATUS IS SETTLED BEFORE ANYTHING STREAMS. Everything that decides whether
// this address exists is answered here, above the in-page `<Suspense>`:
//   1. may this actor stand in it — the entry's VIEW key (`project:browse`), asked
//      by the destination guard;
//   2. which repositories it offers — the project's repositories Motir hosts, read
//      through `projectRepoSetService` (browse-gated) and filtered here, so a
//      customer repository never reaches the picker. A `?repository=` naming one,
//      or naming nothing in the set, is `notFound()` — a 404 with the room's own
//      not-found state (`not-found.tsx`, panel 16).
// Only then does the panel's read stream in behind the skeleton (panel 14). No
// `loading.tsx` sits above this segment: it would commit a 200 before the gate.
//
// Who may roll back is not decided here: the read reports `isAdministrator` and
// `canRollback`, and the rollback service stays the authority.

interface ProductionPageProps {
  searchParams: Promise<{ repository?: string }>;
}

export default async function ProjectProductionPage({ searchParams }: ProductionPageProps) {
  const session = await getSession();
  if (!session) redirect('/sign-in');

  const ctx = await getActiveProject();
  if (!ctx) redirect(NO_PROJECT_PATH);

  // THE DESTINATION GUARD (MOTIR-2469) on the entry's VIEW key.
  const refused = await guardSettingsPage('production', ctx);
  if (refused) return refused;

  const actor = { userId: ctx.userId, workspaceId: ctx.workspaceId };
  const [t, rows, sp] = await Promise.all([
    getTranslations('settings.production'),
    projectRepoSetService.listByProject(ctx.projectId, actor),
    searchParams,
  ]);

  const repositories: ProductionRepositoryOption[] = motirRepositories(rows).map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    label: row.label,
  }));
  const selected = sp.repository
    ? repositories.find((repo) => repo.id === sp.repository)
    : repositories[0];
  if (!selected) notFound();

  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <ProductionHeader title={t('title')} lede={t('lede')} />
      <ProductionRepositoryPicker repositories={repositories} selectedId={selected.id} />
      <div className="flex items-end justify-between gap-3" data-testid="production-panel-header">
        <h2 className="flex items-center gap-2 font-serif text-xl font-semibold text-(--el-text)">
          <FolderGit2 className="size-5 text-(--el-text-secondary)" aria-hidden />
          {selected.name}
        </h2>
      </div>
      {/* Keyed by repository, so choosing another one shows the skeleton again
          rather than the previous repository's releases (nothing stale as live). */}
      <Suspense key={selected.id} fallback={<ProductionSkeleton />}>
        <ProductionPanelSection
          projectKey={ctx.project.identifier}
          repositoryId={selected.id}
          repositoryName={selected.name}
          actor={actor}
        />
      </Suspense>
    </div>
  );
}
