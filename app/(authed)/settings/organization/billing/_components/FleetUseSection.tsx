'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import type {
  FleetUseDTO,
  FleetUseFigureDTO,
  FleetUseHostAccountDTO,
  FleetUseWaitingDTO,
} from '@/lib/dto/fleetUse';
import type { OrgFleetCapacityRequestDTO } from '@/lib/dto/fleetCapacityRequest';
import { fmt, fmtDate } from './billingFormat';
import { Meter } from './BillingClient';
import { FleetUseRequestDialog } from './FleetUseRequestDialog';
import {
  ACCOUNT_KIND_KEYS,
  ACCOUNT_ROLE_KEYS,
  ACCOUNT_STATE_KEYS,
  FIGURE_KEYS,
  FLEET_KIND_KEYS,
  PROVIDER_KEYS,
  QUOTA_OUTCOME_KEYS,
  REQUEST_STATUS_KEYS,
  SHARED_FLOOR_KEYS,
  activeRequest,
  figureSourceKey,
  figureView,
  fmtDateTime,
  isDeniedOutcome,
  stateSince,
  type FleetUseFigureKey,
} from './fleetUseFormat';

// THE FLEET USE SECTION (Story MOTIR-9368 · MOTIR-9663; design/billing
// § Amendment 2026-10-26, `billing--fleet-use.mock.html`) — the last card of the
// Billing & plans settings view. A client island with its OWN read of
// GET …/billing/fleet-use, so its loading, failure and retry never reach the
// page's own state. It renders nothing for a 403 or 404 (a member, off-cloud).
// It reads only the `FleetUseDTO`, which carries no account id, shard id,
// credential, email or user id — so none can be rendered.

type T = ReturnType<typeof useTranslations<'billing.fleetUse'>>;
type Load =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'failed' }
  | { kind: 'ready'; data: FleetUseDTO };

function isFleetUse(value: unknown): value is { fleetUse: FleetUseDTO } {
  const body = value as { fleetUse?: Partial<FleetUseDTO> } | null;
  return Boolean(body?.fleetUse?.plan && body.fleetUse.figures && body.fleetUse.whereItRuns);
}

