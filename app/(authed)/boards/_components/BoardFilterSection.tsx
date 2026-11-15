'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bookmark, Funnel, Info, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import {
  FilterConditionBuilder,
  useFilterConditionModel,
  workingFromAst,
  type FilterConditionModel,
  type WorkingState,
} from '@/app/(authed)/items/_components/FilterConditionBuilder';
import { listFilters, resolveFilter } from '@/app/(authed)/filters/_components/savedFiltersClient';
import { astFromRows } from '@/lib/issues/issueListAdvancedFilter';
import {
  encodeFilterEnvelope,
  FILTER_ROW_CAP,
  type FilterAst,
  type FilterEnvelope,
} from '@/lib/filters/ast';
import { collectFilterReferentIds } from '@/lib/filters/registry';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import type { SavedFilterSummaryDto } from '@/lib/dto/savedFilters';

// The create-board dialog's optional BOARD FILTER section (Story MOTIR-10560 ·
// Subtask MOTIR-11333), built to `design/boards/board--stored-filter.mock.html`
// panels 1–4 (§ "Boards keep their own stored filter" → "1. Board filter
// section"). It hosts the ONE shared predicate UI, `FilterConditionBuilder`, as
// FORM state — the way `AutomationRuleEditor` hosts it (`workingFromAst` in,
// `astFromRows` out, pending rows dropped), never the `/items` URL host — and
// offers "Start from a saved filter", which COPIES the chosen saved filter's
// resolved conditions into the working copy. Only the copied conditions ever
// reach the write: no saved-filter id is kept, so a later edit or delete of that
// saved filter never changes the board.

/** The lookups the shared builder needs — the same reads `/boards` already makes
 * for its toolbar filter, threaded in from the server page. */
export interface BoardFilterLookups {
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  /** Labels the page already resolved (its URL filter's). The section adds the
   * labels a copied saved filter references. */
  referencedLabels: LabelDto[];
  projectKey: string;
}

/** A typed refusal from `POST /api/boards` (422 `{ code, error, conditionIndex? }`).
 * `conditionIndex` is the 0-based condition the server refused, when it named one. */
export interface BoardFilterRefusal {
  code: string;
  error: string;
  conditionIndex?: number;
}

type CopyState =
  | { kind: 'none' }
  | { kind: 'copied'; name: string }
  | { kind: 'broken'; name: string }
  | { kind: 'failed' };

/** The section's draft: whether it is open, the builder's working copy, and what
 * a copy and a refusal left behind. Held by the dialog so the submit can read the
 * committed filter. */
export interface BoardFilterDraft {
  open: boolean;
  setOpen: (open: boolean) => void;
  working: WorkingState;
  setWorking: (next: WorkingState) => void;
  model: FilterConditionModel;
  referencedLabels: LabelDto[];
  copy: CopyState;
  copyFrom: (filter: SavedFilterSummaryDto) => Promise<void>;
  refusal: { refusal: BoardFilterRefusal; sent: FilterAst } | null;
  setRefusal: (refusal: BoardFilterRefusal, sent: FilterAst) => void;
  /** The committed envelope to post, or `null` when the section holds no complete
   * condition (the board is then created with no stored filter). */
  committedFilter: () => { ast: FilterAst; envelope: FilterEnvelope } | null;
}

const EMPTY: WorkingState = workingFromAst(null);

