import { cache, Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import type { FleetImageKey } from '@/lib/dto/fleetStatusImages';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import {
  fleetStatusImagesService,
  type FleetPublishRecords,
} from '@/lib/services/fleetStatusImagesService';
import { fleetStatusPoolsService } from '@/lib/services/fleetStatusPoolsService';
import { HostedImageCard, RunnerImageCard, SandboxImageCard } from './_components/ImageCards';
import { InstallFleetCard, ShardPoolsCard } from './_components/PoolCards';

/**
 * The console's FLEET STATUS page — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-11-10 (Fleet status, MOTIR-10885), card MOTIR-10886. This
 * card builds the frame and the Images section; MOTIR-10887 adds Pools, two
 * cards each read and settled on its own.
 *
 * ⚠️ `superadmin` ONLY, AND EVERYONE ELSE GETS THE 404 — Fleet settings' gate.
 * The service asserts it again on every read and on the action.
 *
 * ⚠️ EACH CARD IS READ AND SETTLED ON ITS OWN, behind its own `<Suspense>`, so a
 * registry, GitHub or AWS that does not answer leaves only its own card saying
 * so (Panel 9). The publish records are one audited read, shared by the three.
 *
 * ⚠️ NO `loading.tsx`. The gate decides existence, so the reads stream behind
 * the in-page `<Suspense>` placed AFTER it.
 */

export const metadata: Metadata = { title: 'Fleet status' };

/** Never cached — a publish a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

/** One audited read of the three images' publish records per request. */
const publishRecords = cache(
  (principal: PlatformPrincipal): Promise<FleetPublishRecords> =>
    fleetStatusImagesService.publishRecords(principal),
);

export default async function AdminFleetStatusPage() {
  const principal = await requirePlatformStaffPage('superadmin');
  const t = await getTranslations('platformAdmin.fleetStatus');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
      </div>
      <section aria-labelledby="images-heading" className="flex flex-col gap-4 pt-2">
        <div className="flex flex-col gap-1">
          <h2 id="images-heading" className="font-serif text-xl text-(--el-text)">
            {t('images.title')}
          </h2>
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('images.subtitle')}
          </p>
        </div>
        {(['hosted', 'runner', 'sandbox'] as const).map((image) => (
          <Suspense
            key={image}
            fallback={<CardSkeleton label={t('loading', { image: t(`imageName.${image}`) })} />}
          >
            <ImageRow image={image} principal={principal} />
          </Suspense>
        ))}
      </section>
      <section aria-labelledby="pools-heading" className="flex flex-col gap-4 pt-2">
        <div className="flex flex-col gap-1">
          <h2 id="pools-heading" className="font-serif text-xl text-(--el-text)">
            {t('pools.title')}
          </h2>
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('pools.subtitle')}
          </p>
        </div>
        <Suspense fallback={<CardSkeleton label={t('pools.loading.install')} />}>
          <InstallFleetPool principal={principal} />
        </Suspense>
        <Suspense fallback={<CardSkeleton label={t('pools.loading.shard')} />}>
          <ShardPools principal={principal} />
        </Suspense>
      </section>
    </div>
  );
}

function CardSkeleton({ label }: { label: string }) {
  return (
    <Card aria-busy="true">
      <span role="status" className="sr-only">
        {label}
      </span>
      <div className="flex animate-pulse flex-col gap-2" aria-hidden="true">
        <div className="h-6 w-56 rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-4 w-full rounded-(--radius-control) bg-(--el-muted)" />
        <div className="h-4 w-2/3 rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </Card>
  );
}

async function ImageRow({
  image,
  principal,
}: {
  image: FleetImageKey;
  principal: PlatformPrincipal;
}) {
  const records = await publishRecords(principal);
  const record = records[image];
  if (image === 'hosted') {
    return (
      <HostedImageCard
        row={await fleetStatusImagesService.readHosted(record)}
        actorEmail={principal.email}
      />
    );
  }
  if (image === 'runner') {
    return (
      <RunnerImageCard
        row={await fleetStatusImagesService.readRunner(record)}
        actorEmail={principal.email}
      />
    );
  }
  return (
    <SandboxImageCard
      row={await fleetStatusImagesService.readSandbox(record)}
      actorEmail={principal.email}
    />
  );
}

async function InstallFleetPool({ principal }: { principal: PlatformPrincipal }) {
  const now = new Date();
  return (
    <InstallFleetCard
      block={await fleetStatusPoolsService.readInstallFleet(principal, { now })}
      now={now}
    />
  );
}

async function ShardPools({ principal }: { principal: PlatformPrincipal }) {
  const now = new Date();
  return (
    <ShardPoolsCard
      block={await fleetStatusPoolsService.readAddShard(principal, { now })}
      now={now}
    />
  );
}
