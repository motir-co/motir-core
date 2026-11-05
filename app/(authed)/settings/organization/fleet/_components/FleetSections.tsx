'use client';

import { useTranslations } from 'next-intl';
import { CircleSlash, ExternalLink, Folder, Layers, Moon, Server, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import type {
  OrgFleetAgentInstanceDTO,
  OrgFleetDTO,
  OrgFleetHostedRunDTO,
  OrgFleetMotirStopDTO,
} from '@/lib/dto/orgFleet';
import { FleetEmpty, FleetRow, FleetRows, FleetSection } from './FleetSection';
import { useFleetTime } from './fleetTime';

// The five sections of the Fleet page (design panel 2), each rendered from its
// OWN part of the read: `not_read` draws that section's error (FleetSection), and
// the others keep their data.
//
// ⚠️ METADATA ONLY. No agent row links anywhere — not to the agent's panel, not to
// its terminal — and Hibernate is the only action on one. Index jobs has no
// control at all.

const ICON = 'h-4 w-4';

type T = ReturnType<typeof useTranslations<'settings.organization.fleet'>>;

/** What a row's in-flight or settled local state is, by id. */
export type RowState = 'working' | 'hibernated';

export function HostedRunsSection({
  part,
  onRetry,
  onCancel,
  busy,
}: {
  part: OrgFleetDTO['hostedRuns'];
  onRetry: () => void;
  /** Absent when the viewer may not stop: the row offers no Cancel. */
  onCancel?: (run: OrgFleetHostedRunDTO) => void;
  busy: ReadonlyMap<string, RowState>;
}) {
  const t = useTranslations('settings.organization.fleet');
  const read = part.kind === 'read' ? part : null;
  return (
    <FleetSection
      id="fleet-hosted"
      testId="fleet-hosted"
      icon={<Sparkles className={ICON} />}
      chip="bg-(--el-tint-lavender) text-(--el-accent-on-surface)"
      title={t('hosted.title')}
      lead={t('hosted.lead')}
      count={read && read.rows.length > 0 ? t('hosted.count', { count: read.rows.length }) : null}
      failed={read ? null : t('hosted.failed')}
      onRetry={onRetry}
    >
      {read && read.rows.length === 0 ? <FleetEmpty text={t('hosted.empty')} /> : null}
      {read && read.rows.length > 0 ? (
        <FleetRows>
          {read.rows.map((run) => (
            <HostedRunRow
              key={run.id}
              t={t}
              run={run}
              working={busy.get(run.id) === 'working'}
              onCancel={onCancel}
            />
          ))}
        </FleetRows>
      ) : null}
    </FleetSection>
  );
}

function HostedRunRow({
  t,
  run,
  working,
  onCancel,
}: {
  t: T;
  run: OrgFleetHostedRunDTO;
  working: boolean;
  /** Absent when the viewer may not stop: the row offers no Cancel. */
  onCancel?: (run: OrgFleetHostedRunDTO) => void;
}) {
  const time = useFleetTime();
  const key = run.card?.key ?? '';
  const project = run.projectName ?? t('hosted.noProject');
  const at = time.at(run.startedAt);
  return (
    <FleetRow
      testId="fleet-hosted-row"
      primary={
        run.card ? (
          <>
            <span className="font-mono text-xs text-(--el-text-secondary)">{run.card.key}</span>{' '}
            {run.card.title}
          </>
        ) : (
          t('hosted.noCard')
        )
      }
      meta={
        <>
          {run.dispatcherName
            ? t('hosted.meta', { project, name: run.dispatcherName, time: at })
            : t('hosted.metaNoName', { project, time: at })}
          <a href={run.runUrl} className="text-(--el-link) underline underline-offset-2">
            {t('hosted.openRun')}
          </a>
        </>
      }
      status={<Pill severity="info">{t('hosted.running')}</Pill>}
      action={
        onCancel ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={t('hosted.cancelAria', { key: key || project })}
            loading={working}
            disabled={working}
            onClick={() => onCancel(run)}
          >
            {working ? t('hosted.cancelling') : t('hosted.cancel')}
          </Button>
        ) : undefined
      }
    />
  );
}

