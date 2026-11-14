'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CornerDownRight,
  GitMerge,
  Hourglass,
  ListTree,
  MessageSquareText,
  PenLine,
  RotateCcw,
  ScanSearch,
  SearchCheck,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import type { PlanChangeProgress } from '@/lib/hooks/usePlanChangeConversation';
import {
  continuesRecord,
  isSessionStep,
  isStep,
  latestRowAnnouncement,
  nextAnnouncement,
  openSteps,
} from '@/components/planning/planCallLines';
import { nextHeadAnnouncement, type NarrationHeadLine } from '@/components/planning/planNarration';

type Tc = ReturnType<typeof useTranslations>;

/** One glyph per act kind — the second, non-textual skim cue (sheet 3).
 *  Keyed on the KIND so the map is exhaustive by type: a new `PlanChangeProgress`
 *  member without a glyph does not compile, which is the same discipline the
 *  frame dispositions use one layer down. */
const ACT_GLYPH: Record<PlanChangeProgress['kind'], typeof Send> = {
  submitted: Send,
  starting: Hourglass,
  reading: ScanSearch,
  redirected: CornerDownRight,
  laying: ListTree,
  authoring: PenLine,
  // MOTIR-11256: an amend merges a level's hand-offs into its written cards; the final
  // check is the design's Checking glyph (MOTIR-11253 §31); the fix mends what it found.
  amending: GitMerge,
  checking: SearchCheck,
  repairing: Wrench,
  note: MessageSquareText,
  proposed: Sparkles,
  validating: ShieldCheck,
};

function ActGlyph({ act }: { act: PlanChangeProgress }) {
  const Icon = ACT_GLYPH[act.kind];
  return <Icon className="size-3.5" aria-hidden="true" />;
}

/** The mono LABEL column's catalog key. */
function actLabelKey(act: PlanChangeProgress): string {
  return `act.${act.kind}`;
}

/** The line one act reads as. Every string is a catalog key; the only values
 *  interpolated are the frame's own data. */
export function actLine(act: PlanChangeProgress, tc: Tc): string {
  switch (act.kind) {
    case 'laying':
      return tc('act.layingLine', { target: act.target ?? '' });
    case 'authoring':
      return tc('act.authoringLine', { title: act.title ?? '' });
    case 'amending':
      return act.target !== null
        ? tc('act.amendingLine', { target: act.target })
        : tc('act.amendingTopLine');
    case 'checking':
      return tc('act.checkingLine');
    case 'repairing':
      return tc('act.repairingLine');
    // ⚠️ THE PLANNER'S OWN WORDS, rendered verbatim rather than through a
    // catalog string — it is prose the model wrote about the act it just took,
    // and there is nothing to translate.
    case 'note':
      return act.text;
    case 'proposed':
      return tc('progress.proposed', { count: act.count });
    default:
      return tc(`progress.${act.kind}`, { count: 0 });
  }
}

/** The text the running bar repeats while a run streams: the newest act the
 *  record draws, or null when there is none. */
export function runningBarLine(acts: readonly PlanChangeProgress[], tc: Tc): string | null {
  const last = acts[acts.length - 1];
  return last ? actLine(last, tc) : null;
}

/**
 * THE ACT RECORD (MOTIR-4069, amended by MOTIR-7975 and by MOTIR-8064) — an
 * accumulating record, not a replacing line. Three columns per act row: glyph ·
 * mono act label · the line (`design/ai-chat/plan-change-run-live.mock.html`
 * sheet 3).
 *
 * ⚠️ THE SKIM AXIS IS THE MIDDLE COLUMN, NOT COLOUR. Every act line is the same
 * ink; what a reader runs their eye down is a fixed-width column of short mono
 * words, with the glyph as a second, non-textual cue.
 *
 * ⚠️ NO TOOL-CALL LINES. `design/ai-chat/design-notes.md` § "⭐ Planner narration
 * in the chat panel" (MOTIR-8061) amends MOTIR-7975's § "The per-call line on the
 * planning rail": the `CallLine` rows, the step disclosure that folded them and
 * the open step's earlier-calls row are gone for both planners, and a failed or
 * refused call's mark is dropped. The run rows a stream still produces stay. When
 * the plan's narration names its sessions (`sessionHeads`), the stream's `laying`
 * / `authoring` rows are not drawn either: the session heads replace them, from
 * the store.
 *
 * The one `aria-live="polite"` region (`plan-change-progress`) holds only an
 * `sr-only` announcer: replaced when a row is appended, and — from the narration's
 * group heads (`heads`) — when a session's group first appears, its step words
 * change, or it ends. A narration sentence is never announced. The record `<ol>`
 * is its next sibling, ordinary content of the transcript's `role="log"`.
 *
 * ⚠️ THE AUTOMATIC RESUME'S ROW (Story MOTIR-8301 · MOTIR-8309; design Part
 * XXVII §27.7). A plan Motir resumed by itself after its machine was lost opens
 * its record with ONE quiet act row saying so. It is drawn from the plan's
 * progress (`autoResume`, the session's own record), not from the stream, so a
 * reload draws it too; the new job's acts append below it. It is not a stream
 * act, so the announcer does not say it.
 */
