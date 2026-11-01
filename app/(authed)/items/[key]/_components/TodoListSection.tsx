'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Check, Copy, GripVertical, Pencil, Plus, Trash2, User } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { Tooltip } from '@/components/ui/Tooltip';
import { ContentSectionCard } from './ContentSectionCard';
import { fieldRef } from '@/lib/translation/fieldRefs';
import { FieldTranslationMark } from './translation/FieldTranslationMark';
import { TranslatableMarkdown } from './translation/TranslatableFields';
import { useFieldTranslation } from './translation/TranslationProvider';
import {
  OriginalLanguageAccessory,
  useOriginalLanguageNote,
} from './translation/OriginalLanguageNote';
import {
  addTodoAction,
  deleteTodoAction,
  moveTodoAction,
  setTodoDoneAction,
  updateTodoAction,
} from '../todoActions';
import type { ExecutorDto, WorkItemRefMap } from '@/lib/dto/workItems';
import type { TodoProgressDto, WorkItemTodoDto } from '@/lib/dto/workItemTodos';

// The TO-DO LIST section on the work item page (Story MOTIR-3808 · MOTIR-3815).
// Built to `design/work-items/todo-list.mock.html` + `design-notes.md`
// § *The to-do list on a work item*; where this file and the card's prose
// disagreed, the asset won.
//
// ⚠️ IT IS A `<ul>` OF ROWS AND DELIBERATELY NOT A LISTBOX. A row carries a
// checkbox, a copy button, a disclosure, a drag handle and two more buttons,
// and an `option` may not contain interactive descendants — drawing it that way
// produces a surface a screen reader can announce and cannot operate.
//
// ⚠️ THE HEADER'S COUNT COMES FROM THE SERVER, NEVER FROM `items.length`. Every
// write returns `{ todo, progress }` read inside its own transaction, so the
// header can never disagree with the list beneath it. Deriving it here would
// re-introduce exactly the drift the envelope exists to prevent.
//
// ⚠️ NO `setState` IN AN EFFECT TO MIRROR PROPS. The list is seeded once from
// the server and moves only on an action's result.
//
// ⚠️ NOTHING HERE TOUCHES THE WORK ITEM'S STATUS. Ticking the last row renders
// the all-done treatment and does nothing else — `docs/decisions/work-item-todo-list.md`
// §3 refuses a third writer of that column.

export interface TodoListSectionProps {
  workItemId: string;
  initialTodos: WorkItemTodoDto[];
  initialProgress: TodoProgressDto;
  /**
   * The notes' `[KEY](motir:<id>)` links, resolved for the reader by the page's read
   * (bug MOTIR-10023, `workItemTodosService.resolveNotesRefs`). An add or an edit
   * merges the written step's own links in, so a just-saved link draws live.
   */
  initialWorkItemRefs: WorkItemRefMap;
  /** `work_item:edit` — the ONE key every write is gated on (ADR §4). */
  canEdit: boolean;
}

type Draft = { text: string; notesMd: string; commandText: string; executor: ExecutorDto | null };

const emptyDraft: Draft = { text: '', notesMd: '', commandText: '', executor: null };

