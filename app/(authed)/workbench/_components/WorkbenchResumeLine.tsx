'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleEllipsis,
  CirclePause,
  CircleSlash,
  Clock,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { relativeLabel, RepairRunLink } from '@/components/github/RepairFixPart';
import {
  ContinueHostedAnswer,
  ContinueHostedButtonRow,
} from '@/components/hosted/ContinueHostedControl';
import { useContinueHosted } from '@/components/hosted/useContinueHosted';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { withApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { formatRunInstant } from '@/lib/runs/runClock';
import { cn } from '@/lib/utils/cn';
import { FixCommand } from './WorkbenchFixLine';
import type { ResumeReshapePlanDto } from '@/lib/dto/home';
import type { WorkbenchResumeGateView, WorkbenchResumeView } from './workbenchRows';

// THE TO RESUME ENTRY'S LINES (Story MOTIR-7701 · MOTIR-7712), built to
// `design/workbench/design-notes.md` § 35.4–35.6 and its mock
// `workbench--to-resume.mock.html`. Under line 1 (the head card's row, unchanged):
//
//   · LINE 2 — `WorkbenchFixLine`'s line with a calm reason: the state's glyph, the
//     sentence, an optional state pill, the aside (who ran it and where, the branch,
//     how many more cards wait with it), and the repairs on the right;
//   · THE GATE LIST — one line per held gate, with its door into the approval overlay;
//   · THE NEXT-STEP LINE — what happens next, per state.
//
// ⚠️ THE TONE IS CALM EVERYWHERE (§ 35.5): no danger or warning ink, no alert glyph.
// These runs are waiting, not broken — a died run stays on To fix.
//
// ⚠️ THE STATE IS READ, NOT DECIDED HERE. `resumeState` (MOTIR-7707) says waiting or
// ready; the newest automatic attempt (MOTIR-7710) says Resuming or Could not resume;
// a held gate that was refused says Sent back. The repairs follow the continue claim's
// own refusals (MOTIR-7708): it refuses `gate_awaiting` and `gate_sent_back`, so
// neither state offers one.

/** The five states § 35.5 draws. */
export type ResumeLineState = 'waiting' | 'ready' | 'resuming' | 'couldNot' | 'sentBack';

const SENT_BACK = new Set(['changes_requested', 'declined', 'overturned']);

/** Which of the five states an entry is in — § 35.5's *read from* column, in order. */
export function resumeLineStateOf(resume: WorkbenchResumeView): ResumeLineState {
  if (resume.attempt?.outcome === 'started' || resume.attempt?.skipReason === 'already_resumed') {
    return 'resuming';
  }
  if (resume.state === 'ready_to_resume') {
    return resume.attempt?.outcome === 'skipped' ? 'couldNot' : 'ready';
  }
  return resume.gates.some((g) => SENT_BACK.has(g.state)) ? 'sentBack' : 'waiting';
}

type Translate = ReturnType<typeof useTranslations<'workbench'>>;

const mono = (chunks: ReactNode) => (
  <b className="font-mono font-semibold whitespace-nowrap">{chunks}</b>
);
const bold = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;

/** A state pill (§ 35.7 `tr-state--*`): the hue in the tint, the ink strong. */
export function StatePill({
  tone,
  icon,
  children,
  testId,
}: {
  tone: 'waiting' | 'ready' | 'resuming' | 'quiet';
  icon?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-medium',
        tone === 'waiting' && 'border-transparent bg-(--el-tint-yellow) text-(--el-text-strong)',
        tone === 'ready' && 'border-transparent bg-(--el-tint-mint) text-(--el-text-strong)',
        tone === 'resuming' && 'border-transparent bg-(--el-tint-sky) text-(--el-text-strong)',
        tone === 'quiet' &&
          'border-(--el-chip-border) bg-(--el-chip-bg) text-(--el-text-secondary)',
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** A gate's state in words (§ 35.6 `workbench.toResume.gate.*`): an approval names
 *  what was given — a choice is *Chosen*, a confirmation *Confirmed*, manual work
 *  *Marked done*. */
function gateStateLabel(t: Translate, gate: WorkbenchResumeGateView, viewerDecides: boolean) {
  switch (gate.state) {
    case 'approved':
      if (gate.kind === 'decision_choice') return t('toResume.gate.chosen');
      if (gate.kind === 'decision_confirmation') return t('toResume.gate.confirmed');
      if (gate.kind === 'manual_work') return t('toResume.gate.markedDone');
      return t('toResume.gate.approved');
    case 'changes_requested':
      return t('toResume.gate.changesRequested');
    case 'declined':
      return t('toResume.gate.declined');
    case 'overturned':
      return t('toResume.gate.overturned');
    default:
      return viewerDecides ? t('toResume.gate.awaitingYou') : t('toResume.gate.awaiting');
  }
}

/** The shipped kind label (`workbench.approvals.kind.*`), lower-cased for running text. */
export function kindLabel(
  t: Translate,
  kind: WorkbenchResumeGateView['kind'],
  lower = false,
): string {
  const label = t(`approvals.kind.${kind}` as 'approvals.kind.design_result');
  return lower ? label.toLowerCase() : label;
}

/** The door into the approval overlay (§ 35.4): the viewer's own decision is a primary
 *  *Review* (or *Guide me through* for manual work), anyone else's an *Open* link. Both
 *  `shallowPush` the overlay's address over this tab. */
function GateDoor({
  gate,
  viewerDecides,
}: {
  gate: WorkbenchResumeGateView;
  viewerDecides: boolean;
}) {
  const t = useTranslations('workbench');
  const tGuide = useTranslations('runs.guide');
  const pathname = usePathname();
  const params = useSearchParams();
  const qs = params.toString();
  const href = withApprovalOverlay(`${pathname}${qs ? `?${qs}` : ''}`, {
    itemKey: gate.subjectKey,
    kind: gate.kind,
  });
  const open = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    shallowPush(href);
  };
  if (viewerDecides && gate.state === 'awaiting') {
    return (
      <Button
        size="sm"
        variant="primary"
        onClick={open}
        data-testid={`workbench-resume-gate-review-${gate.subjectKey}`}
      >
        {gate.kind === 'manual_work' ? tGuide('door') : t('toResume.review')}
      </Button>
    );
  }
  return (
    <a
      href={href}
      onClick={open}
      data-testid={`workbench-resume-gate-open-${gate.subjectKey}`}
      className="relative z-10 font-medium text-(--el-link) hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
    >
      {t('toResume.open')}
    </a>
  );
}

export function GateList({
  headKey,
  gates,
  viewerId,
  when,
  label,
}: {
  headKey: string;
  gates: WorkbenchResumeGateView[];
  viewerId: string | null;
  when: (iso: string) => (chunks: ReactNode) => ReactNode;
  /** The list's accessible name; the To resume entry's *Gates holding {key}'s run* by default. */
  label?: string;
}) {
  const t = useTranslations('workbench');
  if (gates.length === 0) return null;
  return (
    // The list never folds: a gate is why the entry is here (§ 35.4).
    <ul
      aria-label={label ?? t('toResume.gatesLabel', { key: headKey })}
      data-testid={`workbench-resume-gates-${headKey}`}
      className="m-0 flex list-none flex-col gap-1 p-0 pl-6 text-xs"
    >
      {gates.map((gate) => {
        const viewerDecides = viewerId !== null && gate.deciderId === viewerId;
        const decided = gate.state !== 'awaiting';
        const tone = gate.state === 'approved' ? 'ready' : decided ? 'quiet' : 'waiting';
        return (
          <li
            key={gate.gateId}
            data-testid={`workbench-resume-gate-${gate.subjectKey}`}
            data-gate-state={gate.state}
            className="relative z-10 flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-(--el-text)"
          >
            <span className="shrink-0 rounded-(--radius-badge) border border-(--el-chip-border) bg-(--el-chip-bg) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-medium text-(--el-text-secondary)">
              {kindLabel(t, gate.kind)}
            </span>
            <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
              {gate.subjectKey}
            </span>
            <span className="max-w-[28ch] min-w-0 truncate">{gate.subjectTitle}</span>
            <span className="shrink-0 text-(--el-text-secondary)">
              {gate.state === 'approved' && gate.decidedByName && gate.decidedAt
                ? t.rich('toResume.decidedBy', {
                    name: gate.decidedById === viewerId ? t('toResume.you') : gate.decidedByName,
                    b: bold,
                    when: when(gate.decidedAt),
                  })
                : viewerDecides
                  ? t.rich('toResume.deciderYou', { b: bold })
                  : gate.deciderName
                    ? t.rich('toResume.decider', { name: gate.deciderName, b: bold })
                    : null}
            </span>
            <span className="ml-auto inline-flex items-center gap-2.5">
              <StatePill
                tone={tone}
                icon={decided ? null : <Clock className="h-3 w-3" aria-hidden />}
              >
                {gateStateLabel(t, gate, viewerDecides)}
              </StatePill>
              <GateDoor gate={gate} viewerDecides={viewerDecides} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The glyph each state wears (§ 35.5) — `--el-icon-muted`, aria-hidden: the sentence
 *  carries the meaning. */
const STATE_GLYPH: Record<ResumeLineState, typeof CirclePause> = {
  waiting: CirclePause,
  ready: CircleCheck,
  resuming: CircleEllipsis,
  couldNot: CircleSlash,
  sentBack: Undo2,
};

export function WorkbenchResumeLine({
  itemKey,
  resume,
  carried,
  held,
  canContinueHosted = false,
  viewerId = null,
  onStarted,
  onStateMoved,
}: {
  itemKey: string;
  resume: WorkbenchResumeView;
  /** How many other cards wait with the head (§ 34's *N more work items in this run*). */
  carried: number;
  /** The entry left the tab while the reader looked — Resuming's hold (§ 35.5). */
  held: boolean;
  /** The reader may continue it on the hosted agent (`homeService.listToResume`). */
  canContinueHosted?: boolean;
  viewerId?: string | null;
  onStarted?: () => void;
  onStateMoved?: () => void;
}) {
  const t = useTranslations('workbench');
  const locale = useLocale();
  const [clock] = useState(() => Date.now());
  const when = (iso: string) =>
    function ResumeWhen() {
      return (
        <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso, locale)}>
          {relativeLabel(iso, locale, clock)}
        </time>
      );
    };

  const state = resumeLineStateOf(resume);
  // A press that started a resume HOLDS the entry (§ 35.5) until the refetch drops it.
  const resumable = (state === 'ready' || state === 'couldNot') && !held;
  const hostedTarget = resumable && canContinueHosted ? itemKey : null;
  const press = useContinueHosted(hostedTarget, { onStarted, onStateMoved });

  const approved = resume.gates.filter((g) => g.state === 'approved');
  const waiting = resume.gates.filter((g) => g.state === 'awaiting');
  const refused = resume.gates.find((g) => SENT_BACK.has(g.state)) ?? null;
  const attempt = resume.attempt;
  const reshaped = resume.reshapedBy ?? [];
  const youName = (id: string | null, name: string | null) =>
    id !== null && id === viewerId ? t('toResume.you') : (name ?? t('toResume.someone'));

  // LINE 2's sentence (§ 35.6).
  let sentence: ReactNode;
  let pill: ReactNode = null;
  if (state === 'waiting') {
    sentence = t('toResume.waiting', { count: waiting.length || resume.gates.length });
  } else if (state === 'ready') {
    const first = approved[0];
    if (resume.gates.length > 1) {
      sentence = t('toResume.readySome', {
        approved: approved.length,
        total: resume.gates.length,
      });
    } else if (first && first.decidedAt) {
      sentence =
        first.decidedById !== null && first.decidedById === viewerId
          ? t.rich('toResume.readyByYou', {
              kind: kindLabel(t, first.kind, true),
              key: first.subjectKey,
              when: when(first.decidedAt),
            })
          : t.rich('toResume.ready', {
              name: first.decidedByName ?? t('toResume.someone'),
              kind: kindLabel(t, first.kind, true),
              key: first.subjectKey,
              when: when(first.decidedAt),
            });
    } else {
      sentence = t('toResume.readyBare');
    }
  } else if (state === 'resuming') {
    // Resuming is read off an attempt (`resumeLineStateOf`), so one is always here.
    sentence = attempt
      ? t.rich('toResume.resuming', { when: when(attempt.createdAt) })
      : /* v8 ignore next */ t('toResume.state.resuming');
    pill = (
      <StatePill tone="resuming" testId={`workbench-resume-state-${itemKey}`}>
        {t('toResume.state.resuming')}
      </StatePill>
    );
  } else if (state === 'couldNot') {
    const reason = skipReasonText(t, attempt, itemKey);
    sentence = t.rich('toResume.couldNot', { reason: () => reason });
    pill = (
      <StatePill tone="quiet" testId={`workbench-resume-state-${itemKey}`}>
        {t('toResume.state.couldNot')}
      </StatePill>
    );
  } else {
    sentence = sentBackSentence(t, refused);
  }

  // The NEXT-STEP line (§ 35.6 `next.*`).
  let next: ReactNode = null;
  if (state === 'waiting') {
    next =
      resume.ranWhere === 'hosted'
        ? t(
            resume.gates.length > 1
              ? 'toResume.next.waitingHostedMany'
              : 'toResume.next.waitingHosted',
          )
        : t('toResume.next.waitingLocal');
  } else if (state === 'ready') {
    next =
      waiting.length > 0
        ? t('toResume.next.readySome', { count: waiting.length })
        : t('toResume.next.ready');
  } else if (state === 'couldNot') {
    next = t.rich('toResume.next.couldNot', { repair: repairText(t, attempt, itemKey) });
  } else if (state === 'sentBack' && refused) {
    const outcome = refused.state as 'changes_requested' | 'declined' | 'overturned';
    next = t(`toResume.next.${outcome}`, { key: refused.subjectKey, head: itemKey });
  }

  // THE REPAIRS (§ 35.5): only the two states the claim would honour.
  const command = `motir continue ${itemKey}`;
  let repairs: ReactNode = null;
  if (held) {
    repairs = <Pill tone="neutral">{t('live.cleared')}</Pill>;
  } else if (state === 'resuming') {
    repairs = attempt?.resumedRunId ? (
      <span className="relative z-10 text-xs font-medium">
        <RepairRunLink runId={attempt.resumedRunId}>{t('toResume.seeRun')}</RepairRunLink>
      </span>
    ) : null;
  } else if (resumable) {
    repairs = (
      <span className="relative z-10 flex flex-wrap items-center justify-end gap-2">
        {hostedTarget ? (
          <ContinueHostedButtonRow
            continueTarget={hostedTarget}
            itemKey={itemKey}
            starting={press.starting}
            onPress={() => void press.start()}
            refused={press.refusal?.kind === 'noCapacity'}
          />
        ) : null}
        <FixCommand
          command={command}
          itemKey={itemKey}
          ariaLabel={t('toResume.copyAria', { key: itemKey })}
        />
      </span>
    );
  }

  const Glyph = STATE_GLYPH[state];
  const ranBy = t(`toResume.ranBy.${resume.ranWhere}`, {
    name: youName(resume.ranById, resume.ranByName),
    agent: resume.agentName ?? '—',
  });

  return (
    <>
      <div
        data-testid={`workbench-resume-${itemKey}`}
        data-resume-state={state}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-6 text-xs"
      >
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <span
            className={cn(
              'flex min-w-0 items-center gap-1.5',
              held ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
            )}
          >
            {held ? null : (
              <Glyph className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
            )}
            <span className="min-w-0">{sentence}</span>
          </span>
          {pill}
          <span
            className="text-(--el-text-secondary)"
            data-testid={`workbench-resume-aside-${itemKey}`}
          >
            {' · '}
            {ranBy}
            {resume.branch ? (
              <>
                {' · '}
                {t.rich('toResume.branch', { branch: resume.branch, d: mono })}
              </>
            ) : null}
            {carried > 0 ? (
              <>
                {' · '}
                {t('toFix.entry.carriesRun', { count: carried })}
              </>
            ) : null}
          </span>
        </p>
        {repairs}
        {hostedTarget ? (
          <div className="relative z-10 basis-full empty:hidden">
            <ContinueHostedAnswer
              continueTarget={hostedTarget}
              refusal={press.refusal}
              viewerId={viewerId}
            />
          </div>
        ) : null}
      </div>
      <GateList headKey={itemKey} gates={resume.gates} viewerId={viewerId} when={when} />
      {reshaped.length > 0 ? (
        <ReshapedBanner itemKey={itemKey} plans={reshaped} when={when} />
      ) : null}
      {next ? (
        <p
          data-testid={`workbench-resume-next-${itemKey}`}
          className="m-0 pl-6 text-xs leading-normal text-(--el-text-secondary)"
        >
          {next}
          {reshaped.length > 0 ? <> {t('toResume.next.reshaped')}</> : null}
        </p>
      ) : null}
    </>
  );
}

/** `{counts}` (§ 39.3): the non-zero clauses, joined — a zero clause is left out. */
export function reshapeCountsText(t: Translate, plan: ResumeReshapePlanDto): string {
  const clauses: string[] = [];
  if (plan.added > 0) clauses.push(t('toResume.reshaped.added', { n: plan.added }));
  if (plan.changed > 0) clauses.push(t('toResume.reshaped.changed', { n: plan.changed }));
  if (plan.removed > 0) clauses.push(t('toResume.reshaped.removed', { n: plan.removed }));
  return clauses.join(t('toResume.reshaped.separator'));
}

/**
 * THE RE-SHAPED BANNER (Bug MOTIR-8458; `design-notes.md` § 39.3): under the gate list,
 * above the next-step line, it names each plan approved after the run stopped that
 * re-shaped the story. One plan reads as a sentence; two or more fold behind *Show
 * plans*. Raised over the entry's stretched link like the gate lines, so each plan link
 * is its own target. No plan → no banner (the caller draws nothing).
 */
function ReshapedBanner({
  itemKey,
  plans,
  when,
}: {
  itemKey: string;
  plans: ResumeReshapePlanDto[];
  when: (iso: string) => () => ReactNode;
}) {
  const t = useTranslations('workbench');
  const tPlan = useTranslations('planReview');
  const routes = useReaderRoutes();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const planLink = (plan: ResumeReshapePlanDto) =>
    function ReshapePlanLink() {
      return (
        <Link
          href={routes.plan(plan.planId)}
          className="font-medium text-(--el-link) no-underline hover:underline focus-visible:rounded-(--radius-control) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring-color)"
        >
          {plan.title ?? tPlan('untitledPlan')}
        </Link>
      );
    };
  const aside = (chunks: ReactNode) => <span className="text-(--el-text-secondary)">{chunks}</span>;
  const counts = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;
  const line = (plan: ResumeReshapePlanDto, key: 'one' | 'planLine') =>
    t.rich(`toResume.reshaped.${key}`, {
      title: plan.title ?? tPlan('untitledPlan'),
      counts: reshapeCountsText(t, plan),
      plan: planLink(plan),
      aside,
      when: when(plan.approvedAt),
      b: counts,
    });
  const first = plans[0];
  /* v8 ignore next -- the caller draws no banner without a plan */
  if (!first) return null;
  return (
    <div className="relative z-10 pl-6" data-testid={`workbench-resume-reshaped-${itemKey}`}>
      <div
        role="group"
        aria-label={t('toResume.reshaped.label', { key: itemKey })}
        className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y) text-xs leading-normal text-(--el-text)"
      >
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          {plans.length === 1 ? (
            <p className="m-0">{line(first, 'one')}</p>
          ) : (
            <>
              <p className="m-0">
                {t.rich('toResume.reshaped.many', { count: plans.length, b: counts })}
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={listId}
                  onClick={() => setOpen((o) => !o)}
                  className="ml-1.5 inline-flex items-center gap-0.5 border-0 bg-transparent p-0 text-xs font-medium text-(--el-link) hover:underline focus-visible:rounded-(--radius-control) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring-color)"
                >
                  {open ? t('toResume.reshaped.hidePlans') : t('toResume.reshaped.showPlans')}
                  {open ? (
                    <ChevronUp className="h-3 w-3" aria-hidden />
                  ) : (
                    <ChevronDown className="h-3 w-3" aria-hidden />
                  )}
                </button>
              </p>
              <ul id={listId} hidden={!open} className="m-0 flex list-none flex-col gap-0.5 p-0">
                {plans.map((plan) => (
                  <li key={plan.planId}>{line(plan, 'planLine')}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Line 2's `{reason}` for a skipped resume (§ 35.6 `skip.<reason>`). */
export function skipReasonText(
  t: Translate,
  attempt: WorkbenchResumeView['attempt'],
  itemKey: string,
): ReactNode {
  const detail = attempt?.detail ?? '';
  switch (attempt?.skipReason) {
    case 'out_of_credits':
    case 'ci_credits_exhausted':
    case 'credits_unavailable':
    case 'models_unavailable':
      return t(`toResume.skip.${attempt.skipReason}`);
    case 'model_not_offered':
    case 'no_capacity':
      return t(`toResume.skip.${attempt.skipReason}`, { model: detail || '—' });
    case 'no_project_access':
      return t.rich('toResume.skip.no_project_access', { name: detail || '—', b: bold });
    case 'dispatcher_gone':
      return detail
        ? t.rich('toResume.skip.dispatcher_gone', { name: detail, b: bold })
        : t('toResume.skip.dispatcher_goneAnon');
    case 'repository_not_writable':
      return t('toResume.skip.repository_not_writable', { repo: detail || '—' });
    default:
      // `card_not_ready`, and the claim's own refusal (`not_resumable`).
      return t('toResume.skip.card_not_ready', { key: itemKey });
  }
}

/** The next-step line's `{repair}` (§ 35.6 `repair.<reason>`). */
function repairText(
  t: Translate,
  attempt: WorkbenchResumeView['attempt'],
  itemKey: string,
): string {
  switch (attempt?.skipReason) {
    case 'out_of_credits':
    case 'ci_credits_exhausted':
    case 'credits_unavailable':
    case 'model_not_offered':
    case 'models_unavailable':
    case 'no_project_access':
    case 'dispatcher_gone':
    case 'repository_not_writable':
    case 'no_capacity':
      return t(`toResume.repair.${attempt.skipReason}`);
    default:
      return t('toResume.repair.card_not_ready', { key: itemKey });
  }
}

/** Line 2 for a gate sent back (§ 35.6 `back.<outcome>`): the decision, quoted. */
function sentBackSentence(t: Translate, gate: WorkbenchResumeGateView | null): ReactNode {
  /* v8 ignore next -- `sentBack` is only reached with a refused gate */
  if (!gate) return null;
  const name = gate.decidedByName ?? t('toResume.someone');
  const kind = kindLabel(t, gate.kind);
  const outcome = gate.state as 'changes_requested' | 'declined' | 'overturned';
  return gate.notePreview
    ? t.rich(`toResume.back.${outcome}`, { kind, name, note: gate.notePreview, b: bold })
    : t.rich(`toResume.back.${outcome}NoNote`, { kind, name, b: bold });
}
