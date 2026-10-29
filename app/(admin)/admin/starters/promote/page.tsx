import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { seedRegistryConsoleService } from '@/lib/services/seedRegistryConsoleService';
import { PromoteForm } from './_components/PromoteForm';

/**
 * PROMOTE A REPOSITORY — design `starter-library` §3.1 (MOTIR-705), card
 * MOTIR-712. Reached from the library's **Promote a repository** button.
 * Operator and superadmin only, as the library is; the picker's read of every
 * repository Motir created is audited (`seed_registry.promote_sources_read`).
 */

export const metadata: Metadata = { title: 'Promote a repository' };

export const dynamic = 'force-dynamic';

export default async function PromoteStarterPage() {
  const principal = await requirePlatformStaffPage('operator');
  const t = await getTranslations('platformAdmin.starters.promoteForm');
  const sources = await seedRegistryConsoleService.listPromotionSources(principal);

  return (
    <div className="mx-auto flex max-w-[56rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex max-w-prose flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      <Card data-testid="promote-card">
        <PromoteForm sources={sources} />
      </Card>
    </div>
  );
}
