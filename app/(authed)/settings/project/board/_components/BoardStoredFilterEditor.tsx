'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Funnel, Info, Plus, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  FilterConditionBuilder,
  useFilterConditionModel,
  workingFromAst,
  type WorkingState,
} from '@/app/(authed)/items/_components/FilterConditionBuilder';
import { advancedFieldLabel } from '@/app/(authed)/items/_components/advancedFilterLabels';
import { astFromRows } from '@/lib/issues/issueListAdvancedFilter';
import {
  customFieldIdOfFilterField,
  decodeFilterEnvelope,
  encodeFilterEnvelope,
  FILTER_ROW_CAP,
  type FilterAst,
  type FilterEnvelope,
  type FilterFieldId,
} from '@/lib/filters/ast';
import type {
  BoardDto,
  BoardTypeDto,
  StoredBoardFilterDto,
  StoredFilterStaleConditionDto,
} from '@/lib/dto/boards';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';

// The per-board settings page's STORED FILTER editor (Story MOTIR-10560 ·
// Subtask MOTIR-11334), built to `design/boards/board--stored-filter.mock.html`
// panels 5–6 (§ "Boards keep their own stored filter" → "2. Stored filter
// editor"). It hosts the ONE shared predicate UI, `FilterConditionBuilder`, as
// FORM state (`workingFromAst` in, `astFromRows` out, pending rows dropped) —
// the same host shape as the create dialog's section and `AutomationRuleEditor`.
//
// The editor never writes on an edit. Save sends `PATCH /api/boards/:id
// { filter }` with the committed envelope; "Show everything" empties the editor
// and says what Save will do, so clearing is ONE Save (`filter: null`) like any
// other edit, and Discard undoes it. A refusal (422) or a 403 keeps the working
// copy as typed and leaves the saved filter exactly as it was. A save that a
// newer save has overtaken is ignored when it lands (sequence-guarded), so a
// slow reply can never put an older filter back.

/** The lookups the shared builder needs, loaded by the settings page. */
export interface BoardStoredFilterLookups {
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** The project's folders by path (MOTIR-11669) — the builder's Folder field.
   * Required, so the page cannot silently hide the field. */
  folders: ProjectFoldersDto;
  /** The labels the stored filter names, resolved by the page. */
  referencedLabels: LabelDto[];
  projectKey: string;
}

export interface BoardStoredFilterEditorProps {
  boardId: string;
  boardType: BoardTypeDto;
  /** The board read's `storedFilter` (`null` when the board has none). */
  storedFilter: StoredBoardFilterDto | null;
  lookups: BoardStoredFilterLookups;
}

/** A typed failure of the save: a 422 refusal, a 403, or anything else. */
type SaveFailure =
  | {
      kind: 'refused';
      code: string;
      error: string;
      conditionIndex?: number;
      sent: FilterAst | null;
    }
  | { kind: 'forbidden' }
  | { kind: 'failed' };

/** The saved filter as the editor tracks it: the AST it seeds from (`null` when
 * there is none, or it no longer reads) and whether the board stores anything at
 * all (an unreadable envelope still counts — clearing it is a real change). */
interface SavedState {
  ast: FilterAst | null;
  present: boolean;
  stale: StoredFilterStaleConditionDto[];
}

function astOf(envelope: FilterEnvelope | null): FilterAst | null {
  if (!envelope) return null;
  const decoded = decodeFilterEnvelope(envelope);
  /* v8 ignore next -- the board read and the write both hand back an envelope that decodes */
  return decoded.ok ? decoded.ast : null;
}

function savedFrom(storedFilter: StoredBoardFilterDto | null): SavedState {
  return {
    ast: astOf(storedFilter?.envelope ?? null),
    present: storedFilter !== null,
    stale: storedFilter?.staleConditions ?? [],
  };
}

/** A canonical key for "is this the same filter" — the envelope, or `null`. */
function filterKey(ast: FilterAst | null): string {
  return ast && ast.conditions.length > 0 ? JSON.stringify(encodeFilterEnvelope(ast)) : 'null';
}

