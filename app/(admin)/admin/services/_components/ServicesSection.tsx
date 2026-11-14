import { getFormatter, getTranslations } from 'next-intl/server';
import {
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Container,
  GitBranch,
  Info,
  LoaderCircle,
  OctagonAlert,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import { HEADROOM_ALERT_FRACTION } from '@/lib/ciFleet/shardTargets';
import type {
  PlatformServiceCommitDTO,
  PlatformServiceRowDTO,
  PlatformServiceVersionDTO,
  PlatformServiceVersionJudgementDTO,
  PlatformServicesDTO,
  PlatformServicesQuotaDTO,
  PlatformServicesShareDTO,
  PlatformServicesTotalDTO,
} from '@/lib/dto/platformServices';
import {
  ago,
  CardHead,
  InsetState,
  Mono,
  Sub,
  Td,
  Th,
} from '../../monitoring/_components/FleetSection';

/**
 * THE SERVICES CARD (MOTIR-10890, design MOTIR-10889). A server component that
 * renders what `platformServicesService` judged and decides nothing: every
 * verdict, count and figure arrives in the DTO.
 *
 * ⚠️ AN UNREAD FIGURE IS A WORD, NEVER A NUMBER. A failed cluster read renders
 * "ECS did not answer" with no row and no total; an unread quota renders
 * "Not read" and the share "Not available", with no bar.
 *
 * THE COMMIT COLUMN, THE VERSION PILL AND THE STALE COUNT (MOTIR-11112, design
 * MOTIR-11242, `platform-admin/design-notes.md` § _AMENDMENT 2026-11-13 —
 * Services: the Commit column, the version pill and the stale count`). A commit
 * that did not resolve is "Not known" and a version that was not judged is
 * "Unknown" with its reason — never a number, never a green pill.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.services'>>>;
type FleetT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.fleet'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

interface Words {
  t: T;
  ft: FleetT;
  format: Format;
  now: Date;
}

const GLYPH = 'h-3 w-3 shrink-0';

function secondsSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
}

/** HH:MM of an ISO instant, in UTC — the copy says "UTC" beside it. */
export function utcTime(iso: string): string {
  return iso.slice(11, 16);
}

function vcpuWords(n: number, { t, format }: Words): string {
  return t('vcpu', { n: format.number(n) });
}

function memoryWords(mib: number, { t, format }: Words): string {
  return mib % 1024 === 0
    ? t('memory.gb', { n: format.number(mib / 1024) })
    : t('memory.mb', { n: format.number(mib) });
}

export async function ServicesSection({ read: dto }: { read: PlatformServicesDTO }) {
  const t = await getTranslations('platformAdmin.services');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();
  const w: Words = { t, ft, format, now: new Date() };
  const { cluster } = dto;

  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('subtitle', { account: dto.account ?? t('accountUnknown'), cluster })}
        </p>
        <p
          data-testid="services-read-at"
          className="flex items-center gap-1 font-sans text-xs text-(--el-text-secondary)"
        >
          <RefreshCw aria-hidden className={GLYPH} />
          {dto.read.status === 'failed'
            ? t('readFailedAt', { time: utcTime(dto.readAt) })
            : t('readAt', {
                age: ago(ft, secondsSince(dto.readAt, w.now)),
                time: utcTime(dto.readAt),
              })}
        </p>
      </div>
      <Card
        data-testid="services-card"
        header={
          <CardHead
            icon={<Container className="h-4 w-4" />}
            title={t('card.title', { cluster })}
            subtitle={t('card.subtitle', { cluster })}
            pills={<HeaderPills dto={dto} w={w} />}
          />
        }
      >
        <div className="flex flex-col gap-4">
          {dto.read.status === 'failed' ? (
            <InsetState
              icon={<TriangleAlert className="h-5 w-5" />}
              title={t('error.title')}
              tone="error"
            >
              {t('error.body', {
                cluster,
                last: dto.read.lastReadAt
                  ? t('error.lastRead', {
                      age: ago(ft, secondsSince(dto.read.lastReadAt, w.now)),
                      time: utcTime(dto.read.lastReadAt),
                    })
                  : t('error.neverRead'),
              })}
            </InsetState>
          ) : (
            <>
              <ServicesTable
                cluster={cluster}
                rows={dto.read.services}
                total={dto.read.total}
                quota={dto.quota}
                share={dto.share}
                w={w}
              />
              <ServicesList
                cluster={cluster}
                rows={dto.read.services}
                total={dto.read.total}
                quota={dto.quota}
                share={dto.share}
                w={w}
              />
            </>
          )}
          <p className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
            <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
            {t('readOnly')}
          </p>
        </div>
      </Card>
    </>
  );
}

