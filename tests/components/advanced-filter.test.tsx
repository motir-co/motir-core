// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { ProjectFoldersDto } from '@/lib/dto/folders';
import type { LabelDto } from '@/lib/dto/labels';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import { EMPTY_FILTER, parseIssueFilter, type IssueFilter } from '@/lib/issues/issueListFilter';
import { decodeFilterParam, encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { FILTER_FIELDS, type FilterFieldDef } from '@/lib/filters/registry';
import { setAdvancedParam } from '@/lib/issues/issueListAdvancedFilter';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';

// The advanced filter BUILDER (Subtask 6.1.4) under happy-dom — the card's
// component AC: rows render FROM the registry (a test-only entry appears with
// zero UI changes), live-apply writes the `?filter=v1:` param round-trippably
// (asserted by decoding the pushed URL), pending rows are excluded from the
// badge + URL, the cap disables Add condition, the facet bar upgrades
// losslessly and shows the superseded state exactly beyond facet
// expressiveness, and the invalid-param callout recovers. The builder only
// NAVIGATES (the URL is the state) — we stub next/navigation and decode hrefs.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/items',
}));

import { IssueAdvancedFilter } from '@/app/(authed)/items/_components/IssueAdvancedFilter';
import { IssueFilterBar } from '@/app/(authed)/items/_components/IssueFilterBar';
import { AdvancedFilterSummary } from '@/app/(authed)/items/_components/AdvancedFilterSummary';
import { InvalidFilterCallout } from '@/app/(authed)/items/_components/InvalidFilterCallout';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto['hasPointerCapture'] = vi.fn(() => false);
  proto['setPointerCapture'] = vi.fn();
  proto['releasePointerCapture'] = vi.fn();
  proto['scrollIntoView'] = vi.fn();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // The label value editor's bounded autocomplete (6.1.5) — stub the fetch so
  // opening a label row never hits the network; chip names/stale come from the
  // server-resolved `referencedLabels` prop, so an empty window is fine here.
  (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ labels: [] }),
  }));
});

afterEach(() => {
  push.mockReset();
  cleanup();
});

const STATUSES: WorkflowStatusDto[] = [
  {
    id: 's1',
    projectId: 'p',
    key: 'todo',
    label: 'To Do',
    category: 'todo',
    color: null,
    position: 'a',
    isInitial: true,
  },
  {
    id: 's2',
    projectId: 'p',
    key: 'in_progress',
    label: 'In Progress',
    category: 'in_progress',
    color: null,
    position: 'b',
    isInitial: false,
  },
];

const MEMBERS: WorkspaceMemberDTO[] = [
  {
    userId: 'u-alice',
    name: 'Alice Chen',
    email: 'alice@acme.test',
    workspaceRole: 'manager',
    customRole: null,
  },
  {
    userId: 'u-dana',
    name: 'Dana Kim',
    email: 'dana@acme.test',
    workspaceRole: 'member',
    customRole: null,
  },
];

const SPRINTS: SprintDto[] = [
  {
    id: 'sp1',
    name: 'Sprint 1',
    goal: null,
    state: 'active',
    startDate: null,
    endDate: null,
    completedAt: null,
    sequence: 1,
    issueCount: 0,
    committedIssueCount: null,
    committedPoints: null,
  } as unknown as SprintDto,
];

// Epic-5 builder fixtures (Subtask 6.1.5): a select CF (with an archived
// option), a number CF, a user CF; two components; two referenced labels.
const CUSTOM_FIELDS: CustomFieldDefinitionDTO[] = [
  {
    id: 'cf-sev',
    key: 'severity',
    label: 'Severity',
    fieldType: 'select',
    description: null,
    position: 'a',
    valueCount: 3,
    options: [
      { id: 'opt-high', label: 'High', position: 'a', archived: false, valueCount: 2 },
      { id: 'opt-crit', label: 'Critical', position: 'b', archived: true, valueCount: 1 },
    ],
  },
  {
    id: 'cf-eff',
    key: 'effort',
    label: 'Effort',
    fieldType: 'number',
    description: null,
    position: 'b',
    valueCount: 1,
    options: [],
  },
  {
    id: 'cf-qa',
    key: 'qa_owner',
    label: 'QA owner',
    fieldType: 'user',
    description: null,
    position: 'c',
    valueCount: 0,
    options: [],
  },
];

const COMPONENTS: ComponentDto[] = [
  { id: 'cmp-api', name: 'API', description: null, defaultAssigneeId: null },
  { id: 'cmp-web', name: 'Web', description: null, defaultAssigneeId: null },
];

const REFERENCED_LABELS: LabelDto[] = [
  { id: 'lbl-perf', name: 'perf-q3' },
  { id: 'lbl-api', name: 'api' },
];