export function AgentInstancesSection({
  part,
  onRetry,
  onHibernate,
  rowState,
}: {
  part: OrgFleetDTO['agentInstances'];
  onRetry: () => void;
  /** Absent when the viewer may not stop: the row offers no Hibernate. */
  onHibernate?: (agent: OrgFleetAgentInstanceDTO) => void;
  rowState: ReadonlyMap<string, { state: RowState; at?: string }>;
}) {
  const t = useTranslations('settings.organization.fleet');
  const read = part.kind === 'read' ? part : null;
  return (
    <FleetSection
      id="fleet-agents"
      testId="fleet-agents"
      icon={<Server className={ICON} />}
      chip="bg-(--el-tint-sky) text-(--el-info)"
      title={t('agents.title')}
      lead={t('agents.lead')}
      count={read && read.rows.length > 0 ? t('agents.count', { count: read.rows.length }) : null}
      failed={read ? null : t('agents.failed')}
      onRetry={onRetry}
    >
      {read && read.rows.length === 0 ? <FleetEmpty text={t('agents.empty')} /> : null}
      {read && read.rows.length > 0 ? (
        <FleetRows>
          {read.rows.map((agent) => (
            <AgentRow
              key={agent.id}
              t={t}
              agent={agent}
              local={rowState.get(agent.id)}
              onHibernate={onHibernate}
            />
          ))}
        </FleetRows>
      ) : null}
    </FleetSection>
  );
}

/** The owner's display name as the row and its dialog say it. */
export function ownerOf(t: T, agent: OrgFleetAgentInstanceDTO): string {
  return agent.ownerName ?? t('agents.unknownOwner');
}

function AgentRow({
  t,
  agent,
  local,
  onHibernate,
}: {
  t: T;
  agent: OrgFleetAgentInstanceDTO;
  local: { state: RowState; at?: string } | undefined;
  /** Absent when the viewer may not stop: the row offers no Hibernate. */
  onHibernate?: (agent: OrgFleetAgentInstanceDTO) => void;
}) {
  const time = useFleetTime();
  const owner = ownerOf(t, agent);
  const project = agent.projectName ?? t('hosted.noProject');
  // A hibernate this page just confirmed reads as hibernating until a read catches
  // up (panel 7c) — the row never offers the action again meanwhile. A read whose
  // state changed AFTER that hibernate (it rests, or its owner woke it) wins.
  const hibernatedHere =
    local?.state === 'hibernated' &&
    agent.state === 'running' &&
    local.at !== undefined &&
    Date.parse(local.at) >= Date.parse(agent.since);
  const running = agent.state === 'running' && !hibernatedHere;
  const working = local?.state === 'working';
  return (
    <FleetRow
      testId="fleet-agent-row"
      primary={t('agents.name', { owner, profile: agent.profileId })}
      meta={agentMeta(t, agent, project, time.at(agent.since))}
      status={
        hibernatedHere ? (
          <Pill tone="archived">
            {t('agents.hibernatingAt', { time: time.at(local?.at ?? agent.since) })}
          </Pill>
        ) : (
          <AgentStatePill t={t} state={agent.state} />
        )
      }
      action={
        running && onHibernate ? (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={working ? undefined : <Moon aria-hidden className={ICON} />}
            aria-label={t('agents.hibernateAria', { owner })}
            loading={working}
            disabled={working}
            onClick={() => onHibernate(agent)}
          >
            {working ? t('agents.hibernatingNow') : t('agents.hibernate')}
          </Button>
        ) : undefined
      }
    />
  );
}

function agentMeta(t: T, agent: OrgFleetAgentInstanceDTO, project: string, at: string): string {
  if (agent.state === 'running') return t('agents.runningSince', { project, time: at });
  if (agent.state === 'hibernating' || agent.state === 'hibernated') {
    return t('agents.hibernatingSince', { project, time: at });
  }
  return t('agents.inStateSince', { project, state: stateWord(t, agent.state), time: at });
}

const STATE_WORDS = ['starting', 'waking', 'updating', 'deleting', 'hibernated', 'failed'] as const;

function stateWord(t: T, state: string): string {
  const known = STATE_WORDS.find((s) => s === state);
  return known ? t(`agents.state.${known}`) : t('agents.state.other');
}

function AgentStatePill({ t, state }: { t: T; state: string }) {
  if (state === 'running') return <Pill severity="success">{t('agents.running')}</Pill>;
  if (state === 'hibernating' || state === 'hibernated') {
    return <Pill tone="archived">{t('agents.hibernating')}</Pill>;
  }
  return <Pill tone="neutral">{stateWord(t, state)}</Pill>;
}

