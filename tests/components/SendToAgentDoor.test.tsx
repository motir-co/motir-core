// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { HostedRunProvider } from '@/app/(authed)/items/[key]/_components/HostedRunProvider';
import { RunHostedButton } from '@/app/(authed)/items/[key]/_components/RunHostedButton';
import { RunSection } from '@/app/(authed)/items/[key]/_components/RunSection';
import { agentSendRefusalOf } from '@/app/(authed)/items/[key]/_components/useAgentSend';
import type { AgentForCardDto } from '@/lib/dto/agentInstanceRuns';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';

// SEND TO MY AGENT (Story MOTIR-6864 · MOTIR-7028; design MOTIR-7022 revision 2,
// `design/runs/run-section--agent.mock.html` panels 0–7) — the start bar's second
// option on the item page's Run section: the picker lists exactly what the agents
// read answers, one press is ONE POST and the section moves to the new run, each
// refusal renders its own words and opens no run, the empty face links to My
// agents, a card that is not ready disables both options, and a live run of either
// lane leaves neither option to press. Mounted the way the late stack mounts it:
// one provider around the header slot and the section body.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

type Handler = (init?: RequestInit) => { status: number; body: unknown };
let routes: Record<string, Handler> = {};
let offline = false;
let hold: Promise<void> | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
  if (offline && key === START) throw new TypeError('network down');
  if (hold && key === START) await hold;
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

const MODELS = 'GET /api/hosted-runs/models';
const AGENTS = 'GET /api/work-items/PROD-42/agent-runs/agents';
const START = 'POST /api/work-items/PROD-42/agent-runs';
const HISTORY = 'GET /api/work-items/PROD-42/dispatch-runs';

function agent(over: Partial<AgentForCardDto> = {}): AgentForCardDto {
  return {
    id: 'ai_1',
    name: 'yue-claude',
    profileId: 'claude',
    profileName: 'Claude Code',
    state: 'running',
    runLauncher: 'present',
    signInState: 'signed_in',
    signInCheckedAt: '2026-09-30T08:00:00.000Z',
    runningRun: null,
    refusal: null,
    ...over,
  };
}

function run(over: Partial<DispatchRunDto> = {}): DispatchRunDto {
  return {
    id: 'run_1',
    projectId: 'prj_1',
    command: 'run',
    origin: 'local',
    scopeWorkItemId: null,
    scopeLabel: null,
    status: 'succeeded',
    stopReason: 'completed',
    lastHeartbeatAt: null,
    reportedBy: 'cli',
    agentInstance: null,
    agent: 'claude',
    model: 'claude-opus-5',
    startedAt: '2026-09-26T14:02:11.000Z',
    endedAt: '2026-09-26T14:23:11.000Z',
    createdById: 'usr_me',
    seq: 4,
    cards: [
      {
        id: 'leg_1',
        key: 'PROD-42',
        workItemId: 'itm_1',
        position: 0,
        disposition: 'implemented',
        skipReason: null,
        sessionBranch: null,
        startedAt: '2026-09-26T14:02:11.000Z',
        endedAt: '2026-09-26T14:23:11.000Z',
        exitCode: 0,
        model: null,
      },
    ],
    ...over,
  };
}

const AGENT_INSTANCE = {
  id: 'ai_2',
  name: 'yue-sleepy',
  profile: 'claude',
  profileLabel: 'Claude Code',
};

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockClear();
  offline = false;
  hold = null;
  routes = {
    [MODELS]: () => ({
      status: 200,
      body: {
        models: [{ id: 'claude-sonnet-5', provider: 'anthropic' }],
        default: 'claude-sonnet-5',
      },
    }),
    [AGENTS]: () => ({
      status: 200,
      body: {
        agents: [agent(), agent({ id: 'ai_2', name: 'yue-sleepy', state: 'hibernated' })],
      },
    }),
  };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount({
  ready = true,
  openBlockers = 0,
  runs = [],
  agents = { projectName: 'Motir' },
  zh = false,
}: {
  ready?: boolean;
  openBlockers?: number;
  runs?: DispatchRunDto[];
  agents?: { projectName: string } | null;
  zh?: boolean;
} = {}) {
  render(
    <HostedRunProvider
      itemKey="PROD-42"
      ready={ready}
      openBlockers={openBlockers}
      viewerId="usr_me"
      agents={agents}
    >
      <RunHostedButton />
      <RunSection
        initialRuns={runs}
        initialCursor={null}
        itemKey="PROD-42"
        formattedTimes={Object.fromEntries(runs.map((r) => [r.id, '26 Sep']))}
      />
    </HostedRunProvider>,
    zh ? { locale: 'zh', messages: zhMessages } : {},
  );
  await act(async () => {});
}

