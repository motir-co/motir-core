// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { MyAgentsRoom } from '@/app/(authed)/my-agents/_components/MyAgentsRoom';
import type { AgentInstanceListItemDto, AgentInstanceListPageDto } from '@/lib/dto/agentInstances';

// THE MY AGENTS ROOM (Story MOTIR-6860 · MOTIR-6874), held to the approved
// `design/my-agents/my-agents.mock.html` (MOTIR-6868 revision 3). The routes are
// stubbed at `fetch`; what is asserted is the page's own decisions — which face it
// wears, what each action sends, and that it re-reads itself after every one.

const PROFILES = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'kimi', name: 'Kimi Code' },
  { id: 'aider', name: 'Aider' },
  { id: 'goose', name: 'Goose' },
];

function agent(over: Partial<AgentInstanceListItemDto> = {}): AgentInstanceListItemDto {
  return {
    id: 'a1',
    name: 'yue-claude',
    projectId: 'p1',
    profileId: 'claude',
    profileName: 'Claude Code',
    imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
    imageDigest: 'sha256:abc',
    imageVersion: '1.0.0',
    update: null,
    pendingImageVersion: null,
    updateFailureReason: null,
    region: 'iad',
    state: 'running',
    failureReason: null,
    terminalServer: 'unknown',
    stateChangedAt: '2026-09-29T10:00:00.000Z',
    lastActivityAt: '2026-09-29T10:00:00.000Z',
    createdAt: '2026-09-29T10:00:00.000Z',
    machineSecondsThisMonth: 72 * 60,
    creditsThisMonth: 72,
    stopReason: null,
    scheduledDeletionAt: null,
    activeRun: null,
    lastRun: null,
    bootStep: null,
    ...over,
  };
}

const page = (instances: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
  instances,
  total: instances.length,
  planLapse: null,
});

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  // What no test arms answers 404 — a panel a create opens reads its boot and
  // its terminal ticket, which a list test does not care about.
  fetchMock.mockResolvedValue(json(404, {}));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = (
  initial: AgentInstanceListPageDto | null,
  messages?: Record<string, unknown>,
  storageCreditsPerDay: number | null = null,
) =>
  render(
    <MyAgentsRoom
      projectKey="MOTIR"
      projectName="motir"
      initial={initial}
      profiles={PROFILES}
      storageCreditsPerDay={storageCreditsPerDay}
    />,
    messages ? { messages, locale: 'zh' } : {},
  );

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit | undefined)?.method ?? 'GET',
    body: (init as RequestInit | undefined)?.body,
  }));

async function openMenu(name: string) {
  fireEvent.click(screen.getAllByRole('button', { name: `Actions for ${name}` })[0]!);
  return screen.findByRole('menu');
}

