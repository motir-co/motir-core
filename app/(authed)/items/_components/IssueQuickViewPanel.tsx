'use client';

import { SurfaceTitle } from '@/components/workItems/titleTranslation/SurfaceTitleTranslation';
import { RelatedTitles } from '../[key]/_components/translation/RelatedTitles';
import { personDisplayName } from '@/lib/people/personLabel';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArrowRight,
  Bot,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  Component as ComponentIcon,
  Goal,
  SearchX,
  User,
} from 'lucide-react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { ArchivedNotice } from '@/components/issues/ArchivedNotice';
import { DevelopmentSection, hasOpenPullRequest } from '@/components/github/DevelopmentSection';
import { DesignResultPanel } from '../[key]/_components/DesignResultPanel';
import { RepositorySetField } from '@/components/workItems/RepositorySetField';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { TypeInText } from '@/components/planning/TypeInText';
import { ProposalRef } from '@/components/planning/ProposalRef';
import { usePrefersReducedMotion } from '@/lib/hooks/usePrefersReducedMotion';
import {
  finishTypeIn,
  foldTypeIn,
  startTypeIn,
  typeInPhase,
  type TypedField,
} from '@/lib/planning/typeIn';
import { TodoRowReadOnly } from '@/app/(authed)/items/[key]/_components/TodoListSection';
import { ReadinessBadge } from '@/components/ui/ReadinessBadge';
import { WorkItemPlanEntrance } from '@/components/planning/WorkItemPlanEntrance';
import { Pill } from '@/components/ui/Pill';
import { MultiSelectPicker, ValueChip } from '@/components/ui/MultiSelectPicker';
import { Avatar, AssigneeValue, PriorityValue, StatusValue } from './issueCellPrimitives';
import { QuickViewCloseButton } from './QuickViewCloseButton';
import { StatusPicker } from '@/components/issues/StatusPicker';
import { ToFixTag } from '@/components/workItems/ToFixTag';
import { StatusHeldNotice } from '@/components/issues/StatusHeldNotice';
import { useStatusHeld } from '@/components/issues/useStatusHeld';
import { AssigneePicker } from '@/components/issues/AssigneePicker';
import { SprintPicker } from '@/components/issues/SprintPicker';
import { ParentPicker } from '@/components/issues/ParentPicker';
import { setWorkItemSprint } from '@/components/issues/actions/workItemActionsClient';
import { changeStatusAction } from '../[key]/edit/actions';
import type { IssueType } from '@/lib/issues/parentRules';
import { EstimateBadge } from '@/components/issues/EstimateBadge';
import { EstimationConfigProvider } from '@/components/issues/EstimationConfigProvider';
import { PriorityPicker } from '@/components/issues/PriorityPicker';
import { WorkItemTypePicker } from '@/components/issues/WorkItemTypePicker';
import { ExecutorPicker } from '@/components/issues/ExecutorPicker';
import { DifficultyIndicator, DifficultyPicker } from '@/components/issues/DifficultyPicker';
import { ObsolescenceHeaderLink } from '@/components/issues/ObsolescenceBadge';
import { ObsolescenceField } from '@/components/issues/ObsolescenceField';
import { canCarryObsolescence } from '@/lib/issues/obsolescence';
import { DatePicker } from '@/components/ui/DatePicker';
import { Input } from '@/components/ui/Input';
import { EditableRailField, RailStaleNotice, useQuickViewRailEdit } from './QuickViewRailEdit';
import { QuickViewFolderControl } from './QuickViewFolderField';
import { useFolderCommands } from '@/components/folders/FolderCommands';
import { fileWorkItemAction } from '../[key]/edit/actions';
import { useLabelEditing, useComponentEditing } from './fieldChipEditing';
import { useCustomFieldEditing } from './customFieldEditing';
import { useProjectAccess } from '../../_components/ProjectAccessProvider';
import { LABELS_PER_ISSUE_LIMIT } from '@/lib/labels/constants';
import { WORK_ITEM_TYPE_META } from '@/lib/issues/workItemTypeMeta';
import { defaultExecutorForType, isTypeableKind } from '@/lib/issues/executorDefaults';
import { showsReadiness } from '@/lib/issues/readinessVisibility';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import type { ExecutorDto } from '@/lib/dto/workItems';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { Locale } from '@/lib/i18n/locales';
import type { QuickViewData } from '@/lib/dto/quickView';
import type { PlanProposalPeekDto } from '@/lib/dto/planReview';
import type { PlanItemOutcome } from '@/components/planning/PlanItemNode';
import { cn } from '@/lib/utils/cn';
import { ChangedMark, ProposalRailFoot } from '@/components/workItems/ProposalPeekMarks';
import {
  ProposalMarkRows,
  ProposalSupersedesRows,
} from '@/components/planning/ProposalMarkRailRows';
import {
  QuickViewBody,
  QuickViewHeader,
  QuickViewMain,
  QuickViewRail,
  QuickViewRailField,
} from '@/components/workItems/QuickViewSurface';
import { useReaderRoutes } from '@/lib/visitor/useReaderRoutes';
import { fieldRef } from '@/lib/translation/fieldRefs';
import { TranslationProvider } from '../[key]/_components/translation/TranslationProvider';
import { TranslateControl } from '../[key]/_components/translation/TranslateControl';
import { FieldTranslationMark } from '../[key]/_components/translation/FieldTranslationMark';
import {
  TranslatableMarkdown,
  TranslatableTitle,
} from '../[key]/_components/translation/TranslatableFields';

/** The fields the quick view draws, and so the only ones it offers and marks (D3). */
const QUICK_VIEW_FIELDS = [fieldRef.title(), fieldRef.description()];

/** The peek's own anchor for the header badge — distinct from the item page's,
 *  because the peek can open over an item page that has its own field. */
const OBSOLESCENCE_PEEK_ANCHOR = 'obsolescence-field-peek';

// The bot/person glyph for the Executor rail row (mirrors the detail rail's
// ExecutorIndicator, condensed) — a faint value glyph, not a coloured chip.
const EXECUTOR_GLYPH: Record<ExecutorDto, typeof Bot> = { coding_agent: Bot, human: User };

// The presentational quick-view PANEL (Subtask 2.5.19) — the modal body the
// IssueQuickView frame wraps, per design/work-items/quick-view.mock.html. Pure
// view: it takes already-shaped, serializable data (the QuickViewData the
// /api/work-items/peek route returns and IssueQuickViewController fetches) and
// renders one of three states — `loading` (the skeleton shown while the item
// fetches, panel 3), `notfound` (a stale / cross-workspace / deleted key, panel
// 4), or `ready` (the populated peek, panel 2). A large two-column body:
// scrollable main (title + FULL description) + a condensed core-fields rail.
// Read-only — editing lives on the full page.
//
// Composes ONLY shipped primitives — Modal (the frame), IssueTypeIcon (type
// hue), Pill via StatusValue / PriorityValue, the row Avatar, MarkdownView — so
// no new visual primitive is invented (AC). Colour via --el-* only; shape via
// the element-semantic tokens.

// Re-exported for existing consumers (the component test) that import the peek
// payload type from the panel; the canonical definition lives in the DTO.
export type { QuickViewData };

// `onClose` (MOTIR-1352) is the OPTIONAL non-URL close — supplied by the
// roadmap-canvas quick-view, which drives the peek from local state. Omitted on
// /items · /ready · /boards, where the close clears `?peek` via the shipped
// URL-driven default (see QuickViewCloseButton).
type IssueQuickViewPanelProps = {
  onClose?: () => void;
  /**
   * Fired ONCE, the first time a rail edit is confirmed (MOTIR-2563). The driver
   * uses it to decide whether the surface behind the modal needs re-reading when
   * the peek closes — the design's panel-12 decision: re-read on CLOSE, not per
   * edit (that shape caused `bug-inline-status-revert-on-second-edit`), and not
   * at all when nothing changed.
   */
  onEdited?: () => void;
} & (
  | { state: 'loading'; peekKey: string }
  | { state: 'notfound'; peekKey: string }
  | {
      state: 'ready';
      data: QuickViewData;
      /**
       * PROPOSAL MODE (MOTIR-4184, design Part XIV) — present when this peek is
       * reading a PLAN's proposal rather than a committed work item.
       *
       * ⚠️ An OPTIONAL prop on the existing `ready` variant, not a new state and
       * not a second component. The six committed hosts — `/items`, `/ready`,
       * `/boards`, the item page, its edit page and the roadmap canvas — pass
       * nothing and are unchanged by its existence, which is criterion 6 and the
       * whole reason `ProposalQuickView` can be deleted at all.
       */
      proposal?: PlanProposalPeekDto;
      /**
       * The PLAN's decision, when this peek is reading a proposal — `'accepted'`
       * / `'declined'` / `null` (Part XIV §16.1, MOTIR-4472).
       *
       * ⚠️ AN OUTCOME, NEVER A `decided` BOOLEAN, and §16.1 is explicit about
       * why: `op` and `outcome` are INDEPENDENT, so there are six renderings and
       * not four, and a two-valued prop has to pick one decided arm as the
       * default for both. The list picked the approve arm and was wrong on every
       * declined plan (MOTIR-4495).
       *
       * Absent (or `null`) is the `planned` arm — every string on this surface
       * as it shipped. Ignored entirely when `proposal` is absent: the six
       * committed hosts pass neither.
       */
      proposalOutcome?: PlanItemOutcome | null;
      /**
       * Opens the peek of ANOTHER proposal of the same plan — what a proposed
       * supersedes chip on the rail does (Story MOTIR-6577 · MOTIR-6632, design
       * Part XXIV §24.7). Supplied by the plan-review hosts; ignored without
       * `proposal`.
       */
      onOpenProposal?: (planItemId: string) => void;
      /**
       * THE TYPEWRITER (Story MOTIR-8590 · MOTIR-8595, design Part XXVIII §28.6) —
       * the fields that were UNWRITTEN when this quick view opened, on the
       * overlay while the plan is written. Each one that then arrives types itself
       * in, in reading order. Decided by the host (`ProposalPeek`), which holds the
       * review item; this panel only renders what it is told to type. Ignored
       * without `proposal`, so no committed host can ever type.
       */
      typeIn?: ReadonlySet<TypedField> | null;
    }
);

