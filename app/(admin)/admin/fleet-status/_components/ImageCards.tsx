import type { ReactNode } from 'react';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  ExternalLink,
  GitCommitHorizontal,
  HardDrive,
  Info,
  Package,
  Server,
  Settings,
  TriangleAlert,
  Upload,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Spinner } from '@/components/ui/Spinner';
import type {
  FleetImageBuildDTO,
  FleetImageKey,
  FleetImagePublishDTO,
  FleetImageReadSource,
  HostedImageReadDTO,
  HostedImageRowDTO,
  RunnerImageReadDTO,
  RunnerImageRowDTO,
  SandboxImageReadDTO,
  SandboxImageRowDTO,
} from '@/lib/dto/fleetStatusImages';
import {
  amiBuiltAt,
  imageVerdict,
  shortCommit,
  shortDigest,
  type FleetImageVerdict,
} from '@/lib/fleetStatus/imageVerdict';
import { ago, CardHead, InsetState } from '../../monitoring/_components/FleetSection';
import { PublishControl, type PublishControlProps } from './PublishControl';

// THE IMAGE CARDS of /admin/fleet-status (MOTIR-10886; design MOTIR-10885
// § Elements and Panels 1–6, 9, 12–13). Server components: every word and
// figure is rendered here from the row; the one island is the Publish row.

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.fleetStatus'>>>;

const COMMIT_URL = (sha: string) => `https://github.com/motir-co/motir-core/commit/${sha}`;
export const AUDIT_LOG_HREF = '/admin/audit-log?action=fleet.image.publish';

const ICONS: Record<FleetImageKey, ReactNode> = {
  hosted: <Bot className="h-4 w-4" />,
  runner: <Server className="h-4 w-4" />,
  sandbox: <Package className="h-4 w-4" />,
};

async function tools() {
  const [t, tFleet, format] = await Promise.all([
    getTranslations('platformAdmin.fleetStatus'),
    getTranslations('platformAdmin.monitoring.fleet'),
    getFormatter(),
  ]);
  const now = Date.now();
  return {
    t,
    format,
    date: (iso: string | null) =>
      iso ? format.dateTime(new Date(iso), { dateStyle: 'medium' }) : '',
    when: (iso: string) =>
      format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
    age: (iso: string) => ago(tFleet, Math.max(0, Math.round((now - Date.parse(iso)) / 1000))),
  };
}
type Tools = Awaited<ReturnType<typeof tools>>;

function VerdictPill({ t, verdict }: { t: T; verdict: FleetImageVerdict }) {
  const icon = 'h-3 w-3';
  switch (verdict.kind) {
    case 'up_to_date':
      return (
        <Pill severity="success" data-verdict="up_to_date">
          <CircleCheck aria-hidden className={icon} />
          {t('verdict.upToDate')}
        </Pill>
      );
    case 'days_behind':
      return (
        <Pill severity="warning" data-verdict="days_behind">
          <TriangleAlert aria-hidden className={icon} />
          {t('verdict.daysBehind', { count: verdict.count })}
        </Pill>
      );
    case 'releases_behind':
      return (
        <Pill severity="warning" data-verdict="releases_behind">
          <TriangleAlert aria-hidden className={icon} />
          {t('verdict.releasesBehind', { count: verdict.count })}
        </Pill>
      );
    case 'release_needed':
      return (
        <Pill severity="warning" data-verdict="release_needed">
          <TriangleAlert aria-hidden className={icon} />
          {t('verdict.releaseNeeded')}
        </Pill>
      );
    case 'tags_missing':
      return (
        <Pill severity="warning" data-verdict="tags_missing">
          <TriangleAlert aria-hidden className={icon} />
          {t('verdict.tagsMissing', { missing: verdict.missing, total: verdict.total })}
        </Pill>
      );
    case 'publishing':
      return (
        <Pill severity="info" data-verdict="publishing">
          <Upload aria-hidden className={icon} />
          {t('verdict.publishing')}
        </Pill>
      );
    case 'publish_failed':
      return (
        <Pill severity="danger" data-verdict="publish_failed">
          <CircleAlert aria-hidden className={icon} />
          {t('verdict.publishFailed')}
        </Pill>
      );
    case 'unset':
      return (
        <Pill tone="neutral" data-verdict="unset">
          <Settings aria-hidden className={icon} />
          {t('unset.title')}
        </Pill>
      );
    case 'not_read':
      return (
        <Pill tone="awaiting" aria-label={t('verdict.notRead')} data-verdict="not_read">
          <CircleQuestionMark aria-hidden className={icon} />
          {t('verdict.notRead')}
        </Pill>
      );
  }
}

