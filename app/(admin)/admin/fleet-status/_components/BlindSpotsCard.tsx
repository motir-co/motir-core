import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  ServerOff,
  TriangleAlert,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { CiFleetBlindSpotOrgDTO, CiFleetBlindSpotsDTO } from '@/lib/dto/ciFleetBlindSpots';
import { CardHead, InsetState, ago } from '../../monitoring/_components/FleetSection';

/**
 * THE FLEET STATUS PAGE'S CI FLEET BLIND SPOTS CARD (MOTIR-11439; design
 * MOTIR-11467, `platform-admin/design-notes.md` § AMENDMENT 2026-11-16, mock
 * `console--fleet-status--ci-blind-spots.mock.html` Panels 1–9).
 *
 * One card, rendered from the latest reconcile outcome the provision sweep kept
 * (`ciFleetBlindSpotsService.read`): one row per GitHub organisation, its repos
 * with queued fleet jobs but no workflow_job deliveries and its linked repos
 * motir-studio cannot read, and the time that sweep computed them. A server
 * component with no client island.
 *
 * ⚠️ NOTHING READS AS SEEN WITHOUT A READ. A failed org, a failed read, a failed
 * reconcile, not computed and not configured never show _Every repo seen_ or
 * _No blind spots_.
 *
 * ⚠️ READ-ONLY. Installing motir-studio is a manual GitHub step; the reconcile
 * runs on its own schedule. Nothing here writes.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.fleetStatus.blindSpots'>>>;
type FleetT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.fleet'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

/** More repos than this in one org and each group's list takes two columns from `sm`. */
const TWO_COLUMNS_ABOVE = 6;

const PRE_CLASS =
  'overflow-x-auto whitespace-pre-wrap break-all rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-xs text-(--el-text)';

function secondsBetween(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
}

function isBlind(org: CiFleetBlindSpotOrgDTO): boolean {
  return org.undeliveredRepos.length + org.unreadableRepos.length > 0;
}

/** The org row's state: not read, with blind spots, or seen. */
function orgState(org: CiFleetBlindSpotOrgDTO): 'failed' | 'blind' | 'seen' {
  if (org.error !== null) return 'failed';
  return isBlind(org) ? 'blind' : 'seen';
}

function Head({ t, pills }: { t: T; pills: React.ReactNode }) {
  return (
    <CardHead
      level={3}
      icon={<EyeOff className="h-4 w-4" />}
      title={t('card.title')}
      subtitle={t('card.subtitle')}
      pills={pills}
    />
  );
}

function Computed({
  t,
  ft,
  format,
  computedAt,
  now,
}: {
  t: T;
  ft: FleetT;
  format: Format;
  computedAt: string;
  now: Date;
}) {
  return (
    <p
      data-element="computed"
      className="flex items-start gap-1 font-sans text-xs text-(--el-text-secondary)"
    >
      <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
      <span>
        {t('computed', {
          time: format.dateTime(new Date(computedAt), { dateStyle: 'medium', timeStyle: 'short' }),
          age: ago(ft, secondsBetween(computedAt, now)),
        })}
      </span>
    </p>
  );
}