// The project's folders (Story MOTIR-5309 · MOTIR-5378) — a root and one inside it,
// so options and chips are told apart by PATH.
const FOLDERS: ProjectFoldersDto = {
  truncated: false,
  folders: [
    { id: 'f-parked', parentFolderId: null, name: 'Parked', position: 'a0', path: ['Parked'] },
    {
      id: 'f-2025',
      parentFolderId: 'f-parked',
      name: '2025',
      position: 'a0',
      path: ['Parked', '2025'],
    },
  ],
};

function renderBuilder(
  opts: {
    ast?: FilterAst | null;
    fields?: FilterFieldDef[];
    customFields?: CustomFieldDefinitionDTO[];
    components?: ComponentDto[];
    /** `null` renders a host that passes no folders (the board / backlog). */
    folders?: ProjectFoldersDto | null;
    referencedLabels?: LabelDto[];
  } = {},
) {
  const ast = opts.ast ?? null;
  const filter = ast ? setAdvancedParam(EMPTY_FILTER, ast) : EMPTY_FILTER;
  return renderWithIntl(
    <IssueAdvancedFilter
      filter={filter}
      ast={ast}
      view="tree"
      sort={DEFAULT_SORT}
      statuses={STATUSES}
      members={MEMBERS}
      sprints={SPRINTS}
      customFields={opts.customFields ?? CUSTOM_FIELDS}
      components={opts.components ?? COMPONENTS}
      folders={opts.folders === null ? undefined : (opts.folders ?? FOLDERS)}
      referencedLabels={opts.referencedLabels ?? REFERENCED_LABELS}
      projectKey="PROD"
      fields={opts.fields}
    />,
  );
}

function openBuilder() {
  fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));
}

/** Decode the `?filter=` param of the LAST pushed href into its AST. */
function lastPushedAst(): FilterAst | null {
  const href = push.mock.calls.at(-1)?.[0] as string;
  const params = new URLSearchParams(href.split('?')[1] ?? '');
  const raw = params.get('filter');
  if (raw === null) return null;
  const decoded = decodeFilterParam(raw);
  if (!decoded.ok) throw new Error(`pushed an undecodable filter: ${raw}`);
  return decoded.ast;
}