/** The card frame every image card shares. */
function ImageCard({
  image,
  t,
  verdict,
  footer,
  children,
}: {
  image: FleetImageKey;
  t: T;
  verdict: FleetImageVerdict;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      data-image={image}
      data-state={verdict.kind}
      header={
        <CardHead
          level={3}
          icon={ICONS[image]}
          title={t(`image.${image}.title`)}
          subtitle={t(`image.${image}.subtitle`)}
          pills={<VerdictPill t={t} verdict={verdict} />}
        />
      }
      footer={footer}
    >
      {children}
    </Card>
  );
}

const SOURCE_KEY: Record<FleetImageReadSource, 'source.ghcr' | 'source.github' | 'source.aws'> = {
  ghcr: 'source.ghcr',
  github: 'source.github',
  aws: 'source.aws',
};

/** Panel 9 — a row one source did not answer for: the Block error, no figure, no button. */
async function NotReadCard({
  image,
  source,
  detail,
}: {
  image: FleetImageKey;
  source: FleetImageReadSource;
  detail: string;
}) {
  const t = await getTranslations('platformAdmin.fleetStatus');
  // The read's own words go to the server log, never to the page.
  console.error('[admin] fleet status image could not be read', { image, source, detail });
  return (
    <ImageCard image={image} t={t} verdict={{ kind: 'not_read' }}>
      <InsetState
        icon={<TriangleAlert className="h-5 w-5" />}
        title={t('imageError.title', { image: t(`imageName.${image}`) })}
        tone="error"
        level={4}
      >
        {t('imageError.body', { source: t(SOURCE_KEY[source]) })}
      </InsetState>
    </ImageCard>
  );
}

async function UnsetCard({ image, variable }: { image: FleetImageKey; variable: string }) {
  const t = await getTranslations('platformAdmin.fleetStatus');
  return (
    <ImageCard image={image} t={t} verdict={{ kind: 'unset' }}>
      <InsetState icon={<Settings className="h-5 w-5" />} title={t('unset.title')} level={4}>
        {t('unset.body', { variable })}
      </InsetState>
    </ImageCard>
  );
}

function CommitLink({ commit, className = '' }: { commit: string; className?: string }) {
  return (
    <a
      href={COMMIT_URL(commit)}
      className={`font-mono text-(--el-link) underline underline-offset-2 ${className}`}
    >
      {shortCommit(commit)}
    </a>
  );
}

function CompareTile({
  label,
  value,
  digest,
  build,
  same,
  x,
}: {
  label: string;
  value: string;
  digest: string | null;
  build: FleetImageBuildDTO;
  same: boolean;
  x: Tools;
}) {
  const { t } = x;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) p-(--spacing-card-padding-12)">
      <span className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
        {label}
      </span>
      <span className="break-all font-mono text-sm text-(--el-text)">{value}</span>
      {digest ? (
        <span className="font-mono text-xs text-(--el-text-identifier)">{digest}</span>
      ) : null}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-xs text-(--el-text-secondary)">
        <span className="inline-flex items-center gap-1">
          <GitCommitHorizontal aria-hidden className="h-3 w-3" />
          {build.commit
            ? t.rich('compare.builtFrom', {
                commit: () => <CommitLink commit={build.commit!} />,
              })
            : t('compare.noCommit')}
        </span>
        {build.createdAt ? (
          <>
            <span aria-hidden>·</span>
            <span>{x.date(build.createdAt)}</span>
          </>
        ) : null}
      </span>
      {same ? (
        <span className="font-sans text-xs text-(--el-text-secondary)">{t('compare.same')}</span>
      ) : null}
    </div>
  );
}

function GapLine({
  strong,
  rest,
  href,
  t,
}: {
  strong: string;
  rest: string;
  href: string | null;
  t: T;
}) {
  return (
    <p
      className="flex flex-wrap items-start gap-x-2 gap-y-1 font-sans text-sm text-(--el-text)"
      data-element="gap"
    >
      <span className="inline-flex items-start gap-1.5">
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
        <span>
          <strong className="font-semibold">{strong}</strong>
          {rest ? ` · ${rest}` : null}
        </span>
      </span>
      {href ? (
        <a
          href={href}
          className="inline-flex items-center gap-1 font-medium text-(--el-link) underline underline-offset-2"
        >
          {t('gap.link')}
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      ) : null}
    </p>
  );
}

