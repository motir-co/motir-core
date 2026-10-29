'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CircleX, Copy, TriangleAlert, Undo2 } from 'lucide-react';
import { relativeLabel, RepairRunLink } from '@/components/github/RepairFixPart';
import {
  ContinueHostedAnswer,
  ContinueHostedButtonRow,
} from '@/components/hosted/ContinueHostedControl';
import { useContinueHosted } from '@/components/hosted/useContinueHosted';
import {
  FixHostedAnswer,
  FixHostedButtonRow,
  useFixHosted,
} from '@/components/hosted/FixHostedControl';
import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';
import { isReviewSentBack } from '@/lib/workItems/reviewSentBack';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/lib/utils/cn';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import { formatRunInstant } from '@/lib/runs/runClock';

// THE FIX LINE — line 2 of a To fix row (Story MOTIR-6588 · MOTIR-6605), built to
// `design/workbench/design-notes.md` § 30, Panel 2 (and Panel 3 for a HELD row).
//
// LEFT, WHY: one glyph and one sentence, read from `fixReason` + `fixDetail`. RIGHT,
// WHAT REPAIRS IT: the command chip and an always-visible copy button.
//
// ⚠️ THE COMMAND COMES FROM `fixDetail.repair`, NEVER FROM THE REASON. Every review
// refusal — the review agent's, a person's Request changes on the approve-to-merge gate,
// an acceptance Re-run — is `fix` since MOTIR-6822 (`approval-gates.md` §12.7), because
// `motir fix` claims it; a dead run is `continue`. Deriving the verb from the reason would
// print the wrong command on exactly the rows where the two differ.
//
// ⚠️ A REFUSAL THE REVIEW AGENT WROTE NAMES THE AGENT (MOTIR-6825; § 32): *Sent back by the
// review agent — "{first findings line}"*, keyed by `fixDetail.gate`, never the run's
// attributed user.
//
// ⚠️ THE REASON LINE IS NOT THE CI BADGE. The badge on line 1 is a glyph about the
// checks; this is a sentence about why the card is stuck. A conflicted, queue-failed
// or sent-back card usually has green checks and no badge — which is why this line
// never rests on colour: every reason is words.

/**
 * The repair command a row offers — the only place the verb is decided. Null for a dead
 * run that pushed nothing (`none`): there is no branch to continue, and a command the
 * claim would refuse (`no_branch`) is a trap (§ 31, state 4). A continue names the card
 * the claim takes — the PARENT's key for a leg of a parent run.
 */
export function fixCommandOf(detail: FixDetailDto, key: string): string | null {
  if (detail.repair === 'none') return null;
  if (detail.repair === 'continue') return `motir continue ${detail.continueKey ?? key}`;
  return `motir ${detail.repair} ${key}`;
}

type Translate = ReturnType<typeof useTranslations<'workbench'>>;

/** What a sentence needs beyond the detail: the row's own key, and the one clock its
 *  relative times read (read once per mount — a label that moved between renders
 *  would be a hydration mismatch). */
interface SentenceContext {
  itemKey: string;
  when: (iso: string) => (chunks: ReactNode) => ReactNode;
}

const mono = (chunks: ReactNode) => (
  <b className="font-mono font-semibold whitespace-nowrap">{chunks}</b>
);
const plainBold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

/** The queue reasons § 30 humanises; any other falls to the bare sentence. */
const HUMANISED_QUEUE_REASONS = new Set([
  'CI_FAILURE',
  'CI_TIMEOUT',
  'MERGE_CONFLICT',
  'INVALID_MERGE_COMMIT',
]);

/**
 * The sentence for each reason — a TOTAL map over `WorkItemFixReasonDto` with no
 * default branch, so a fifth reason (the dead-run story adds one) is a type error
 * here until somebody draws it.
 */
const REASON_SENTENCE: Readonly<
  Record<WorkItemFixReasonDto, (t: Translate, d: FixDetailDto, c: SentenceContext) => ReactNode>
