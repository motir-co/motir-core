// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  changedRows,
  combineRoom,
  OrgAiModelsRoom,
  runRow,
} from '@/app/(authed)/settings/organization/ai-models/_components/OrgAiModelsRoom';
import type {
  OrgPlannerModelRowDTO,
  OrgPlannerModelsDTO,
  OrgRunModelRowDTO,
  OrgRunModelsDTO,
} from '@/lib/dto/orgAiModels';

// OrgAiModelsRoom (MOTIR-10846 · Story MOTIR-10838) — the org AI models room, per
// `design/org-admin/org-admin--ai-models.mock.html`. Driven under happy-dom: the
// room is a client island over the two org route sets, so global fetch is stubbed
// per URL with answers in the routes' own DTO shapes. Every panel is asserted:
// loading · editable · staged + saved · cleared · refused · withdrawn · locked ·
// not applying · read-only · unavailable (+ Try again) · meta.

const ORG = 'org_1';
const PLANNING_URL = `/api/organizations/${ORG}/ai-models/planning`;
const RUNS_URL = `/api/organizations/${ORG}/ai-models/runs`;

const PLANNING_OFFER = [
  { id: 'claude-opus-5-5', provider: 'anthropic' },
  { id: 'claude-sonnet-5-5', provider: 'anthropic' },
  { id: 'glm-5.1', provider: 'zai' },
];
const RUN_OFFER = [
  { id: 'claude-haiku-5-5', provider: 'anthropic' },
  { id: 'claude-opus-5-5', provider: 'anthropic' },
  { id: 'gpt-5.2-codex', provider: 'openai' },
];

const pRow = (fn: OrgPlannerModelRowDTO['function'], over: Partial<OrgPlannerModelRowDTO> = {}) =>
  ({
    function: fn,
    model: null,
    withdrawn: false,
    applies: false,
    effectiveModel: 'claude-opus-5-5',
    effectiveSource: 'function_default',
    updatedAt: null,
    ...over,
  }) satisfies OrgPlannerModelRowDTO;

const rRow = (key: OrgRunModelRowDTO['key'], over: Partial<OrgRunModelRowDTO> = {}) =>
  ({
    key,
    model: null,
    withdrawn: false,
    effectiveModel: key === 'design' ? null : 'claude-haiku-5-5',
    effectiveSource: key === 'design' ? 'difficulty_mapping' : 'platform_level',
    ...over,
  }) satisfies OrgRunModelRowDTO;

function planning(
  over: Partial<Record<OrgPlannerModelRowDTO['function'], Partial<OrgPlannerModelRowDTO>>> = {},
  canEdit = true,
): OrgPlannerModelsDTO {
  return {
    state: 'ready',
    canEdit,
    rows: (['planning', 'guide', 'debug', 'ask'] as const).map((fn) => pRow(fn, over[fn])),
    offered: PLANNING_OFFER,
  };
}

function runs(
  over: Partial<Record<OrgRunModelRowDTO['key'], Partial<OrgRunModelRowDTO>>> = {},
  canEdit = true,
): OrgRunModelsDTO {
  return {
    state: 'ready',
    canEdit,
    rows: (['trivial', 'low', 'medium', 'high', 'review', 'design'] as const).map((k) =>
      rRow(k, over[k]),
    ),
    offered: RUN_OFFER,
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, body: unknown = {}) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: { planning: Handler; runs: Handler; patchPlanning: Handler; patchRuns: Handler };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routes = {
    planning: () => ok(planning()),
    runs: () => ok(runs()),
    patchPlanning: (init) => {
      const body = JSON.parse(init!.body as string);
      return ok({
        function: body.function,
        previousModel: null,
        model: body.model,
        updatedAt: 'x',
      });
    },
    patchRuns: (init) => {
      const body = JSON.parse(init!.body as string);
      return ok({
        key: body.key,
        previousModel: null,
        model: body.model,
        row: rRow(body.key, {
          model: body.model,
          effectiveModel: body.model ?? 'claude-haiku-5-5',
          effectiveSource: body.model ? 'org_level' : 'platform_level',
        }),
      });
    },
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const patch = init?.method === 'PATCH';
    if (url === PLANNING_URL) return patch ? routes.patchPlanning(init) : routes.planning(init);
    if (url === RUNS_URL) return patch ? routes.patchRuns(init) : routes.runs(init);
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(props: { isMeta?: boolean; planName?: string | null } = {}) {
  renderWithIntl(
    <ToastProvider>
      <OrgAiModelsRoom
        orgId={ORG}
        orgName="Acme Robotics"
        isMeta={props.isMeta ?? false}
        planName={props.planName === undefined ? 'Pro' : props.planName}
      />
    </ToastProvider>,
  );
  await act(async () => {});
}

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
}

const row = (id: string) => screen.getByTestId(`org-ai-models-row-${id}`);
const chooser = (name: string) =>
  screen.getByRole('combobox', { name: `Model for ${name}` }) as HTMLButtonElement;
const source = (id: string) => screen.getByTestId(`org-ai-models-source-${id}`).textContent;
const saveButton = () => screen.getByTestId('org-ai-models-save') as HTMLButtonElement;
const patches = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);

