'use client';

import type { ComponentType } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Folder, Layers, Server, Sparkles } from 'lucide-react';
import { Meter } from '../../billing/_components/BillingClient';
import type { FleetUseFigureDTO } from '@/lib/dto/fleetUse';
import type { OrgFleetDTO } from '@/lib/dto/orgFleet';
import { SectionError } from './FleetSection';

// The four tiles (design panel 2): the platform Fleet card's tile grid carrying
// the org's OWN Fleet use figures, with Billing & plans' `Meter` under each
// figure that has one. The page derives no figure. A count that was not read
// says so in words — never a 0.

const TILE =
  'flex flex-col gap-1 rounded-(--radius-card) border border-(--el-border) p-(--spacing-card-padding)';

export function FleetTiles({
  tiles,
  indexJobs,
  onRetry,
}: {
  tiles: OrgFleetDTO['tiles'];
  indexJobs: OrgFleetDTO['indexJobs'];
  onRetry: () => void;
}) {
  const t = useTranslations('settings.organization.fleet.tiles');
  if (tiles.kind !== 'read') {
    return (
      <div data-testid="fleet-tiles">
        <SectionError title={t('failedTitle')} body={t('failedBody')} onRetry={onRetry} />
      </div>
    );
  }
  const ci = tiles.figures.ciJobsInFlight;
  const waiting = ci.waiting ? ci.waiting.planLimit + ci.waiting.poolFull + ci.waiting.other : null;
  return (
    <div data-testid="fleet-tiles" className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <FigureTile
        testId="fleet-tile-agent-runs"
        icon={Sparkles}
        label={t('agentRuns')}
        figure={tiles.figures.agentRunsInParallel}
        note={t('agentRunsNote')}
      />
      <FigureTile
        testId="fleet-tile-agents"
        icon={Server}
        label={t('agents')}
        figure={tiles.figures.agentsInOrg}
        note={t('agentsNote')}
      />
      <FigureTile
        testId="fleet-tile-ci"
        icon={Layers}
        label={t('ciJobs')}
        figure={ci}
        note={waiting === null ? null : t('ciWaiting', { count: waiting })}
      />
      <div data-testid="fleet-tile-index" className={`${TILE} bg-(--el-surface-soft)`}>
        <TileLabel icon={Folder} label={t('index')} />
        <TileValue value={indexJobs.kind === 'read' ? indexJobs.running : null} />
        <span className="font-sans text-xs text-(--el-text-secondary)">{t('indexNote')}</span>
      </div>
    </div>
  );
}

function TileLabel({
  icon: Icon,
  label,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1 font-sans text-xs font-medium text-(--el-text-secondary)">
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function TileValue({ value, figure }: { value: number | null; figure?: number | null }) {
  const t = useTranslations('settings.organization.fleet.tiles');
  const format = useFormatter();
  if (value === null) {
    return <span className="font-sans text-sm text-(--el-text-secondary)">{t('notRead')}</span>;
  }
  return (
    <span className="font-sans text-xl font-semibold tabular-nums text-(--el-text)">
      <span>{format.number(value)}</span>
      {figure != null ? (
        <span className="font-sans text-sm font-normal text-(--el-text-secondary)">
          {t('of', { figure: format.number(figure) })}
        </span>
      ) : null}
    </span>
  );
}

function FigureTile({
  testId,
  icon,
  label,
  figure,
  note,
}: {
  testId: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  figure: FleetUseFigureDTO;
  note: string | null;
}) {
  const { inUse } = figure;
  const cap = figure.figure;
  const pct = inUse !== null && cap !== null && cap > 0 ? (inUse / cap) * 100 : null;
  return (
    <div data-testid={testId} className={`${TILE} bg-(--el-page-bg)`}>
      <TileLabel icon={icon} label={label} />
      <TileValue value={inUse} figure={cap} />
      {pct !== null ? (
        <Meter pct={pct} low={inUse !== null && cap !== null && inUse >= cap} />
      ) : null}
      {note ? <span className="font-sans text-xs text-(--el-text-secondary)">{note}</span> : null}
    </div>
  );
}