> = {
  // § 31: the six endings fold into *last heard from*; the branch, or *nothing was
  // pushed*; then the repositories clause and the parent clause, both secondary.
  run_died: (t, d, c) => {
    if (!d.lastHeardAt) return t('toFix.reason.runDiedBare');
    const when = c.when(d.lastHeardAt);
    const main = !d.pushed
      ? d.ranByName
        ? t.rich('toFix.reason.runDiedNothingPushed', { when, name: d.ranByName })
        : t.rich('toFix.reason.runDiedNothingPushedNoName', { when })
      : d.branch
        ? d.ranByName
          ? t.rich('toFix.reason.runDied', { when, name: d.ranByName, branch: d.branch, d: mono })
          : t.rich('toFix.reason.runDiedNoName', { when, branch: d.branch, d: mono })
        : t('toFix.reason.runDiedBare');
    const more = (d.branches?.length ?? 0) - 1;
    // ⚠️ NO *Part of {parent}'s run* CLAUSE ANY MORE (MOTIR-7589; § 34.3 retires § 31
    // state 3): a leg of a dead parent run is a MEMBER of the parent's entry now, never a
    // row of its own, so the head this line belongs to is the card the repair runs on.
    return (
      <>
        {main}
        {more > 0 ? (
          <span
            className="text-(--el-text-secondary)"
            title={d
              .branches!.map((b) => [b.repository, b.branch].filter(Boolean).join(' · '))
              .join('\n')}
          >
            {' '}
            {t('toFix.reason.runDiedMoreRepositories', { count: more })}
          </span>
        ) : null}
      </>
    );
  },
  // `check` → the humanised `queueReason` → the bare sentence (§ 30's fallback order).
  queue_failed: (t, d) => {
    if (d.check) return t.rich('toFix.reason.queueFailed', { detail: d.check, d: mono });
    if (d.queueReason && HUMANISED_QUEUE_REASONS.has(d.queueReason)) {
      return t.rich('toFix.reason.queueFailed', {
        detail: t(`toFix.queueReason.${d.queueReason}` as 'toFix.queueReason.CI_FAILURE'),
        d: plainBold,
      });
    }
    return t('toFix.reason.queueFailedBare');
  },
  conflicted: (t, d) =>
    d.base
      ? t.rich('toFix.reason.conflicted', { base: d.base, d: mono })
      : t('toFix.reason.conflictedNoBase'),
  out_of_date: (t, d) =>
    d.base
      ? t.rich('toFix.reason.outOfDate', { base: d.base, d: mono })
      : t('toFix.reason.outOfDateNoBase'),
  ci_failed: (t, d) =>
    d.check
      ? t.rich('toFix.reason.ciFailed', { check: d.check, d: mono })
      : t('toFix.reason.ciFailedBare'),
  changes_requested: (t, d) => {
    if (d.gate === 'agent_review') {
      return d.notePreview
        ? t.rich('toFix.reason.sentBackByAgent', { note: d.notePreview, b: plainBold })
        : t.rich('toFix.reason.sentBackByAgentNoNote', { b: plainBold });
    }
    if (!d.reviewerName) return t('toFix.reason.changesRequestedAnon');
    return d.notePreview
      ? t.rich('toFix.reason.changesRequested', {
          name: d.reviewerName,
          note: d.notePreview,
          b: plainBold,
        })
      : t.rich('toFix.reason.changesRequestedNoNote', { name: d.reviewerName, b: plainBold });
  },
};

/** The glyph each reason wears — `RepairFixPart`'s pairing: a failure is `CircleX` in
 *  danger-on-surface, a refusal is `Undo2`, muted, because a refusal is not a failure.
 *  A dead run wears the run-died marker's own `TriangleAlert`, muted: nothing about
 *  the work failed, the run stopped and the work is kept (§ 31). */
function ReasonGlyph({ reason }: { reason: WorkItemFixReasonDto }) {
  if (reason === 'run_died') {
    return <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />;
  }
  return reason === 'changes_requested' ? (
    <Undo2 className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" aria-hidden />
  ) : (
    <CircleX className="h-3.5 w-3.5 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
  );
}

/** The copy button — `ReadyList`'s icon-button, ALWAYS visible here (§ 30: the command
 *  is the answer the row exists to give, and a touch screen cannot hover). Raised above
 *  the row's stretched link, so pressing it copies and does not open the card. */