// ── Header pills ─────────────────────────────────────────────────────────────

function HeaderPills({ dto, w }: { dto: PlatformServicesDTO; w: Words }) {
  const { t } = w;
  if (dto.read.status === 'failed') {
    return (
      <Pill tone="awaiting">
        <CircleHelp aria-hidden className={GLYPH} />
        {t('verdict.clusterNotRead')}
      </Pill>
    );
  }
  const { read } = dto;
  return (
    <>
      <Pill tone="neutral">{t('pill.count', { count: read.total.services })}</Pill>
      {read.rolling > 0 ? (
        <Pill severity="info">
          <LoaderCircle aria-hidden className={GLYPH} />
          {t('pill.rolling', { count: read.rolling })}
        </Pill>
      ) : null}
      {read.failed > 0 ? (
        <Pill severity="danger">
          <OctagonAlert aria-hidden className={GLYPH} />
          {t('pill.rolloutFailed', { count: read.failed })}
        </Pill>
      ) : null}
      <StaleCountPill read={read} t={t} />
      {read.short > 0 ? (
        <Pill severity="warning">
          <TriangleAlert aria-hidden className={GLYPH} />
          {t('pill.short', { count: read.short })}
        </Pill>
      ) : null}
      <VerdictPill share={dto.share} t={t} />
    </>
  );
}

/** Stale-or-diverged services, after the rollout-failed pill. Absent at zero;
 *  "Versions not read" when no row's version was judged — never a zero. */
function StaleCountPill({
  read,
  t,
}: {
  read: Extract<PlatformServicesDTO['read'], { status: 'ok' }>;
  t: T;
}) {
  if (read.versionsNotRead) {
    return (
      <Pill tone="awaiting" aria-label={t('pill.versionsNotReadLabel')} data-element="stale-count">
        <CircleHelp aria-hidden className={GLYPH} />
        {t('pill.versionsNotRead')}
      </Pill>
    );
  }
  if (read.staleOrDiverged === 0) return null;
  return (
    <Pill severity="danger" data-element="stale-count">
      <OctagonAlert aria-hidden className={GLYPH} />
      {t('pill.staleOrDiverged', { count: read.staleOrDiverged })}
    </Pill>
  );
}

function VerdictPill({ share, t }: { share: PlatformServicesShareDTO | null; t: T }) {
  if (share === null) {
    return (
      <Pill tone="awaiting" aria-label={t('verdict.notReadLabel')} data-verdict="notRead">
        <CircleHelp aria-hidden className={GLYPH} />
        {t('verdict.notRead')}
      </Pill>
    );
  }
  switch (share.verdict) {
    case 'atQuota':
      return (
        <Pill severity="danger" data-verdict="atQuota">
          <OctagonAlert aria-hidden className={GLYPH} />
          {t('verdict.atQuota')}
        </Pill>
      );
    case 'over70':
      return (
        <Pill severity="warning" data-verdict="over70">
          <TriangleAlert aria-hidden className={GLYPH} />
          {t('verdict.over70')}
        </Pill>
      );
    default:
      return (
        <Pill severity="success" data-verdict="under">
          <CircleCheck aria-hidden className={GLYPH} />
          {t('verdict.under', { percent: share.percent })}
        </Pill>
      );
  }
}

// ── Per-row cells, shared by the table and the phone list ─────────────────────

function rowRail(row: PlatformServiceRowDTO): boolean | 'warning' {
  if (row.deployment.state === 'failed') return true;
  if (row.tasks === 'short') return 'warning';
  return false;
}

function shareRail(share: PlatformServicesShareDTO | null): boolean | 'warning' {
  if (share?.verdict === 'atQuota') return true;
  if (share?.verdict === 'over70') return 'warning';
  return false;
}

