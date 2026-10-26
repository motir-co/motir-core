// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { HostedRunProvider } from '@/app/(authed)/items/[key]/_components/HostedRunProvider';
import { RunDoorControl } from '@/app/(authed)/items/[key]/_components/RunHostedButton';
import {
  HostedModelsProvider,
  useHostedModels,
  type HostedModelsValue,
} from '@/components/hosted/HostedModelsProvider';
import { ContinueHostedControl } from '@/components/hosted/ContinueHostedControl';
import {
  preselectedModel,
  provenanceFor,
  readModels,
  withoutResolution,
  type HostedModelsState,
  type HostedResolvedModel,
} from '@/components/hosted/hostedModels';

// RUN HOSTED PRESELECTS THE DIFFICULTY'S MODEL (Story MOTIR-6989 · MOTIR-6996;
// `design/runs/run-section--from-difficulty.mock.html`, Panels F1–F6). The door
// reads its card's resolved model with the list, opens on it, and says why in a
// line under the picker; the line goes when the person picks another model, and
// Continue hosted keeps the preselect it always had.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

type Handler = (init?: RequestInit) => { status: number; body: unknown };
let routes: Record<string, Handler> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
  const handler = routes[key];
  if (!handler) return new Response(null, { status: 500 });
  const { status, body } = handler(init);
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
});
const calls = (key: string) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input).split('?')[0]}` === key,
  );
const bodyOf = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

const MODELS = 'GET /api/hosted-runs/models';
const START = 'POST /api/work-items/PROD-42/hosted-runs';
const LIST = [
  { id: 'claude-sonnet-5-5', provider: 'anthropic' },
  { id: 'claude-opus-5-5', provider: 'anthropic' },
  { id: 'claude-opus-5', provider: 'anthropic' },
  { id: 'claude-fable-5-1', provider: 'anthropic' },
];
const DEFAULT = 'claude-opus-5-5';

function resolved(over: Partial<HostedResolvedModel> = {}): HostedResolvedModel {
  return {
    model: 'claude-opus-5-5',
    source: 'platform_level',
    difficulty: 'high',
    fromLeaves: false,
    ...over,
  };
}

function serve(r: HostedResolvedModel | null | undefined) {
  routes[MODELS] = () => ({
    status: 200,
    body: { models: LIST, default: DEFAULT, ...(r === undefined ? {} : { resolved: r }) },
  });
}

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockClear();
  routes = { [START]: () => ({ status: 201, body: { dispatchRunId: 'run_1' } }) };
  serve(resolved());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountDoor({ zh = false }: { zh?: boolean } = {}) {
  render(
    <HostedRunProvider itemKey="PROD-42" ready openBlockers={0}>
      <RunDoorControl />
    </HostedRunProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  await act(async () => {});
}

const trigger = () => screen.getByRole('combobox', { name: 'Model' });
const line = () => screen.queryByTestId('hosted-model-provenance');

async function pick(id: string) {
  await act(async () => {
    fireEvent.click(trigger());
  });
  // Match the label exactly: `claude-opus-5` must not find `claude-opus-5-5`.
  const option = screen
    .getAllByRole('option')
    .find((o) => o.textContent?.startsWith(id) && !o.textContent.startsWith(`${id}-`));
  await act(async () => {
    fireEvent.click(option!);
  });
}

describe('the read', () => {
  it("asks for the page's card, once", async () => {
    await mountDoor();
    expect(calls(MODELS)).toHaveLength(1);
    expect(String(calls(MODELS)[0]![0])).toBe('/api/hosted-runs/models?workItem=PROD-42');
  });

  it('a surface of many cards (no key) reads the list alone', async () => {
    render(
      <HostedModelsProvider>
        <ContinueHostedControl continueTarget="PROD-42" />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    expect(String(calls(MODELS)[0]![0])).toBe('/api/hosted-runs/models');
  });
});

describe('the door opens on the resolved model and says why', () => {
  it('F1 — a High leaf on the platform model that is also the default: both the Default label and the line', async () => {
    await mountDoor();
    expect(trigger().textContent).toContain('claude-opus-5-5');
    expect(trigger().textContent).toContain('Default');
    expect(line()!.textContent).toBe('From difficulty: High');
    expect(within(line()!).getByText('High').tagName).toBe('B');
    // The trigger is described by the line.
    expect(trigger().getAttribute('aria-describedby')).toBe(line()!.id);
  });

  it('F2 — a High leaf the project overrode: that model, and "Project override for High"', async () => {
    serve(resolved({ model: 'claude-fable-5-1', source: 'override' }));
    await mountDoor();
    expect(trigger().textContent).toContain('claude-fable-5-1');
    expect(trigger().textContent).not.toContain('Default');
    expect(line()!.textContent).toBe('Project override for High');
  });

  it('a Low leaf with no override: the platform Low model, "From difficulty: Low"', async () => {
    serve(resolved({ model: 'claude-sonnet-5-5', difficulty: 'low' }));
    await mountDoor();
    expect(trigger().textContent).toContain('claude-sonnet-5-5');
    expect(line()!.textContent).toBe('From difficulty: Low');
  });

  it('F3 — a parent: "Highest difficulty among its leaves: High"', async () => {
    serve(resolved({ fromLeaves: true }));
    await mountDoor();
    expect(line()!.textContent).toBe('Highest difficulty among its leaves: High');
  });

  it('a parent AND an override: the stated wording', async () => {
    serve(resolved({ model: 'claude-opus-5', source: 'override', fromLeaves: true }));
    await mountDoor();
    expect(trigger().textContent).toContain('claude-opus-5');
    expect(line()!.textContent).toBe(
      'Project override for High, the highest difficulty among its leaves',
    );
  });

  it('F4 — a leaf with no difficulty: the default, today’s picker, no line', async () => {
    serve(resolved({ difficulty: null, source: 'platform_default' }));
    await mountDoor();
    expect(trigger().textContent).toContain(DEFAULT);
    expect(trigger().textContent).toContain('Default');
    expect(line()).toBeNull();
    expect(trigger().hasAttribute('aria-describedby')).toBe(false);
  });

  it('a resolve failure (resolved: null) degrades to the default with no line', async () => {
    serve(null);
    await mountDoor();
    expect(trigger().textContent).toContain(DEFAULT);
    expect(line()).toBeNull();
  });

  it('F5 — the open menu carries the line as the preselected option’s description only', async () => {
    serve(resolved({ model: 'claude-fable-5-1', source: 'override' }));
    await mountDoor();
    await act(async () => {
      fireEvent.click(trigger());
    });
    const options = screen.getAllByRole('option');
    const fable = options.find((o) => o.textContent?.startsWith('claude-fable-5-1'))!;
    expect(fable.textContent).toContain('Project override for High');
    for (const o of options.filter((x) => x !== fable)) {
      expect(o.textContent).not.toContain('Project override');
    }
  });

  it('reads in zh', async () => {
    serve(resolved({ difficulty: 'low', model: 'claude-sonnet-5-5' }));
    await mountDoor({ zh: true });
    expect(screen.getByTestId('hosted-model-provenance').textContent).toBe('按难度：低');
  });
});

describe('the person’s own pick', () => {
  it('F6 — picking another model removes the line; re-picking the resolved one brings it back', async () => {
    await mountDoor();
    await pick('claude-opus-5');
    expect(trigger().textContent).toContain('claude-opus-5');
    expect(trigger().textContent).not.toContain('claude-opus-5-5');
    expect(line()).toBeNull();
    expect(trigger().hasAttribute('aria-describedby')).toBe(false);
    await pick('claude-opus-5-5');
    expect(line()!.textContent).toBe('From difficulty: High');
  });

  it('the start POST carries the model the person chose', async () => {
    await mountDoor();
    await pick('claude-fable-5-1');
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-hosted'));
    });
    expect(calls(START).map(bodyOf)[0]).toEqual({ model: 'claude-fable-5-1' });
  });

  it('untouched, the start POST carries the resolved model', async () => {
    serve(resolved({ model: 'claude-fable-5-1', source: 'override' }));
    await mountDoor();
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-hosted'));
    });
    expect(calls(START).map(bodyOf)[0]).toEqual({ model: 'claude-fable-5-1' });
  });
});

describe('the provider — late reads never reset a pick', () => {
  let hosted: HostedModelsValue | null = null;
  function Probe() {
    hosted = useHostedModels();
    return null;
  }

  it('a re-read that lands after a pick keeps the pick, even with a different resolution', async () => {
    render(
      <HostedModelsProvider workItemKey="PROD-42">
        <Probe />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    expect(hosted!.selectedModel).toBe('claude-opus-5-5');
    await act(async () => hosted!.setChosen('claude-sonnet-5-5'));
    serve(resolved({ model: 'claude-fable-5-1', source: 'override' }));
    await act(async () => hosted!.reloadModels());
    expect(hosted!.chosen).toBe('claude-sonnet-5-5');
    expect(hosted!.selectedModel).toBe('claude-sonnet-5-5');
  });

  it('an older read resolving after a newer one does not win (the seq guard)', async () => {
    render(
      <HostedModelsProvider workItemKey="PROD-42">
        <Probe />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    // Read #2 is held; read #3 answers first with a different resolution.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const answer = fetchMock.getMockImplementation()!;
    let n = 0;
    fetchMock.mockImplementation(async (input, init) => {
      n += 1;
      if (n === 1) {
        await held;
        return new Response(
          JSON.stringify({ models: LIST, default: DEFAULT, resolved: resolved() }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return answer(input, init);
    });
    serve(resolved({ model: 'claude-fable-5-1', source: 'override' }));
    await act(async () => {
      hosted!.reloadModels();
      hosted!.reloadModels();
    });
    expect(hosted!.selectedModel).toBe('claude-fable-5-1');
    await act(async () => release());
    expect(hosted!.selectedModel).toBe('claude-fable-5-1');
    fetchMock.mockImplementation(answer);
  });

  it('Continue hosted keeps its old preselect — the default — beside a resolved Run hosted', async () => {
    serve(resolved({ model: 'claude-fable-5-1', source: 'override' }));
    render(
      <HostedModelsProvider workItemKey="PROD-42">
        <Probe />
        <ContinueHostedControl continueTarget="PROD-42" />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    expect(hosted!.selectedModel).toBe('claude-fable-5-1');
    expect(hosted!.continueModel).toBe(DEFAULT);
    const row = screen.getByTestId('continue-hosted-door');
    expect(within(row).getByRole('combobox').textContent).toContain(DEFAULT);
    expect(screen.queryByTestId('hosted-model-provenance')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('continue-hosted'));
    });
    expect(calls(START).map(bodyOf)[0]).toMatchObject({ model: DEFAULT, mode: 'continue' });
  });
});

describe('preselectedModel — total', () => {
  const ok = (over: Partial<Extract<HostedModelsState, { state: 'ok' }>> = {}) =>
    ({ state: 'ok', models: LIST, default: DEFAULT, ...over }) as HostedModelsState;

  it('prefers the resolved model when it is offered', () => {
    expect(preselectedModel(ok({ resolved: resolved({ model: 'claude-fable-5-1' }) }))).toBe(
      'claude-fable-5-1',
    );
  });
  it('falls to the default when the resolved model is not offered, or there is none', () => {
    expect(preselectedModel(ok({ resolved: resolved({ model: 'claude-gone' }) }))).toBe(DEFAULT);
    expect(preselectedModel(ok({ resolved: null }))).toBe(DEFAULT);
    expect(preselectedModel(ok())).toBe(DEFAULT);
  });
  it('falls to the first offered when neither is offered', () => {
    expect(
      preselectedModel(ok({ default: 'claude-gone', resolved: resolved({ model: 'x' }) })),
    ).toBe('claude-sonnet-5-5');
    expect(preselectedModel(ok({ default: null }))).toBe('claude-sonnet-5-5');
  });
  it('answers null with nothing to pick', () => {
    expect(preselectedModel({ state: 'loading' })).toBeNull();
    expect(preselectedModel({ state: 'unavailable' })).toBeNull();
    expect(preselectedModel(ok({ models: [], resolved: resolved() }))).toBeNull();
  });
  it('withoutResolution drops the card’s resolution and leaves other states alone', () => {
    const state = ok({ resolved: resolved({ model: 'claude-fable-5-1' }) });
    expect(preselectedModel(withoutResolution(state))).toBe(DEFAULT);
    expect(withoutResolution({ state: 'loading' })).toEqual({ state: 'loading' });
  });
});

describe('provenanceFor', () => {
  const ok = (r: HostedResolvedModel | null) =>
    ({ state: 'ok', models: LIST, default: DEFAULT, resolved: r }) as HostedModelsState;

  it('describes the value only while it is the resolved model', () => {
    const r = resolved();
    expect(provenanceFor(ok(r), 'claude-opus-5-5')).toBe(r);
    expect(provenanceFor(ok(r), 'claude-opus-5')).toBeNull();
    expect(provenanceFor(ok(r), null)).toBeNull();
  });
  it('draws no line for a source that is not about difficulty, or no difficulty', () => {
    expect(provenanceFor(ok(resolved({ source: 'platform_default' })), DEFAULT)).toBeNull();
    expect(provenanceFor(ok(resolved({ source: 'first_offered' })), DEFAULT)).toBeNull();
    expect(provenanceFor(ok(resolved({ difficulty: null })), DEFAULT)).toBeNull();
  });
  it('draws no line without a resolution, a list, or an offered model', () => {
    expect(provenanceFor(ok(null), DEFAULT)).toBeNull();
    expect(provenanceFor({ state: 'loading' }, DEFAULT)).toBeNull();
    expect(provenanceFor(ok(resolved({ model: 'claude-gone' })), 'claude-gone')).toBeNull();
  });
});

describe('readModels — the wire', () => {
  it('parses a resolution, and a malformed one as null', async () => {
    serve(resolved({ fromLeaves: true }));
    expect(await readModels('PROD-42')).toEqual({
      state: 'ok',
      // A wire model with no `capacity` reads available (MOTIR-9630).
      models: LIST.map((m) => ({ ...m, capacity: { verdict: 'available' } })),
      default: DEFAULT,
      resolved: resolved({ fromLeaves: true }),
    });
    routes[MODELS] = () => ({
      status: 200,
      body: { models: LIST, default: DEFAULT, resolved: { model: 7, source: 'override' } },
    });
    expect(await readModels('PROD-42')).toMatchObject({ resolved: null });
    routes[MODELS] = () => ({
      status: 200,
      body: { models: LIST, default: DEFAULT, resolved: { model: 'x', source: 'guess' } },
    });
    expect(await readModels('PROD-42')).toMatchObject({ resolved: null });
    routes[MODELS] = () => ({
      status: 200,
      body: {
        models: LIST,
        default: DEFAULT,
        resolved: { model: 'x', source: 'override', difficulty: 'extreme' },
      },
    });
    expect(await readModels('PROD-42')).toMatchObject({
      resolved: { model: 'x', difficulty: null, fromLeaves: false },
    });
  });

  it('an absent resolution reads as null, and the key is URL-encoded', async () => {
    serve(undefined);
    expect(await readModels('A B-1')).toMatchObject({ resolved: null });
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
      '/api/hosted-runs/models?workItem=A%20B-1',
    );
  });
});