async function openPicker() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('send-to-agent'));
  });
  await waitFor(() => expect(screen.queryByTestId('send-to-agent-loading')).toBeNull());
  return screen.getByTestId('send-to-agent-picker');
}

const row = (name: string) =>
  screen.getAllByTestId('send-to-agent-row').find((r) => r.getAttribute('data-agent') === name)!;

/** Press a row whose press the server refuses with `status` + `body`. */
async function refusedWith(status: number, body: Record<string, unknown>, name = 'yue-claude') {
  routes[START] = () => ({ status, body });
  await mount();
  await openPicker();
  await act(async () => {
    fireEvent.click(row(name));
  });
}

describe('the start bar on a ready card', () => {
  it('draws the two ways to start — Run and Send to my agent — with no "hosted" anywhere', async () => {
    await mount();
    const bar = screen.getByTestId('start-bar');
    expect(bar.textContent).toContain('Start this work item');
    expect(bar.textContent).toContain('Run');
    expect(screen.getByTestId('start-send').textContent).toContain(
      'One of your own agents works it',
    );
    expect(screen.getByTestId('send-to-agent').textContent).toBe('Send to my agent');
    expect(screen.getByTestId('run-hosted').textContent).toBe('Run');
    expect(bar.textContent?.toLowerCase()).not.toContain('hosted');
  });

  it('without the right to use agents, only Run shows', async () => {
    await mount({ agents: null });
    expect(screen.getByTestId('run-hosted')).toBeTruthy();
    expect(screen.queryByTestId('send-to-agent')).toBeNull();
  });

  it('every string it draws exists in Chinese too', async () => {
    await mount({ zh: true });
    const bar = screen.getByTestId('start-bar');
    expect(bar.textContent).not.toContain('Start this work item');
    expect(bar.textContent).not.toContain('Send to my agent');
  });
});