export function TodoListSection({
  workItemId,
  initialTodos,
  initialProgress,
  initialWorkItemRefs,
  canEdit,
}: TodoListSectionProps) {
  const t = useTranslations('workItemTodos');
  const [todos, setTodos] = useState<WorkItemTodoDto[]>(initialTodos);
  const [workItemRefs, setWorkItemRefs] = useState<WorkItemRefMap>(initialWorkItemRefs);
  const mergeRefs = useCallback((next: WorkItemRefMap | undefined) => {
    if (next && Object.keys(next).length > 0) setWorkItemRefs((prev) => ({ ...prev, ...next }));
  }, []);
  const [progress, setProgress] = useState<TodoProgressDto>(initialProgress);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const genericError = t('errors.generic');

  const [adding, setAdding] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The move ANNOUNCEMENT — a live region, because a keyboard reorder that says
  // nothing is a reorder a screen-reader user cannot verify.
  const [announcement, setAnnouncement] = useState('');
  const lastAction = useRef<(() => Promise<void>) | null>(null);

  /**
   * Run one action, holding its failure INSIDE the section (never blanking the
   * page).
   *
   * ⚠️ TWO FAILURE SHAPES, AND THE SECOND IS THE ONE THAT ACTUALLY HAPPENS. An
   * action can REFUSE — returning `{ ok: false, error }` for a typed store
   * error — or it can REJECT: the network drops, a deploy lands mid-flight, or
   * the action rethrows an error it has no message for (which `todoActions`
   * does deliberately, so a bug is reported rather than flattened into
   * "something went wrong").
   *
   * An earlier revision handled only the refusal — `try` / `finally` with no
   * `catch` — so a rejection escaped as an unhandled rejection and the section
   * rendered NOTHING: no error, no retry, and a control that silently did not
   * work. MOTIR-3817's error-state E2E is what caught it, by aborting the
   * action's POST at the network boundary, which is exactly the shape a real
   * user hits and the one no refusal path can produce.
   */
  const run = useCallback(
    async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
      setPending(true);
      try {
        const result = await fn();
        if (!result.ok) {
          setError(result.error ?? genericError);
          return false;
        }
        setError(null);
        return true;
      } catch {
        // No typed message exists for this — the action never got to answer.
        setError(genericError);
        return false;
      } finally {
        setPending(false);
      }
    },
    [genericError],
  );

  const retry = useCallback(async () => {
    const again = lastAction.current;
    if (again) await again();
  }, []);

  const replaceTodo = useCallback((next: WorkItemTodoDto) => {
    setTodos((prev) => prev.map((row) => (row.id === next.id ? next : row)));
  }, []);

  async function onToggle(row: WorkItemTodoDto, next: boolean) {
    const act = async () => {
      await run(async () => {
        const result = await setTodoDoneAction({ todoId: row.id, done: next });
        if (result.ok) {
          replaceTodo(result.todo);
          setProgress(result.progress);
        }
        return result;
      });
    };
    lastAction.current = act;
    await act();
  }

  async function onAdd() {
    const text = adding.trim();
    if (text.length === 0) return;
    const act = async () => {
      const ok = await run(async () => {
        const result = await addTodoAction({ workItemId, text });
        if (result.ok) {
          setTodos((prev) => [...prev, result.todo]);
          mergeRefs(result.workItemRefs);
          setProgress(result.progress);
          setAdding('');
        }
        return result;
      });
      return ok;
    };
    lastAction.current = async () => {
      await act();
    };
    await act();
  }

  async function onSaveEdit(row: WorkItemTodoDto, draft: Draft) {
    const act = async () => {
      await run(async () => {
        const result = await updateTodoAction({
          todoId: row.id,
          text: draft.text,
          // '' clears the field — the sparse patch's explicit-null arm, which is
          // how a user removes a command or its instructions.
          notesMd: draft.notesMd.trim() === '' ? null : draft.notesMd,
          commandText: draft.commandText.trim() === '' ? null : draft.commandText,
          executor: draft.executor,
        });
        if (result.ok) {
          replaceTodo(result.todo);
          mergeRefs(result.workItemRefs);
          setProgress(result.progress);
          setEditingId(null);
        }
        return result;
      });
    };
    lastAction.current = act;
    await act();
  }

  async function onDelete(row: WorkItemTodoDto) {
    const act = async () => {
      await run(async () => {
        const result = await deleteTodoAction({ todoId: row.id });
        if (result.ok) {
          setTodos((prev) => prev.filter((r) => r.id !== row.id));
          setProgress(result.progress);
          setConfirmingId(null);
        }
        return result;
      });
    };
    lastAction.current = act;
    await act();
  }

  /**
   * Move a row by one slot.
   *
   * ⚠️ THE DESTINATION IS AN INDEX, resolved server-side against the list that
   * transaction locks — not a pair of neighbour ids resolved against whatever
   * this client last rendered.
   */
  async function onMove(row: WorkItemTodoDto, delta: -1 | 1) {
    const from = todos.findIndex((r) => r.id === row.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= todos.length) return;
    const act = async () => {
      await run(async () => {
        const result = await moveTodoAction({ todoId: row.id, toIndex: to });
        if (result.ok) {
          setTodos((prev) => {
            const next = prev.filter((r) => r.id !== row.id);
            next.splice(to, 0, result.todo);
            return next;
          });
          setProgress(result.progress);
          setAnnouncement(t('movedTo', { position: to + 1, total: todos.length }));
        }
        return result;
      });
    };
    lastAction.current = act;
    await act();
  }

  const allDone = progress.total > 0 && progress.done === progress.total;

  return (
    <ContentSectionCard
      title={t('sectionTitle')}
      subtitle={t('sectionSubtitle')}
      headerRight={
        <span
          data-testid="todo-progress"
          className="font-mono text-[11px] text-(--el-text-secondary)"
        >
          {t('progress', { done: progress.done, total: progress.total })}
        </span>
      }
    >
      {/* The keyboard reorder's announcement. Always mounted so a screen reader
          picks up the change rather than the region's arrival. */}
      <p data-testid="todo-announcement" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {error ? (
        <div
          role="alert"
          data-testid="todo-error"
          className="mb-3 flex items-center gap-3 rounded-(--radius-control) border border-(--el-border) bg-(--el-tint-peach) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-[12.5px] text-(--el-text-strong)"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button type="button" variant="secondary" size="sm" onClick={retry} className="shrink-0">
            {t('retry')}
          </Button>
        </div>
      ) : null}

      {todos.length === 0 ? (
        <div data-testid="todo-empty" className="py-2">
          <p className="text-[13.5px] text-(--el-text)">{t('empty')}</p>
          <p className="mt-1 text-[12.5px] text-(--el-text-secondary)">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul data-testid="todo-list" className="list-none">
          {todos.map((row, index) => (
            <TodoRow
              key={row.id}
              row={row}
              workItemRefs={workItemRefs}
              index={index}
              total={todos.length}
              canEdit={canEdit}
              pending={pending}
              isEditing={editingId === row.id}
              isConfirming={confirmingId === row.id}
              isExpanded={expanded.has(row.id)}
              onToggleExpanded={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.id)) next.delete(row.id);
                  else next.add(row.id);
                  return next;
                })
              }
              onToggle={(next) => onToggle(row, next)}
              onStartEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSaveEdit={(draft) => onSaveEdit(row, draft)}
              onStartDelete={() => setConfirmingId(row.id)}
              onCancelDelete={() => setConfirmingId(null)}
              onDelete={() => onDelete(row)}
              onMove={(delta) => onMove(row, delta)}
            />
          ))}
        </ul>
      )}

      {allDone ? (
        <p data-testid="todo-all-done" className="mt-3 text-[12.5px] text-(--el-text-secondary)">
          {t('allDone')}
        </p>
      ) : null}

      {canEdit ? (
        <div className="mt-2 flex items-center gap-2 border-t border-(--el-border) pt-3">
          <Plus className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
          <Input
            data-testid="todo-add-input"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            aria-label={t('addPlaceholder')}
            placeholder={t('addPlaceholder')}
            className="min-w-0 flex-1"
            onKeyDown={(e) => {
              // Enter commits and keeps the field focused for the next step.
              if (e.key === 'Enter') {
                e.preventDefault();
                void onAdd();
              }
              if (e.key === 'Escape') setAdding('');
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void onAdd()}
            disabled={pending || adding.trim().length === 0}
            className="shrink-0"
          >
            {t('add')}
          </Button>
        </div>
      ) : null}
    </ContentSectionCard>
  );
}