function TasksCell({ row, w }: { row: PlatformServiceRowDTO; w: Words }) {
  const { t, format } = w;
  switch (row.tasks) {
    case 'scaledToZero':
      return (
        <span className="flex flex-col items-end gap-1">
          <span className="text-(--el-text-secondary)">{t('tasks.running', { n: 0 })}</span>
          <Pill tone="neutral">
            <CircleMinus aria-hidden className={GLYPH} />
            {t('tasks.scaledToZero')}
          </Pill>
        </span>
      );
    case 'rolling':
      return (
        <span>
          <span className="font-semibold text-(--el-text)">
            {t('tasks.running', { n: format.number(row.running) })}
          </span>
          <Sub>
            {t('tasks.rolling', {
              desired: format.number(row.desired),
              old: format.number(row.deployment.oldRunning),
              new: format.number(row.deployment.newRunning),
            })}
          </Sub>
        </span>
      );
    case 'short':
      return (
        <span className="flex flex-col items-end gap-1">
          <span className="text-(--el-text)">
            {t('tasks.partial', {
              running: format.number(row.running),
              desired: format.number(row.desired),
            })}
          </span>
          <Pill severity="warning">
            <TriangleAlert aria-hidden className={GLYPH} />
            {t('tasks.notStarted', { n: format.number(row.notStarted) })}
          </Pill>
        </span>
      );
    default:
      return (
        <span className="text-(--el-text)">
          {t('tasks.running', { n: format.number(row.running) })}
        </span>
      );
  }
}

function VcpuCell({ row, w }: { row: PlatformServiceRowDTO; w: Words }) {
  const { t, format } = w;
  return (
    <span>
      <span
        className={
          row.tasks === 'scaledToZero'
            ? 'text-(--el-text-secondary)'
            : 'font-medium text-(--el-text)'
        }
      >
        {vcpuWords(row.vcpu, w)}
      </span>
      {row.uniformSize && row.running > 0 ? (
        <Sub>
          {t('vcpuTimes', {
            running: format.number(row.running),
            perTask: format.number(row.vcpuPerTask),
          })}
        </Sub>
      ) : null}
    </span>
  );
}

function DeploymentCell({ row, w }: { row: PlatformServiceRowDTO; w: Words }) {
  const { t, ft, format, now } = w;
  const d = row.deployment;
  const started = d.startedAt ? (
    <Sub>{t('deploy.started', { age: ago(ft, secondsSince(d.startedAt, now)) })}</Sub>
  ) : null;
  switch (d.state) {
    case 'rolling':
      return (
        <span data-deployment="rolling">
          <Pill severity="info">
            <LoaderCircle aria-hidden className={GLYPH} />
            {t('deploy.rolling')}
          </Pill>
          <Sub>
            {t('deploy.rollingDetail', {
              from: d.fromRevision ?? d.toRevision,
              to: d.toRevision,
              new: format.number(d.newRunning),
              desired: format.number(d.newDesired),
            })}
          </Sub>
          {started}
        </span>
      );
    case 'failed':
      return (
        <span data-deployment="failed">
          <Pill severity="danger">
            <OctagonAlert aria-hidden className={GLYPH} />
            {t('deploy.failed')}
          </Pill>
          <Sub>
            {t('deploy.failedDetail', { to: d.toRevision, from: d.fromRevision ?? d.toRevision })}
          </Sub>
          {started}
        </span>
      );
    case 'notRolling':
      return (
        <span data-deployment="notRolling">
          <Pill tone="neutral">
            <CircleMinus aria-hidden className={GLYPH} />
            {t('deploy.notRolling')}
          </Pill>
        </span>
      );
    default:
      return (
        <span data-deployment="steady">
          <Pill tone="neutral">
            <CircleCheck aria-hidden className={GLYPH} />
            {t('deploy.steady')}
          </Pill>
          <Sub>{t('deploy.onRevision', { revision: d.toRevision })}</Sub>
        </span>
      );
  }
}

// ── The commit cell and the version pill (MOTIR-11112) ──────────────────────

