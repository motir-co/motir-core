'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  TriangleAlert,
} from 'lucide-react';
import type { MonitorEvidenceFrameDto, MonitorIssueEvidenceDto } from '@/lib/dto/monitorIssueLink';
import { useRelativeTime } from '@/lib/hooks/useRelativeTime';

// The EVIDENCE of one linked error (Story MOTIR-5975 · Subtask MOTIR-5980), drawn
// by `design/monitoring/work-item-errors--evidence.mock.html` and
// `design-notes.md` §15 — a DELTA of §14's row, which it sits inside.
//
// ⚠️ STORED DATA ONLY, AND NO READ OF ITS OWN. Everything here is the link's
// `evidence` DTO (MOTIR-5979), already on the row the section rendered: opening
// the block is local UI state with no request and no spinner, and nothing here
// asks the monitor anything. The frames arrive in the adapter's order (in-app
// first, most recent call first) and are never re-sorted; the tags arrive with
// every user-identifying key already dropped at the seam, so there is no second
// filter here.

/** §15 Decision 2 — the first N tags show as chips; the rest fold. */
export const EVIDENCE_TAGS_SHOWN = 12;
/** How long the copy control reads "Copied" (the CopyableCodeBlock grammar). */
const COPIED_MS = 2000;

/**
 * Which of §15 Decision 3's treatments a link's evidence takes — TOTAL over
 * `state × stale`, so every value the DTO can carry has exactly one answer:
 *
 * - `never_read` → a quiet note and NO door: there is nothing to open. Stale is
 *   irrelevant here (the mapper never sets it without a read; if it ever did,
 *   there is still nothing old to show).
 * - `present` / `no_exception` → the door and the block, the block opening on
 *   the exception (present) or on the no-exception sentence, and on the
 *   out-of-date line first when `stale`.
 */
export type EvidenceView =
  | { kind: 'never_read' }
  | { kind: 'block'; exception: boolean; stale: boolean };

export function evidenceView(
  evidence: Pick<MonitorIssueEvidenceDto, 'state' | 'stale'>,
): EvidenceView {
  switch (evidence.state) {
    case 'never_read':
      return { kind: 'never_read' };
    case 'present':
      return { kind: 'block', exception: true, stale: evidence.stale };
    case 'no_exception':
      return { kind: 'block', exception: false, stale: evidence.stale };
  }
}

/** §15 Decision 2 — the stack's two groups. When NO frame is the application's,
 *  the trace shows flat and ungrouped: folding everything would hide it all.
 *  `inApp` false OR null is framework — the adapter's own partition. */
export function frameGroups(frames: readonly MonitorEvidenceFrameDto[]): {
  inApp: MonitorEvidenceFrameDto[];
  framework: MonitorEvidenceFrameDto[];
  flat: boolean;
} {
  const inApp = frames.filter((frame) => frame.inApp === true);
  const framework = frames.filter((frame) => frame.inApp !== true);
  return { inApp, framework, flat: inApp.length === 0 };
}

/** A frame's location: `filePath:lineNumber`, or the path alone — never "unknown". */
export function frameLocation(frame: MonitorEvidenceFrameDto): string {
  return frame.lineNumber === null ? frame.filePath : `${frame.filePath}:${frame.lineNumber}`;
}

/** The collapsed door's summary parts, each absent part OMITTED. */
export function evidenceSummaryParts(evidence: MonitorIssueEvidenceDto): {
  exceptionType: string | null;
  request: string | null;
} {
  return {
    exceptionType: evidence.exception?.type ?? null,
    request: evidence.request
      ? [evidence.request.method, evidence.request.path].filter(Boolean).join(' ')
      : null,
  };
}

const LABEL =
  'mb-1 font-mono text-[11px] font-semibold tracking-[0.06em] text-(--el-text-secondary) uppercase';
const LABEL_COUNT = 'font-normal tracking-normal normal-case';
const CODE =
  'rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-control-x) py-(--spacing-control-y-8) font-mono text-xs leading-normal [overflow-wrap:anywhere] whitespace-pre-wrap text-(--el-code-text)';
const FOLD =
  'mt-1 font-sans text-xs font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';
const QUIET_LINE =
  'flex items-start gap-1.5 font-sans text-xs leading-snug text-(--el-text-secondary)';

