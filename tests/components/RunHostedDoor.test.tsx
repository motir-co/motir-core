// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { HostedRunProvider } from '@/app/(authed)/items/[key]/_components/HostedRunProvider';
import { RunHostedButton } from '@/app/(authed)/items/[key]/_components/RunHostedButton';
import { RunSection } from '@/app/(authed)/items/[key]/_components/RunSection';
import { announceRunsChanged } from '@/components/hosted/runsChangedSignal';
import type { DispatchRunDto, DispatchRunListItemDto } from '@/lib/dto/dispatchRuns';

// THE RUN HOSTED DOOR (Story MOTIR-683 · MOTIR-691) — the Run section header's
// model picker and Run hosted, what a refusal says in the body, and Cancel run
// while a hosted run is live. Mounted exactly as the late stack mounts it: one
// provider around the header door and the section body.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

type Handler = (init?: RequestInit) => { status: number; body: unknown };
let routes: Record<string, Handler> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const key = `${method} ${url.split('?')[0]}`;
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
const START = 'POST /api/work-items/PROD-42/hosted-runs';
const HISTORY = 'GET /api/work-items/PROD-42/dispatch-runs';

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockClear();
  routes = {
    [MODELS]: () => ({
      status: 200,
      body: {
        models: [
          { id: 'claude-opus-5-5', provider: 'anthropic' },
          { id: 'claude-sonnet-5', provider: 'anthropic' },
        ],
        default: 'claude-sonnet-5',
      },
    }),
  };
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    createdById: 'usr_1',
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

async function mount({
  ready = true,
  openBlockers = 0,
  runs = [],
  scopeRun = null,
}: {
  ready?: boolean;
  openBlockers?: number;
  runs?: DispatchRunDto[];
  scopeRun?: DispatchRunListItemDto | null;
} = {}) {
  render(
    <HostedRunProvider itemKey="PROD-42" ready={ready} openBlockers={openBlockers}>
      <RunHostedButton />
      <RunSection
        initialRuns={runs}
        initialCursor={null}
        itemKey="PROD-42"
        formattedTimes={Object.fromEntries(runs.map((r) => [r.id, '26 Sep']))}
        scopeRun={scopeRun}
        scopeRunTime={scopeRun ? '26 Sep' : null}
      />
    </HostedRunProvider>,
  );
  // The list read resolves in an effect.
  await act(async () => {});
}

describe('the door on a ready card', () => {
  it('shows the picker with the DEFAULT preselected, and Run hosted enabled', async () => {
    await mount();
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain(
      'claude-sonnet-5',
    );
    expect((screen.getByTestId('run-hosted') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('run-hosted').textContent).toBe('Run');
  });

  it('with no default, the FIRST offered model is preselected', async () => {
    routes[MODELS] = () => ({
      status: 200,
      body: { models: [{ id: 'claude-opus-5-5', provider: 'anthropic' }], default: null },
    });
    await mount();
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain(
      'claude-opus-5-5',
    );
  });

  it('Run hosted starts the run with the selected model, then refetches the history and refreshes the page', async () => {
    routes[START] = () => ({ status: 201, body: { dispatchRunId: 'run_new', created: true } });
    routes[HISTORY] = () => ({
      status: 200,
      body: {
        runs: [run({ id: 'run_new', origin: 'hosted', status: 'running', endedAt: null, seq: 0 })],
        nextCursor: null,
      },
    });
    routes['GET /api/dispatch-runs/run_new'] = () => ({ status: 404, body: null });
    routes['GET /api/dispatch-runs/run_new/machine-time'] = () => ({
      status: 200,
      body: { billableSeconds: 0, settled: false },
    });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-hosted'));
    });
    const [, init] = calls(START)[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'claude-sonnet-5' });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls(HISTORY)).toHaveLength(1));
    // The island now holds the new, live hosted run — so the header holds Cancel run.
    await waitFor(() => expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy());
  });
});