export function BoardStoredFilterEditor({
  boardId,
  boardType,
  storedFilter,
  lookups,
}: BoardStoredFilterEditorProps) {
  const t = useTranslations('settings.board.storedFilter');
  const router = useRouter();

  const [saved, setSaved] = useState<SavedState>(() => savedFrom(storedFilter));
  const [working, setWorkingState] = useState<WorkingState>(() => workingFromAst(saved.ast));
  // Whether the builder is mounted: a board with a filter opens on it; "Add a
  // board filter" opens an empty one; "Show everything" closes it.
  const [open, setOpen] = useState(() => (saved.ast?.conditions.length ?? 0) > 0);
  const [cleared, setCleared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [announce, setAnnounce] = useState('');
  const seq = useRef(0);

  const model = useFilterConditionModel({
    ast: saved.ast,
    customFields: lookups.customFields,
    components: lookups.components,
    folders: lookups.folders,
    referencedLabels: lookups.referencedLabels,
  });

  const committed: FilterAst | null = open
    ? astFromRows(working.combinator, working.rows, model.resolveDef)
    : null;
  const committedKey = filterKey(committed);
  const dirty = cleared ? saved.present : committedKey !== filterKey(saved.ast);

  function setWorking(next: WorkingState) {
    setWorkingState(next);
    setFailure(null);
    setAnnounce('');
  }

  function reseed(next: SavedState) {
    setWorkingState(workingFromAst(next.ast));
    setOpen((next.ast?.conditions.length ?? 0) > 0);
    setCleared(false);
    setFailure(null);
  }

  function discard() {
    seq.current += 1;
    setSaving(false);
    setAnnounce('');
    reseed(saved);
  }

  function showEverything() {
    setWorkingState(workingFromAst(null));
    setOpen(false);
    setCleared(true);
    setFailure(null);
    setAnnounce('');
  }

  async function save() {
    const sent = committed && committed.conditions.length > 0 ? committed : null;
    const mine = ++seq.current;
    setSaving(true);
    setFailure(null);
    setAnnounce('');
    let next: SaveFailure | null = null;
    let adopted: SavedState | null = null;
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ filter: sent ? encodeFilterEnvelope(sent) : null }),
      });
      if (res.ok) {
        const board = (await res.json()) as BoardDto;
        // The write's normalised envelope is the saved filter now; nothing it
        // holds was refused, so nothing in it is stale.
        adopted = { ast: astOf(board.filter), present: board.filter !== null, stale: [] };
      } else if (res.status === 422) {
        const body = (await res.json()) as { code: string; error: string; conditionIndex?: number };
        next = { kind: 'refused', ...body, sent };
      } else if (res.status === 403) {
        next = { kind: 'forbidden' };
      } else {
        next = { kind: 'failed' };
      }
    } catch {
      next = { kind: 'failed' };
    }
    // A newer save (or a Discard) overtook this one: its outcome is not ours to show.
    if (mine !== seq.current) return;
    setSaving(false);
    if (adopted) {
      setSaved(adopted);
      reseed(adopted);
      setAnnounce(t('savedAnnounce'));
      router.refresh();
    } else {
      setFailure(next);
    }
  }

  const stale = saved.stale;
  const unreadable = stale.some((s) => s.index === null);
  // An unreadable stored filter narrows the board to nothing: the footer stays
  // up so "Show everything" can clear it without building a filter first.
  const unreadablePending = unreadable && !cleared;
  const showFooter = open || dirty || unreadablePending;

  return (
    <section
      aria-label={t('title')}
      data-testid="board-stored-filter-editor"
      className="overflow-hidden rounded-(--radius-card) border border-(--el-border)"
    >
      <div className="flex items-center gap-2 border-b border-(--el-border) bg-(--el-surface-soft) px-4 py-3">
        <Funnel className="size-[17px] shrink-0 text-(--el-text-secondary)" aria-hidden />
        <h2 className="text-sm font-semibold text-(--el-text-strong)">{t('title')}</h2>
        {dirty ? (
          <span
            data-testid="board-stored-filter-unsaved"
            className="inline-flex items-center gap-1.5 text-xs text-(--el-text-secondary) italic"
          >
            <span className="h-2 w-2 rounded-full bg-(--el-warning)" aria-hidden />
            {t('unsaved')}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <p className="text-xs text-(--el-text-secondary)">{t('subtitle')}</p>

        {unreadablePending ? (
          <UnreadableCallout />
        ) : stale.length > 0 && !dirty ? (
          <StaleCallout stale={stale} model={model} />
        ) : null}

        {failure ? <FailureCallout failure={failure} /> : null}

        {cleared && saved.present ? (
          <p
            data-testid="board-stored-filter-cleared"
            className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-sky) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-[12.5px] text-(--el-text-strong)"
          >
            <Info className="mt-px size-4 shrink-0" aria-hidden />
            {t('clearedNote')}
          </p>
        ) : null}

        {open ? (
          <FilterConditionBuilder
            working={working}
            onChange={(next) => setWorking(next)}
            model={model}
            statuses={lookups.statuses}
            members={lookups.members}
            sprints={lookups.sprints}
            customFields={lookups.customFields}
            components={lookups.components}
            folders={lookups.folders}
            referencedLabels={lookups.referencedLabels}
            projectKey={lookups.projectKey}
            host="form"
          />
        ) : cleared && saved.present ? null : (
          <div className="flex items-center justify-between gap-3">
            {unreadablePending ? (
              <span />
            ) : (
              <p className="text-sm text-(--el-text-secondary)">
                {boardType === 'scrum' ? t('noneScrum') : t('none')}
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Plus className="size-4" />}
              data-testid="board-stored-filter-add"
              onClick={() => {
                setOpen(true);
                setCleared(false);
              }}
            >
              {t('add')}
            </Button>
          </div>
        )}

        {showFooter ? (
          <div className="flex items-center justify-between gap-2 border-t border-(--el-border) pt-3">
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X className="size-4" />}
              data-testid="board-stored-filter-clear"
              disabled={!(open || unreadablePending) || saving}
              onClick={showEverything}
            >
              {t('clear')}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="board-stored-filter-discard"
                disabled={!dirty && !saving}
                onClick={discard}
              >
                {t('discard')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                data-testid="board-stored-filter-save"
                disabled={!dirty || saving}
                loading={saving}
                onClick={() => void save()}
              >
                {t('save')}
              </Button>
            </div>
          </div>
        ) : null}

        <p
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="board-stored-filter-announce"
        >
          {announce}
        </p>
      </div>
    </section>
  );
}

function FailureCallout({ failure }: { failure: SaveFailure }) {
  const t = useTranslations('settings.board.storedFilter');
  let message: string;
  if (failure.kind === 'forbidden') {
    message = t('refusedForbidden');
  } else if (failure.kind === 'failed') {
    message = t('refusedFailed');
  } else if (failure.code === 'FILTER_TOO_LARGE') {
    const count = failure.sent?.conditions.length ?? 0;
    message = t('refusedTooMany', {
      cap: FILTER_ROW_CAP,
      count,
      extra: Math.max(count - FILTER_ROW_CAP, 1),
    });
  } else if (failure.conditionIndex !== undefined) {
    message = t('refusedInvalid', { n: failure.conditionIndex + 1, reason: failure.error });
  } else {
    message = t('refusedGeneric', { reason: failure.error });
  }
  return (
    <div
      role="alert"
      data-testid="board-filter-refusal"
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <TriangleAlert className="mt-px size-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <div className="text-[13px] leading-relaxed text-(--el-text-strong)">
        <p className="font-semibold">{t('refusedTitle')}</p>
        <p>{message}</p>
      </div>
    </div>
  );
}

function UnreadableCallout() {
  const t = useTranslations('settings.board.storedFilter');
  return (
    <div
      role="status"
      data-testid="board-stored-filter-stale"
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-yellow) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-[13px] text-(--el-text-strong)"
    >
      <TriangleAlert className="mt-px size-4 shrink-0 text-(--el-warning)" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">{t('unreadableTitle')}</p>
        <p>{t('unreadableBody')}</p>
      </div>
    </div>
  );
}

