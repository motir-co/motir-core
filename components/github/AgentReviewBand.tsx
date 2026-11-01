'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bot, ChevronDown, ChevronRight, Loader2, TriangleAlert, User } from 'lucide-react';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Pill } from '@/components/ui/Pill';
import type { AgentReviewRunRefDto } from '@/lib/dto/agentReview';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { formatRunInstant } from '@/lib/runs/runClock';
import { runsHref } from '@/lib/runs/runsAddress';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { relativeLabel } from './RepairFixPart';

// THE REVIEW BAND of the Development frame (Story MOTIR-1626 · MOTIR-6825), built to
// `design/github/design-notes.md` § 30 — Panels 1 (Reviewing), 2a/2b (Passed), 3 (Sent
// back), 4a/4b (Could not run) and 5 (the override, decided). Each class string is the
// one the mock's `ar-` rule block quotes.
//
// ⚠️ IT SITS BETWEEN BAND 1 AND THE PORT — § 29's slot (`ApprovalGateControl`'s
// `leadBand`), so the reader learns what the agent said before reading the rows it is
// about. `--el-page-bg` with a rule under it and no fill of its own: it is part of the
// frame, not a callout. The one filled band is *could not run*, which IS a warning and
// borrows the shipped stale callout.
//
// ⚠️ THE OVERRIDE IS NEVER THE AGENT'S PASS (§12.3). *Continued without the review* wears
// the person's `User` glyph and names the person, the time and their reason — never the
// word *Passed*, never the `Bot`.
//
// ⚠️ INKS: `--el-text`, `--el-text-secondary`, `--el-link` only — `--el-text-muted` fails
// AA on the port's surface (CLAUDE.md, MOTIR-2455) and is never used here.

/**
 * WHICH COPY LINE a could-not-run code reads (§12.6; MOTIR-6820 writes the codes): one
 * line per case, and a generic line for any code this reader does not know — a newer
 * server's, or a refusal's own `code` that is not a hosted-run one.
 */
export type CouldNotRunCopy =
  | 'no_credits'
  | 'no_model'
  | 'repository_unreadable'
  | 'no_verdict'
  | 'boot_failed'
  | 'no_actor'
  | 'noCapacity'
  | 'unknown';

export function couldNotRunCopyOf(code: string): CouldNotRunCopy {
  switch (code) {
    case 'hosted_run_out_of_credits':
    case 'CI_CREDITS_EXHAUSTED':
      return 'no_credits';
    case 'hosted_no_model_offered':
    case 'hosted_models_unavailable':
      return 'no_model';
    case 'hosted_repository_not_readable':
      return 'repository_unreadable';
    case 'hosted_run_boot_failed':
      return 'boot_failed';
    case 'no_verdict':
      return 'no_verdict';
    case 'review_no_actor':
      return 'no_actor';
    // The review's model has no agent-run capacity right now (MOTIR-9633).
    case 'hosted_run_no_capacity':
      return 'noCapacity';
    default:
      return 'unknown';
  }
}

/**
 * The findings' FIRST PARAGRAPH — the pass's summary (§ 30, *the pass's summary*: the
 * verdict carries Markdown findings and no separate summary field). The first block of
 * prose up to a blank line, skipping headings and fences; empty for empty findings.
 */