/**
 * The op chip — the shipped `Pill` the list row and the canvas node already
 * speak (`PlanProposalList.tsx`), so no fourth vocabulary for the same three
 * facts and no new copy key (Part XIV §4).
 *
 * `notYetCreated` rather than `opAdd` on the `add` arm: it is the stronger
 * statement and it is the copy that head already shipped.
 */
function ProposalOpChip({
  op,
  outcome,
}: {
  op: PlanProposalPeekDto['op'];
  outcome: PlanItemOutcome | null;
}) {
  const t = useTranslations('planReview');
  const label = op === 'add' ? t('notYetCreated') : op === 'remove' ? t('opRemove') : t('opModify');
  const pill =
    op === 'add' ? (
      <Pill severity="info" data-testid="quick-view-op">
        {label}
      </Pill>
    ) : op === 'remove' ? (
      <Pill tone="archived" data-testid="quick-view-op">
        {label}
      </Pill>
    ) : (
      <Pill status="planned" data-testid="quick-view-op">
        {label}
      </Pill>
    );
  if (!outcome) return pill;
  // ── DECIDED: the chip gains a SECOND SEGMENT (Part XIV §16.3) ─────────────
  // The word is not CHANGED, it is FUSED — exactly the construction
  // `PlanItemNode`'s `OpBadge` already draws (`:192-250`), which is the node the
  // canvas's `View` pill sits on. Segment 1 is the shipped `Pill` byte for byte;
  // segment 2 takes Part VI §3's own two pairs, seamed with a 1px rule rather
  // than a gap.
  //
  // ⚠️ NOT the LIST's `applied` / `archived` word, and §16.3 says why: Part VI's
  // `accepted` / `declined` is what happened to the PROPOSAL, Part VIII's
  // `created` / `applied` / `archived` is what happened to the WORK ITEM — and
  // this slot is where the proposal's own state lives, with the work item's own
  // state already rendering beside it as the `StatusValue` and the `Archived`
  // pill. Saying `archived` here would be the surface saying one thing twice and
  // the other thing not at all.
  //
  // NO NEW COPY KEY: `outcomeAccepted` / `outcomeDeclined` were authored by
  // Part VI for this exact word.
  return (
    <span
      className="inline-flex shrink-0 items-stretch overflow-hidden rounded-(--radius-badge)"
      data-testid="quick-view-op-chip"
    >
      {pill}
      <span
        data-testid="quick-view-outcome"
        className={cn(
          'inline-flex items-center gap-1 border-s border-(--el-border-soft) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium',
          outcome === 'accepted'
            ? 'bg-(--el-tint-mint) text-(--el-text-strong)'
            : 'bg-(--el-muted) text-(--el-text-secondary)',
        )}
      >
        {t(outcome === 'accepted' ? 'outcomeAccepted' : 'outcomeDeclined')}
      </span>
    </span>
  );
}

/**
 * "Open the work item as it stands →" — the link out in PROPOSAL MODE.
 *
 * ⚠️ THE LABEL CARRIES THE TENSE, and that is the whole difference from
 * `OpenFullPageLink` (Part XIV §7). The destination shows the work item as it
 * IS: `app/(authed)/items/[key]/page.tsx` has no pending-plan affordance, so a
 * reviewer reading *"PRIORITY · changed · Highest"* here lands on a page saying
 * *"High"*, and on a rename the two tabs carry two different names for one work
 * item. `target="_blank"` keeps this peek open behind it. The page LEARNING
 * about the plan is MOTIR-4197; the honest label is what this card owes.
 */
function OpenTargetLink({ identifier }: { identifier: string }) {
  const routes = useReaderRoutes();
  const t = useTranslations('planReview');
  return (
    <Link
      href={routes.item(identifier)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="quick-view-open-full"
      className="inline-flex h-(--height-btn-sm) shrink-0 items-center justify-center gap-1.5 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-control-x-12) font-sans text-xs font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {t('openTargetAsItStands')}
      <ArrowRight className="h-[15px] w-[15px]" aria-hidden />
    </Link>
  );
}

/** "Open full page →" — a Next Link styled as the primary Button (size sm). */
function OpenFullPageLink({ identifier }: { identifier: string }) {
  const routes = useReaderRoutes();
  const t = useTranslations('issueViews');
  return (
    <Link
      href={routes.item(identifier)}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="quick-view-open-full"
      className="inline-flex h-(--height-btn-sm) shrink-0 items-center justify-center gap-1.5 rounded-(--radius-btn) bg-(--el-accent) px-(--spacing-control-x-12) font-sans text-xs font-medium text-(--el-accent-text) transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {t('openFullPage')}
      <ArrowRight className="h-[15px] w-[15px]" aria-hidden />
    </Link>
  );
}

/**
 * One custom-field rail row (MOTIR-2599). Its own chevron, because a custom
 * field's editor is per-TYPE and lives in the shared hook — this is the peek's
 * chrome around it, the way `FieldCard` is the detail page's. Read mode uses the
 * peek's condensed value grammar, which is deliberately denser than the card's.
 */
function CustomRailRow({
  field,
  edit,
  render,
}: {
  field: CustomFieldWithValueDto;
  edit: ReturnType<typeof useCustomFieldEditing>;
  render: (f: CustomFieldWithValueDto) => ReactNode;
}) {
  const t = useTranslations('issueViews');
  const { can } = useProjectAccess();
  const canEdit = can('work_item:edit');
  const editing = edit.editingId === field.id;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
        {field.label}
        {canEdit ? (
          <button
            type="button"
            onClick={() => edit.onToggle(field, editing)}
            aria-label={
              editing
                ? t('quickViewCloseField', { field: field.label })
                : t('quickViewEditField', { field: field.label })
            }
            aria-expanded={editing}
            className="ml-auto inline-flex rounded-(--radius-control) p-(--spacing-control-x-2) text-(--el-text-faint) transition-colors hover:text-(--el-text-secondary) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${editing ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>
        ) : null}
      </dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-sm text-(--el-text-secondary)">
        {editing ? edit.renderEditor(field) : render(field)}
      </dd>
    </div>
  );
}

/** A pulsing skeleton bar (the loading state's placeholders). */
function Sk({ className }: { className?: string }) {
  return (
    <span
      className={`block animate-pulse rounded-(--radius-control) bg-(--el-muted) ${className ?? ''}`}
    />
  );
}