function useFleetUse(orgId: string) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const seq = useRef(0);
  const read = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing/fleet-use`);
      if (mySeq !== seq.current) return;
      if (res.status === 403 || res.status === 404) return setLoad({ kind: 'hidden' });
      const body: unknown = res.ok ? await res.json() : null;
      if (mySeq !== seq.current) return;
      setLoad(isFleetUse(body) ? { kind: 'ready', data: body.fleetUse } : { kind: 'failed' });
    } catch {
      if (mySeq === seq.current) setLoad({ kind: 'failed' });
    }
  }, [orgId]);
  useEffect(() => {
    // The section's first read — an external-system sync (the fleet-use API);
    // every state write in read() happens after its await, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);
  return { load, read };
}

export function FleetUseSection({ orgId }: { orgId: string }) {
  const t = useTranslations('billing.fleetUse');
  const { load, read } = useFleetUse(orgId);
  if (load.kind === 'hidden') return null;
  if (load.kind === 'loading') {
    return (
      <FleetUseCard t={t} plan={null} busy>
        <p className="font-sans text-sm text-(--el-text-secondary)">{t('loading')}</p>
      </FleetUseCard>
    );
  }
  if (load.kind === 'failed') return <NotReadSection t={t} retry={read} data={null} />;
  return <FleetUseBody t={t} data={load.data} orgId={orgId} reload={read} />;
}

function FleetUseCard({
  t,
  plan,
  busy,
  children,
}: {
  t: T;
  plan: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="fleet-use-title"
      aria-busy={busy || undefined}
      data-testid="fleet-use"
    >
      <Card header={<FleetUseHeader t={t} plan={plan} />}>
        <div className="flex flex-col gap-4">{children}</div>
      </Card>
    </section>
  );
}

function FleetUseHeader({ t, plan }: { t: T; plan: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) font-sans text-xs font-semibold text-(--el-text-strong)"
          aria-hidden
        >
          ⚙
        </span>
        <div>
          <h2 id="fleet-use-title" className="font-sans text-base font-semibold text-(--el-text)">
            {t('title')}
          </h2>
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('lead')}</p>
        </div>
      </div>
      {plan ? <div className="font-sans text-sm text-(--el-text)">{plan}</div> : null}
    </div>
  );
}

function PlanName({ t, name }: { t: T; name: string }) {
  return (
    <span>
      {t('yourPlan')} <span className="font-semibold">{name}</span>
    </span>
  );
}

function PlanWord({ text }: { text: string }) {
  return <span className="font-sans text-sm text-(--el-text-secondary)">{text}</span>;
}

function FleetUseBody({
  t,
  data,
  orgId,
  reload,
}: {
  t: T;
  data: FleetUseDTO;
  orgId: string;
  reload: () => Promise<void>;
}) {
  const plan = data.plan;
  if (plan.kind === 'not_read' || !data.countsRead) {
    return <NotReadSection t={t} retry={reload} data={data} />;
  }
  if (plan.kind === 'no_plan_limits') return <NoPlanLimits t={t} data={data} />;
  if (plan.noFleet) return <NoFleetOnPlan t={t} planName={plan.planName} />;
  return (
    <FleetUseCard t={t} plan={<PlanName t={t} name={plan.planName} />}>
      <FigureRows t={t} data={data} />
      <IndexingLine t={t} inUse={data.codeGraphIndex.inUse} />
      <WhereItRunsList t={t} data={data} />
      <OwnAccountsBlock t={t} data={data} orgId={orgId} reload={reload} />
    </FleetUseCard>
  );
}

function FigureRows({ t, data, noLimits }: { t: T; data: FleetUseDTO; noLimits?: boolean }) {
  const keys = noLimits ? FIGURE_KEYS.filter((k) => k !== 'agentsPerPerson') : FIGURE_KEYS;
  return (
    <div className="flex flex-col">
      {keys.map((key) => (
        <FigureRow key={key} t={t} figureKey={key} row={data.figures[key]} noLimits={noLimits} />
      ))}
    </div>
  );
}

function FigureRow({
  t,
  figureKey,
  row,
  noLimits,
}: {
  t: T;
  figureKey: FleetUseFigureKey;
  row: FleetUseFigureDTO;
  noLimits?: boolean;
}) {
  const locale = useLocale();
  const view = figureView(figureKey, row, locale, noLimits);
  const muted = view.reading.key === 'notRead' || view.reading.key === 'running';
  return (
    <div
      className="flex flex-col gap-1 border-t border-(--el-border-soft) py-(--spacing-control-y-8) first:border-t-0"
      data-testid={`fleet-figure-${figureKey}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-sans text-sm font-medium text-(--el-text)">
          {t(`label.${figureKey}`)}
        </span>
        <span
          className={`font-sans text-sm tabular-nums ${muted ? 'font-medium text-(--el-text-secondary)' : 'font-semibold text-(--el-text)'}`}
        >
          {t(view.reading.key, view.reading.values)}
        </span>
      </div>
      {view.pct === null ? null : <Meter pct={view.pct} />}
      <FigureExplain t={t} figureKey={figureKey} row={row} noLimits={noLimits} />
    </div>
  );
}

function FigureExplain({
  t,
  figureKey,
  row,
  noLimits,
}: {
  t: T;
  figureKey: FleetUseFigureKey;
  row: FleetUseFigureDTO;
  noLimits?: boolean;
}) {
  if (noLimits)
    return <p className="font-sans text-xs text-(--el-text-secondary)">{t('noLimit')}</p>;
  const sourceKey = row.inUse === null ? null : figureSourceKey(figureKey, row.figureSource);
  const queues = figureKey === 'agentRunsInParallel' || figureKey === 'ciJobsInFlight';
  return (
    <>
      <p className="font-sans text-xs text-(--el-text-secondary)">{t(`explain.${figureKey}`)}</p>
      {sourceKey ? <SourceLine t={t} sourceKey={sourceKey} figure={row.figure} /> : null}
      {queues && row.waiting && row.inUse !== null ? (
        <WaitingBreakdown t={t} figureKey={figureKey} waiting={row.waiting} />
      ) : null}
    </>
  );
}

function SourceLine({ t, sourceKey, figure }: { t: T; sourceKey: string; figure: number | null }) {
  const locale = useLocale();
  const values = {
    figure: figure === null ? '' : fmt(figure, locale),
    vcpu: figure === null ? '' : fmt(figure * 2, locale),
  };
  const strong = sourceKey === 'source.notRead';
  return (
    <p
      className={`font-sans text-xs ${strong ? 'font-medium text-(--el-text)' : 'text-(--el-text-secondary)'}`}
    >
      {t(sourceKey, values)}
    </p>
  );
}