describe('IssueAdvancedFilter — the builder', () => {
  it('opens as a labelled dialog with the combinator sentence and footer', () => {
    renderBuilder();
    openBuilder();
    expect(screen.getByRole('dialog', { name: 'Advanced filter' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Combinator' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add condition' })).toBeTruthy();
    expect(screen.getByText('0 of 20 conditions · applied live')).toBeTruthy();
  });

  it('Add condition appends a PENDING row — drawn with the not-applied note, no URL push', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(
      within(row).getByText('Not applied yet — pick a value to activate this condition.'),
    ).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    // pending rows are excluded from the trigger badge
    expect(screen.getByRole('button', { name: /^Advanced$/ })).toBeTruthy();
  });

  it('completing a row live-applies the encoded AST (URL round-trip)', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    // default row: Kind · is any of · (empty kind-select); pick "Bug"
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Kind values' }));
    fireEvent.click(screen.getByRole('option', { name: /Bug/ }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    });
    // the trigger badge now counts the applied row
    expect(
      screen.getByRole('button', { name: 'Advanced filter — 1 condition active' }),
    ).toBeTruthy();
  });

  it('emptying an applied row returns it to pending WITHOUT dropping it (and clears the URL)', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Bug' }));
    // row still present, now pending; the URL drops the param
    expect(screen.getByRole('group', { name: 'Condition 1' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Condition 1' })).getByText(
        'Not applied yet — pick a value to activate this condition.',
      ),
    ).toBeTruthy();
    expect(push).toHaveBeenCalledTimes(1);
    expect(lastPushedAst()).toBeNull();
  });

  it('the field menu RENDERS the registry — a test-only entry appears with zero UI changes', () => {
    const testOnly: FilterFieldDef = {
      id: 'watchers' as never,
      fieldType: 'number',
      nullable: true,
      operators: ['eq', 'gt', 'is_empty', 'is_not_empty'],
    };
    renderBuilder({ fields: [...FILTER_FIELDS, testOnly] });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    // open the field picker — the entry lists under its raw id (no copy yet)
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'watchers' }));
    // its operator set populates from the registry def
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getByRole('option', { name: '=' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'is empty' })).toBeTruthy();
  });

  it('choosing a zero-arity operator collapses the value slot and applies at once', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'assignee', operator: 'is_any_of', value: ['u-alice'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    fireEvent.click(screen.getByRole('option', { name: 'is empty' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'assignee', operator: 'is_empty', value: null }],
    });
    // the value editor is gone
    expect(within(row).queryByRole('combobox', { name: 'Assignee values' })).toBeNull();
  });

  it('flipping the combinator to Match any re-applies with `or`', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
      ],
    };
    renderBuilder({ ast });
    openBuilder();
    fireEvent.click(within(screen.getByRole('group', { name: 'Combinator' })).getByText('any'));
    expect(lastPushedAst()?.combinator).toBe('or');
  });

  it('Clear all empties the rows and drops the param', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('group', { name: 'Condition 1' })).toBeNull();
    expect(lastPushedAst()).toBeNull();
  });

  it('at the 20-row cap Add condition disables with the cap notice', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: Array.from({ length: 20 }, () => ({
        field: 'kind' as const,
        operator: 'is_any_of' as const,
        value: ['bug'],
      })),
    };
    // NB 20 same-field rows decode fine (the cap is the only structural gate)
    renderBuilder({ ast });
    openBuilder();
    const add = screen.getByRole('button', { name: 'Add condition' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('Condition limit reached (20) — remove one to add another.'),
    ).toBeTruthy();
  });

  it('restores the builder state from the URL (reload/share)', () => {
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'status', operator: 'is_none_of', value: ['todo'] },
        { field: 'due', operator: 'in_next_days', value: 14 },
        { field: 'text', operator: 'contains', value: 'oauth' },
      ],
    };
    renderBuilder({ ast });
    openBuilder();
    expect(screen.getByRole('group', { name: 'Condition 1' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Condition 2' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Condition 3' })).toBeTruthy();
    expect(screen.getByText('3 of 20 conditions · applied live')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Text values' }) as HTMLInputElement).value).toBe(
      'oauth',
    );
    expect((screen.getByRole('textbox', { name: 'Day count' }) as HTMLInputElement).value).toBe(
      '14',
    );
  });

  it('debounces free-typing edits into one push', () => {
    vi.useFakeTimers();
    try {
      const ast: FilterAst = {
        combinator: 'and',
        conditions: [{ field: 'text', operator: 'contains', value: 'o' }],
      };
      renderBuilder({ ast });
      openBuilder();
      const input = screen.getByRole('textbox', { name: 'Text values' }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'oa' } });
      fireEvent.change(input, { target: { value: 'oauth' } });
      expect(push).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(push).toHaveBeenCalledTimes(1);
      expect(lastPushedAst()).toEqual({
        combinator: 'and',
        conditions: [{ field: 'text', operator: 'contains', value: 'oauth' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// MOTIR-6752: live-apply pushes each discrete edit at once, so two quick picks
// put TWO navigations in flight, and their echoes can land after the person has
// already added the next (pending) row. A pending row lives only in the working
// copy, so any echo misread as an EXTERNAL change rebuilds it away. These drive
// the echoes by hand — `rerender` with the URL each push wrote — in the order a
// loaded runner delivers them.
describe('IssueAdvancedFilter — late navigation echoes (MOTIR-6752)', () => {
  function builderFor(filter: IssueFilter, ast: FilterAst | null) {
    return (
      <IssueAdvancedFilter
        filter={filter}
        ast={ast}
        view="tree"
        sort={DEFAULT_SORT}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        folders={FOLDERS}
        referencedLabels={REFERENCED_LABELS}
        projectKey="PROD"
      />
    );
  }

  /** The props the page re-renders with once push #`n` (0-based) lands. */
  function echoOf(n: number) {
    const href = push.mock.calls[n]?.[0] as string;
    const raw = new URLSearchParams(href.split('?')[1] ?? '').get('filter');
    const decoded = raw === null ? null : decodeFilterParam(raw);
    const ast = decoded?.ok ? decoded.ast : null;
    return builderFor(setAdvancedParam(EMPTY_FILTER, ast), ast);
  }

  function pickKind(name: RegExp) {
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Kind values' }));
    fireEvent.click(screen.getByRole('option', { name }));
  }

  /** Two quick picks (two pushes, no echo yet), then Add condition. */
  function twoPicksThenAdd() {
    const view = renderWithIntl(builderFor(EMPTY_FILTER, null));
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    pickKind(/Bug/);
    pickKind(/Task/);
    expect(push).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(screen.getByRole('group', { name: 'Condition 2' })).toBeTruthy();
    return view;
  }

  it('keeps a just-added pending row when BOTH earlier pushes echo late, in order', () => {
    const { rerender } = twoPicksThenAdd();
    rerender(echoOf(0));
    rerender(echoOf(1));
    expect(screen.getByRole('group', { name: 'Condition 2' })).toBeTruthy();
    expect(screen.getByText('2 of 20 conditions · applied live')).toBeTruthy();
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('keeps it when only the LATEST echo arrives (the router coalesced the first)', () => {
    const { rerender } = twoPicksThenAdd();
    rerender(echoOf(1));
    expect(screen.getByRole('group', { name: 'Condition 2' })).toBeTruthy();
  });

  it('still rebuilds from the URL on a change it never pushed (Back to an earlier push)', () => {
    const { rerender } = twoPicksThenAdd();
    rerender(echoOf(1));
    // Back: the URL returns to push #0's value AFTER push #1's echo settled — an
    // external change now, so the working copy is rebuilt and the pending row goes.
    rerender(echoOf(0));
    expect(screen.queryByRole('group', { name: 'Condition 2' })).toBeNull();
    expect(screen.getByText('1 of 20 conditions · applied live')).toBeTruthy();
  });

  it('still rebuilds from the URL on an external change while its own pushes are in flight', () => {
    const { rerender } = twoPicksThenAdd();
    const external: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
    };
    rerender(builderFor(setAdvancedParam(EMPTY_FILTER, external), external));
    expect(screen.queryByRole('group', { name: 'Condition 2' })).toBeNull();
    expect(
      within(screen.getByRole('group', { name: 'Condition 1' })).getByRole('combobox', {
        name: 'Status values',
      }),
    ).toBeTruthy();
    // …and a push made BEFORE that change, landing after it, is read as the URL
    // it now is: the external change forgot the in-flight set.
    rerender(echoOf(1));
    expect(screen.queryByRole('group', { name: 'Condition 2' })).toBeNull();
    expect(screen.getByText('1 of 20 conditions · applied live')).toBeTruthy();
  });
});

describe('IssueFilterBar — superseded state + the one-way upgrade (6.1.4)', () => {
  function renderBar(filter: IssueFilter = EMPTY_FILTER, ast: FilterAst | null = null) {
    return renderWithIntl(
      <IssueFilterBar
        filter={filter}
        statuses={STATUSES}
        members={MEMBERS}
        view="tree"
        sort={DEFAULT_SORT}
        ast={ast}
      />,
    );
  }

  const BEYOND: FilterAst = {
    combinator: 'and',
    conditions: [{ field: 'status', operator: 'is_none_of', value: ['todo'] }],
  };
  const WITHIN: FilterAst = {
    combinator: 'and',
    conditions: [{ field: 'status', operator: 'is_any_of', value: ['todo'] }],
  };

  it('marks the facet trigger SUPERSEDED exactly when the AST exceeds facet expressiveness', () => {
    const { unmount } = renderBar(setAdvancedParam(EMPTY_FILTER, BEYOND), BEYOND);
    expect(screen.getByLabelText('Managed in Advanced')).toBeTruthy();
    unmount();
    renderBar(setAdvancedParam(EMPTY_FILTER, WITHIN), WITHIN);
    expect(screen.queryByLabelText('Managed in Advanced')).toBeNull();
  });

  it('the superseded popover is READ-ONLY with the Edit in Advanced hand-off', () => {
    renderBar(setAdvancedParam(EMPTY_FILTER, BEYOND), BEYOND);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const bug = screen.getByRole('option', { name: 'Bug' }) as HTMLButtonElement;
    expect(bug.disabled).toBe(true);
    fireEvent.click(bug);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit in Advanced' })).toBeTruthy();
  });

  it('Edit in Advanced upgrades the facets LOSSLESSLY into builder rows and swaps the params', () => {
    const facets: IssueFilter = {
      ...EMPTY_FILTER,
      kinds: ['bug'],
      statuses: ['todo'],
      includeUnassigned: true,
    };
    renderBar(facets);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit in Advanced' }));
    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0]![0] as string;
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    // the facet params are gone…
    expect(parseIssueFilter({ kind: params.getAll('kind') }).kinds).toEqual([]);
    expect(params.get('q')).toBeNull();
    // …and the AST carries every selection
    const decoded = decodeFilterParam(params.get('filter')!);
    expect(decoded.ok && decoded.ast).toEqual({
      combinator: 'and',
      conditions: [
        { field: 'kind', operator: 'is_any_of', value: ['bug'] },
        { field: 'status', operator: 'is_any_of', value: ['todo'] },
        { field: 'assignee', operator: 'is_any_of', value: ['unassigned'] },
      ],
    });
  });

  it('the facet Clear preserves an active advanced param (it clears FACETS, not the builder)', () => {
    const filter = setAdvancedParam({ ...EMPTY_FILTER, kinds: ['bug'] }, WITHIN);
    renderBar(filter, WITHIN);
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(push).toHaveBeenCalledTimes(1);
    const href = push.mock.calls[0]![0] as string;
    const params = new URLSearchParams(href.split('?')[1] ?? '');
    expect(params.getAll('kind')).toEqual([]);
    expect(params.get('filter')).toBe(encodeFilterParam(WITHIN));
  });
});

describe('AdvancedFilterSummary — the read-only chip readout', () => {
  it('renders one chip per condition with resolved value labels (+ Match any only on OR)', () => {
    const ast: FilterAst = {
      combinator: 'or',
      conditions: [
        { field: 'status', operator: 'is_any_of', value: ['todo', 'in_progress'] },
        { field: 'due', operator: 'in_next_days', value: 14 },
        { field: 'assignee', operator: 'is_any_of', value: ['u-dana', 'unassigned'] },
      ],
    };
    renderWithIntl(
      <AdvancedFilterSummary
        ast={ast}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
    );
    expect(screen.getByText('Match any')).toBeTruthy();
    expect(screen.getByText('is any of To Do, In Progress')).toBeTruthy();
    expect(screen.getByText('in the next 14 days')).toBeTruthy();
    expect(screen.getByText('is any of Dana Kim, Unassigned')).toBeTruthy();
  });

  it('omits the Match-any chip on AND', () => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [{ field: 'kind', operator: 'is_any_of', value: ['bug'] }],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
    );
    expect(screen.queryByText('Match any')).toBeNull();
  });
});

describe('InvalidFilterCallout — the typed recoverable state', () => {
  it('renders the alert with the designed copy and Clear filter navigates to the canonical URL', () => {
    renderWithIntl(<InvalidFilterCallout view="list" sort={DEFAULT_SORT} filter={EMPTY_FILTER} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('This filter link couldn’t be read')).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Clear filter' }));
    expect(push).toHaveBeenCalledWith('/items?view=list');
  });
});

describe('IssueAdvancedFilter — Epic-5 rows (Subtask 6.1.5)', () => {
  function openFieldPicker(rowName = 'Condition 1') {
    const row = screen.getByRole('group', { name: rowName });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    return row;
  }

  it('the field menu groups the dynamic custom-field entries under "Custom fields"', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    openFieldPicker();
    // the group header + every dynamic CF entry + the join fields render
    expect(screen.getByText('Custom fields')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Severity' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Effort' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'QA owner' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Label' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Component' })).toBeTruthy();
  });

  it('a project with no custom fields shows zero CF entries (registry-driven)', () => {
    renderBuilder({ customFields: [] });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    openFieldPicker();
    expect(screen.queryByText('Custom fields')).toBeNull();
    expect(screen.queryByRole('option', { name: 'Severity' })).toBeNull();
    // the built-in + join fields are still there
    expect(screen.getByRole('option', { name: 'Label' })).toBeTruthy();
  });

  it('builds a select custom-field condition incl. the archived option (URL round-trip)', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = openFieldPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Severity' }));
    // the value editor is the CF option picker; archived options carry the mark
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Severity values' }));
    expect(screen.getByRole('option', { name: 'Critical (archived)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'High' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high'] }],
    });
  });

  it('builds a component condition (URL round-trip)', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = openFieldPicker();
    fireEvent.click(screen.getByRole('option', { name: 'Component' }));
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Component values' }));
    fireEvent.click(screen.getByRole('option', { name: 'API' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'cmp', operator: 'is_any_of', value: ['cmp-api'] }],
    });
  });

  it('builds a number custom-field comparison (Effort ≥ 3)', () => {
    vi.useFakeTimers();
    try {
      renderBuilder();
      openBuilder();
      fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
      const row = openFieldPicker();
      fireEvent.click(screen.getByRole('option', { name: 'Effort' }));
      // default operator for a number field is `=`; switch to ≥ and type 3
      fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
      fireEvent.click(screen.getByRole('option', { name: '≥' }));
      // numeric input free-typing debounces the live-apply push
      fireEvent.change(within(row).getByRole('textbox', { name: 'Effort values' }), {
        target: { value: '3' },
      });
      vi.advanceTimersByTime(300);
      expect(lastPushedAst()).toEqual({
        combinator: 'and',
        conditions: [{ field: 'cf:cf-eff', operator: 'gte', value: 3 }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a label row from the URL — a deleted referent renders the stale chip + notice', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl-perf', 'lbl-gone'] }],
    };
    // referencedLabels resolves only the surviving id; 'lbl-gone' is deleted.
    renderBuilder({ ast, referencedLabels: [{ id: 'lbl-perf', name: 'perf-q3' }] });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('perf-q3')).toBeTruthy();
    expect(within(row).getByText('Unknown value')).toBeTruthy();
    expect(
      within(row).getByText(
        'This value no longer exists in the project — this condition matches nothing.',
      ),
    ).toBeTruthy();
    // removing the stale chip re-applies WITHOUT it (it matched nothing)
    fireEvent.click(within(row).getByRole('button', { name: 'Remove Unknown value' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl-perf'] }],
    });
  });

  it('degrades a deleted custom FIELD to the unknown-field row (kept, removable)', () => {
    const ast: FilterAst = {
      combinator: 'and',
      conditions: [{ field: 'cf:cf-gone', operator: 'is_any_of', value: ['opt-x'] }],
    };
    renderBuilder({ ast });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Unknown field')).toBeTruthy();
    expect(
      within(row).getByText('This field no longer exists — this condition matches nothing.'),
    ).toBeTruthy();
    // it counts as applied (matches nothing) until removed
    expect(screen.getByText('1 of 20 conditions · applied live')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Remove condition 1' }));
    expect(lastPushedAst()).toBeNull();
  });
});