export function PlanActRecord({
  acts: allActs,
  streaming,
  sessionHeads = false,
  heads = NO_HEADS,
  autoResume = null,
}: {
  acts: readonly PlanChangeProgress[];
  streaming: boolean;
  /** The narration's session heads stand in for the stream's step rows. */
  sessionHeads?: boolean;
  /** The narration's group heads, in words, for the announcer. */
  heads?: readonly NarrationHeadLine[];
  /** The session's latest automatic resume, when the plan has one. */
  autoResume?: { count: number } | null;
}) {
  const tc = useTranslations('planningWorkspace.conversation');
  const acts = allActs;
  const said = useAnnouncer(acts, heads, tc);
  const open = openSteps(acts, streaming);
  const lastIndex = acts.length - 1;
  // The newest act that is not a step (a note, a lookup row, a debug turn's
  // act): an open step BEFORE it no longer carries the spinner.
  let lastPlainRow = -1;
  acts.forEach((act, i) => {
    if (!isStep(act)) lastPlainRow = i;
  });
  const drawn = acts.flatMap((act, index) =>
    sessionHeads && isSessionStep(act) ? [] : [{ act, index }],
  );

  return (
    <>
      <div aria-live="polite" data-testid="plan-change-progress">
        <p className="sr-only" data-testid="plan-change-announcer">
          {said}
        </p>
      </div>
      {drawn.length > 0 || autoResume ? (
        <ol
          data-testid="plan-change-acts"
          className="flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
        >
          {autoResume ? <ResumedRow second={autoResume.count === 2} tc={tc} /> : null}
          {drawn.map(({ act, index }) => {
            // The newest act is live while the run streams; an open step carries
            // the spinner on its own row until a row that is not a step follows it.
            const live =
              streaming &&
              (isStep(act) ? open.has(index) && index > lastPlainRow : index === lastIndex);
            return <ActRow key={`${act.kind}-${index}`} act={act} live={live} tc={tc} />;
          })}
        </ol>
      ) : null}
    </>
  );
}

const NO_HEADS: readonly NarrationHeadLine[] = [];

function ResumedRow({ second, tc }: { second: boolean; tc: Tc }) {
  return (
    <li
      data-testid="plan-change-act-resumed"
      className="flex items-start gap-2 text-xs text-(--el-text-secondary)"
    >
      <span className="mt-px shrink-0 text-(--el-text-secondary)">
        <RotateCcw className="size-3.5" aria-hidden="true" />
      </span>
      <span className="mt-px w-16 shrink-0 font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
        {tc('act.resumed')}
      </span>
      <span className="min-w-0 flex-1">
        {tc(second ? 'act.resumedLineSecond' : 'act.resumedLine')}
      </span>
    </li>
  );
}

function ActRow({ act, live, tc }: { act: PlanChangeProgress; live: boolean; tc: Tc }) {
  return (
    <li
      data-testid={`plan-change-act-${act.kind}`}
      className={`flex items-start gap-2 text-xs ${
        live ? 'text-(--el-text)' : 'text-(--el-text-secondary)'
      }`}
    >
      {live ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : (
        <span className="mt-px shrink-0 text-(--el-text-secondary)">
          <ActGlyph act={act} />
        </span>
      )}
      <span className="mt-px w-16 shrink-0 font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
        {tc(actLabelKey(act))}
      </span>
      <span className="min-w-0 flex-1">{actLine(act, tc)}</span>
    </li>
  );
}

/**
 * What the live region says, carried across renders: replaced only when a row is
 * appended or a head changes, never on an unrelated re-render. Compared by
 * content, not identity: a host that hands the record as `[progress]` builds a
 * new array on every render, and that is not a change.
 */
function useAnnouncer(
  acts: readonly PlanChangeProgress[],
  heads: readonly NarrationHeadLine[],
  tc: Tc,
): string {
  const [said, setSaid] = useState(() => {
    const index = latestRowAnnouncement(acts);
    return { acts, heads, text: index === null ? '' : actLine(acts[index]!, tc) };
  });
  const actsChanged =
    said.acts.length !== acts.length || said.acts.some((act, i) => act !== acts[i]);
  const headsChanged =
    said.heads.length !== heads.length ||
    said.heads.some((h, i) => h.line !== heads[i]!.line || h.live !== heads[i]!.live);
  if (actsChanged || headsChanged) {
    const row = actsChanged ? nextAnnouncement(said.acts, acts) : null;
    const head = headsChanged ? nextHeadAnnouncement(said.heads, heads) : null;
    let text = continuesRecord(said.acts, acts) ? said.text : '';
    if (row !== null) text = actLine(acts[row]!, tc);
    if (head !== null) {
      text = head.finished ? tc('narration.groupFinished', { step: head.line }) : head.line;
    }
    setSaid({ acts, heads, text });
  }
  return said.text;
}
