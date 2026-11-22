'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Activity,
  CircleCheckBig,
  CircleOff,
  ExternalLink,
  LoaderCircle,
  TriangleAlert,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { Pill } from '@/components/ui/Pill';
import { Popover } from '@/components/ui/Popover';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import type { MonitorLinkRefusal } from '../actions';
import { MonitorErrorEvidence } from './MonitorErrorEvidence';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The work-item page's ERRORS section — its rows (Story MOTIR-4932 · Subtask
// MOTIR-5732), drawn by `design/monitoring/work-item-errors.mock.html` and
// `design-notes.md` §14.
//
// ⚠️ IT IS THE DEVELOPMENT CARD'S GRAMMAR WITH A DIFFERENT SOURCE, NOT A SECOND
// IDIOM. A row is `PullRequestRow` class for class (bordered row on
// `--el-surface`, the 17px muted glyph, the 13.5px title over the 12px
// `--el-text-identifier` line, the pill group, the out-link, the × LAST), and the
// × is the `RemovePullRequestLinkButton` popover. The host card is the shared
// `ContentSectionCard`, rendered by `LateSections.tsx`.
//
// ⚠️ EVERYTHING HERE IS STORED DATA. The rows render what the reconciler and the
// sync wrote (`monitorIssueService.listForWorkItem`); nothing on this page asks
// the monitor anything. The linking doors — `+ Link error`, the picker, the move
// confirmation and the ⋯-menu row — are MOTIR-5744's and render inside this
// section; this file owns the rows and their unlink.

/** §14 Decision 3 — the level pill. A known level takes its severity; any other
 *  string is a NEUTRAL pill carrying the string VERBATIM, never mapped to a
 *  plausible neighbour (the ingestion store lets an unknown level through on
 *  purpose, and a guessed severity would hide a real value); `null` is no pill. */
export function levelPillProps(
  level: string | null,
): { severity: 'danger' | 'warning' | 'info' } | { tone: 'neutral' } | null {
  if (level === null) return null;
  if (level === 'fatal' || level === 'error') return { severity: 'danger' };
  if (level === 'warning') return { severity: 'warning' };
  if (level === 'info') return { severity: 'info' };
  return { tone: 'neutral' };
}

/** §14 Decision 5 — the write controls (the ×, and MOTIR-5744's doors) show only
 *  to a reader holding `work_item:edit` AND only when the project binds a monitor.
 *  Absent otherwise, never disabled. */
export function canWriteErrors(canEdit: boolean, hasConnection: boolean): boolean {
  return canEdit && hasConnection;
}

/**
 * What the section renders for a read, before any row: nothing at all for a
 * card with no link (the page is unchanged — §14 panel 5a), the failed-read card
 * only where the project HAS a connection (panel 10: a project with none cannot
 * have had a link to fail to read), and otherwise the rows.
 */
export type ErrorsSectionState = 'hidden' | 'failed' | 'rows';
export function errorsSectionState(
  links: MonitorIssueLinkDto[] | null,
  hasConnection: boolean,
): ErrorsSectionState {
  if (links === null) return hasConnection ? 'failed' : 'hidden';
  return links.length > 0 ? 'rows' : 'hidden';
}

/** The identifier line: `<org> / <project> · <environment> · <release>`, each
 *  absent part OMITTED — never "unknown" (§14 panels 1–2). */
export function errorMetaLine(link: MonitorIssueLinkDto): string {
  const connection = link.connection.orgSlug
    ? `${link.connection.orgSlug} / ${link.connection.projectSlug}`
    : link.connection.projectSlug;
  return [connection, link.environment, link.release].filter(Boolean).join(' · ');
}

/** A relative time's two halves for a rich message: `when` is the relative text,
 *  and `t` wraps it in the underline-dotted span carrying the ABSOLUTE time on
 *  hover — the `t` element the mock draws inside a sentence. */
