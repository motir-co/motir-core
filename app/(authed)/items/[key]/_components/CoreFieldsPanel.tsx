'use client';

import {
  SurfaceTitle,
  useSurfaceTitleText,
} from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { personDisplayName } from '@/lib/people/personLabel';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Bot, Calendar, Clock, Folder, GitBranch, Goal, Plus, User } from 'lucide-react';
import type {
  ExecutorDto,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemPlacementDto,
  WorkItemRefMap,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { WorkflowDto } from '@/lib/dto/workflows';
import { bumpActivity } from '@/lib/hooks/useActivityRevision';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { LabelDto } from '@/lib/dto/labels';
import type { ComponentDto } from '@/lib/dto/components';
import type { SprintDto } from '@/lib/dto/sprints';
import type { IssueType } from '@/lib/issues/parentRules';
import type { Locale } from '@/lib/i18n/locales';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { StatusHeldNotice } from '@/components/issues/StatusHeldNotice';
import { useStatusHeld } from '@/components/issues/useStatusHeld';
import type { HeldTransitionDTO } from '@/lib/dto/approvalGate';
import type { PlanHoldDTO } from '@/lib/dto/plans';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { SprintPicker } from '@/components/issues/SprintPicker';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { TypePicker } from '@/components/issues/TypePicker';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { WorkItemTypePicker } from '@/components/issues/WorkItemTypePicker';
import { WorkItemTypeChip } from '@/components/issues/WorkItemTypeChip';
import { ExecutorPicker } from '@/components/issues/ExecutorPicker';
import { DifficultyIndicator, DifficultyPicker } from '@/components/issues/DifficultyPicker';
import { OBSOLESCENCE_FIELD_ANCHOR } from '@/components/issues/ObsolescenceBadge';
import { ObsolescenceField } from '@/components/issues/ObsolescenceField';
import { useApplyOptimisticMark } from './OptimisticMarkProvider';
import { canCarryObsolescence } from '@/lib/issues/obsolescence';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { defaultExecutorForType, isTypeableKind } from '@/lib/issues/executorDefaults';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import { formatDateTime, formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import {
  changeStatusAction,
  fileWorkItemAction,
  updateIssueAction,
  type UpdateIssueInput,
} from '../edit/actions';
import { setWorkItemSprint } from '@/components/issues/actions/workItemActionsClient';
import { Avatar, FieldCard } from './FieldCard';
import { CustomFieldsSection } from './CustomFieldsSection';
import { RepositorySetField } from '@/components/workItems/RepositorySetField';
import type { RepoDelivery } from '@/lib/workItems/repoDelivery';
import type { WorkItemDeliveryDto } from '@/lib/dto/github';
import { LabelsCard } from './LabelsCard';
import { ComponentsCard } from './ComponentsCard';
import { ProvenanceSection } from './ProvenanceSection';
import { StatusPill } from '@/components/issues/StatusPill';
import { useDisplayedStatus } from './OptimisticStatusProvider';
import { usePlacement, usePlacementReporter } from './PlacementProvider';
import { QuickViewFolderControl } from '../../_components/QuickViewFolderField';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';

// The issue detail metadata rail (Story 2.4 · Subtasks 2.4.2 + 2.4.4). Per the
// mockup `design/work-items/detail.png`: a stack of field cards that DISPLAY the
// value normally, each with a chevron in the top-right corner to edit it inline.
// Clicking the chevron swaps the value for the field's control; picking a new
// value commits through the shipped Server Actions (changeStatusAction → the
// gated 2.2.4 transition path; updateIssueAction → the concurrency-checked
// updateWorkItem) and refreshes the route. Status / type / priority / assignee /
// parent / due / estimate are editable; reporter + created/updated are read-only.

export interface CoreFieldsPanelProps {
  item: WorkItemDto;
  /**
   * The status moves an approval HOLDS (Story MOTIR-4887 · MOTIR-5528) — the
   * status card draws them as a message under its value and locks them in the
   * picker. Defaults to `[]`, the state almost every card is in.
   */
  heldTransitions?: HeldTransitionDTO[];
  /**
   * The undecided PLAN holding the card at Planning (Story MOTIR-6017 ·
   * MOTIR-6267) — every move locked, and the status card says so with a Review
   * plan door, to an editor and a reader alike. Defaults to none.
   */
  planHold?: PlanHoldDTO | null;
  /**
   * The page's resolved work-item refs (bug MOTIR-10023) — the item read resolves
   * the obsolescence note's `[KEY](motir:<id>)` links with the bodies', and the
   * Obsolescence field draws them from this. Defaults to none.
   */
  workItemRefs?: WorkItemRefMap;
  members: WorkspaceMemberDTO[];
  workflow: WorkflowDto;
  /** The resolved parent summary (for the Parent card's display). */
  parent: WorkItemSummaryDto | null;
  /** True when the reporter is the signed-in viewer (renders a "You" chip). */
  reporterIsSelf?: boolean;
  /**
   * The project's custom-field definitions + this issue's values (Subtask
   * 5.3.7), rendered as a contiguous card block after Estimate and before
   * created/updated. With no definitions the rail renders exactly as before.
   */
  customFields?: CustomFieldWithValueDto[];
  /**
   * Every repository this item ships in, with each one's DELIVERY state (Story
   * MOTIR-2725 · MOTIR-2415) — RESOLVED server-side by
   * `workItemsService.listRepoDelivery`, which calls the same classifier the
   * completion gate calls, so the panel can never say `delivered` about a
   * repository the gate is holding the card for.
   *
   * Defaults to `[]` — the empty set, which is the state most cards are in and a
   * deliberate one, not a missing value.
   */
  repoDelivery?: RepoDelivery[];
  /** The card's DELIVERY SET (MOTIR-3660) — the rail caption names the pull
   *  request that is outstanding, which a repository row cannot. */
  deliveries?: WorkItemDeliveryDto[];
  /**
   * Labels + components (Story 5.4 · Subtask 5.4.8) — the two cards slot
   * between Parent and Due date (the relational group, ahead of the
   * date/estimate block — labels-components-watch.mock.html panel 0). The
   * page threads the project key (the label-autocomplete route), the project
   * taxonomy (the components picker's option source), and the admin flag
   * (the empty-taxonomy "Manage components" link). Omitted (older call
   * sites / unit tests), the rail renders without the two cards.
   */
  labelsComponents?: {
    projectKey: string;
    labels: LabelDto[];
    components: ComponentDto[];
    projectComponents: ComponentDto[];
    canManageComponents: boolean;
  };
  /**
   * The project's sprints (Subtask 2.4.14) — backs the inline Sprint field's
   * picker + the current sprint's display name. Omitted (older call sites / unit
   * tests) or for an EPIC, the Sprint card does not render (epics span sprints,
   * Jira-faithful).
   */
  sprints?: SprintDto[];
}

type EditableKey =
  | 'status'
  | 'type'
  | 'workItemType'
  | 'executor'
  | 'difficulty'
  | 'obsolescence'
  | 'priority'
  | 'assignee'
  | 'parent'
  | 'folder'
  | 'sprint'
  | 'dueDate'
  | 'estimate';

// The read-mode executor indicator (Story 2.7 · 2.7.4) — a compact bot/person
// glyph + label, per design panel 3. Decorative glyph; the label carries the name.
const EXECUTOR_GLYPH: Record<ExecutorDto, typeof Bot> = { coding_agent: Bot, human: User };

function ExecutorIndicator({ executor }: { executor: ExecutorDto }) {
  const tl = useTranslations('labels');
  const Glyph = EXECUTOR_GLYPH[executor];
  return (
    <span className="flex items-center gap-1.5">
      <Glyph className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
      {tl(`executor.${executor}`)}
    </span>
  );
}

// The status chip's tone + glyph live in `components/issues/StatusPill`
// (MOTIR-3103). This file used to keep its own copy of the category map —
// one of five — which is how `implemented` could share a chip with three
// other statuses in every one of them at once.

/** No resolved refs — a host with no item read (a test, a story) passes none. */
const NO_REFS: WorkItemRefMap = {};

// Priority chip presentation now lives in the shared `PRIORITY_META` (reused by
// the issue-list row, 2.5.3) — imported above.

// Avatar + FieldCard moved to `./FieldCard` (Subtask 5.3.7) so the custom-field
// cards compose the same chrome — imported above.

export function CoreFieldsPanel({
  item,
  members,
  workflow,
  parent,
  reporterIsSelf,
  customFields = [],
  repoDelivery = [],
  deliveries = [],
  labelsComponents,
  sprints = [],
  heldTransitions,
  planHold,
  workItemRefs = NO_REFS,
}: CoreFieldsPanelProps) {
  const routes = useReaderRoutes();
  const router = useRouter();
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const tob = useTranslations('workItems.obsolescence');
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  // Story 6.4.6 — a read-only actor (viewer, or member on a limited project)
  // sees every field control disabled. The server (6.4.3) rejects the write
  // regardless; disabling here makes the affordance honest rather than letting
  // a viewer edit then bounce off a 403.
  // MOTIR-2473 — the key this control's own write asserts:
  // `projectAccessService.assertCanEdit` resolves `work_item:edit`.
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  const readOnly = !canEdit;
  // MOTIR-6173 — the permission-gated UI rule's part 2: every field card a
  // read-only actor sees keeps its chevron DISABLED, with this reason on it, and
  // never mounts an editor (the MOTIR-4822 path was an auto-opening picker
  // mounted for a Viewer). Undefined for an actor who can edit.
  const tpa = useTranslations('projectAccess');
  const readOnlyReason = readOnly ? tpa('readOnlyHint') : undefined;
  const [editing, setEditing] = useState<EditableKey | null>(null);
  const [updatedAt, setUpdatedAt] = useState(item.updatedAt);
  const [dueDate, setDueDate] = useState(item.dueDate ? item.dueDate.slice(0, 10) : '');
  const [estimate, setEstimate] = useState(
    item.estimateMinutes != null ? String(item.estimateMinutes) : '',
  );
  // Optimistic field overrides (the inline-edit rule, bug-inline-status-revert):
  // a picked value displays immediately and the action RESPONSE is the
  // confirmation, so we KEEP it — never router.refresh() on success, which
  // re-reads the not-yet-propagated server tree and reverts this cell AND any
  // sibling optimistic state on the page (the estimation/watch flakes). Cleared
  // back to the server value only on error / a stale-conflict re-read.
  const [overrides, setOverrides] = useState<Partial<WorkItemDto>>({});
  // The picked parent's display label: the relational field can't derive its
  // identifier/title from the id alone, so the picker hands it over (`undefined`
  // = no pending change → show the server `parent`).
  const [parentOverride, setParentOverride] = useState<
    Pick<WorkItemSummaryDto, 'id' | 'identifier' | 'title'> | null | undefined
  >(undefined);
  // THE STATUS ANOTHER ISLAND ON THIS PAGE JUST MOVED (Bug MOTIR-5212). An
  // approval gate is decided in its own frame further down the page, and the
  // decision writes the card's status — a surface only this panel draws. The
  // provider carries the status key the decide response RECORDED the server
  // writing, so the rail repaints without waiting for the RSC apply that
  // MOTIR-5118 measured being intermittently lost. Outside the provider (unit
  // call sites, the peek) it is `item.status` unchanged.
  const pageStatus = useDisplayedStatus(item.status);
  // ⚠️ PRECEDENCE: this reader's OWN inline edit outranks the page channel, and
  // the order is the whole rule. Someone who has just picked a status by hand is
  // looking at the cell they picked it in — case 1 of the page-state contract,
  // where the response IS the confirmation. A gate decided elsewhere must never
  // pull that value out from under them; the reconcile above settles both the
  // instant a server render lands.
  const eff = { ...item, status: pageStatus, ...overrides };
  // The held moves, filtered by the status the card shows NOW — an approval that
  // repaints the page in place moves it without going through this panel.
  const statusHeld = useStatusHeld(
    heldTransitions,
    workflow.statuses,
    eff.status,
    planHold,
    // …and the mark, as the rail shows it NOW (MOTIR-6676): clearing it in the
    // Obsolescence field below lifts the hold with no reload.
    eff.obsolescence,
  );
  const effParent = parentOverride !== undefined ? parentOverride : parent;

  // THE FOLDER FIELD (Story MOTIR-5309 · MOTIR-5377). Its value is the page's
  // placement channel — where the item sits, as the server last answered — so it
  // renders only on the page (`null` outside a provider). A pick shows at once
  // (the inline-edit rule); the pending value is stored with the placement it was
  // picked OVER and stands only while the channel still reads that placement, so
  // the server's answer to the report — or to a later Parent change — replaces it.
  const placement = usePlacement();
  const tf = useTranslations('folders');
  const [folderOverride, setFolderOverride] = useState<
    { folderId: string | null; path: string[]; over: WorkItemPlacementDto | null } | undefined
  >(undefined);
  const pendingFolder =
    folderOverride !== undefined && folderOverride.over === placement ? folderOverride : undefined;
  // The item's OWN folder — the picker's checked option. An item placed through its
  // root has none of its own, so picking the inherited folder files it directly.
  const ownFolderId = pendingFolder ? pendingFolder.folderId : (placement?.folderId ?? null);
  const shownFolder: { path: string[]; via: WorkItemSummaryDto | null } | null = pendingFolder
    ? pendingFolder.folderId === null
      ? null
      : { path: pendingFolder.path, via: null }
    : (placement?.placementFolder ?? null);
  const viaTitle = useSurfaceTitleText(shownFolder?.via?.id ?? '', shownFolder?.via?.title ?? '');

  const typeMeta = ISSUE_TYPE_META[eff.kind];
  const reporter = members.find((m) => m.userId === eff.reporterId);
  const assignee = members.find((m) => m.userId === eff.assigneeId);
  const statusMeta = workflow.statuses.find((s) => s.key === eff.status);
  // The Sprint field's empty label is status-aware: an ACTIVE item with no sprint
  // sits in the Backlog, but a DONE/cancelled one is EXCLUDED from the backlog
  // (backlogService.backlogExcludedStatusKeys → every category 'done' status), so
  // it reads "None". Used for BOTH the read value AND the picker sentinel so the
  // two never disagree.
  const sprintEmptyLabel = statusMeta?.category === 'done' ? t('none') : t('backlog');
  const currentSprint = eff.sprintId ? sprints.find((s) => s.id === eff.sprintId) : undefined;

  // Drop the optimistic override for the given field keys (on error / stale).
  function revert(keys: string[]) {
    setOverrides((o) => {
      const next = { ...o };
      for (const k of keys) delete next[k as keyof WorkItemDto];
      return next;
    });
    if (keys.includes('parentId')) setParentOverride(undefined);
  }

  const toggle = (key: EditableKey) => {
    // A read-only actor never enters edit mode — not from the chevron (which is
    // disabled) and not from an inline "Set …" button (which they are not shown).
    if (readOnly) return;
    setEditing((cur) => (cur === key ? null : key));
  };

  // THE PAGE'S PLACEMENT CHANNEL (MOTIR-5381). A parent change moves the item, and
  // the breadcrumb that draws where it sits is another island; reporting asks the
  // server where the item now is. A no-op outside the page (unit call sites).
  const reportPlacementChange = usePlacementReporter();

  // File the item into a folder, or take it out of one. The placement rules are
  // `fileWorkItem`'s: filing clears a work-item parent (so Parent reads None while
  // it saves), un-filing leaves the parent as it is. The success arm's `updatedAt`
  // becomes the panel's token so the next inline edit is not refused as stale.
  function fileIntoFolder(folderId: string | null, path: string[]) {
    setEditing(null);
    /* v8 ignore next -- UNREACHABLE through the shipped control: the picker's
       `choose` DISMISSES on its current option and never hands it back, and the
       current option is exactly `ownFolderId`. Kept as the rail's own guard should
       the control change. Asserted by issue-detail-fields.test.tsx › 'picking the
       folder the item is already in writes nothing'. */
    if (folderId === ownFolderId) return;
    setFolderOverride({ folderId, path, over: placement });
    if (folderId !== null) {
      setParentOverride(null);
      setOverrides((o) => ({ ...o, parentId: null }));
    }
    startTransition(async () => {
      const res = await fileWorkItemAction({ workItemId: item.id, folderId });
      if (res.ok) {
        setUpdatedAt(res.updatedAt);
        reportPlacementChange(item.id);
      } else {
        setFolderOverride(undefined);
        if (folderId !== null) revert(['parentId']);
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  function patch(input: Omit<UpdateIssueInput, 'id' | 'expectedUpdatedAt' | 'languages'>) {
    setEditing(null);
    setOverrides((o) => ({ ...o, ...input }));
    startTransition(async () => {
      const res = await updateIssueAction({ id: item.id, expectedUpdatedAt: updatedAt, ...input });
      if (res.ok) {
        // The 200 IS the confirmation — keep the optimistic value, no refresh.
        setUpdatedAt(res.updatedAt);
        // ...but the activity island (a client island the refresh could not
        // reach anyway) re-reads, so the recorded change shows at once.
        bumpActivity(item.id);
        // Only after a SUCCESSFUL parent change: a failed or stale save moved nothing.
        if (input.parentId !== undefined) reportPlacementChange(item.id);
      } else if (res.stale) {
        // A genuine conflict (someone else edited): drop our optimistic value
        // and re-read the server's newer state — the one place a refresh is right.
        revert(Object.keys(input));
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else {
        revert(Object.keys(input));
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  // THE OBSOLESCENCE WRITE (Story MOTIR-6575 · MOTIR-6674). The patch path's rule
  // (optimistic, the 200 is the confirmation, a stale conflict re-reads) with two
  // differences: the editor STAYS OPEN after a mark press so the note can follow,
  // and the finished-card refusal is drawn IN the field rather than as a toast.
  const [obsolescenceRefusal, setObsolescenceRefusal] = useState<string | null>(null);
  const applyOptimisticMark = useApplyOptimisticMark();
  function writeObsolescence(
    input: Pick<UpdateIssueInput, 'obsolescence' | 'obsolescenceNoteMd'>,
    opts: { close?: boolean } = {},
  ) {
    if (opts.close) setEditing(null);
    setObsolescenceRefusal(null);
    setOverrides((o) => ({ ...o, ...input }));
    startTransition(async () => {
      const res = await updateIssueAction({ id: item.id, expectedUpdatedAt: updatedAt, ...input });
      if (res.ok) {
        setUpdatedAt(res.updatedAt);
        bumpActivity(item.id);
        // The header badge is another surface: tell it what the 200 confirmed,
        // never by a refresh (the inline-edit rule above).
        if ('obsolescence' in input) applyOptimisticMark(input.obsolescence ?? null);
      } else if (res.stale) {
        revert(Object.keys(input));
        toast({ variant: 'error', title: t('changedElsewhereRefreshing') });
        router.refresh();
      } else if (res.code === 'OBSOLESCENCE_REQUIRES_FINISHED') {
        revert(Object.keys(input));
        setObsolescenceRefusal(res.error);
      } else {
        revert(Object.keys(input));
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  function changeStatus(toStatusKey: string) {
    setEditing(null);
    if (toStatusKey === eff.status) return;
    setOverrides((o) => ({ ...o, status: toStatusKey }));
    startTransition(async () => {
      const res = await changeStatusAction({ id: item.id, toStatusKey });
      if (res.ok) {
        setUpdatedAt(res.updatedAt);
        statusHeld.onMoved(toStatusKey);
      } else if (res.code === 'APPROVAL_GATE_PENDING' && res.gate) {
        // A hold that arrived after render (MOTIR-5528): revert, and say so ON the
        // status control with its door — not in a toast that points nowhere.
        revert(['status']);
        statusHeld.onRefused(toStatusKey, res.gate);
      } else if (res.code === 'PLAN_TARGET_HELD' && res.plan) {
        // A plan took the card after render (MOTIR-6267): revert, and draw the
        // plan's line with its Review plan door — never a toast.
        revert(['status']);
        statusHeld.onPlanHeldRefused(res.plan);
      } else if (res.code === 'MARKED_CARD_CANNOT_REOPEN' && res.mark) {
        // The card was marked after render (MOTIR-6676): revert, and draw the
        // mark's line with its Clear the mark door — never a toast.
        revert(['status']);
        statusHeld.onMarkRefused(res.mark);
      } else {
        revert(['status']);
        toast({ variant: 'error', title: res.error });
      }
    });
  }

  // Due date commits as soon as the DatePicker fires (a day picked or cleared);
  // the picker owns its own open/close, so there's no blur/chevron commit. patch()
  // closes edit mode on a real change; an unchanged pick just closes.
  function commitDue(next: string | null) {
    setDueDate(next ?? '');
    const iso = next ? new Date(`${next}T00:00:00.000Z`).toISOString() : null;
    if (iso !== eff.dueDate) patch({ dueDate: iso });
    else setEditing(null);
  }
  // Estimate stays a free-text field: commits on blur AND when the chevron
  // collapses it (the chevron no longer blurs the input).
  function commitEstimate() {
    const next = estimate === '' ? null : Number(estimate);
    if (next !== eff.estimateMinutes) patch({ estimateMinutes: next });
    else setEditing(null);
  }

  // Sprint commits through the existing assign route (4.1.4) via the client
  // helper — NOT updateIssueAction (sprint assignment is a ranked move owned by
  // backlogService, not a field patch). Optimistic like the other inline fields:
  // the picked value displays immediately and the 200 IS the confirmation (no
  // router.refresh of the cell — the page-state inline-edit rule); reverted only
  // on error. `null` = move to the backlog.
  function commitSprint(next: string | null) {
    setEditing(null);
    if (next === (eff.sprintId ?? null)) return;
    setOverrides((o) => ({ ...o, sprintId: next }));
    startTransition(async () => {
      try {
        const res = await setWorkItemSprint(item.id, next);
        setUpdatedAt(res.updatedAt);
      } catch {
        revert(['sprintId']);
        toast({ variant: 'error', title: t('sprintChangeFailed') });
      }
    });
  }

  const muted = (text: string) => <span className="text-(--el-text-secondary) italic">{text}</span>;
  const priorityPill = PRIORITY_META[eff.priority];

  return (
    <div className="flex flex-col gap-3">
      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('status')}
        editing={editing === 'status'}
        onToggle={() => toggle('status')}
      >
        <div className="flex flex-col items-start gap-2">
          {editing === 'status' ? (
            <StatusPicker
              statuses={workflow.statuses}
              transitions={workflow.transitions}
              policyMode={workflow.policyMode}
              value={eff.status}
              onChange={changeStatus}
              disabled={isPending || readOnly}
              held={statusHeld.held}
            />
          ) : statusMeta ? (
            <StatusPill
              statusKey={statusMeta.key}
              category={statusMeta.category}
              label={statusMeta.label}
            />
          ) : (
            <Pill tone="neutral">{eff.status}</Pill>
          )}
          {/* The held message sits UNDER the value and stays visible whether or not
              the picker is open (design § The status control says so). */}
          <StatusHeldNotice
            itemKey={item.identifier}
            lines={statusHeld.lines}
            plan={statusHeld.plan}
            mark={statusHeld.mark}
          />
        </div>
      </FieldCard>

      {/* Session branch (Subtask 7.8.11) — a READ-ONLY line under Status,
          present only while the item is integrated-awaiting-review (its work
          merged to a session branch via `mark_integrated`, cleared on done). No
          editing affordance: it's set/cleared by the integration tools, never by
          hand. Reuses the read-only FieldCard chrome (no new visual element). */}
      {eff.sessionBranch ? (
        <FieldCard label={t('sessionBranch')} editable={false}>
          <span className="flex items-center gap-1.5">
            <GitBranch className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            <span className="truncate font-mono text-xs">{eff.sessionBranch}</span>
          </span>
        </FieldCard>
      ) : null}

      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('type')}
        editing={editing === 'type'}
        onToggle={() => toggle('type')}
      >
        {editing === 'type' ? (
          <TypePicker
            value={eff.kind as IssueType}
            onChange={(kind) => patch({ kind: kind as WorkItemKindDto })}
            disabled={isPending || readOnly}
          />
        ) : (
          <span className="flex items-center gap-1.5">
            <IssueTypeIcon type={eff.kind as IssueType} className="h-4 w-4" />
            {typeMeta.label}
          </span>
        )}
      </FieldCard>

      {/* Work type + Executor (Story 2.7 · 2.7.4) — the NATURE of the work +
          WHO does it, per design/work-items/type-executor-picker.mock.html
          panel 3. LEAF-ONLY: shown only for a leaf kind (task/subtask/bug),
          absent for epic/story (panel 2d). Inline-edit reuses the SAME picker
          (the 2.5.5 pattern); choosing a type seeds the executor when none is
          set (matching the service seed-if-absent), preserving an override. The
          Executor row appears only once a type is set (it follows the type). */}
      {isTypeableKind(eff.kind as WorkItemKindDto) ? (
        <>
          <FieldCard
            readOnlyReason={readOnlyReason}
            label={t('workItemType')}
            editing={editing === 'workItemType'}
            onToggle={() => toggle('workItemType')}
          >
            {editing === 'workItemType' ? (
              <WorkItemTypePicker
                value={eff.type}
                onChange={(tp) =>
                  patch({
                    type: tp,
                    ...(eff.executor == null ? { executor: defaultExecutorForType(tp) } : {}),
                  })
                }
                onClose={() => setEditing(null)}
                autoOpen
                disabled={isPending || readOnly}
              />
            ) : eff.type ? (
              <WorkItemTypeChip type={eff.type} />
            ) : readOnly ? (
              <span className="text-(--el-text-secondary)">{t('none')}</span>
            ) : (
              <button
                type="button"
                onClick={() => toggle('workItemType')}
                disabled={isPending || readOnly}
                className="inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-dashed border-(--el-border-strong) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text-muted) hover:text-(--el-text) disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5 text-(--el-text-faint)" aria-hidden />
                {t('setType')}
              </button>
            )}
          </FieldCard>

          {eff.type ? (
            <FieldCard
              readOnlyReason={readOnlyReason}
              label={t('executor')}
              editing={editing === 'executor'}
              onToggle={() => toggle('executor')}
            >
              {editing === 'executor' ? (
                <ExecutorPicker
                  value={eff.executor ?? defaultExecutorForType(eff.type)}
                  onChange={(ex) => patch({ executor: ex })}
                  disabled={isPending || readOnly}
                />
              ) : (
                <ExecutorIndicator executor={eff.executor ?? defaultExecutorForType(eff.type)} />
              )}
            </FieldCard>
          ) : null}

          {/* Difficulty (Story MOTIR-6016 · MOTIR-6101), per
              design/work-items/core-fields--difficulty.mock.html — directly below
              Executor, inside the SAME leaf-only branch, so an epic/story renders
              no card at all. Unlike Executor it does not wait for a type. A
              read-only viewer sees the value and a DISABLED chevron that says why
              (MOTIR-6173). */}
          <FieldCard
            readOnlyReason={readOnlyReason}
            label={t('difficulty')}
            editing={editing === 'difficulty'}
            onToggle={() => toggle('difficulty')}
          >
            {editing === 'difficulty' ? (
              <DifficultyPicker
                value={eff.difficulty}
                onChange={(d) => patch({ difficulty: d })}
                disabled={isPending || readOnly}
              />
            ) : eff.difficulty ? (
              <DifficultyIndicator difficulty={eff.difficulty} />
            ) : readOnly ? (
              <span className="text-(--el-text-secondary)">{t('none')}</span>
            ) : (
              <button
                type="button"
                onClick={() => toggle('difficulty')}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-(--radius-badge) border border-dashed border-(--el-border-strong) px-(--spacing-chip-x) py-(--spacing-chip-y) text-(--el-text-muted) hover:text-(--el-text) disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5 text-(--el-text-faint)" aria-hidden />
                {t('setDifficulty')}
              </button>
            )}
          </FieldCard>
        </>
      ) : null}

      {/* Obsolescence (Story MOTIR-6575 · MOTIR-6674), per
          design/work-items/core-fields--obsolescence.mock.html — directly below
          Difficulty and OUTSIDE the leaf-only branch: every kind may carry the
          mark. Both marks are locked on a card outside the done category
          (`canCarryObsolescence`), decided from the status the rail already shows;
          the server (MOTIR-6672) stays the authority. The header badge scrolls
          here, so the card is the anchor. */}
      <div id={OBSOLESCENCE_FIELD_ANCHOR} tabIndex={-1} className="focus:outline-none">
        <FieldCard
          readOnlyReason={readOnlyReason}
          label={tob('label')}
          editing={editing === 'obsolescence'}
          onToggle={() => toggle('obsolescence')}
        >
          <ObsolescenceField
            value={eff.obsolescence}
            noteMd={eff.obsolescenceNoteMd}
            workItemRefs={workItemRefs}
            editing={editing === 'obsolescence' && !readOnly}
            locked={!canCarryObsolescence(statusMeta?.category)}
            pending={isPending}
            refusal={obsolescenceRefusal}
            onMark={(obsolescence) => writeObsolescence({ obsolescence })}
            onNote={(obsolescenceNoteMd) =>
              writeObsolescence({ obsolescenceNoteMd }, { close: true })
            }
            onCancelNote={() => setEditing(null)}
          />
        </FieldCard>
      </div>

      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('priority')}
        editing={editing === 'priority'}
        onToggle={() => toggle('priority')}
      >
        {editing === 'priority' ? (
          <PriorityPicker
            value={eff.priority}
            onChange={(priority) => patch({ priority })}
            disabled={isPending || readOnly}
          />
        ) : (
          <Pill {...priorityPill.pill}>
            <priorityPill.icon className="h-3 w-3" aria-hidden />
            {tl('priority.' + eff.priority)}
          </Pill>
        )}
      </FieldCard>

      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('assignee')}
        editing={editing === 'assignee'}
        onToggle={() => toggle('assignee')}
      >
        {editing === 'assignee' ? (
          <AssigneePicker
            members={members}
            value={eff.assigneeId}
            onChange={(userId) => patch({ assigneeId: userId })}
            disabled={isPending || readOnly}
          />
        ) : assignee ? (
          <span className="flex items-center gap-2">
            <Avatar name={personDisplayName(assignee)} />
            <span className="truncate">{assignee.name}</span>
          </span>
        ) : (
          muted(t('unassigned'))
        )}
      </FieldCard>

      <FieldCard label={t('reporter')} editable={false}>
        {reporter ? (
          <span className="flex items-center gap-2">
            <Avatar name={personDisplayName(reporter)} />
            <span className="truncate">{reporter.name}</span>
            {reporterIsSelf ? <Pill tone="neutral">{t('you')}</Pill> : null}
          </span>
        ) : (
          muted(t('unknown'))
        )}
      </FieldCard>

      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('parent')}
        editing={editing === 'parent'}
        onToggle={() => toggle('parent')}
      >
        {editing === 'parent' ? (
          <ParentPicker
            childType={eff.kind as IssueType}
            value={eff.parentId}
            onChange={(parentId, picked) => {
              // The picker hands over the chosen parent's label so the display
              // shows it immediately (optimistic) without a server re-read.
              setParentOverride(picked && parentId ? { ...picked, id: parentId } : null);
              patch({ parentId });
            }}
            disabled={isPending || readOnly}
          />
        ) : effParent ? (
          <Link
            href={routes.item(effParent.identifier)}
            className="flex items-center gap-1.5 hover:underline"
          >
            <span className="text-(--el-text-secondary) font-mono text-xs">
              {effParent.identifier}
            </span>
            <span className="truncate">
              <SurfaceTitle id={effParent.id} title={effParent.title} />
            </span>
          </Link>
        ) : (
          muted(t('none'))
        )}
      </FieldCard>

      {/* Folder (MOTIR-5377, placement.mock.html panels 2–3) — directly below Parent,
          because the two are one fact about placement. The control is the quick
          view's, unforked. A viewer sees the value and a DISABLED chevron that
          says why (MOTIR-6173). */}
      {placement ? (
        <FieldCard
          readOnlyReason={readOnlyReason}
          label={tf('fieldLabel')}
          editing={editing === 'folder'}
          onToggle={() => toggle('folder')}
        >
          {editing === 'folder' ? (
            <QuickViewFolderControl
              folderId={ownFolderId}
              parent={effParent}
              onPick={fileIntoFolder}
              onDismiss={() => setEditing(null)}
            />
          ) : shownFolder ? (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <Folder className="h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
                <span className="truncate">{shownFolder.path.join(' ▸ ')}</span>
              </span>
              {shownFolder.via ? (
                <span className="text-xs text-(--el-text-secondary)">
                  {tf('placedThrough', {
                    key: shownFolder.via.identifier,
                    title: viaTitle,
                  })}
                </span>
              ) : null}
            </span>
          ) : (
            muted(tf('noFolder'))
          )}
        </FieldCard>
      ) : null}

      {/* Labels + Components (5.4.8) — between Parent and Due date: with the
          relational fields, ahead of the date/estimate group (the Jira
          details-panel grouping; labels-components-watch.mock.html panel 0).
          Each card owns its edit state + picker; commits confirm from the
          action response (no whole-tree refresh). */}
      {labelsComponents ? (
        <>
          <LabelsCard
            workItemId={item.id}
            projectKey={labelsComponents.projectKey}
            initialLabels={labelsComponents.labels}
          />
          <ComponentsCard
            workItemId={item.id}
            initialComponents={labelsComponents.components}
            projectComponents={labelsComponents.projectComponents}
            canManageComponents={labelsComponents.canManageComponents}
          />
        </>
      ) : null}

      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('dueDate')}
        editing={editing === 'dueDate'}
        onToggle={() => toggle('dueDate')}
      >
        {editing === 'dueDate' ? (
          <DatePicker
            aria-label={t('dueDate')}
            value={dueDate || null}
            onChange={commitDue}
            disabled={isPending || readOnly}
            autoOpen
          />
        ) : eff.dueDate ? (
          <span className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDate(eff.dueDate, locale)}
          </span>
        ) : (
          muted(t('noDueDate'))
        )}
      </FieldCard>

      {/* Sprint (Subtask 2.4.14) — between Due date and Story points (the agile
          cluster; design/work-items/sprint-field.mock.html). Inline-editable via
          the SprintPicker (Backlog-first sentinel). HIDDEN for epics — they span
          sprints (Jira-faithful). No sprint → muted-italic "Backlog" for an
          ACTIVE item, but "None" for a DONE/cancelled one (the backlog excludes
          category 'done', so such an item is not "in the Backlog"). The write
          goes through backlogService (the 4.1.4 assign route), so this commits
          optimistically with no router.refresh. */}
      {eff.kind !== 'epic' ? (
        <FieldCard
          readOnlyReason={readOnlyReason}
          label={t('sprint')}
          editing={editing === 'sprint'}
          onToggle={() => toggle('sprint')}
        >
          {editing === 'sprint' ? (
            <SprintPicker
              sprints={sprints}
              value={eff.sprintId}
              onChange={commitSprint}
              emptyLabel={sprintEmptyLabel}
              onClose={() => setEditing(null)}
              autoOpen
              disabled={isPending || readOnly}
            />
          ) : currentSprint ? (
            <span className="flex items-center gap-1.5">
              <Goal className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
              <span className="truncate">{currentSprint.name}</span>
              {currentSprint.state === 'complete' ? (
                <span className="text-(--el-text-muted) italic">({t('sprintCompleted')})</span>
              ) : null}
            </span>
          ) : (
            muted(sprintEmptyLabel)
          )}
        </FieldCard>
      ) : null}

      {/* Story points (Subtask 4.3.4) — the agile estimate, DISTINCT from the
          TIME Estimate below (design panel 2). The badge owns its own
          click-to-edit picker, so for an actor who can edit this card has no
          chevron (editable={false}) — a second one would be a second affordance
          for one field. A read-only actor gets the disabled chevron with its
          reason like every neighbour (MOTIR-6338, treatment-table row 6): the
          badge falls to its static chip, and without it the card would read as
          a field nobody edits. `forceStoryPoints` keeps it a story-points field
          regardless of the project's display statistic, so the reason is never
          wrong here. */}
      <FieldCard label={t('storyPoints')} editable={readOnly} readOnlyReason={readOnlyReason}>
        <EstimateBadge
          itemId={item.id}
          storyPoints={item.storyPoints}
          estimateMinutes={item.estimateMinutes}
          forceStoryPoints
        />
      </FieldCard>

      <FieldCard
        readOnlyReason={readOnlyReason}
        label={t('estimate')}
        editing={editing === 'estimate'}
        onToggle={() => (editing === 'estimate' ? commitEstimate() : setEditing('estimate'))}
      >
        {editing === 'estimate' ? (
          <Input
            type="number"
            min={0}
            aria-label={t('estimateMinutes')}
            value={estimate}
            onChange={(e) => setEstimate(e.target.value)}
            onBlur={commitEstimate}
            disabled={isPending || readOnly}
            autoFocus
          />
        ) : eff.estimateMinutes != null ? (
          <span className="flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDurationMinutes(eff.estimateMinutes)}
          </span>
        ) : (
          muted(t('noEstimate'))
        )}
      </FieldCard>

      {/* Repositories (Story MOTIR-2725 · MOTIR-2415) — EVERY repository this
          item ships in, with each one's delivery state, per
          design/work-items/repository-set.mock.html.

          PLACEMENT is the design's panel 0: after Estimate, before the collapsed
          Provenance disclosure — last of the always-visible fields. It is read at
          DISPATCH and REVIEW time rather than at triage time, so it must not push
          Status / Assignee / Priority down the rail; and it gates completion, so
          it outranks provenance and stays expanded. It sits BEFORE the
          custom-field block so the built-in FieldCard run stays contiguous (the
          comment below), which the design's panel 0 does not contradict — it drew
          no custom fields.

          READ-ONLY for now: the design chose an editable bounded picker, and the
          editor lands with the quick view's shared control in MOTIR-2416, so both
          surfaces get one editor rather than two. `editable={false}` drops the
          chevron, exactly as Story points does — no affordance that does nothing.

          The set renders NOTHING when the item carries no repositories AND the
          page could not resolve delivery... except it must: the empty set is a
          DELIBERATE state with its own copy, so the card always renders. */}
      <FieldCard label={t('repositories')} editable={false}>
        <RepositorySetField delivery={repoDelivery} deliveries={deliveries} />
      </FieldCard>

      {/* Custom fields (5.3.7) — a contiguous block after the last built-in
          card, before created/updated (custom-fields.mock.html panel 0). With
          no definitions the section renders nothing — the rail is unchanged. */}
      <CustomFieldsSection workItemId={item.id} fields={customFields} members={members} />

      {/* Created / updated — read-only audit fields (locale-aware date, UTC zone). */}
      <dl className="flex flex-col gap-1 px-1 pt-1 font-sans text-xs text-(--el-text-secondary)">
        <div className="flex justify-between gap-2">
          <dt>{t('created')}</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.createdAt, locale)}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>{t('updated')}</dt>
          <dd className="text-(--el-text)">{formatDateTime(item.updatedAt, locale)}</dd>
        </div>
      </dl>

      {/* Work-item provenance (Story MOTIR-1685 · MOTIR-1693) — a collapsed
          disclosure at the VERY BOTTOM of the rail (after every other field), per
          design/work-items/provenance.mock.html + the ADR's Decision 7. Read-only;
          expands to show the Planning + Implementation triples. */}
      <ProvenanceSection item={item} />
    </div>
  );
}
