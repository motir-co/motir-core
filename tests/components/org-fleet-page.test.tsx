// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { clearToastTimersAfterEach } from '../helpers/toastTimers';
import { ToastProvider } from '@/components/ui/Toast';
import type { OrgFleetDTO } from '@/lib/dto/orgFleet';
import type { OrgFleetStopResultDTO } from '@/lib/dto/orgFleetStop';

/**
 * SETTINGS › ORGANIZATION › FLEET — the island (MOTIR-10369 · design
 * `design/org-admin/org-admin--fleet.mock.html` panels 2–9).
 *
 * ⚠️ Asserted from the side that can fail: a section that was NOT read draws its
 * own error and never a 0; no agent row links anywhere; Stop everything cannot be
 * confirmed against counts nobody read; the result survives a re-read.
 */

const cancelHostedRunAction = vi.hoisted(() => vi.fn());
const hibernateAgentAction = vi.hoisted(() => vi.fn());
const previewStopEverythingAction = vi.hoisted(() => vi.fn());
const stopEverythingAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/(authed)/settings/organization/fleet/actions', () => ({
  cancelHostedRunAction,
  hibernateAgentAction,
  previewStopEverythingAction,
  stopEverythingAction,
}));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { FleetClient } =
  await import('@/app/(authed)/settings/organization/fleet/_components/FleetClient');
const { FLEET_POLL_MS } =
  await import('@/app/(authed)/settings/organization/fleet/_components/useFleetRead');

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const figure = (inUse: number | null, cap: number | null) => ({
  figure: cap,
  inUse,
  waiting: null,
  figureSource: 'plan' as const,
});

function fleet(overrides: Partial<OrgFleetDTO> = {}): OrgFleetDTO {
  return {
    tiles: {
      kind: 'read',
      plan: { kind: 'limited', planKey: 'max', planName: 'Max', noFleet: false },
      countsRead: true,
      figures: {
        agentRunsInParallel: figure(1, 4),
        agentsInOrg: figure(3, 10),
        agentsPerPerson: figure(null, 3),
        ciJobsInFlight: {
          figure: 8,
          inUse: 1,
          waiting: { planLimit: 1, poolFull: 0, other: 0 },
          figureSource: 'plan',
        },
      },
    },
    hostedRuns: {
      kind: 'read',
      rows: [
        {
          id: 'run_1',
          projectName: 'Payments',
          card: { key: 'PAY-12', title: 'Refund flow' },
          dispatcherName: 'Ana',
          startedAt: ago(5),
          runUrl: '/runs?run=run_1',
        },
      ],
    },
    agentInstances: {
      kind: 'read',
      rows: [
        {
          id: 'inst_1',
          ownerName: 'Ben',
          profileId: 'claude-code',
          projectName: 'Payments',
          state: 'running',
          since: ago(120),
          ownedByViewer: false,
        },
        {
          id: 'inst_2',
          ownerName: null,
          profileId: 'codex',
          projectName: null,
          state: 'hibernated',
          since: ago(60),
          ownedByViewer: false,
        },
        {
          id: 'inst_3',
          ownerName: 'Me',
          profileId: 'claude-code',
          projectName: 'Payments',
          state: 'waking',
          since: ago(1),
          ownedByViewer: true,
        },
      ],
    },
    ciJobs: {
      kind: 'read',
      inFlight: 1,
      waiting: { planLimit: 1, poolFull: 0, other: 0 },
      rows: [
        {
          id: 'job_1',
          repository: 'acme/pay',
          workflowName: 'CI',
          jobName: 'test',
          projectName: 'Payments',
          queuedAt: ago(3),
          state: 'in_flight',
          waitingCause: null,
          actionsUrl: 'https://github.com/acme/pay/actions/runs/1',
        },
        {
          id: 'job_2',
          repository: 'acme/pay',
          workflowName: null,
          jobName: null,
          projectName: null,
          queuedAt: ago(2),
          state: 'waiting',
          waitingCause: 'planLimit',
          actionsUrl: 'https://github.com/acme/pay/actions/runs/2',
        },
      ],
    },
    indexJobs: { kind: 'read', running: 1 },
    motirStops: {
      kind: 'read',
      since: ago(7 * 24 * 60),
      entries: [
        { decidedAt: ago(30), workload: 'ci_runner', reason: 'record_ended', completed: true },
        { decidedAt: ago(40), workload: 'hosted_agent', reason: 'foreign_org', completed: false },
      ],
    },
    lastStop: { kind: 'read', stop: { actorName: 'Ana', action: 'stop_everything', at: ago(90) } },
    ...overrides,
  };
}

