'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { FunnelPlus, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { buildIssueListHref, type IssueListView, type IssueSort } from '@/lib/issues/issueListView';
import type { IssueFilter } from '@/lib/issues/issueListFilter';
import { astFromRows, setAdvancedParam } from '@/lib/issues/issueListAdvancedFilter';
import type { FilterAst } from '@/lib/filters/ast';
import type { FilterFieldDef } from '@/lib/filters/registry';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import { cn } from '@/lib/utils/cn';
import { useAdvancedFilterPopover } from './AdvancedFilterContext';
import {
  FilterConditionBuilder,
  useFilterConditionModel,
  workingFromAst,
  type WorkingState,
} from './FilterConditionBuilder';

// The ADVANCED filter builder (Story 6.1 · Subtasks 6.1.4 + 6.1.5), per
// design/work-items/filter-builder.mock.html panels 1–4 + 6: the [Advanced]
// ToolbarButton beside the 2.5.4 [Filter] facet button, opening a Popover
// dialog hosting the shared `FilterConditionBuilder` (the SAME predicate UI the
// Story 6.6 automation rule editor mounts — one builder, two hosts). This host
// owns the URL plumbing: LIVE-APPLY (no Apply button — the 2.5.4 precedent) —
// complete rows write the versioned `?filter=v1:…` param as they land (composing
// with ?view/?sort and resetting ?page, all through buildIssueListHref); a row
// missing its value is PENDING (held in the builder's working copy only — never
// in the URL, the badge count, or the result set). Free-typing editors debounce
// the push; discrete edits apply at once. The working copy resyncs from the URL
// exactly when the param changes under us (back/forward, the facet upgrade,
// Clear elsewhere) — recognised by comparing against every param this component
// pushed whose echo has not landed yet — so an in-flight pending row never gets
// stomped by its own navigation echo, however late it lands (finding #58's
// optimistic-mirror lesson; MOTIR-6752).

export interface IssueAdvancedFilterProps {
  filter: IssueFilter;
  /** The decoded active AST (null when none / invalid — the page decodes). */
  ast: FilterAst | null;
  view: IssueListView;
  sort: IssueSort;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  /** The project's custom-field definitions — the dynamic `cf:<id>` field
   * entries + their option editors (Subtask 6.1.5). */
  customFields: CustomFieldDefinitionDTO[];
  /** The project's components (bounded) — the Component field's value editor. */
  components: ComponentDto[];
  /** The project's folders by path (Story MOTIR-5309 · MOTIR-5378) — the Folder
   * field's value editor. Every page that mounts this dialog passes it, the
   * board's toolbar included (MOTIR-11667); leaving it out offers no Folder
   * field. */
  folders?: ProjectFoldersDto;
  /** The active AST's referenced labels, resolved to names server-side — seeds
   * the Label editor's chips + drives label stale-detection. */
  referencedLabels: LabelDto[];
  /** Project identifier — the Label editor's debounced autocomplete read. */
  projectKey: string;
  /** Field-def override for tests (the registry-driven AC); defaults to the
   * registry's built-ins + the project's dynamic custom-field entries. */
  fields?: FilterFieldDef[];
  /** Navigation override (Subtask 6.15.3): the board injects
   * `buildBoardFilterHref` (board-scoped URL, no view/sort). Defaults to the
   * /items `buildIssueListHref`. */
  buildHref?: (filter: IssueFilter) => string;
  /** A host action placed before Clear all in the builder header (MOTIR-11565:
   * the board's "Reset to board filter"). Absent on /items. */
  headerAction?: ReactNode;
}

