import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { PlannerModelsSkeleton } from '@/components/ai/PlannerModelsSkeleton';
import { MotirAiError } from '@/lib/ai/errors';
import type { PlatformRunModelListDTO } from '@/lib/dto/platformRunModel';
import type { PlatformRunModelDefaultsDTO } from '@/lib/dto/platformRunModelDefaults';
import { HostedModelsUnavailableError } from '@/lib/hostedRuns/errors';
import { type PlatformPrincipal } from '@/lib/platform/auth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformRunModelDefaultsService } from '@/lib/services/platformRunModelDefaultsService';
import { platformRunModelService } from '@/lib/services/platformRunModelService';
import { RunModelDefaults } from './_components/RunModelDefaults';
import { RunModelDefaultsUnavailable } from './_components/RunModelDefaultsUnavailable';
import { RunModelList } from './_components/RunModelList';
import { RunModelListUnavailable } from './_components/RunModelListUnavailable';

/**
 * The console's HOSTED-RUN MODELS page — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10-04 (Model lists) Panels 5–13, card MOTIR-7528, story
 * MOTIR-7521; `docs/decisions/hosted-agent-run.md` §7 as amended by MOTIR-7522.
 *
 * Which models a hosted run may use, for every project. Every staff role reads
 * it; only a `superadmin` adds or removes. A non-staff request gets the app's
 * 404 from this page's gate as from the layout's (`pageGate.ts`, MOTIR-7613).
 *
 * ⚠️ NOT SHOWN HALF-KNOWN. The list is stored here, but whether each entry is
 * offered is motir-ai's answer, so when motir-ai cannot answer the page renders
 * the error card with Retry and no rows (Panel 11).
 */

export const metadata: Metadata = { title: 'Hosted-run models' };

/** Never cached — a model delisted a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminRunModelsPage() {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin.runModels');

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
          <span>{t('lineLive')}</span>
        </p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>
            <strong className="font-semibold text-(--el-text-strong)">
              {t('lineProjectsLead')}
            </strong>{' '}
            {t('lineProjectsBody')}
          </span>
        </p>
      </div>

      {/* After the gate, so the frame can never fix a status (CLAUDE.md's
          boundary rule); the header above paints at once (Panel 10). */}
      <Suspense fallback={<PlannerModelsSkeleton title={t('card.title')} />}>
        <RunModelsSection principal={principal} />
      </Suspense>

      {/* The run-side defaults (MOTIR-10844), under the list their pickers
          choose from; their own section, so either can fail alone. */}
      <Suspense fallback={<PlannerModelsSkeleton title={t('defaults.title')} />}>
        <RunModelDefaultsSection principal={principal} />
      </Suspense>
    </div>
  );
}

async function RunModelsSection({ principal }: { principal: PlatformPrincipal }) {
  let list: PlatformRunModelListDTO;
  try {
    list = await platformRunModelService.listModels(principal);
  } catch (err) {
    if (!(err instanceof HostedModelsUnavailableError)) throw err;
    console.error('[admin] hosted-run model list could not be read', err);
    return <RunModelListUnavailable />;
  }
  return <RunModelList list={list} />;
}

async function RunModelDefaultsSection({ principal }: { principal: PlatformPrincipal }) {
  let defaults: PlatformRunModelDefaultsDTO;
  try {
    defaults = await platformRunModelDefaultsService.getDefaults(principal);
  } catch (err) {
    // Any motir-ai failure is the unavailable card; anything else is a real bug.
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] run-side defaults could not be read', err);
    return <RunModelDefaultsUnavailable />;
  }
  return <RunModelDefaults defaults={defaults} />;
}
