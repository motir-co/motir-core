import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformServicesService } from '@/lib/services/platformServicesService';
import { ServicesSection, ServicesSkeleton } from './_components/ServicesSection';

/**
 * THE CONSOLE'S SERVICES PAGE (MOTIR-10890, design MOTIR-10889,
 * `platform-admin/design-notes.md` § _Services_): every ECS service Motir itself
 * runs in core's own AWS account, its tasks and their size, against the
 * account's Fargate On-Demand vCPU quota. Superadmin only — the gate 404s
 * anyone below it, so the route's existence is never confirmed.
 *
 * Server-rendered, ONE read per load, no client poll: a reload is the refresh.
 *
 * ⚠️ NO `loading.tsx`, DELIBERATELY, where the design names one. A route-level
 * loading boundary streams the response and fixes its status at 200 before the
 * gate runs, so a non-superadmin would get a 200 shell instead of the 404. The
 * gate runs first, here, and the slow AWS read streams in under an in-page
 * `<Suspense>` whose fallback is the design's loading state — the Fleet settings
 * page's shape.
 */

export const metadata: Metadata = { title: 'Services' };

/** Never cached — every load reads AWS. */
export const dynamic = 'force-dynamic';

export default async function AdminServicesPage() {
  await requirePlatformStaffPage('superadmin');
  const t = await getTranslations('platformAdmin.services');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
      {/* The subtitle names the account, which only the read knows, so it renders
          with the read. */}
      <Suspense fallback={<ServicesSkeleton />}>
        <ServicesRead />
      </Suspense>
    </div>
  );
}

async function ServicesRead() {
  const read = await platformServicesService.read();
  return <ServicesSection read={read} />;
}