const EMPTY: Partial<OrgFleetDTO> = {
  hostedRuns: { kind: 'read', rows: [] },
  agentInstances: { kind: 'read', rows: [] },
  ciJobs: { kind: 'read', inFlight: 0, waiting: { planLimit: 0, poolFull: 0, other: 0 }, rows: [] },
  indexJobs: { kind: 'read', running: 0 },
  motirStops: { kind: 'read', since: ago(7 * 24 * 60), entries: [] },
  lastStop: { kind: 'read', stop: null },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

// The cancel / hibernate outcome toasts arm Radix's 5 s close timer, which
// Radix never clears on unmount. Left running it fires after happy-dom is torn
// down and fails the shard with "document is not defined" (MOTIR-10744).
clearToastTimersAfterEach();

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Restores every `vi.spyOn` — the toast-timer spy above, and the
  // `document.visibilityState` getters two polling tests pin to `hidden`, which
  // otherwise leak into whichever test runs next under `--sequence.shuffle`.
  vi.restoreAllMocks();
  for (const fn of [
    cancelHostedRunAction,
    hibernateAgentAction,
    previewStopEverythingAction,
    stopEverythingAction,
    refresh,
  ]) {
    fn.mockReset();
  }
});

function renderPage(initial: OrgFleetDTO = fleet(), canStop = true) {
  return render(
    <ToastProvider>
      <FleetClient
        orgId="org_1"
        orgName="Acme"
        initialFleet={initial}
        initialReadAt={new Date(NOW).toISOString()}
        canStop={canStop}
      />
    </ToastProvider>,
  );
}

function answer(body: OrgFleetDTO, status = 200) {
  return { ok: status === 200, status, json: async () => ({ fleet: body }) };
}