function CopyFixCommand({
  command,
  itemKey,
  ariaLabel,
}: {
  command: string;
  itemKey: string;
  ariaLabel?: string;
}) {
  const t = useTranslations('workbench');
  const { toast } = useToast();
  const copy = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      await navigator.clipboard.writeText(command);
      toast({
        variant: 'success',
        title: t('toFix.toast.title'),
        description: t('toFix.toast.body', { command }),
      });
    },
    [command, t, toast],
  );
  return (
    <Tooltip
      content={t.rich('toFix.copyTooltip', {
        command,
        cmd: (chunks) => <code className="font-mono">{chunks}</code>,
      })}
    >
      <button
        type="button"
        onClick={copy}
        aria-label={ariaLabel ?? t('toFix.copyAria', { key: itemKey })}
        data-testid={`workbench-fix-copy-${itemKey}`}
        className="inline-flex h-(--height-control) w-(--height-control) shrink-0 items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) transition-colors hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        <Copy className="h-4 w-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

/** The command chip and its copy button — § 30's command part, reused by To resume's
 *  *Ready to resume* (§ 35.5) with its own accessible name. */
export function FixCommand({
  command,
  itemKey,
  ariaLabel,
}: {
  command: string;
  itemKey: string;
  ariaLabel?: string;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-mono text-(--el-code-text)">
        {command}
      </code>
      <CopyFixCommand command={command} itemKey={itemKey} ariaLabel={ariaLabel} />
    </span>
  );
}

const keyBold = (chunks: ReactNode) => <b className="font-semibold text-(--el-text)">{chunks}</b>;

export function WorkbenchFixLine({
  itemKey,
  reason,
  detail,
  carried = null,
  held,
  canContinueHosted = false,
  viewerId = null,
  onStarted,
  onStateMoved,
  canFixHosted = false,
  repairRun = null,
}: {
  /**
   * *FIX ON THE HOSTED AGENT* (MOTIR-6930; `design/workbench` § 32 Panel 2): a row a REVIEW
   * sent back whose viewer may run the card hosted (`homeService.listToFix` decided it).
   * The door LEADS the command in § 31's repairs slot; its answer takes the notice slot.
   */
  canFixHosted?: boolean;
  /** The row's OPEN repair (MOTIR-6930) — the lock. A hosted one replaces the door and the
   *  command with *Being fixed on the hosted agent by …*; a local one withdraws the door
   *  and keeps the command. */
  repairRun?: OpenRepairRunDto | null;
  itemKey: string;
  reason: WorkItemFixReasonDto;
  detail: FixDetailDto;
  /**
   * The OTHER cards stuck in this entry (MOTIR-7589; § 34.3) — drawn as one clause after
   * the reason: *· 5 more work items in this run* / *· 2 more work items on the same pull
   * request*. Null, or a count of 0, draws nothing: a card alone is § 30's row unchanged.
   */
  carried?: { kind: 'run' | 'prs'; count: number } | null;
  /** The card left the To fix set while the reader looked (§ 30 Panel 3). */
  held: boolean;
  /** A dead run the viewer may continue: the row places Continue hosted (§ 31). */
  canContinueHosted?: boolean;
  /** The session's user — a `taken` refusal naming them reads *you*. */
  viewerId?: string | null;
  /** The continue started — the list re-reads the page, and the row goes HELD. */
  onStarted?: () => void;
  /** A refusal that means the row's view is stale (C5a) — the list re-reads it. */
  onStateMoved?: () => void;
}) {
  const t = useTranslations('workbench');
  const tContinue = useTranslations('github.development.continue');
  const locale = useLocale();
  const [clock] = useState(() => Date.now());
  const context: SentenceContext = {
    itemKey,
    when: (iso) =>
      function FixWhen() {
        return (
          <time className="whitespace-nowrap" dateTime={iso} title={formatRunInstant(iso, locale)}>
            {relativeLabel(iso, locale, clock)}
          </time>
        );
      },
  };
  const command = fixCommandOf(detail, itemKey);
  const dead = reason === 'run_died';
  const continueKey = detail.continueKey ?? itemKey;
  // § 31's door rule: a dead run with a branch to continue, and a viewer who may edit.
  // The server decided the permission (`homeService.listToFix`); the repair decides
  // whether there is anything to continue.
  const hostedTarget =
    dead && detail.repair === 'continue' && canContinueHosted ? continueKey : null;
  // THE PRESS LIVES ON THE ROW, not in a child that unmounts when the row goes HELD:
  // a C5a refusal (the state moved) holds the row AND must stay on it (§ 31 state 6).
  const press = useContinueHosted(hostedTarget, { onStarted, onStateMoved });
  // § 32: the hosted repair on a sent-back row — a review's refusal only, and never while
  // a repair is open. Its press lives on the row too, so its answer survives a re-read.
  const reviewSentBack = isReviewSentBack(reason, detail);
  const hostedRepair = reviewSentBack && repairRun?.hosted ? repairRun : null;
  const fixTarget = reviewSentBack && canFixHosted && !repairRun ? itemKey : null;
  const fixPress = useFixHosted(fixTarget, { onStarted, onStateMoved });

  let repairs: ReactNode = null;
  if (held) {
    /* HELD (§ 26 as widened by § 30): the command is replaced by the colourless
       chip. *Cleared*, not *Repaired* — the nudge says the card LEFT the set, not
       why, and an archive clears it too. The row still opens. */
    repairs = <Pill tone="neutral">{t('live.cleared')}</Pill>;
  } else if (dead && detail.repair === 'none') {
    // § 31 state 4 — nothing pushed: the marker's own start-over line, no command.
    repairs = (
      <p
        data-testid={`workbench-fix-start-over-${itemKey}`}
        className="text-xs text-(--el-text-secondary)"
      >
        {tContinue.rich('startOver', { target: continueKey, b: keyBold })}
      </p>
    );
  } else if (dead && detail.repair === 'continue' && !canContinueHosted) {
    // § 31 state 5 — the viewer may not edit: `claimContinue` would refuse the
    // command too, so neither repair is offered.
    repairs = (
      <p
        data-testid={`workbench-fix-cannot-edit-${itemKey}`}
        className="text-xs text-(--el-text-secondary)"
      >
        {t('toFix.reason.runDiedCannotEdit')}
      </p>
    );
  } else if (hostedRepair) {
    // § 32, running: the door and the command give way to one sentence naming who pressed
    // and the hosted run's link (§ 31's sentence-in-the-command's-place grammar).
    repairs = (
      <p
        data-testid={`workbench-fix-hosted-fixing-${itemKey}`}
        className="relative z-10 text-xs text-(--el-text-secondary)"
      >
        {t.rich(hostedRepair.byViewer ? 'toFix.fixingHostedByYou' : 'toFix.fixingHosted', {
          name: hostedRepair.holder?.name ?? '—',
          label: hostedRepair.label,
          b: keyBold,
          run: (chunks) => <RepairRunLink runId={hostedRepair.id}>{chunks}</RepairRunLink>,
        })}
      </p>
    );
  } else if (command !== null) {
    repairs = (
      <span className="relative z-10 flex flex-wrap items-center justify-end gap-2">
        {/* § 31: Continue hosted leads; the command keeps the right edge. § 32: so does
         *Fix on the hosted agent* on a row a review sent back (MOTIR-6930). */}
        {fixTarget ? (
          <FixHostedButtonRow
            starting={fixPress.starting}
            onPress={() => void fixPress.start()}
            refused={fixPress.refusal?.kind === 'noCapacity'}
          />
        ) : null}
        {hostedTarget ? (
          <ContinueHostedButtonRow
            continueTarget={hostedTarget}
            itemKey={itemKey}
            starting={press.starting}
            onPress={() => void press.start()}
            refused={press.refusal?.kind === 'noCapacity'}
          />
        ) : null}
        <FixCommand command={command} itemKey={itemKey} />
      </span>
    );
  }

  return (
    <div
      data-testid={`workbench-fix-${itemKey}`}
      data-fix-reason={reason}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-6 text-xs"
    >
      <p
        className={cn(
          'flex min-w-0 items-center gap-1.5',
          held ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
        )}
      >
        {/* A held row drops its glyph (§ 30 Panel 3): it is a receipt, not a failure. */}
        {held ? null : <ReasonGlyph reason={reason} />}
        <span className="min-w-0 truncate">{REASON_SENTENCE[reason](t, detail, context)}</span>
        {/* THE ENTRY CLAUSE (§ 34.3) — how many other cards this one repair clears. */}
        {carried && carried.count > 0 ? (
          <span
            className="shrink-0 text-(--el-text-secondary)"
            data-testid={`workbench-fix-carries-${itemKey}`}
          >
            {' · '}
            {t(
              carried.kind === 'run' ? 'toFix.entry.carriesRun' : 'toFix.entry.carriesPullRequests',
              { count: carried.count },
            )}
          </span>
        ) : null}
        {/* The affected clause — only for a card delivering more than one pull request. */}
        {detail.total > 1 ? (
          <span className="shrink-0 text-(--el-text-secondary)">
            {' · '}
            {t('toFix.affected', { affected: detail.affected, total: detail.total })}
          </span>
        ) : null}
      </p>
      {repairs}
      {/* § 31 state 6: the door's answer takes a full-width slot under the repairs,
          and a refusal stays on a HELD row, because it answers the press. The model
          notices belong to a live door only. */}
      {hostedTarget ? (
        <div className="relative z-10 basis-full empty:hidden">
          <ContinueHostedAnswer
            continueTarget={held ? null : hostedTarget}
            refusal={press.refusal}
            viewerId={viewerId}
          />
        </div>
      ) : null}
      {/* § 32: the hosted repair's answer in the same notice slot — a refusal stays on a
          HELD row, because it answers the press; the model notices need a live door. */}
      {fixTarget || fixPress.refusal ? (
        <div className="relative z-10 basis-full empty:hidden">
          <FixHostedAnswer
            live={!held && fixTarget !== null}
            refusal={fixPress.refusal}
            viewerId={viewerId}
          />
        </div>
      ) : null}
    </div>
  );
}