function Band({ tone, children }: { tone: 'info' | 'success' | 'danger'; children: ReactNode }) {
  const fill =
    tone === 'info'
      ? 'bg-(--el-tint-sky)'
      : tone === 'success'
        ? 'bg-(--el-tint-mint)'
        : 'bg-(--el-tint-rose)';
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-tone={tone}
      className={`flex items-start gap-2 rounded-(--radius-card) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong) ${fill}`}
    >
      {tone === 'info' ? (
        <Spinner size="sm" className="mt-0.5 shrink-0 text-(--el-info)" />
      ) : tone === 'success' ? (
        <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-success)" />
      ) : (
        <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
      )}
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

function RunLink({
  publish,
  label,
  x,
}: {
  publish: FleetImagePublishDTO;
  label: string;
  x: Tools;
}) {
  const record = publish.record;
  if (!record?.runUrl) return null;
  const text =
    record.runNumber !== null
      ? x.t('workflow.run', { workflow: label, number: record.runNumber })
      : x.t('workflow.runNoNumber', { workflow: label });
  return (
    <a
      href={record.runUrl}
      className="inline-flex items-center gap-1 font-medium text-(--el-text-strong) underline underline-offset-2"
    >
      {text}
      <ExternalLink aria-hidden className="h-3 w-3" />
    </a>
  );
}

/** The progress, done and failed bands (Panel 6), or null when idle. */
function PublishBand({
  publish,
  workflowLabel,
  doneText,
  x,
}: {
  publish: FleetImagePublishDTO;
  workflowLabel: string;
  doneText: string;
  x: Tools;
}) {
  const { t } = x;
  const { progress, record } = publish;
  if (progress.state === 'running') {
    return (
      <Band tone="info">
        <span>
          <strong className="font-semibold">{t('progress.title')}</strong> {t('progress.body')}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs">
          <RunLink publish={publish} label={workflowLabel} x={x} />
          <span>
            {record?.actorEmail
              ? t('progress.started', { age: x.age(progress.startedAt), email: record.actorEmail })
              : t('progress.startedNoActor', { age: x.age(progress.startedAt) })}
          </span>
        </span>
      </Band>
    );
  }
  if (progress.state === 'done') {
    return (
      <Band tone="success">
        <span>
          <strong className="font-semibold">{t('done.title')}</strong> {doneText}
        </span>
        <span className="text-xs">
          <RunLink publish={publish} label={workflowLabel} x={x} />
        </span>
      </Band>
    );
  }
  if (progress.state === 'failed') {
    return (
      <Band tone="danger">
        <span>
          <strong className="font-semibold">
            {t('failed.title', { age: x.age(progress.endedAt) })}
          </strong>{' '}
          {t('failed.body')}
        </span>
        <code className="block whitespace-pre-wrap break-all rounded-(--radius-control) bg-(--el-page-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs text-(--el-text)">
          {progress.error ?? t('failed.noDetail')}
        </code>
        <span className="text-xs">
          <RunLink publish={publish} label={workflowLabel} x={x} />
        </span>
      </Band>
    );
  }
  return null;
}

function AuditLine({ publish, x }: { publish: FleetImagePublishDTO; x: Tools }) {
  const { t } = x;
  const record = publish.record;
  const text = !record
    ? t('audit.never')
    : t(publish.progress.state === 'running' ? 'audit.started' : 'audit.last', {
        email: record.actorEmail ?? '—',
        when: x.when(record.at),
      });
  return (
    <p className="flex flex-wrap items-start gap-1 font-sans text-xs text-(--el-text-secondary)">
      <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
      <span>{text}</span>
      <Link
        href={AUDIT_LOG_HREF}
        className="inline-flex items-center gap-1 font-medium text-(--el-link) underline underline-offset-2"
      >
        {t('audit.link')}
      </Link>
    </p>
  );
}