describe('the faces', () => {
  it('no agents yet: explains what an agent is and offers New agent — never an error', () => {
    mount(page([]));
    expect(screen.getByRole('heading', { name: 'My agents' })).toBeTruthy();
    expect(screen.getByText('No agents yet')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'New agent' })).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed first read is its own face, never the empty state', () => {
    mount(null);
    expect(screen.getByRole('alert').textContent).toContain('We couldn’t load your agents.');
    expect(screen.queryByText('No agents yet')).toBeNull();
  });

  it('the list: every column the design names, the total and the page', () => {
    mount(
      page([
        agent(),
        agent({
          id: 'a2',
          name: 'yue-codex',
          profileName: 'Codex',
          state: 'hibernated',
          stopReason: 'credits',
          machineSecondsThisMonth: 123 * 60,
          creditsThisMonth: 123,
        }),
        agent({
          id: 'a3',
          name: 'old-box',
          state: 'failed',
          failureReason: 'The machine could not start: no capacity on its host.',
        }),
        agent({ id: 'a4', name: 'booting', state: 'starting', machineSecondsThisMonth: 0 }),
      ]),
    );
    const table = screen.getByRole('table');
    for (const col of [
      'Name',
      'Coding agent',
      'Project',
      'State',
      'Machine time this month',
      'Credits',
    ]) {
      expect(within(table).getByRole('columnheader', { name: col })).toBeTruthy();
    }
    const rows = within(table).getAllByTestId('agent-row');
    expect(rows[0]!.textContent).toContain('yue-claude');
    expect(rows[0]!.textContent).toContain('Claude Code');
    expect(rows[0]!.textContent).toContain('Running');
    expect(rows[0]!.textContent).toContain('1h 12m');
    expect(rows[1]!.textContent).toContain('Hibernated');
    expect(rows[1]!.textContent).toContain(
      'Stopped: your organization ran out of credits. Add credits, then wake it.',
    );
    expect(rows[1]!.textContent).toContain('2h 03m');
    expect(rows[2]!.textContent).toContain(
      'The machine could not start: no capacity on its host. Wake to try again, or delete it.',
    );
    expect(rows[3]!.textContent).toContain('Booting — cloning the project’s repositories');
    // Not paginated (a person keeps at most 10 agents): no pager, no page count.
    expect(screen.queryByText(/Page \d+ of/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('renders in Chinese from the zh catalog', () => {
    mount(page([agent()]), zhMessages as Record<string, unknown>);
    expect(screen.getByRole('heading', { name: '我的智能体' })).toBeTruthy();
    expect(within(screen.getByRole('table')).getByText('运行中')).toBeTruthy();
  });
});

describe('create', () => {
  it('offers exactly the six coding agents with the price line, posts, closes and re-reads', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(6);
    expect(within(dialog).getByText('Kimi Code')).toBeTruthy();
    expect(within(dialog).queryByText('Cursor')).toBeNull();
    expect(dialog.textContent).toContain('1 credit per minute');

    fetchMock
      .mockResolvedValueOnce(json(201, { instance: agent({ name: 'my-codex' }) }))
      .mockResolvedValueOnce(json(200, page([agent({ name: 'my-codex' })])));
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'my-codex' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Codex/ }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });

    const [post, get] = calls();
    expect(post).toMatchObject({ url: '/api/projects/MOTIR/instances', method: 'POST' });
    expect(JSON.parse(String(post!.body))).toEqual({ name: 'my-codex', profileId: 'codex' });
    expect(get).toMatchObject({ method: 'GET' });
    expect(get!.url).toContain('/api/projects/MOTIR/instances?limit=10');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByText('my-codex').length).toBeGreaterThan(0);
  });

  it('the boot delta: closes on the 201, shows the new row before any re-read, and opens its panel at ?agent=', async () => {
    window.history.replaceState(null, '', '/my-agents');
    mount(page([agent({ id: 'old', name: 'older-agent' })]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    const created = agent({ id: 'new1', name: 'my-claude', state: 'starting' });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json(201, { instance: created });
      // The re-read never answers: the row must come from the create's own answer.
      if (url.includes('/instances?limit=')) return new Promise(() => {});
      return json(404, {});
    });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'my-claude' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).toBe('?agent=new1');
    const panel = screen.getByTestId('agent-panel');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toContain('my-claude');
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { level: 2 }));
    // The list holds the new row, newest first, beside the older one.
    const doors = document.querySelectorAll('[data-agent-id]');
    expect(doors[0]?.getAttribute('data-agent-id')).toBe('new1');
  });

  it('the boot delta: a booting row names the step it is on, a row with none the shipped line', () => {
    mount(
      page([
        agent({
          id: 'b1',
          name: 'cloning-one',
          state: 'starting',
          bootStep: { step: 'clone', repository: 'acme/web', waiting: null },
        }),
        agent({ id: 'b2', name: 'quiet-one', state: 'waking', bootStep: null }),
      ]),
    );
    expect(screen.getAllByText('Cloning acme/web…').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Starting a fresh machine on your home').length).toBeGreaterThan(0);
  });

  it('a refusal lands in the dialog, in the design’s words, and keeps the dialog open', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'x' } });

    fetchMock.mockResolvedValueOnce(
      json(402, { code: 'agent_instance_start_refused', reason: 'credits', error: 'nope' }),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toBe(
      'Out of creditsYour organization is out of credits. Agents use credits while they run and for their storage every day, asleep or not. Add credits to create or wake an agent.',
    );
    expect(within(alert).getByRole('link', { name: 'Add credits' }).getAttribute('href')).toBe(
      '/settings/organization/billing',
    );

    // MOTIR-9376: the figure and the plan are the refusal's own, never a constant.
    fetchMock.mockResolvedValueOnce(
      json(429, {
        code: 'agent_instance_start_refused',
        reason: 'user_cap',
        limit: 1,
        planName: 'Standard',
      }),
    );
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    const capAlert = within(dialog).getByRole('alert');
    expect(capAlert.textContent).toBe(
      'Your limitYour organization’s Standard plan allows 1 agent per person. Each one is charged for its storage every day, even asleep. Delete one to create another.',
    );
    expect(capAlert.textContent).not.toContain('10');

    fetchMock.mockResolvedValueOnce(json(409, { code: 'agent_instance_name_taken' }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create agent' }));
    });
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'You already have an agent called x on this project.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('a paid AI plan, and storage in the words (MOTIR-6918, the MOTIR-6916 delta)', () => {
  async function refuseCreate(status: number, reason: string) {
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Name'), {
      target: { value: 'x' },
    });
    fetchMock.mockResolvedValueOnce(json(status, { code: 'agent_instance_start_refused', reason }));
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Create agent' }),
      );
    });
    return within(screen.getByRole('dialog')).getByRole('alert');
  }

  it('panel A: needs an AI plan, titled, with Choose an AI plan → Billing & plans — and the dialog stays open', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    await screen.findByRole('dialog');
    const alert = await refuseCreate(402, 'ai_plan_required');
    expect(within(alert).getByText('Needs an AI plan').className).toContain('font-semibold');
    expect(alert.textContent).toContain(
      'Agents need a paid AI plan. Choose an AI plan to create or wake one.',
    );
    expect(
      within(alert).getByRole('link', { name: 'Choose an AI plan' }).getAttribute('href'),
    ).toBe('/settings/organization/billing');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('an AI plan that could not be checked: titled, no link', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    await screen.findByRole('dialog');
    const alert = await refuseCreate(503, 'ai_plan_unknown');
    expect(alert.textContent).toBe(
      'Couldn’t check your AI planMotir could not check your organization’s AI plan just now. Try again in a moment.',
    );
    expect(within(alert).queryByRole('link')).toBeNull();
  });

  it('panel B: a Wake refused for the plan shows above the list, and the row stays hibernated', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fetchMock
      .mockResolvedValueOnce(
        json(402, { code: 'agent_instance_start_refused', reason: 'ai_plan_required' }),
      )
      .mockResolvedValueOnce(json(200, page([agent({ state: 'hibernated' })])));
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Needs an AI plan');
    expect(within(alert).getByRole('link', { name: 'Choose an AI plan' })).toBeTruthy();
    expect(screen.getAllByText('Hibernated').length).toBeGreaterThan(0);
  });

  it('panel D: your organization’s limit, titled, naming the number the refusal carries', async () => {
    mount(page([]));
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    await screen.findByRole('dialog');
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Name'), {
      target: { value: 'x' },
    });
    fetchMock.mockResolvedValueOnce(
      json(429, {
        code: 'agent_instance_start_refused',
        reason: 'org_running_cap',
        limit: 50,
        planName: 'Max',
      }),
    );
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Create agent' }),
      );
    });
    const alert = within(screen.getByRole('dialog')).getByRole('alert');
    expect(alert.textContent).toBe(
      'Your organization’s limitYour organization’s Max plan runs 50 agents at once, and all of them are running. Hibernate one to start another.',
    );
    expect(alert.className).toContain('bg-(--el-tint-rose)');
  });

  it('on a cloud build the price line and the empty state say storage is charged every day, at the rate given', async () => {
    mount(page([]), undefined, 10);
    expect(
      screen.getByText(/Motir charges its machine time while it runs and its storage every day/),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      '1 credit per minute while it runs, and 10 credits a day for its storage, running or hibernated. It hibernates after 30 minutes without use.',
    );
    expect(dialog.textContent).not.toContain('costs nothing while hibernated');
  });

  it('where storage is not charged (self-hosted) the words keep the base design', async () => {
    mount(page([]));
    expect(screen.getByText(/Motir charges only its machine time/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'New agent' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toContain('for its storage');
  });

  it('the zh catalog carries every new key', async () => {
    mount(page([]), zhMessages as Record<string, unknown>, 10);
    fireEvent.click(screen.getAllByRole('button', { name: /智能体/ })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('每天 10 额度');
  });
});

describe('the plan has ended (MOTIR-6921, the MOTIR-6916 delta panel E)', () => {
  const lapsed = (rows: AgentInstanceListItemDto[]): AgentInstanceListPageDto => ({
    ...page(rows),
    planLapse: { deletesOn: '2026-10-29T00:00:00.000Z' },
  });

  it('a banner between the header and the list names the date and links Renew the AI plan', () => {
    mount(lapsed([agent({ scheduledDeletionAt: '2026-10-29T00:00:00.000Z' })]));
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe(
      'Your organization’s AI plan has ended.Your agents will be deleted on Oct 29, 2026 unless the plan is renewed. Renew the AI plan',
    );
    expect(
      within(banner).getByRole('link', { name: 'Renew the AI plan' }).getAttribute('href'),
    ).toBe('/settings/organization/billing');
    expect(banner.className).toContain('bg-(--el-tint-peach)');
  });

  it('every row carries its deletion date as its last line, in danger ink', () => {
    mount(
      lapsed([
        agent({ id: 'a1', name: 'yue-claude', scheduledDeletionAt: '2026-10-29T00:00:00.000Z' }),
        agent({
          id: 'a2',
          name: 'yue-codex',
          state: 'hibernated',
          stopReason: 'idle',
          scheduledDeletionAt: '2026-10-29T00:00:00.000Z',
        }),
      ]),
    );
    const lines = screen.getAllByText('Will be deleted on Oct 29, 2026');
    // Two rows, each drawn in the table and the narrow cards.
    expect(lines).toHaveLength(4);
    expect(lines[0]!.className).toContain('text-(--el-danger-on-surface)');
  });

  it('Wake is disabled, with the needs-an-AI-plan reason and its link under it; Delete stays', async () => {
    mount(
      lapsed([agent({ state: 'hibernated', scheduledDeletionAt: '2026-10-29T00:00:00.000Z' })]),
    );
    const menu = await openMenu('yue-claude');
    const wake = within(menu).getByRole('menuitem', { name: 'Wake' });
    expect(wake.getAttribute('aria-disabled')).toBe('true');
    expect(menu.textContent).toContain(
      'Agents need a paid AI plan. Choose an AI plan to create or wake one.',
    );
    expect(within(menu).getByRole('link', { name: 'Choose an AI plan' })).toBeTruthy();
    expect(
      within(menu).getByRole('menuitem', { name: 'Delete…' }).getAttribute('aria-disabled'),
    ).toBe('false');
  });

  it('with the plan standing there is no banner, no date and Wake is offered', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Will be deleted on/)).toBeNull();
    const menu = await openMenu('yue-claude');
    expect(within(menu).getByRole('menuitem', { name: 'Wake' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
  });
});

describe('waiting for room (MOTIR-9475, the waiting delta)', () => {
  it('a waiting row reads Waiting in the queued tone, and its line says it waits for room', () => {
    mount(
      page([
        agent({
          id: 'w1',
          name: 'new-one',
          state: 'starting',
          bootStep: { step: 'provision', repository: null, waiting: 'pool' },
        }),
        agent({
          id: 'w2',
          name: 'woken-one',
          state: 'waking',
          bootStep: { step: 'provision', repository: null, waiting: 'account' },
        }),
        agent({
          id: 'w3',
          name: 'plain-one',
          state: 'starting',
          bootStep: { step: 'machine_start', repository: null, waiting: null },
        }),
      ]),
    );
    expect(screen.getAllByText('Waiting for room…').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting for room to wake…').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Starting the machine…').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
  });

  it('the menu keeps Wake and Hibernate disabled, Delete offered, and says what Delete does to the wait', async () => {
    mount(
      page([
        agent({
          state: 'starting',
          bootStep: { step: 'provision', repository: null, waiting: 'pool' },
        }),
      ]),
    );
    const menu = await openMenu('yue-claude');
    expect(within(menu).getByRole('menuitem', { name: 'Wake' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Hibernate' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Delete…' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(
      within(menu).getByText('Deleting it stops the wait. Nothing was created yet.'),
    ).toBeTruthy();
  });

  it('a woken agent’s note says Delete deletes its files', async () => {
    mount(
      page([
        agent({
          state: 'waking',
          bootStep: { step: 'provision', repository: null, waiting: 'account' },
        }),
      ]),
    );
    const menu = await openMenu('yue-claude');
    expect(
      within(menu).getByText('Deleting it stops the wait and deletes its files.'),
    ).toBeTruthy();
  });

  it('an agent that is not waiting carries no note', async () => {
    mount(page([agent()]));
    const menu = await openMenu('yue-claude');
    expect(within(menu).queryByText(/stops the wait/)).toBeNull();
  });
});

describe('the row menu', () => {
  it('offers only the moves the state allows — the rest disabled, not hidden', async () => {
    mount(page([agent()]));
    const menu = await openMenu('yue-claude');
    expect(within(menu).getByRole('menuitem', { name: 'Wake' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Hibernate' }).hasAttribute('disabled')).toBe(
      false,
    );
    expect(within(menu).getByRole('menuitem', { name: 'Delete…' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('Wake posts to its route and the row re-reads to the new state', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fetchMock
      .mockResolvedValueOnce(json(200, { instance: agent({ state: 'running' }) }))
      .mockResolvedValueOnce(json(200, page([agent({ state: 'running' })])));
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
    });
    expect(calls()[0]).toMatchObject({
      url: '/api/projects/MOTIR/instances/a1/wake',
      method: 'POST',
    });
    const row = within(screen.getByRole('table')).getByTestId('agent-row');
    expect(row.getAttribute('data-state')).toBe('running');
  });

  it('a Wake refused for the org’s running cap names the plan and the figure the refusal carries (MOTIR-9376)', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fetchMock
      .mockResolvedValueOnce(
        json(429, {
          code: 'agent_instance_start_refused',
          reason: 'org_running_cap',
          limit: 30,
          planName: 'Pro',
        }),
      )
      .mockResolvedValueOnce(json(200, page([agent({ state: 'hibernated' })])));
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'Your organization’s limitYour organization’s Pro plan runs 30 agents at once, and all of them are running. Hibernate one to start another.',
    );
  });

  it.each([
    [
      'user_cap',
      { limit: 1 },
      'Your limitYou already have as many agents as your organization’s plan allows per person. Each one is charged for its storage every day, even asleep. Delete one to create another.',
    ],
    [
      'user_cap',
      { planName: 'Standard' },
      'Your limitYou already have as many agents as your organization’s plan allows per person. Each one is charged for its storage every day, even asleep. Delete one to create another.',
    ],
    [
      'org_running_cap',
      {},
      'Your organization’s limitYour organization is already running as many agents at once as its plan allows. Hibernate one to start another.',
    ],
  ])(
    'a %s refusal missing its figure or its plan (%j) names neither — no constant, no 0 (MOTIR-9376)',
    async (reason, extra, words) => {
      mount(page([agent({ state: 'hibernated' })]));
      const menu = await openMenu('yue-claude');
      fetchMock
        .mockResolvedValueOnce(
          json(429, { code: 'agent_instance_start_refused', reason, ...extra }),
        )
        .mockResolvedValueOnce(json(200, page([agent({ state: 'hibernated' })])));
      await act(async () => {
        fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
      });
      const text = screen.getByRole('alert').textContent ?? '';
      expect(text).toBe(words);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toContain('Standard');
    },
  );

  it('a refused Wake shows above the list', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fetchMock
      .mockResolvedValueOnce(
        json(429, { code: 'agent_instance_start_refused', reason: 'fleet_busy' }),
      )
      .mockResolvedValueOnce(json(200, page([agent({ state: 'hibernated' })])));
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Wake' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'Motir is running as many machines as it can right now. Try again in a few minutes.',
    );
  });

  it('Delete… confirms first, naming what is lost, then deletes and re-reads', async () => {
    mount(page([agent({ state: 'hibernated' })]));
    const menu = await openMenu('yue-claude');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Delete yue-claude?');
    expect(dialog.textContent).toContain('any work you have not committed and pushed.');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock
      .mockResolvedValueOnce(json(200, { instance: agent({ state: 'deleting' }) }))
      .mockResolvedValueOnce(json(200, page([])));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));
    });
    expect(calls()[0]).toMatchObject({ url: '/api/projects/MOTIR/instances/a1', method: 'DELETE' });
    await waitFor(() => expect(screen.getByText('No agents yet')).toBeTruthy());
  });
});

describe('freshness', () => {
  it('polls while a row is in motion, and stops once it settles', async () => {
    vi.useFakeTimers();
    mount(page([agent({ state: 'starting' })]));
    fetchMock.mockResolvedValue(json(200, page([agent({ state: 'running' })])));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      within(screen.getByRole('table')).getByTestId('agent-row').getAttribute('data-state'),
    ).toBe('running');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