export function IssueAdvancedFilter({
  filter,
  ast,
  view,
  sort,
  statuses,
  members,
  sprints,
  customFields,
  components,
  folders,
  referencedLabels,
  projectKey,
  fields,
  buildHref,
  headerAction,
}: IssueAdvancedFilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const hrefFor = (next: IssueFilter) =>
    buildHref ? buildHref(next) : buildIssueListHref(pathname, { view, sort, filter: next });
  const t = useTranslations('issueViews');
  // Page-shared open state (the summary chips + the facet upgrade open the
  // builder from outside the toolbar); local fallback when no provider.
  const popoverCtx = useAdvancedFilterPopover();
  const [localOpen, setLocalOpen] = useState(false);
  const open = popoverCtx?.open ?? localOpen;
  const setOpen = popoverCtx?.setOpen ?? setLocalOpen;

  const model = useFilterConditionModel({
    ast,
    customFields,
    components,
    folders,
    referencedLabels,
    fields,
  });
  const { resolveDef } = model;

  // The working copy (incl. pending rows) lives here; the builder mutates it via
  // `apply`. Resync from the URL only when the param changed EXTERNALLY (a
  // back/forward / facet upgrade / Clear rebuilds). Every push this component
  // makes is queued in `inFlightRef` until its echo lands, and ANY queued value
  // is recognised as our own — not only the latest: two quick picks put two
  // navigations in flight, and the first echo arriving after the second push
  // used to read as external and rebuild a just-added pending row away
  // (MOTIR-6752). An echo also retires every push queued before it, since the
  // router may never render a superseded navigation.
  const [working, setWorking] = useState<WorkingState>(() => workingFromAst(ast));
  const lastPushedRef = useRef<string | null>(filter.advanced);
  const inFlightRef = useRef<(string | null)[]>([]);
  const seenAdvancedRef = useRef<string | null>(filter.advanced);
  useEffect(() => {
    if (filter.advanced === seenAdvancedRef.current) return;
    seenAdvancedRef.current = filter.advanced;
    const echo = inFlightRef.current.indexOf(filter.advanced);
    if (echo !== -1) {
      inFlightRef.current = inFlightRef.current.slice(echo + 1);
      return;
    }
    inFlightRef.current = [];
    lastPushedRef.current = filter.advanced;
    setWorking(workingFromAst(ast));
  }, [filter.advanced, ast]);

  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
  }, []);

  // Live-apply: push the applied rows' AST whenever it differs from the applied
  // param. `debounce` marks free-typing edits.
  function apply(next: WorkingState, opts?: { debounce?: boolean }) {
    setWorking(next);
    const nextAst = astFromRows(next.combinator, next.rows, resolveDef);
    const nextFilter = setAdvancedParam(filter, nextAst);
    if (pushTimer.current) clearTimeout(pushTimer.current);
    // `lastPushedRef` starts at the URL's param and tracks every push (a pushed
    // `null` — param cleared — is a real value, hence no `??`).
    if (nextFilter.advanced === lastPushedRef.current) return;
    const push = () => {
      lastPushedRef.current = nextFilter.advanced;
      inFlightRef.current = [...inFlightRef.current, nextFilter.advanced];
      router.push(hrefFor(nextFilter));
    };
    if (opts?.debounce) {
      pushTimer.current = setTimeout(push, 300);
    } else {
      push();
    }
  }

  const appliedCount = astFromRows(working.combinator, working.rows, resolveDef).conditions.length;
  const active = appliedCount > 0;

  const clearAllButton = (
    <button
      type="button"
      disabled={working.rows.length === 0}
      onClick={() => apply({ combinator: 'and', rows: [] })}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x-4) py-(--spacing-control-y-2) text-sm focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
        // Asked the same way `disabled` above is, so the faint ink is
        // visibly the inactive state rather than a second, independent
        // statement of it (MOTIR-2489).
        working.rows.length === 0
          ? 'cursor-default text-(--el-text-faint)'
          : 'text-(--el-link) hover:underline',
      )}
    >
      <X className="h-3.5 w-3.5" aria-hidden />
      {t('advancedClearAll')}
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={active ? t('advancedActiveAria', { count: appliedCount }) : t('advanced')}
          className={cn(
            'inline-flex h-(--height-control) items-center gap-2 rounded-(--radius-btn) border px-(--spacing-control-x-12) font-sans text-sm text-(--el-text) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none',
            active ? 'border-(--el-accent) bg-(--el-tint-lavender)' : 'border-(--el-border)',
          )}
        >
          <FunnelPlus
            className={cn(
              'h-4 w-4',
              active ? 'text-(--el-accent-on-surface)' : 'text-(--el-text-muted)',
            )}
            aria-hidden
          />
          {t('advanced')}
          {active ? (
            <span
              aria-hidden
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-(--radius-badge) bg-(--el-accent) px-(--spacing-chip-x-6) text-[11px] font-semibold text-(--el-accent-text) tabular-nums"
            >
              {appliedCount}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>

      <Popover.Content
        role="dialog"
        aria-label={t('advancedDialogLabel')}
        align="end"
        width={680}
        className="p-0"
        // Layered dismiss: with a row's field/operator menu or value listbox
        // open (they mark themselves `data-inner-dismiss`), Esc closes THAT and
        // keeps the builder open; a second Esc closes the builder. Radix captures
        // Escape at the document before the inner handlers run, so the deferral
        // must happen here, not in the inner components.
        onEscapeKeyDown={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('[data-inner-dismiss]')) event.preventDefault();
        }}
      >
        {/* Header — mono uppercase title + Clear all */}
        <div className="flex items-center justify-between gap-2 border-b border-(--el-border) px-3.5 py-2.5">
          <span className="font-mono text-[11px] font-semibold tracking-wider text-(--el-text-muted) uppercase">
            {t('advancedDialogLabel')}
          </span>
          {headerAction ? (
            <span className="inline-flex items-center gap-1">
              {headerAction}
              {clearAllButton}
            </span>
          ) : (
            clearAllButton
          )}
        </div>

        <div className="flex max-h-[60vh] flex-col overflow-y-auto px-3.5 py-3">
          <FilterConditionBuilder
            working={working}
            onChange={apply}
            model={model}
            statuses={statuses}
            members={members}
            sprints={sprints}
            customFields={customFields}
            components={components}
            folders={folders}
            referencedLabels={referencedLabels}
            projectKey={projectKey}
          />
        </div>
      </Popover.Content>
    </Popover>
  );
}