/** The island's props for a read row. */
function publishProps({
  image,
  publish,
  enabledNote,
  idleNote,
  band,
  confirm,
  t,
}: {
  image: FleetImageKey;
  publish: FleetImagePublishDTO;
  enabledNote: string;
  idleNote: string;
  band: ReactNode;
  confirm: PublishControlProps['confirm'];
  t: T;
}): PublishControlProps {
  const { progress, blocked, record } = publish;
  const mode: PublishControlProps['mode'] =
    progress.state === 'running'
      ? 'running'
      : progress.state === 'failed' && !blocked
        ? 'failed'
        : progress.state === 'done'
          ? 'done'
          : blocked
            ? 'disabled'
            : 'enabled';
  const note =
    progress.state === 'done'
      ? t('publish.note.done')
      : blocked === 'running'
        ? t('publish.note.running')
        : blocked
          ? idleNote
          : enabledNote;
  return {
    image,
    mode,
    note,
    band,
    confirm: blocked ? null : confirm,
    poll:
      progress.state === 'running' && record?.runId
        ? { runId: record.runId, target: record.target }
        : null,
  };
}

// ── Hosted agent ─────────────────────────────────────────────────────────────

export async function HostedImageCard({
  row,
  actorEmail,
}: {
  row: HostedImageRowDTO;
  actorEmail: string;
}) {
  if (row.status === 'not_read')
    return <NotReadCard image="hosted" source={row.source} detail={row.detail} />;
  if (row.status === 'unset') return <UnsetCard image="hosted" variable={row.variable} />;
  const x = await tools();
  return <HostedBody row={row} x={x} actorEmail={actorEmail} />;
}

function HostedBody({
  row,
  x,
  actorEmail,
}: {
  row: HostedImageReadDTO;
  x: Tools;
  actorEmail: string;
}) {
  const { t } = x;
  const verdict = imageVerdict(row);
  const workflowLabel = t('workflow.hosted');
  const tileLine = (b: FleetImageBuildDTO) =>
    [shortDigest(b.digest), shortCommit(b.commit), x.date(b.createdAt)].filter(Boolean).join(' · ');
  return (
    <ImageCard
      image="hosted"
      t={t}
      verdict={verdict}
      footer={<AuditLine publish={row.publish} x={x} />}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <CompareTile
            label={t('compare.pinned')}
            value={shortDigest(row.pinned.digest)}
            digest={null}
            build={row.pinned}
            same={false}
            x={x}
          />
          <CompareTile
            label={t('compare.newestBuild')}
            value={shortDigest(row.newest.digest)}
            digest={null}
            build={row.newest}
            same={!row.behind}
            x={x}
          />
        </div>
        {row.behind ? (
          <GapLine
            t={t}
            strong={t('verdict.daysBehind', { count: row.daysBehind ?? 0 })}
            rest={row.cliCommits !== null ? t('gap.hosted', { count: row.cliCommits }) : ''}
            href={row.compareUrl}
          />
        ) : null}
        <PublishControl
          {...publishProps({
            image: 'hosted',
            publish: row.publish,
            enabledNote: t('publish.note.hosted'),
            idleNote: t('publish.note.hostedCurrent'),
            band: (
              <PublishBand
                publish={row.publish}
                workflowLabel={workflowLabel}
                doneText={t('done.pin', {
                  to: shortCommit(row.pinned.commit) || shortDigest(row.pinned.digest),
                  digest: shortDigest(row.pinned.digest),
                })}
                x={x}
              />
            ),
            confirm: {
              title: t('confirm.hostedTitle'),
              from: tileLine(row.pinned),
              to: tileLine(row.newest),
              body: t.rich('confirm.hostedBody', {
                strong: (c) => <strong className="font-semibold">{c}</strong>,
              }),
              confirmLabel: t('publish.button'),
              audited: t('confirm.audited', { email: actorEmail }),
            },
            t,
          })}
        />
      </div>
    </ImageCard>
  );
}

// ── CI runner ────────────────────────────────────────────────────────────────

export async function RunnerImageCard({
  row,
  actorEmail,
}: {
  row: RunnerImageRowDTO;
  actorEmail: string;
}) {
  if (row.status === 'not_read')
    return <NotReadCard image="runner" source={row.source} detail={row.detail} />;
  if (row.status === 'unset') return <UnsetCard image="runner" variable={row.variable} />;
  const x = await tools();
  return <RunnerBody row={row} x={x} actorEmail={actorEmail} />;
}