/** Which row copy names a stale condition: by what the condition's field is and
 * why the read reported it. */
function staleRowKey(field: FilterFieldId, reason: StoredFilterStaleConditionDto['reason']) {
  if (reason === 'invalid') return 'staleRowInvalid';
  if (customFieldIdOfFilterField(field) !== null) {
    return reason === 'unknown-field' ? 'staleRowField' : 'staleRowOption';
  }
  if (field === 'lbl') return 'staleRowLabel';
  if (field === 'cmp') return 'staleRowComponent';
  if (field === 'folder') return 'staleRowFolder';
  /* v8 ignore next -- the read reports staleness only for the referent fields above */
  return 'staleRowInvalid';
}

function StaleCallout({
  stale,
  model,
}: {
  stale: StoredFilterStaleConditionDto[];
  model: ReturnType<typeof useFilterConditionModel>;
}) {
  const t = useTranslations('settings.board.storedFilter');
  const tiv = useTranslations('issueViews');
  return (
    <div
      role="status"
      data-testid="board-stored-filter-stale"
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-yellow) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-[13px] text-(--el-text-strong)"
    >
      <TriangleAlert className="mt-px size-4 shrink-0 text-(--el-warning)" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">{t('staleTitle', { count: stale.length })}</p>
        <p>{t('staleBody')}</p>
        <ul className="mt-1 list-disc pl-4">
          {stale.map((s) => {
            const field = (s.field ?? '') as FilterFieldId;
            return (
              <li key={s.index}>
                {t(staleRowKey(field, s.reason), {
                  n: (s.index ?? 0) + 1,
                  field: advancedFieldLabel(tiv, field, model.dynamicLabels),
                })}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