export function firstParagraph(findingsMd: string | null): string {
  const blocks = (findingsMd ?? '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '' && !/^#{1,6}\s/.test(block) && !block.startsWith('```'));
  return blocks[0] ?? '';
}

// The mock's `ar-band` / `ar-band-head` / `ar-band-title` / `ar-band-meta`.
const BAND =
  'flex min-w-0 flex-col gap-2 border-b border-(--el-border) bg-(--el-page-bg) px-3.5 py-3';
const HEAD = 'flex flex-wrap items-center gap-x-2.5 gap-y-1';
const TITLE = 'm-0 inline-flex items-center gap-1.5 text-[13px] font-semibold text-(--el-text)';
const META = 'text-[12.5px] text-(--el-text-secondary)';
const GLYPH = 'h-4 w-4 shrink-0 text-(--el-text-secondary)';

/**
 * The review run's label, linked to the run (`ar-run`). The address is the READER's
 * (`useReaderRoutes`, MOTIR-6888): this body renders on the Visitor tree too.
 */
function ReviewRunLink({ runId, children }: { runId: string; children: ReactNode }) {
  const routes = useReaderRoutes();
  return (
    <Link
      href={routes.view(runsHref({ run: runId }))}
      className="font-semibold text-(--el-link) underline hover:text-(--el-link-pressed)"
      data-testid="agent-review-run-link"
    >
      {children}
    </Link>
  );
}

/** `<run>` in a rich message — the run's label, linked to the run (`ar-run`). */
function runLink(run: AgentReviewRunRefDto) {
  return function RunLink(chunks: ReactNode) {
    return <ReviewRunLink runId={run.id}>{chunks}</ReviewRunLink>;
  };
}

/** The run, the time and the commits of a DECIDED review — `run.decided`'s line. */
function DecidedMeta({
  run,
  decidedAt,
  count,
}: {
  run: AgentReviewRunRefDto | null;
  decidedAt: string | null;
  count: number;
}) {
  const t = useTranslations('approvalGate.agentReview');
  const locale = useLocale();
  const when = decidedAt ? new Date(decidedAt).toLocaleString(locale) : '';
  return (
    <span className={META}>
      {run
        ? t.rich('run.decided', { label: run.label, when, count, run: runLink(run) })
        : t('run.decidedNoRun', { when, count })}
    </span>
  );
}

/** Panel 1 — REVIEWING: who is answering, and the run (linked) once it has opened. */
export function ReviewingBand({
  run,
  count,
  now,
}: {
  run: AgentReviewRunRefDto | null;
  count: number;
  /** The clock the relative time reads. Injected by tests; `Date.now()` otherwise. */
  now?: number;
}) {
  const t = useTranslations('approvalGate.agentReview');
  const locale = useLocale();
  // Read ONCE per mount: a relative label that moved between renders would be a
  // hydration mismatch (the fix part's rule).
  const [clock] = useState(() => now ?? Date.now());
  return (
    <div className={BAND} role="status" data-testid="agent-review-band" data-state="reviewing">
      <div className={HEAD}>
        <h4 className={TITLE}>
          <Loader2 className={`${GLYPH} animate-spin`} aria-hidden />
          {t('reviewing.title')}
        </h4>
        <span className={META}>
          {run
            ? t.rich('run.started', {
                label: run.label,
                count,
                run: runLink(run),
                when: () => (
                  <time dateTime={run.startedAt} title={formatRunInstant(run.startedAt, locale)}>
                    {relativeLabel(run.startedAt, locale, clock)}
                  </time>
                ),
              })
            : t('run.commits', { count })}
        </span>
      </div>
    </div>
  );
}

/** Panels 4a/4b — COULD NOT RUN: one line per reason, in the shipped stale callout. */
export function CouldNotRunBand({
  reason,
  run,
}: {
  reason: string;
  run: AgentReviewRunRefDto | null;
}) {
  const t = useTranslations('approvalGate.agentReview');
  const copy = couldNotRunCopyOf(reason);
  const line: ReactNode =
    copy === 'no_verdict'
      ? run
        ? t.rich('couldNotRun.reason.no_verdict', { label: run.label, run: runLink(run) })
        : t('couldNotRun.reason.no_verdictNoRun')
      : t(`couldNotRun.reason.${copy}`);
  return (
    <div className={BAND} role="group" aria-label={t('kindLabel')}>
      <div
        role="status"
        data-testid="agent-review-band"
        data-state="could-not-run"
        data-reason={copy}
        className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-warning-surface) px-(--spacing-control-x) py-(--spacing-control-y) text-[13px] leading-snug text-(--el-text-strong)"
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          {t.rich('couldNotRun.lead', {
            b: (chunks) => <b className="font-semibold">{chunks}</b>,
            reason: () => line,
          })}
        </span>
      </div>
    </div>
  );
}

/** The findings in full, through the one Markdown stack (fenced blocks keep their Copy). */
function Findings({
  findingsMd,
  workItemRefs,
}: {
  findingsMd: string;
  workItemRefs: WorkItemRefMap;
}) {
  return (
    <MarkdownView
      value={findingsMd}
      workItemRefs={workItemRefs}
      copyableCode
      className="motir-how-to-test min-w-0"
      data-testid="agent-review-findings"
    />
  );
}

/** Panel 3 — SENT BACK: the findings in full, never collapsed (they are the repair's brief). */
export function SentBackBand({
  findingsMd,
  findingsRefs,
  run,
  decidedAt,
  count,
}: {
  findingsMd: string | null;
  /** The findings' card links, resolved for the reader (MOTIR-10023). */
  findingsRefs: WorkItemRefMap;
  run: AgentReviewRunRefDto | null;
  decidedAt: string | null;
  count: number;
}) {
  const t = useTranslations('approvalGate.agentReview');
  return (
    <div
      className={BAND}
      role="group"
      aria-label={t('kindLabel')}
      data-testid="agent-review-band"
      data-state="sent-back"
    >
      <div className={HEAD}>
        <h4 className={TITLE}>
          <Bot className={GLYPH} aria-hidden />
          {t('sentBack.title')}
        </h4>
        <DecidedMeta run={run} decidedAt={decidedAt} count={count} />
      </div>
      {findingsMd?.trim() ? <Findings findingsMd={findingsMd} workItemRefs={findingsRefs} /> : null}
    </div>
  );
}

/** Panels 2a/2b — PASSED: the summary, then the findings behind the shipped disclosure. */
export function PassedBand({
  findingsMd,
  findingsRefs,
  run,
  decidedAt,
  count,
}: {
  findingsMd: string | null;
  /** The findings' card links, resolved for the reader (MOTIR-10023). */
  findingsRefs: WorkItemRefMap;
  run: AgentReviewRunRefDto | null;
  decidedAt: string | null;
  count: number;
}) {
  const t = useTranslations('approvalGate.agentReview');
  // Not remembered (§ 30, *the pass's summary*): every visit starts collapsed.
  const [open, setOpen] = useState(false);
  const summary = firstParagraph(findingsMd);
  const hasFindings = Boolean(findingsMd?.trim());
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div
      className={BAND}
      role="group"
      aria-label={t('kindLabel')}
      data-testid="agent-review-band"
      data-state="passed"
    >
      <div className={HEAD}>
        <h4 className={TITLE}>
          <Bot className={GLYPH} aria-hidden />
          {t('passed.title')}
        </h4>
        <Pill severity="success">{t('passed.pill')}</Pill>
        <DecidedMeta run={run} decidedAt={decidedAt} count={count} />
      </div>
      {/* A pass with nothing said draws the head alone — no summary, no disclosure. */}
      {hasFindings && !open && summary ? (
        <p
          className="m-0 line-clamp-2 text-[13px] leading-normal text-(--el-text)"
          data-testid="agent-review-summary"
        >
          {summary}
        </p>
      ) : null}
      {hasFindings ? (
        <div>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1.5 rounded-(--radius-control) p-(--spacing-control-x-4) text-left text-xs font-medium text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <Chevron className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
            {t(open ? 'findings.hide' : 'findings.show')}
          </button>
          {open ? (
            <div className="mt-1 border-t border-(--el-border-soft) pt-2.5">
              <Findings findingsMd={findingsMd!} workItemRefs={findingsRefs} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Panel 5 — THE OVERRIDE, DECIDED: the person, the time and their note; never *Passed*. */
export function OverrideBand({
  name,
  decidedAt,
  noteMd,
  count,
}: {
  name: string | null;
  decidedAt: string | null;
  noteMd: string | null;
  count: number;
}) {
  const t = useTranslations('approvalGate.agentReview');
  const locale = useLocale();
  const tGate = useTranslations('approvalGate');
  const note = noteMd?.trim() ?? '';
  return (
    <div
      className={BAND}
      role="group"
      aria-label={t('kindLabel')}
      data-testid="agent-review-band"
      data-state="override"
    >
      <div className={HEAD}>
        <h4 className={TITLE}>
          <User className={GLYPH} aria-hidden />
          {t('override.bandTitle')}
        </h4>
        <span className={META}>{t('override.bandNote', { count })}</span>
      </div>
      {/* The record band's shape (`af-record`), with the note quoted as the refusal's is. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-(--el-text-secondary)">
        <span>
          {t.rich('override.record', {
            // An unattributable decider is SAID, never shown as nobody (§6b).
            name: name ?? tGate('record.unattributed'),
            when: decidedAt ? new Date(decidedAt).toLocaleString(locale) : '',
            b: (chunks) => <b className="font-semibold text-(--el-text)">{chunks}</b>,
          })}
        </span>
        {note ? (
          <span className="basis-full whitespace-pre-line text-(--el-text)">
            &ldquo;{note}&rdquo;
          </span>
        ) : null}
      </div>
    </div>
  );
}