/** A relative time with the absolute one on hover — the section's `useWhen`. */
function useWhen(): (at: string) => { when: string; t: (chunks: ReactNode) => ReactNode } {
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

/** The never-read note — in the row's quiet-note grammar, never an error colour:
 *  an old link, or one past the poll's read budget, is waiting, not broken. */
function NeverReadNote() {
  const t = useTranslations('monitorErrors.evidence');
  return (
    <div
      className="mt-0.5 mb-1 ml-[27px] flex items-start gap-1.5 font-sans text-xs leading-snug text-(--el-text-secondary) @max-[30rem]:ml-0"
      data-evidence="never_read"
    >
      <Clock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{t('neverRead')}</span>
    </div>
  );
}

function CopyEventId({ id }: { id: string }) {
  const t = useTranslations('monitorErrors.evidence');
  const [state, setState] = useState<'rest' | 'copied' | 'failed'>('rest');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(id);
      setState('copied');
      timer.current = setTimeout(() => setState('rest'), COPIED_MS);
    } catch {
      // A denied clipboard leaves the id on screen, selectable — the sentence
      // says so rather than pretending it copied.
      setState('failed');
    }
  }
  const copied = state === 'copied';
  return (
    <span className="inline-flex items-center gap-1" aria-live="polite">
      <button
        type="button"
        aria-label={t('copyEventId')}
        data-state={state}
        onClick={() => void copy()}
        className="inline-flex h-6 w-6 items-center justify-center rounded-(--radius-control) text-(--el-icon-muted) hover:bg-(--el-muted) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-(--el-success)" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      {copied ? <span className="text-xs">{t('copied')}</span> : null}
      {state === 'failed' ? <span className="text-xs">{t('copyFailed')}</span> : null}
    </span>
  );
}

function FrameRow({ frame, framework }: { frame: MonitorEvidenceFrameDto; framework: boolean }) {
  const t = useTranslations('monitorErrors.evidence');
  return (
    <li
      className="flex flex-wrap items-baseline gap-x-2 border-t border-(--el-border-soft) px-2.5 py-1 font-mono text-xs leading-normal first:border-t-0"
      data-frame={framework ? 'framework' : 'app'}
    >
      <span
        className={`min-w-0 [overflow-wrap:anywhere] ${
          framework ? 'text-(--el-text-secondary)' : 'text-(--el-code-text)'
        }`}
      >
        {frameLocation(frame)}
      </span>
      {frame.function ? (
        <span
          className={`[overflow-wrap:anywhere] ${
            framework ? 'text-(--el-text-secondary)' : 'text-(--el-text-strong)'
          }`}
        >
          {t('frameIn', { function: frame.function })}
        </span>
      ) : null}
    </li>
  );
}