export function CiJobsSection({
  part,
  onRetry,
}: {
  part: OrgFleetDTO['ciJobs'];
  onRetry: () => void;
}) {
  const t = useTranslations('settings.organization.fleet');
  const time = useFleetTime();
  const read = part.kind === 'read' ? part : null;
  const waiting = read ? read.waiting.planLimit + read.waiting.poolFull + read.waiting.other : 0;
  return (
    <FleetSection
      id="fleet-ci"
      testId="fleet-ci"
      icon={<Layers className={ICON} />}
      chip="bg-(--el-tint-mint) text-(--el-success)"
      title={t('ci.title')}
      lead={t('ci.lead')}
      count={
        read && read.rows.length > 0 ? t('ci.count', { inFlight: read.inFlight, waiting }) : null
      }
      failed={read ? null : t('ci.failed')}
      onRetry={onRetry}
    >
      {read && read.rows.length === 0 ? <FleetEmpty text={t('ci.empty')} /> : null}
      {read && read.rows.length > 0 ? (
        <FleetRows>
          {read.rows.map((job) => (
            <FleetRow
              key={job.id}
              testId="fleet-ci-row"
              primary={
                <>
                  <span className="font-mono text-xs">{job.repository}</span>
                  {[job.workflowName, job.jobName]
                    .filter((part): part is string => Boolean(part))
                    .map((part) => ` · ${part}`)
                    .join('')}
                </>
              }
              meta={
                <>
                  {t('ci.meta', {
                    project: job.projectName ?? t('ci.noProject'),
                    time: time.at(job.queuedAt),
                  })}
                  <a
                    href={job.actionsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-(--el-link) underline underline-offset-2"
                  >
                    {t('ci.viewOnGithub')}
                    <ExternalLink aria-hidden className="h-3 w-3" />
                  </a>
                </>
              }
              status={
                job.state === 'waiting' ? (
                  <Pill tone="awaiting">
                    {t('ci.waiting', { cause: t(`ci.cause.${job.waitingCause ?? 'other'}`) })}
                  </Pill>
                ) : (
                  <Pill severity="success">{t('ci.running')}</Pill>
                )
              }
            />
          ))}
        </FleetRows>
      ) : null}
    </FleetSection>
  );
}

export function IndexJobsSection({
  part,
  onRetry,
}: {
  part: OrgFleetDTO['indexJobs'];
  onRetry: () => void;
}) {
  const t = useTranslations('settings.organization.fleet');
  return (
    <FleetSection
      id="fleet-index"
      testId="fleet-index"
      icon={<Folder className={ICON} />}
      chip="bg-(--el-surface-soft) text-(--el-text-secondary)"
      title={t('index.title')}
      failed={part.kind === 'read' ? null : t('index.failed')}
      onRetry={onRetry}
    >
      {part.kind === 'read' ? (
        <p className="font-sans text-sm text-(--el-text)">
          {t.rich('index.running', {
            count: part.running,
            n: (chunks) => <strong className="font-semibold tabular-nums">{chunks}</strong>,
          })}
          <span className="block font-sans text-xs text-(--el-text-secondary)">
            {t('index.note')}
          </span>
        </p>
      ) : null}
    </FleetSection>
  );
}

export function MotirStopsSection({
  part,
  onRetry,
}: {
  part: OrgFleetDTO['motirStops'];
  onRetry: () => void;
}) {
  const t = useTranslations('settings.organization.fleet');
  const read = part.kind === 'read' ? part : null;
  return (
    <FleetSection
      id="fleet-motir-stops"
      testId="fleet-motir-stops"
      icon={<CircleSlash className={ICON} />}
      chip="bg-(--el-tint-peach) text-(--el-warning)"
      title={t('motirStops.title')}
      lead={t('motirStops.lead')}
      failed={read ? null : t('motirStops.failed')}
      onRetry={onRetry}
    >
      {read && read.entries.length === 0 ? <FleetEmpty text={t('motirStops.empty')} /> : null}
      {read && read.entries.length > 0 ? (
        <FleetRows>
          {read.entries.map((entry, index) => (
            <MotirStopRow key={`${entry.decidedAt}-${index}`} t={t} entry={entry} />
          ))}
        </FleetRows>
      ) : null}
    </FleetSection>
  );
}

const WORKLOADS = ['ci_runner', 'hosted_agent', 'agent_instance', 'code_graph_index'] as const;

function MotirStopRow({ t, entry }: { t: T; entry: OrgFleetMotirStopDTO }) {
  const time = useFleetTime();
  const workload = WORKLOADS.find((w) => w === entry.workload) ?? 'other';
  return (
    <FleetRow
      testId="fleet-motir-stop-row"
      primary={t(`motirStops.workload.${workload}`)}
      meta={t('motirStops.line', {
        when: time.at(entry.decidedAt),
        reason: t(`motirStops.reason.${entry.reason}`),
      })}
      status={
        entry.completed ? (
          <Pill tone="neutral">{t('motirStops.done')}</Pill>
        ) : (
          <Pill severity="warning">{t('motirStops.notDone')}</Pill>
        )
      }
    />
  );
}