function useWhen(): (at: string) => {
  when: string;
  t: (chunks: ReactNode) => ReactNode;
} {
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  return (at: string) => {
    const date = new Date(at);
    return {
      when: relativeTime(date),
      t: (chunks: ReactNode) => (
        <span
          className="underline decoration-dotted"
          title={format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' })}
        >
          {chunks}
        </span>
      ),
    };
  };
}

const QUIET_NOTE =
  'mt-0.5 mb-1 ml-[27px] flex items-start gap-1.5 font-sans text-xs leading-snug text-(--el-text-secondary)';

/** The resolve-back line (§14 panel 3), one per `resolve.state` value; `null`
 *  draws nothing. */
function ResolveNote({ link }: { link: MonitorIssueLinkDto }) {
  const t = useTranslations('monitorErrors');
  const whenOf = useWhen();
  // A state written without its timestamp (none is) still reads as a sentence.
  const noWhen = { when: '', t: () => null };
  const b = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;
  switch (link.resolve.state) {
    case null:
      return null;
    case 'pending':
      return (
        <div className={QUIET_NOTE} data-note="resolve-pending">
          <LoaderCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('resolve.pending')}</span>
        </div>
      );
    case 'resolved':
      return (
        <div className={QUIET_NOTE} data-note="resolve-resolved">
          <CircleCheckBig className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t.rich(
              'resolve.resolved',
              link.resolve.resolvedAt ? whenOf(link.resolve.resolvedAt) : noWhen,
            )}
          </span>
        </div>
      );
    case 'failed':
      return (
        <div
          className="mt-0.5 mb-1 ml-[27px] flex items-start gap-1.5 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs leading-snug text-(--el-warning-text)"
          data-note="resolve-failed"
        >
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-warning)" aria-hidden />
          <span>
            {t.rich('resolve.failed', {
              b,
              // The provider's OWN words, verbatim — never reworded (§4's rule).
              reason: link.resolve.error ?? '',
              ...(link.resolve.attemptedAt ? whenOf(link.resolve.attemptedAt) : noWhen),
            })}
          </span>
        </div>
      );
    case 'gone':
      return (
        <div className={QUIET_NOTE} data-note="resolve-gone">
          <CircleOff className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t.rich('resolve.gone', { b })}</span>
        </div>
      );
  }
}

/** The assignee note (§14 panel 4) — a quiet secondary line, never a warning. */
function AssigneeNote({ link }: { link: MonitorIssueLinkDto }) {
  const t = useTranslations('monitorErrors');
  if (link.assigneeNote === null) return null;
  const team = link.assigneeNote === 'team_assignee';
  const Glyph = team ? UsersRound : UserRound;
  return (
    <div className={QUIET_NOTE} data-note={`assignee-${link.assigneeNote}`}>
      <Glyph className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t(team ? 'assignee.teamAssignee' : 'assignee.noMatch')}</span>
    </div>
  );
}

/** One linked issue — `PullRequestRow`'s grammar (§14 composition table). */
export function ErrorRow({ link, action }: { link: MonitorIssueLinkDto; action?: ReactNode }) {
  const t = useTranslations('monitorErrors');
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const gone = link.resolve.state === 'gone';
  const pill = levelPillProps(link.level);
  const lastSeen = new Date(link.lastSeenAt);
  return (
    <li
      className={`mt-2 rounded-(--radius-control) border border-(--el-border) px-(--spacing-control-x) py-(--spacing-control-y) ${
        gone ? 'bg-(--el-surface-soft)' : 'bg-(--el-surface)'
      }`}
      data-testid="error-row"
    >
      <div className="flex items-center gap-2.5 gap-y-1 @max-[30rem]:flex-wrap">
        <Activity className="h-[17px] w-[17px] shrink-0 text-(--el-icon-muted)" aria-hidden />
        <div className="min-w-0 flex-1 py-1">
          {gone || !link.permalink ? (
            // A GONE issue is not a link: the monitor no longer has it (§14 panel 3).
            <span
              className={`block truncate font-sans text-[13.5px] font-medium ${
                gone ? 'text-(--el-text-secondary)' : 'text-(--el-text)'
              }`}
            >
              {link.title}
            </span>
          ) : (
            <a
              href={link.permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate font-sans text-[13.5px] font-medium text-(--el-text) hover:underline"
            >
              {link.title}
            </a>
          )}
          <div className="truncate font-sans text-xs text-(--el-text-identifier)">
            {errorMetaLine(link)}
          </div>
        </div>
        {/* NARROW: below a 30rem column the facts drop to their own line, indented
            past the glyph — `PullRequestRow`'s `@max-[30rem]` rule. */}
        <span className="flex shrink-0 items-center gap-2.5 @max-[30rem]:order-last @max-[30rem]:basis-full @max-[30rem]:flex-wrap @max-[30rem]:pb-1 @max-[30rem]:pl-[27px]">
          {pill ? (
            <Pill {...pill} data-testid="error-level">
              {link.level}
            </Pill>
          ) : null}
          {/* §14 Decision 2 — recurrence reads by WIDTH: full precision, the
              locale's grouping, tabular figures, right-aligned in its own slot. */}
          <span className="min-w-[118px] text-right font-sans text-xs whitespace-nowrap text-(--el-text-secondary)">
            {t.rich('seen', {
              count: link.eventCount,
              b: (chunks) => (
                <b
                  className="text-[13px] font-semibold text-(--el-text) tabular-nums"
                  data-testid="error-count"
                >
                  {chunks}
                </b>
              ),
            })}
          </span>
          <span
            className="min-w-[112px] font-sans text-xs whitespace-nowrap text-(--el-text-secondary)"
            title={format.dateTime(lastSeen, { dateStyle: 'medium', timeStyle: 'short' })}
          >
            {t('lastSeen', { when: relativeTime(lastSeen) })}
          </span>
        </span>
        {gone || !link.permalink ? (
          // The spacer keeps the columns when the out-link is dropped.
          <span className="inline-block h-6 w-6 shrink-0" aria-hidden />
        ) : (
          // aria-label, NOT an sr-only span — the shipped icon-only convention.
          <a
            href={link.permalink}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('openInSentry')}
            className="shrink-0 rounded-(--radius-control) p-(--spacing-control-x-4) text-(--el-icon-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none @max-[30rem]:order-2"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        )}
        {action}
      </div>
      {/* Resolve line first, then the note (§14 panel 4), then the EVIDENCE
          (§15 Decision 1): the notes are about the LINK, the evidence is about
          the EVENT. On a GONE issue the evidence is KEPT and never marked stale
          (§15 Decision 3): Motir's copy is then the only place it can be read. */}
      <ResolveNote link={link} />
      <AssigneeNote link={link} />
      <MonitorErrorEvidence evidence={gone ? { ...link.evidence, stale: false } : link.evidence} />
    </li>
  );
}

