'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import {
  TodoRowBody,
  TodoRowReadOnly,
} from '@/app/(authed)/items/[key]/_components/TodoListSection';
import type { GuideRow, GuideRowTag, GuideView } from '@/lib/planning/guideView';
import type { WorkItemRefMap } from '@/lib/dto/workItems';

// THE GUIDE CANVAS (Story MOTIR-7459 · MOTIR-7466; design
// `design/ai-chat/planning-workspace--guide.mock.html` panels 1–16 and
// `design-notes.md` § ⭐ Guide me through). In guide mode the overlay's left pane
// shows the guided card's TO-DO LIST in place of the project tree: one `Card`
// centred on the canvas, max 560px, holding the shipped section header, a
// progress header, and the shipped rows.
//
// ⚠️ THE ROW IS THE SHIPPED ROW. Each step's content is `TodoRowBody` — the same
// markup the item page and the plan peek draw — and a PROPOSED list is drawn
// with `TodoRowReadOnly` itself. What this file adds is only what the design
// calls NEW: the current-step marker, the tags, the bands and the motion.
//
// ⚠️ NO EDITING HERE. There is no actions column: a list changes through the
// conversation or on the item page. The one write is the person's own TICK on a
// saved row, through the shipped to-do action (the host passes it), so a canvas
// tick and a page tick are one write path.
//
// ⚠️ MOTION IS DRAWN FROM WHAT CHANGED BETWEEN TWO READS, NEVER FROM A TURN.
// A tick Motir AI landed, a tick the person made here, and a tick made on the
// item page and read back all play the same sequence (panel 12), because each is
// a row that was not done in the last view and is done in this one. A refresh
// that reads the same rows changes nothing, so it replays nothing. Under
// `prefers-reduced-motion` the classes are withheld and the end state is painted
// at once (and `globals.css` scopes every keyframe to `no-preference` as well).

/** How long a transition's classes stay on before the row is plain again —
 *  the tick's whole ≈ 820ms sequence, rounded up. */
export const GUIDE_MOTION_MS = 900;

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Motion {
  ticked: ReadonlySet<string>;
  unticked: ReadonlySet<string>;
  arrived: ReadonlySet<string>;
  moved: ReadonlySet<string>;
  /** Rows that left, drawn where they were until they have collapsed. */
  leaving: ReadonlyArray<{ row: GuideRow; index: number }>;
  currentIn: string | null;
  gain: boolean;
}

const NO_MOTION: Motion = {
  ticked: new Set(),
  unticked: new Set(),
  arrived: new Set(),
  moved: new Set(),
  leaving: [],
  currentIn: null,
  gain: false,
};

function viewKey(view: GuideView): string {
  return `${view.kind}|${view.currentId ?? ''}|${view.rows.map((r) => `${r.id}:${r.done ? 1 : 0}`).join(',')}`;
}

/** What moved between two views of the same list. */
function diffViews(prev: GuideView, next: GuideView): Motion {
  // A different LIST (proposed → saved, a write that replaced the temporary
  // walk) is a new picture, not a change to animate row by row.
  const sameList =
    prev.kind === next.kind || (prev.kind === 'proposed' && next.kind === 'temporary');
  if (!sameList || prev.kind === 'loading') return NO_MOTION;
  const before = new Map(prev.rows.map((r, i) => [r.id, { row: r, index: i }]));
  const ticked = new Set<string>();
  const unticked = new Set<string>();
  const arrived = new Set<string>();
  const moved = new Set<string>();
  const order = prev.rows.map((r) => r.id).filter((id) => next.rows.some((n) => n.id === id));
  const nextOrder = next.rows.map((r) => r.id).filter((id) => before.has(id));
  next.rows.forEach((row) => {
    const was = before.get(row.id);
    if (!was) {
      arrived.add(row.id);
      return;
    }
    if (!was.row.done && row.done) ticked.add(row.id);
    if (was.row.done && !row.done) unticked.add(row.id);
    if (order.indexOf(row.id) !== nextOrder.indexOf(row.id) && next.tags[row.id] === 'moved') {
      moved.add(row.id);
    }
  });
  const leaving = prev.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !next.rows.some((n) => n.id === row.id));
  return {
    ticked,
    unticked,
    arrived,
    moved,
    leaving,
    currentIn: prev.currentId !== next.currentId ? next.currentId : null,
    gain: next.done > prev.done,
  };
}