/** The deployed commit: linked to GitHub, plain when no repository is mapped,
 *  and "Not known" when none resolved. */
function CommitCell({ commit, t }: { commit: PlatformServiceCommitDTO | null; t: T }) {
  if (commit === null) {
    return (
      <span data-element="commit-cell" className="italic text-(--el-text-secondary)">
        {t('commit.notKnown')}
      </span>
    );
  }
  const short = commit.sha.slice(0, 7);
  if (commit.url === null || commit.repository === null) {
    return (
      <span data-element="commit-cell" className="font-mono text-xs text-(--el-text-identifier)">
        {short}
      </span>
    );
  }
  return (
    <a
      data-element="commit-cell"
      href={commit.url}
      aria-label={t('commit.linkLabel', { commit: short, repo: commit.repository })}
      className="font-mono text-xs text-(--el-link) underline underline-offset-2"
    >
      {short}
    </a>
  );
}

/** One judgement's pill — glyph + words, never colour alone. */
function JudgementPill({ judgement, t }: { judgement: PlatformServiceVersionJudgementDTO; t: T }) {
  switch (judgement.state) {
    case 'latest':
      return (
        <Pill severity="success" data-version="latest">
          <CircleCheck aria-hidden className={GLYPH} />
          {t('version.latest')}
        </Pill>
      );
    case 'behind': {
      const stale = judgement.severity === 'stale';
      const Glyph = stale ? OctagonAlert : TriangleAlert;
      return (
        <Pill severity={stale ? 'danger' : 'warning'} data-version={`behind-${judgement.severity}`}>
          <Glyph aria-hidden className={GLYPH} />
          {t('version.behind', { count: judgement.count })}
        </Pill>
      );
    }
    case 'diverged':
      return (
        <Pill severity="danger" data-version="diverged">
          <GitBranch aria-hidden className={GLYPH} />
          {t('version.diverged')}
        </Pill>
      );
    default: {
      const reason = t(`version.reason.${judgement.reason}`);
      return (
        <Tooltip content={reason} className="max-w-[18rem]">
          <Pill
            tone="neutral"
            tabIndex={0}
            aria-label={t('version.unknownLabel', { reason })}
            data-reason={judgement.reason}
          >
            <CircleHelp aria-hidden className={GLYPH} />
            {t('version.unknown')}
          </Pill>
        </Tooltip>
      );
    }
  }
}

/** What sits under a judgement's pill: the behind line, the diverged line, and
 *  on the phone (no hover) Unknown's short reason. */
function JudgementLines({
  judgement,
  phone,
  w,
}: {
  judgement: PlatformServiceVersionJudgementDTO;
  phone: boolean;
  w: Words;
}) {
  const { t, ft, now } = w;
  switch (judgement.state) {
    case 'behind':
      return (
        <>
          <Sub>
            {t('version.oldest', {
              age: ago(ft, secondsSince(judgement.oldestUndeployedAt, now)),
            })}
          </Sub>
          <a
            href={judgement.compareUrl}
            className="font-sans text-xs text-(--el-link) underline underline-offset-2"
          >
            {t('version.compare')}
          </a>
        </>
      );
    case 'diverged':
      return <Sub>{t('version.divergedDetail')}</Sub>;
    case 'unknown':
      return phone ? <Sub>{t(`version.reasonShort.${judgement.reason}`)}</Sub> : null;
    default:
      return null;
  }
}

function VersionBody({
  version,
  phone,
  w,
}: {
  version: PlatformServiceVersionDTO;
  phone: boolean;
  w: Words;
}) {
  const { t } = w;
  if (version.state === 'rolling') {
    return (
      <span className="flex flex-col items-start gap-1" data-version="rolling">
        <span className="flex flex-wrap items-center gap-1">
          <Pill severity="info">
            <LoaderCircle aria-hidden className={GLYPH} />
            {t('version.rolling')}
          </Pill>
          <JudgementPill judgement={version.primary} t={t} />
        </span>
        <Sub>{t('version.rollingDetail')}</Sub>
        <JudgementLines judgement={version.primary} phone={phone} w={w} />
      </span>
    );
  }
  return (
    <span
      className="flex flex-col items-start gap-1"
      data-version={version.state === 'unknown' ? 'unknown' : undefined}
    >
      <JudgementPill judgement={version} t={t} />
      <JudgementLines judgement={version} phone={phone} w={w} />
    </span>
  );
}

