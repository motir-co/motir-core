'use client';

import { personDisplayName } from '@/lib/people/personLabel';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { WorkItemObsolescenceDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { cn } from '@/lib/utils/cn';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { StatusHeldNotice, type StatusHeldLine } from '@/components/issues/StatusHeldNotice';
import { heldLineFromRefusal, useDismissOnEscapeOrOutside } from '@/components/issues/heldRefusal';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import {
  changeStatusAction,
  updateIssueAction,
  type IssueActionResult,
  type UpdateIssueInput,
} from '../[key]/edit/actions';
import { serverActionRejectionKey } from '@/lib/utils/serverActionRejection';
import { StatusValue, AssigneeValue, PriorityValue, EstimateValue } from './issueCellPrimitives';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import type { IssueRowData } from './issueRows';

// Inline editing for the /items row cells (Subtask 2.5.5) — STATUS · ASSIGNEE ·
// PRIORITY · ESTIMATE, the fields the detail page's `CoreFieldsPanel` edits that
// are also list/tree columns. (DUE is not one: the Due column was removed from
// every view in MOTIR-1307, and its unrendered inline editor with it in
// MOTIR-10591 — the due date is edited on the detail page's rail and in the quick
// view.) A REUSE module, not new mutation work: STATUS opens the shared
// `StatusPicker` → 2.4.4's gated `changeStatusAction` (→ 2.2.4 `updateStatus`);
// the others open the shared `AssigneePicker` / `PriorityPicker` /
// a numeric field → `updateIssueAction` (→ the status-free `updateWorkItem`,
// writes a revision) — the SAME components + Server Actions the detail page uses,
// with identical workspace+membership gating (a forged cross-workspace id 404s).
//
// A surface is editable only inside an `IssueInlineEditProvider` (which carries
// the project workflow → legal status targets, and the workspace members → the
// assignee options). Without the provider the cells render read-only values — so
// the loading skeleton or any non-interactive caller degrades gracefully. Both
// views (Tree + List) mount the provider, so the list and the detail page truly
// share the controls (no parallel components).

// The provider's per-row ledger of server-acknowledged edits. Two registers:
//
// `updatedAt` — with no refresh on success, `row.updatedAt` in server props
// stops advancing after a confirmed edit, so a follow-up edit on the SAME row
// (unassign after reassign; an assignee edit after a status change, which also
// bumps the row) would submit the stale prop as `expectedUpdatedAt` and die on
// the optimistic-concurrency check. Every confirmed action acknowledges its
// returned `updatedAt`; submissions use the max of the ledger and the prop.
//
// Confirmed FIELD VALUES — the cells' converging overrides are component
// state, and the row components UNMOUNT: TreeTable virtualizes (2.5.15), so
// scrolling a row out of the window destroys its overrides, and the Tree's
// `levels` client cache — which inline edits never write into — re-renders the
// OLD value on remount (the post-#640 recurrence of
// bug-inline-status-revert-on-second-edit; collapse→re-expand does the same to
// cached child levels). So every confirmed edit also records (rowId, field) →
// {value, confirmedUpdatedAt} here, and a remounting cell re-reads it; the
// same convergence rule applies (the entry yields once the served
// `row.updatedAt` reaches the acknowledged write).
//
// The ledger lives on the PROVIDER (one per view mount) — above the cells, so
// it is shared by all five editors of a row and survives row unmounts, yet
// resets with the page where fresh server props make it moot. It only ever
// holds values the server itself confirmed; per-key newest-write-wins keeps
// both registers monotonic, and a fresher server prop (someone else's later
// edit) always wins the comparisons. The `updatedAt` register is NOT used for
// display convergence — value resolution must keep comparing against the
// row's actually-served `updatedAt`, otherwise a confirmed cell would yield
// to the still-stale prop value immediately.
type InlineFieldKey = 'status' | 'assigneeId' | 'priority' | 'estimateMinutes';

interface ConfirmedFieldEntry {
  value: unknown;
  confirmedUpdatedAt: string;
}

interface UpdatedAtLedger {
  acknowledge(rowId: string, updatedAt: string): void;
  latest(row: IssueRowData): string;
  confirmField(rowId: string, field: InlineFieldKey, value: unknown, updatedAt: string): void;
  readField(rowId: string, field: InlineFieldKey): ConfirmedFieldEntry | undefined;
}

interface InlineEditContextValue {
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  ledger: UpdatedAtLedger;
}

const IssueInlineEditContext = createContext<InlineEditContextValue | null>(null);

export function IssueInlineEditProvider({
  workflow,
  members,
  children,
}: {
  workflow: WorkflowDto;
  members: WorkspaceMemberDTO[];
  children: ReactNode;
}) {
  // Story 6.4.6 — a read-only actor (viewer / member on a limited project) gets
  // a NULL context, so every cell falls through to its read-only value (the
  // `if (!ctx) return <…Value/>` branch below). The whole inline-edit surface
  // goes read-only without touching the three mount sites. Defaults to editable
  // when there's no ProjectAccessProvider (non-shell / test mounts).
  // MOTIR-2473 — the key this control's own write asserts:
  // `projectAccessService.assertCanEdit` resolves `work_item:edit`.
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  const acknowledgedRef = useRef<Map<string, string>>(new Map());
  const confirmedFieldsRef = useRef<Map<string, ConfirmedFieldEntry>>(new Map());
  const value = useMemo(() => {
    if (!canEdit) return null;
    const acked = acknowledgedRef.current;
    const fields = confirmedFieldsRef.current;
    const ledger: UpdatedAtLedger = {
      acknowledge(rowId, updatedAt) {
        const cur = acked.get(rowId);
        if (cur === undefined || updatedAt > cur) acked.set(rowId, updatedAt);
      },
      latest(row) {
        const a = acked.get(row.id);
        return a !== undefined && a > row.updatedAt ? a : row.updatedAt;
      },
      confirmField(rowId, field, value, updatedAt) {
        const key = `${rowId}:${field}`;
        const cur = fields.get(key);
        if (cur === undefined || updatedAt > cur.confirmedUpdatedAt) {
          fields.set(key, { value, confirmedUpdatedAt: updatedAt });
        }
      },
      readField(rowId, field) {
        return fields.get(`${rowId}:${field}`);
      },
    };
    return { workflow, members, ledger };
  }, [canEdit, workflow, members]);
  return (
    <IssueInlineEditContext.Provider value={value}>{children}</IssueInlineEditContext.Provider>
  );
}

function useIssueInlineEdit() {
  return useContext(IssueInlineEditContext);
}

// The optimistic value for one inline cell. A successful action response IS
// the confirmation (bug-inline-status-revert-on-second-edit): the cell shows
// the picked value immediately, marks it confirmed when the action returns
// the row's new `updatedAt`, and that's it — no `router.refresh()`, no
// revalidate, no whole-tree repaint on success. The refresh fan-out was the
// bug's cause: every inline edit shipped full-page RSC snapshots, so two
// quick edits on different rows raced multiple snapshots and a stale one
// applying last re-rendered the first row's OLD value (display-only; the DB
// held the new one).
//
// Server props CAN still change under the cell — a sibling cell's stale-
// conflict refresh, a navigation, a future live-update surface — so the
// confirmed override yields to the server only when the row's `updatedAt`
// has caught up with the acknowledged write (`>=`, lexicographic — both
// sides are same-format UTC ISO-8601). An older snapshot is by definition
// missing our committed write, so the override keeps rendering; a snapshot
// at/after it includes the write (per-row `updatedAt` is monotonic), so the
// server value wins — which also lets a genuinely later edit by someone else
// show through. No setState-in-effect; a follow-up edit on the same cell
// replaces the override (the token keeps a superseded action's confirm/fail
// from clobbering it).
//
// The local override alone is NOT enough: the row component unmounts when it
// scrolls out of TreeTable's virtualization window (2.5.15) or its parent
// collapses, and the Tree re-renders it from the `levels` client cache, which
// inline edits never write into — so the old value came back on remount (the
// post-#640 recurrence of the bug). Confirmed values therefore also go into
// the provider's ledger, which outlives the cell; on remount the resolution
// is local override (an edit in THIS mount) → ledger entry (an edit confirmed
// before an unmount) → server value, with the same catch-up rule deciding
// when the server wins. Reading the ledger ref during render is safe here:
// entries only change inside this hook's own confirm path, which re-renders
// this cell via setOverride, and a remounting cell renders fresh.
function useConvergingOverride<T>(row: IssueRowData, field: InlineFieldKey, serverValue: T) {
  const ledger = useIssueInlineEdit()?.ledger;
  const serverUpdatedAt = row.updatedAt;
  const [override, setOverride] = useState<{ value: T; confirmedUpdatedAt?: string } | null>(null);
  const tokenRef = useRef(0);
  // The value handed to begin(), kept for confirm() to write into the ledger
  // (the override state may not have flushed when the action resolves).
  const begunRef = useRef<{ token: number; value: T } | null>(null);

  const persisted = ledger?.readField(row.id, field);
  const overrideCaughtUp =
    override?.confirmedUpdatedAt !== undefined && serverUpdatedAt >= override.confirmedUpdatedAt;
  const persistedCaughtUp =
    persisted !== undefined && serverUpdatedAt >= persisted.confirmedUpdatedAt;
  const value =
    override !== null && !overrideCaughtUp
      ? override.value
      : persisted !== undefined && !persistedCaughtUp
        ? (persisted.value as T)
        : serverValue;

  function begin(next: T): number {
    const token = ++tokenRef.current;
    begunRef.current = { token, value: next };
    setOverride({ value: next });
    return token;
  }
  function confirm(token: number, updatedAt: string) {
    if (tokenRef.current !== token) return;
    setOverride((o) => (o === null ? o : { ...o, confirmedUpdatedAt: updatedAt }));
    const begun = begunRef.current;
    if (begun?.token === token) ledger?.confirmField(row.id, field, begun.value, updatedAt);
  }
  function fail(token: number) {
    if (tokenRef.current !== token) return;
    setOverride(null);
  }
  return { value, begin, confirm, fail };
}

// The shared commit path for the `updateIssueAction` fields (assignee / priority
// / estimate). Optimistic: the caller begins a converging override, then
// `run` fires the gated action with the row's `expectedUpdatedAt`; on success
// `onConfirm` receives the acknowledged `updatedAt` and the cell is done — no
// refresh. Only a STALE conflict refreshes: the row genuinely needs re-reading
// (the override was dropped, and the next attempt needs a fresh concurrency
// token). On any failure `onFail` drops the override and a toast surfaces the
// typed message.
function useUpdateField(row: IssueRowData) {
  const router = useRouter();
  const { toast } = useToast();
  const t = useTranslations('issueViews');
  // The editors only render inside an editable provider, so ctx is present;
  // the prop fallback just keeps the hook total.
  const ledger = useIssueInlineEdit()?.ledger;
  const [pending, startTransition] = useTransition();
  function run(
    patch: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt'>,
    handlers: { onConfirm: (updatedAt: string) => void; onFail: () => void },
  ) {
    startTransition(async () => {
      let res: IssueActionResult;
      try {
        res = await updateIssueAction({
          id: row.id,
          expectedUpdatedAt: ledger ? ledger.latest(row) : row.updatedAt,
          ...patch,
        });
      } catch (err) {
        // The action REJECTED — no result to read, so neither arm below runs
        // and the optimistic override would otherwise stand for a write that
        // never landed (MOTIR-3948). Drop it and say why, the same two
        // dispositions the rail uses.
        handlers.onFail();
        toast({ variant: 'error', title: t(serverActionRejectionKey(err)) });
        return;
      }
      if (res.ok) {
        ledger?.acknowledge(row.id, res.updatedAt);
        handlers.onConfirm(res.updatedAt);
      } else if (res.stale) {
        handlers.onFail();
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else {
        handlers.onFail();
        toast({ variant: 'error', title: res.error });
      }
    });
  }
  return { run, pending };
}

// The cell's clickable resting state — the value rendered as a button that opens
// the picker. `relative z-10` lifts it above the row's stretched detail link so
// the click opens the editor instead of navigating (the AC's "opening a control
// does not navigate the row"); `stopPropagation` is belt-and-braces.
function EditTrigger({
  label,
  onOpen,
  disabled,
  className,
  children,
}: {
  label: string;
  onOpen: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      className={cn(
        'relative z-10 -mx-1 inline-flex max-w-full items-center rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-left hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60',
        className,
      )}
    >
      {children}
    </button>
  );
}

// The open editor wrapper. `z-30` (above the resting cells' `z-10` AND the
// sticky header's `z-20`) so the picker's dropdown — confined to this cell's
// stacking context — paints OVER the sibling rows below it, instead of being
// occluded by their later-in-DOM `z-10` cells. Also swallows clicks so a pick
// inside the picker never bubbles to the row navigation.
function EditSurface({ children }: { children: ReactNode }) {
  return (
    <span className="relative z-30 block w-full" onClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}

function InlineStatusEditor({ row, workflow }: { row: IssueRowData; workflow: WorkflowDto }) {
  const t = useTranslations('issueViews');
  const { toast } = useToast();
  const ledger = useIssueInlineEdit()?.ledger;
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  // A move an approval or a merge HOLDS (MOTIR-5529; the status-control design's
  // list-row panel): the ONE refused line, anchored on this row's status cell with
  // its door — not a toast. The list reads no gate per row; this is the refusal.
  // A PLAN hold (MOTIR-6268; the plan-hold status-control design's panel 8) is the
  // other arm: the list reads no plan per row either, so it draws the plan line
  // the refusal carried, with its Review plan door.
  const [held, setHeld] = useState<
    | { kind: 'gate'; line: StatusHeldLine }
    | { kind: 'plan'; plan: PlanHoldDTO }
    | { kind: 'mark'; mark: WorkItemObsolescenceDto }
    | null
  >(null);
  const heldRef = useRef<HTMLSpanElement>(null);
  const closeHeld = useCallback(() => setHeld(null), []);
  useDismissOnEscapeOrOutside(heldRef, held !== null, closeHeld);
  // Optimistic override: the just-picked key, confirmed by the action response
  // (see useConvergingOverride — the success response IS the confirmation; no
  // refresh follows). On failure the override is dropped and the cell reverts.
  const status = useConvergingOverride(row, 'status', row.status);

  const statusKey = status.value;
  const meta = workflow.statuses.find((s) => s.key === statusKey);
  const label = meta?.label ?? statusKey;
  const category = meta?.category ?? null;

  function commit(toStatusKey: string) {
    setEditing(false);
    if (toStatusKey === statusKey) return;
    const token = status.begin(toStatusKey);
    startTransition(async () => {
      let res: IssueActionResult;
      try {
        res = await changeStatusAction({ id: row.id, toStatusKey });
      } catch (err) {
        // Same third outcome as `useUpdateField`'s (MOTIR-3948): a rejected
        // action reaches neither arm, so the row kept the status it had
        // optimistically painted for a transition the server never made.
        status.fail(token);
        toast({ variant: 'error', title: t(serverActionRejectionKey(err)) });
        return;
      }
      if (res.ok) {
        // A status change bumps the row's `updatedAt` even though it submits
        // no token itself — later token-carrying edits on this row need it.
        ledger?.acknowledge(row.id, res.updatedAt);
        status.confirm(token, res.updatedAt);
      } else if (res.code === 'APPROVAL_GATE_PENDING' && res.gate) {
        status.fail(token);
        const target = workflow.statuses.find((s) => s.key === toStatusKey);
        setHeld({
          kind: 'gate',
          line: heldLineFromRefusal(toStatusKey, target?.label ?? toStatusKey, res.gate),
        });
      } else if (res.code === 'PLAN_TARGET_HELD' && res.plan) {
        status.fail(token);
        setHeld({ kind: 'plan', plan: res.plan });
      } else if (res.code === 'MARKED_CARD_CANNOT_REOPEN' && res.mark) {
        // A marked card cannot be reopened (MOTIR-6682): the same anchored box,
        // the mark's one line and its Open item door — never a toast.
        status.fail(token);
        setHeld({ kind: 'mark', mark: res.mark });
      } else {
        status.fail(token);
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  if (editing) {
    return (
      <EditSurface>
        <StatusPicker
          statuses={workflow.statuses}
          transitions={workflow.transitions}
          policyMode={workflow.policyMode}
          value={statusKey}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
        />
      </EditSurface>
    );
  }

  const trigger = (
    <EditTrigger
      label={`${t('edit')} ${t('status')}`}
      onOpen={() => {
        setHeld(null);
        setEditing(true);
      }}
      disabled={pending}
    >
      <StatusValue category={category} label={label} />
    </EditTrigger>
  );
  if (!held) return trigger;
  return (
    // The anchored line sits under the status cell, above the rows below it (the
    // same `z-30` the open editor takes), and never navigates the row.
    <span ref={heldRef} className="relative z-30 inline-block" onClick={(e) => e.stopPropagation()}>
      {trigger}
      <span
        data-list-held=""
        className="absolute top-full left-0 mt-1.5 block w-[18.75rem] rounded-(--radius-control) shadow-(--shadow-elevated)"
      >
        {held.kind === 'plan' ? (
          <StatusHeldNotice itemKey={row.identifier} lines={[]} plan={held.plan} />
        ) : held.kind === 'mark' ? (
          <StatusHeldNotice
            itemKey={row.identifier}
            lines={[]}
            mark={{ mark: held.mark, refused: true, inPlace: true }}
          />
        ) : (
          <StatusHeldNotice itemKey={row.identifier} lines={[held.line]} />
        )}
      </span>
    </span>
  );
}

function InlineAssigneeEditor({
  row,
  members,
}: {
  row: IssueRowData;
  members: WorkspaceMemberDTO[];
}) {
  const t = useTranslations('issueViews');
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  // Converging override (the value may be null for an unassign) — held until
  // the server's row catches up with the acknowledged write.
  const assignee = useConvergingOverride(row, 'assigneeId', row.assigneeId);

  const assigneeId = assignee.value;
  const member = assigneeId ? members.find((m) => m.userId === assigneeId) : undefined;
  const name = member ? personDisplayName(member) : null;

  function commit(userId: string | null) {
    setEditing(false);
    if (userId === assigneeId) return;
    const token = assignee.begin(userId);
    run(
      { assigneeId: userId },
      {
        onConfirm: (updatedAt) => assignee.confirm(token, updatedAt),
        onFail: () => assignee.fail(token),
      },
    );
  }

  if (editing) {
    return (
      <EditSurface>
        <AssigneePicker
          members={members}
          value={assigneeId}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('assignee')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
    >
      <AssigneeValue name={name} />
    </EditTrigger>
  );
}

function InlinePriorityEditor({ row }: { row: IssueRowData }) {
  const t = useTranslations('issueViews');
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  const priorityField = useConvergingOverride(row, 'priority', row.priority);

  const priority = priorityField.value;

  function commit(next: WorkItemPriorityDto) {
    setEditing(false);
    if (next === priority) return;
    const token = priorityField.begin(next);
    run(
      { priority: next },
      {
        onConfirm: (updatedAt) => priorityField.confirm(token, updatedAt),
        onFail: () => priorityField.fail(token),
      },
    );
  }

  if (editing) {
    return (
      <EditSurface>
        <PriorityPicker
          value={priority}
          onChange={commit}
          disabled={pending}
          autoOpen
          onClose={() => setEditing(false)}
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('priority')}`}
      onOpen={() => setEditing(true)}
      disabled={pending}
    >
      <PriorityValue priority={priority} />
    </EditTrigger>
  );
}

function InlineEstimateEditor({ row }: { row: IssueRowData }) {
  const t = useTranslations('issueViews');
  const { run, pending } = useUpdateField(row);
  const [editing, setEditing] = useState(false);
  const estimateField = useConvergingOverride(row, 'estimateMinutes', row.estimateMinutes);
  // The free-text draft, seeded from the shown value each time the editor
  // opens (the cell no longer remounts on a server change, so a mount-time
  // seed would go stale).
  const [draft, setDraft] = useState('');

  const estimate = estimateField.value;
  const label = estimate != null ? formatDurationMinutes(estimate) : null;

  function open() {
    setDraft(estimate != null ? String(estimate) : '');
    setEditing(true);
  }

  // Commit on blur / Enter (not per-keystroke), like the detail page's estimate
  // field. An empty field clears the estimate; an invalid number is a no-op.
  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next != null && (!Number.isFinite(next) || next < 0)) return;
    if (next === (estimate ?? null)) return;
    const token = estimateField.begin(next);
    run(
      { estimateMinutes: next },
      {
        onConfirm: (updatedAt) => estimateField.confirm(token, updatedAt),
        onFail: () => estimateField.fail(token),
      },
    );
  }

  if (editing) {
    // A compact, cell-sized field — the form-sized `Input` (taller
    // `--height-input` + FormField chrome) doesn't fit a table row. Same shape /
    // colour element tokens (control height, input radius, strong border), native
    // number spinners hidden (they overflow + aren't needed), right-aligned to
    // the column.
    return (
      <EditSurface>
        <input
          type="number"
          min={0}
          inputMode="numeric"
          aria-label={t('estimateMinutes')}
          className="h-(--height-control) w-full rounded-(--radius-input) border border-(--el-border-strong) bg-(--el-page-bg) px-(--spacing-control-x) text-right font-sans text-sm text-(--el-text) outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
          disabled={pending}
          autoFocus
        />
      </EditSurface>
    );
  }

  return (
    <EditTrigger
      label={`${t('edit')} ${t('estimate')}`}
      onOpen={open}
      disabled={pending}
      className="w-full justify-end"
    >
      <EstimateValue label={label} />
    </EditTrigger>
  );
}

// NOTE (bug-inline-status-revert-on-second-edit): the editors below are
// deliberately NOT keyed by their authoritative row value. The old keyed
// remount discarded the optimistic override on the FIRST server change —
// which let a stale refresh payload, applied after the fresh one, revert a
// row another in-flight edit had already committed. Reconciliation now lives
// in useConvergingOverride (the override yields only once the row's
// `updatedAt` reaches the acknowledged write), and confirmed values survive
// row unmounts (virtualization scroll-out, parent collapse) via the
// provider's ledger.

/** STATUS cell — inline-editable inside a provider, else the read-only pill. */
export function InlineStatusCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx)
    return (
      <StatusValue statusKey={row.status} category={row.statusCategory} label={row.statusLabel} />
    );
  return <InlineStatusEditor row={row} workflow={ctx.workflow} />;
}

/** ASSIGNEE cell — inline-editable inside a provider, else the read-only value. */
export function InlineAssigneeCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <AssigneeValue name={row.assigneeName} />;
  return <InlineAssigneeEditor row={row} members={ctx.members} />;
}

/** PRIORITY cell — inline-editable inside a provider, else the read-only chip. */
export function InlinePriorityCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <PriorityValue priority={row.priority} />;
  return <InlinePriorityEditor row={row} />;
}

/** ESTIMATE cell — inline-editable inside a provider, else the read-only value. */
export function InlineEstimateCell({ row }: { row: IssueRowData }) {
  const ctx = useIssueInlineEdit();
  if (!ctx) return <EstimateValue label={row.estimateLabel} />;
  return <InlineEstimateEditor row={row} />;
}