function done(overrides: Partial<OrgFleetStopResultDTO> = {}): OrgFleetStopResultDTO {
  return {
    runsCancelled: 2,
    ciContainersStopped: 3,
    hostedRunsEnded: 1,
    agentsHibernated: 1,
    failures: { ci: 0, hosted: 0, agents: 0 },
    stoppedByName: 'Me',
    stoppedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('the populated page (panel 2)', () => {
  it('renders the header, the tiles and every section with its rows', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Fleet' })).toBeTruthy();
    expect(screen.getByText('Acme · Settings')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Billing & plans › Fleet use' });
    expect(link.getAttribute('href')).toBe('/settings/organization/billing#fleet-use');

    const tiles = screen.getByTestId('fleet-tiles');
    expect(within(tiles).getByTestId('fleet-tile-agent-runs').textContent).toContain('1 of 4');
    expect(within(tiles).getByTestId('fleet-tile-agents').textContent).toContain('3 of 10');
    expect(within(tiles).getByTestId('fleet-tile-ci').textContent).toContain('1 waiting');
    expect(within(tiles).getByTestId('fleet-tile-index').textContent).toContain('Not charged');

    const hosted = screen.getByTestId('fleet-hosted');
    expect(within(hosted).getByText('1 live')).toBeTruthy();
    expect(within(hosted).getByText('PAY-12')).toBeTruthy();
    expect(within(hosted).getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
      '/runs?run=run_1',
    );
    expect(within(hosted).getByRole('button', { name: 'Cancel the run of PAY-12' })).toBeTruthy();

    const ci = screen.getByTestId('fleet-ci');
    expect(within(ci).getByText('1 in flight · 1 waiting')).toBeTruthy();
    expect(within(ci).getByText('Waiting · plan limit')).toBeTruthy();
    expect(within(ci).getAllByRole('link', { name: /View on GitHub/ })).toHaveLength(2);
    expect(within(ci).getByText('No project', { exact: false })).toBeTruthy();

    expect(screen.getByTestId('fleet-index').textContent).toContain('1 running');
    const stops = screen.getByTestId('fleet-motir-stops');
    expect(within(stops).getByText('CI job container')).toBeTruthy();
    expect(within(stops).getByText('Did not complete')).toBeTruthy();
    expect(stops.textContent).toContain('it was running another organization’s work');
  });

  it('offers Hibernate only on a running agent, and no agent row links anywhere', () => {
    renderPage();
    const agents = screen.getByTestId('fleet-agents');
    expect(within(agents).queryAllByRole('link')).toHaveLength(0);
    const rows = within(agents).getAllByTestId('fleet-agent-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByRole('button', { name: 'Hibernate Ben’s agent' })).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button')).toBeNull();
    expect(rows[1]!.textContent).toContain('A member’s agent · codex');
    expect(rows[1]!.textContent).toContain('A deleted project · hibernating since');
    expect(within(rows[2]!).queryByRole('button')).toBeNull();
    expect(rows[2]!.textContent).toContain('Waking');
  });

  it('says who last stopped fleet work', () => {
    renderPage();
    expect(screen.getByTestId('fleet-last-stop').textContent).toMatch(/^Last stopped by Ana, /);
  });

  it('names an unnamed stopper and a run with no card or dispatcher in their own words', () => {
    renderPage(
      fleet({
        lastStop: {
          kind: 'read',
          stop: { actorName: null, action: 'cancel_hosted_run', at: ago(2) },
        },
        hostedRuns: {
          kind: 'read',
          rows: [
            {
              id: 'run_2',
              projectName: null,
              card: null,
              dispatcherName: null,
              startedAt: ago(4 * 24 * 60),
              runUrl: '/runs?run=run_2',
            },
          ],
        },
      }),
    );
    expect(screen.getByTestId('fleet-last-stop').textContent).toMatch(/^Last stopped today at /);
    const hosted = screen.getByTestId('fleet-hosted');
    expect(hosted.textContent).toContain('A run with no work item');
    expect(hosted.textContent).toContain('A deleted project · ');
    expect(hosted.textContent).not.toContain('started by');
  });
});

describe('a viewer who may not stop', () => {
  it('reads every section but is offered no Cancel, Hibernate or Stop everything', () => {
    renderPage(fleet(), false);
    expect(screen.getByTestId('fleet-hosted').textContent).toContain('PAY-12');
    expect(
      screen.getByTestId('fleet-agents').querySelectorAll('[data-testid="fleet-agent-row"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Cancel the run of/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hibernate / })).toBeNull();
    expect(screen.queryByTestId('fleet-stop-all')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });
});

describe('the empty page (panel 3)', () => {
  it('says every section in its own words and disables Stop everything', () => {
    renderPage(fleet(EMPTY));
    expect(screen.getByText('No agent run is live.')).toBeTruthy();
    expect(screen.getByText('No agent is running or hibernating.')).toBeTruthy();
    expect(screen.getByText('No CI job is in flight or waiting.')).toBeTruthy();
    expect(screen.getByTestId('fleet-index').textContent).toContain('0 running');
    expect(
      screen.getByText('Motir stopped nothing for this organization in the last 7 days.'),
    ).toBeTruthy();
    expect(screen.getByTestId('fleet-last-stop').textContent).toBe(
      'No one in Acme has stopped fleet work yet.',
    );
    expect(screen.getByTestId('fleet-stop-all').hasAttribute('disabled')).toBe(true);
    // No count chip on an empty section.
    expect(within(screen.getByTestId('fleet-hosted')).queryByText(/live$/)).toBeNull();
  });

  it('keeps Stop everything enabled when a section was not read', () => {
    renderPage(fleet({ ...EMPTY, ciJobs: { kind: 'not_read' } }));
    expect(screen.getByTestId('fleet-stop-all').hasAttribute('disabled')).toBe(false);
  });
});

describe('a part that was not read (panel 5)', () => {
  it('draws that section’s error with Retry, never a 0, and leaves the others', async () => {
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage(
      fleet({
        agentInstances: { kind: 'not_read' },
        hostedRuns: { kind: 'not_read' },
        ciJobs: { kind: 'not_read' },
        indexJobs: { kind: 'not_read' },
        motirStops: { kind: 'not_read' },
        lastStop: { kind: 'not_read' },
        tiles: { kind: 'not_read' },
      }),
    );
    const agents = screen.getByTestId('fleet-agents');
    const alert = within(agents).getByRole('alert');
    expect(alert.textContent).toContain('Couldn’t read the agent instances');
    expect(alert.textContent).toContain('Nothing here is shown as zero.');
    expect(within(agents).queryByText(/live$/)).toBeNull();
    expect(screen.getByTestId('fleet-tiles').textContent).toContain(
      'Couldn’t read the fleet figures',
    );
    for (const id of ['fleet-hosted', 'fleet-ci', 'fleet-index', 'fleet-motir-stops']) {
      expect(within(screen.getByTestId(id)).getByRole('alert')).toBeTruthy();
    }
    expect(screen.getByTestId('fleet-last-stop').textContent).toBe(
      'Couldn’t read who last stopped fleet work.',
    );

    fireEvent.click(within(agents).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getAllByTestId('fleet-agent-row')).toHaveLength(3));
    expect(fetchMock).toHaveBeenCalledWith('/api/organizations/org_1/fleet', { cache: 'no-store' });
  });

  it('says a tile count was not read rather than drawing a 0', () => {
    renderPage(
      fleet({
        tiles: {
          kind: 'read',
          plan: { kind: 'no_plan_limits' },
          countsRead: false,
          figures: {
            agentRunsInParallel: figure(null, null),
            agentsInOrg: figure(null, null),
            agentsPerPerson: figure(null, null),
            ciJobsInFlight: figure(null, null),
          },
        },
        indexJobs: { kind: 'not_read' },
      }),
    );
    const tiles = screen.getByTestId('fleet-tiles');
    expect(within(tiles).getAllByText('Couldn’t read')).toHaveLength(4);
    expect(tiles.textContent).not.toMatch(/\b0\b/);
  });
});

describe('refresh (panel 4b)', () => {
  it('re-reads every 30 seconds while visible, keeps the data on a failure, and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    renderPage();
    await act(async () => {
      vi.advanceTimersByTime(FLEET_POLL_MS);
    });
    await waitFor(() =>
      expect(screen.getByTestId('fleet-refresh-cue').textContent).toBe(
        'Couldn’t refresh. The last data read is still shown.',
      ),
    );
    expect(screen.getAllByTestId('fleet-agent-row')).toHaveLength(3);

    fetchMock.mockResolvedValueOnce(answer(fleet(EMPTY)));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('No agent run is live.')).toBeTruthy());
    expect(screen.getByTestId('fleet-refresh-cue').textContent).toMatch(/^Updated /);
  });

  it('stops polling while the tab is hidden and re-reads on return', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      vi.advanceTimersByTime(FLEET_POLL_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hands the decision back to the server when the read answers 403', async () => {
    fetchMock.mockResolvedValue(answer(fleet(), 403));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('treats a thrown fetch or a malformed body as a failed refresh', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByTestId('fleet-refresh-cue').textContent).toContain('Couldn’t refresh'),
    );
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nope: 1 }) });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('fleet-refresh-cue').textContent).toContain('Couldn’t refresh');
  });
});