describe('a hosted start made OUTSIDE the provider (MOTIR-6930)', () => {
  it('an announced start on THIS card refetches the history, without a second page refresh; another card’s is ignored', async () => {
    routes[HISTORY] = () => ({
      status: 200,
      body: {
        runs: [run({ id: 'run_fix', origin: 'hosted', status: 'running', endedAt: null, seq: 0 })],
        nextCursor: null,
      },
    });
    routes['GET /api/dispatch-runs/run_fix'] = () => ({ status: 404, body: null });
    routes['GET /api/dispatch-runs/run_fix/machine-time'] = () => ({
      status: 200,
      body: { billableSeconds: 0, settled: false },
    });
    await mount();

    // Another card's start is not this Run section's business.
    await act(async () => {
      announceRunsChanged('PROD-7');
    });
    expect(calls(HISTORY)).toHaveLength(0);

    // The To fix banner's start on this card: the banner refreshed the server surfaces
    // itself, so the provider only ticks the island.
    await act(async () => {
      announceRunsChanged('PROD-42');
    });
    await waitFor(() => expect(calls(HISTORY)).toHaveLength(1));
    expect(refresh).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy());
  });
});

describe('the door, disabled', () => {
  it('a card that is not ready keeps the door, disabled, with its reason in the body', async () => {
    await mount({ ready: false, openBlockers: 2 });
    expect((screen.getByTestId('run-hosted') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hosted-not-ready').textContent).toBe(
      'Run is available once this work item is ready — it has 2 open blockers.',
    );
  });

  it('UNAVAILABLE says so, offers Try again, and disables Run hosted', async () => {
    routes[MODELS] = () => ({ status: 503, body: { code: 'hosted_models_unavailable' } });
    await mount();
    expect((screen.getByTestId('run-hosted') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain(
      'Models unavailable',
    );
    const notice = screen.getByTestId('hosted-models-unavailable');
    expect(notice.textContent).toContain('Couldn’t load the models, so Run is off');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(calls(MODELS)).toHaveLength(2);
  });

  it('EMPTY says so with no retry — there is nothing to retry', async () => {
    routes[MODELS] = () => ({ status: 200, body: { models: [], default: null } });
    await mount();
    expect((screen.getByTestId('run-hosted') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hosted-models-empty').textContent).toContain(
      'No model can run this work item right now',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('refusals live on the door — none of them starts anything', () => {
  it('422: the model-refused notice, and the list is read again in place', async () => {
    routes[START] = () => ({ status: 422, body: { code: 'hosted_model_not_offered' } });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-hosted'));
    });
    expect(screen.getByTestId('hosted-refused-modelNotOffered').textContent).toContain(
      'claude-sonnet-5 is no longer offered.',
    );
    expect(calls(MODELS)).toHaveLength(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(calls(HISTORY)).toHaveLength(0);
  });

  it('402: out of credits', async () => {
    routes[START] = () => ({ status: 402, body: { code: 'hosted_run_out_of_credits' } });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-hosted'));
    });
    expect(screen.getByTestId('hosted-refused-outOfCredits').textContent).toContain(
      'Not started — your organization is out of credits.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('409 not writable: one line per repository, the reason verbatim, and a link to its row', async () => {
    const reason =
      'Motir agent runs on acme/api need Motir Integration’s updated permissions — an owner of acme accepts them on GitHub';
    routes[START] = () => ({
      status: 409,
      body: {
        code: 'hosted_repository_not_writable',
        repositories: [
          { repository: 'acme/api', reason, fix: 'accept_permissions', fixUrl: 'https://x' },
        ],
        totalRepositories: 2,
      },
    });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-hosted'));
    });
    const notice = screen.getByTestId('hosted-refused-notWritable');
    expect(notice.textContent).toContain(
      'Not started — Motir’s app can’t write to 1 of this run’s 2 repositories.',
    );
    expect(notice.textContent).toContain(reason);
    const link = screen.getByRole('link', { name: 'Open in Repositories' });
    expect(link.getAttribute('href')).toBe('/settings/project/repositories#repository-acme%2Fapi');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('the header holds exactly one thing', () => {
  it('a LIVE HOSTED run: Cancel run, and no picker', async () => {
    routes['GET /api/dispatch-runs/run_1'] = () => ({ status: 404, body: null });
    routes['GET /api/dispatch-runs/run_1/machine-time'] = () => ({
      status: 200,
      body: { billableSeconds: 12, settled: false },
    });
    await mount({ runs: [run({ origin: 'hosted', status: 'running', endedAt: null })] });
    expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy();
    expect(screen.queryByTestId('hosted-model-picker')).toBeNull();
  });

  it('a LIVE LOCAL run: nothing — it runs on somebody’s machine', async () => {
    // Live under MOTIR-6526's rule: a local run is alive while it heartbeats.
    await mount({
      runs: [run({ status: 'running', endedAt: null, lastHeartbeatAt: new Date().toISOString() })],
    });
    expect(screen.queryByTestId('run-hosted-door')).toBeNull();
    expect(screen.queryByTestId('hosted-run-cancel')).toBeNull();
  });

  it('after a hosted run has ended the door reads Run hosted again', async () => {
    routes['GET /api/dispatch-runs/run_1'] = () => ({ status: 404, body: null });
    routes['GET /api/dispatch-runs/run_1/machine-time'] = () => ({
      status: 200,
      body: { billableSeconds: 60, settled: true },
    });
    await mount({ runs: [run({ origin: 'hosted', status: 'failed' })] });
    expect(screen.getByTestId('run-hosted').textContent).toBe('Run again');
  });

  it('a PARENT card whose scope run is a live hosted run offers Cancel run', async () => {
    const {
      cards: _cards,
      seq: _seq,
      projectId: _p,
      ...base
    } = run({
      id: 'run_scope',
      origin: 'hosted',
      status: 'running',
      endedAt: null,
    });
    const scopeRun: DispatchRunListItemDto = {
      ...base,
      scopeWorkItemId: 'itm_parent',
      scopeLabel: 'PROD-42',
      targetKey: 'PROD-42',
      targetWorkItemId: 'itm_parent',
      otherCardCount: 2,
      cardCount: 2,
      legs: {
        queued: 1,
        running: 1,
        integrated: 0,
        implemented: 0,
        failed: 0,
        replanned: 0,
        skipped: 0,
        not_reached: 0,
      },
    };
    await mount({ scopeRun });
    expect(screen.getByTestId('hosted-run-cancel')).toBeTruthy();
  });
});

describe('cancel', () => {
  it('confirming Cancel run posts the cancel, then refetches the history and refreshes', async () => {
    routes['GET /api/dispatch-runs/run_1'] = () => ({ status: 404, body: null });
    routes['GET /api/dispatch-runs/run_1/machine-time'] = () => ({
      status: 200,
      body: { billableSeconds: 12, settled: false },
    });
    routes['POST /api/dispatch-runs/run_1/cancel'] = () => ({
      status: 200,
      body: { dispatchRunId: 'run_1' },
    });
    routes[HISTORY] = () => ({
      status: 200,
      body: { runs: [run({ origin: 'hosted', status: 'cancelled' })], nextCursor: null },
    });
    await mount({ runs: [run({ origin: 'hosted', status: 'running', endedAt: null })] });
    fireEvent.click(screen.getByTestId('hosted-run-cancel'));
    expect(screen.getByRole('alertdialog', { name: 'Cancel this run?' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('hosted-run-cancel-confirm'));
    });
    expect(calls('POST /api/dispatch-runs/run_1/cancel')).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(calls(HISTORY)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('run-hosted').textContent).toBe('Run again'));
  });
});
