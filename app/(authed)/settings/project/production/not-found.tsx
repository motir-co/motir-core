import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FolderX } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { hasMotirRepository } from '@/lib/environmentConfig/motirRepositories';
import { PRODUCTION_ROOM_HREF } from '@/lib/hosting/productionRoom';
import { getActiveProject } from '@/lib/projects';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { ProductionHeader } from './_components/ProductionHeader';

// The Production room's NOT FOUND (Story MOTIR-9797 · MOTIR-10037, design
// MOTIR-10024 panel 16): `?repository=` named a customer repository, one in
// another project, one the viewer cannot see or nothing at all, or the project
// holds no repository Motir hosts. Rendered by the page's `notFound()`, so the
// response is a 404 — never a release, and never a 200 with an empty panel.
//
// `Back to Production` is offered only when the room has a repository to open:
// in a project holding none it would lead straight back here.

async function roomHasRepository(): Promise<boolean> {
  try {
    const ctx = await getActiveProject();
    if (!ctx) return false;
    const rows = await projectRepoSetService.listByProject(ctx.projectId, {
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
    });
    return hasMotirRepository(rows);
  } catch {
    return false;
  }
}

export default async function ProductionNotFound() {
  const [t, back] = await Promise.all([
    getTranslations('settings.production'),
    roomHasRepository(),
  ]);
  return (
    <div className="mx-auto flex max-w-[46rem] flex-col gap-6">
      <ProductionHeader title={t('title')} lede={t('lede')} />
      <Card data-testid="production-not-found">
        <EmptyState
          icon={<FolderX aria-hidden />}
          title={t('notFound.title')}
          description={t('notFound.body')}
          action={
            back ? (
              <Link
                href={PRODUCTION_ROOM_HREF}
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
