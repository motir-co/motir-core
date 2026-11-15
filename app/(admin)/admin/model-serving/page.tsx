import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { PlannerModelsSkeleton } from '@/components/ai/PlannerModelsSkeleton';
import { type PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformModelServingService } from '@/lib/services/platformModelServingService';
import { ModelServingTable } from './_components/ModelServingTable';
import { ModelServingUnavailable } from './_components/ModelServingUnavailable';

/**
 * The console's MODEL SERVING page (MOTIR-11280; design MOTIR-11279,
 * `platform-admin/design-notes.md` § Model serving).
 *
 * A model several providers sell is charged its original provider's official
 * price plus margin on every channel. This page shows that price, and lets a
 * `superadmin` choose which provider's gateway channel serves each model, which
 * moves only what Motir pays. Every staff role reads it; a non-staff request gets
 * the app's 404 from the gate.
 *
 * ⚠️ NOT SHOWN HALF-KNOWN. The choice lives in the gateway, so when the gateway
 * cannot answer the page renders the error card with Retry and no rows (Panel 7).
 */

export const metadata: Metadata = { title: 'Model serving' };

/** Never cached — a channel turned off a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminModelServingPage() {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.modelServing');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>{t('lineCharge')}</span>
        </p>
      </div>

      <Suspense fallback={<PlannerModelsSkeleton title={t('card.title')} />}>
        <ModelServingSection principal={principal} />
      </Suspense>
    </div>
  );
}

async function ModelServingSection({ principal }: { principal: PlatformPrincipal }) {
  const view = await platformModelServingService.getView(principal);
  if (view.state === 'unavailable') return <ModelServingUnavailable />;
  return <ModelServingTable entries={view.entries} canChange={view.canChange} />;
}