describe('Cancel run (panels 6a/6b)', () => {
  it('opens on the safe button, cancels, says "you" on the last-stop line', async () => {
    const at = new Date(NOW + 1000).toISOString();
    cancelHostedRunAction.mockResolvedValue({
      ok: true,
      outcome: { dispatchRunId: 'run_1', closed: true, at },
    });
    fetchMock.mockResolvedValue(
      answer(
        fleet({
          ...EMPTY,
          lastStop: { kind: 'read', stop: { actorName: 'Me', action: 'cancel_hosted_run', at } },
        }),
      ),
    );
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the run of PAY-12' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Cancel this run?')).toBeTruthy();
    expect(within(dialog).getByText('PAY-12 · Refund flow')).toBeTruthy();
    expect(dialog.textContent).toContain('Ana started this run at');
    expect(document.activeElement?.textContent).toBe('Keep it running');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cancelHostedRunAction).toHaveBeenCalledWith('org_1', 'run_1');
    await waitFor(() =>
      expect(screen.getByTestId('fleet-last-stop').textContent).toMatch(/^Last stopped by you, /),
    );
  });

  it('Keep it running closes without a call; a run with no card or name reads in its own words', async () => {
    renderPage(
      fleet({
        hostedRuns: {
          kind: 'read',
          rows: [
            {
              id: 'run_9',
              projectName: 'Ops',
              card: null,
              dispatcherName: null,
              startedAt: ago(1),
              runUrl: '/runs?run=run_9',
            },
          ],
        },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the run of Ops' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('This run started at');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it running' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cancelHostedRunAction).not.toHaveBeenCalled();
  });

  it.each([
    [
      { ok: true, outcome: { dispatchRunId: 'run_1', closed: false, at: ago(0) } },
      'The run of PAY-12 had already ended.',
    ],
    [{ ok: false, code: 'notFound' }, 'That run is no longer live.'],
    [{ ok: false, code: 'failed' }, 'Couldn’t cancel the run of PAY-12. Try again.'],
    [
      { ok: false, code: 'forbidden' },
      'Only an owner or admin can stop this organization’s fleet work.',
    ],
  ])('says an outcome other than cancelled in a toast (%o)', async (outcome, text) => {
    cancelHostedRunAction.mockResolvedValue(outcome);
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the run of PAY-12' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText(text)).toBeTruthy();
    if ((outcome as { code?: string }).code === 'forbidden') expect(refresh).toHaveBeenCalled();
  });
});

