'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { FolderGit2, Loader2, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { GithubMark } from '@/components/icons/GithubMark';
import type { RepoAuditRow } from '@/lib/codeHealth/repoAuditRows';
import { orderRepoAuditRows, rollupRepoAuditRows } from '@/lib/codeHealth/repoAuditRows';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// Panel 7 (MOTIR-2207): the layer ABOVE the audit report that chooses whose
// report is on screen — a worst-first list of the connected repos, each row
// carrying that repo's OWN grade, with the selected repo's report rendering
// beneath it unchanged.
//
// ⚠️ THE LIST IS NOT DRAWN AT N = 1 (Panel 7 §7). Its only two jobs are
// selection and comparison and both are vacuous with one row, so a single-repo
// project renders exactly the tab it renders today. This is a deliberate
// departure from design/repository-set §15.5's "design it as a SET whose
// degenerate case is one" — there the strip still answered a per-repository
// question at N = 1; here it answers nothing.
//
// ⚠️ ROWS ARE SIBLING BUTTONS, NEVER A LISTBOX. A row carries a per-row action
// (the unavailable state's "Try again"), and a `role="listbox"` of
// `role="option"` rows may not contain interactive children — the shipped
// `SavedFilterDropdown` failed the 6.2.6 axe sweep on exactly that
// (`aria-required-children` critical + `nested-interactive` serious). So: a
// `role="group"` wrapper, ONE button per row whose accessible name is the repo
// plus its state, the recovery as a SIBLING button, and `aria-current` on the
// selected row.
//
// ⚠️ COLOUR IS NEVER ALONE. The grade chip puts the hue in the TINT with
// `--el-text-strong` ink and repeats the grade LETTER and the percentage as
// text; the three non-graded states carry colour on the ICON and meaning in the
// WORD. Selection reuses this page's existing current-row highlight (an
// `--el-accent-on-surface` border on `--el-surface-soft`) PLUS a semibold repo
// name, so it is not colour-only either.

/** The SHIPPED tone rule, unchanged: the same thresholds `HealthSummary`'s grade
 *  tile uses, so a repo's chip and its tile can never disagree. */
function gradeTint(pct: number | null): string {
  if (pct === null) return 'bg-(--el-muted)';
  if (pct >= 70) return 'bg-(--el-tint-mint)';
  if (pct >= 40) return 'bg-(--el-tint-yellow)';
  return 'bg-(--el-tint-peach)';
}