describe('AdvancedFilterSummary — Epic-5 value resolution (6.1.5)', () => {
  function renderSummary(ast: FilterAst, referencedLabels = REFERENCED_LABELS) {
    return renderWithIntl(
      <AdvancedFilterSummary
        ast={ast}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        folders={FOLDERS}
        referencedLabels={referencedLabels}
      />,
    );
  }

  it('resolves CF-option, label, and component value names (with the field labels)', () => {
    renderSummary({
      combinator: 'and',
      conditions: [
        { field: 'cf:cf-sev', operator: 'is_any_of', value: ['opt-high', 'opt-crit'] },
        { field: 'lbl', operator: 'is_none_of', value: ['lbl-api'] },
        { field: 'cmp', operator: 'is_any_of', value: ['cmp-api'] },
      ],
    });
    expect(screen.getByText('Severity')).toBeTruthy();
    expect(screen.getByText('is any of High, Critical (archived)')).toBeTruthy();
    expect(screen.getByText('is none of api')).toBeTruthy();
    expect(screen.getByText('is any of API')).toBeTruthy();
  });

  it('renders a deleted referent as the unknown-value text', () => {
    renderSummary(
      {
        combinator: 'and',
        conditions: [{ field: 'lbl', operator: 'is_any_of', value: ['lbl-gone'] }],
      },
      [],
    );
    expect(screen.getByText('is any of Unknown value')).toBeTruthy();
  });
});