/** Resolve label ids to labels through the project's labels route (`?ids=`). */
async function resolveLabels(projectKey: string, ids: string[]): Promise<LabelDto[]> {
  if (ids.length === 0) return [];
  const params = new URLSearchParams({ ids: ids.join(',') });
  const res = await fetch(`/api/projects/${encodeURIComponent(projectKey)}/labels?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`labels ${res.status}`);
  return ((await res.json()) as { labels: LabelDto[] }).labels;
}

export function useBoardFilterDraft(lookups: BoardFilterLookups): BoardFilterDraft {
  const [open, setOpenState] = useState(false);
  const [working, setWorkingState] = useState<WorkingState>(EMPTY);
  // The AST the builder's stale detection runs over: the copied one (a label it
  // names that resolves to nothing is the only "deleted" label).
  const [seedAst, setSeedAst] = useState<FilterAst | null>(null);
  const [copiedLabels, setCopiedLabels] = useState<LabelDto[]>([]);
  const [copy, setCopy] = useState<CopyState>({ kind: 'none' });
  const [refusal, setRefusalState] = useState<BoardFilterDraft['refusal']>(null);

  const referencedLabels = [
    ...lookups.referencedLabels,
    ...copiedLabels.filter((l) => !lookups.referencedLabels.some((r) => r.id === l.id)),
  ];

  const model = useFilterConditionModel({
    ast: seedAst,
    customFields: lookups.customFields,
    components: lookups.components,
    referencedLabels,
  });

  function setWorking(next: WorkingState) {
    setWorkingState(next);
    setRefusalState(null);
  }

  function setOpen(next: boolean) {
    setOpenState(next);
    if (!next) {
      // Removing the section discards its conditions: the board shows everything.
      setWorkingState(EMPTY);
      setSeedAst(null);
      setCopiedLabels([]);
      setCopy({ kind: 'none' });
      setRefusalState(null);
    }
  }

  async function copyFrom(filter: SavedFilterSummaryDto) {
    try {
      const resolved = await resolveFilter(lookups.projectKey, filter.id);
      if (resolved.astError || !resolved.ast) {
        // A broken saved filter copies nothing; the builder keeps what it held.
        setCopy({ kind: 'broken', name: filter.name });
        return;
      }
      const ast = resolved.ast;
      const labels = await resolveLabels(
        lookups.projectKey,
        collectFilterReferentIds(ast).labelIds,
      );
      setCopiedLabels(labels);
      setSeedAst(ast);
      setWorkingState(workingFromAst(ast));
      setRefusalState(null);
      setCopy({ kind: 'copied', name: filter.name });
    } catch {
      setCopy({ kind: 'failed' });
    }
  }

  function committedFilter() {
    if (!open) return null;
    const ast = astFromRows(working.combinator, working.rows, model.resolveDef);
    if (ast.conditions.length === 0) return null;
    return { ast, envelope: encodeFilterEnvelope(ast) };
  }

  return {
    open,
    setOpen,
    working,
    setWorking,
    model,
    referencedLabels,
    copy,
    copyFrom,
    refusal,
    setRefusal: (r, sent) => setRefusalState({ refusal: r, sent }),
    committedFilter,
  };
}

function RefusalCallout({ refusal, sent }: { refusal: BoardFilterRefusal; sent: FilterAst }) {
  const t = useTranslations('boards');
  let message: string;
  if (refusal.code === 'FILTER_TOO_LARGE') {
    const count = sent.conditions.length;
    message = t('filterRefusedTooMany', {
      cap: FILTER_ROW_CAP,
      count,
      extra: Math.max(count - FILTER_ROW_CAP, 1),
    });
  } else {
    message =
      refusal.conditionIndex === undefined
        ? t('filterRefusedGeneric', { reason: refusal.error })
        : t('filterRefusedInvalid', { n: refusal.conditionIndex + 1, reason: refusal.error });
  }
  return (
    <div
      role="alert"
      data-testid="board-filter-refusal"
      className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-rose) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <TriangleAlert className="mt-px size-4 shrink-0 text-(--el-danger-on-surface)" aria-hidden />
      <div className="text-[13px] leading-relaxed text-(--el-text-strong)">
        <p className="font-semibold">{t('filterRefusedTitle')}</p>
        <p>{message}</p>
      </div>
    </div>
  );
}

/** "Start from a saved filter" — the project's saved filters the reader can see,
 * searched through the shipped saved-filter client. */
function SavedFilterPicker({ draft, projectKey }: { draft: BoardFilterDraft; projectKey: string }) {
  const t = useTranslations('boards');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SavedFilterSummaryDto[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        listFilters(projectKey, { q: query || undefined, signal: controller.signal })
          .then((page) => setItems(page.items))
          .catch(() => {
            if (!controller.signal.aborted) setItems([]);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      controller.abort();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [projectKey, query]);

  const options: ComboboxOption<string>[] = (items ?? []).map((f) => ({
    value: f.id,
    label: f.name,
    secondary: f.owner.name,
  }));

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Combobox
        options={options}
        value={picked}
        onChange={(id) => {
          const filter = items?.find((f) => f.id === id);
          if (!filter) return;
          setPicked(id);
          void draft.copyFrom(filter);
        }}
        label={t('filterStartFromSaved')}
        placeholder={t('filterStartFromSavedPlaceholder')}
        triggerIcon={<Bookmark className="size-4 text-(--el-text-muted)" aria-hidden />}
        searchable
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder={t('filterStartFromSavedSearch')}
        loading={items === null}
        emptyText={t('filterStartFromSavedEmpty')}
        className="w-[16rem]"
      />
      <span className="text-xs text-(--el-text-secondary)">{t('filterStartFromSavedHint')}</span>
    </div>
  );
}

/** The create-board dialog's Board filter section (collapsed by default). */
export function BoardFilterSection({
  draft,
  lookups,
}: {
  draft: BoardFilterDraft;
  lookups: BoardFilterLookups;
}) {
  const t = useTranslations('boards');
  return (
    <fieldset className="flex flex-col gap-2.5" data-testid="board-filter-section">
      <legend className="mb-1 flex items-center gap-2 text-xs font-medium text-(--el-text-secondary)">
        {t('filterSectionLabel')}
        <span className="rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x-6) text-[11px] font-medium text-(--el-text-secondary)">
          {t('filterSectionOptional')}
        </span>
      </legend>

      {!draft.open ? (
        <div className="flex flex-col items-start gap-2 rounded-(--radius-input) border border-dashed border-(--el-border) px-(--spacing-control-x-12) py-(--spacing-control-y-8)">
          <p className="text-[12.5px] leading-snug text-(--el-text-secondary)">
            {t('filterSectionEmptyHint')}
          </p>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Funnel className="size-4" />}
            data-testid="board-filter-add"
            onClick={() => draft.setOpen(true)}
          >
            {t('filterSectionAdd')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-surface-soft) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12)">
          <div className="flex items-start justify-between gap-4">
            <p className="text-[12.5px] leading-snug text-(--el-text-secondary)">
              {t('filterSectionIntro')}
            </p>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<X className="size-4" />}
              data-testid="board-filter-remove"
              onClick={() => draft.setOpen(false)}
            >
              {t('filterSectionRemove')}
            </Button>
          </div>

          <SavedFilterPicker draft={draft} projectKey={lookups.projectKey} />

          {draft.copy.kind === 'copied' ? (
            <p
              data-testid="board-filter-copied"
              className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-sky) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-[12.5px] text-(--el-text-strong)"
            >
              <Info className="mt-px size-4 shrink-0" aria-hidden />
              {t('filterCopiedNote', { name: draft.copy.name })}
            </p>
          ) : draft.copy.kind === 'broken' || draft.copy.kind === 'failed' ? (
            <p
              role="status"
              data-testid="board-filter-copy-error"
              className="flex items-start gap-2 rounded-(--radius-control) bg-(--el-tint-yellow) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-[12.5px] text-(--el-text-strong)"
            >
              <TriangleAlert className="mt-px size-4 shrink-0 text-(--el-warning)" aria-hidden />
              {draft.copy.kind === 'broken'
                ? t('filterStartFromSavedBroken', { name: draft.copy.name })
                : t('filterStartFromSavedFailed')}
            </p>
          ) : null}

          {draft.refusal ? (
            <RefusalCallout refusal={draft.refusal.refusal} sent={draft.refusal.sent} />
          ) : null}

          <div className="rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-12)">
            <FilterConditionBuilder
              working={draft.working}
              onChange={(next) => draft.setWorking(next)}
              model={draft.model}
              statuses={lookups.statuses}
              members={lookups.members}
              sprints={lookups.sprints}
              customFields={lookups.customFields}
              components={lookups.components}
              referencedLabels={draft.referencedLabels}
              projectKey={lookups.projectKey}
              host="form"
            />
          </div>
        </div>
      )}
    </fieldset>
  );
}