async function pick(name: string, model: string) {
  await click(chooser(name));
  const option = screen.getAllByRole('option').find((o) => o.textContent?.includes(model));
  await click(option!);
}

describe('the room states', () => {
  it('reads both routes on mount and shows the loading face while they run', async () => {
    let release!: () => void;
    routes.runs = () => new Promise((r) => (release = () => r(ok(runs()))));
    await mount();
    expect(fetchMock).toHaveBeenCalledWith(PLANNING_URL, expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(RUNS_URL, expect.anything());
    expect(screen.getByTestId('org-ai-models-card').parentElement!.getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(screen.getByTestId('org-ai-models-skeleton-guide')).toBeTruthy();
    expect(chooser('Guide').disabled).toBe(true);
    expect(chooser('Guide').textContent).toContain('Loading models…');
    await act(async () => release());
    expect(screen.queryByTestId('org-ai-models-skeleton-guide')).toBeNull();
  });

  it('editable: both groups in order, effective models, inherits pills, lines, Save disabled', async () => {
    await mount();
    expect(screen.getByText('Planning-side')).toBeTruthy();
    expect(screen.getByText('Run-side')).toBeTruthy();
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('aria-label'))).toEqual([
      'Model for Planning',
      'Model for Guide',
      'Model for Debug',
      'Model for Ask',
      'Model for Review agent',
      'Model for Trivial',
      'Model for Low',
      'Model for Medium',
      'Model for High',
      'Model for Design run',
    ]);
    expect(chooser('Guide').textContent).toContain('claude-opus-5-5');
    expect(source('guide')).toBe('Inherits platform default');
    expect(chooser('Design run').textContent).toContain('Follows the work item’s difficulty');
    expect(screen.getByTestId('org-ai-models-agent-run').textContent).toContain(
      'A project’s own override for a difficulty still wins over the organisation’s.',
    );
    const precedence = screen.getByTestId('org-ai-models-precedence').textContent!;
    expect(precedence).toContain('Which model a job uses');
    expect(precedence).toContain('more of Acme Robotics’s credits');
    expect(screen.queryByTestId('org-ai-models-clear-guide')).toBeNull();
    expect(saveButton().disabled).toBe(true);
    expect(
      screen.getByText(
        'Each function uses the platform default until your organisation chooses another.',
      ),
    ).toBeTruthy();
  });

  it('an organisation choice reads as such, with Clear', async () => {
    routes.planning = () =>
      ok(
        planning({
          guide: { model: 'glm-5.1', effectiveModel: 'glm-5.1', effectiveSource: 'org' },
        }),
      );
    routes.runs = () =>
      ok(
        runs({
          high: {
            model: 'gpt-5.2-codex',
            effectiveModel: 'gpt-5.2-codex',
            effectiveSource: 'org_level',
          },
        }),
      );
    await mount();
    expect(source('guide')).toBe('Organisation choice');
    expect(source('high')).toBe('Organisation choice');
    expect(chooser('High').textContent).toContain('gpt-5.2-codex');
    expect(
      screen.getByRole('button', { name: 'Clear the Guide choice' }).getAttribute('data-testid'),
    ).toBe('org-ai-models-clear-guide');
  });

  it('withdrawn: the fallback, Inherits + the chip, the struck note, Clear still offered', async () => {
    routes.planning = () =>
      ok(
        planning({
          guide: { model: 'gone-1', withdrawn: true, effectiveModel: 'claude-opus-5-5' },
        }),
      );
    routes.runs = () =>
      ok(runs({ design: { model: 'gone-2', withdrawn: true, effectiveModel: null } }));
    await mount();
    expect(source('guide')).toBe('Inherits platform default');
    expect(screen.getByTestId('org-ai-models-withdrawn-chip-guide').textContent).toBe(
      'No longer offered',
    );
    const note = screen.getByTestId('org-ai-models-withdrawn-guide');
    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toBe(
      'gone-1 is no longer offered, so Guide falls back to the platform default, claude-opus-5-5, until you choose another.',
    );
    expect(note.querySelector('s')!.textContent).toBe('gone-1');
    expect(screen.getByTestId('org-ai-models-withdrawn-design').textContent).toBe(
      'gone-2 is no longer offered, so Design run falls back to the platform default until you choose another.',
    );
    expect(screen.getByTestId('org-ai-models-clear-guide')).toBeTruthy();
  });

  it('locked: the panel only, a link to Billing & plans, and no model id anywhere', async () => {
    routes.planning = () => ok({ state: 'locked', canEdit: false, keptChoices: false });
    await mount({ planName: 'Standard' });
    const panel = screen.getByTestId('org-ai-models-locked');
    expect(panel.textContent).toContain('Choosing models is part of Pro and above');
    expect(panel.textContent).toContain('Acme Robotics is on Standard.');
    expect(screen.getByRole('link', { name: 'See plans' }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByTestId('org-ai-models-save')).toBeNull();
    expect(screen.queryByTestId('org-ai-models-not-applying')).toBeNull();
    const html = document.body.innerHTML;
    for (const m of [...PLANNING_OFFER, ...RUN_OFFER]) expect(html).not.toContain(m.id);
  });

  it('stored but not applying: the kept-choices line, still no model id; no plan name reads without it', async () => {
    routes.runs = () => ok({ state: 'locked', canEdit: false, keptChoices: true });
    await mount({ planName: null });
    expect(screen.getByTestId('org-ai-models-not-applying').textContent).toBe(
      'Acme Robotics’s saved choices are kept. They apply again when it moves to Pro or above.',
    );
    expect(screen.getByTestId('org-ai-models-locked').textContent).toContain(
      'Until then every function in Acme Robotics uses the platform default.',
    );
    const html = document.body.innerHTML;
    for (const m of [...PLANNING_OFFER, ...RUN_OFFER]) expect(html).not.toContain(m.id);
  });

  it('read-only: values as text, no chooser, Clear or Save, and the read-only line', async () => {
    routes.planning = () =>
      ok(
        planning(
          {
            guide: { model: 'glm-5.1', effectiveModel: 'glm-5.1', effectiveSource: 'org' },
            ask: { model: 'gone', withdrawn: true },
          },
          false,
        ),
      );
    routes.runs = () => ok(runs({}, false));
    await mount();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByTestId('org-ai-models-save')).toBeNull();
    expect(screen.queryByTestId('org-ai-models-clear-guide')).toBeNull();
    expect(screen.getByTestId('org-ai-models-read-only').textContent).toBe(
      'Only an owner or admin of Acme Robotics can change these.',
    );
    expect(row('guide').textContent).toContain('glm-5.1');
    expect(row('guide').textContent).toContain('zai');
    expect(row('design').textContent).toContain('Follows the work item’s difficulty');
    expect(screen.getByTestId('org-ai-models-withdrawn-ask').textContent).toContain(
      'until an owner or admin chooses another.',
    );
  });

  it('unavailable: either side unreadable or failing shows the card, Try again re-reads both', async () => {
    routes.runs = () => ok({ state: 'unreadable', canEdit: false });
    await mount();
    const card = screen.getByTestId('org-ai-models-unavailable');
    expect(card.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByTestId('org-ai-models-save')).toBeNull();

    routes.runs = () => ok(runs());
    fetchMock.mockClear();
    await click(screen.getByTestId('org-ai-models-retry'));
    expect(fetchMock.mock.calls.map(([u]) => u).sort()).toEqual([PLANNING_URL, RUNS_URL]);
    expect(screen.queryByTestId('org-ai-models-unavailable')).toBeNull();
    expect(chooser('Guide')).toBeTruthy();
  });

  it('a network error and a non-OK answer are unavailable too', async () => {
    routes.planning = () => {
      throw new Error('offline');
    };
    await mount();
    expect(screen.getByTestId('org-ai-models-unavailable')).toBeTruthy();
    cleanup();
    routes.planning = () => ok(planning());
    routes.runs = () => fail(500);
    await mount();
    expect(screen.getByTestId('org-ai-models-unavailable')).toBeTruthy();
  });

  it('a read that resolves after a newer one is ignored', async () => {
    const pending: ((r: Response) => void)[] = [];
    routes.planning = () => new Promise((r) => pending.push(r));
    routes.runs = () => ok({ state: 'unreadable', canEdit: false });
    await mount();
    await click(screen.getByTestId('org-ai-models-retry'));
    routes.runs = () => ok(runs());
    // The NEWER planning read answers first, then the stale one with a locked answer.
    await act(async () => pending[1]!(ok(planning())));
    await act(async () => pending[0]!(ok({ state: 'locked', canEdit: false, keptChoices: true })));
    expect(screen.queryByTestId('org-ai-models-locked')).toBeNull();
  });

  it('meta: editable on any plan, its own subtitle and no upgrade note', async () => {
    await mount({ isMeta: true, planName: 'Free' });
    expect(
      screen.getByText(
        'Acme Robotics is Motir’s meta organisation, so it chooses its own models on any plan.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('org-ai-models-locked')).toBeNull();
    expect(saveButton()).toBeTruthy();
  });
});

describe('edit and save', () => {
  it('lists only the row’s own route offer and marks the inherited default', async () => {
    await mount();
    await click(chooser('Guide'));
    const planningOptions = screen.getAllByRole('option').map((o) => o.textContent);
    expect(planningOptions).toHaveLength(3);
    expect(planningOptions.some((t) => t?.includes('glm-5.1'))).toBe(true);
    expect(planningOptions.find((t) => t?.includes('claude-opus-5-5'))).toContain(
      'Platform default',
    );
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    await click(chooser('High'));
    const runOptions = screen.getAllByRole('option').map((o) => o.textContent);
    expect(runOptions.some((t) => t?.includes('gpt-5.2-codex'))).toBe(true);
    expect(runOptions.some((t) => t?.includes('glm-5.1'))).toBe(false);
  });

  it('stages a pick, Save sends one PATCH per changed row, rows update in place with a toast', async () => {
    await mount();
    await pick('Guide', 'glm-5.1');
    await pick('High', 'gpt-5.2-codex');
    expect(row('guide').textContent).toContain('Not saved yet');
    expect(source('guide')).toBe('Organisation choice');
    expect(screen.getByTestId('org-ai-models-footer-hint').textContent).toBe(
      'You have unsaved changes.',
    );
    routes.planning = () =>
      ok(
        planning({
          guide: { model: 'glm-5.1', effectiveModel: 'glm-5.1', effectiveSource: 'org' },
        }),
      );
    await click(saveButton());
    expect(patches()).toEqual([
      [PLANNING_URL, { function: 'guide', model: 'glm-5.1' }],
      [RUNS_URL, { key: 'high', model: 'gpt-5.2-codex' }],
    ]);
    expect(source('guide')).toBe('Organisation choice');
    expect(source('high')).toBe('Organisation choice');
    expect(chooser('High').textContent).toContain('gpt-5.2-codex');
    expect(row('guide').textContent).not.toContain('Not saved yet');
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText('AI models saved')).toBeTruthy();
    expect(screen.getByText('Acme Robotics uses them from the next job or run.')).toBeTruthy();
  });

  it('Clear then Save sends model: null; picking the inherited default stages nothing', async () => {
    routes.runs = () =>
      ok(
        runs({
          review: {
            model: 'gpt-5.2-codex',
            effectiveModel: 'gpt-5.2-codex',
            effectiveSource: 'org_review',
          },
        }),
      );
    await mount();
    await click(screen.getByTestId('org-ai-models-clear-review'));
    expect(source('review')).toBe('Inherits platform default');
    expect(chooser('Review agent').textContent).toContain('The platform default');
    await pick('Low', 'claude-opus-5-5');
    await pick('Low', 'claude-haiku-5-5'); // the inherited model: a clear, not a choice
    await click(saveButton());
    expect(patches()).toEqual([[RUNS_URL, { key: 'review', model: null }]]);
  });

  it('Cancel puts every row back', async () => {
    await mount();
    await pick('Ask', 'glm-5.1');
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(source('ask')).toBe('Inherits platform default');
    expect(saveButton().disabled).toBe(true);
  });

  it('MODEL_NOT_OFFERED keeps the row, names the model and re-reads; other rows stay saved', async () => {
    routes.patchPlanning = () => fail(422, { code: 'MODEL_NOT_OFFERED', model: 'glm-5.1' });
    await mount();
    await pick('Debug', 'glm-5.1');
    await pick('Low', 'gpt-5.2-codex');
    fetchMock.mockClear();
    await click(saveButton());
    const refusal = screen.getByTestId('org-ai-models-refused-debug');
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent).toBe(
      'Not saved: glm-5.1 stopped being offered for Debug before the save reached it. Debug keeps its current model; choose another.',
    );
    expect(source('debug')).toBe('Inherits platform default');
    expect(source('low')).toBe('Organisation choice');
    expect(fetchMock.mock.calls.filter(([u, i]) => u === PLANNING_URL && !i?.method)).toHaveLength(
      1,
    );
    expect(screen.getByText('AI models saved')).toBeTruthy();
    // A new pick on the row clears its refusal.
    await pick('Debug', 'claude-sonnet-5-5');
    expect(screen.queryByTestId('org-ai-models-refused-debug')).toBeNull();
  });

  it('MODEL_UNREACHABLE and an unknown refusal are said on their rows; no toast when nothing saved', async () => {
    routes.patchPlanning = () =>
      fail(422, { code: 'MODEL_UNREACHABLE', model: 'glm-5.1', reason: 'timeout' });
    routes.patchRuns = () => fail(500, {});
    await mount();
    await pick('Ask', 'glm-5.1');
    await pick('Trivial', 'gpt-5.2-codex');
    await click(saveButton());
    expect(screen.getByTestId('org-ai-models-refused-ask').textContent).toBe(
      'Not saved: glm-5.1 cannot be reached right now, so Ask keeps its current model. Try again, or choose another.',
    );
    expect(screen.getByTestId('org-ai-models-refused-trivial').textContent).toBe(
      'Not saved: Trivial could not be saved. It keeps its current model; try again.',
    );
    expect(screen.queryByText('AI models saved')).toBeNull();
  });

  it('a network error on a PATCH is a failed row', async () => {
    routes.patchRuns = () => {
      throw new Error('offline');
    };
    await mount();
    await pick('Medium', 'gpt-5.2-codex');
    await click(saveButton());
    expect(screen.getByTestId('org-ai-models-refused-medium')).toBeTruthy();
  });

  it('ORG_MODEL_CHOICE_NOT_QUALIFIED re-reads the room, which shows locked', async () => {
    routes.patchRuns = () => fail(403, { code: 'ORG_MODEL_CHOICE_NOT_QUALIFIED' });
    await mount();
    await pick('High', 'gpt-5.2-codex');
    routes.planning = () => ok({ state: 'locked', canEdit: false, keptChoices: false });
    routes.runs = () => ok({ state: 'locked', canEdit: false, keptChoices: false });
    await click(saveButton());
    expect(screen.getByTestId('org-ai-models-locked')).toBeTruthy();
  });

  it('MODELS_UNREADABLE shows the unavailable card', async () => {
    routes.patchPlanning = () => fail(503, { code: 'MODELS_UNREADABLE' });
    await mount();
    await pick('Planning', 'glm-5.1');
    await click(saveButton());
    expect(screen.getByTestId('org-ai-models-unavailable')).toBeTruthy();
  });
});