function StackTrace({ frames }: { frames: MonitorEvidenceFrameDto[] }) {
  const t = useTranslations('monitorErrors.evidence');
  const [showFramework, setShowFramework] = useState(false);
  const groups = frameGroups(frames);
  return (
    <div data-evidence-block="frames">
      <div className={LABEL}>
        {t('stackTrace')}{' '}
        <span className={LABEL_COUNT}>
          ·{' '}
          {groups.flat
            ? t('framesFlat', { count: frames.length })
            : t('framesGrouped', {
                inApp: groups.inApp.length,
                framework: groups.framework.length,
              })}
        </span>
      </div>
      <ul className="m-0 list-none rounded-(--radius-control) bg-(--el-code-bg) p-0">
        {groups.flat
          ? frames.map((frame, i) => <FrameRow key={i} frame={frame} framework={false} />)
          : groups.inApp.map((frame, i) => <FrameRow key={i} frame={frame} framework={false} />)}
        {!groups.flat && groups.framework.length > 0 && showFramework
          ? groups.framework.map((frame, i) => <FrameRow key={`f${i}`} frame={frame} framework />)
          : null}
        {!groups.flat && groups.framework.length > 0 ? (
          <li className="list-none">
            <button
              type="button"
              aria-expanded={showFramework}
              onClick={() => setShowFramework((open) => !open)}
              className="flex w-full items-center gap-1.5 border-t border-(--el-border-soft) px-2.5 py-1.5 text-left font-sans text-xs text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {showFramework ? (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              )}
              {showFramework
                ? t('hideFramework')
                : t('showFramework', { count: groups.framework.length })}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function Tags({ tags }: { tags: { key: string; value: string }[] }) {
  const t = useTranslations('monitorErrors.evidence');
  const [all, setAll] = useState(false);
  const shown = all ? tags : tags.slice(0, EVIDENCE_TAGS_SHOWN);
  return (
    <div data-evidence-block="tags">
      <div className={LABEL}>
        {t('tags')} <span className={LABEL_COUNT}>· {tags.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((tag, i) => (
          <span
            key={i}
            className="inline-flex max-w-full items-baseline gap-1 rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) font-mono text-xs leading-normal"
            data-tag={tag.key}
          >
            <span className="text-(--el-text-secondary)">{tag.key}</span>
            <span className="min-w-0 [overflow-wrap:anywhere] text-(--el-text)">{tag.value}</span>
          </span>
        ))}
      </div>
      {tags.length > EVIDENCE_TAGS_SHOWN && !all ? (
        <button type="button" className={FOLD} onClick={() => setAll(true)}>
          {t('showAllTags', { count: tags.length })}
        </button>
      ) : null}
    </div>
  );
}

function ExceptionBlock({
  exception,
}: {
  exception: NonNullable<MonitorIssueEvidenceDto['exception']>;
}) {
  const t = useTranslations('monitorErrors.evidence');
  const [full, setFull] = useState(false);
  // A message longer than a few lines is CLAMPED with a fold, never cut
  // silently (§15 Decision 2). A short one gets no fold at all.
  const long =
    (exception.message ?? '').length > 280 || (exception.message ?? '').split('\n').length > 4;
  return (
    <div data-evidence-block="exception">
      <div className={LABEL}>{t('exception')}</div>
      <div className={CODE}>
        <div className={full || !long ? undefined : 'line-clamp-4'} data-testid="evidence-message">
          {exception.type ? <span className="font-semibold">{exception.type}</span> : null}
          {exception.type && exception.message ? ': ' : null}
          {exception.message}
        </div>
      </div>
      {long ? (
        <button type="button" className={FOLD} onClick={() => setFull((open) => !open)}>
          {full ? t('showLess') : t('showFullMessage')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The row's evidence: §15's door (a quiet full-width line under the row's notes,
 * collapsed by default) and, open, the block — Exception → Request → Stack trace
 * → Tags → footer, each part OMITTED when its data is absent.
 */
export function MonitorErrorEvidence({ evidence }: { evidence: MonitorIssueEvidenceDto }) {
  const t = useTranslations('monitorErrors.evidence');
  const whenOf = useWhen();
  const [open, setOpen] = useState(false);
  const view = evidenceView(evidence);
  if (view.kind === 'never_read') return <NeverReadNote />;

  const summary = evidenceSummaryParts(evidence);
  const mono = (text: string) => <span className="font-mono text-(--el-text)">{text}</span>;
  const summaryParts: ReactNode[] = [
    summary.exceptionType ? mono(summary.exceptionType) : t('summaryNoException'),
    summary.request ? mono(summary.request) : null,
    evidence.eventAt ? t('summaryLatest', { when: whenOf(evidence.eventAt).when }) : null,
    view.stale ? t('summaryStale') : null,
  ].filter((part) => part !== null);

  return (
    <div data-evidence={evidence.state} data-stale={view.stale ? 'true' : 'false'}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-0.5 mb-1 ml-[27px] flex w-[calc(100%-27px)] items-center gap-1.5 rounded-(--radius-control) py-(--spacing-control-y-2) pr-(--spacing-control-x-6) pl-(--spacing-control-x-2) text-left font-sans text-xs leading-snug text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none @max-[30rem]:ml-0 @max-[30rem]:w-full"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <b className="shrink-0 font-semibold whitespace-nowrap text-(--el-text)">
          {open ? t('hide') : t('show')}
        </b>
        <span className="min-w-0 truncate" data-testid="evidence-summary">
          {summaryParts.map((part, i) => (
            <span key={i}>· {part} </span>
          ))}
        </span>
      </button>
      {open ? (
        <div
          className="mt-1 mb-1.5 ml-[27px] flex flex-col gap-3 rounded-(--radius-control) border border-(--el-border-soft) bg-(--el-card) p-(--spacing-control-x-12) @max-[30rem]:ml-0"
          data-testid="evidence-block"
        >
          {view.stale && evidence.lastFailedAt ? (
            <div className={QUIET_LINE} data-evidence-block="stale">
              <TriangleAlert
                className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-warning)"
                aria-hidden
              />
              <span>
                {t.rich('stale', {
                  ...whenOf(evidence.lastFailedAt),
                  b: (chunks) => <b className="font-semibold">{chunks}</b>,
                  eventWhen: evidence.eventAt
                    ? whenOf(evidence.eventAt).when
                    : whenOf(evidence.readAt ?? evidence.lastFailedAt).when,
                })}
              </span>
            </div>
          ) : null}
          {view.exception && evidence.exception ? (
            <ExceptionBlock exception={evidence.exception} />
          ) : !view.exception ? (
            <div className={QUIET_LINE} data-evidence-block="no_exception">
              <CircleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{t('noException')}</span>
            </div>
          ) : null}
          {summary.request ? (
            <div data-evidence-block="request">
              <div className={LABEL}>{t('request')}</div>
              <div className={CODE}>{summary.request}</div>
            </div>
          ) : null}
          {evidence.frames.length > 0 ? <StackTrace frames={evidence.frames} /> : null}
          {evidence.tags.length > 0 ? <Tags tags={evidence.tags} /> : null}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-(--el-border-soft) pt-2.5 font-sans text-xs text-(--el-text-secondary)">
            <span>
              {evidence.eventAt
                ? t.rich('latestEvent', whenOf(evidence.eventAt))
                : t.rich('latestEvent', { when: '', t: () => null })}
            </span>
            {evidence.eventId ? (
              <span className="inline-flex items-center gap-1 text-(--el-text-identifier)">
                {t('eventId', {
                  id: `${evidence.eventId.slice(0, 12)}${evidence.eventId.length > 12 ? '…' : ''}`,
                })}
                <CopyEventId id={evidence.eventId} />
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