function WaitingBreakdown({
  t,
  figureKey,
  waiting,
}: {
  t: T;
  figureKey: FleetUseFigureKey;
  waiting: FleetUseWaitingDTO;
}) {
  const locale = useLocale();
  if (waiting.planLimit + waiting.poolFull + waiting.other === 0) {
    return <p className="font-sans text-xs text-(--el-text-secondary)">{t('waiting.none')}</p>;
  }
  const lines: { n: number; tone: 'awaiting' | 'neutral'; words: string }[] = [
    { n: waiting.planLimit, tone: 'awaiting', words: t('waiting.planLimit') },
    { n: waiting.poolFull, tone: 'neutral', words: t(`waiting.poolFull.${figureKey}`) },
    { n: waiting.other, tone: 'neutral', words: t('waiting.other') },
  ];
  return (
    <ul className="flex flex-col gap-1">
      {lines
        .filter((line) => line.n > 0)
        .map((line) => (
          <li
            key={line.words}
            className="flex items-start gap-2 font-sans text-xs text-(--el-text)"
          >
            <Pill tone={line.tone} className="shrink-0 whitespace-nowrap">
              {t('waiting.count', { count: fmt(line.n, locale) })}
            </Pill>
            <span className="pt-0.5">{line.words}</span>
          </li>
        ))}
    </ul>
  );
}

function IndexingLine({ t, inUse }: { t: T; inUse: number | null }) {
  const locale = useLocale();
  return (
    <p className="font-sans text-xs text-(--el-text-secondary)">
      {inUse === null ? t('indexingNotRead') : t('indexing', { count: fmt(inUse, locale) })}
    </p>
  );
}

function WhereItRunsList({ t, data }: { t: T; data: FleetUseDTO }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-sans text-sm font-semibold text-(--el-text)">{t('whereItRuns')}</h3>
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1">
        {data.whereItRuns.map((row) => (
          <div key={row.fleetKind} className="contents">
            <dt className="font-sans text-xs text-(--el-text-secondary)">
              {t(FLEET_KIND_KEYS[row.fleetKind])}
            </dt>
            <dd className="font-sans text-xs font-medium text-(--el-text)">
              {t(PROVIDER_KEYS[row.provider])}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DashedNotice({ text, retry, t }: { text: string; retry: () => void; t: T }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-control) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-control-x-12)"
    >
      <p className="font-sans text-sm text-(--el-text)">{text}</p>
      <Button variant="secondary" size="sm" onClick={retry}>
        {t('tryAgain')}
      </Button>
    </div>
  );
}

const NOT_READ_ROW: FleetUseFigureDTO = {
  figure: null,
  inUse: null,
  waiting: null,
  figureSource: 'not_read',
};

/** Not read: the whole read failed, the plan was not read, or the counts were not. */
function NotReadSection({
  t,
  retry,
  data,
}: {
  t: T;
  retry: () => Promise<void>;
  data: FleetUseDTO | null;
}) {
  const figures = Object.fromEntries(FIGURE_KEYS.map((k) => [k, NOT_READ_ROW]));
  const shown = { ...(data ?? EMPTY_FLEET_USE), figures } as FleetUseDTO;
  return (
    <FleetUseCard t={t} plan={<PlanWord text={t('planNotRead')} />}>
      <DashedNotice t={t} text={t('notReadNotice')} retry={() => void retry()} />
      <FigureRows t={t} data={shown} />
      <IndexingLine t={t} inUse={null} />
      {data ? <WhereItRunsList t={t} data={data} /> : null}
    </FleetUseCard>
  );
}

const EMPTY_FLEET_USE: FleetUseDTO = {
  plan: { kind: 'not_read' },
  countsRead: false,
  figures: {
    agentRunsInParallel: NOT_READ_ROW,
    agentsInOrg: NOT_READ_ROW,
    agentsPerPerson: NOT_READ_ROW,
    ciJobsInFlight: NOT_READ_ROW,
  },
  codeGraphIndex: { inUse: null },
  whereItRuns: [],
  hostAccounts: null,
};

function NoPlanLimits({ t, data }: { t: T; data: FleetUseDTO }) {
  return (
    <FleetUseCard t={t} plan={<PlanWord text={t('noPlanLimits')} />}>
      <p className="font-sans text-sm text-(--el-text)">{t('noPlanLimitsNote')}</p>
      <FigureRows t={t} data={data} noLimits />
      <IndexingLine t={t} inUse={data.codeGraphIndex.inUse} />
      <WhereItRunsList t={t} data={data} />
    </FleetUseCard>
  );
}

function NoFleetOnPlan({ t, planName }: { t: T; planName: string }) {
  return (
    <FleetUseCard t={t} plan={<PlanName t={t} name={planName} />}>
      <p className="font-sans text-sm text-(--el-text)">{t('noFleet')}</p>
    </FleetUseCard>
  );
}

function OwnAccountsBlock({
  t,
  data,
  orgId,
  reload,
}: {
  t: T;
  data: FleetUseDTO;
  orgId: string;
  reload: () => Promise<void>;
}) {
  const accounts = data.hostAccounts;
  if (accounts === null) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="fleet-own-accounts">
      <h3 className="font-sans text-sm font-semibold text-(--el-text)">{t('accounts.title')}</h3>
      {'kind' in accounts ? (
        <DashedNotice t={t} text={t('accounts.notRead')} retry={() => void reload()} />
      ) : (
        accounts.map((account) => (
          <AccountRow
            key={account.accountKind}
            t={t}
            account={account}
            data={data}
            orgId={orgId}
            reload={reload}
          />
        ))
      )}
    </div>
  );
}