// The builder's FOLDER row (Story MOTIR-5309 · MOTIR-5378, placement.mock.html
// panel 5): last in the menu's Other group, values and chips by path, the
// included-folders hint, the empty pair, a deleted folder, no folders, a truncated
// list, a host that loads none, a reopened filter, and the applied chip.
describe('IssueAdvancedFilter — the Folder row', () => {
  function addFolderRow(): HTMLElement {
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'Folder' }));
    return row;
  }

  function openValues(row: HTMLElement) {
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Folder values' }));
  }

  it('sits last in the Other group, right after Component, with the four list operators', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    const names = screen.getAllByRole('option').map((o) => (o.textContent ?? '').trim());
    expect(names.indexOf('Folder')).toBe(names.indexOf('Component') + 1);

    fireEvent.click(screen.getByRole('option', { name: 'Folder' }));
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('lists folders by PATH, and picking two writes a ?filter= carrying both ids', () => {
    renderBuilder();
    openBuilder();
    const row = addFolderRow();
    openValues(row);
    expect(screen.getByRole('option', { name: 'Parked ▸ 2025' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Parked' }));
    openValues(row);
    fireEvent.click(screen.getByRole('option', { name: 'Parked ▸ 2025' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-parked', 'f-2025'] }],
    });
  });

  it('says folders inside a chosen folder are included, under a list-operator row', () => {
    renderBuilder();
    openBuilder();
    const row = addFolderRow();
    expect(within(row).getByText('Folders inside a chosen folder are included.')).toBeTruthy();
  });

  it('is empty collapses the value slot and drops the hint', () => {
    renderBuilder({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_empty', value: null }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).queryByRole('combobox', { name: 'Folder values' })).toBeNull();
    expect(within(row).queryByText('Folders inside a chosen folder are included.')).toBeNull();
  });

  it('reopens a saved or shared folder filter with its row populated by path', () => {
    renderBuilder({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_none_of', value: ['f-2025'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Parked ▸ 2025')).toBeTruthy();
    expect(within(row).getByRole('combobox', { name: 'Folder values' })).toBeTruthy();
  });

  it('a deleted folder renders the unknown-value chip and the per-row notice', () => {
    renderBuilder({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-parked', 'f-gone'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('Parked')).toBeTruthy();
    expect(within(row).getByText('Unknown value')).toBeTruthy();
    expect(
      within(row).getByText(
        'This value no longer exists in the project — this condition matches nothing.',
      ),
    ).toBeTruthy();
  });

  it('a project with no folders says so in the value list', () => {
    renderBuilder({ folders: { folders: [], truncated: false } });
    openBuilder();
    const row = addFolderRow();
    openValues(row);
    expect(screen.getByText('This project has no folders yet.')).toBeTruthy();
  });

  it('a truncated folder list shows the notice, and flags no folder past the window as deleted', () => {
    renderBuilder({
      folders: { ...FOLDERS, truncated: true },
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-past-the-cap'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    openValues(row);
    expect(screen.getByText('Showing the first 2 folders.')).toBeTruthy();
    expect(within(row).queryByText('Unknown value')).toBeNull();
  });

  it('a host that passes no folders offers no Folder field', () => {
    renderBuilder({ folders: null });
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    expect(screen.queryByRole('option', { name: 'Folder' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Component' })).toBeTruthy();
  });

  it('a host with no folders still restores a shared folder condition — disabled, its ids as they are', () => {
    // A board or backlog URL can carry a Folder condition its host never loads
    // folders for: the row stays (it still filters server-side), names no path
    // it cannot know, and calls nothing deleted.
    renderBuilder({
      folders: null,
      ast: {
        combinator: 'and',
        conditions: [{ field: 'folder', operator: 'is_any_of', value: ['f-parked'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(within(row).getByText('f-parked')).toBeTruthy();
    expect(within(row).queryByText('Unknown value')).toBeNull();
    const values = within(row).getByRole('combobox', { name: 'Folder values' });
    expect((values as HTMLInputElement).disabled).toBe(true);
  });

  it('the applied chip names an id as it is when the host loaded no folders, or only a truncated list', () => {
    const summary = (folders: ProjectFoldersDto | undefined, id: string) =>
      renderWithIntl(
        <AdvancedFilterSummary
          ast={{
            combinator: 'and',
            conditions: [{ field: 'folder', operator: 'is_any_of', value: [id] }],
          }}
          statuses={STATUSES}
          members={MEMBERS}
          sprints={SPRINTS}
          customFields={CUSTOM_FIELDS}
          components={COMPONENTS}
          folders={folders}
          referencedLabels={REFERENCED_LABELS}
        />,
      );

    summary(undefined, 'f-parked');
    expect(screen.getByText('is any of f-parked')).toBeTruthy();
    cleanup();

    summary({ ...FOLDERS, truncated: true }, 'f-past-the-cap');
    expect(screen.getByText('is any of f-past-the-cap')).toBeTruthy();
  });

  it('the applied chip names each folder by its path, and a deleted one as unknown', () => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [
            { field: 'folder', operator: 'is_any_of', value: ['f-2025'] },
            { field: 'folder', operator: 'is_none_of', value: ['f-gone'] },
          ],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        folders={FOLDERS}
        referencedLabels={REFERENCED_LABELS}
      />,
    );
    expect(screen.getAllByText('Folder')).toHaveLength(2);
    expect(screen.getByText('is any of Parked ▸ 2025')).toBeTruthy();
    expect(screen.getByText('is none of Unknown value')).toBeTruthy();
  });
});

// ── THE *CHECKS* FIELD IN THE BUILDER (Story MOTIR-5469 · MOTIR-5473) ─────────
// Design: `design/work-items/list--ci-badge.mock.html` panel 8, spec
// `design/work-items/design-notes.md` § *The CI badge (MOTIR-5471)*.
describe('IssueAdvancedFilter — the Checks field (MOTIR-5473)', () => {
  it('picks Checks → Failing and emits the AST', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });

    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'Checks' }));

    fireEvent.focus(within(row).getByRole('combobox', { name: 'Checks values' }));
    fireEvent.click(screen.getByRole('option', { name: /Checks failing/ }));

    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'ciState', operator: 'is_any_of', value: ['failing'] }],
    });
  });

  it('offers the three verdicts WORST-FIRST, the order the fold applies', () => {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'Checks' }));
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Checks values' }));

    const labels = screen
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
      .filter((text) => text.includes('Checks '));
    expect(labels).toEqual(['Checks failing', 'Checks running', 'Checks passing']);
  });

  it('words the empty pair as HAS NO CHECKS / HAS CHECKS, not "is empty"', () => {
    // The column's `null` means *no pull request has reported and none is
    // expected to* — a real answer a reader can name, which is why this field
    // overrides the generic empty pair.
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'Checks' }));

    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getByRole('option', { name: 'has no checks' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'has checks' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'is empty' })).toBeNull();
  });
});