function RunnerBody({
  row,
  x,
  actorEmail,
}: {
  row: RunnerImageReadDTO;
  x: Tools;
  actorEmail: string;
}) {
  const { t } = x;
  const verdict = imageVerdict(row);
  const newestTag = `runner-v${row.newest.version}`;
  const pinnedTag = row.pinned.version ? `runner-v${row.pinned.version}` : null;
  const tileLine = (tag: string | null, b: FleetImageBuildDTO) =>
    [tag ?? shortDigest(b.digest), shortCommit(b.commit), x.date(b.createdAt)]
      .filter(Boolean)
      .join(' · ');
  const gapRest =
    row.runnerCommits === null
      ? ''
      : row.releasesBetween
        ? t('gap.runner', {
            tags: row.releasesBetween.join(', '),
            days: row.daysBehind ?? 0,
            commits: row.runnerCommits,
          })
        : t('gap.runnerNoTags', { days: row.daysBehind ?? 0, commits: row.runnerCommits });
  return (
    <ImageCard
      image="runner"
      t={t}
      verdict={verdict}
      footer={<AuditLine publish={row.publish} x={x} />}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <CompareTile
            label={t('compare.pinned')}
            value={pinnedTag ?? t('compare.unknownRelease')}
            digest={shortDigest(row.pinned.digest)}
            build={row.pinned}
            same={false}
            x={x}
          />
          <CompareTile
            label={t('compare.newestRelease')}
            value={newestTag}
            digest={shortDigest(row.newest.digest)}
            build={row.newest}
            same={!row.behind}
            x={x}
          />
        </div>
        {row.behind ? (
          <GapLine
            t={t}
            strong={
              row.releasesBetween
                ? t('verdict.releasesBehind', { count: row.releasesBetween.length })
                : t('verdict.daysBehind', { count: row.daysBehind ?? 0 })
            }
            rest={gapRest}
            href={row.compareUrl}
          />
        ) : null}
        {row.unreleased.length > 0 ? <Unreleased row={row} newestTag={newestTag} x={x} /> : null}
        <PublishControl
          {...publishProps({
            image: 'runner',
            publish: row.publish,
            enabledNote: t('publish.note.runner', { release: newestTag }),
            idleNote:
              row.publish.blocked === 'release_needed'
                ? t('publish.note.runnerReleaseNeeded')
                : t('publish.note.runnerCurrent'),
            band: (
              <PublishBand
                publish={row.publish}
                workflowLabel={t('workflow.runner')}
                doneText={t('done.pin', {
                  to: pinnedTag ?? shortDigest(row.pinned.digest),
                  digest: shortDigest(row.pinned.digest),
                })}
                x={x}
              />
            ),
            confirm: {
              title: t('confirm.runnerTitle', { release: newestTag }),
              from: tileLine(pinnedTag, row.pinned),
              to: tileLine(newestTag, row.newest),
              body: t.rich('confirm.runnerBody', {
                release: newestTag,
                strong: (c) => <strong className="font-semibold">{c}</strong>,
              }),
              confirmLabel: t('publish.button'),
              audited: t('confirm.audited', { email: actorEmail }),
            },
            t,
          })}
        />
        <AmiBox row={row} x={x} />
      </div>
    </ImageCard>
  );
}

