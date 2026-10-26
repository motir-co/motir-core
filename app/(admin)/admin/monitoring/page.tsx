import type { Metadata } from 'next';
import { getFormatter, getTranslations } from 'next-intl/server';
import {
  AlertTriangle,
  Cloud,
  Database,
  ExternalLink,
  HeartPulse,
  Network,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type {
  PlatformSignalDTO,
  PlatformSignalId,
  PlatformSignalState,
} from '@/lib/dto/platformHealth';
import { requirePlatformStaffPage } from '@/lib/platform/pageGate';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { platformFleetMonitorService } from '@/lib/services/platformFleetMonitorService';
import { platformIndexAllowanceService } from '@/lib/services/platformIndexAllowanceService';
import { platformFleetPoolsService } from '@/lib/services/platformFleetPoolsService';
import { PLATFORM_POOL_KIND_ORDER } from '@/lib/dto/platformFleetPools';
import { FleetSection, type FleetRead } from './_components/FleetSection';
import { IndexAllowanceSection } from './_components/IndexAllowanceSection';
import { PoolsSection, poolEventsParam, poolRequestsParam } from './_components/PoolsSection';

/**
 * The system-health board — design `platform-admin/design-notes.md` **Panel 8**
 * (card MOTIR-1167) and its Story 10.2 delta (MOTIR-737). It occupies the
 * left-nav **Operations → Monitoring** row, and Story 10.2 extends it IN PLACE
 * rather than replacing it: the Errors card reads Motir's own Sentry count
 * (MOTIR-740), the Hosting card counts motir-core's machines and releases
 * (MOTIR-7332), and a seventh card probes motir-gateway (MOTIR-742).
 *
 * ⚠️ READ AND LINK, NEVER REMEDIATE. Seven cards, each a state and a link-out to
 * the provider's own dashboard. There is no replay button, no redeploy, no
 * cancel, no trace timeline and no log search — Story 10.2's
 * *integrate-not-rebuild* stance, and it is why this page renders nothing
 * interactive.
 *
 * ⚠️ AND NO FORK OF `/settings/workspace/jobs`. A per-WORKSPACE view of this
 * same job data already ships there (`JobsDashboard.tsx`, tabs `runs | dlq |
 * system`). This page reads the platform-wide equivalent through its own
 * staff-gated service; it does not copy that component and does not widen it in
 * place. The asset and the card both say so.
 *
 * A Server Component with no client island: every value is read once, on load,
 * which is what the subtitle promises. Adding a poll would put a cross-tenant
 * audited read on a timer.
 */

export const metadata: Metadata = {
  // No description, and nothing here names what the surface DOES — the same
  // reasoning as the console landing page's: the 404 posture is about the
  // route's existence never being confirmable.
  title: 'System health',
};

/**
 * Never cached. A health board rendered from a cached read is a board that can
 * report a database as reachable after it has gone — which is the same class of
 * lie as an unreachable probe rendering a zero.
 */
export const dynamic = 'force-dynamic';

/** The kills list's reach — the design titles it "last 24 hours". */
const FLEET_KILLS_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Settle one Fleet read so its failure stays INSIDE its own card (design
 * MOTIR-7314 frames 5 and 8): a throw here must not reject the page's
 * `Promise.all` and take Panel 8 and the Index allowance down with it. The
 * error is logged, never rendered — the card says, in words, that nothing loaded.
 */
async function settleFleetRead<T>(label: string, read: Promise<T>): Promise<FleetRead<T>> {
  try {
    return { status: 'ok', data: await read };
  } catch (err) {
    console.error(`[admin/monitoring] the fleet ${label} read failed`, {
      detail: err instanceof Error ? err.message.slice(0, 300) : 'unknown',
    });
    return { status: 'failed' };
  }
}

/** A `?fleetPage=` / `?killsPage=` value as a page number; anything else is page 1. */
function pageParam(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export default async function AdminMonitoringPage({
  searchParams,
}: {
  searchParams: Promise<{
    reason?: string;
    q?: string;
    page?: string;
    fleetPage?: string;
    killsPage?: string;
    // The Pools section's pagers: one request list and one event list per kind.
    [poolsPage: string]: string | undefined;
  }>;
}) {
  const principal = await requirePlatformStaffPage('support');
  const t = await getTranslations('platformAdmin');
  const format = await getFormatter();
  const params = await searchParams;
  const now = new Date();
  const [health, indexAllowance, fleetOrgs, fleetKills, pools] = await Promise.all([
    platformHealthService.read(principal),
    // Monitoring · Index allowance (MOTIR-4595, design Panel 13) — internal
    // accounting only; Motir does not charge for code indexing.
    platformIndexAllowanceService.read(principal, params),
    // Monitoring · Fleet (MOTIR-7319, design MOTIR-7314) — two reads, each
    // settled on its own so each card owns its own failure. Paged by their own
    // params so neither resets the Stopped list's `page`.
    settleFleetRead(
      'organisations',
      platformFleetMonitorService.listRunningOrgs(
        principal,
        { page: pageParam(params.fleetPage) },
        now,
      ),
    ),
    settleFleetRead(
      'kills',
      platformFleetMonitorService.listKills(
        principal,
        {
          since: new Date(now.getTime() - FLEET_KILLS_WINDOW_MS),
          page: pageParam(params.killsPage),
        },
        now,
      ),
    ),
    // Monitoring · Pools (MOTIR-9563, design MOTIR-9561) — settled on its own like
    // the Fleet reads, so a throw renders one error inside the Pools section.
    settleFleetRead('pools', platformFleetPoolsService.listPools(principal, now)),
  ]);

  // Every list's page, carried through every pager link so paging one never resets
  // another. The Pools pagers are validated like the Fleet ones.
  const poolsPages: Record<string, string | undefined> = {};
  for (const kind of PLATFORM_POOL_KIND_ORDER) {
    for (const key of [poolRequestsParam(kind), poolEventsParam(kind)]) {
      const page = pageParam(params[key]);
      poolsPages[key] = page === undefined ? undefined : String(page);
    }
  }
  const listQuery = {
    reason: params.reason,
    q: params.q,
    page: params.page,
    fleetPage: params.fleetPage,
    killsPage: params.killsPage,
    ...poolsPages,
  };

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('monitoring.breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('monitoring.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('monitoring.subtitle')}
        </p>
      </div>

      {/* One polite announcement once the board has loaded: how many cards need
          a look. The chips say it per card; this says it once, so a screen-reader
          user does not have to visit seven cards to learn the board is green. */}
      <p role="status" aria-live="polite" className="sr-only">
        {t('monitoring.announce', {
          count: health.signals.filter((signal) => signal.state !== 'healthy').length,
          total: health.signals.length,
        })}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {health.signals.map((signal) => (
          <SignalCard key={signal.id} signal={signal} />
        ))}
      </div>

      <Card
        header={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="font-sans text-sm font-semibold text-(--el-text)">
                {t('monitoring.overdue.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('monitoring.overdue.subtitle')}
              </p>
            </div>
            <Pill severity={health.overdueTotal > 0 ? 'warning' : 'success'}>
              {t('monitoring.overdue.count', { n: health.overdueTotal })}
            </Pill>
          </div>
        }
        footer={
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {t('monitoring.overdue.foot', {
              n: health.overdue.length,
              total: health.overdueTotal,
              checked: health.schedulesChecked,
            })}
          </p>
        }
      >
        {health.overdue.length === 0 ? (
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {t('monitoring.overdue.empty')}
          </p>
        ) : (
          // The wide table scrolls INSIDE its own box; the page body never
          // scrolls sideways.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse font-sans text-sm">
              <thead>
                <tr className="border-b border-(--el-border) text-left">
                  <Th>{t('monitoring.overdue.colJob')}</Th>
                  <Th>{t('monitoring.overdue.colCron')}</Th>
                  <Th>{t('monitoring.overdue.colLastFired')}</Th>
                  <Th>{t('monitoring.overdue.colExpected')}</Th>
                </tr>
              </thead>
              <tbody>
                {health.overdue.map((row) => (
                  <tr key={row.functionId} className="border-b border-(--el-border-soft)">
                    <Td className="font-mono text-xs text-(--el-text)">{row.functionId}</Td>
                    <Td className="font-mono text-xs text-(--el-text-secondary)">{row.cron}</Td>
                    <Td className="text-(--el-text-secondary)">
                      {/* ⚠️ "Never" is a WORD, not a dash. This column answers
                          "when did this cron last fire?", and a job that has
                          never fired at all is the loudest reading on the
                          board — an em-dash would render it as a missing value
                          rather than as the finding it is. */}
                      {row.lastRunAt
                        ? format.dateTime(new Date(row.lastRunAt))
                        : t('monitoring.overdue.never')}
                    </Td>
                    <Td className="text-(--el-text-secondary)">
                      {row.expectedAt ? format.dateTime(new Date(row.expectedAt)) : '—'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <IndexAllowanceSection data={indexAllowance} />

      <FleetSection orgs={fleetOrgs} kills={fleetKills} now={now} query={listQuery} />

      <PoolsSection read={pools} query={listQuery} now={now} />
    </div>
  );
}

/**
 * One signal card.
 *
 * ⚠️ THE THREE STATES ARE RENDERED IN WORDS AND A GLYPH, NEVER IN COLOUR ALONE.
 * `Pill severity` carries the hue in the tint BACKGROUND with `--el-text-strong`
 * ink (finding #35, AA in both themes), the chip's TEXT names the state, and the
 * icon tile changes glyph as well as tone. A board whose only difference between
 * "healthy" and "can't reach" is a hue is unreadable to a colour-blind operator
 * and invisible in a screenshot.
 */
function SignalCard({ signal }: { signal: PlatformSignalDTO }) {
  const Icon = SIGNAL_ICONS[signal.id];
  const tone = STATE_TONE[signal.state];

  return (
    <Card
      header={
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className={`inline-flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) ${tone.tile}`}
            >
              <Icon className="h-4 w-4" />
            </span>
            <SignalTitle id={signal.id} />
          </span>
          <SignalState state={signal.state} />
        </div>
      }
    >
      <SignalBody signal={signal} />
    </Card>
  );
}

async function SignalTitle({ id }: { id: PlatformSignalId }) {
  const t = await getTranslations('platformAdmin');
  return (
    <span className="min-w-0 truncate font-sans text-sm font-medium text-(--el-text)">
      {t(`monitoring.signal.${id}.title`)}
    </span>
  );
}

async function SignalState({ state }: { state: PlatformSignalState }) {
  const t = await getTranslations('platformAdmin');
  return (
    <Pill severity={STATE_TONE[state].severity} className="shrink-0">
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATE_TONE[state].dot}`} />
      {t(`monitoring.state.${state}`)}
    </Pill>
  );
}

/**
 * The card's headline and body copy.
 *
 * ⚠️ AN UNREACHABLE SIGNAL RENDERS NO NUMBER — it renders the reason, in words.
 * The service guarantees an `unreachable` signal carries no measurement, and
 * this is the other half of that guarantee: there is no `?? 0`, no `—` standing
 * in for a count, and no headline slot a missing value could fall through into
 * looking like zero. The design's own instance is the Errors card, which says
 * *"this is not an error count of zero"* on screen.
 */
async function SignalBody({ signal }: { signal: PlatformSignalDTO }) {
  const t = await getTranslations('platformAdmin');
  const format = await getFormatter();
  // ⚠️ THE DTO CARRIES AN ISO STRING AND THE SURFACE RENDERS A DATE, and the
  // conversion belongs HERE rather than in the service. `format.dateTime` is
  // locale-aware, so the same reading renders differently for the `en` and `zh`
  // catalogues — a service that formatted it would have to know which one it was
  // rendering into. It is also why the ISO string crosses the boundary at all:
  // `lib/dto/platform.ts`'s own note, one tier over, is that dates cross as ISO
  // so the JSON shape is stable.
  //
  // A Server Component, so `format.dateTime` is deterministic — there is no
  // second render to disagree with the first (the hydration hazard that makes
  // `relativeTime` a client-side trap does not arise).
  //
  // `since` (the Gateway card's up-since, MOTIR-742) is the same kind of reading
  // and takes the same conversion.
  const values: Record<string, string | number> = { ...signal.values };
  for (const field of ['ranAt', 'since']) {
    const iso = signal.values[field];
    if (typeof iso === 'string') values[field] = format.dateTime(new Date(iso));
  }
  // A DEGRADED card says so in words where its copy carries a degraded sentence
  // (the Gateway's "Slow · {ms} ms") — otherwise a slow gateway would headline
  // "Reachable" under an amber chip. Cards without one keep their single string.
  // A card with more than one degraded arm (Hosting's `shortGroup` /
  // `mixedReleases`, MOTIR-7332) keys its detail by the reason the DTO carries.
  const reason = String(signal.values['reason']);
  const base = `monitoring.signal.${signal.id}`;
  const degraded = (suffix: 'value' | 'detail') => {
    const own = `${base}.degraded${suffix === 'value' ? 'Value' : 'Detail'}`;
    if (signal.state !== 'degraded') return `${base}.${suffix}`;
    if (t.has(`${own}.${reason}`)) return `${own}.${reason}`;
    return t.has(own) ? own : `${base}.${suffix}`;
  };
  const key = signal.state === 'unreachable' ? `${base}.unreachable.${reason}` : degraded('value');
  const detailKey =
    signal.state === 'unreachable' ? `${base}.unreachableDetail.${reason}` : degraded('detail');
  // The Hosting headline names its process groups, and a SHORT group is set in
  // weight, not in a hue (design § colour roles): the chip already carries the
  // warning tone, and a second colour on one word would read as a second signal.
  const short = reason === 'shortGroup' ? String(signal.values['group']) : null;
  const group = (name: string) =>
    function GroupChunk(chunks: React.ReactNode) {
      return <span className={short === name ? 'font-semibold' : undefined}>{chunks}</span>;
    };

  return (
    <div className="flex flex-col gap-2">
      <p className="font-sans text-lg text-(--el-text)">
        {t.rich(key, { ...values, appGroup: group('app'), workerGroup: group('worker') })}
      </p>
      <p className="font-sans text-xs text-(--el-text-secondary)">{t(detailKey, values)}</p>
      {signal.linkOut ? (
        <a
          href={signal.linkOut}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
        >
          {t(`monitoring.signal.${signal.id}.linkOut`)}
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="py-2 pr-4 font-sans text-xs font-medium uppercase tracking-wide text-(--el-text-secondary)">
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 pr-4 align-top ${className}`}>{children}</td>;
}

/**
 * The icon per signal.
 *
 * ⚠️ NOT the entity tints the console's `.ico.ent-*` tiles use — those encode
 * org / workspace / project / user IDENTITY, and borrowing one for a health card
 * would say "this card is about users" in a system where that tint means exactly
 * that. The asset says so explicitly; these tiles take the semantic health tones
 * below instead.
 */
const SIGNAL_ICONS: Record<PlatformSignalId, typeof Database> = {
  database: Database,
  hosting: Cloud,
  gateway: Network,
  schedules: Timer,
  failedJobs: AlertTriangle,
  errors: ShieldAlert,
  lastHealthCheck: HeartPulse,
};

/**
 * The three tones, as design-system tokens.
 *
 * The pill takes `Pill`'s own `severity` variant rather than a hand-rolled tint,
 * so the AA-safe hue-in-the-background recipe comes from the shipped primitive.
 * The dot and the icon tile use the saturated `--el-success` / `--el-warning` /
 * `--el-danger` inks, which are safe there because neither carries text.
 */
const STATE_TONE: Record<
  PlatformSignalState,
  { severity: 'success' | 'warning' | 'danger'; dot: string; tile: string }
> = {
  healthy: {
    severity: 'success',
    dot: 'bg-(--el-success)',
    tile: 'bg-(--el-tint-mint) text-(--el-success)',
  },
  degraded: {
    severity: 'warning',
    dot: 'bg-(--el-warning)',
    tile: 'bg-(--el-tint-peach) text-(--el-warning)',
  },
  unreachable: {
    severity: 'danger',
    dot: 'bg-(--el-danger)',
    tile: 'bg-(--el-tint-rose) text-(--el-danger)',
  },
};