interface TodoRowProps {
  row: WorkItemTodoDto;
  workItemRefs: WorkItemRefMap;
  index: number;
  total: number;
  canEdit: boolean;
  pending: boolean;
  isEditing: boolean;
  isConfirming: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onToggle: (next: boolean) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (draft: Draft) => void;
  onStartDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onMove: (delta: -1 | 1) => void;
}

function TodoRow({
  row,
  workItemRefs,
  index,
  total,
  canEdit,
  pending,
  isEditing,
  isConfirming,
  isExpanded,
  onToggleExpanded,
  onToggle,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onStartDelete,
  onCancelDelete,
  onDelete,
  onMove,
}: TodoRowProps) {
  const t = useTranslations('workItemTodos');
  const tpa = useTranslations('projectAccess');
  const notesId = useId();
  // The checkbox takes its name from the row's text, so in the translated view it
  // names the translated text (MOTIR-8122; design § Where each field's mark sits).
  const label = useFieldTranslation(fieldRef.todoText(row.id)).text ?? row.text;

  if (isEditing) {
    return (
      <li className="grid grid-cols-[auto_1fr_auto] items-start gap-2.5 py-2.5">
        <span aria-hidden className="mt-0.5 size-4" />
        <TodoEditor row={row} onCancel={onCancelEdit} onSave={onSaveEdit} pending={pending} />
        <span />
      </li>
    );
  }

  return (
    <li
      data-testid="todo-row"
      data-todo-id={row.id}
      data-todo-done={row.done ? 'true' : 'false'}
      className="grid grid-cols-[auto_1fr_auto] items-start gap-2.5 border-t border-(--el-border) py-2.5 first:border-t-0"
    >
      {/* The tick. `stateLabels` is what keeps a screen reader from announcing a
          STEP as "Held" — the primitive's default vocabulary is set-membership,
          which is right for the role editor and wrong here. */}
      {canEdit ? (
        <Checkbox
          checked={row.done}
          onChange={onToggle}
          label={label}
          disabled={pending}
          stateLabels={{ checked: t('done'), unchecked: t('notDone') }}
          className="mt-0.5"
        />
      ) : (
        // MOTIR-6173 — the permission-gated UI rule's part 2: an in-place control
        // a read-only actor can SEE stays, disabled, and says why. A disabled
        // input swallows pointer events, so the reason hangs off a wrapper.
        <Tooltip content={tpa('readOnlyHint')}>
          <span data-testid="todo-checkbox-read-only" className="mt-0.5 inline-flex">
            <Checkbox
              checked={row.done}
              onChange={onToggle}
              label={label}
              disabled
              stateLabels={{ checked: t('done'), unchecked: t('notDone') }}
            />
          </span>
        </Tooltip>
      )}

      <div className="min-w-0">
        {isConfirming ? (
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 text-[13.5px] text-(--el-text)">
              {t('confirmDelete', { text: row.text })}
            </span>
            <Button type="button" variant="secondary" size="sm" onClick={onCancelDelete}>
              {t('cancel')}
            </Button>
            {/* The confirm's own verb — `delete` is the icon button's
                accessible name ("Delete step") and would read oddly here. */}
            <Button type="button" variant="danger" size="sm" onClick={onDelete} disabled={pending}>
              {t('deleteConfirm')}
            </Button>
          </div>
        ) : (
          <TodoRowBody
            row={row}
            workItemRefs={workItemRefs}
            todoId={row.id}
            isExpanded={isExpanded}
            onToggleExpanded={onToggleExpanded}
            notesId={notesId}
          />
        )}
      </div>

      <span className="inline-flex items-center gap-0.5">
        {canEdit && !isConfirming ? (
          <>
            <IconButton
              label={t('moveUp')}
              disabled={pending || index === 0}
              onClick={() => onMove(-1)}
            >
              <GripVertical className="h-4 w-4" aria-hidden />
            </IconButton>
            <IconButton
              label={t('moveDown')}
              disabled={pending || index === total - 1}
              onClick={() => onMove(1)}
            >
              <GripVertical className="h-4 w-4 rotate-180" aria-hidden />
            </IconButton>
            <IconButton label={t('editStep')} onClick={onStartEdit} disabled={pending}>
              <Pencil className="h-4 w-4" aria-hidden />
            </IconButton>
            <IconButton label={t('delete')} onClick={onStartDelete} disabled={pending}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </IconButton>
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * ONE STEP's CONTENT — the text, its executor mark, the instructions disclosure,
 * the command, and the done-by line. Everything inside a row's middle cell.
 *
 * ⚠️ EXTRACTED SO THERE IS ONE ROW MARKUP, NOT TWO (Story MOTIR-3810 ·
 * MOTIR-4622). It is rendered by the editable {@link TodoRow} on the work-item
 * page AND by {@link TodoRowReadOnly} in the plan peek's proposal mode. A second
 * rendering of a step would be a second thing to keep in step with the first,
 * on a surface that has just had that exact defect class — two peeks for one
 * proposal — removed at some cost (MOTIR-4181). The reviewer's preview and the
 * card's list cannot drift, because they ARE the same markup.
 *
 * A THIRD consumer since MOTIR-7466: the guide canvas in the planning overlay
 * draws each step with this body beside its own live tick and current-step mark.
 *
 * Typed on the FIELDS it reads rather than on `WorkItemTodoDto`, because the
 * proposal side has no `id`, no `position` and no `doneAt` — a proposal never
 * ticks — and widening the DTO to fake them would be the drift by another route.
 */
export interface TodoRowContent {
  text: string;
  notesMd: string | null;
  commandText: string | null;
  executor: ExecutorDto | null;
  done?: boolean;
  doneBy?: { id: string; name: string } | null;
}

export function TodoRowBody({
  row,
  workItemRefs,
  todoId,
  isExpanded,
  onToggleExpanded,
  notesId,
}: {
  row: TodoRowContent;
  /**
   * The notes' work-item links, resolved for the reader by the host's read (bug
   * MOTIR-10023). Required: with no map every card a step names draws as deleted.
   */
  workItemRefs: WorkItemRefMap;
  /**
   * The step's id, on a REAL card's row (MOTIR-8122): its text and notes then take
   * part in on-demand translation. A proposal's row has none, and translates nothing.
   */
  todoId?: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  notesId: string;
}) {
  const t = useTranslations('workItemTodos');
  const textRef = todoId ? fieldRef.todoText(todoId) : null;
  const notesRef = todoId ? fieldRef.todoNotes(todoId) : null;
  const text = useFieldTranslation(textRef).text ?? row.text;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* `text` is PLAIN and stays a text node — never the Markdown pipeline. */}
        <span
          data-testid="todo-text"
          className={
            row.done
              ? 'text-[13.5px] text-(--el-text-secondary) line-through'
              : 'text-[13.5px] text-(--el-text)'
          }
        >
          {text}
        </span>
        <ExecutorMark executor={row.executor} />
        {textRef ? <FieldTranslationMark fieldRef={textRef} field="todo" /> : null}
      </div>

      {/* The INSTRUCTIONS disclosure — rendered ONLY when the row has
          notes, collapsed by default, and a real button controlling the
          region so the chevron is the tell rather than the only cue.
          It stays INTERACTIVE in the read face: expanding notes is a read. */}
      {row.notesMd ? (
        <>
          {/* The notes' translation mark sits beside the disclosure, so it shows
              whether the notes are open or closed (MOTIR-8122). */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleExpanded}
              aria-expanded={isExpanded}
              aria-controls={notesId}
              className="inline-flex items-center gap-1 rounded-(--radius-control) font-sans text-[11.5px] text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              <span aria-hidden>{isExpanded ? '▾' : '▸'}</span>
              {isExpanded ? t('notesHide') : t('notesShow')}
            </button>
            {notesRef ? <FieldTranslationMark fieldRef={notesRef} field="instructions" /> : null}
          </div>
          {isExpanded ? (
            <div
              id={notesId}
              className="mt-1.5 border-l-2 border-(--el-border-strong) pl-3 text-[12.5px] text-(--el-text-secondary)"
            >
              {notesRef ? (
                <TranslatableMarkdown
                  fieldRef={notesRef}
                  value={row.notesMd}
                  workItemRefs={workItemRefs}
                />
              ) : (
                <MarkdownView value={row.notesMd} workItemRefs={workItemRefs} />
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {/* The COMMAND. `min-w-0` on the cell above + `overflow-x-auto` here
          + `shrink-0` on the button is the containment rule: without all
          three the PAGE scrolls sideways instead of the command.
          It stays in the read face too — copying a command is a READ. */}
      {row.commandText ? <CommandRow command={row.commandText} /> : null}

      {row.done && row.doneBy ? (
        <p className="mt-1 text-[11px] text-(--el-text-secondary)">
          {t('doneBy', { name: row.doneBy.name })}
        </p>
      ) : null}
    </>
  );
}

/**
 * A step in its READ FACE — the row a PROPOSAL shows (MOTIR-4622,
 * `design/ai-planning/design-notes.md` Part XV §15.1).
 *
 * The shipped row's three-track grid drops to TWO, because the actions column
 * has nothing to hold: no reorder handle, no edit, no delete, and the section
 * around it renders no add row.
 *
 * ⚠️ THE CHECKBOX STAYS, INERT, AND IS NOT SIMPLY REMOVED. It is what makes the
 * section recognisable as *the list you will tick* — without it this is a
 * bulleted paragraph that happens to sit in a card, which is what the whole
 * story exists to stop being the answer. It is drawn as a plain `<span>` with
 * no role and no tab stop rather than a `disabled` `Checkbox`: a disabled
 * control announces itself as a control that is unavailable, and this is not a
 * control at all. `--el-input-readonly-bg` dims it, because a control that looks
 * tickable and is not is worse than no control.
 */
export function TodoRowReadOnly({
  row,
  workItemRefs,
  drawDone = false,
}: {
  row: TodoRowContent;
  /** The notes' work-item links, resolved by the host's read (bug MOTIR-10023). */
  workItemRefs: WorkItemRefMap;
  /**
   * DRAW THE BOX BY STATE (Story MOTIR-7460 · MOTIR-7478; design § 33.3) — a REAL card's
   * list read in a decision frame, where a ticked row is a fact the reader needs:
   * `GuideTodoCanvas`'s static idiom, still not a control. A proposal never ticks, so
   * its rows keep the plain inert box (the default).
   */
  drawDone?: boolean;
}) {
  const [isExpanded, setExpanded] = useState(false);
  const notesId = useId();
  const ticked = drawDone && row.done === true;

  return (
    <li
      data-testid="todo-row-readonly"
      className="grid grid-cols-[auto_1fr] items-start gap-2.5 border-t border-(--el-border) py-2.5 first:border-t-0"
    >
      {drawDone ? (
        <span
          aria-hidden
          data-testid="todo-checkbox-inert"
          data-todo-done={ticked ? 'true' : 'false'}
          className={`mt-0.5 inline-flex size-4 items-center justify-center rounded-(--radius-control) border ${
            ticked
              ? 'border-(--el-accent) bg-(--el-accent) text-(--el-accent-text)'
              : 'border-(--el-border-strong) bg-(--el-input-readonly-bg)'
          }`}
        >
          {ticked ? <Check className="size-3" strokeWidth={3} aria-hidden /> : null}
        </span>
      ) : (
        <span
          aria-hidden
          data-testid="todo-checkbox-inert"
          className="mt-0.5 size-4 rounded-(--radius-control) border border-(--el-border-strong) bg-(--el-input-readonly-bg)"
        />
      )}
      <div className="min-w-0">
        <TodoRowBody
          row={row}
          workItemRefs={workItemRefs}
          isExpanded={isExpanded}
          onToggleExpanded={() => setExpanded((prev) => !prev)}
          notesId={notesId}
        />
      </div>
    </li>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-40"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** The executor mark. DECLARATIVE — it names who the step is for and gates nothing. */
function ExecutorMark({ executor }: { executor: ExecutorDto | null }) {
  const t = useTranslations('workItemTodos');
  if (executor === 'coding_agent') {
    return (
      <span
        data-testid="todo-executor-agent"
        className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x-8) py-(--spacing-chip-y) text-[11px] text-(--el-text-strong)"
      >
        <Bot className="h-3 w-3" aria-hidden />
        {t('agentStep')}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) border border-(--el-border) px-(--spacing-chip-x-8) py-(--spacing-chip-y) text-[11px] text-(--el-text-secondary)">
      <User className="h-3 w-3" aria-hidden />
      {t('humanStep')}
    </span>
  );
}

/**
 * The command + its copy button.
 *
 * The confirmation is the BUTTON'S OWN STATE and never a toast — the reader is
 * looking at the control they clicked, and a list where several rows are copied
 * in sequence would stack toasts for a confirmation the row already gives
 * (`design-notes.md` § *The copy grammar*). Exactly one of the two, and this
 * surface takes the button.
 */
function CommandRow({ command }: { command: string }) {
  const t = useTranslations('workItemTodos');
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-1.5 flex min-w-0 items-center gap-2">
      <pre
        data-testid="todo-command"
        tabIndex={0}
        className="m-0 min-w-0 flex-1 overflow-x-auto rounded-(--radius-control) border border-(--el-border) bg-(--el-code-bg) px-(--spacing-control-x-8) py-(--spacing-control-y-4) font-mono text-[12px] whitespace-pre text-(--el-code-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
      >
        {command}
      </pre>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="shrink-0"
        aria-label={t('copyCommand')}
        onClick={async () => {
          await navigator.clipboard.writeText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? t('commandCopied') : <Copy className="h-4 w-4" aria-hidden />}
      </Button>
    </div>
  );
}

/**
 * The row's editor — THREE controls, because the row holds three KINDS of text.
 *
 * `text` is plain and one line → `Input`. `notesMd` is Markdown → the shipped
 * `MarkdownEditor` at `size="compact"`, the mode the comment composer on this
 * page already uses. `commandText` is one line of mono → `Input` again, never a
 * rich-text surface. A field the product STORES as Markdown and EDITS as plain
 * text is a field whose numbered list and link a user can only produce by
 * typing the syntax blind.
 */
function TodoEditor({
  row,
  onCancel,
  onSave,
  pending,
}: {
  row: WorkItemTodoDto;
  onCancel: () => void;
  onSave: (draft: Draft) => void;
  pending: boolean;
}) {
  const t = useTranslations('workItemTodos');
  // The languages the STORED text and instructions are recorded in (MOTIR-8832,
  // design MOTIR-8837). The draft below seeds from the stored row, never from a
  // translation.
  const textNote = useOriginalLanguageNote(row.textLanguage, row.text.trim() !== '');
  const [draft, setDraft] = useState<Draft>({
    ...emptyDraft,
    text: row.text,
    notesMd: row.notesMd ?? '',
    commandText: row.commandText ?? '',
    executor: row.executor,
  });

  return (
    <div className="min-w-0">
      <Input
        value={draft.text}
        onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        aria-label={t('stepLabel')}
        helperText={textNote ?? undefined}
        className="w-full"
      />

      <div className="mt-2">
        <MarkdownEditor
          value={draft.notesMd}
          onChange={(next) => setDraft((d) => ({ ...d, notesMd: next }))}
          label={t('notesLabel')}
          labelAccessory={
            <OriginalLanguageAccessory
              language={row.notesLanguage}
              hasText={row.notesMd != null && row.notesMd.trim() !== ''}
            />
          }
          size="compact"
        />
      </div>

      <Input
        value={draft.commandText}
        onChange={(e) => setDraft((d) => ({ ...d, commandText: e.target.value }))}
        aria-label={t('commandLabel')}
        className="mt-2 w-full font-mono text-[12px]"
      />

      <div className="mt-2 flex items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={draft.executor !== 'coding_agent'}
          onClick={() => setDraft((d) => ({ ...d, executor: 'human' }))}
        >
          {t('humanStep')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-pressed={draft.executor === 'coding_agent'}
          onClick={() => setDraft((d) => ({ ...d, executor: 'coding_agent' }))}
        >
          {t('agentStep')}
        </Button>
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => onSave(draft)} disabled={pending}>
            {t('save')}
          </Button>
        </span>
      </div>
    </div>
  );
}