describe('the picker', () => {
  it('lists exactly the agents the read returns, the free first one active, and its footer', async () => {
    await mount();
    const picker = await openPicker();
    expect(calls(AGENTS)).toHaveLength(1);
    const rows = screen.getAllByTestId('send-to-agent-row');
    expect(rows.map((r) => r.getAttribute('data-agent'))).toEqual(['yue-claude', 'yue-sleepy']);
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    expect(rows[0]!.textContent).toContain('starts now');
    expect(rows[1]!.textContent).toContain('wakes first');
    expect(picker.textContent).toContain('Send PROD-42 to one of your agents');
    expect(picker.textContent).toContain('Only your agents on Motir are listed.');
    expect(within(picker).getByText('Manage in My agents').getAttribute('href')).toBe('/my-agents');
  });

  it('reads the list afresh on every opening', async () => {
    await mount();
    await openPicker();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    });
    await openPicker();
    expect(calls(AGENTS)).toHaveLength(2);
  });

  it('a failed read says so and Try again reads it once more', async () => {
    routes[AGENTS] = () => ({ status: 500, body: {} });
    await mount();
    await openPicker();
    expect(screen.getByTestId('send-to-agent-failed').textContent).toContain(
      'Couldn’t load your agents.',
    );
    routes[AGENTS] = () => ({ status: 200, body: { agents: [agent()] } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await waitFor(() => expect(screen.getAllByTestId('send-to-agent-row')).toHaveLength(1));
  });

  it('a read that never answers is a failed read too', async () => {
    routes[AGENTS] = () => {
      throw new TypeError('network down');
    };
    await mount();
    await openPicker();
    expect(screen.getByTestId('send-to-agent-failed')).toBeTruthy();
  });

  it('with no agent on the project it shows the empty face, linking to My agents', async () => {
    routes[AGENTS] = () => ({ status: 200, body: { agents: [] } });
    await mount();
    await openPicker();
    const empty = screen.getByTestId('send-to-agent-empty');
    expect(empty.textContent).toContain('You have no agent on Motir yet.');
    expect(screen.getByTestId('send-to-agent-create').getAttribute('href')).toBe('/my-agents');
    expect(screen.queryByTestId('send-to-agent-row')).toBeNull();
  });

  it('the busy row names the work item its agent is on, links it and its run, and cannot be pressed', async () => {
    routes[AGENTS] = () => ({
      status: 200,
      body: {
        agents: [
          agent({
            refusal: 'agent_instance_run_active',
            runningRun: { id: 'run_busy', workItemKey: 'PROD-7', workItemTitle: 'Fix the export' },
          }),
          agent({
            id: 'ai_3',
            name: 'yue-other',
            refusal: 'agent_instance_run_active',
            runningRun: { id: 'run_b2', workItemKey: 'PROD-8', workItemTitle: null },
          }),
          agent({
            id: 'ai_4',
            name: 'yue-third',
            refusal: 'agent_instance_run_active',
            runningRun: null,
          }),
        ],
      },
    });
    routes[START] = () => ({ status: 201, body: { dispatchRunId: 'x' } });
    await mount();
    await openPicker();
    const busy = row('yue-claude');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.textContent).toContain('Working');
    const line = within(busy).getByTestId('send-to-agent-busy');
    expect(line.textContent).toContain('Working on PROD-7 · Fix the export.');
    expect(within(line).getByText('PROD-7').getAttribute('href')).toBe(
      '/items/PROD-42'.replace('PROD-42', 'PROD-7'),
    );
    expect(within(line).getByText('Open that run').getAttribute('href')).toBe('/runs?run=run_busy');
    expect(within(row('yue-other')).getByTestId('send-to-agent-busy').textContent).toContain(
      'Working on PROD-8. It can take',
    );
    expect(within(row('yue-third')).getByTestId('send-to-agent-busy').textContent).toContain(
      'Working on another work item.',
    );
    await act(async () => {
      fireEvent.click(busy);
    });
    expect(calls(START)).toHaveLength(0);
  });

  it('every other reason a row cannot take the work is said on the row', async () => {
    routes[AGENTS] = () => ({
      status: 200,
      body: {
        agents: [
          agent({
            id: 'a1',
            name: 'signed-out',
            signInState: 'signed_out',
            refusal: 'agent_not_signed_in',
          }),
          agent({ id: 'a2', name: 'old', refusal: 'agent_instance_image_too_old' }),
          agent({
            id: 'a3',
            name: 'shelly',
            profileId: 'shell',
            profileName: 'Shell',
            signInState: 'unknown',
            refusal: 'agent_profile_cannot_run',
          }),
          agent({
            id: 'a4',
            name: 'stopping',
            state: 'hibernating',
            refusal: 'agent_instance_state_conflict',
          }),
          agent({
            id: 'a5',
            name: 'going',
            state: 'deleting',
            refusal: 'agent_instance_state_conflict',
          }),
          agent({ id: 'a6', name: 'waking', state: 'waking' }),
          agent({ id: 'a7', name: 'broken', state: 'failed' }),
          agent({
            id: 'a8',
            name: 'codexy',
            profileId: 'codex',
            profileName: 'Codex',
            signInState: 'signed_out',
            refusal: 'agent_not_signed_in',
          }),
          agent({
            id: 'a9',
            name: 'custom',
            profileId: 'somethingelse',
            profileName: 'Something',
            signInState: 'signed_out',
            refusal: 'agent_not_signed_in',
          }),
        ],
      },
    });
    await mount();
    await openPicker();
    const why = (name: string) => within(row(name)).getByTestId('send-to-agent-why').textContent;
    expect(why('signed-out')).toContain(
      'Sign in first: open signed-out and run claude, then /login,',
    );
    expect(within(row('signed-out')).getByText('Open signed-out').getAttribute('href')).toBe(
      '/my-agents?agent=a1',
    );
    expect(row('signed-out').textContent).toContain('Not signed in');
    expect(why('codexy')).toContain('run codex login --device-auth in its terminal');
    expect(why('custom')).toContain('run its sign-in command in its terminal');
    expect(why('old')).toContain('Made from an older image');
    expect(why('shelly')).toContain('Shell can’t work on a work item on its own');
    expect(row('shelly').textContent).toContain('Sign-in can’t be checked');
    expect(why('stopping')).toContain('It’s stopping.');
    expect(why('going')).toBe('It’s being deleted.');
    expect(row('waking').textContent).toContain('starts when it’s up');
    expect(row('broken').textContent).toContain('wakes first — it failed last time');
    // The first FREE row is the active one; the others are pressable.
    expect(row('waking').getAttribute('aria-selected')).toBe('true');
    expect(row('broken').getAttribute('aria-disabled')).toBeNull();
  });

  it('an agent waiting for room is shown, cannot be pressed, and says why (MOTIR-9475)', async () => {
    routes[AGENTS] = () => ({
      status: 200,
      body: {
        agents: [
          agent({ id: 'w1', name: 'waiting-one', state: 'starting', waitingForRoom: true }),
          agent({ id: 'f1', name: 'free-one' }),
        ],
      },
    });
    await mount();
    await openPicker();
    expect(row('waiting-one').getAttribute('aria-disabled')).toBe('true');
    expect(row('waiting-one').textContent).toContain('Waiting');
    expect(within(row('waiting-one')).getByTestId('send-to-agent-why').textContent).toBe(
      'This agent can run work once it’s running. It’s waiting for room.',
    );
    expect(row('free-one').getAttribute('aria-selected')).toBe('true');
  });

  it('arrows move across the free rows only, and Enter sends the active one', async () => {
    routes[AGENTS] = () => ({
      status: 200,
      body: {
        agents: [
          agent(),
          agent({ id: 'ai_x', name: 'off', refusal: 'agent_instance_image_too_old' }),
          agent({ id: 'ai_2', name: 'yue-sleepy', state: 'hibernated' }),
        ],
      },
    });
    routes[START] = () => ({ status: 409, body: { code: 'agent_profile_cannot_run' } });
    await mount();
    await openPicker();
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe('agent-row-ai_2');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(list.getAttribute('aria-activedescendant')).toBe('agent-row-ai_1');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(list.getAttribute('aria-activedescendant')).toBe('agent-row-ai_2');
    fireEvent.keyDown(list, { key: 'Tab' });
    fireEvent.mouseEnter(row('off'));
    expect(list.getAttribute('aria-activedescendant')).toBe('agent-row-ai_2');
    await act(async () => {
      fireEvent.keyDown(list, { key: 'Enter' });
    });
    const [, init] = calls(START)[0]!;
    expect(JSON.parse(String(init?.body)).agentInstanceId).toBe('ai_2');
  });
});