export function IssueQuickViewPanel(props: IssueQuickViewPanelProps) {
  const routes = useReaderRoutes();
  const t = useTranslations('issueViews');
  const tl = useTranslations('labels');
  const tob = useTranslations('workItems.obsolescence');
  const locale = useLocale() as Locale;
  // The expanded rail's empty custom fields hide behind a read-only "Show more
  // fields (N)" disclosure (8.8.8, mirroring the detail rail 5.3.7).
  const [showAllCustom, setShowAllCustom] = useState(false);
  // Called above the early returns — hooks cannot be conditional, so the rail's
  // edit state takes a nullable payload and is inert until the peek is `ready`.
  // PROPOSAL MODE — resolved before the early returns so the hook order is
  // stable across states (the loading / notfound arms carry no proposal).
  const tPlan = useTranslations('planReview');
  const format = useFormatter();
  // The shipped to-do section's own copy — the title and the count are the SAME
  // strings the created card will show, which is the point of composing that
  // section rather than writing a preview of it (MOTIR-4622).
  const tTodos = useTranslations('workItemTodos');
  const proposal = props.state === 'ready' ? (props.proposal ?? null) : null;
  // The PLAN's decision — resolved beside the proposal for the same reason (hook
  // order), and `null` on every committed host (Part XIV §16.1, MOTIR-4472).
  const proposalOutcome: PlanItemOutcome | null =
    props.state === 'ready' ? (props.proposalOutcome ?? null) : null;
  // A PROPOSED body's `[label](motir-ref:planItem:<id>)` links name SIBLING
  // proposals of the same plan (bug MOTIR-9355): drawn as the rail's proposal
  // chip and, where the host can open another proposal, a button that does. A
  // committed card's body has no such links, so its hosts get no renderer.
  const onOpenProposal = props.state === 'ready' ? props.onOpenProposal : undefined;
  const proposalRefs = proposal
    ? {
        renderProposalRef: (planItemId: string, label: ReactNode) => (
          <ProposalRef
            planItemId={planItemId}
            label={label}
            {...(onOpenProposal ? { onSelect: onOpenProposal } : {})}
          />
        ),
      }
    : {};
  const tFolders = useTranslations('folders');
  const folderCommands = useFolderCommands();
  const edit = useQuickViewRailEdit(
    props.state === 'ready' ? props.data : null,
    props.onEdited,
    // Suppress the editors rather than gate them: a proposal is changed by
    // RE-PLANNING (MOTIR-3084), so a permitted actor must see no affordance.
    proposal != null,
  );
  // MOTIR-2566 — the SAME hooks the detail rail's Labels / Components cards use.
  // Called above the early returns (hooks cannot be conditional) and inert until
  // the peek is `ready`. `active` is this surface's own open/closed state, which
  // is why the hook takes it rather than owning it.
  const ready = props.state === 'ready' ? props.data : null;
  // The moves an approval HOLDS (MOTIR-5528) — above the early returns for the
  // same hook-order reason; empty until the peek is `ready`.
  const statusHeld = useStatusHeld(
    ready?.heldTransitions,
    ready?.workflow.statuses ?? [],
    edit.effective?.status ?? ready?.status,
    // …and the undecided PLAN holding it at Planning (MOTIR-6267).
    ready?.planHold,
    // …and the MARK, as the rail shows it now (MOTIR-6676) — a clear in the
    // Obsolescence row lifts the hold with no re-read.
    edit.effective ? edit.effective.obsolescence : ready?.obsolescence,
  );
  // THE TYPEWRITER'S RUN for this open (MOTIR-8595) — above the early returns for
  // hook order. The panel is keyed per proposal, so the run is per open. Folded in
  // render: an armed field that arrives queues, a changed one shows final, and
  // reduced motion or a finished plan (`typeIn` gone) shows everything at once.
  const typeInArmed = props.state === 'ready' && props.proposal ? (props.typeIn ?? null) : null;
  const reducedMotion = usePrefersReducedMotion();
  const [typeRun, setTypeRun] = useState(() => startTypeIn(typeInArmed));
  const typeRunNow = foldTypeIn(
    typeRun,
    ready
      ? {
          title: ready.title,
          descriptionMd: ready.descriptionMd,
          explanationMd: ready.explanationMd,
        }
      : {},
    typeInArmed !== null && !reducedMotion,
  );
  if (typeRunNow !== typeRun) setTypeRun(typeRunNow);
  const finishTyping = useCallback(
    (field: TypedField) => setTypeRun((run) => finishTypeIn(run, field)),
    [],
  );
  const typed = (field: TypedField, node: ReactNode, placeholder: ReactNode = null) =>
    typeInArmed?.has(field) ? (
      <TypeInText
        phase={typeInPhase(typeRunNow, field)}
        placeholder={placeholder}
        onDone={() => finishTyping(field)}
        testId={`quick-view-typein-${field}`}
      >
        {node}
      </TypeInText>
    ) : (
      node
    );
  const labelEdit = useLabelEditing({
    workItemId: ready?.id ?? '',
    projectKey: ready?.projectIdentifier ?? '',
    initialLabels: ready?.labels ?? [],
    active: edit.editing === 'labels',
  });
  // MOTIR-2599 — the SAME per-type editors and commit paths the detail rail
  // runs, via the shared hook. This surface keeps its own condensed value
  // grammar (`renderCustomValue`), which is deliberately denser than the
  // detail card's.
  const customEdit = useCustomFieldEditing({
    workItemId: ready?.id ?? '',
    fields: ready?.customFields ?? [],
    members: ready?.members ?? [],
  });
  const componentEdit = useComponentEditing({
    workItemId: ready?.id ?? '',
    initialComponents: ready?.components ?? [],
    projectComponents: ready?.projectComponents ?? [],
    toOption: (c: { id: string; name: string }) => ({
      id: c.id,
      label: c.name,
      glyph: ComponentIcon,
    }),
  });
  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }),
    [locale],
  );
  // MOTIR-4196 — `--el-text-secondary`, not `--el-text-muted`. This value is
  // rendered by `CustomRailRow` INSIDE `QuickViewRail`, which paints
  // `bg-(--el-surface-soft)` from another module: muted ink measures 4.34:1
  // there (AA needs 4.50) and 4.54:1 on the white page/card, so the ink was
  // legal on the surface this panel does NOT render on. Secondary is 6.18-6.80:1
  // on all four surfaces in both themes. `tests/theme/inkContrastLint.test.ts`'s
  // muted arm ABSTAINS on exactly this shape — the tint is painted elsewhere —
  // so `tests/components/quick-view-rail-ink.test.tsx` is what holds it.
  const noneValue = <span className="text-(--el-text-secondary)">{t('none')}</span>;

  // Read-only custom-field value (8.8.8) — the detail rail's per-type value
  // grammar (CustomFieldsSection.renderValue, 5.3.7), condensed and WITHOUT any
  // editor (the peek has one write path: Open full page). `user`/`option`/`date`
  // arrive resolved from the server, so this never re-derives a label from an id.
  const renderCustomValue = (field: CustomFieldWithValueDto): ReactNode => {
    const v = field.value;
    if (!v) return noneValue;
    switch (field.fieldType) {
      case 'text':
        return (
          <span className="truncate" title={v.text ?? undefined}>
            {v.text}
          </span>
        );
      case 'number':
        return v.number != null ? numberFormat.format(v.number) : noneValue;
      case 'date':
        return v.date ? (
          <>
            <Calendar className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
            <span className="truncate">{formatDate(v.date, locale)}</span>
          </>
        ) : (
          noneValue
        );
      case 'select':
        return v.option ? (
          <span className="truncate">
            {v.option.label}
            {v.option.archived ? (
              <span className="text-(--el-text-secondary) italic">
                {' '}
                {t('customFields.archivedMark')}
              </span>
            ) : null}
          </span>
        ) : (
          noneValue
        );
      case 'user':
        return v.user ? (
          <>
            <Avatar name={v.user.name} />
            <span className="truncate">{v.user.name}</span>
          </>
        ) : (
          noneValue
        );
    }
  };

  // ── NOT FOUND / NO ACCESS (panel 4) ──────────────────────────────────────
  if (props.state === 'notfound') {
    return (
      <>
        <QuickViewHeader>
          <span className="flex-1" />
          <QuickViewCloseButton variant="icon" onClose={props.onClose} />
        </QuickViewHeader>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="mb-1.5 inline-flex h-14 w-14 items-center justify-center rounded-full bg-(--el-muted) text-(--el-text-secondary)">
            <SearchX className="h-7 w-7" aria-hidden />
          </span>
          <h2 className="font-serif text-lg font-semibold text-(--el-text)">
            {t('quickViewUnavailableTitle')}
          </h2>
          <p className="max-w-[24rem] text-sm leading-relaxed text-(--el-text-secondary)">
            {t('quickViewUnavailableDescription', { key: props.peekKey })}
          </p>
          <div className="mt-3">
            <QuickViewCloseButton variant="button" onClose={props.onClose} />
          </div>
        </div>
      </>
    );
  }

  // ── LOADING (panel 3) — fields fetch while the modal is already open ──────
  if (props.state === 'loading') {
    return (
      <>
        <QuickViewHeader>
          <Sk className="h-[18px] w-[18px] rounded-(--radius-control)" />
          <Sk className="h-3.5 w-16" />
          <Sk className="h-5 w-20 rounded-(--radius-badge)" />
          <span className="flex-1" />
          <OpenFullPageLink identifier={props.peekKey} />
          <QuickViewCloseButton variant="icon" onClose={props.onClose} />
        </QuickViewHeader>
        <QuickViewBody>
          <div className="min-w-0 overflow-y-auto px-7 pt-6 pb-7" role="status" aria-live="polite">
            <span className="sr-only">{t('quickViewLoadingAria')}</span>
            <Sk className="mb-6 h-7 w-2/3" />
            <Sk className="mb-3 h-2.5 w-24" />
            <Sk className="mb-2.5 h-3.5 w-full" />
            <Sk className="mb-2.5 h-3.5 w-[97%]" />
            <Sk className="mb-2.5 h-3.5 w-[92%]" />
            <Sk className="mb-6 h-3.5 w-3/5" />
            <Sk className="mb-2.5 h-3.5 w-full" />
            <Sk className="h-3.5 w-4/5" />
          </div>
          {/* The skeleton holds the EXPANDED rail's height (8.8.8) so the modal
              doesn't resize when the full field set lands. */}
          <dl className="flex min-w-0 flex-col gap-5 overflow-y-auto border-l border-(--el-border) bg-(--el-surface-soft) px-5 py-6">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Sk className="h-2.5 w-14" />
                <Sk className="h-5 w-28 rounded-(--radius-badge)" />
              </div>
            ))}
          </dl>
        </QuickViewBody>
      </>
    );
  }

  // ── READY (panel 2) — the populated peek ──────────────────────────────────
  const { data } = props;
  // The rail renders the OPTIMISTIC view for the rows this card edits; every
  // other row still reads `data` directly (untouched by MOTIR-2563).
  const view = edit.effective ?? data;
  // Custom fields split the detail-rail way (5.3.7): the VALUED ones render as
  // rows, the empty ones hide behind the read-only "Show more fields (N)".
  // Override-applied, so an optimistic commit moves a field from `empty` to
  // `valued` immediately rather than after a re-read.
  const valuedCustom = customEdit.valued;
  const emptyCustom = customEdit.empty;
  // Type/Executor are leaf-only (epic/story have no work type — mirror the
  // detail rail). Sprint is omitted for epics (they span sprints, Jira-faithful);
  // its empty label is status-aware (a done/cancelled item is excluded from the
  // backlog → "None", otherwise "Backlog"), matching CoreFieldsPanel.
  const showWorkType = isTypeableKind(data.kind);
  // Derived from the OPTIMISTIC view, so an executor/type change repaints its
  // glyph with the value the user just picked rather than the served one.
  const ViewTypeGlyph = view.type ? WORK_ITEM_TYPE_META[view.type].icon : null;
  const ViewExecutorGlyph = view.executor ? EXECUTOR_GLYPH[view.executor] : null;
  const sprintEmptyLabel = view.statusCategory === 'done' ? t('none') : t('backlog');
  // ── PROPOSAL MODE's two derived values (Part XIV §3) ─────────────────────
  // The marker for one rail row, and the line that reads the SILENCE of the
  // rest. Both are computed from the envelope the review model already carries
  // — nothing here re-derives which fields a plan touches.
  const changed = new Set<string>(proposal?.changedFields ?? []);
  const markFor = (field: string) =>
    changed.has(field) ? <ChangedMark label={tPlan('railChangedMark')} /> : undefined;
  const railChangeCount = proposal
    ? proposal.settableRailFields.filter((f) => changed.has(f)).length
    : 0;
  // What a `modify` moves that is NOT a settable rail row — its title, bodies,
  // dependencies — read from the same `changedFields` set, so the n = 0 line
  // names what the plan DOES change rather than a fixed pair (MOTIR-6119).
  const offRailChanged = proposal
    ? proposal.changedFields.filter((f) => !proposal.settableRailFields.includes(f))
    : [];
  const offRailFieldsText = format.list(
    offRailChanged.map((f) => tPlan(`field_${f}` as 'field_title').toLocaleLowerCase(locale)),
    { type: 'conjunction' },
  );
  // Naming the DENOMINATOR is what makes the silence readable: an unmarked row
  // means EITHER *the plan is not changing this* OR *no plan can change this*,
  // and a marker cannot separate those without a second marker on every row.
  //
  // ⚠️ AND THE TENSE IS THE PLAN'S OUTCOME (Part XIV §16.5, MOTIR-4472). This is
  // the only element on the surface that states what the plan DOES, so it is the
  // whole of the tense — a chip 500px above it is not read by somebody who has
  // scrolled the rail, which is why the declined arms NAME the decline in words
  // rather than leaving it to the chip.
  //
  // Three decisions inside the table, each of which could have gone the other
  // way: the COUNT survives on `declined` (a marker without its denominator
  // cannot be read — the ambiguity the line exists to remove, restored one state
  // over); `would have` rather than a bare past, because a declined `modify` did
  // not change two fields and did not change none of them, it proposed two and
  // was refused; and `remove` × approved reads *this plan archived {key}* rather
  // than *{key} is archived*, because the `Archived` pill and banner already say
  // the work item IS archived and only this line can say WHO did it.
  const proposalFootLine = !proposal
    ? null
    : proposal.op === 'add'
      ? proposalOutcome === 'declined'
        ? tPlan('railAddDeclined')
        : tPlan('railAddAll')
      : proposal.op === 'remove'
        ? proposalOutcome === 'accepted'
          ? tPlan('railRemoveArchived', { key: data.identifier })
          : proposalOutcome === 'declined'
            ? tPlan('railRemoveDeclined', { key: data.identifier })
            : tPlan('railRemoveArchives', { key: data.identifier })
        : railChangeCount === 0
          ? tPlan(
              `${offRailChanged.length === 0 ? 'railChangeNothing' : 'railChangeNone'}${
                proposalOutcome === 'accepted'
                  ? 'Applied'
                  : proposalOutcome === 'declined'
                    ? 'Declined'
                    : ''
              }` as 'railChangeNone',
              { fields: offRailFieldsText },
            )
          : tPlan(
              proposalOutcome === 'accepted'
                ? 'railChangeCountApplied'
                : proposalOutcome === 'declined'
                  ? 'railChangeCountDeclined'
                  : 'railChangeCount',
              {
                n: railChangeCount,
                m: proposal.settableRailFields.length,
              },
            );
  const peek = (
    // MOTIR-2593 — the peek provides its OWN estimation config, from the payload.
    // Only three pages mount `EstimationConfigProvider` and none of them wraps
    // this modal, so without this the composed `EstimateBadge` silently falls
    // back to a read-only default and is inert on every peek surface.
    <EstimationConfigProvider config={data.estimation} canEdit={data.estimation.canEdit}>
      <QuickViewHeader>
        <IssueTypeIcon type={data.kind} className="h-[18px] w-[18px] shrink-0" />
        {/* WHICH work item this is. An un-materialized `add` has no key until
            approve creates one, so it says so in the same mono slot with the
            word the node crumb and the list row already use — an empty slot in a
            column of keys reads as a missing value (Part XIV §4). */}
        {proposal && proposal.identifier == null ? (
          <span
            data-testid="quick-view-proposal-new"
            className="shrink-0 font-mono text-[13px] font-medium text-(--el-text-secondary)"
          >
            {tPlan('newItem')}
          </span>
        ) : (
          <Link
            href={routes.item(data.identifier)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[13px] font-medium text-(--el-link) hover:underline focus-visible:rounded-(--radius-control) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            {data.identifier}
          </Link>
        )}
        {/* THE OBSOLESCENCE BADGE (MOTIR-6674) right after the key — a pointer to
            the rail's field (panel 2). Nothing on an unmarked item or a proposal. */}
        {!proposal && view.obsolescence ? (
          <ObsolescenceHeaderLink mark={view.obsolescence} targetId={OBSOLESCENCE_PEEK_ANCHOR} />
        ) : null}
        {/* WHAT THE PLAN WILL DO, in the slot `/items` puts the status in — a
            status answers *what state is this work item in*, and on a review
            surface the question is *what will the plan do to it* (Part XIV §4).
            The op chip comes FIRST and the target's live status follows, so the
            header reads *what the plan does* → *where it is now*. An `add` has
            no status at all, so the two never crowd. */}
        {proposal ? <ProposalOpChip op={proposal.op} outcome={proposalOutcome ?? null} /> : null}
        {proposal && proposal.identifier == null ? null : (
          <StatusValue
            statusKey={data.status}
            category={data.statusCategory}
            label={data.statusLabel}
          />
        )}
        {/* THE TO FIX TAG (MOTIR-6610; design MOTIR-6608 panel 4) — the label,
            right after the status pill it qualifies. A proposal peek carries no
            reason, so it draws nothing there. */}
        <ToFixTag
          fixReason={data.fixReason}
          statusCategory={data.statusCategory}
          fixGate={data.fixGate}
          headKey={data.fixHeadKey ?? null}
        />
        {/* MOTIR-2050: the "Archived" chip, mirroring the detail page's eyebrow
          chip (2.9.6) — the archived state stays legible after the main column
          (which scrolls independently) is scrolled past the notice below. Neutral
          register, NOT a coloured Pill tone: archived is calm and factual. */}
        {data.archived ? (
          <Pill className="shrink-0 border-(--el-border) bg-(--el-surface) text-(--el-text-secondary)">
            <Archive className="size-3 text-(--el-text-muted)" aria-hidden />
            {t('archivedEntry')}
          </Pill>
        ) : null}
        <span className="flex-1" />
        {/* MOTIR-910: the same per-item Plan / Re-plan door the detail page
          carries, here between the status pill and "Open full page" (the
          plan-replan-entrance mockup's panels 3–4). Activating it hands off to
          the planning workspace — a route navigation, which dismisses this
          modal; a LOCAL-state host (the roadmap canvas peek, MOTIR-1352) also
          gets its own close called so its state doesn't outlive the handoff.
          The URL-driven peek passes no `onClose`, so its `?peek=` simply stays
          on the history entry the user came from. BOTH whether it renders and
          which face it wears are the entrance's own call (`planEntranceFace`,
          MOTIR-2084 + MOTIR-2097) — this surface just hands over the item state:
          the actor's capability, the archived flag (MOTIR-2050), the status
          CATEGORY, and the kind + children/description the face is picked from —
          all already in the payload. */}
        {/* The Plan / Re-plan entrance opens a planning conversation ON a work
            item. A proposal is already the output of one, and its target is
            being re-planned right now — two plans open on one work item is the
            state this suppresses (Part XIV §5). */}
        {proposal ? null : (
          <WorkItemPlanEntrance
            itemKey={data.identifier}
            hasChildren={data.hasChildren}
            kind={data.kind}
            hasDescription={(data.descriptionMd ?? '').trim().length > 0}
            canPlan={data.canPlan}
            archived={data.archived != null}
            statusCategory={data.statusCategory}
            // ⚠️ NO `onActivate` (MOTIR-4730). This used to be `props.onClose`,
            // handing off by dismissing the peek as the workspace opened. The
            // workspace is an OVERLAY now and the design settled this case: it
            // opens ABOVE the quick view and `?peek=` stays in the address, so
            // closing it returns the reader to the peek they launched from.
          />
        )}
        {/* ABSENT for an un-materialized `add` — there is no route, and a
            control that navigates nowhere is worse than no control. Present for
            a `modify` / `remove`, whose target HAS a page and is the only door
            to the delivery, comments and children this mode suppresses — and
            LABELLED for the tense, because that page shows the work item as it
            stands, not as the plan will leave it (Part XIV §7). */}
        {proposal && proposal.identifier == null ? null : proposal &&
          proposalOutcome !== 'accepted' ? (
          // ⚠️ THE OVERRIDE LIFTS ON `approved` AND STAYS ON `declined`
          // (Part XIV §16.4). `openTargetAsItStands` is a WARNING about a
          // divergence between this peek and the destination page, so it is
          // right exactly while the divergence exists. Approved: the plan HAS
          // been applied, the destination IS the projection, and §7's own
          // "only there" has stopped being here — keeping the label would
          // assert a disagreement that no longer exists. Declined: the
          // divergence is MAXIMAL, and that is the state the label was written
          // for. A REUSED key either way; the label retires on the state it was
          // drawn against and survives on the one nobody had drawn.
          <OpenTargetLink identifier={data.identifier} />
        ) : (
          <OpenFullPageLink identifier={data.identifier} />
        )}
        <QuickViewCloseButton variant="icon" onClose={props.onClose} />
      </QuickViewHeader>

      {/* A `remove`'s REASON, directly under the header row (MOTIR-6055 · Part
          XIX §19.5): it belongs to the op the header names, and a reader deciding
          a removal needs the why before the what. Verbatim — the planner wrote it
          for the reviewer. No reason ⇒ no band, the header byte-identical. */}
      {proposal?.op === 'remove' && proposal.removeReason ? (
        <div
          data-testid="remove-reason"
          className="flex flex-none items-baseline gap-3 border-b border-(--el-border) bg-(--el-surface-soft) py-2.5 pr-4 pl-5"
        >
          <span className="shrink-0 text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
            {tPlan('removeReason')}
          </span>
          <p className="min-w-0 text-sm text-(--el-text)">{proposal.removeReason}</p>
        </div>
      ) : null}

      <QuickViewBody>
        {/* Main — title + the FULL description (scrollable). */}
        <QuickViewMain>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {typed(
                'title',
                <h2 className="font-serif text-[27px] leading-tight font-semibold text-(--el-text)">
                  <TranslatableTitle
                    title={data.title}
                    projectIdentifier={data.projectIdentifier}
                    workItemRefs={data.workItemRefs}
                  />
                </h2>,
              )}
              <FieldTranslationMark fieldRef={fieldRef.title()} field="title" />
            </div>
            <TranslateControl />
          </div>
          {/* MOTIR-2050: the archived notice — the SAME banner the detail page
              renders (the shared ArchivedNotice), first in the main column under
              the title, where the detail page puts it relative to its own header.
              The peek is READ-ONLY, so it carries no Restore: the notice states
              the fact and "Open full page →" is the existing door to the action
              (which needs a server refresh the client-fetched peek has no path
              for). Hence no restore tail either — the peek never promises an
              action it doesn't offer. */}
          {data.archived ? (
            <ArchivedNotice
              archivedByName={data.archived.byName}
              archivedAtLabel={data.archived.atLabel}
              testId="quick-view-archived-banner"
              className="mt-4"
            />
          ) : null}
          {/* Readiness banner (2.5.21) — the shipped ReadinessBadge, top of the
              main column under the title, per quick-view.mock.html (2.5.20). Shown
              only for a TODO-category item that has blockers: no banner without
              blockers, and none once the item is in-progress / done ("can I start
              this?" is moot past todo) — and none on an ARCHIVED item, which is not
              startable work at all (MOTIR-2050; the shared `showsReadiness` gate the
              detail page's RelationshipsPanel uses). Each named blocker opens its DETAIL page in
              a NEW TAB (8.8.32 — overrides the 2.5.20 peek-swap), matching the
              new-tab treatment the other quick-view detail links got in 8.8.31. */}
          {/* Readiness answers *can I start this?*, which is moot for something
              nobody has approved. A proposal's dependency story is the canvas's
              arrows (Part IX), not this banner (Part XIV §5). */}
          {!proposal &&
          data.readiness &&
          showsReadiness({
            statusCategory: data.statusCategory,
            archived: data.archived != null,
          }) ? (
            <ReadinessBadge
              ready={data.readiness.ready}
              blockers={data.readiness.blockers.map((identifier) => ({
                identifier,
                href: routes.item(identifier),
              }))}
              blockedByAncestor={
                data.readiness.blockedByAncestor
                  ? {
                      id: data.readiness.blockedByAncestor.id,
                      identifier: data.readiness.blockedByAncestor.identifier,
                      title: data.readiness.blockedByAncestor.title,
                      href: routes.item(data.readiness.blockedByAncestor.identifier),
                    }
                  : null
              }
              blockerLinksNewTab
              className="mt-4"
            />
          ) : null}
          <span className="mt-6 mb-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
            {t('description')}
            <span className="font-normal tracking-normal normal-case">
              <FieldTranslationMark fieldRef={fieldRef.description()} field="description" />
            </span>
          </span>
          {typed(
            'descriptionMd',
            data.descriptionMd ? (
              <TranslatableMarkdown
                fieldRef={fieldRef.description()}
                value={data.descriptionMd}
                aria-label={t('issueDescriptionAria')}
                workItemRefs={data.workItemRefs}
                pageRefs={data.pageRefs}
                {...proposalRefs}
              />
            ) : (
              <p className="text-sm text-(--el-text-secondary) italic">{t('noDescription')}</p>
            ),
            <p className="text-sm text-(--el-text-secondary) italic">{t('noDescription')}</p>,
          )}
          {/* THE EXPLANATION, INLINE (Part XIV §6). The shipped peek defers it
              to the full page; a proposal has no page, and deferring to a thing
              that does not exist is precisely how `explanationMd` came to be
              carried, diffed and materialized while nothing displayed it
              (MOTIR-4134). It scrolls with the description in the main column's
              own scroller — no clamp, because a clamp needs a destination for
              the rest and an `add` has none. */}
          {proposal ? (
            <>
              <span className="mt-6 mb-2 block text-[11px] font-semibold tracking-wide text-(--el-text-secondary) uppercase">
                {tPlan('sectionExplanation')}
              </span>
              {typed(
                'explanationMd',
                data.explanationMd ? (
                  <MarkdownView
                    value={data.explanationMd}
                    aria-label={t('issueExplanationAria')}
                    workItemRefs={data.workItemRefs}
                    pageRefs={data.pageRefs}
                    {...proposalRefs}
                  />
                ) : (
                  <p className="text-sm text-(--el-text-secondary) italic">
                    {tPlan('noExplanation')}
                  </p>
                ),
                <p className="text-sm text-(--el-text-secondary) italic">
                  {tPlan('noExplanation')}
                </p>,
              )}
            </>
          ) : null}
          {/* THE PROPOSED STEPS (Story MOTIR-3810 · MOTIR-4622) — the read-only
              To-do list, built to `design/ai-planning/design-notes.md` Part XV.
              LAST in the main column, after the explanation, because the peek
              defers children and comments to a page a proposal does not have
              (Part XIV §2): there is nothing below it, and the reader reaches it
              by scrolling the body they were already reading.

              ⚠️ `null` / `[]` RENDERS NOTHING, and that is the decision rather
              than a fallback (Part XV §15.3). An empty `To-do list · 0 of 0`
              would assert that a planner considered this card's steps and
              proposed none — a claim the data cannot support, since the same
              proposal is produced by a planner that never reached the question.
              A row's absence is a statement about the SUBJECT (Part XIV §1).

              The section does NOT get its own scroller at any length: it grows,
              and `QuickViewMain`'s existing `overflow-y-auto` is the one scroll
              surface (Part XV §15.2). A second scroller inside the first gives
              the reader two things to move and no way to tell which one they
              are in. */}
          {proposal?.todos && proposal.todos.length > 0 ? (
            <section className="mt-6" data-testid="proposal-todos">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="text-[13px] font-semibold text-(--el-text)">
                    {tTodos('sectionTitle')}
                  </h3>
                  <span className="text-[11.5px] text-(--el-text-secondary)">
                    {tPlan('proposedTodosSubtitle')}
                  </span>
                </div>
                <span
                  data-testid="proposal-todos-progress"
                  className="font-mono text-[11px] text-(--el-text-secondary)"
                >
                  {tTodos('progress', { done: 0, total: proposal.todos.length })}
                </span>
              </div>
              <ul data-testid="proposal-todos-list" className="list-none">
                {proposal.todos.map((row, index) => (
                  // No id on a proposed row — it has none until approve mints
                  // one — so the index IS the identity here, and it is a stable
                  // one: this list is read-only and never reorders.
                  <TodoRowReadOnly key={index} row={row} workItemRefs={data.workItemRefs} />
                ))}
              </ul>
            </section>
          ) : null}
          {/* Development — linked PRs + PR/CI state (Story 7.10 · MOTIR-1579,
              design/github Panels 3 + 4a). Display-only here (the peek's one
              write path stays "Open full page"); the explicit-link affordance
              lives on the detail page (MOTIR-1596, design Panel 5). */}
          {proposal ? null : (
            <DevelopmentSection
              className="mt-6"
              pullRequests={data.pullRequests}
              itemIdentifier={data.identifier}
              // The DELIVERY SET (MOTIR-3660) — the same list the detail page
              // draws from, so the `Not on trunk` pill and any row the singular
              // column could not name appear on both surfaces or on neither.
              deliveries={data.deliveries ?? []}
              // MOTIR-2415 added this row behind a prop and left the peek's
              // default empty so its output could not move by accident. This is
              // the card that turns it on — by DECISION, and the design (2414 Q2)
              // keeps the same treatment here rather than a reduced second one.
              // The set goes over VERBATIM: the peek filtering its own copy is
              // what made it say "No pull request yet" about a repository whose
              // pull request was on the row above (MOTIR-3036).
              repoDelivery={data.repoDelivery ?? []}
              // The persisted merge outcomes (Bug MOTIR-5650): a queued pull request reads
              // *Queued to merge* here as it does on the item page, not *Checks passing*.
              mergeMembers={data.mergeMembers ?? []}
              // The design result's SLOT (Q8): a card whose open pull requests
              // carry its design shows it here, first in the block, exactly as
              // the detail page does. The service reads it only in that case.
              designResult={
                data.designEvidence &&
                hasOpenPullRequest(data.pullRequests, data.deliveries ?? []) ? (
                  <DesignResultPanel
                    evidence={data.designEvidence}
                    isDesignCard={data.type === 'design'}
                    placement="development"
                  />
                ) : undefined
              }
            />
          )}
          {/* The shipped line — *"Explanation, relationships, attachments and
              the activity feed live on the full page"* — is wrong TWICE in
              proposal mode: the explanation is right here, and an `add` has no
              full page. It is REPLACED, not kept (Part XIV §6). */}
          {proposal ? (
            <p
              data-testid="quick-view-proposal-more"
              className="mt-6 flex items-center gap-1.5 border-t border-(--el-border-soft) pt-4 text-[13px] text-(--el-text-secondary)"
            >
              {tPlan('peekNoActivity')}
            </p>
          ) : (
            <p className="mt-6 flex items-center gap-1.5 border-t border-(--el-border-soft) pt-4 text-[13px] text-(--el-text-muted)">
              {t.rich('quickViewMore', {
                link: (chunks) => (
                  <Link
                    href={routes.item(data.identifier)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-(--el-link) hover:underline"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
        </QuickViewMain>

        {/* Rail — the detail page's FULL core-field set (8.8.8), condensed and
            read-only, in detail.png order. The rail scrolls independently inside
            the fixed-height modal; built-in fields always render (muted "None"
            when empty), custom fields split valued / "Show more". */}
        <QuickViewRail
          foot={proposal ? <ProposalRailFoot>{proposalFootLine}</ProposalRailFoot> : undefined}
        >
          {/* Not a field error — the whole payload is behind, so the notice sits
              ABOVE rows that may all have moved (design panel 9). */}
          {edit.stale ? <RailStaleNotice /> : null}
          {/* Status has its OWN action — it stopped being a patch field when
              finding #46 closed, so it goes through the gated `changeStatusAction`
              and the picker offers only the LEGAL targets under the project's
              policyMode. */}
          <EditableRailField
            label={t('status')}
            fieldKey="status"
            edit={edit}
            control={
              <StatusPicker
                statuses={view.workflow.statuses}
                transitions={view.workflow.transitions}
                policyMode={view.workflow.policyMode}
                value={view.status}
                autoOpen
                onClose={edit.close}
                onChange={(toStatusKey) => {
                  const next = view.workflow.statuses.find((st) => st.key === toStatusKey);
                  void edit.commitVia(
                    'status',
                    {
                      status: toStatusKey,
                      statusLabel: next?.label ?? toStatusKey,
                      statusCategory: next?.category ?? view.statusCategory,
                    },
                    async () => {
                      const res = await changeStatusAction({ id: view.id, toStatusKey });
                      if (res.ok) statusHeld.onMoved(toStatusKey);
                      else if (res.code === 'APPROVAL_GATE_PENDING' && res.gate) {
                        statusHeld.onRefused(toStatusKey, res.gate);
                      } else if (res.code === 'PLAN_TARGET_HELD' && res.plan) {
                        // The rail reverts the optimistic value; the plan's line
                        // says why, with its Review plan door (MOTIR-6267).
                        statusHeld.onPlanHeldRefused(res.plan);
                      } else if (res.code === 'MARKED_CARD_CANNOT_REOPEN' && res.mark) {
                        // Marked after render (MOTIR-6676): the mark's line says why.
                        statusHeld.onMarkRefused(res.mark);
                      }
                      return res;
                    },
                  );
                }}
                held={statusHeld.held}
              />
            }
          >
            <StatusValue
              statusKey={view.status}
              category={view.statusCategory}
              label={view.statusLabel}
            />
          </EditableRailField>
          {/* The held message under the status field (MOTIR-5528; design panel 13
              of quick-view.mock.html) — visible without opening the picker. */}
          {statusHeld.lines.length > 0 || statusHeld.plan || statusHeld.mark ? (
            <div className="px-(--spacing-control-x)">
              <StatusHeldNotice
                itemKey={view.identifier}
                lines={statusHeld.lines}
                plan={statusHeld.plan}
                mark={statusHeld.mark}
                markFieldId={OBSOLESCENCE_PEEK_ANCHOR}
              />
            </div>
          ) : null}
          {/* The proposed MARK and its NOTE, directly under Status — the mark
              beside the finished status it holds (MOTIR-6632, Part XXIV §24.10).
              Only the rows this plan moves; none on a committed host. */}
          {proposal ? (
            <ProposalMarkRows
              proposal={proposal}
              statusCategory={view.statusCategory}
              statusLabel={view.statusLabel}
              outcome={proposalOutcome}
            />
          ) : null}

          {/* Repositories (Story MOTIR-2725 · MOTIR-2416) — SECOND in the rail,
              immediately after Status, per design/work-items/
              repository-set-quick-view.mock.html.

              ⚠️ This is a DELIBERATE divergence from the detail rail, which puts
              the field last. It is a MEASUREMENT, not a preference: the peek's
              rail is a bounded scroller (827px of content in a 621px viewport at
              1280×900), and measured last the row sat at y 642–751 in a 680px
              modal — below the fold, failing the card's own "visible without
              scrolling" criterion. Second, it sits at y 137–246. The set is also
              a COMPLETION fact — the reason a card is In Review rather than Done
              — which is what this surface is opened from a list to ask.

              READ-ONLY here, exactly as on the detail rail: the design chose an
              editable bounded picker for BOTH surfaces, and it ships once, as
              the shared control, rather than twice. */}
          <QuickViewRailField label={t('repositories')} marker={markFor('targetRepo')}>
            {/* `?? []` at the DESERIALIZATION boundary, not as blanket
                defensiveness: this payload arrives over HTTP from
                `/api/work-items/peek`, and a server that predates MOTIR-2416
                does not send the field. A client rendering against an older
                deploy — or a mid-deploy window — must show the empty set, which
                is a real state, rather than throw. */}
            <RepositorySetField
              delivery={view.repoDelivery ?? []}
              deliveries={view.deliveries ?? []}
              compact
            />
          </QuickViewRailField>

          {/* Work Type + Executor — leaf-only (Story 2.7). The faint value glyph
              follows the Estimate/Due grammar (NOT the coloured type chip — the
              dense rail stays quiet, per the 8.8.4 design). The kind is already
              in the header (IssueTypeIcon), so the rail adds only the work type. */}
          {showWorkType ? (
            <>
              <EditableRailField
                label={t('type')}
                fieldKey="workItemType"
                marker={markFor('type')}
                edit={edit}
                control={
                  <WorkItemTypePicker
                    value={view.type}
                    autoOpen
                    onClose={edit.close}
                    onChange={(type) => void edit.commit('workItemType', { type }, { type })}
                  />
                }
              >
                {view.type && ViewTypeGlyph ? (
                  <>
                    <ViewTypeGlyph
                      className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)"
                      aria-hidden
                    />
                    <span className="truncate">{tl(`workItemType.${view.type}`)}</span>
                  </>
                ) : (
                  <span className="text-(--el-text-secondary)">{t('none')}</span>
                )}
              </EditableRailField>
              <EditableRailField
                label={t('executor')}
                fieldKey="executor"
                edit={edit}
                control={
                  view.type == null ? undefined : (
                    <ExecutorPicker
                      value={view.executor ?? defaultExecutorForType(view.type)}
                      onChange={(executor) => {
                        edit.close();
                        void edit.commit('executor', { executor }, { executor });
                      }}
                    />
                  )
                }
              >
                {view.executor && ViewExecutorGlyph ? (
                  <>
                    <ViewExecutorGlyph
                      className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)"
                      aria-hidden
                    />
                    <span className="truncate">{tl(`executor.${view.executor}`)}</span>
                  </>
                ) : (
                  <span className="text-(--el-text-secondary)">{t('none')}</span>
                )}
              </EditableRailField>
              {/* Difficulty (Story MOTIR-6016 · MOTIR-6101) — below Executor in the
                  same leaf-only branch, per core-fields--difficulty.mock.html: a
                  label with a faint signal glyph, None when unset, and the same
                  Segmented + Clear editor the item page uses. Not gated on a type. */}
              <EditableRailField
                label={t('difficulty')}
                fieldKey="difficulty"
                marker={markFor('difficulty')}
                edit={edit}
                control={
                  <DifficultyPicker
                    value={view.difficulty}
                    onChange={(difficulty) => {
                      edit.close();
                      void edit.commit('difficulty', { difficulty }, { difficulty });
                    }}
                  />
                }
              >
                {view.difficulty ? (
                  <DifficultyIndicator difficulty={view.difficulty} />
                ) : (
                  <span className="text-(--el-text-secondary)">{t('none')}</span>
                )}
              </EditableRailField>
            </>
          ) : null}

          {/* Obsolescence (Story MOTIR-6575 · MOTIR-6674) — the item page's field in
              the 300px rail (core-fields--obsolescence.mock.html panel 1c), on EVERY
              kind, so outside the leaf-only branch. Both marks lock on a card outside
              the done category; a refusal lands on this row, never as a toast. */}
          <div id={OBSOLESCENCE_PEEK_ANCHOR} tabIndex={-1} className="focus:outline-none">
            <EditableRailField
              label={tob('label')}
              fieldKey="obsolescence"
              marker={markFor('obsolescence')}
              edit={edit}
              control={
                <ObsolescenceField
                  value={view.obsolescence}
                  noteMd={view.obsolescenceNoteMd}
                  workItemRefs={data.workItemRefs}
                  editing
                  locked={!canCarryObsolescence(view.statusCategory)}
                  pending={edit.pending === 'obsolescence'}
                  onMark={(obsolescence) =>
                    void edit.commit('obsolescence', { obsolescence }, { obsolescence })
                  }
                  onNote={(obsolescenceNoteMd) =>
                    void edit.commit('obsolescence', { obsolescenceNoteMd }, { obsolescenceNoteMd })
                  }
                  onCancelNote={edit.close}
                />
              }
            >
              <ObsolescenceField
                value={view.obsolescence}
                noteMd={view.obsolescenceNoteMd}
                workItemRefs={data.workItemRefs}
                editing={false}
                locked={false}
                onMark={() => undefined}
                onNote={() => undefined}
              />
            </EditableRailField>
          </div>

          <EditableRailField
            label={t('priority')}
            fieldKey="priority"
            marker={markFor('priority')}
            edit={edit}
            control={
              <PriorityPicker
                value={view.priority}
                autoOpen
                onClose={edit.close}
                onChange={(priority) => void edit.commit('priority', { priority }, { priority })}
              />
            }
          >
            <PriorityValue priority={view.priority} />
          </EditableRailField>
          <EditableRailField
            label={t('assignee')}
            fieldKey="assignee"
            edit={edit}
            control={
              <AssigneePicker
                members={view.members}
                value={view.assigneeId}
                autoOpen
                onClose={edit.close}
                onChange={(assigneeId) => {
                  const m = view.members.find((x) => x.userId === assigneeId);
                  void edit.commit(
                    'assignee',
                    { assigneeId, assigneeName: m ? personDisplayName(m) : null },
                    { assigneeId },
                  );
                }}
              />
            }
          >
            <AssigneeValue name={view.assigneeName} />
          </EditableRailField>
          <QuickViewRailField label={t('reporter')}>
            <Avatar name={data.reporterName} />
            <span className="truncate">{data.reporterName}</span>
          </QuickViewRailField>
          <EditableRailField
            label={t('parent')}
            fieldKey="parent"
            marker={markFor('parent')}
            edit={edit}
            control={
              <ParentPicker
                childType={view.kind as IssueType}
                value={view.parentId}
                onChange={(parentId, picked) => {
                  edit.close();
                  void edit.commit(
                    'parent',
                    {
                      parentId,
                      // The picker hands the chosen label over so the row shows it
                      // immediately, without a server re-read.
                      parent:
                        parentId && picked
                          ? { identifier: picked.identifier, title: picked.title, kind: 'story' }
                          : null,
                    },
                    { parentId },
                  );
                }}
              />
            }
          >
            {/* The OPTIMISTIC parent, not the served one: the picker hands the
                chosen item's identifier + title over with the id (above), and
                reading `data` here would compute that label and then throw it
                away — the row would keep showing the old parent until a re-read
                the peek never performs. */}
            {view.parent ? (
              <Link
                href={routes.item(view.parent.identifier)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 items-center gap-1.5 text-(--el-link) hover:underline"
              >
                <IssueTypeIcon type={view.parent.kind} className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0 font-mono text-xs">{view.parent.identifier}</span>
                <span className="truncate text-(--el-text-secondary)">
                  <SurfaceTitle id={view.parentId ?? ''} title={view.parent.title} />
                </span>
              </Link>
            ) : (
              <span className="text-(--el-text-secondary)">{t('none')}</span>
            )}
          </EditableRailField>

          {/* Folder (MOTIR-5316, folders design panel 6) — directly below Parent,
              because the two are one fact about placement: an item sits under a
              work item OR in a folder. Filing commits through the rail's own
              optimistic path and, on success, tells the tree behind the dialog
              where the row now sits. */}
          <EditableRailField
            label={tFolders('fieldLabel')}
            fieldKey="folder"
            edit={edit}
            control={
              <QuickViewFolderControl
                folderId={view.folderId}
                parent={view.parent && view.parentId ? { ...view.parent, id: view.parentId } : null}
                onDismiss={edit.close}
                onPick={(folderId, folderPath) => {
                  edit.close();
                  if (folderId === view.folderId) return;
                  const workItemId = view.id;
                  void edit.commitVia(
                    'folder',
                    { folderId, folderPath, parentId: null, parent: null },
                    async () => {
                      const res = await fileWorkItemAction({ workItemId, folderId });
                      if (res.ok) {
                        folderCommands?.reportWorkItemPlacement({
                          workItemId,
                          folderId,
                          parentId: null,
                        });
                      }
                      return res;
                    },
                  );
                }}
              />
            }
          >
            <span className="truncate text-(--el-text-secondary)">
              {view.folderPath.length > 0 ? view.folderPath.join(' ▸ ') : tFolders('noFolder')}
            </span>
          </EditableRailField>

          {/* Labels — coloured chips. Reuses the SHIPPED ValueChip + name-hash
              labelTint (5.4.8), NOT a fixed lavender: the labelTint decision
              (product owner, 2026-06-10) guarantees a label renders the SAME
              colour on every surface, so the peek and the detail rail match. */}
          {/* Labels + Components (MOTIR-2566) — the SAME behaviour the detail
              cards run, via the shared hooks, behind the rail's chip grammar.
              A collection row has no single commit moment, so it does not swap
              its value for one control: it stays a chip stack and the picker
              opens beneath it, staying open across several adds and removes. */}
          <EditableRailField
            label={t('labelsField')}
            fieldKey="labels"
            edit={edit}
            control={
              <MultiSelectPicker
                values={labelEdit.chips}
                options={labelEdit.options}
                onToggle={labelEdit.toggle}
                onRemove={labelEdit.remove}
                onCreate={labelEdit.create}
                query={labelEdit.query}
                onQueryChange={labelEdit.setQuery}
                cap={LABELS_PER_ISSUE_LIMIT}
                label={t('labelsField')}
                placeholder={t('labelsPlaceholder')}
                createLabel={(q) => t('labelsCreate', { name: q })}
                removeLabel={(label) => t('labelsRemove', { label })}
                hint={
                  labelEdit.atCap
                    ? t('labelsLimitReached', { limit: LABELS_PER_ISSUE_LIMIT })
                    : undefined
                }
                error={labelEdit.error}
                disabled={labelEdit.isPending}
              />
            }
          >
            {labelEdit.chips.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {labelEdit.chips.map((c) => (
                  <ValueChip key={c.id} option={c} />
                ))}
              </div>
            ) : (
              <span className="text-(--el-text-secondary)">{t('noLabels')}</span>
            )}
          </EditableRailField>

          {/* Components — neutral chips with the component glyph (5.4.8).
              The detail card's empty-taxonomy state offers a project admin a
              "Manage components" link to the settings hub. That link is NOT
              carried here: following it from a peek would navigate the page out
              from under the modal, discarding the user's place in the list —
              the exact loss the peek exists to prevent. An admin with no
              taxonomy yet sees the same "none defined" text and manages it from
              the detail page or settings. */}
          <EditableRailField
            label={t('componentsField')}
            fieldKey="components"
            edit={edit}
            control={
              <MultiSelectPicker
                values={componentEdit.chips}
                options={componentEdit.options}
                onToggle={componentEdit.toggle}
                onRemove={componentEdit.remove}
                query={componentEdit.query}
                onQueryChange={componentEdit.setQuery}
                label={t('componentsField')}
                placeholder={t('componentsPlaceholder')}
                removeLabel={(label) => t('componentsRemove', { label })}
                emptyText={t('componentsNoneDefined')}
                error={componentEdit.error}
                disabled={componentEdit.isPending}
              />
            }
          >
            {componentEdit.chips.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {componentEdit.chips.map((c) => (
                  <ValueChip key={c.id} option={c} />
                ))}
              </div>
            ) : (
              <span className="text-(--el-text-secondary)">{t('noComponents')}</span>
            )}
          </EditableRailField>

          {/* Due date + Estimate carry BOTH axes, so an optimistic write updates
              the raw value AND its display label together — the payload's
              display/raw pairing is what keeps the panel presentational, and
              leaving the label behind would show the OLD date under a new one. */}
          <EditableRailField
            label={t('dueDate')}
            fieldKey="dueDate"
            edit={edit}
            control={
              <DatePicker
                value={view.dueDate ? view.dueDate.slice(0, 10) : ''}
                onChange={(next) => {
                  const iso = next ? `${next}T00:00:00.000Z` : null;
                  void edit.commit(
                    'dueDate',
                    { dueDate: iso, dueLabel: iso ? formatDate(iso, locale) : null },
                    { dueDate: iso },
                  );
                }}
              />
            }
          >
            {view.dueLabel ? (
              <span className="truncate">{view.dueLabel}</span>
            ) : (
              <span className="text-(--el-text-secondary)">{t('noDueDate')}</span>
            )}
          </EditableRailField>

          {/* Sprint — omitted for epics (they span sprints). Goal glyph + name,
              or the status-aware empty label (Backlog / None). */}
          {data.kind !== 'epic' ? (
            <EditableRailField
              label={t('sprint')}
              fieldKey="sprint"
              edit={edit}
              control={
                <SprintPicker
                  sprints={view.sprints}
                  value={view.sprintId}
                  autoOpen
                  onClose={edit.close}
                  // The SAME value the read row uses, so "Backlog" and "None"
                  // can never disagree between the label and the sentinel.
                  emptyLabel={sprintEmptyLabel}
                  onChange={(sprintId) => {
                    const picked = view.sprints.find((x) => x.id === sprintId);
                    void edit.commitVia(
                      'sprint',
                      { sprintId, sprintName: picked?.name ?? null },
                      // Sprint has its own endpoint, not `updateIssueAction`.
                      // Shape its response into the shared result type.
                      async () => {
                        try {
                          const res = await setWorkItemSprint(view.id, sprintId);
                          return { ok: true as const, updatedAt: res.updatedAt };
                        } catch {
                          return { ok: false as const, error: t('sprintUpdateFailed') };
                        }
                      },
                    );
                  }}
                />
              }
            >
              {view.sprintName ? (
                <>
                  <Goal className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
                  <span className="truncate">{view.sprintName}</span>
                </>
              ) : (
                <span className="text-(--el-text-secondary)">{sprintEmptyLabel}</span>
              )}
            </EditableRailField>
          ) : null}

          {/* Story points — the agile estimate, distinct from the TIME estimate. */}
          {/* Story points (MOTIR-2565) — the shipped `EstimateBadge`, the same
              click-to-edit chip the backlog, the board, the item list and the
              detail rail all compose. The peek was the ONE issue surface that
              rendered a bare number instead.
              NO edit chevron on this row, deliberately: the badge IS the
              affordance, which is exactly why the detail rail's FieldCard is
              `editable={false}` here. A chevron beside it would be a second
              affordance for one field. Editing routes through the badge's own
              `PATCH /api/work-items/[id]/estimate` and the project's configured
              scale deck — never a free-text number, which could hold a value the
              scale does not contain.
              A read-only actor gets the permission-gated reason instead
              (MOTIR-6338, treatment-table row 6): the badge falls to its static
              chip, and without the disabled chevron the row would read as a
              field nobody edits rather than one this actor may not. */}
          <QuickViewRailField
            label={t('storyPoints')}
            marker={markFor('storyPoints')}
            readOnlyReason={edit.readOnlyReason}
          >
            <EstimateBadge
              itemId={view.id}
              storyPoints={view.storyPoints}
              estimateMinutes={view.estimateMinutes}
              forceStoryPoints
            />
          </QuickViewRailField>

          <EditableRailField
            label={t('estimate')}
            fieldKey="estimate"
            marker={markFor('estimateMinutes')}
            edit={edit}
            control={
              <Input
                type="number"
                min={0}
                autoFocus
                defaultValue={view.estimateMinutes ?? ''}
                onBlur={(e) => {
                  const raw = e.currentTarget.value.trim();
                  const minutes = raw === '' ? null : Number(raw);
                  if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) {
                    edit.close();
                    return;
                  }
                  if (minutes === view.estimateMinutes) {
                    edit.close();
                    return;
                  }
                  void edit.commit(
                    'estimate',
                    {
                      estimateMinutes: minutes,
                      estimateLabel: minutes != null ? formatDurationMinutes(minutes) : null,
                    },
                    { estimateMinutes: minutes },
                  );
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') edit.close();
                }}
              />
            }
          >
            {view.estimateLabel ? (
              <>
                <Clock className="h-3.5 w-3.5 shrink-0 text-(--el-text-faint)" aria-hidden />
                <span className="truncate">{view.estimateLabel}</span>
              </>
            ) : (
              <span className="text-(--el-text-secondary)">{t('noEstimate')}</span>
            )}
          </EditableRailField>

          {/* The SUPERSEDES rows, LAST (MOTIR-6632, Part XXIV §24.10): a
              `modify`'s signed deltas, an `add`'s unsigned refs. */}
          {proposal ? (
            <ProposalSupersedesRows
              proposal={proposal}
              {...(props.state === 'ready' && props.onOpenProposal
                ? { onOpenProposal: props.onOpenProposal }
                : {})}
            />
          ) : null}

          {/* Custom fields (5.3.7 · editable MOTIR-2599) — valued rows, then the
              empty ones behind a disclosure. That disclosure was built READ-ONLY
              in 8.8.8, purely to stop the rail being a wall of "None". Now the
              rail edits, it is the ONLY route to an empty field someone wants to
              fill, so its label says "N more fields" rather than promising only
              to SHOW them — a field you cannot reach is a field you cannot set. */}
          {data.customFields.length > 0 ? (
            <>
              <div className="-mx-1 my-1 h-px bg-(--el-border-soft)" />
              {valuedCustom.map((f) => (
                <CustomRailRow key={f.id} field={f} edit={customEdit} render={renderCustomValue} />
              ))}
              {emptyCustom.length > 0 ? (
                <>
                  <button
                    type="button"
                    aria-expanded={showAllCustom}
                    onClick={() => setShowAllCustom((s) => !s)}
                    className="flex items-center gap-1.5 self-start rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-4) font-sans text-xs font-medium text-(--el-text-secondary) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                  >
                    <ChevronRight
                      className={`h-3.5 w-3.5 shrink-0 text-(--el-text-faint) transition-transform ${showAllCustom ? 'rotate-90' : ''}`}
                      aria-hidden
                    />
                    {showAllCustom
                      ? t('customFields.showFewer')
                      : t('quickViewMoreFields', { count: emptyCustom.length })}
                  </button>
                  {showAllCustom
                    ? emptyCustom.map((f) => (
                        <CustomRailRow
                          key={f.id}
                          field={f}
                          edit={customEdit}
                          render={renderCustomValue}
                        />
                      ))
                    : null}
                </>
              ) : null}
            </>
          ) : null}

          {/* Created / Updated — the quiet audit line at the foot.
              REPLACED in proposal mode by the pinned count line: these are
              instants of the PLAN ROW, not of the work item, and the plan's own
              timeline carries them better (Part XIV §5). */}
          {proposal ? null : (
            <>
              <div className="-mx-1 my-1 h-px bg-(--el-border-soft)" />
              <div className="flex flex-col gap-1 font-sans text-xs text-(--el-text-secondary)">
                <span>
                  {t('created')} {formatDate(data.createdAt, locale)}
                </span>
                <span>
                  {t('updated')} {formatDate(data.updatedAt, locale)}
                </span>
              </div>
            </>
          )}
        </QuickViewRail>
      </QuickViewBody>
    </EstimationConfigProvider>
  );
  // THE QUICK VIEW'S TRANSLATION (MOTIR-8122; design MOTIR-8112 host differences
  // 1–5): the same provider, bar and marks as the item page, from the offer this
  // peek read carried. It draws only the title and the description, so it offers
  // and marks only those (D3) — its press is the page's request and translates
  // every differing field. Under auto-translate (MOTIR-8832) the offer carries the
  // reader's context (`translation.auto`) and the host starts on mount with the
  // same two-field scope. No offer (a Visitor, a proposal, a failed read): the
  // peek renders exactly as before. Bound to `peek` so the wrap re-indents nothing.
  const translation = proposal ? null : (data.translation ?? null);
  return translation ? (
    <TranslationProvider itemId={data.id} translation={translation} fields={QUICK_VIEW_FIELDS}>
      <RelatedTitles projectKey={data.projectIdentifier}>{peek}</RelatedTitles>
    </TranslationProvider>
  ) : (
    peek
  );
}