/** The Commit column's cell: the commit, the version pill directly under it. */
function VersionCell({ row, phone, w }: { row: PlatformServiceRowDTO; phone: boolean; w: Words }) {
  return (
    <span className="flex flex-col items-start gap-1" data-element="version-cell">
      <CommitCell commit={row.commit} t={w.t} />
      <VersionBody version={row.version} phone={phone} w={w} />
    </span>
  );
}

// ── The total against the quota ──────────────────────────────────────────────

/** The use bar with its 70% tick: accent under 70%, warning at or over it,
 *  danger at the quota. `aria-hidden`: the percent beside it carries the meaning. */
function UseBar({ share }: { share: PlatformServicesShareDTO }) {
  const fill =
    share.verdict === 'atQuota'
      ? 'bg-(--el-danger)'
      : share.verdict === 'over70'
        ? 'bg-(--el-warning)'
        : 'bg-(--el-accent)';
  const width = share.percent <= 0 ? 0 : Math.min(100, Math.max(1, share.percent));
  return (
    <span
      aria-hidden
      data-bar={share.verdict}
      className="relative block h-2 w-full min-w-[8rem] overflow-hidden rounded-(--radius-badge) bg-(--el-surface)"
    >
      <span
        className={`block h-full rounded-(--radius-badge) ${fill}`}
        style={{ width: `${width}%` }}
      />
      <span
        className="absolute inset-y-0 w-px bg-(--el-text-secondary)"
        style={{ left: `${HEADROOM_ALERT_FRACTION * 100}%` }}
      />
    </span>
  );
}