describe('one press starts the run', () => {
  it('choosing a hibernated agent issues ONE POST, and the section moves to the new run — waking, then running — with no second click and no reload', async () => {
    routes[START] = () => ({
      status: 201,
      body: { dispatchRunId: 'run_new', created: true, woke: true },
    });
    const live = run({
      id: 'run_new',
      origin: 'instance',
      status: 'running',
      stopReason: null,
      endedAt: null,
      seq: 0,
      agent: 'claude',
      model: null,
      agentInstance: AGENT_INSTANCE,
    });
    routes[HISTORY] = () => ({ status: 200, body: { runs: [live], nextCursor: null } });
    routes['GET /api/dispatch-runs/run_new'] = () => ({
      status: 200,
      body: {
        ...live,
        cost: null,
        hostedEnd: { outcome: null, detail: null, exitCode: null },
        cards: live.cards.map((c) => ({ ...c, deliveries: [] })),
      },
    });
    await mount();
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-sleepy'));
    });
    expect(calls(START)).toHaveLength(1);
    const [, init] = calls(START)[0]!;
    const sent = JSON.parse(String(init?.body));
    expect(sent.agentInstanceId).toBe('ai_2');
    expect(typeof sent.idempotencyKey).toBe('string');
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId('agent-run')).toBeTruthy());
    expect(calls(HISTORY)).toHaveLength(1);
    const body = screen.getByTestId('agent-run');
    expect(body.getAttribute('data-status')).toBe('running');
    expect(body.textContent).toContain('Waking yue-sleepy');
    expect(body.textContent).toContain('Your agent is working on it');
    // A live run leaves neither way to start another one.
    expect(screen.queryByTestId('start-bar')).toBeNull();
    expect(screen.queryByTestId('run-hosted')).toBeNull();
    expect(screen.queryByTestId('send-to-agent')).toBeNull();
    // The owner holds Cancel run in the header.
    expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy();
    expect(calls(START)).toHaveLength(1);
  });

  it('a running agent reads Starting in, not Waking', async () => {
    routes[START] = () => ({
      status: 201,
      body: { dispatchRunId: 'run_new', created: true, woke: false },
    });
    const live = run({
      id: 'run_new',
      origin: 'instance',
      status: 'running',
      stopReason: null,
      endedAt: null,
      model: null,
      agentInstance: { ...AGENT_INSTANCE, id: 'ai_1', name: 'yue-claude' },
    });
    routes[HISTORY] = () => ({ status: 200, body: { runs: [live], nextCursor: null } });
    await mount();
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    await waitFor(() => expect(screen.getByTestId('agent-run')).toBeTruthy());
    expect(screen.getByTestId('agent-run').textContent).toContain('Starting in yue-claude');
  });

  it('while the send is in flight both options are off and the control reads Starting…', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    routes[START] = () => ({ status: 409, body: { code: 'agent_profile_cannot_run' } });
    await mount();
    await openPicker();
    act(() => {
      fireEvent.click(row('yue-claude'));
    });
    expect(screen.getByTestId('send-to-agent').textContent).toContain('Starting…');
    expect((screen.getByTestId('run-hosted') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.getByTestId('agent-refused-cannotRun')).toBeTruthy());
    expect(screen.getByTestId('send-to-agent').textContent).toContain('Send to my agent');
  });
});

