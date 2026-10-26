'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CirclePause, RefreshCw } from 'lucide-react';
import type { DesignAutoRerunDTO, DesignAutoRerunSkipReasonDTO } from '@/lib/dto/approvalGate';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// THE AUTOMATIC RE-RUN LINE (Story MOTIR-693 · MOTIR-702), built to
// `design/work-items/design-result--auto-rerun.mock.html`: the LAST line of a refused
// design gate's record band, on its own full-width row, read from that refusal's
// `design_auto_rerun` record (MOTIR-700).
//
// ⚠️ NO RECORD, NO LINE (panel 3): a card last run BYOK or by hand, a Re-plan and a
// GitHub refusal attempted nothing, so nothing is said.
//
// ⚠️ INK: the lead in `--el-text`, the detail in `--el-text-secondary`, at most ONE link
// in `--el-link`; the glyph is `aria-hidden` and the lead carries the meaning.

/** Each skip reason's ONE next step — its label key and where it goes. `null` for a
 *  reason nobody can act on. Total over the reason set, so a new reason fails to compile. */
const NEXT_STEP: Record<DesignAutoRerunSkipReasonDTO, { href: string } | null> = {
  cap_reached: { href: '#run-hosted' },
  dispatcher_gone: { href: '#run-hosted' },
  no_project_access: { href: '#run-hosted' },
  ci_credits_exhausted: { href: '/settings/organization/billing' },
  model_not_offered: { href: '#run-hosted' },
  models_unavailable: { href: '#run-hosted' },
  out_of_credits: { href: '/settings/organization/billing' },
  credits_unavailable: { href: '#run-hosted' },
  repository_not_writable: { href: '/settings/project/repositories' },
  card_not_ready: null,
  // No agent-run capacity right now (MOTIR-9633): the person starts it themselves.
  no_capacity: { href: '#run-hosted' },
};

export function AutoRerunLine({ rerun }: { rerun: DesignAutoRerunDTO | null | undefined }) {
  const t = useTranslations('approvalGate.autoRerun');
  // A shared body builds its addresses FOR THE READER (MOTIR-6888): a visitor's tree
  // routes the run elsewhere, so the member route is never emitted raw.
  const routes = useReaderRoutes();
  if (!rerun) return null;

  if (rerun.outcome === 'started') {
    return (
      <span
        className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-0.5"
        data-testid="auto-rerun-line"
      >
        <RefreshCw className="size-3 shrink-0 text-(--el-text-secondary)" aria-hidden="true" />
        <span className="font-medium text-(--el-text)">{t('started')}</span>
        <span>· {t('startedCount', { ordinal: rerun.ordinal, cap: rerun.cap })}</span>
        {rerun.dispatchRunId ? (
          <Link
            className="text-(--el-link) underline underline-offset-2"
            href={routes.view(runsHref({ run: rerun.dispatchRunId }))}
          >
            {t('viewRun')}
          </Link>
        ) : null}
      </span>
    );
  }

  const reason = rerun.skipReason ?? 'card_not_ready';
  const next = NEXT_STEP[reason];
  return (
    <span
      className="flex basis-full flex-wrap items-center gap-x-1.5 gap-y-0.5"
      data-testid="auto-rerun-line"
    >
      <CirclePause className="size-3 shrink-0 text-(--el-text-secondary)" aria-hidden="true" />
      <span className="font-medium text-(--el-text)">{t('skipped')}</span>
      <span>· {t(`reason.${reason}`, { cap: rerun.cap, detail: rerun.detail ?? '—' })}</span>
      {next ? (
        <Link className="text-(--el-link) underline underline-offset-2" href={next.href}>
          {t(`next.${reason as Exclude<DesignAutoRerunSkipReasonDTO, 'card_not_ready'>}`)}
        </Link>
      ) : null}
    </span>
  );
}