function Unreleased({
  row,
  newestTag,
  x,
}: {
  row: RunnerImageReadDTO;
  newestTag: string;
  x: Tools;
}) {
  const { t } = x;
  return (
    <div className="flex flex-col gap-3" data-element="unreleased">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
          {t('unreleased.title', { release: newestTag })}
        </h4>
        <span className="font-sans text-xs text-(--el-text-secondary)">
          {t('unreleased.count', { count: row.unreleased.length })}
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-(--el-border-soft) rounded-(--radius-card) border border-(--el-border-soft)">
        {row.unreleased.map((change) => (
          <li
            key={change.commit}
            className="flex flex-col gap-1 px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm sm:flex-row sm:items-baseline sm:gap-3"
          >
            <CommitLink commit={change.commit} className="shrink-0 text-xs" />
            <span className="min-w-0 flex-1 text-(--el-text)">{change.subject}</span>
            <span className="shrink-0 text-xs text-(--el-text-secondary)">
              {x.date(change.committedAt)} ·{' '}
              <span className="font-mono">{change.paths.join(', ')}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text)">
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
        <div className="flex min-w-0 flex-col gap-2">
          <span>
            {t.rich('releaseNeeded', {
              tag: row.nextTag,
              strong: (c) => <strong className="font-semibold">{c}</strong>,
              mono: (c) => <span className="font-mono">{c}</span>,
            })}
          </span>
          <span className="flex flex-wrap">
            <code className="rounded-(--radius-control) bg-(--el-muted) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-xs text-(--el-text)">
              {`git tag ${row.nextTag} origin/main && git push origin ${row.nextTag}`}
            </code>
          </span>
        </div>
      </div>
    </div>
  );
}

function AmiBox({ row, x }: { row: RunnerImageReadDTO; x: Tools }) {
  const { t } = x;
  const ami = row.ami;
  if (ami.state === 'unset') {
    return (
      <div
        className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding-12)"
        data-element="ami"
      >
        <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
          {t('ami.title')}
        </h4>
        <p className="font-sans text-xs text-(--el-text-secondary)">{t('ami.unset')}</p>
      </div>
    );
  }
  const pill =
    ami.state === 'current' ? (
      <Pill severity="success">
        <CircleCheck aria-hidden className="h-3 w-3" />
        {t('ami.current')}
      </Pill>
    ) : ami.state === 'stale' ? (
      <Pill severity="warning">
        <TriangleAlert aria-hidden className="h-3 w-3" />
        {t('ami.stale')}
      </Pill>
    ) : (
      <Pill tone="awaiting" aria-label={t('ami.notRead')}>
        <CircleQuestionMark aria-hidden className="h-3 w-3" />
        {t('ami.notRead')}
      </Pill>
    );
  return (
    <div
      className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding-12)"
      data-element="ami"
      data-ami={ami.state}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
          {t('ami.title')}
        </h4>
        <div className="flex flex-wrap gap-1.5">{pill}</div>
      </div>
      {ami.state === 'indeterminate' ? (
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {t('ami.notReadBody', { ami: ami.amiId })}
        </p>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <HardDrive aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" />
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 font-sans text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-(--el-text-secondary)">{t('ami.pinned')}</dt>
              <dd className="break-all font-mono text-(--el-text)">{ami.build.amiId}</dd>
              <dt className="text-(--el-text-secondary)">{t('ami.name')}</dt>
              <dd className="break-all font-mono text-xs text-(--el-text)">
                {ami.build.name ?? '—'}
              </dd>
              <dt className="text-(--el-text-secondary)">{t('ami.builtFrom')}</dt>
              <dd className="text-(--el-text)">
                <span className="font-mono">{shortCommit(ami.build.commit)}</span>
                {amiBuiltAt(ami.build.name) ? ` · ${x.date(amiBuiltAt(ami.build.name))}` : null}
                <span className="mt-0.5 block text-xs text-(--el-text-secondary)">
                  {ami.state === 'stale'
                    ? t('ami.after', { count: ami.unreleased.length })
                    : t('ami.contains')}
                </span>
              </dd>
            </dl>
          </div>
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('ami.note', { account: ami.build.account })}
          </p>
        </>
      )}
    </div>
  );
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

export async function SandboxImageCard({
  row,
  actorEmail,
}: {
  row: SandboxImageRowDTO;
  actorEmail: string;
}) {
  if (row.status === 'not_read')
    return <NotReadCard image="sandbox" source={row.source} detail={row.detail} />;
  if (row.status === 'unset') return <UnsetCard image="sandbox" variable={row.variable} />;
  const x = await tools();
  return <SandboxBody row={row} x={x} actorEmail={actorEmail} />;
}