describe('each refusal renders its own words, and the section shows no run', () => {
  const noRun = () => {
    expect(screen.queryByTestId('agent-run')).toBeNull();
    expect(calls(HISTORY)).toHaveLength(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('start-bar')).toBeTruthy();
  };
  const NOTHING = 'Nothing was started and nothing was charged.';

  it('agent_not_signed_in', async () => {
    await refusedWith(409, { code: 'agent_not_signed_in' });
    const n = screen.getByTestId('agent-refused-notSignedIn');
    expect(n.textContent).toContain('Not sent — Claude Code isn’t signed in on yue-claude.');
    expect(n.textContent).toContain(
      'Open yue-claude and run claude, then /login, in its terminal.',
    );
    expect(n.textContent).toContain(NOTHING);
    expect(within(n).getByText('Open yue-claude').getAttribute('href')).toBe(
      '/my-agents?agent=ai_1',
    );
    noRun();
  });

  it('agent_instance_wrong_project', async () => {
    await refusedWith(409, { code: 'agent_instance_wrong_project' });
    const n = screen.getByTestId('agent-refused-wrongProject');
    expect(n.textContent).toContain('Not sent — yue-claude works on another project.');
    expect(n.textContent).toContain('Choose an agent on Motir');
    noRun();
  });

  it('agent_run_card_not_ready', async () => {
    await refusedWith(409, { code: 'agent_run_card_not_ready', detail: 'in progress' });
    const n = screen.getByTestId('agent-refused-notReady');
    expect(n.textContent).toContain('Not sent — this work item isn’t ready to start.');
    expect(n.textContent).toContain('It isn’t waiting to be started');
    noRun();
  });

  it('agent_run_card_not_ready, while the page still counts open blockers', async () => {
    routes[START] = () => ({ status: 409, body: { code: 'agent_run_card_not_ready' } });
    await mount({ openBlockers: 1 });
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(screen.getByTestId('agent-refused-notReady').textContent).toContain(
      'It has 1 open blocker.',
    );
    noRun();
  });

  it('agent_instance_run_active, naming the work item and its run', async () => {
    await refusedWith(409, {
      code: 'agent_instance_run_active',
      runId: 'run_b',
      workItemKey: 'PROD-9',
    });
    const n = screen.getByTestId('agent-refused-runActive');
    expect(n.textContent).toContain('Not sent — yue-claude is already working on PROD-9.');
    expect(within(n).getByText('PROD-9').getAttribute('href')).toBe('/items/PROD-9');
    expect(within(n).getByText('Open PROD-9’s run').getAttribute('href')).toBe('/runs?run=run_b');
    noRun();
  });

  it('agent_instance_run_active with no key', async () => {
    await refusedWith(409, { code: 'agent_instance_run_active' });
    const n = screen.getByTestId('agent-refused-runActive');
    expect(n.textContent).toContain(
      'Not sent — yue-claude is already working on another work item.',
    );
    expect(within(n).getByText('Open that run')).toBeTruthy();
    noRun();
  });

  it('agent_instance_image_too_old', async () => {
    await refusedWith(409, { code: 'agent_instance_image_too_old' });
    expect(screen.getByTestId('agent-refused-imageTooOld').textContent).toContain(
      'Not sent — yue-claude was made from an older image',
    );
    noRun();
  });

  it('agent_profile_cannot_run', async () => {
    await refusedWith(409, { code: 'agent_profile_cannot_run' });
    expect(screen.getByTestId('agent-refused-cannotRun').textContent).toContain(
      'Not sent — Claude Code can’t work on a work item on its own.',
    );
    noRun();
  });

  it('agent_instance_state_conflict on a stopping agent', async () => {
    await refusedWith(409, { code: 'agent_instance_state_conflict' });
    expect(screen.getByTestId('agent-refused-hibernating').textContent).toContain(
      'Not sent — yue-claude is hibernating.',
    );
    noRun();
  });

  it('agent_instance_state_conflict on an agent being deleted', async () => {
    routes[AGENTS] = () => ({ status: 200, body: { agents: [agent({ state: 'deleting' })] } });
    await refusedWith(409, { code: 'agent_instance_state_conflict' });
    const n = screen.getByTestId('agent-refused-deleting');
    expect(n.textContent).toContain('Not sent — yue-claude is being deleted.');
    expect(n.textContent).toContain(NOTHING);
    noRun();
  });

  it('agent_instance_not_found', async () => {
    await refusedWith(404, { code: 'agent_instance_not_found' });
    expect(screen.getByTestId('agent-refused-notFound').textContent).toContain(
      'Not sent — that agent isn’t available.',
    );
    noRun();
  });

  it('hosted_repository_not_writable — the shipped repositories notice', async () => {
    await refusedWith(409, {
      code: 'hosted_repository_not_writable',
      repositories: [
        { repository: 'acme/api', reason: 'not_installed', fix: 'install', fixUrl: null },
      ],
      totalRepositories: 2,
    });
    expect(screen.getByTestId('hosted-refused-notWritable')).toBeTruthy();
    noRun();
  });

  it('agent_instance_start_refused · credits — the wake’s own words', async () => {
    await refusedWith(
      402,
      { code: 'agent_instance_start_refused', reason: 'credits' },
      'yue-sleepy',
    );
    const n = screen.getByTestId('agent-refused-wake');
    expect(n.textContent).toContain('Not sent — yue-sleepy couldn’t wake.');
    expect(n.textContent).toContain('Your organization is out of credits.');
    expect(within(n).getByText('Add credits').getAttribute('href')).toBe(
      '/settings/organization/billing',
    );
    noRun();
  });

  it('agent_instance_start_refused · credits_unknown', async () => {
    await refusedWith(
      503,
      { code: 'agent_instance_start_refused', reason: 'credits_unknown' },
      'yue-sleepy',
    );
    expect(screen.getByTestId('agent-refused-wake').textContent).toContain(
      'Motir could not check your organization’s credits just now.',
    );
    noRun();
  });

  it('agent_instance_start_refused · fleet_busy', async () => {
    await refusedWith(
      429,
      { code: 'agent_instance_start_refused', reason: 'fleet_busy' },
      'yue-sleepy',
    );
    expect(screen.getByTestId('agent-refused-wake').textContent).toContain(
      'Motir is running as many machines as it can right now.',
    );
    noRun();
  });

  it('agent_instance_start_refused · org_cap — the plan and the figure the refusal carries (MOTIR-9376)', async () => {
    await refusedWith(
      429,
      {
        code: 'agent_instance_start_refused',
        reason: 'org_cap',
        limit: 30,
        planName: 'Pro',
      },
      'yue-sleepy',
    );
    expect(screen.getByTestId('agent-refused-wake').textContent).toContain(
      'Your organization’s Pro plan allows 30 agents in the organization, running or asleep.',
    );
    noRun();
  });

  it('agent_instances_unavailable', async () => {
    await refusedWith(503, { code: 'agent_instances_unavailable' });
    expect(screen.getByTestId('agent-refused-wake').textContent).toContain(
      'My agents aren’t available on this deployment.',
    );
    noRun();
  });

  it('CI_CREDITS_EXHAUSTED (402)', async () => {
    await refusedWith(402, { code: 'CI_CREDITS_EXHAUSTED' });
    expect(screen.getByTestId('agent-refused-outOfCredits').textContent).toContain(
      'Not sent — your organization is out of credits.',
    );
    noRun();
  });

  it('a permission refusal (403)', async () => {
    await refusedWith(403, { code: 'FORBIDDEN' });
    expect(screen.getByTestId('agent-refused-permission').textContent).toContain(
      'Not sent — you can’t send this work item to an agent.',
    );
    noRun();
  });

  it('anything else — a missing work item, a server error', async () => {
    await refusedWith(404, { code: 'WORK_ITEM_NOT_FOUND' });
    expect(screen.getByTestId('agent-refused-failed').textContent).toContain(
      'Not sent — Motir couldn’t send it.',
    );
    noRun();
  });

  it('an answer that is not JSON', async () => {
    await refusedWith(502, null as unknown as Record<string, unknown>);
    expect(screen.getByTestId('agent-refused-failed')).toBeTruthy();
    noRun();
  });

  it('a network failure', async () => {
    offline = true;
    await refusedWith(500, {});
    expect(screen.getByTestId('agent-refused-failed')).toBeTruthy();
    noRun();
  });

  it('a refusal clears on the next press', async () => {
    await refusedWith(409, { code: 'agent_profile_cannot_run' });
    routes[START] = () => ({ status: 409, body: { code: 'agent_instance_image_too_old' } });
    await openPicker();
    await act(async () => {
      fireEvent.click(row('yue-claude'));
    });
    expect(screen.queryByTestId('agent-refused-cannotRun')).toBeNull();
    expect(screen.getByTestId('agent-refused-imageTooOld')).toBeTruthy();
  });
});