type UnlinkResult = { ok: true; removed: boolean } | MonitorLinkRefusal;

/**
 * The row's × and its confirm (§14 panel 8) — `RemovePullRequestLinkButton`'s
 * popover. The sentence states the CONSEQUENCE, not a warning for effect:
 * deleting the link makes the error exactly as untracked as one never ingested,
 * so a recurrence files a new bug (MOTIR-5731 §3).
 *
 * `removed: false` is not a silent success: the link was already gone, and the
 * popover says so (§14's nothing-to-unlink line).
 */
export function UnlinkErrorButton({
  link,
  unlink,
}: {
  link: MonitorIssueLinkDto;
  unlink: (monitorIssueId: string) => Promise<UnlinkResult>;
}) {
  const t = useTranslations('monitorErrors');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function confirm() {
    setMessage(null);
    setPending(true);
    void (async () => {
      try {
        const res = await unlink(link.id);
        if (res.ok && res.removed) setOpen(false);
        else if (res.ok) setMessage(t('unlink.nothing'));
        else if (res.code === 'forbidden') setMessage(t('error.forbidden'));
        else if (res.code === 'provider_failed')
          setMessage(t('unlink.failed', { reason: res.reason }));
        else setMessage(t('error.notFound'));
      } finally {
        setPending(false);
      }
    })();
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setMessage(null);
      }}
    >
      <Popover.Trigger
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-tint-rose) hover:text-(--el-danger) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        aria-label={t('unlink.aria', { title: link.title })}
      >
        <X className="h-[15px] w-[15px]" aria-hidden />
      </Popover.Trigger>
      <Popover.Content width={300} align="end">
        <div className="flex flex-col gap-3 p-3.5">
          <p className="font-sans text-sm leading-snug text-(--el-text)">
            {t('unlink.confirmBefore')} <span className="font-mono text-xs">{link.title}</span>
            {t('unlink.confirmAfter')}
          </p>
          {message ? (
            <p
              className="rounded-(--radius-control) bg-(--el-tint-rose) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-xs text-(--el-text-strong)"
              role="alert"
            >
              {message}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              {tc('cancel')}
            </Button>
            <Button size="sm" variant="danger" onClick={confirm} loading={pending}>
              {t('unlink.action')}
            </Button>
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}

/**
 * The section's body: the rows, most recently seen first (the read's order),
 * each with its × when the reader may write. After an unlink the card is
 * server-rendered from the late read, so the removal reconciles with
 * `router.refresh()` — exactly how the Development card's unlink does (the
 * page-state contract's case 2).
 */
export function MonitorErrorsList({
  links,
  canWrite,
  unlinkAction,
  workItemId,
  identifier,
}: {
  links: MonitorIssueLinkDto[];
  canWrite: boolean;
  unlinkAction: (input: {
    workItemId: string;
    identifier: string;
    monitorIssueId: string;
  }) => Promise<UnlinkResult>;
  workItemId: string;
  identifier: string;
}) {
  const router = useRouter();
  async function unlink(monitorIssueId: string): Promise<UnlinkResult> {
    const res = await unlinkAction({ workItemId, identifier, monitorIssueId });
    if (res.ok && res.removed) router.refresh();
    return res;
  }
  return (
    // `@container` is what the rows' `@max-[30rem]` rules query (§15 Decision 4's
    // finding): without it neither the row's narrow layout nor the evidence
    // block's ever applied.
    <ul className="@container m-0 list-none p-0" data-testid="errors-list">
      {links.map((link) => (
        <ErrorRow
          key={link.id}
          link={link}
          action={canWrite ? <UnlinkErrorButton link={link} unlink={unlink} /> : undefined}
        />
      ))}
    </ul>
  );
}

/** A failed read (§14 panel 10): named inside the card; the neighbours render. */
export function MonitorErrorsLoadFailed() {
  const t = useTranslations('monitorErrors');
  const router = useRouter();
  return (
    <ErrorState
      title={t('loadFailedTitle')}
      description={t('loadFailedBody')}
      retry={() => router.refresh()}
    />
  );
}