function ShareBody({ share, w }: { share: PlatformServicesShareDTO | null; w: Words }) {
  const { t, format } = w;
  if (share === null) {
    return (
      <span className="flex flex-col gap-1" data-share="notAvailable">
        <span className="italic text-(--el-text-secondary)">{t('notAvailable')}</span>
        <Sub>{t('total.shareNotKnown')}</Sub>
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1" data-share={share.verdict}>
      <span className="font-medium text-(--el-text)">
        {t('total.share', { percent: share.percent })}
      </span>
      <UseBar share={share} />
      {share.verdict === 'atQuota' ? (
        <span className="flex flex-wrap items-center gap-2">
          <Pill severity="danger">
            <OctagonAlert aria-hidden className={GLYPH} />
            {t('total.atQuota')}
          </Pill>
          <Sub>
            {share.over > 0
              ? t('total.overBy', { n: format.number(share.over) })
              : t('total.noneLeft')}
          </Sub>
        </span>
      ) : share.verdict === 'over70' ? (
        <span className="flex flex-wrap items-center gap-2">
          <Pill severity="warning">
            <TriangleAlert aria-hidden className={GLYPH} />
            {t('total.over70')}
          </Pill>
          <Sub>{t('total.leftBeforeQuota', { n: format.number(share.headroom) })}</Sub>
        </span>
      ) : (
        <Sub>{t('total.toGo', { n: format.number(share.headroom) })}</Sub>
      )}
    </span>
  );
}

function QuotaFigure({ quota, w }: { quota: PlatformServicesQuotaDTO; w: Words }) {
  const { t, ft, now } = w;
  if (quota.status === 'ok') {
    return (
      <span>
        <span className="font-medium text-(--el-text)">{vcpuWords(quota.vcpu, w)}</span>
        <Sub>{t('quota.readAgo', { age: ago(ft, secondsSince(quota.readAt, now)) })}</Sub>
      </span>
    );
  }
  return (
    <span className="flex flex-col items-end gap-1" data-mark="not-read">
      <Pill tone="awaiting" aria-label={t('quota.notReadLabel')}>
        <CircleHelp aria-hidden className={GLYPH} />
        {t('quota.notRead')}
      </Pill>
      <Sub>
        {quota.lastReadAt
          ? t('quota.lastRead', { age: ago(ft, secondsSince(quota.lastReadAt, now)) })
          : t('quota.neverRead')}
      </Sub>
    </span>
  );
}

// ── The table (≥ sm) ─────────────────────────────────────────────────────────

interface ReadProps {
  cluster: string;
  rows: PlatformServiceRowDTO[];
  total: PlatformServicesTotalDTO;
  quota: PlatformServicesQuotaDTO;
  share: PlatformServicesShareDTO | null;
  w: Words;
}

const DASH = <span className="text-(--el-text-secondary)">—</span>;

/** The Commit column's dash on the total and quota rows: no commit belongs there. */
const DASH_HIDDEN = (
  <span aria-hidden className="text-(--el-text-secondary)">
    —
  </span>
);

function ServicesTable({ cluster, rows, total, quota, share, w }: ReadProps) {
  const { t, format } = w;
  return (
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[62rem] border-collapse font-sans text-sm">
        <caption className="sr-only">{t('caption', { cluster })}</caption>
        <thead className="border-b border-(--el-border)">
          <tr>
            <Th scope="col">{t('col.service')}</Th>
            <Th scope="col" numeric>
              {t('col.tasks')}
            </Th>
            <Th scope="col" numeric>
              {t('col.vcpuPerTask')}
            </Th>
            <Th scope="col" numeric>
              {t('col.memoryPerTask')}
            </Th>
            <Th scope="col" numeric>
              {t('col.vcpu')}
            </Th>
            <Th scope="col">{t('col.deployment')}</Th>
            <Th scope="col">{t('col.commit')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              data-service={row.name}
              className="border-b border-(--el-border-soft)"
            >
              <Td rail={rowRail(row)}>
                <Mono>{row.name}</Mono>
                <Sub>{t('taskDefinition', { family: row.family, revision: row.revision })}</Sub>
              </Td>
              <Td numeric className="tabular-nums whitespace-nowrap">
                <TasksCell row={row} w={w} />
              </Td>
              <Td numeric className="tabular-nums whitespace-nowrap">
                {format.number(row.vcpuPerTask)}
              </Td>
              <Td numeric className="tabular-nums whitespace-nowrap">
                {memoryWords(row.memoryMib, w)}
              </Td>
              <Td numeric className="tabular-nums whitespace-nowrap">
                <VcpuCell row={row} w={w} />
              </Td>
              <Td>
                <DeploymentCell row={row} w={w} />
              </Td>
              <Td>
                <VersionCell row={row} phone={false} w={w} />
              </Td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-(--el-surface-soft)">
          <tr data-row="total" className="border-b border-(--el-border-soft)">
            <Td rail={shareRail(share)}>
              <span className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
                {t('total.label')}
              </span>
              <Sub>{t('total.services', { count: total.services })}</Sub>
            </Td>
            <Td numeric className="tabular-nums whitespace-nowrap">
              <span className="text-(--el-text)">
                {t('tasks.running', { n: format.number(total.running) })}
              </span>
              <Sub>{t('total.desired', { n: format.number(total.desired) })}</Sub>
            </Td>
            <Td numeric>{DASH}</Td>
            <Td numeric>{DASH}</Td>
            <Td numeric className="tabular-nums whitespace-nowrap">
              <span className="font-serif text-xl text-(--el-text)">
                {vcpuWords(total.vcpu, w)}
              </span>
              <Sub>{t('total.inUse')}</Sub>
            </Td>
            <Td>
              <ShareBody share={share} w={w} />
            </Td>
            <Td>{DASH_HIDDEN}</Td>
          </tr>
          <tr data-row="quota">
            <Td rail={false}>
              <span className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
                {t('quota.label')}
              </span>
              <Sub>{t('quota.code')}</Sub>
            </Td>
            <Td numeric>{DASH}</Td>
            <Td numeric>{DASH}</Td>
            <Td numeric>{DASH}</Td>
            <Td numeric className="tabular-nums whitespace-nowrap">
              <QuotaFigure quota={quota} w={w} />
            </Td>
            <Td>
              <span className="block max-w-[22rem] text-xs text-(--el-text-secondary)">
                {quota.status === 'ok' ? t('quota.body') : t('quota.bodyNotRead')}
              </span>
            </Td>
            <Td>{DASH_HIDDEN}</Td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ── The phone list (< sm) ────────────────────────────────────────────────────

function railClass(rail: boolean | 'warning'): string {
  return rail === 'warning'
    ? 'border-l-[3px] border-l-(--el-warning) pl-3'
    : rail
      ? 'border-l-[3px] border-l-(--el-danger) pl-3'
      : '';
}

function Pair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-(--el-text-secondary)">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function ServicesList({ cluster, rows, total, quota, share, w }: ReadProps) {
  const { t, format } = w;
  return (
    <div className="flex flex-col gap-3 sm:hidden">
      <ul aria-label={t('phone.listLabel', { cluster })} className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.name}
            data-service={row.name}
            className={`flex flex-col gap-2 border-b border-(--el-border-soft) py-3 ${railClass(rowRail(row))}`}
          >
            <div>
              <Mono>{row.name}</Mono>
              <Sub>{t('taskDefinition', { family: row.family, revision: row.revision })}</Sub>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              <Pair label={t('col.tasks')}>
                <TasksCell row={row} w={w} />
              </Pair>
              <Pair label={t('col.vcpu')}>
                <VcpuCell row={row} w={w} />
              </Pair>
              <Pair label={t('phone.perTask')}>
                <span className="text-(--el-text)">
                  {`${vcpuWords(row.vcpuPerTask, w)} · ${memoryWords(row.memoryMib, w)}`}
                </span>
              </Pair>
              <Pair label={t('col.deployment')}>
                <DeploymentCell row={row} w={w} />
              </Pair>
              <div className="col-span-2">
                <Pair label={t('col.commit')}>
                  <VersionCell row={row} phone w={w} />
                </Pair>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <div
        data-row="total"
        className={`flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding-12) ${railClass(shareRail(share))}`}
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Pair label={t('total.label')}>
            <span className="text-(--el-text)">
              {t('tasks.running', { n: format.number(total.running) })}
            </span>
            <Sub>{t('total.desired', { n: format.number(total.desired) })}</Sub>
          </Pair>
          <Pair label={t('col.vcpu')}>
            <span className="font-serif text-xl text-(--el-text)">{vcpuWords(total.vcpu, w)}</span>
            <Sub>{t('total.inUse')}</Sub>
          </Pair>
          <Pair label={t('quota.label')}>
            <QuotaFigure quota={quota} w={w} />
          </Pair>
        </dl>
        <ShareBody share={share} w={w} />
      </div>
    </div>
  );
}

// ── Loading ──────────────────────────────────────────────────────────────────

function Bar({ className }: { className: string }) {
  return (
    <span
      className={`block rounded-(--radius-control) bg-(--el-muted) ${/\bh-/.test(className) ? '' : 'h-4'} ${className}`}
    />
  );
}

/** The read in flight: the table head over four skeleton rows and a skeleton
 *  total, with one status line for a screen reader. */
export async function ServicesSkeleton() {
  const t = await getTranslations('platformAdmin.services');
  return (
    <>
      <div aria-hidden="true" className="flex animate-pulse flex-col gap-2">
        <Bar className="w-full max-w-prose" />
        <Bar className="w-64" />
      </div>
      <Card aria-busy="true" data-testid="services-loading">
        <p role="status" className="sr-only">
          {t('loading')}
        </p>
        <div aria-hidden="true" className="flex animate-pulse flex-col gap-3">
          <Bar className="w-72" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] font-sans text-sm">
              <thead className="border-b border-(--el-border)">
                <tr>
                  <Th>{t('col.service')}</Th>
                  <Th numeric>{t('col.tasks')}</Th>
                  <Th numeric>{t('col.vcpuPerTask')}</Th>
                  <Th numeric>{t('col.memoryPerTask')}</Th>
                  <Th numeric>{t('col.vcpu')}</Th>
                  <Th>{t('col.deployment')}</Th>
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2, 3].map((i) => (
                  <tr key={i} className="border-b border-(--el-border-soft)">
                    {[0, 1, 2, 3, 4, 5].map((j) => (
                      <td key={j} className="py-3 pr-3 first:pl-3">
                        <Bar className="w-full" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Bar className="h-10 w-full" />
        </div>
      </Card>
    </>
  );
}