// Story MOTIR-6016 · MOTIR-6100 — the Difficulty condition row, as drawn in
// `design/work-items/filter-builder--difficulty.mock.html`: a three-value
// picker, easiest first, and a chip that names the values, in en and zh.
describe('the Difficulty condition row', () => {
  it('offers Low · Medium · High and live-applies a pick', () => {
    renderBuilder({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'difficulty', operator: 'is_any_of', value: ['low'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Difficulty values' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toEqual(expect.arrayContaining(['Low', 'Medium', 'High']));
    fireEvent.click(screen.getByRole('option', { name: /High/ }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'difficulty', operator: 'is_any_of', value: ['low', 'high'] }],
    });
  });

  it.each([
    ['en', 'Difficulty', 'is any of Medium, High'],
    ['zh', '难度', null],
  ] as const)('the applied chip names the field and its values (%s)', (locale, field, text) => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [{ field: 'difficulty', operator: 'is_any_of', value: ['medium', 'high'] }],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
      locale === 'zh' ? { locale, messages: zhMessages } : {},
    );
    expect(screen.getByText(field)).toBeTruthy();
    if (text) expect(screen.getByText(text)).toBeTruthy();
    else {
      expect(document.body.textContent).toContain('中');
      expect(document.body.textContent).toContain('高');
    }
  });
});

