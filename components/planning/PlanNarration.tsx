'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  SkipForward,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import {
  SkipFinalCheckDialog,
  type SkipFinalCheckPhase,
} from '@/components/planning/SkipFinalCheckDialog';
import type { PlanNarrationSessionDto, PlanStepKindDto } from '@/lib/dto/plans';
import type { NarrationGroup, NarrationHeadLine } from '@/components/planning/planNarration';

type Tc = ReturnType<typeof useTranslations>;

/**
 * THE PLANNER'S NARRATION in the chat panel (Story MOTIR-8060 · MOTIR-8064),
 * drawn to `design/ai-chat/design-notes.md` § "⭐ Planner narration in the chat
 * panel" (MOTIR-8061) and `plan-change-run-live--narration.mock.html`.
 *
 * The planner's own sentences, one group per session under a head naming that
 * session's stored step words — live or finished, on reopen, after the plan ends
 * and for a Visitor — with one control that folds them all. Built only from the
 * stored read (`groupNarration` over `review.narration`), never from stream
 * frames, so there is nothing in memory to lose when the overlay closes.
 *
 * ⚠️ QUIET IN THE LOG. The transcript is `role="log"`, which is implicitly
 * polite, so this block carries `aria-live="off"`: a sentence is never spoken as
 * it lands. The act record's announcer stays the one live region, and says the
 * head lines instead.
 *
 * ⚠️ AS WRITTEN. A sentence and a target title are shown as stored, never through
 * `t()`, and carry `dir="auto"` with no `lang` (no field says which language a
 * sentence is in, and a wrong `lang` is worse than none).
 */

/** The per-browser collapse-all memory: global, not per plan (MOTIR-8061 panel 3). */
export const PLANNER_NOTES_STORAGE_KEY = 'motir:planning:planner-notes';

type Remembered = 'collapsed' | 'expanded';