function AccountRow({
  t,
  account,
  data,
  orgId,
  reload,
}: {
  t: T;
  account: FleetUseHostAccountDTO;
  data: FleetUseDTO;
  orgId: string;
  reload: () => Promise<void>;
}) {
  const active = activeRequest(account);
  const latest = account.capacityRequests[0] ?? null;
  return (
    <div
      className="flex flex-col gap-2 rounded-(--radius-control) border border-(--el-border-soft) p-(--spacing-control-x-12)"
      data-testid={`fleet-account-${account.accountKind}`}
    >
      <AccountHeading t={t} account={account} />
      <VcpuFigures t={t} account={account} />
      <SharedFloorNote t={t} account={account} data={data} />
      {account.keptIndexSpots === null ? null : (
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('accounts.keptSpots', { count: account.keptIndexSpots })}
        </p>
      )}
      {latest ? <RequestStatusLine t={t} request={active ?? latest} /> : null}
      {active ? null : <RequestButton t={t} account={account} orgId={orgId} onSent={reload} />}
    </div>
  );
}

function AccountHeading({ t, account }: { t: T; account: FleetUseHostAccountDTO }) {
  const locale = useLocale();
  const since = fmtDateTime(stateSince(account), locale);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-col">
        <span className="font-sans text-sm font-semibold text-(--el-text)">
          {t(ACCOUNT_KIND_KEYS[account.accountKind])}
        </span>
        <span className="font-sans text-xs text-(--el-text-secondary)">
          {t(ACCOUNT_ROLE_KEYS[account.accountKind])}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <AccountStatePill t={t} account={account} />
        {since ? (
          <span className="font-sans text-xs text-(--el-text-secondary)">
            {t('accounts.since', { when: since })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AccountStatePill({ t, account }: { t: T; account: FleetUseHostAccountDTO }) {
  if (isDeniedOutcome(account.quotaOutcome)) {
    return <Pill severity="danger">{t('accounts.quotaDenied')}</Pill>;
  }
  const label = t(ACCOUNT_STATE_KEYS[account.state]);
  switch (account.state) {
    case 'live':
      return <Pill severity="success">{label}</Pill>;
    case 'granted':
      return <Pill severity="info">{label}</Pill>;
    case 'quota_requested':
      return <Pill tone="awaiting">{label}</Pill>;
    case 'created':
      return <Pill tone="neutral">{label}</Pill>;
  }
}

function VcpuFigures({ t, account }: { t: T; account: FleetUseHostAccountDTO }) {
  const locale = useLocale();
  const dd = 'font-medium tabular-nums text-(--el-text)';
  return (
    <dl className="grid grid-cols-2 gap-x-4 font-sans text-xs">
      <dt className="text-(--el-text-secondary)">{t('accounts.vcpuAsked')}</dt>
      <dt className="text-(--el-text-secondary)">{t('accounts.vcpuGranted')}</dt>
      <dd className={dd}>{account.vcpuAsked === null ? '—' : fmt(account.vcpuAsked, locale)}</dd>
      <dd className={dd}>
        {account.vcpuGranted === null ? t('accounts.noneYet') : fmt(account.vcpuGranted, locale)}
      </dd>
    </dl>
  );
}

function SharedFloorNote({
  t,
  account,
  data,
}: {
  t: T;
  account: FleetUseHostAccountDTO;
  data: FleetUseDTO;
}) {
  const locale = useLocale();
  const n = (row: FleetUseFigureDTO) => (row.figure === null ? '—' : fmt(row.figure, locale));
  const sentences: string[] = [];
  if (account.onSharedFloor) {
    sentences.push(
      t(SHARED_FLOOR_KEYS[account.accountKind], {
        figure: n(
          account.accountKind === 'ci_runner'
            ? data.figures.ciJobsInFlight
            : data.figures.agentRunsInParallel,
        ),
        perPerson: n(data.figures.agentsPerPerson),
        perOrg: n(data.figures.agentsInOrg),
      }),
    );
  }
  if (account.state === 'granted') sentences.push(t('accounts.liveOnceNetwork'));
  if (isDeniedOutcome(account.quotaOutcome)) {
    sentences.push(t('accounts.deniedNote', { state: t(ACCOUNT_STATE_KEYS[account.state]) }));
  }
  if (sentences.length === 0) return null;
  return <p className="font-sans text-xs text-(--el-text)">{sentences.join(' ')}</p>;
}

function requestPill(t: T, request: OrgFleetCapacityRequestDTO, locale: string) {
  if (request.status !== 'closed') {
    const tone = request.status === 'open' ? 'awaiting' : undefined;
    return tone ? (
      <Pill tone={tone}>{t(REQUEST_STATUS_KEYS.open)}</Pill>
    ) : (
      <Pill severity="info">{t(REQUEST_STATUS_KEYS.filed)}</Pill>
    );
  }
  if (request.closedNote) return <Pill tone="neutral">{t(REQUEST_STATUS_KEYS.closed)}</Pill>;
  if (request.outcome?.status === 'approved') {
    const vcpu = fmt(request.outcome.grantedValue ?? request.desiredVcpu, locale);
    return <Pill severity="success">{t('request.granted', { vcpu })}</Pill>;
  }
  if (request.outcome && isDeniedOutcome(request.outcome.status)) {
    return <Pill severity="danger">{t('quotaOutcome.denied')}</Pill>;
  }
  return <Pill tone="neutral">{t(REQUEST_STATUS_KEYS.closed)}</Pill>;
}

function requestWords(t: T, request: OrgFleetCapacityRequestDTO): string {
  if (request.status === 'open') return t('request.line.open');
  if (request.status === 'filed') return t('request.line.filed');
  if (request.closedNote) return t('request.line.closedNote', { note: request.closedNote });
  const outcome = request.outcome?.status ?? null;
  if (outcome === 'approved') return t('request.line.granted');
  if (isDeniedOutcome(outcome)) return t('request.line.denied');
  return t('request.line.closed', {
    outcome: outcome ? t(QUOTA_OUTCOME_KEYS[outcome]) : t('notRead'),
  });
}

function RequestStatusLine({ t, request }: { t: T; request: OrgFleetCapacityRequestDTO }) {
  const locale = useLocale();
  const asked = t('request.asked', {
    vcpu: fmt(request.desiredVcpu, locale),
    date: fmtDate(request.createdAt, locale) ?? '',
  });
  return (
    <div
      className="flex flex-wrap items-center gap-2 font-sans text-xs text-(--el-text)"
      data-testid="fleet-request-status"
    >
      {requestPill(t, request, locale)}
      <span>
        {asked} · {requestWords(t, request)}
      </span>
    </div>
  );
}

function RequestButton({
  t,
  account,
  orgId,
  onSent,
}: {
  t: T;
  account: FleetUseHostAccountDTO;
  orgId: string;
  onSent: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t('request.button')}
      </Button>
      {open ? (
        <FleetUseRequestDialog
          orgId={orgId}
          account={account}
          onClose={() => setOpen(false)}
          onSent={onSent}
        />
      ) : null}
    </div>
  );
}