describe('Hibernate (panels 7a–7c)', () => {
  it('tells the admin the owner will be told, then the row reads hibernating with no action', async () => {
    let settle: (value: unknown) => void = () => {};
    hibernateAgentAction.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Hibernate Ben’s agent' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Hibernate Ben’s agent?')).toBeTruthy();
    expect(dialog.textContent).toContain('Ben will be told');
    expect(document.activeElement?.textContent).toBe('Keep it running');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hibernate agent' }));
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Keep it running' }).hasAttribute('disabled'),
      ).toBe(true),
    );
    // Escape is inert while the stop is in flight.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    await act(async () => {
      settle({ ok: true, code: 'hibernated', at: new Date(NOW + 5_000).toISOString() });
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const row = screen.getAllByTestId('fleet-agent-row')[0]!;
    expect(row.textContent).toContain('Hibernating · since');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('says only the viewer can wake their own agent', async () => {
    const own = fleet();
    if (own.agentInstances.kind === 'read') {
      own.agentInstances.rows[0] = { ...own.agentInstances.rows[0]!, ownedByViewer: true };
    }
    renderPage(own);
    fireEvent.click(screen.getByRole('button', { name: 'Hibernate Ben’s agent' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Only you can wake, open or delete it.');
    expect(dialog.textContent).not.toContain('will be told');
  });

  it.each([
    [{ ok: true, code: 'alreadyResting' }, 'Ben’s agent was already resting.'],
    [
      { ok: true, code: 'inMotion' },
      'Ben’s agent is starting or changing state, so it was not hibernated. Try again in a moment.',
    ],
    [{ ok: false, code: 'notFound' }, 'That agent is no longer live.'],
    [{ ok: false, code: 'failed' }, 'Couldn’t hibernate Ben’s agent. Try again.'],
  ])('says an outcome other than hibernated in a toast (%o)', async (outcome, text) => {
    hibernateAgentAction.mockResolvedValue(outcome);
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Hibernate Ben’s agent' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hibernate agent' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(
      within(screen.getAllByTestId('fleet-agent-row')[0]!).getByRole('button', {
        name: 'Hibernate Ben’s agent',
      }),
    ).toBeTruthy();
  });
});

describe('Stop everything (panels 8a–9b)', () => {
  const PREVIEW = {
    ok: true as const,
    preview: { ciRuns: 2, ciContainers: 3, hostedRuns: 1, runningAgents: 0, indexContainers: 1 },
    countedAt: new Date(NOW).toISOString(),
  };

  async function openStopAll() {
    fireEvent.click(screen.getByTestId('fleet-stop-all'));
    return screen.findByRole('alertdialog');
  }

  it('counts first, shows the effects with zeros kept, then stops and keeps the result across a re-read', async () => {
    let settle: (value: unknown) => void = () => {};
    previewStopEverythingAction.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    stopEverythingAction.mockResolvedValue({ ok: true, result: done() });
    fetchMock.mockResolvedValue(answer(fleet(EMPTY)));
    renderPage();
    const dialog = await openStopAll();
    expect(within(dialog).getByTestId('stop-all-counting').textContent).toContain(
      'Counting what is running…',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Stop everything' }).hasAttribute('disabled'),
    ).toBe(true);
    await act(async () => settle(PREVIEW));
    const effects = await within(dialog).findByTestId('stop-all-effects');
    expect(within(effects).getByTestId('stop-all-effect-ci').textContent).toBe(
      '2CI jobs cancelled and 3 containers stopped',
    );
    expect(within(effects).getByTestId('stop-all-effect-agents').className).toContain(
      'text-(--el-text-secondary)',
    );
    expect(within(effects).getByTestId('stop-all-effect-index').textContent).toContain(
      'index job keeps running',
    );
    expect(dialog.textContent).toContain('The owners of hibernated agents are told.');
    expect(document.activeElement?.textContent).toBe('Cancel');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop everything' }));
    const result = await screen.findByTestId('fleet-stop-result');
    expect(result.getAttribute('data-partial')).toBe('false');
    expect(result.textContent).toContain('Everything was stopped');
    expect(result.textContent).toContain('2 CI jobs cancelled, 3 of 3 containers stopped');
    expect(result.textContent).toContain('Index jobs were left running.');
    expect(result.textContent).toMatch(/Stopped by you, today at /);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('fleet-stop-result')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stop result' }));
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();
  });

  it('names a partial failure path by path', async () => {
    previewStopEverythingAction.mockResolvedValue(PREVIEW);
    stopEverythingAction.mockResolvedValue({
      ok: true,
      result: done({ failures: { ci: 1, hosted: 1, agents: 2 } }),
    });
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    const dialog = await openStopAll();
    await within(dialog).findByTestId('stop-all-effects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop everything' }));
    const result = await screen.findByTestId('fleet-stop-result');
    expect(result.getAttribute('data-partial')).toBe('true');
    expect(result.textContent).toContain('Some work did not stop');
    expect(result.textContent).toContain('3 of 4 containers stopped');
    expect(result.textContent).toContain('1 of 2 agent runs ended');
    expect(result.textContent).toContain('1 of 3 running agents hibernated');
    expect(result.textContent).toContain('2 agents did not stop');
    expect(result.textContent).toContain('1 agent run did not end.');
  });

  it('refuses to confirm against counts nobody read, and Try again re-reads them', async () => {
    previewStopEverythingAction
      .mockResolvedValueOnce({ ok: false, code: 'failed' })
      .mockResolvedValueOnce({ ...PREVIEW, preview: { ...PREVIEW.preview, runningAgents: null } })
      .mockResolvedValueOnce({ ...PREVIEW, preview: { ...PREVIEW.preview, ciRuns: null } });
    renderPage();
    const dialog = await openStopAll();
    await within(dialog).findByTestId('stop-all-unreadable');
    expect(within(dialog).queryByRole('button', { name: 'Stop everything' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(previewStopEverythingAction).toHaveBeenCalledTimes(2));
    await within(dialog).findByTestId('stop-all-unreadable');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    const effects = await within(dialog).findByTestId('stop-all-effects');
    expect(within(effects).getByTestId('stop-all-effect-ci').textContent).toBe(
      '—CI jobs cancelled',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(stopEverythingAction).not.toHaveBeenCalled();
  });

  it('a refused preview closes the dialog and hands back to the server', async () => {
    previewStopEverythingAction.mockResolvedValue({ ok: false, code: 'forbidden' });
    renderPage();
    fireEvent.click(screen.getByTestId('fleet-stop-all'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('a failed stop says some of it may have stopped', async () => {
    previewStopEverythingAction.mockResolvedValue(PREVIEW);
    stopEverythingAction.mockResolvedValue({ ok: false, code: 'failed' });
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    const dialog = await openStopAll();
    await within(dialog).findByTestId('stop-all-effects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop everything' }));
    expect(await screen.findByText(/Couldn’t stop the fleet work\./)).toBeTruthy();
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();
  });
});

describe('edges', () => {
  it('every section’s Retry re-reads', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    renderPage(
      fleet({
        tiles: { kind: 'not_read' },
        hostedRuns: { kind: 'not_read' },
        agentInstances: { kind: 'not_read' },
        ciJobs: { kind: 'not_read' },
        indexJobs: { kind: 'not_read' },
        motirStops: { kind: 'not_read' },
      }),
    );
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(6);
    for (const retry of retries) fireEvent.click(retry);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('Escape closes each confirmation when nothing is in flight', async () => {
    previewStopEverythingAction.mockResolvedValue({ ok: false, code: 'failed' });
    renderPage();
    for (const open of [
      () => fireEvent.click(screen.getByRole('button', { name: 'Cancel the run of PAY-12' })),
      () => fireEvent.click(screen.getByRole('button', { name: 'Hibernate Ben’s agent' })),
      () => fireEvent.click(screen.getByTestId('fleet-stop-all')),
    ]) {
      open();
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    }
    fireEvent.click(screen.getByRole('button', { name: 'Hibernate Ben’s agent' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep it running' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(hibernateAgentAction).not.toHaveBeenCalled();
  });

  it('says yesterday, and an older stop by its day', () => {
    const yesterday = new Date(NOW);
    yesterday.setDate(yesterday.getDate() - 1);
    renderPage(
      fleet({
        lastStop: {
          kind: 'read',
          stop: { actorName: 'Ana', action: 'hibernate_agent', at: yesterday.toISOString() },
        },
      }),
    );
    expect(screen.getByTestId('fleet-last-stop').textContent).toMatch(/Ana, yesterday at /);
    cleanup();
    renderPage(
      fleet({
        lastStop: {
          kind: 'read',
          stop: { actorName: 'Ana', action: 'hibernate_agent', at: ago(5 * 24 * 60) },
        },
      }),
    );
    expect(screen.getByTestId('fleet-last-stop').textContent).not.toMatch(/today|yesterday/);
  });

  it('words an unknown state, workload or cause generically, and a card with no title', async () => {
    renderPage(
      fleet({
        hostedRuns: {
          kind: 'read',
          rows: [
            {
              id: 'run_3',
              projectName: 'Ops',
              card: { key: 'OPS-1', title: null },
              dispatcherName: 'Ana',
              startedAt: ago(1),
              runUrl: '/runs?run=run_3',
            },
          ],
        },
        agentInstances: {
          kind: 'read',
          rows: [
            {
              id: 'inst_9',
              ownerName: 'Cy',
              profileId: 'p',
              projectName: null,
              state: 'mystery',
              since: ago(1),
              ownedByViewer: false,
            },
            {
              id: 'inst_10',
              ownerName: 'Di',
              profileId: 'p',
              projectName: null,
              state: 'running',
              since: ago(1),
              ownedByViewer: false,
            },
          ],
        },
        ciJobs: {
          kind: 'read',
          inFlight: 0,
          waiting: { planLimit: 0, poolFull: 0, other: 1 },
          rows: [
            {
              id: 'job_9',
              repository: 'acme/x',
              workflowName: 'CI',
              jobName: null,
              projectName: 'Ops',
              queuedAt: ago(1),
              state: 'waiting',
              waitingCause: null,
              actionsUrl: 'https://github.com/acme/x/actions/runs/9',
            },
          ],
        },
        motirStops: {
          kind: 'read',
          since: ago(60),
          entries: [
            {
              decidedAt: ago(1),
              workload: 'something_new' as never,
              reason: 'no_record',
              completed: true,
            },
          ],
        },
      }),
    );
    expect(screen.getByTestId('fleet-agents').textContent).toContain('Busy');
    expect(screen.getByTestId('fleet-ci').textContent).toContain('Waiting · other');
    expect(screen.getByTestId('fleet-motir-stops').textContent).toContain('Machine');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the run of OPS-1' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('OPS-1 ·')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Hibernate Di’s agent' }));
    dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('p · A deleted project · ');
  });
});

describe('the read’s ordering', () => {
  it('a stale answer never overwrites a newer one', async () => {
    let first: (value: unknown) => void = () => {};
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
      .mockResolvedValueOnce(answer(fleet()));
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => first(answer(fleet(EMPTY))));
    expect(screen.queryByText('No agent run is live.')).toBeNull();
    expect(screen.getAllByTestId('fleet-hosted-row')).toHaveLength(1);
  });

  it('a stale failure or body is dropped too', async () => {
    let first: (value: unknown) => void = () => {};
    let body: (value: unknown) => void = () => {};
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
      .mockReturnValueOnce(
        Promise.resolve({ ok: true, status: 200, json: () => new Promise((r) => (body = r)) }),
      )
      .mockResolvedValueOnce(answer(fleet()));
    renderPage();
    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    fireEvent.click(refreshButton);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      first(Promise.reject(new Error('late')));
      body({ fleet: fleet(EMPTY) });
    });
    expect(screen.queryByText('No agent run is live.')).toBeNull();
    expect(screen.getByTestId('fleet-refresh-cue').textContent).not.toContain('Couldn’t');
  });

  it('a page opened in a hidden tab does not poll until it is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderPage();
    await act(async () => {
      vi.advanceTimersByTime(FLEET_POLL_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the stop result survives a reload (criterion 4)', () => {
  it('the server render shows no stored result (no hydration mismatch)', async () => {
    window.sessionStorage.setItem('motir.orgFleet.stopResult.org_1', JSON.stringify(done()));
    const { renderToString } = await import('react-dom/server');
    const { NextIntlClientProvider } = await import('next-intl');
    const { enMessages } = await import('../helpers/renderWithIntl');
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ToastProvider>
          <FleetClient
            orgId="org_1"
            orgName="Acme"
            initialFleet={fleet()}
            initialReadAt={new Date(NOW).toISOString()}
            canStop
          />
        </ToastProvider>
      </NextIntlClientProvider>,
    );
    expect(html).toContain('fleet-tiles');
    expect(html).not.toContain('fleet-stop-result');
  });

  it('a remount shows the stored result until Dismiss, and only for its own org', async () => {
    previewStopEverythingAction.mockResolvedValue({
      ok: true,
      preview: { ciRuns: 1, ciContainers: 1, hostedRuns: 0, runningAgents: 0, indexContainers: 0 },
      countedAt: new Date(NOW).toISOString(),
    });
    stopEverythingAction.mockResolvedValue({ ok: true, result: done() });
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    fireEvent.click(screen.getByTestId('fleet-stop-all'));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByTestId('stop-all-effects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop everything' }));
    await screen.findByTestId('fleet-stop-result');

    cleanup();
    renderPage();
    expect(await screen.findByTestId('fleet-stop-result')).toBeTruthy();

    cleanup();
    render(
      <ToastProvider>
        <FleetClient
          orgId="org_2"
          orgName="Other"
          initialFleet={fleet()}
          initialReadAt={new Date(NOW).toISOString()}
          canStop
        />
      </ToastProvider>,
    );
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();

    cleanup();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss the stop result' }));
    cleanup();
    renderPage();
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();
  });

  it('ignores a malformed stored value, and keeps working when storage throws', async () => {
    window.sessionStorage.setItem('motir.orgFleet.stopResult.org_1', '{not json');
    renderPage();
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();
    cleanup();
    window.sessionStorage.setItem('motir.orgFleet.stopResult.org_1', '{"x":1}');
    renderPage();
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();
    cleanup();

    const blocked = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    previewStopEverythingAction.mockResolvedValue({
      ok: true,
      preview: { ciRuns: 1, ciContainers: 1, hostedRuns: 0, runningAgents: 0, indexContainers: 0 },
      countedAt: new Date(NOW).toISOString(),
    });
    stopEverythingAction.mockResolvedValue({ ok: true, result: done() });
    fetchMock.mockResolvedValue(answer(fleet()));
    renderPage();
    fireEvent.click(screen.getByTestId('fleet-stop-all'));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByTestId('stop-all-effects');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop everything' }));
    await screen.findByTestId('fleet-stop-result');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the stop result' }));
    expect(screen.queryByTestId('fleet-stop-result')).toBeNull();
    blocked.mockRestore();
  });
});
