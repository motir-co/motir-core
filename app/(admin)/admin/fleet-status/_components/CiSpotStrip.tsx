import type { getFormatter, getTranslations } from 'next-intl/server';
import { CircleHelp, CloudLightning, Power, TriangleAlert } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type {
  CiSpotBlockDTO,
  CiSpotCountsDTO,
  CiSpotSettingReadDTO,
} from '@/lib/dto/fleetStatusPools';
import { InsetState, MiniStat, Sub } from '../../monitoring/_components/FleetSection';

/**
 * THE CI SPOT STRIP (MOTIR-11729; design MOTIR-11726 `platform-admin/design-notes.md`
 * § AMENDMENT 2026-11-18 — Fleet status: CI Spot use, mock
 * `console--fleet-status--ci-spot.mock.html`).
 *
 * A full-width row under the CI runner pool row of both Pools cards: the Spot
 * status pill, the Spot share bar, the Interruptions figure, the All-fell-back
 * note and the CI Spot read-failed inset — and, on the add-shard card, the two
 * Account Spot columns of the disclosed account table.
 *
 * ⚠️ UNKNOWN, NONE AND ZERO STAY THREE THINGS DOWN TO THE TEXT. A failed read
 * draws the inset and no number at all; no launches draws a sentence, no bar
 * and no percentage, and the Interruptions figure reads _None_; a read zero
 * reads `0`. The setting is its own read: its pill shows whatever the counts did.
 *
 * ⚠️ THE SPOT SHARE IS OVER RECORDED LAUNCHES ONLY (design rule 1): a runner
 * whose capacity was not recorded is never counted as on-demand — it is its own
 * bar segment, its own legend entry and its own sentence.
 *
 * Server-rendered and settled with its pool card, behind that card's own
 * `<Suspense>`: the strip adds no boundary of its own.
 */

type T = Awaited<ReturnType<typeof getTranslations<'platformAdmin.fleetStatus'>>>;
type MonT = Awaited<ReturnType<typeof getTranslations<'platformAdmin.monitoring.pools'>>>;
type Format = Awaited<ReturnType<typeof getFormatter>>;

/** Which card the strip sits on: the all-fell-back sentence differs. */
export type CiSpotPlacement = 'shard' | 'install';

/** Whole percent of Spot among the RECORDED launches; null when none was recorded. */
export function spotPercent(counts: CiSpotCountsDTO): number | null {
  const recorded = counts.spot + counts.onDemand;
  return recorded > 0 ? Math.round((counts.spot * 100) / recorded) : null;
}

function SettingPill({ setting, t }: { setting: CiSpotSettingReadDTO; t: T }) {
  if (setting === 'on') {
    return (
      <Pill severity="info" data-element="spot-status-pill" data-setting="on">
        <CloudLightning aria-hidden className="h-3 w-3 shrink-0" />
        {t('pools.ciSpot.setting.on')}
      </Pill>
    );
  }
  if (setting === 'off') {
    return (
      <Pill tone="neutral" data-element="spot-status-pill" data-setting="off">
        <Power aria-hidden className="h-3 w-3 shrink-0" />
        {t('pools.ciSpot.setting.off')}
      </Pill>
    );
  }
  return (
    <Pill
      tone="awaiting"
      data-element="spot-status-pill"
      data-setting="not-read"
      aria-label={t('pools.ciSpot.setting.notReadLabel')}
    >
      <CircleHelp aria-hidden className="h-3 w-3 shrink-0" />
      {t('pools.ciSpot.setting.notRead')}
    </Pill>
  );
}