export function AuditRepoList({
  rows,
  selectedRepoKey,
  onSelect,
  onRetry,
  onAuditRepos,
  busy = false,
}: {
  rows: RepoAuditRow[];
  selectedRepoKey: string | null;
  onSelect: (repoKey: string) => void;
  /** Re-read ONE repo's surface after its read failed. Never a re-audit: the
   *  row failed to LOAD, which says nothing about whether it needs deriving. */
  onRetry: (repoKey: string) => void;
  /** DERIVE an audit for exactly these repos (Panel 8 / MOTIR-2249). One repo
   *  from a row action, or every un-audited repo from the header action. */
  onAuditRepos?: (repoKeys: string[]) => void;
  /** A run is in flight (or is being resumed). Every derive trigger is then
   *  REMOVED, not disabled — Panel 4b State C's rule: the guarded handler would
   *  no-op anyway, and a control that does nothing is worse than an absent one. */
  busy?: boolean;
}) {
  const t = useTranslations('codeHealth.audit.repos');
  const format = useFormatter();
  const relativeTime = useRelativeTime();

  // §7 — with one connected repo there is nothing to choose between.
  if (rows.length <= 1) return null;

  const ordered = orderRepoAuditRows(rows);
  const rollup = rollupRepoAuditRows(rows);
  const canTrigger = onAuditRepos !== undefined && !busy;
  // The header action's scope: every repo with NO report. `unavailable` is
  // excluded — its read failed, so nothing here knows whether it needs deriving
  // (Panel 8 §2); the row offers a free re-READ instead.
  const unaudited = ordered.filter((row) => row.state === 'not_audited').map((row) => row.repoKey);

  return (
    <Card
      header={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-(--el-text-strong)">{t('title')}</span>
          <div className="flex items-center gap-2">
            <Pill tone="neutral">{t('connected', { count: rollup.connected })}</Pill>
            {/* ABSENT at zero, never disabled (Panel 8 §3): a control whose only
                meaning is "there is nothing to do" has to be explained, and the
                rollup already says every repo is audited. */}
            {canTrigger && unaudited.length > 0 ? (
              <Button variant="secondary" size="sm" onClick={() => onAuditRepos?.(unaudited)}>
                {t('auditUnaudited', { count: unaudited.length })}
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      {/* Counts that are TRUE BY ADDITION — never a project-level mean (§2). */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--el-text-secondary)">
        <span>{t('rollupAudited', { audited: rollup.audited, total: rollup.connected })}</span>
        <span aria-hidden>·</span>
        <span>{t('rollupFindings', { count: rollup.findings })}</span>
        {rollup.deriving > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{t('rollupDeriving', { count: rollup.deriving })}</span>
          </>
        ) : null}
        {rollup.notAudited > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{t('rollupNotAudited', { count: rollup.notAudited })}</span>
          </>
        ) : null}
        {rollup.unavailable > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span>{t('rollupUnavailable', { count: rollup.unavailable })}</span>
          </>
        ) : null}
      </p>

      <div role="group" aria-label={t('groupLabel')} className="mt-3 flex flex-col">
        {ordered.map((row) => (
          <RepoRow
            key={row.repoKey}
            row={row}
            selected={row.repoKey === selectedRepoKey}
            onSelect={onSelect}
            onRetry={onRetry}
            onAudit={canTrigger ? (repoKey) => onAuditRepos?.([repoKey]) : undefined}
            // A deriving row is timed from when THIS run was queued, never from
            // the audit it is replacing (MOTIR-7620) — that one's age read as
            // "started 2 weeks ago" on a re-audit fired a second earlier. Its
            // clock is the browser's, not the provider's per-request `now`: the
            // run was queued AFTER the page was served, so against that `now`
            // it would read as starting in the future. Only the island ever sets
            // `startedAt`, so this never renders on the server. Inside its first
            // minute it stays "just started" rather than "started now".
            when={
              row.state === 'deriving'
                ? startedWhen(row.startedAt, (at, now) => format.relativeTime(at, now))
                : row.auditedAt === null
                  ? null
                  : relativeTime(new Date(row.auditedAt))
            }
          />
        ))}
      </div>
    </Card>
  );
}

const JUST_STARTED_MS = 60_000;

/** A deriving row's "{when}", or null for "just started" — no queued-at known
 *  yet, or one less than a minute old. */
function startedWhen(
  startedAt: string | null,
  relative: (at: Date, now: Date) => string,
): string | null {
  if (startedAt === null) return null;
  const at = new Date(startedAt);
  const now = new Date();
  return now.getTime() - at.getTime() < JUST_STARTED_MS ? null : relative(at, now);
}