describe('the pure refusal map', () => {
  it('an unknown body is a failed send', () => {
    const a = agent();
    expect(agentSendRefusalOf(500, {}, a)).toEqual({ kind: 'failed', agent: a });
    expect(agentSendRefusalOf(409, { code: 'agent_instance_run_active', runId: 7 }, a)).toEqual({
      kind: 'runActive',
      agent: a,
      runId: null,
      workItemKey: null,
    });
  });

  it('a wake refusal carries the cap’s figure and plan only when the body names them', () => {
    const a = agent();
    const code = 'agent_instance_start_refused';
    expect(
      agentSendRefusalOf(429, { code, reason: 'user_cap', limit: 1, planName: 'Standard' }, a),
    ).toEqual({ kind: 'wake', agent: a, code, reason: 'user_cap', limit: 1, planName: 'Standard' });
    expect(
      agentSendRefusalOf(429, { code, reason: 'user_cap', limit: '1', planName: '' }, a),
    ).toEqual({ kind: 'wake', agent: a, code, reason: 'user_cap' });
  });
});

describe('the options, disabled', () => {
  it('a card that is not ready disables both, with the not-ready words', async () => {
    await mount({ ready: false, openBlockers: 2 });
    expect((screen.getByTestId('send-to-agent') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('run-hosted') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hosted-not-ready').textContent).toBe(
      'Run and Send to my agent are available once this work item is ready — it has 2 open blockers.',
    );
  });

  it('a live LOCAL run leaves neither option, and no Cancel', async () => {
    await mount({ runs: [run({ status: 'running', endedAt: null, stopReason: null })] });
    expect(screen.queryByTestId('start-bar')).toBeNull();
    expect(screen.queryByTestId('send-to-agent')).toBeNull();
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });

  it('a live run in ANOTHER member’s agent leaves neither option, and no Cancel for this reader', async () => {
    await mount({
      runs: [
        run({
          origin: 'instance',
          status: 'running',
          endedAt: null,
          stopReason: null,
          createdById: 'usr_other',
          agentInstance: AGENT_INSTANCE,
        }),
      ],
    });
    expect(screen.queryByTestId('start-bar')).toBeNull();
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });

  it('after a run in an agent has ended, Run reads Run again', async () => {
    await mount({ runs: [run({ origin: 'instance', agentInstance: AGENT_INSTANCE })] });
    expect(screen.getByTestId('run-hosted').textContent).toBe('Run again');
    expect(screen.getByTestId('send-to-agent').textContent).toContain('Send to my agent');
  });
});