// Story MOTIR-6575 · MOTIR-6678 — the Obsolescence condition row, per
// `design/boards/filter-builder--obsolescence.mock.html`: a two-value picker,
// mildest first, each with the badge's glyph; the nullable-enum operators; and a
// chip that names the field and its values, in en and zh. The board mounts the
// same builder, so this is its row too.
describe('the Obsolescence condition row', () => {
  it('offers Outdated · Deprecated, mildest first, and live-applies a pick', () => {
    renderBuilder({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'obsolescence', operator: 'is_any_of', value: ['outdated'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.focus(within(row).getByRole('combobox', { name: 'Obsolescence values' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toEqual(['Outdated', 'Deprecated']);
    for (const o of screen.getAllByRole('option')) expect(o.querySelector('svg')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Deprecated/ }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [
        { field: 'obsolescence', operator: 'is_any_of', value: ['outdated', 'deprecated'] },
      ],
    });
  });

  it('names the field Obsolescence and offers the four nullable-enum operators', () => {
    renderBuilder({
      ast: {
        combinator: 'and',
        conditions: [{ field: 'obsolescence', operator: 'is_any_of', value: ['outdated'] }],
      },
    });
    openBuilder();
    const row = screen.getByRole('group', { name: 'Condition 1' });
    expect(row.textContent).toContain('Obsolescence');
    const operator = within(row).getAllByRole('combobox')[1]!;
    fireEvent.click(operator);
    for (const name of ['is any of', 'is none of', 'is empty', 'is not empty'])
      expect(screen.getByRole('option', { name })).toBeTruthy();
  });

  it.each([
    ['en', 'Obsolescence', 'is any of Outdated, Deprecated'],
    ['zh', '失效状态', null],
  ] as const)('the applied chip names the field and its values (%s)', (locale, field, text) => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [
            { field: 'obsolescence', operator: 'is_any_of', value: ['outdated', 'deprecated'] },
          ],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
      locale === 'zh' ? { locale, messages: zhMessages } : {},
    );
    expect(screen.getByText(field)).toBeTruthy();
    if (text) expect(screen.getByText(text)).toBeTruthy();
    else {
      expect(document.body.textContent).toContain('已过时');
      expect(document.body.textContent).toContain('已弃用');
    }
  });
});

// Story MOTIR-6589 · MOTIR-6609 — the *To fix* condition row, as drawn in
// `design/work-items/to-fix--tag-and-banner.mock.html` panel 7: the four reasons
// in PRIORITY order, the empty pair worded *is any* / *is none*, and a chip that
// names the values in en and zh.
describe('the To fix condition row (MOTIR-6609)', () => {
  function pickToFix() {
    renderBuilder();
    openBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    const row = screen.getByRole('group', { name: 'Condition 1' });
    fireEvent.click(within(row).getByRole('combobox', { name: 'Field' }));
    fireEvent.click(screen.getByRole('option', { name: 'To fix' }));
    return row;
  }

  it('offers the six reasons in priority order — a dead run first — and emits the AST', () => {
    const row = pickToFix();
    fireEvent.focus(within(row).getByRole('combobox', { name: 'To fix values' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent?.trim());
    expect(options).toEqual([
      'Run died',
      'Failed in the merge queue',
      'Conflicts with its base branch',
      'Out of date with its base branch',
      'CI failed',
      'Changes requested',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'Conflicts with its base branch' }));
    expect(lastPushedAst()).toEqual({
      combinator: 'and',
      conditions: [{ field: 'fixReason', operator: 'is_any_of', value: ['conflicted'] }],
    });
  });

  it('words the empty pair as IS ANY / IS NONE, not "is empty"', () => {
    const row = pickToFix();
    fireEvent.click(within(row).getByRole('combobox', { name: 'Operator' }));
    expect(screen.getByRole('option', { name: 'is any' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'is none' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'is empty' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'is not empty' })).toBeNull();
  });

  it.each([
    ['en', 'To fix', 'is any of Failed in the merge queue, CI failed'],
    ['zh', '待修复', 'CI 未通过'],
  ] as const)('the applied chip names the field and its values (%s)', (locale, field, text) => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [
            { field: 'fixReason', operator: 'is_any_of', value: ['queue_failed', 'ci_failed'] },
          ],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
      locale === 'zh' ? { locale, messages: zhMessages } : {},
    );
    expect(screen.getByText(field)).toBeTruthy();
    expect(document.body.textContent).toContain(text);
  });

  it('the applied chip reads "To fix is any" for the not-empty operator', () => {
    renderWithIntl(
      <AdvancedFilterSummary
        ast={{
          combinator: 'and',
          conditions: [{ field: 'fixReason', operator: 'is_not_empty', value: null }],
        }}
        statuses={STATUSES}
        members={MEMBERS}
        sprints={SPRINTS}
        customFields={CUSTOM_FIELDS}
        components={COMPONENTS}
        referencedLabels={REFERENCED_LABELS}
      />,
    );
    expect(document.body.textContent).toContain('To fix');
    expect(document.body.textContent).toContain('is any');
  });
});