function SandboxBody({
  row,
  x,
  actorEmail,
}: {
  row: SandboxImageReadDTO;
  x: Tools;
  actorEmail: string;
}) {
  const { t, format } = x;
  const verdict = imageVerdict(row);
  const { release } = row;
  const total = row.profiles.length;
  const missing = row.profiles.filter((p) => !p.published);
  const published = row.profiles.filter((p) => p.published);
  const list = (ids: string[]) => format.list(ids, { type: 'conjunction' });
  const mono = (c: ReactNode) => <span className="font-mono">{c}</span>;
  const strong = (c: ReactNode) => <strong className="font-semibold">{c}</strong>;
  return (
    <ImageCard
      image="sandbox"
      t={t}
      verdict={verdict}
      footer={<AuditLine publish={row.publish} x={x} />}
    >
      <div className="flex flex-col gap-4">
        <p className="font-sans text-sm text-(--el-text)">
          {t.rich('sandbox.newest', {
            release: release.tag,
            date: x.date(release.committedAt),
            commit: shortCommit(release.commit),
            mono,
          })}
        </p>
        <div className="flex flex-col gap-2" data-element="profiles">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
              {t('sandbox.tagsAt', { release: release.tag })}
            </h4>
            <span className="font-sans text-xs text-(--el-text-secondary)">
              {missing.length === 0
                ? t('sandbox.allPublished', { total })
                : t('sandbox.somePublished', {
                    published: published.length,
                    total,
                    missing: missing.length,
                  })}
            </span>
          </div>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {row.profiles.map((p) => (
              <li
                key={p.id}
                data-profile={p.id}
                data-published={p.published ? 'true' : 'false'}
                className={`flex items-center justify-between gap-2 rounded-(--radius-card) border px-(--spacing-control-x) py-(--spacing-control-y) ${
                  p.published ? 'border-(--el-border-soft)' : 'border-(--el-warning)'
                }`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="font-sans text-sm text-(--el-text)">{p.id}</span>
                  <span className="font-mono text-xs text-(--el-text-identifier)">{p.tag}</span>
                </span>
                {p.published ? (
                  <Pill severity="success">
                    <CircleCheck aria-hidden className="h-3 w-3" />
                    {t('sandbox.published')}
                  </Pill>
                ) : (
                  <Pill severity="warning">
                    <TriangleAlert aria-hidden className="h-3 w-3" />
                    {t('sandbox.missing')}
                  </Pill>
                )}
              </li>
            ))}
          </ul>
        </div>
        {missing.length > 0 ? (
          <p className="flex flex-wrap items-start gap-x-2 gap-y-1 font-sans text-sm text-(--el-text)">
            <span className="inline-flex items-start gap-1.5">
              <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
              <span>
                {row.previous
                  ? t.rich('sandbox.incomplete', {
                      profiles: list(missing.map((p) => p.id)),
                      version: release.version,
                      previous: row.previous,
                      strong,
                    })
                  : t.rich('sandbox.incompleteNoPrevious', {
                      profiles: list(missing.map((p) => p.id)),
                      version: release.version,
                      strong,
                    })}
              </span>
            </span>
          </p>
        ) : null}
        {row.liveOlder > 0 ? (
          <p
            className="flex items-start gap-1.5 font-sans text-sm text-(--el-text)"
            data-element="live-agents"
          >
            <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
            <span>{t.rich('sandbox.older', { count: row.liveOlder, strong })}</span>
          </p>
        ) : (
          <p
            className="flex items-start gap-1.5 font-sans text-sm text-(--el-text)"
            data-element="live-agents"
          >
            <CircleCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-success)" />
            <span>{t('sandbox.allCurrent', { version: release.version })}</span>
          </p>
        )}
        <PublishControl
          {...publishProps({
            image: 'sandbox',
            publish: row.publish,
            enabledNote: t('publish.note.sandbox', { release: release.tag, count: missing.length }),
            idleNote:
              row.publish.blocked === 'not_republishable'
                ? t('publish.note.sandboxOld', { release: release.tag })
                : t('publish.note.sandboxCurrent'),
            band: (
              <PublishBand
                publish={row.publish}
                workflowLabel={t('workflow.sandbox', { tag: release.tag })}
                doneText={t('done.sandbox', { version: release.version })}
                x={x}
              />
            ),
            confirm: {
              title: t('confirm.sandboxTitle', { release: release.tag }),
              from: t('confirm.sandboxFrom', {
                published: published.length,
                total,
                version: release.version,
              }),
              to: t('confirm.sandboxFrom', { published: total, total, version: release.version }),
              body:
                published.length > 0
                  ? t.rich('confirm.sandboxBody', {
                      release: release.tag,
                      missing: list(missing.map((p) => p.tag)),
                      published: list(published.map((p) => p.id)),
                      strong,
                    })
                  : t.rich('confirm.sandboxBodyNonePublished', {
                      release: release.tag,
                      missing: list(missing.map((p) => p.tag)),
                      strong,
                    }),
              confirmLabel: t('publish.republish'),
              audited: t('confirm.audited', { email: actorEmail }),
            },
            t,
          })}
        />
      </div>
    </ImageCard>
  );
}