function RepoRow({
  row,
  selected,
  onSelect,
  onRetry,
  onAudit,
  when,
}: {
  row: RepoAuditRow;
  selected: boolean;
  onSelect: (repoKey: string) => void;
  onRetry: (repoKey: string) => void;
  /** Undefined when no derive trigger may render at all (N/A or a run in flight). */
  onAudit?: (repoKey: string) => void;
  when: string | null;
}) {
  const t = useTranslations('codeHealth.audit.repos');

  // The row's state, as an icon PLUS a word — the accessible name carries the
  // same pair, so the button announces "<repo>, Deriving…" rather than a bare
  // repo name whose meaning lives only in a colour.
  const stateLabel =
    row.state === 'audited'
      ? row.notMeasured
        ? t('stateNotMeasured')
        : row.grade !== null && row.conformancePct !== null
          ? t('grade', { grade: row.grade, pct: row.conformancePct })
          : t('stateAudited')
      : row.state === 'deriving'
        ? t('stateDeriving')
        : row.state === 'not_audited'
          ? t('stateNotAudited')
          : t('stateUnavailable');

  return (
    <div
      className={`flex flex-wrap items-center gap-2 border-b border-(--el-border-soft) px-(--spacing-control-x) py-(--spacing-control-y) last:border-b-0 ${
        selected
          ? 'rounded-(--radius-control) border-(--el-accent-on-surface) bg-(--el-surface-soft)'
          : ''
      }`}
    >
      {/* ONE button per row, named "<the action> · <the state>" (§6). The name is
          set explicitly rather than left to the row's contents: a grade chip, a
          count pill and a timestamp concatenate into an announcement nobody can
          parse, and the STATE is the part that must survive into it. */}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={`${t('pick', { repoRef: row.repoKey })} · ${stateLabel}`}
        onClick={() => onSelect(row.repoKey)}
        className="flex flex-1 flex-wrap items-center gap-2 rounded-(--radius-control) text-left focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <GithubMark className="size-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
        <span
          className={`font-mono text-xs text-(--el-text-identifier) ${selected ? 'font-semibold' : ''}`}
        >
          {row.repoKey}
        </span>

        {row.state === 'audited' ? (
          <span
            className={`rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium text-(--el-text-strong) ${gradeTint(row.conformancePct)}`}
          >
            {stateLabel}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-(--el-text-secondary)">
            <StateIcon state={row.state} />
            {stateLabel}
          </span>
        )}

        <span className="flex-1" />

        {row.state === 'audited' ? (
          <Pill tone="neutral">{t('findingCount', { count: row.findingCount })}</Pill>
        ) : null}
        {/* `--el-text-muted` is 4.34:1 on `--el-surface-soft` (below AA), which
            is why the SELECTED row's timestamp used to step up a level (§6).
            MOTIR-2477 dropped the split: the selected row is the only tinted
            one, but the scanner cannot correlate a conditional background with
            the branch that paints it, and `--el-text-secondary` is AA on both,
            so the whole column takes it. */}
        <span className="text-xs text-(--el-text-secondary)">
          {row.state === 'deriving'
            ? when === null
              ? t('startedRecently')
              : t('startedWhen', { when })
            : (when ?? '—')}
        </span>
      </button>

      {/* The recovery is a SIBLING of the row button, never nested inside it. */}
      {row.state === 'unavailable' ? (
        <Button variant="ghost" size="sm" onClick={() => onRetry(row.repoKey)}>
          {t('retry')}
        </Button>
      ) : null}

      {/* The DERIVE trigger — also a sibling, and the row's last element (Panel 8
          §2). Weight encodes price: `secondary` (bordered) for the one thing
          worth doing on a repo with no report, `ghost` for the rarer re-derive.
          Its accessible name repeats the REPO, because "Audit this repo" read
          out of the row means nothing.

          ⚠️ Two states get NO trigger, and both are deliberate:
            · `deriving`    — the work is already happening; a second press can
                              only duplicate it.
            · `unavailable` — the read FAILED, so nothing here knows whether the
                              repo has a report; deriving would spend money to
                              fix what may be a display error. Its free re-READ
                              above is the correct first move. This is also what
                              keeps the free recovery and the paid trigger from
                              ever sitting in the same row. */}
      {onAudit !== undefined && (row.state === 'not_audited' || row.state === 'audited') ? (
        <Button
          variant={row.state === 'not_audited' ? 'secondary' : 'ghost'}
          size="sm"
          aria-label={
            row.state === 'not_audited'
              ? t('auditOneLabel', { repoRef: row.repoKey })
              : t('reauditOneLabel', { repoRef: row.repoKey })
          }
          onClick={() => onAudit(row.repoKey)}
        >
          {row.state === 'not_audited' ? t('auditOne') : t('reauditOne')}
        </Button>
      ) : null}
    </div>
  );
}

function StateIcon({ state }: { state: RepoAuditRow['state'] }) {
  if (state === 'deriving') {
    return <Loader2 className="size-4 animate-spin text-(--el-accent-on-surface)" aria-hidden />;
  }
  if (state === 'not_audited') {
    return <FolderGit2 className="size-4 text-(--el-warning)" aria-hidden />;
  }
  return <TriangleAlert className="size-4 text-(--el-danger)" aria-hidden />;
}
