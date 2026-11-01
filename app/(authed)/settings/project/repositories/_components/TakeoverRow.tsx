'use client';

import { useFormatter, useTranslations } from 'next-intl';
import {
  BadgeCheck,
  CircleCheckBig,
  Clock,
  ExternalLink,
  FolderGit2,
  MoveUpRight,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { GithubMark } from '@/components/icons/GithubMark';
import { repoWebUrl } from '@/lib/repos/cloneUrl';
import type { ProjectRepoDto, ProjectRepoRoomSeedDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { isPlanEditableState, SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';
import {
  currentSeedEntry,
  SeedPills,
  StarterPicker,
  WhyThisStarter,
  type SeedRefusalState,
} from './RowSeed';

// ONE row of the TAKE-IT-OVER room (Story MOTIR-1775 · MOTIR-1939 —
// design/repository-set §14, panels 1 and 4–8).
//
// ⚠️ THE WAITING STATES ARE PLACES, NOT SPINNERS. `transfer_pending` and
// `awaiting_reinstall` are waits on a HUMAN doing something on github.com, with
// no bounded duration — so each renders as a durable row that survives a reload,
// says what the user must go and do, and re-prompts every time it is seen. That
// is the property MOTIR-711 asks for ("re-promptable rather than a wedged repo")
// and it is why the decision is a modal while the STATE is not.
//
// ⚠️ THREE REGISTERS, NOT TWO. "Waiting on you" (peach) is deliberately its own
// register beside settled-Motir (mint) and yours (sky): an unaccepted transfer is
// NOT a failure and must never be tinted as one. Only a request GitHub REFUSED is
// red (§14.7).
//
// ⚠️ STATE IS NEVER COLOUR ALONE — icon PLUS word, with the tint on the ROW and
// never in a `Pill` (a `Pill severity` resolves to the same token as the row tint
// and would be invisible). The only pill here is the neutral role chip. That
// contract came from the establish step's `RepositoryRow`, which was DELETED with
// the technical path (MOTIR-5014); it is written out here because this row is now
// the surviving instance of it, not a copy of a file to go and read.

/** How long a wait has to sit before the copy acknowledges it (the design's
 *  "days later" variants). Not a timeout — nothing expires on Motir's side; it
 *  only changes what the row SAYS, so a user returning to an old wait is told
 *  nothing is wrong rather than being shown the same first-time sentence. */
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** The row's rendering mode — derived once, so every branch below reads one
 *  value instead of re-deriving the same `takeover?.state` ladder. */
type RowMode = 'hosted' | 'yours' | 'pending' | 'reinstall' | 'failed' | 'other';

export interface TakeoverRowProps {
  row: ProjectRepoDto;
  /** The actor's connected GitHub login — what a personal-account target reads
   *  as, and the test that tells an ORG target from a personal one. */
  githubLogin: string | null;
  /** The SHIPPED App-install screen, or null when no App slug is configured
   *  (which drops the button rather than linking nowhere). */
  installHref: string | null;
  /**
   * The request's `now`, stamped ONCE on the server and threaded down.
   *
   * ⚠️ NOT `Date.now()` IN RENDER. Server and client would disagree by the
   * round-trip and the staleness copy would hydrate differently — the repo's
   * known relative-time hydration-flake class. One timestamp, passed in, makes
   * both renders identical by construction.
   */
  nowIso: string;
  busy: boolean;
  onMove: (row: ProjectRepoDto) => void;
  onCheckAgain: (row: ProjectRepoDto) => void;
  onRetry: (row: ProjectRepoDto) => void;
  /**
   * The row's SEED (MOTIR-712; design MOTIR-705 §1) — its starter and hosting
   * pills, and while it is not created yet, why that starter and the picker that
   * re-points it. Absent for a row the room has no seed for.
   */
  seed?: ProjectRepoRoomSeedDto;
  /** A re-point the server refused, shown under the picker until the next pick. */
  seedRefusal?: SeedRefusalState | null;
  onRepoint?: (row: ProjectRepoDto, entry: SeedRegistryEntryDto) => void;
}

export function TakeoverRow({
  row,
  githubLogin,
  installHref,
  nowIso,
  busy,
  onMove,
  onCheckAgain,
  onRetry,
  seed,
  seedRefusal = null,
  onRepoint,
}: TakeoverRowProps) {
  const t = useTranslations('repositoryTakeover');
  const ts = useTranslations('repositorySet');
  const format = useFormatter();

  const mode = rowMode(row);
  const target = row.takeover?.targetOwner ?? githubLogin ?? '';
  const repoRef = row.realizedRepo?.repoRef ?? row.name;
  const shortName = row.realizedRepo?.name ?? row.name;
  const stale = isStale(row, nowIso, mode);
  const seedEntry = seed ? currentSeedEntry(row, seed) : null;
  // A row not created yet — `proposed`, or `failed` and retried from the plan —
  // is the one whose starter can still change (§1.2).
  const notCreated = mode === 'other' && isPlanEditableState(row.state);

  const on = (iso: string | null): string =>
    iso ? format.dateTime(new Date(iso), { day: 'numeric', month: 'short' }) : '';

  return (
    <div
      data-testid={`takeover-row-${row.role}`}
      data-takeover={row.takeover?.state ?? 'none'}
      className={`flex gap-3 rounded-(--radius-card) border p-(--spacing-card-padding) ${ROW_TINT[mode]}`}
    >
      {/* `min-w-0` on the main column and `shrink-0` on the aside is the shipped
          row's own shape — a long owner/name truncates instead of blowing the row
          out (this repo's recurring horizontal-overflow class). */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone="neutral" className="font-mono">
            {row.role}
          </Pill>

          {mode === 'hosted' ? (
            <StateWord icon={<CircleCheckBig className={ICON} />} tone="success">
              {ts('stateCreated')}
            </StateWord>
          ) : null}
          {mode === 'yours' ? (
            <StateWord icon={<BadgeCheck className={ICON} />} tone="info">
              {t('stateYours')}
            </StateWord>
          ) : null}
          {mode === 'pending' ? (
            <StateWord icon={<Clock className={ICON} />} tone="warning" status>
              {stale ? t('statePendingStale') : t('statePending')}
            </StateWord>
          ) : null}
          {mode === 'reinstall' ? (
            <StateWord icon={<FolderGit2 className={ICON} />} tone="warning" status>
              {stale
                ? t('stateReinstallStale', { login: target })
                : t('stateReinstall', { login: target })}
            </StateWord>
          ) : null}
          {mode === 'failed' ? (
            <StateWord icon={<TriangleAlert className={ICON} />} tone="danger">
              {t('stateFailed')}
            </StateWord>
          ) : null}
          {notCreated ? (
            <StateWord icon={<Clock className={ICON} />} tone="waiting">
              {ts('stateProposed')}
            </StateWord>
          ) : null}

          {seed ? <SeedPills row={row} entry={seedEntry} /> : null}
        </div>

        <RepoReference row={row} />

        {/* ── The body copy, per state. Every waiting state names the CONSEQUENCE
            and what to go do, not just the chore. ─────────────────────────── */}
        {mode === 'hosted' ? (
          <Helper>
            {seedEntry === null
              ? ts('createdDetailNoSeed')
              : seedEntry.key === SEED_SOURCE_INITIALISED
                ? ts('createdDetailInitialised')
                : ts('createdDetail', { seed: seedEntry.label })}
          </Helper>
        ) : null}

        {notCreated && seed && seedEntry ? <WhyThisStarter row={row} entry={seedEntry} /> : null}
        {notCreated && seed?.options && onRepoint ? (
          <StarterPicker
            row={row}
            entry={seedEntry}
            options={seed.options}
            busy={busy}
            refusal={seedRefusal}
            onPick={onRepoint}
          />
        ) : null}

        {mode === 'yours' ? (
          <Helper>
            {row.takeover?.state === 'done'
              ? t('doneDetail', { login: target, date: on(row.takeover.transferredAt) })
              : t('yoursDetail')}
          </Helper>
        ) : null}

        {mode === 'pending' ? (
          <Helper>
            {stale
              ? t('pendingDetailStale', {
                  login: target,
                  date: on(row.takeover?.requestedAt ?? null),
                })
              : t('pendingDetail', { login: target })}
          </Helper>
        ) : null}

        {mode === 'reinstall' ? (
          <>
            <Helper>
              {stale
                ? t('reinstallDetailStale', { login: target })
                : t('reinstallDetail', { login: target, repo: shortName })}
            </Helper>
            {/* `role="alert"` because dispatch being OFF is the one thing the
                user did not ask for and would not otherwise learn. The WAIT
                itself is `role="status"` — a refusal interrupts, a wait does
                not (§14.9). */}
            <p role="alert" className="min-w-0 text-sm text-(--el-text-helper)">
              {t('reinstallConsequence')}
            </p>
          </>
        ) : null}

        {mode === 'failed' ? (
          <div className="flex flex-col gap-1">
            {/* The ORG refusal is the failure the design draws, and it is the one
                Motir can explain in the user's own language. GitHub's recorded
                sentence follows it as the REAL reason — never instead of it. */}
            {target && githubLogin && target !== githubLogin ? (
              <p
                role="alert"
                className="flex items-start gap-2 text-sm text-(--el-danger-surface-text)"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{t('failedOrgPermission', { owner: target })}</span>
              </p>
            ) : null}
            {row.takeover?.failureReason ? (
              <p className="min-w-0 text-sm text-(--el-danger-surface-text)">
                {row.takeover.failureReason}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ── The ways forward. Every non-settled state keeps one, which is what
            "no state is a dead end" means here. ───────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 empty:hidden">
          {mode === 'hosted' ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              aria-label={t('moveActionLabel', { repo: repoRef })}
              onClick={() => onMove(row)}
              leftIcon={<MoveUpRight className="size-3.5 shrink-0" />}
            >
              {t('moveAction')}
            </Button>
          ) : null}

          {mode === 'pending' ? (
            <ExternalAction
              href={row.realizedRepo ? repoWebUrl(row.realizedRepo) : null}
              label={t('acceptOnGithubLabel', { repo: repoRef })}
            >
              {t('acceptOnGithub')}
            </ExternalAction>
          ) : null}

          {mode === 'reinstall' && installHref ? (
            <ExternalAction href={installHref} label={t('installOnGithubLabel', { repo: repoRef })}>
              {t('installOnGithub')}
            </ExternalAction>
          ) : null}

          {/* THE RE-PROMPT. Re-running any step of the saga is a no-op
              (MOTIR-711), so this is always safe to press — which is exactly what
              makes an abandoned hand-off recoverable by asking again rather than
              by an operator editing a row. */}
          {mode === 'pending' || mode === 'reinstall' ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={t('checkAgainLabel', { repo: repoRef })}
              onClick={() => onCheckAgain(row)}
              leftIcon={<RefreshCw className="size-3.5 shrink-0" />}
            >
              {t('checkAgain')}
            </Button>
          ) : null}

          {mode === 'failed' ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => onRetry(row)}
                leftIcon={<RefreshCw className="size-3.5 shrink-0" />}
              >
                {t('tryAgain')}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onMove(row)}>
                {t('pickDifferentAccount')}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ICON = 'size-4 shrink-0';

/** The row tint per register (§14.7). `yours` deliberately reuses the shipped
 *  `connected` fill: a repository taken over and one brought in are the same
 *  thing, which is the whole point of the promise. */
const ROW_TINT: Record<RowMode, string> = {
  hosted: 'bg-(--el-success-surface) border-(--el-border-soft)',
  yours: 'bg-(--el-notice-info-bg) border-(--el-border-soft)',
  pending: 'bg-(--el-warning-surface) border-(--el-border-soft)',
  reinstall: 'bg-(--el-warning-surface) border-(--el-border-soft)',
  failed: 'bg-(--el-danger-surface) border-(--el-border-soft)',
  other: 'bg-(--el-card) border-(--el-border)',
};

/**
 * Which of the design's registers this row is in.
 *
 * ⚠️ `connected` IS THE ALREADY-YOURS NO-OP and it reads as `Yours` with NO
 * action — the same word a completed takeover lands on, because by then they are
 * the same thing. `requested` renders as the pending wait rather than a fourth
 * state: it is the instant between the claim and GitHub's answer, and a user who
 * ever sees it is looking at a transfer that has been asked for.
 */
function rowMode(row: ProjectRepoDto): RowMode {
  const takeover = row.takeover?.state ?? null;
  if (takeover === 'requested' || takeover === 'transfer_pending') return 'pending';
  if (takeover === 'awaiting_reinstall') return 'reinstall';
  if (takeover === 'failed') return 'failed';
  if (takeover === 'done' || row.state === 'connected') return 'yours';
  if (row.state === 'created') return 'hosted';
  return 'other';
}

/** Whether a wait has been sitting long enough to say so. */
function isStale(row: ProjectRepoDto, nowIso: string, mode: RowMode): boolean {
  const since =
    mode === 'pending'
      ? row.takeover?.requestedAt
      : mode === 'reinstall'
        ? row.takeover?.transferredAt
        : null;
  if (!since) return false;
  return new Date(nowIso).getTime() - new Date(since).getTime() > STALE_AFTER_MS;
}

/** The state's icon PLUS its word. `status` marks the waiting states, which are
 *  standing conditions the user can resolve rather than errors the row raised. */
function StateWord({
  icon,
  tone,
  status,
  children,
}: {
  icon: ReactNode;
  tone: 'success' | 'info' | 'warning' | 'danger' | 'waiting';
  status?: boolean;
  children: ReactNode;
}) {
  const ink = tone === 'danger' ? 'text-(--el-danger-surface-text)' : 'text-(--el-text-strong)';
  const glyph = {
    success: 'text-(--el-success)',
    info: 'text-(--el-info)',
    warning: 'text-(--el-warning)',
    danger: 'text-(--el-danger)',
    waiting: 'text-(--el-icon-muted)',
  }[tone];
  return (
    <span
      {...(status ? { role: 'status' } : {})}
      className={`inline-flex min-w-0 items-center gap-1.5 text-sm font-semibold ${ink}`}
    >
      <span className={`inline-flex shrink-0 ${glyph}`}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** The realized repository, linked out to the host when there is one to link to
 *  and plain text when there is not (`--el-text`, per §14.7). */
function RepoReference({ row }: { row: ProjectRepoDto }) {
  const href = row.realizedRepo ? repoWebUrl(row.realizedRepo) : null;
  const label = row.realizedRepo?.repoRef ?? row.name;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <GithubMark className="size-4 shrink-0 text-(--el-icon-muted)" aria-hidden />
      {href ? (
        <>
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="min-w-0 truncate font-mono text-sm text-(--el-link) hover:text-(--el-link-pressed)"
          >
            {label}
          </a>
          <ExternalLink className="size-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden="true" />
        </>
      ) : (
        <span className="min-w-0 truncate font-mono text-sm text-(--el-text)">{label}</span>
      )}
    </span>
  );
}

function Helper({ children }: { children: ReactNode }) {
  return <p className="min-w-0 text-sm text-(--el-text-helper)">{children}</p>;
}

/**
 * A navigation out to GitHub wearing the secondary/sm shape.
 *
 * An anchor rather than a `Button`: these go to github.com, and a button faking a
 * link loses middle-click, open-in-new-tab and the role a screen reader
 * announces. The shipped invitation row makes the same call for the same reason.
 * A null `href` renders nothing — a dead control is worse than an absent one.
 */
function ExternalAction({
  href,
  label,
  children,
}: {
  href: string | null;
  label: string;
  children: ReactNode;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      className="inline-flex h-(--height-btn-sm) items-center gap-1.5 rounded-(--radius-btn) border border-(--el-button-border) px-(--spacing-btn-x-sm) font-sans text-xs font-medium text-(--el-text) hover:bg-(--el-surface)"
    >
      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
      {children}
    </a>
  );
}
