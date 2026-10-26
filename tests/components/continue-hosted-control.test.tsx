// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import {
  HostedModelsProvider,
  useHostedModels,
  type HostedModelsValue,
} from '@/components/hosted/HostedModelsProvider';
import { ContinueHostedControl } from '@/components/hosted/ContinueHostedControl';

// CONTINUE HOSTED AS A PLACEABLE CONTROL (Story MOTIR-6590 · MOTIR-6879). The
// Workbench To fix tab draws one per dead-run row, so the model list is the PAGE's
// (one `HostedModelsProvider`, one read) and each press is the ROW's own.

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
const START_A = 'POST /api/work-items/ACME-12/hosted-runs';
const START_B = 'POST /api/work-items/ACME-30/hosted-runs';

beforeEach(() => {
  fetchMock.mockClear();
  routes = {
    [MODELS]: () => ({
      status: 200,
      body: {
        models: [
          { id: 'claude-sonnet-5', provider: 'anthropic' },
          { id: 'claude-opus-5', provider: 'anthropic' },
        ],
        default: 'claude-opus-5',
      },
    }),
    [START_A]: () => ({ status: 202, body: { runId: 'run_a' } }),
    [START_B]: () => ({ status: 202, body: { runId: 'run_b' } }),
  };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountTwo(
  props: {
    onStartedA?: () => void;
    onStateMovedA?: () => void;
    viewerId?: string | null;
  } = {},
  { zh = false }: { zh?: boolean } = {},
) {
  render(
    <HostedModelsProvider>
      <div data-testid="row-a">
        <ContinueHostedControl
          continueTarget="ACME-12"
          viewerId={props.viewerId ?? 'usr_me'}
          onStarted={props.onStartedA}
          onStateMoved={props.onStateMovedA}
          compact
        />
      </div>
      <div data-testid="row-b">
        {/* A leg of a parent run: the row sits on ACME-31, the press continues ACME-30. */}
        <ContinueHostedControl continueTarget="ACME-30" itemKey="ACME-31" />
      </div>
    </HostedModelsProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  await act(async () => {});
}

const row = (id: 'a' | 'b') => within(screen.getByTestId(`row-${id}`));
const press = async (id: 'a' | 'b') =>
  act(async () => {
    fireEvent.click(row(id).getByTestId('continue-hosted'));
  });

describe('one model list, many presses', () => {
  it('two controls under one provider read the models ONCE', async () => {
    await mountTwo();
    expect(calls(MODELS)).toHaveLength(1);
    expect(screen.getAllByTestId('continue-hosted')).toHaveLength(2);
  });

  it('each press posts its OWN target, mode continue, the chosen model and a fresh key', async () => {
    const onStartedA = vi.fn();
    await mountTwo({ onStartedA });
    await press('a');
    await press('b');
    await press('a');

    const a = calls(START_A).map(bodyOf);
    const b = calls(START_B).map(bodyOf);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(1);
    for (const body of [...a, ...b]) {
      expect(body.mode).toBe('continue');
      // The default model is preselected; the dead run's id is never sent.
      expect(body.model).toBe('claude-opus-5');
      expect(Object.keys(body).sort()).toEqual(['idempotencyKey', 'mode', 'model']);
    }
    const keys = [...a, ...b].map((body) => body.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(onStartedA).toHaveBeenCalledTimes(2);
  });

  it('names the parent on a row whose target is not the card it sits on', async () => {
    await mountTwo();
    expect(row('a').getByTestId('continue-hosted').textContent).toBe('Continue');
    expect(row('b').getByTestId('continue-hosted').textContent).toBe('Continue ACME-30');
  });

  it('a refusal is answered on its own row only', async () => {
    routes[START_A] = () => ({ status: 409, body: { code: 'hosted_continue_no_dead_run' } });
    await mountTwo();
    await press('a');
    expect(row('a').getByTestId('continue-hosted-refused-noDeadRun')).toBeTruthy();
    expect(row('b').queryByTestId('continue-hosted-refused-noDeadRun')).toBeNull();
  });
});

describe('each refusal in its shipped words', () => {
  it.each([
    [
      409,
      { code: 'hosted_continue_taken', holder: { id: 'usr_2', name: 'Bo' }, startedAt: null },
      'taken',
      'Not started — Bo is already continuing this work item',
      true,
    ],
    [
      409,
      {
        code: 'hosted_continue_taken',
        holder: { id: 'usr_me', name: 'Me' },
        startedAt: '2026-09-27T14:00:00.000Z',
      },
      'taken',
      'Not started — you are already continuing this work item',
      true,
    ],
    [
      409,
      { code: 'hosted_continue_run_alive', holder: { id: 'usr_2', name: 'Bo' } },
      'runAlive',
      "Not started — Bo's run is still reporting",
      true,
    ],
    [
      409,
      { code: 'hosted_continue_nothing_pushed' },
      'nothingPushed',
      'the run pushed nothing to continue from',
      true,
    ],
    [409, { code: 'hosted_continue_use_fix' }, 'useFix', 'the pull request is open', true],
    [
      409,
      { code: 'hosted_continue_the_parent', parentKey: 'ACME-1' },
      'theParent',
      "this is part of ACME-1's run",
      true,
    ],
    [
      402,
      { code: 'hosted_run_out_of_credits' },
      'outOfCredits',
      'Not started — your organization is out of credits.',
      false,
    ],
    [
      503,
      { code: 'hosted_runs_unavailable' },
      'unavailable',
      'Not started — Run isn’t available right now.',
      false,
    ],
    [
      502,
      { code: 'hosted_run_boot_failed' },
      'bootFailed',
      'The run couldn’t start its machine.',
      true,
    ],
  ] as const)('%i %j → %s', async (status, body, kind, copy, moved) => {
    const onStateMovedA = vi.fn();
    routes[START_A] = () => ({ status, body });
    await mountTwo({ onStateMovedA });
    await press('a');
    expect(row('a').getByTestId(`continue-hosted-refused-${kind}`).textContent).toContain(copy);
    // A stale-page answer asks the surface to re-read the card; a transient one does not.
    expect(onStateMovedA).toHaveBeenCalledTimes(moved ? 1 : 0);
  });

  it('a model withdrawn since the page loaded: says so and re-reads the ONE list', async () => {
    routes[START_A] = () => ({ status: 409, body: { code: 'hosted_model_not_offered' } });
    await mountTwo();
    await press('a');
    expect(row('a').getByTestId('continue-hosted-refused-modelNotOffered').textContent).toContain(
      'claude-opus-5 is no longer offered.',
    );
    await act(async () => {});
    expect(calls(MODELS)).toHaveLength(2);
  });

  it('not writable lists every repository with a way to fix it', async () => {
    routes[START_A] = () => ({
      status: 409,
      body: {
        code: 'hosted_repository_not_writable',
        repositories: [
          { repository: 'acme/web', reason: 'The app is suspended.', fix: 'x', fixUrl: null },
        ],
        totalRepositories: 2,
      },
    });
    await mountTwo();
    await press('a');
    const notice = row('a').getByTestId('continue-hosted-refused-notWritable');
    expect(notice.textContent).toContain(
      'Not started — Motir’s app can’t write to 1 of this run’s 2 repositories.',
    );
    expect(notice.textContent).toContain('acme/web');
  });

  it('a network failure is `failed`, and the control is usable again', async () => {
    routes[START_A] = () => {
      throw new Error('offline');
    };
    await mountTwo();
    await press('a');
    expect(row('a').getByTestId('continue-hosted-refused-failed')).toBeTruthy();
    expect((row('a').getByTestId('continue-hosted') as HTMLButtonElement).disabled).toBe(false);
  });

  it('draws in zh too', async () => {
    routes[START_A] = () => ({ status: 409, body: { code: 'hosted_continue_no_dead_run' } });
    await mountTwo({}, { zh: true });
    expect(row('a').getByTestId('continue-hosted').textContent).toBe('继续');
    await press('a');
    expect(row('a').getByTestId('continue-hosted-refused-noDeadRun').textContent).toContain(
      '未启动——此工作项没有中断的运行。',
    );
  });
});

describe('the model list’s other faces', () => {
  it('unavailable: every control says so, and Try again re-reads once', async () => {
    routes[MODELS] = () => ({ status: 503, body: null });
    await mountTwo();
    const notices = screen.getAllByTestId('continue-hosted-models-unavailable');
    expect(notices).toHaveLength(2);
    expect((row('a').getByTestId('continue-hosted') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(within(notices[0]!).getByRole('button'));
    });
    expect(calls(MODELS)).toHaveLength(2);
  });

  it('empty: says so, with nothing to press', async () => {
    routes[MODELS] = () => ({ status: 200, body: { models: [], default: null } });
    await mountTwo();
    expect(screen.getAllByTestId('continue-hosted-models-empty')).toHaveLength(2);
    await press('a');
    expect(calls(START_A)).toHaveLength(0);
  });

  it('with no provider mounted the control draws nothing and a press posts nothing', async () => {
    render(<ContinueHostedControl continueTarget="ACME-12" />);
    await act(async () => {});
    expect(screen.queryByTestId('continue-hosted')).toBeNull();
    expect(calls(MODELS)).toHaveLength(0);
  });
});

describe('the chosen model', () => {
  let hosted: HostedModelsValue | null = null;
  function Probe() {
    hosted = useHostedModels();
    return null;
  }

  it('a pick is what every press sends, and survives a re-read that still offers it', async () => {
    render(
      <HostedModelsProvider>
        <Probe />
        <ContinueHostedControl continueTarget="ACME-12" />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    await act(async () => hosted!.setChosen('claude-sonnet-5'));
    await act(async () => hosted!.reloadModels());
    expect(hosted!.chosen).toBe('claude-sonnet-5');
    await act(async () => {
      fireEvent.click(screen.getByTestId('continue-hosted'));
    });
    expect(calls(START_A).map(bodyOf)[0]!.model).toBe('claude-sonnet-5');
  });

  it('a pick the new list drops falls back to the preselection', async () => {
    render(
      <HostedModelsProvider>
        <Probe />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    await act(async () => hosted!.setChosen('claude-sonnet-5'));
    routes[MODELS] = () => ({
      status: 200,
      body: { models: [{ id: 'claude-opus-5', provider: 'anthropic' }], default: null },
    });
    await act(async () => hosted!.reloadModels());
    expect(hosted!.chosen).toBeNull();
    expect(hosted!.selectedModel).toBe('claude-opus-5');
  });

  it('an older read that resolves after a newer one does not win', async () => {
    render(
      <HostedModelsProvider>
        <Probe />
      </HostedModelsProvider>,
    );
    await act(async () => {});
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const slow = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      n += 1;
      if (n === 1) {
        await gate;
        return new Response(JSON.stringify({ models: [], default: null }), { status: 200 });
      }
      return slow(input, init);
    });
    await act(async () => {
      hosted!.reloadModels();
      hosted!.reloadModels();
    });
    release();
    await act(async () => {});
    expect(hosted!.models).toMatchObject({ state: 'ok' });
    expect(hosted!.models.state === 'ok' && hosted!.models.models).toHaveLength(2);
  });
});

// A MODEL WITH NO AGENT-RUN CAPACITY at the Continue hosted door (Story MOTIR-9541 ·
// MOTIR-9630; `design/runs/run-section--no-capacity.mock.html` Panel N7): the same
// hold as Run (the model stays, the button is off, the Held Run line), and the same
// No-capacity refusal, which keeps the door and quietly re-reads the list.
describe('no agent-run capacity (N7)', () => {
  const capacityList = (heldDefault: boolean) => ({
    status: 200,
    body: {
      models: [
        { id: 'claude-sonnet-5', provider: 'anthropic', capacity: { verdict: 'available' } },
        {
          id: 'claude-opus-5',
          provider: 'anthropic',
          capacity: heldDefault
            ? { verdict: 'no_capacity', reason: 'agent_share_exhausted' }
            : { verdict: 'available' },
        },
      ],
      default: 'claude-opus-5',
    },
  });

  it('a held preselected model holds Continue with the Held Run line', async () => {
    routes[MODELS] = () => capacityList(true);
    await mountTwo();
    const button = row('a').getByTestId('continue-hosted') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const line = row('a').getByTestId('hosted-held-line');
    expect(line.textContent).toContain('claude-opus-5 has no agent-run capacity right now.');
    expect(button.getAttribute('aria-describedby')).toBe(line.id);
  });

  it('a refused continue names the model, stays drawn, and re-reads the list once', async () => {
    const onStateMovedA = vi.fn();
    routes[START_A] = () => ({
      status: 409,
      body: { code: 'hosted_run_no_capacity', model: 'claude-opus-5', reason: 'x' },
    });
    await mountTwo({ onStateMovedA });
    routes[MODELS] = () => capacityList(true);
    await press('a');
    await act(async () => {});
    const notice = row('a').getByTestId('continue-hosted-refused-noCapacity');
    expect(notice.textContent).toContain(
      'Not started — claude-opus-5 has no agent-run capacity right now.',
    );
    expect(onStateMovedA).not.toHaveBeenCalled();
    expect(row('a').getByTestId('continue-hosted-door')).toBeTruthy();
    expect(calls(MODELS)).toHaveLength(2);
    // The refusal names the model, so the line under the button gives way to it.
    expect(row('a').queryByTestId('hosted-held-line')).toBeNull();
    expect((row('a').getByTestId('continue-hosted') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reads in zh', async () => {
    routes[START_A] = () => ({
      status: 409,
      body: { code: 'hosted_run_no_capacity', model: 'claude-opus-5', reason: 'x' },
    });
    await mountTwo({}, { zh: true });
    await press('a');
    await act(async () => {});
    expect(row('a').getByTestId('continue-hosted-refused-noCapacity').textContent).toContain(
      zhMessages.runs.hosted.refused.noCapacity.title.replace('{model}', 'claude-opus-5'),
    );
  });
});