export interface GuideTodoCanvasProps {
  view: GuideView;
  /**
   * The steps' notes' work-item links, resolved for the reader (bug MOTIR-10023) —
   * the card's rows from their read, the conversation's from the thread's.
   */
  workItemRefs: WorkItemRefMap;
  /** The person may tick (`work_item:edit`); a saved list only. */
  canTick: boolean;
  onSetDone: (todoId: string, done: boolean) => void;
  /** The temporary band's *Save to the card* — sends the save turn. */
  onSave?: () => void;
  /** A turn is running: the band's Save waits for it. */
  busy?: boolean;
  /** A canvas tick the card refused, in the catalog's words. */
  tickError?: string | null;
}

export function GuideTodoCanvas({
  view,
  workItemRefs,
  canTick,
  onSetDone,
  onSave,
  busy = false,
  tickError = null,
}: GuideTodoCanvasProps) {
  const t = useTranslations('planningWorkspace.guide');
  const tt = useTranslations('workItemTodos');

  // The previous view, held as state and compared IN RENDER (React's documented
  // pattern for a value derived from a transition), so the motion classes are on
  // the very paint that shows the new state — never a frame late.
  const key = viewKey(view);
  const [seen, setSeen] = useState<{ key: string; view: GuideView; motion: Motion }>({
    key,
    view,
    motion: NO_MOTION,
  });
  if (seen.key !== key) {
    const motion = prefersReducedMotion() ? NO_MOTION : diffViews(seen.view, view);
    setSeen({ key, view, motion });
  }
  const motion = seen.key === key ? seen.motion : NO_MOTION;

  // The classes come off once the sequence has played, so the next change to
  // the same row animates again and a still row is a plain row.
  useEffect(() => {
    if (motion === NO_MOTION) return;
    const timer = window.setTimeout(() => {
      setSeen((s) => (s.key === key ? { ...s, motion: NO_MOTION } : s));
    }, GUIDE_MOTION_MS);
    return () => window.clearTimeout(timer);
  }, [motion, key]);

  const loading = view.kind === 'loading' || view.kind === 'empty';
  const temporary = view.kind === 'temporary';
  const proposed = view.kind === 'proposed';

  // The rows to draw: the view's, with any leaving rows held at their old place.
  const drawn: Array<{ row: GuideRow; leaving: boolean }> = view.rows.map((row) => ({
    row,
    leaving: false,
  }));
  for (const { row, index } of motion.leaving) {
    drawn.splice(Math.min(index, drawn.length), 0, { row, leaving: true });
  }

  const pct = view.total > 0 ? Math.round((view.done / view.total) * 100) : 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col items-center gap-3 overflow-auto px-5 py-6 max-md:p-3"
      data-testid="guide-canvas"
      data-guide-list={view.kind}
    >
      {proposed ? (
        <p
          data-testid="guide-proposed-band"
          className="flex w-full max-w-[560px] items-center gap-2.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-[12.5px] leading-normal text-(--el-text-strong)"
        >
          <span className="min-w-0 flex-1">
            {t.rich('proposedBand', { b: (chunks) => <b>{chunks}</b> })}
          </span>
        </p>
      ) : null}
      {temporary ? (
        <div
          data-testid="guide-temporary-band"
          className="flex w-full max-w-[560px] items-center gap-2.5 rounded-(--radius-control) border border-(--el-border) bg-(--el-tint-yellow) px-(--spacing-control-x) py-(--spacing-control-y) text-[12.5px] leading-normal text-(--el-text-strong)"
        >
          <span className="min-w-0 flex-1">{t('temporaryBand')}</span>
          {onSave ? (
            <Button variant="secondary" size="sm" onClick={onSave} disabled={busy}>
              {t('save')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Card className="w-full max-w-[560px] shadow-(--shadow-card) max-md:p-(--spacing-md)">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="m-0 text-base font-semibold text-(--el-text)">{tt('sectionTitle')}</h3>
          <span className="text-sm text-(--el-text-secondary)">— {tt('sectionSubtitle')}</span>
          {!loading ? (
            <span
              className="ml-auto font-mono text-[11px] text-(--el-text-secondary)"
              data-testid="guide-count"
            >
              {tt('progress', { done: view.done, total: view.total })}
              {proposed || temporary ? ` ${t('notSavedSuffix')}` : ''}
            </span>
          ) : null}
        </div>

        {/* THE PROGRESS HEADER (NEW). The step is the CURRENT step; the bar is
            the DONE count — they differ when the person ticks ahead. A proposed
            list is not being walked, so it has none. */}
        {!loading && !proposed && view.total > 0 ? (
          <div className="mt-3 flex items-center gap-3" data-testid="guide-progress">
            <span className="flex-none text-[13px] font-semibold text-(--el-text)">
              {view.walkStopped
                ? t('offer.walkStopped')
                : view.currentStep !== null
                  ? t('stepOf', { n: view.currentStep, total: view.total })
                  : tt('allDone')}
            </span>
            <div
              className="relative h-1 flex-1 overflow-hidden rounded-full bg-(--el-muted)"
              role="img"
              aria-label={tt('progress', { done: view.done, total: view.total })}
            >
              <span
                data-testid="guide-bar-fill"
                className={`guide-bar-fill absolute inset-y-0 left-0 rounded-full bg-(--el-accent) ${
                  motion.gain ? 'guide-bar-fill--gain' : ''
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : null}

        {loading ? (
          <ul className="mt-2 list-none p-0" aria-busy data-testid="guide-skeleton">
            {[0, 1, 2, 3].map((i) => (
              <li
                key={i}
                className="grid grid-cols-[auto_1fr] items-center gap-2.5 border-t border-(--el-border) px-2 py-2.5 first:border-t-0"
              >
                <span className="size-4 rounded-(--radius-control) bg-(--el-muted)" />
                <span className="block h-2.5 w-3/4 rounded-(--radius-kbd) bg-(--el-muted)" />
              </li>
            ))}
          </ul>
        ) : proposed ? (
          // A PROPOSED list is the shipped READ face, proper: inert checkboxes, no
          // tick, no actions (panel 3).
          <ul className="mt-2 list-none p-0" data-testid="guide-list">
            {view.rows.map((row) => (
              <TodoRowReadOnly key={row.id} row={row} workItemRefs={workItemRefs} />
            ))}
          </ul>
        ) : (
          <ul className="mt-2 list-none p-0" data-testid="guide-list">
            {drawn.map(({ row, leaving }) => (
              <GuideTodoRow
                key={leaving ? `leaving-${row.id}` : row.id}
                row={row}
                workItemRefs={workItemRefs}
                current={!leaving && row.id === view.currentId}
                tag={leaving ? null : (view.tags[row.id] ?? null)}
                temporary={temporary}
                tickable={canTick && !temporary && !leaving}
                onSetDone={onSetDone}
                motionClass={
                  leaving
                    ? 'guide-row--leaving'
                    : motion.ticked.has(row.id)
                      ? 'guide-row--ticked'
                      : motion.unticked.has(row.id)
                        ? 'guide-row--unticked'
                        : motion.arrived.has(row.id)
                          ? 'guide-row--added'
                          : motion.moved.has(row.id)
                            ? 'guide-row--moved'
                            : motion.currentIn === row.id
                              ? 'guide-row--current-in'
                              : ''
                }
                drawTick={motion.ticked.has(row.id)}
                tickLabels={{ checked: tt('done'), unchecked: tt('notDone') }}
              />
            ))}
          </ul>
        )}

        {!loading && !proposed && view.total > 0 && view.done === view.total ? (
          <p
            className="mt-2.5 text-[12.5px] text-(--el-text-secondary)"
            data-testid="guide-all-done"
          >
            {tt('allDone')}
          </p>
        ) : null}
        {tickError ? (
          <p role="alert" className="mt-2 text-[12.5px] text-(--el-danger-on-surface)">
            {tickError === 'FAILED' ? tt('errors.generic') : tickError}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

const TAG_FILL: Record<GuideRowTag | 'current' | 'notSaved', string> = {
  current: 'bg-(--el-tint-lavender)',
  notSaved: 'bg-(--el-tint-yellow)',
  added: 'border border-(--el-border) bg-(--el-diff-added)',
  changed: 'bg-(--el-tint-sage)',
  moved: 'border border-(--el-border) bg-(--el-diff-moved)',
  cannot: 'bg-(--el-warning-surface)',
};

function Tag({ kind }: { kind: GuideRowTag | 'current' | 'notSaved' }) {
  const t = useTranslations('planningWorkspace.guide.tag');
  return (
    <span
      data-testid={`guide-tag-${kind}`}
      className={`inline-flex flex-none items-center rounded-(--radius-badge) px-(--spacing-chip-x) py-(--spacing-chip-y) text-[11px] font-semibold text-(--el-text-strong) ${TAG_FILL[kind]}`}
    >
      {t(kind)}
    </span>
  );
}

function GuideTodoRow({
  row,
  workItemRefs,
  current,
  tag,
  temporary,
  tickable,
  onSetDone,
  motionClass,
  drawTick,
  tickLabels,
}: {
  row: GuideRow;
  workItemRefs: WorkItemRefMap;
  current: boolean;
  tag: GuideRowTag | null;
  temporary: boolean;
  tickable: boolean;
  onSetDone: (todoId: string, done: boolean) => void;
  motionClass: string;
  drawTick: boolean;
  tickLabels: { checked: string; unchecked: string };
}) {
  // The CURRENT step's instructions open by default (panel 2); the reader's own
  // toggle wins from then on.
  const [expandedByReader, setExpanded] = useState<boolean | null>(null);
  const expanded = expandedByReader ?? current;
  const notesId = useId();

  return (
    <li
      data-testid="guide-row"
      data-todo-id={row.id}
      data-todo-done={row.done ? 'true' : 'false'}
      data-current={current ? 'true' : undefined}
      data-motion={motionClass || undefined}
      className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 border-t border-(--el-border) px-(--spacing-control-x-8) py-(--spacing-control-y-8) first:border-t-0 ${
        current
          ? 'rounded-(--radius-control) bg-(--el-surface-soft) shadow-[inset_3px_0_0_var(--el-accent)]'
          : ''
      } ${motionClass}`}
    >
      {tickable ? (
        <span className={`mt-0.5 inline-flex ${drawTick ? 'guide-tick-draw' : ''}`}>
          <Checkbox
            checked={row.done}
            onChange={(next) => onSetDone(row.id, next)}
            label={row.text}
            stateLabels={tickLabels}
          />
        </span>
      ) : (
        // A temporary walk's rows, and a row the viewer may not tick: the state
        // is drawn, and the box is not a control (`TodoRowReadOnly`'s idiom).
        <span
          aria-hidden
          data-testid="guide-checkbox-static"
          className={`mt-0.5 inline-flex size-4 items-center justify-center rounded-(--radius-control) border ${
            row.done
              ? 'border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)'
              : 'border-(--el-border-strong) bg-(--el-input-readonly-bg)'
          } ${drawTick ? 'guide-tick-draw' : ''}`}
        >
          {row.done ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
        </span>
      )}
      <div className="min-w-0">
        <TodoRowBody
          row={temporary ? { ...row, doneBy: null } : row}
          workItemRefs={workItemRefs}
          isExpanded={expanded}
          onToggleExpanded={() => setExpanded(!expanded)}
          notesId={notesId}
        />
        {current || tag || temporary ? (
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            {current ? <Tag kind="current" /> : null}
            {tag ? <Tag kind={tag} /> : null}
            {temporary ? <Tag kind="notSaved" /> : null}
          </span>
        ) : null}
      </div>
    </li>
  );
}