function readRemembered(): boolean {
  try {
    return window.localStorage.getItem(PLANNER_NOTES_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

/** Another tab's choice is not followed live; the next mount reads it. */
function subscribeNever(): () => void {
  return () => {};
}

function writeRemembered(value: Remembered): void {
  try {
    window.localStorage.setItem(PLANNER_NOTES_STORAGE_KEY, value);
  } catch {
    /* storage unavailable: the choice holds for this view only */
  }
}

const KIND_LABEL: Record<PlanStepKindDto, string> = {
  settle: 'narration.kindSettle',
  lay: 'act.laying',
  author: 'act.authoring',
  amend: 'act.amending',
  check: 'act.checking',
  repair: 'act.repairing',
};

/** A marker no catalogue line contains, used to split a line around its title. */
const TITLE_SLOT = '\u0001';

/**
 * The line a head with no title to name reads as, by kind, or `null` when the kind
 * always names one. A settle names nothing; the final check's own head (not one of
 * its card sessions) and the fix name the plan's step, not a card; an amend of the
 * top level has no parent to name (MOTIR-11256).
 */
function untitledLine(session: PlanNarrationSessionDto, tc: Tc): string | null {
  switch (session.stepKind) {
    case 'settle':
      return tc('narration.settleLine');
    case 'repair':
      return tc('act.repairingLine');
    case 'check':
      return session.targetRef === null ? tc('act.checkingLine') : null;
    case 'amend':
      return session.targetRef === null ? tc('act.amendingTopLine') : null;
    default:
      return null;
  }
}

/** The titled line, with {@link TITLE_SLOT} where the stored title goes. */
function titledLine(kind: PlanStepKindDto, tc: Tc): string {
  switch (kind) {
    case 'lay':
      return tc('act.layingLine', { target: TITLE_SLOT });
    case 'amend':
      return tc('act.amendingLine', { target: TITLE_SLOT });
    case 'check':
      return tc('act.checkingCardLine', { title: TITLE_SLOT });
    default:
      return tc('act.authoringLine', { title: TITLE_SLOT });
  }
}

/** A head's line split around the stored title: `[before, title, after]`, the
 *  title `null` for a head that names none (a settle, the final check's own head,
 *  the fix, a top-level amend). Shipped act-line wording (MOTIR-8061 §One group per
 *  session), so one catalogue line serves live and finished. */
function headParts(session: PlanNarrationSessionDto, tc: Tc): [string, string | null, string] {
  const untitled = untitledLine(session, tc);
  if (untitled !== null) return [untitled, null, ''];
  const [before = '', after = ''] = titledLine(session.stepKind, tc).split(TITLE_SLOT);
  return [before, session.targetTitle ?? '', after];
}

/** A head's line as one plain string — the announcer's and the list's name. */
export function narrationHeadLine(session: PlanNarrationSessionDto, tc: Tc): string {
  const [before, title, after] = headParts(session, tc);
  return `${before}${title ?? ''}${after}`.trim();
}

/** The group heads in words, for the act record's announcer. */
export function narrationHeadLines(groups: readonly NarrationGroup[], tc: Tc): NarrationHeadLine[] {
  return groups.flatMap((group) =>
    group.session
      ? [
          {
            sessionKey: group.sessionKey,
            line: narrationHeadLine(group.session, tc),
            live: group.live,
          },
        ]
      : [],
  );
}

const DISCLOSURE_CLASS =
  'inline-flex shrink-0 items-center gap-0.5 rounded-(--radius-control) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-[11px] font-medium text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none';

/** The sticky bar's place in its scroll container, per host. `top-0` would stick
 *  below the container's top padding and leave a gap the notes show through, so
 *  the bar's negative top cancels that padding. In the chat rail the notes sit
 *  beside Motir AI's avatar, so the bar bleeds right only and never covers it. */
const BAR_INSET_CLASS = {
  rail: '-top-4 -mr-4 pr-4',
  page: '-top-5 -mx-5 px-5',
} as const;

export interface PlanNarrationProps {
  groups: readonly NarrationGroup[];
  /** Which scroll container the notes sit in: the chat rail (`p-4`, beside the
   *  avatar) or the plan review page (`p-5`). */
  inset: keyof typeof BAR_INSET_CLASS;
  /** The plan's total sentence count: the read's window plus its `earlierCount`. */
  total: number;
  /** Sentences before the earliest one in hand. */
  earlierCount: number;
  loadingEarlier?: boolean;
  onShowEarlier?: () => void;
  /**
   * SKIP THE FINAL CHECK (MOTIR-11266): the confirm's press, answering what the
   * door said. Given only on a run in flight and to a viewer holding `ai:plan`;
   * absent, no control is drawn. The control itself shows only under a LIVE
   * final-check head, and never while the fix after it runs.
   */
  onSkipCheck?: () => Promise<'skipped' | 'not_running'>;
}

/**
 * The group the Skip the final check control sits under: the first LIVE group
 * whose session is the final check (its own head or a card it is reviewing),
 * and none at all while a `repair` session is live — the fix has begun and
 * there is no check left to skip (design § "⭐ The final check" §2, When).
 */
export function skipCheckGroupKey(groups: readonly NarrationGroup[]): string | null {
  if (groups.some((g) => g.live && g.session?.stepKind === 'repair')) return null;
  return groups.find((g) => g.live && g.session?.stepKind === 'check')?.sessionKey ?? null;
}

export function PlanNarration({
  groups,
  inset,
  total,
  earlierCount,
  loadingEarlier = false,
  onShowEarlier,
  onSkipCheck,
}: PlanNarrationProps) {
  const tc = useTranslations('planningWorkspace.conversation');
  const baseId = useId();
  const fold = useFoldState();
  const skip = useSkipCheck(onSkipCheck);
  const skipKey = onSkipCheck ? skipCheckGroupKey(groups) : null;
  const { clearPending } = skip;
  // The check ended (or its fix began): a pending skip has done its work, so the
  // next run's check starts with the control again.
  useEffect(() => {
    if (skipKey === null) clearPending();
  }, [skipKey, clearPending]);
  if (groups.length === 0) return null;
  const listId = (i: number) => `${baseId}-notes-${i}`;
  const foldable = groups.flatMap((g, i) => (g.messages.length > 0 ? [{ g, i }] : []));
  const allOpen = foldable.every(({ g }) => !fold.isFolded(g.sessionKey));

  return (
    <div data-testid="plan-narration" aria-live="off" className="flex flex-col gap-1.5">
      {total > 0 ? (
        <div
          data-testid="plan-narration-bar"
          className={`sticky z-10 flex items-center gap-2 bg-(--el-surface) py-1 ${BAR_INSET_CLASS[inset]}`}
        >
          <span className="font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
            {tc('narration.label')}
          </span>
          <button
            type="button"
            aria-expanded={allOpen}
            aria-controls={foldable.map(({ i }) => listId(i)).join(' ')}
            data-testid="plan-narration-toggle-all"
            onClick={() => fold.setAll(allOpen)}
            className={`ml-auto ${DISCLOSURE_CLASS}`}
          >
            {allOpen ? (
              <ChevronsDownUp className="size-3" aria-hidden="true" />
            ) : (
              <ChevronsUpDown className="size-3" aria-hidden="true" />
            )}
            {tc(allOpen ? 'narration.hideAll' : 'narration.showAll', { count: total })}
          </button>
        </div>
      ) : null}
      {earlierCount > 0 && onShowEarlier ? (
        <button
          type="button"
          data-testid="plan-narration-earlier"
          disabled={loadingEarlier}
          onClick={onShowEarlier}
          className={`self-start ${DISCLOSURE_CLASS}`}
        >
          <ChevronUp className="size-3" aria-hidden="true" />
          {tc('narration.earlier', { count: earlierCount })}
        </button>
      ) : null}
      <ol
        data-testid="plan-narration-groups"
        className="flex flex-col gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
      >
        {groups.map((group, i) => (
          <NarrationGroupRow
            key={group.sessionKey}
            group={group}
            listId={listId(i)}
            folded={fold.isFolded(group.sessionKey)}
            onToggle={() => fold.toggle(group.sessionKey)}
            skipRow={group.sessionKey === skipKey ? skip.row(tc) : null}
            tc={tc}
          />
        ))}
      </ol>
      {onSkipCheck ? skip.dialog : null}
    </div>
  );
}

/**
 * The control, its pending row and its confirm (design § "⭐ The final check" §2,
 * §3, §5). Pending holds from an accepted skip until the check's head is no longer
 * live, when the row is not drawn at all; a later run's check starts clean because
 * the control unmounts with its run.
 */
function useSkipCheck(onSkipCheck: PlanNarrationProps['onSkipCheck']) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<SkipFinalCheckPhase>('open');
  const [pending, setPending] = useState(false);
  const controlRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);

  const confirm = async () => {
    if (!onSkipCheck || phase === 'skipping') return;
    setPhase('skipping');
    try {
      const outcome = await onSkipCheck();
      if (outcome === 'not_running') {
        setPhase('finished');
        return;
      }
      setPending(true);
      setOpen(false);
    } catch {
      setPhase('failed');
    }
  };

  const row = (tc: Tc): ReactNode => (
    <div data-testid="plan-narration-skip-check" className="ml-5.5">
      {pending ? (
        <div
          ref={pendingRef}
          tabIndex={-1}
          role="status"
          data-testid="plan-narration-skip-check-pending"
          className="flex items-center gap-2 text-(--el-text-secondary) focus-visible:outline-none"
        >
          <Spinner size="sm" aria-hidden="true" />
          {tc('narration.skippingCheck')}
        </div>
      ) : (
        <Button
          ref={controlRef}
          variant="secondary"
          size="sm"
          leftIcon={<SkipForward className="size-3.5" aria-hidden="true" />}
          data-testid="plan-narration-skip-check-control"
          onClick={() => {
            setPhase('open');
            setOpen(true);
          }}
        >
          {tc('narration.skipCheck')}
        </Button>
      )}
    </div>
  );

  const dialog = (
    <SkipFinalCheckDialog
      open={open}
      phase={phase}
      onKeep={() => setOpen(false)}
      onConfirm={() => void confirm()}
      onCloseAutoFocus={(event) => {
        // Back to the control when kept; to the pending row once accepted. When
        // neither is drawn any more (the check ended), Radix's default applies.
        const target = pendingRef.current ?? controlRef.current;
        if (!target) return;
        event.preventDefault();
        target.focus();
      }}
    />
  );

  const clearPending = useCallback(() => setPending(false), []);

  return { row, dialog, clearPending };
}

/**
 * The fold: every group follows the remembered all-state, except the ones the
 * reader toggled on their own. A press on the all-control clears those, so a
 * later Hide folds a group that was opened alone. Only the all-control is
 * remembered; a single group's disclosure is view state.
 */
function useFoldState() {
  // The remembered choice is read through `useSyncExternalStore`, whose server
  // snapshot is "expanded": the server has no storage, so a render-time read
  // would hydrate one tree over another. A press in this view wins over it.
  const remembered = useSyncExternalStore(subscribeNever, readRemembered, () => false);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  const allFolded = chosen ?? remembered;
  return {
    isFolded: (key: string) => allFolded !== toggled.has(key),
    toggle: (key: string) =>
      setToggled((set) => {
        const next = new Set(set);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    setAll: (fold: boolean) => {
      setChosen(fold);
      setToggled(new Set());
      writeRemembered(fold ? 'collapsed' : 'expanded');
    },
  };
}

function NarrationGroupRow({
  group,
  listId,
  folded,
  onToggle,
  skipRow,
  tc,
}: {
  group: NarrationGroup;
  listId: string;
  folded: boolean;
  onToggle: () => void;
  /** The Skip the final check row, under the live check head only; between the
   *  head and the list, so hiding the notes never hides it. */
  skipRow: ReactNode;
  tc: Tc;
}) {
  const state = group.session === null ? 'unattributed' : group.live ? 'live' : 'finished';
  const name = group.session
    ? tc(group.live ? 'narration.groupLive' : 'narration.groupFinished', {
        step: narrationHeadLine(group.session, tc),
      })
    : undefined;
  const hasMessages = group.messages.length > 0;
  return (
    <li
      data-testid="plan-narration-group"
      data-session={state}
      data-session-key={group.sessionKey}
      className={`flex flex-col gap-1 text-xs ${
        group.live ? 'text-(--el-text)' : 'text-(--el-text-secondary)'
      }`}
    >
      {group.session ? (
        <NarrationHead
          session={group.session}
          live={group.live}
          disclosure={
            hasMessages ? (
              <button
                type="button"
                aria-expanded={!folded}
                aria-controls={listId}
                data-testid="plan-narration-group-toggle"
                onClick={onToggle}
                className={`-my-px ml-auto ${DISCLOSURE_CLASS}`}
              >
                {folded ? (
                  <ChevronRight className="size-3" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-3" aria-hidden="true" />
                )}
                {tc('narration.groupCount', { count: group.messages.length })}
              </button>
            ) : null
          }
          tc={tc}
        />
      ) : null}
      {skipRow}
      {hasMessages ? (
        <ol
          id={listId}
          hidden={folded}
          aria-label={name}
          data-testid="plan-narration-messages"
          className="ml-5.5 flex flex-col gap-1 border-l border-(--el-border-strong) pl-2.5"
        >
          {group.messages.map((message, i) => (
            <li
              key={message.seq}
              dir="auto"
              data-testid="plan-narration-message"
              data-seq={message.seq}
              className={`leading-relaxed wrap-anywhere ${
                group.live && i === group.messages.length - 1
                  ? 'text-(--el-text)'
                  : 'text-(--el-text-secondary)'
              }`}
            >
              {message.body}
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

/** The group head: the shipped act row's three columns, from the stored step
 *  words. Live: the spinner and `--el-text`. Finished: `circle-check` and the
 *  word "· done" — the step words stay, never a generic finished label. */
function NarrationHead({
  session,
  live,
  disclosure,
  tc,
}: {
  session: PlanNarrationSessionDto;
  live: boolean;
  disclosure: ReactNode;
  tc: Tc;
}) {
  const [before, title, after] = headParts(session, tc);
  return (
    <div className="flex items-start gap-2" data-testid="plan-narration-head">
      {live ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : (
        <span className="mt-px shrink-0 text-(--el-text-secondary)">
          <CircleCheck className="size-3.5" aria-hidden="true" />
        </span>
      )}
      <span
        className="mt-px w-16 shrink-0 font-mono text-[10px] font-semibold tracking-wide text-(--el-text-secondary) uppercase"
        data-kind={session.stepKind}
      >
        {tc(KIND_LABEL[session.stepKind])}
      </span>
      <span className="min-w-0 flex-1 wrap-anywhere" data-testid="plan-narration-head-line">
        {before}
        {title !== null ? (
          <span dir="auto" data-testid="plan-narration-head-title">
            {title}
          </span>
        ) : null}
        {after}
        {live ? null : (
          <>
            {' '}
            <span data-testid="plan-narration-done" className="text-(--el-text-secondary)">
              {tc('narration.done')}
            </span>
          </>
        )}
      </span>
      {disclosure}
    </div>
  );
}