describe('the pure helpers', () => {
  it('combineRoom: unreadable beats locked beats ready; a split qualification is locked', () => {
    const lockedKept = {
      state: 'answered' as const,
      dto: { state: 'locked' as const, canEdit: false as const, keptChoices: true },
    };
    const readyP = { state: 'answered' as const, dto: planning() };
    const readyR = { state: 'answered' as const, dto: runs() };
    expect(combineRoom({ state: 'loading' }, readyR)).toEqual({ face: 'loading' });
    expect(combineRoom({ state: 'failed' }, { state: 'loading' })).toEqual({ face: 'unavailable' });
    expect(
      combineRoom(lockedKept, { state: 'answered', dto: { state: 'unreadable', canEdit: false } }),
    ).toEqual({ face: 'unavailable' });
    expect(combineRoom(readyP, lockedKept)).toEqual({ face: 'locked', keptChoices: true });
    const ready = combineRoom(readyP, { state: 'answered', dto: runs({}, false) });
    expect(ready).toMatchObject({ face: 'ready', canEdit: false });
  });

  it('changedRows lists only differing rows, in the room order', () => {
    expect(
      changedRows(
        { guide: null, high: 'a', planning: null },
        { guide: 'x', high: 'a', planning: null },
      ),
    ).toEqual([{ id: 'guide', model: 'x' }]);
    expect(changedRows({ high: 'a', review: null }, { review: 'b', high: null })).toEqual([
      { id: 'review', model: 'b' },
      { id: 'high', model: null },
    ]);
  });

  it('runRow: only an org_* source is an organisation choice', () => {
    expect(runRow(rRow('review', { effectiveSource: 'org_review' })).isOrg).toBe(true);
    expect(runRow(rRow('review', { effectiveSource: 'platform_review' })).isOrg).toBe(false);
    expect(runRow(rRow('review', { effectiveSource: null })).isOrg).toBe(false);
  });
});
