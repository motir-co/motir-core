import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { CAPACITY_SCREEN_REFRESH_MS } from '@/lib/capacity/screenRefresh';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { platformCapacityService } from '@/lib/services/platformCapacityService';
import { editCapacityLimitsAction, setCapacityAlertShareAction } from './actions';
import { CapacityScreen } from './_components/CapacityScreen';
import { CapacitySkeleton } from './_components/CapacitySkeleton';

/**
 * The console's PROVIDER CAPACITY page — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-25 (MOTIR-9607), card MOTIR-9614, story MOTIR-9539.
 *
 * Each provider model's usage against its published limits, per lane, with the
 * alert share and the alerts raised. Every staff role reads it; `canEdit` on the
 * view (operator and up) decides whether the edits are drawn, and the actions
 * check the role again. A non-staff request gets the app's 404 from this page's
 * gate as from the layout's (`pageGate.ts`).
 *
 * No `loading.tsx`: a boundary above a page that 404s fixes the status at 200.
 * The header paints at once; the read waits under the in-page `<Suspense>`.
 */

export const metadata: Metadata = { title: 'Provider capacity' };

/** Never cached — the numbers are this minute's. */
export const dynamic = 'force-dynamic';

export default async function AdminCapacityPage() {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.capacity');
  const tShell = await getTranslations('platformAdmin.shell');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs tracking-wide text-(--el-text-secondary)">
        <b className="font-semibold">{tShell('groupPlatform')}</b> · {t('title')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      <Suspense fallback={<CapacitySkeleton />}>
        <CapacitySection principal={principal} />
      </Suspense>
    </div>
  );
}

async function CapacitySection({ principal }: { principal: PlatformPrincipal }) {
  // The service answers every gateway outcome as a state of the view; anything
  // it throws is a real bug and reaches the error boundary.
  const view = await platformCapacityService.getView(principal);
  return (
    <CapacityScreen
      initialView={view}
      refreshMs={CAPACITY_SCREEN_REFRESH_MS}
      editLimits={editCapacityLimitsAction}
      setAlertShare={setCapacityAlertShareAction}
    />
  );
}