function RepoLink({ repo, t }: { repo: string; t: T }) {
  return (
    <a
      href={`https://github.com/${repo}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('repo.link', { repo })}
      className="inline-flex items-center gap-1 break-all font-mono text-xs text-(--el-link) underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
    >
      {repo}
      <ExternalLink aria-hidden className="h-3 w-3 shrink-0" />
    </a>
  );
}

function GroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <h5 className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </h5>
  );
}

function OrgPills({ org, t }: { org: CiFleetBlindSpotOrgDTO; t: T }) {
  if (org.error !== null) {
    return (
      <Pill tone="awaiting" data-flag="not-read">
        <CircleQuestionMark aria-hidden className="h-3 w-3" />
        {t('pill.notRead')}
      </Pill>
    );
  }
  if (!isBlind(org)) {
    return (
      <Pill severity="success" data-flag="seen">
        <CircleCheck aria-hidden className="h-3 w-3" />
        {t('pill.allSeen')}
      </Pill>
    );
  }
  return (
    <>
      {org.undeliveredRepos.length > 0 ? (
        <Pill severity="warning" data-flag="undelivered">
          <TriangleAlert aria-hidden className="h-3 w-3" />
          {t('org.undeliveredCount', { count: org.undeliveredRepos.length })}
        </Pill>
      ) : null}
      {org.unreadableRepos.length > 0 ? (
        <Pill severity="warning" data-flag="unreadable">
          <TriangleAlert aria-hidden className="h-3 w-3" />
          {t('org.unreadableCount', { count: org.unreadableRepos.length })}
        </Pill>
      ) : null}
    </>
  );
}

function OrgBody({ org, t }: { org: CiFleetBlindSpotOrgDTO; t: T }) {
  if (org.error !== null) {
    return (
      <div role="alert" data-element="org-error" className="flex flex-col gap-2">
        <p className="flex items-start gap-1.5 font-sans text-sm text-(--el-text)">
          <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
          <span>
            <strong className="font-semibold">{t('orgError.title')}</strong> {t('orgError.body')}
          </span>
        </p>
        <pre className={PRE_CLASS}>{org.error}</pre>
      </div>
    );
  }
  if (!isBlind(org)) {
    return <p className="font-sans text-xs text-(--el-text-secondary)">{t('org.seen')}</p>;
  }
  const columns =
    org.undeliveredRepos.length + org.unreadableRepos.length > TWO_COLUMNS_ABOVE
      ? 'sm:grid-cols-2'
      : '';
  return (
    <>
      {org.undeliveredRepos.length > 0 ? (
        <div data-element="undelivered" className="flex flex-col gap-2">
          <GroupTitle>{t('undelivered.title')}</GroupTitle>
          <ul className={`grid gap-x-6 gap-y-2 ${columns}`}>
            {org.undeliveredRepos.map((repo) => (
              <li key={repo} className="flex min-w-0 flex-col gap-0.5">
                <RepoLink repo={repo} t={t} />
                <span className="font-sans text-xs text-(--el-text-secondary)">
                  {t('undelivered.hint')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {org.unreadableRepos.length > 0 ? (
        <div data-element="unreadable" className="flex flex-col gap-2">
          <GroupTitle>{t('unreadable.title')}</GroupTitle>
          <p className="max-w-prose font-sans text-xs text-(--el-text-secondary)">
            {t('unreadable.body')}
          </p>
          <ul className={`grid gap-x-6 gap-y-1.5 ${columns}`}>
            {org.unreadableRepos.map((repo) => (
              <li key={repo} className="min-w-0">
                <RepoLink repo={repo} t={t} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

const RAIL: Record<ReturnType<typeof orgState>, string> = {
  failed: 'border-l-(--el-danger)',
  blind: 'border-l-(--el-warning)',
  seen: 'border-l-transparent',
};

function OrgRow({ org, t }: { org: CiFleetBlindSpotOrgDTO; t: T }) {
  const state = orgState(org);
  return (
    <li
      data-org={org.org}
      data-state={state}
      className={`flex flex-col gap-3 border-l-[3px] py-3 pl-3 ${RAIL[state]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-mono text-sm font-semibold text-(--el-text)">{org.org}</h4>
        <div className="flex flex-wrap justify-end gap-1.5">
          <OrgPills org={org} t={t} />
        </div>
      </div>
      <OrgBody org={org} t={t} />
    </li>
  );
}

function HeaderPills({ orgs, t }: { orgs: CiFleetBlindSpotOrgDTO[]; t: T }) {
  const notRead = orgs.filter((o) => o.error !== null).length;
  const blind = orgs.filter((o) => o.error === null && isBlind(o)).length;
  if (notRead === 0 && blind === 0) {
    return (
      <Pill severity="success" data-flag="all-seen">
        <CircleCheck aria-hidden className="h-3 w-3" />
        {t('pill.allSeen')}
      </Pill>
    );
  }
  return (
    <>
      {notRead > 0 ? (
        <Pill tone="awaiting" data-flag="orgs-not-read">
          <CircleQuestionMark aria-hidden className="h-3 w-3" />
          {t('pill.orgsNotRead', { count: notRead })}
        </Pill>
      ) : null}
      {blind > 0 ? (
        <Pill severity="warning" data-flag="orgs-blind">
          <TriangleAlert aria-hidden className="h-3 w-3" />
          {t('pill.orgs', { count: blind })}
        </Pill>
      ) : null}
    </>
  );
}

function OrgList({ orgs, t }: { orgs: CiFleetBlindSpotOrgDTO[]; t: T }) {
  if (orgs.length === 0) {
    return (
      <InsetState level={4} icon={<Eye className="h-5 w-5" />} title={t('empty.title')}>
        {t('empty.noOrgs')}
      </InsetState>
    );
  }
  if (orgs.every((o) => o.error === null && !isBlind(o))) {
    return (
      <InsetState level={4} icon={<Eye className="h-5 w-5" />} title={t('empty.title')}>
        {t('empty.body', { count: orgs.length })}
      </InsetState>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-(--el-border-soft)">
      {orgs.map((org) => (
        <OrgRow key={org.org} org={org} t={t} />
      ))}
    </ul>
  );
}

/** The card for a state with nothing read: the header alone and one inset state. */
function StateCard({
  t,
  state,
  children,
}: {
  t: T;
  state: 'failed' | 'not-computed' | 'not-configured';
  children: React.ReactNode;
}) {
  return (
    <Card data-element="blind-spots" data-state={state} header={<Head t={t} pills={null} />}>
      {children}
    </Card>
  );
}

function FleetSettingsLink(chunks: React.ReactNode) {
  return (
    <Link href="/admin/fleet-settings" className="text-(--el-link) underline underline-offset-2">
      {chunks}
    </Link>
  );
}

export async function BlindSpotsCard({ block, now }: { block: CiFleetBlindSpotsDTO; now: Date }) {
  const t = await getTranslations('platformAdmin.fleetStatus.blindSpots');
  const ft = await getTranslations('platformAdmin.monitoring.fleet');
  const format = await getFormatter();

  if (block.status === 'unavailable') {
    return (
      <StateCard t={t} state="failed">
        <InsetState
          level={4}
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('error.title')}
        >
          {t('error.body')}
        </InsetState>
      </StateCard>
    );
  }
  if (block.status === 'notConfigured') {
    return (
      <StateCard t={t} state="not-configured">
        <InsetState
          level={4}
          icon={<ServerOff className="h-5 w-5" />}
          title={t('notConfigured.title')}
        >
          {t.rich('notConfigured.body', { link: FleetSettingsLink })}
        </InsetState>
      </StateCard>
    );
  }
  if (block.status === 'notComputed') {
    return (
      <StateCard t={t} state="not-computed">
        <InsetState level={4} icon={<Clock className="h-5 w-5" />} title={t('notComputed.title')}>
          {t('notComputed.body')}
        </InsetState>
      </StateCard>
    );
  }

  const footer = <Computed t={t} ft={ft} format={format} computedAt={block.computedAt} now={now} />;

  if (block.status === 'reconcileFailed') {
    return (
      <Card
        data-element="blind-spots"
        data-state="reconcile-failed"
        header={<Head t={t} pills={null} />}
        footer={footer}
      >
        <div className="flex flex-col gap-3">
          <InsetState
            level={4}
            tone="error"
            icon={<TriangleAlert className="h-5 w-5" />}
            title={t('reconcileError.title')}
          >
            {t('reconcileError.body')}
          </InsetState>
          <pre className={PRE_CLASS}>{block.error}</pre>
        </div>
      </Card>
    );
  }

  return (
    <Card
      data-element="blind-spots"
      data-state="read"
      header={<Head t={t} pills={<HeaderPills orgs={block.orgs} t={t} />} />}
      footer={footer}
    >
      <OrgList orgs={block.orgs} t={t} />
    </Card>
  );
}