function ShareBar({ counts, t, format }: { counts: CiSpotCountsDTO; t: T; format: Format }) {
  const n = (v: number) => format.number(v);
  const percent = spotPercent(counts);
  const recorded = counts.spot + counts.onDemand;
  const segments = [
    { key: 'spot', count: counts.spot, fill: 'bg-(--el-accent)' },
    { key: 'on-demand', count: counts.onDemand, fill: 'bg-(--el-info)' },
    { key: 'not-recorded', count: counts.notRecorded, fill: 'bg-(--el-border-strong)' },
  ].filter((s) => s.count > 0);
  const label =
    counts.notRecorded > 0
      ? t('pools.ciSpot.barLabelNotRecorded', {
          spot: n(counts.spot),
          onDemand: n(counts.onDemand),
          notRecorded: n(counts.notRecorded),
          total: n(counts.launched),
        })
      : t('pools.ciSpot.barLabel', {
          spot: n(counts.spot),
          onDemand: n(counts.onDemand),
          total: n(counts.launched),
        });

  return (
    <div className="flex flex-col gap-2" data-element="spot-share-bar">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-serif text-xl text-(--el-text)" data-element="spot-percent">
          {percent === null
            ? t('pools.ciSpot.share.noPercent')
            : t('pools.ciSpot.share.headline', { percent: n(percent) })}
        </span>
        <span className="font-sans text-xs text-(--el-text-secondary)">
          {counts.notRecorded > 0
            ? t('pools.ciSpot.share.ofRecorded', {
                recorded: n(recorded),
                total: n(counts.launched),
              })
            : t('pools.ciSpot.share.of', { count: counts.launched })}
        </span>
      </p>
      <div
        role="img"
        aria-label={label}
        className="flex h-2 w-full gap-px overflow-hidden rounded-(--radius-badge) bg-(--el-surface)"
      >
        {segments.map((s) => (
          <span
            key={s.key}
            data-segment={s.key}
            className={`block h-full ${s.fill}`}
            style={{ width: `${(s.count * 100) / counts.launched}%` }}
          />
        ))}
      </div>
      <ul
        aria-hidden
        className="flex flex-wrap gap-x-4 gap-y-1 font-sans text-xs text-(--el-text)"
        data-element="spot-legend"
      >
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-(--el-accent)" />
          {t('pools.ciSpot.legend.spot', { count: n(counts.spot) })}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-(--el-info)" />
          {t('pools.ciSpot.legend.onDemand', { count: n(counts.onDemand) })}
        </li>
        {counts.notRecorded > 0 ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full border border-(--el-text-secondary) bg-(--el-border-strong)" />
            {t('pools.ciSpot.legend.notRecorded', { count: n(counts.notRecorded) })}
          </li>
        ) : null}
      </ul>
      {counts.notRecorded > 0 ? (
        <p
          className="font-sans text-xs text-(--el-text-secondary)"
          data-element="not-recorded-note"
        >
          {t('pools.ciSpot.notRecordedNote', { count: counts.notRecorded })}
        </p>
      ) : null}
    </div>
  );
}

function stripState(block: CiSpotBlockDTO): 'ok' | 'all-fell-back' | 'none' | 'failed' {
  if (block.status === 'unavailable') return 'failed';
  if (block.counts.launched === 0) return 'none';
  return block.allFellBack ? 'all-fell-back' : 'ok';
}

/**
 * The CI Spot strip in its own table row, one cell spanning the table.
 * `idPrefix` names the section and its heading (`<idPrefix>-ci-spot`).
 */
export function CiSpotStripRow({
  block,
  placement,
  idPrefix,
  colSpan,
  t,
  format,
}: {
  block: CiSpotBlockDTO;
  placement: CiSpotPlacement;
  idPrefix: string;
  colSpan: number;
  t: T;
  format: Format;
}) {
  const state = stripState(block);
  const sectionId = `${idPrefix}-ci-spot`;
  const headingId = `${sectionId}-heading`;
  const setting = block.setting;

  return (
    <tr data-element="ci-spot-strip-row" className="border-b border-(--el-border-soft)">
      <td colSpan={colSpan} className="py-2 pr-3 pl-3">
        <section
          id={sectionId}
          aria-labelledby={headingId}
          data-element="ci-spot-strip"
          data-state={state}
          className="sticky left-3 flex max-w-[calc(100cqw-1.5rem)] flex-col gap-3 overflow-hidden rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-page-bg) p-(--spacing-card-padding-12)"
        >
          {state === 'all-fell-back' ? (
            <span
              aria-hidden
              data-element="ci-spot-warning-rail"
              className="absolute inset-y-0 left-0 w-[3px] bg-(--el-warning)"
            />
          ) : null}
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <SettingPill setting={setting} t={t} />
              <h4
                id={headingId}
                className="font-sans text-xs font-semibold uppercase tracking-wide text-(--el-text-secondary)"
              >
                {t('pools.ciSpot.heading')}
              </h4>
            </div>
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('pools.ciSpot.scope')}
            </p>
            {setting === 'off' ? (
              <p
                className="font-sans text-xs text-(--el-text-secondary)"
                data-element="spot-off-note"
              >
                {t('pools.ciSpot.offNote')}
              </p>
            ) : setting === 'notRead' ? (
              <p
                className="font-sans text-xs text-(--el-text-secondary)"
                data-element="spot-not-read-note"
              >
                {t('pools.ciSpot.notReadNote')}
              </p>
            ) : null}
          </div>
          <StripBody block={block} placement={placement} t={t} format={format} />
        </section>
      </td>
    </tr>
  );
}

