'use client';

import type { ReactNode } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import {
  Activity,
  AlertTriangle,
  Clock,
  Moon,
  RotateCcw,
  ServerCrash,
  WifiOff,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import type { ProductionHealthDto } from '@/lib/dto/productionHealth';
import type { HostedHealthState } from '@/lib/hosting/healthState';
import type { HostingTarget } from '@/lib/hosting/vocabulary';
import { useLiveNow } from '@/lib/hooks/useRelativeTime';
import { formatStateDuration, isOutOfMemory } from '@/lib/hosting/productionRuntimeWords';
import { shortCommit } from '@/lib/hosting/releaseStateLabel';

// The HEALTH STATE (Story MOTIR-9799 · MOTIR-12109; `design/hosting/design-notes.md`
// § Health state — tone per state): one state per application with its tone and
// glyph, a one-line explanation, how long it has held (absolute on hover), and the
// "health probe unreachable" note beside — never instead of — the last state seen.

type PillTone =
  | { severity: 'success' | 'warning' | 'danger' }
  | { status: 'in-progress' }
  | { tone: 'neutral' };

const TONE: Record<HostedHealthState, PillTone> = {
  healthy: { severity: 'success' },
  unhealthy: { severity: 'warning' },
  crashed: { severity: 'danger' },
  deploying: { status: 'in-progress' },
  suspended: { tone: 'neutral' },
};

const GLYPH: Record<HostedHealthState, ReactNode> = {
  healthy: <Activity className="size-3" aria-hidden />,
  unhealthy: <AlertTriangle className="size-3" aria-hidden />,
  suspended: <Moon className="size-3" aria-hidden />,
  crashed: <ServerCrash className="size-3" aria-hidden />,
  deploying: <Spinner size="sm" className="h-3 w-3" aria-hidden />,
};

export type HealthView =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; health: ProductionHealthDto };

export function HealthStatePill({ state }: { state: HostedHealthState }) {
  const t = useTranslations('settings.production.health');
  return (
    <Pill {...TONE[state]} data-testid="production-health-pill" data-health-state={state}>
      {GLYPH[state]}
      {t(`state.${state}`)}
    </Pill>
  );
}

export function ProductionHealthState({
  view,
  target,
  address,
  deployingCommit,
  onRetry,
}: {
  view: HealthView;
  target: HostingTarget | null;
  address: string | null;
  /** The release rolling out, when the newest release is still building. */
  deployingCommit: string | null;
  onRetry: () => void;
}) {
  const t = useTranslations('settings.production.health');
  const tTarget = useTranslations('repositorySet.seed.target');
  const format = useFormatter();
  const locale = useLocale();
  const now = useLiveNow();
  const health = view.kind === 'ready' ? view.health : null;
  const state = health?.state ?? null;
  const targetLabel = target ? tTarget(target) : '';

  const line = (s: HostedHealthState): string => {
    const path = health?.healthCheckPath ?? '/';
    switch (s) {
      case 'healthy':
        return t('line.healthy', { path });
      case 'unhealthy':
        return t('line.unhealthy', { path });
      case 'suspended':
        return t('line.suspended');
      case 'crashed':
        return health?.events[0]?.kind === 'crashed' && isOutOfMemory(health.events[0].reason)
          ? t('line.crashedOom', { target: targetLabel })
          : t('line.crashed', { target: targetLabel });
      case 'deploying':
        return deployingCommit
          ? t('line.deploying', { commit: shortCommit(deployingCommit) })
          : t('line.deployingUnnamed');
    }
  };

  return (
    <Card data-testid="production-health">
      <section className="flex flex-col gap-2" aria-labelledby="production-health-heading">
        <div className="flex items-center justify-between gap-3">
          <h2
            id="production-health-heading"
            className="font-serif text-lg font-semibold text-(--el-text)"
          >
            {t('heading')}
          </h2>
          {state ? <HealthStatePill state={state} /> : null}
        </div>

        {view.kind === 'loading' ? (
          <span
            aria-busy="true"
            className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
          >
            <Spinner size="sm" aria-hidden />
            {t('loading')}
          </span>
        ) : null}

        {view.kind === 'failed' ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="font-sans text-sm text-(--el-text)">{t('failed')}</p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RotateCcw className="size-3.5" aria-hidden />}
              onClick={onRetry}
            >
              {t('retry')}
            </Button>
          </div>
        ) : null}

        {view.kind === 'ready' && !state ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('pending')}</p>
        ) : null}

        {state && health?.since ? (
          <>
            <p className="font-sans text-sm text-(--el-text)" data-testid="production-health-line">
              {line(state)}
            </p>
            <p className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
              <Clock className="size-3.5 shrink-0" aria-hidden />
              <time
                dateTime={health.since}
                title={format.dateTime(new Date(health.since), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                data-testid="production-health-since"
              >
                {t('since', {
                  state: t(`state.${state}`),
                  duration: formatStateDuration(new Date(health.since), now, locale),
                })}
              </time>
            </p>
          </>
        ) : null}

        {health?.condition === 'probe_unreachable' ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text)"
            data-testid="production-health-unreachable"
          >
            <WifiOff className="mt-0.5 size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <span>{address ? t('unreachable', { address }) : t('unreachableNoAddress')}</span>
          </p>
        ) : null}
      </section>
    </Card>
  );
}