function StripBody({
  block,
  placement,
  t,
  format,
}: {
  block: CiSpotBlockDTO;
  placement: CiSpotPlacement;
  t: T;
  format: Format;
}) {
  if (block.status === 'unavailable') {
    // No percentage, bar, legend or figure: a failed read is not a zero.
    return (
      <div data-element="ci-spot-read-failed">
        <InsetState
          level={4}
          tone="error"
          icon={<TriangleAlert className="h-5 w-5" />}
          title={t('pools.ciSpot.error.title')}
        >
          {t('pools.ciSpot.error.body')}
        </InsetState>
      </div>
    );
  }

  const { counts } = block;
  if (counts.launched === 0) {
    return (
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
        <p className="font-sans text-sm text-(--el-text)" data-element="ci-spot-none">
          {t('pools.ciSpot.none')}
        </p>
        <div data-element="interruptions-figure">
          <MiniStat
            value={t('pools.ciSpot.interrupted.none')}
            label={t('pools.ciSpot.interrupted.label')}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-start">
        <ShareBar counts={counts} t={t} format={format} />
        <div data-element="interruptions-figure">
          <MiniStat
            value={format.number(counts.interrupted)}
            label={t('pools.ciSpot.interrupted.label')}
            sub={t('pools.ciSpot.interrupted.sub')}
          />
        </div>
      </div>
      {block.allFellBack ? (
        <p
          className="flex items-start gap-2 font-sans text-sm text-(--el-text)"
          data-element="all-fell-back-note"
        >
          <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
          <span>
            {placement === 'install'
              ? t('pools.ciSpot.allFellBackInstall', { count: format.number(counts.launched) })
              : t('pools.ciSpot.allFellBack', { count: format.number(counts.launched) })}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** A cell with no launch to show: the dash for the eye, the words for a reader. */
function NoLaunch({ t }: { t: T }) {
  return (
    <span className="text-(--el-text-secondary)">
      <span aria-hidden>—</span>
      <span className="sr-only">{t('pools.ciSpot.accounts.none')}</span>
    </span>
  );
}

function NotAvailable({ mon }: { mon: MonT }) {
  return <span className="italic text-(--el-text-secondary)">{mon('notAvailable')}</span>;
}

/**
 * The two Account Spot columns' cells for one account of the CI runner pool.
 * `undefined` counts = the pool's read failed (_Not available_); `null` = the
 * account launched nothing in the window (a dash).
 */
export function AccountSpotCells({
  counts,
  t,
  mon,
  format,
}: {
  counts: CiSpotCountsDTO | null | undefined;
  t: T;
  mon: MonT;
  format: Format;
}) {
  if (counts === undefined) {
    return (
      <>
        <td className="py-2 pr-3 align-top" data-element="account-spot">
          <NotAvailable mon={mon} />
        </td>
        <td className="py-2 pr-3 align-top" data-element="account-interrupted">
          <NotAvailable mon={mon} />
        </td>
      </>
    );
  }
  if (counts === null) {
    return (
      <>
        <td className="py-2 pr-3 align-top" data-element="account-spot">
          <NoLaunch t={t} />
        </td>
        <td className="py-2 pr-3 align-top" data-element="account-interrupted">
          <NoLaunch t={t} />
        </td>
      </>
    );
  }
  const percent = spotPercent(counts);
  return (
    <>
      <td className="py-2 pr-3 align-top whitespace-nowrap" data-element="account-spot">
        <span className="tabular-nums text-(--el-text)">
          {t('pools.ciSpot.accounts.spotOf', {
            spot: format.number(counts.spot),
            total: format.number(counts.launched),
          })}
        </span>
        {counts.notRecorded > 0 ? (
          <Sub>
            {t('pools.ciSpot.accounts.notRecorded', { count: format.number(counts.notRecorded) })}
          </Sub>
        ) : percent !== null ? (
          <Sub>{t('pools.ciSpot.accounts.percent', { percent: format.number(percent) })}</Sub>
        ) : null}
      </td>
      <td className="py-2 pr-3 align-top whitespace-nowrap" data-element="account-interrupted">
        <span className="tabular-nums text-(--el-text)">{format.number(counts.interrupted)}</span>
      </td>
    </>
  );
}
