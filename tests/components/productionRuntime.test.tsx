// @vitest-environment happy-dom
// MOTIR-12109 — the Production panel's live app operations (design MOTIR-12101,
// `design/hosting/production--live-app-ops.mock.html`): Health, Crash events with
// Roll back, and the Logs view, rendered with the real `en` catalogue and the two
// runtime routes stubbed at `fetch`. Plus the pure words module and the thin
// client behind them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { ProductionHealthDto, ProductionHealthEventDto } from '@/lib/dto/productionHealth';
import type { ProductionLogLineDto, ProductionLogsDto } from '@/lib/dto/productionLogs';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import { HEALTH_REFRESH_MS, ProductionPanel } from '@/components/hosting/ProductionPanel';
import { FILTER_DEBOUNCE_MS } from '@/components/hosting/ProductionLogsView';
import { productionRuntimeClient } from '@/lib/hosting/productionRuntimeClient';
import {
  eventReasonMessage,
  formatStateDuration,
  isOutOfMemory,
  maskSegments,
  rangeSince,
} from '@/lib/hosting/productionRuntimeWords';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, prefetch: vi.fn() }),
  usePathname: () => '/settings/project/production',
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = new Date('2026-11-23T15:00:00Z');
const BASE = '/api/projects/ACME/repositories/row-1/production';
const SHA_LIVE = `aaaaaaa${'1'.repeat(33)}`;
const SHA_PREV = `bbbbbbb${'2'.repeat(33)}`;

function release(overrides: Partial<HostedReleaseDto>): HostedReleaseDto {
  return {
    id: 'rel-live',
    applicationId: 'app-1',
    commitSha: SHA_LIVE,
    ref: null,
    commitSubject: null,
    pullRequestNumber: null,
    requestedBy: null,
    cause: 'merge',
    state: 'live',
    artifactRef: null,
    providerReleaseId: null,
    failureReason: null,
    usageSeconds: null,
    restoredBy: null,
    restoredAt: null,
    createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    liveAt: null,
    endedAt: null,
    ...overrides,
  };
}

const LIVE = release({});
const PREV = release({ id: 'rel-prev', commitSha: SHA_PREV, state: 'replaced' });

function panel(overrides: Partial<ProductionPanelDto> = {}): ProductionPanelDto {
  return {
    application: { id: 'app-1', target: 'fly', productionAddress: 'shop--acme.motir.site' },
    currentRelease: LIVE,
    previousRelease: PREV,
    releases: [LIVE, PREV],
    nextCursor: null,
    isAdministrator: true,
    canRollback: true,
    ...overrides,
  };
}

function health(overrides: Partial<ProductionHealthDto> = {}): ProductionHealthDto {
  return {
    state: 'healthy',
    since: new Date(NOW.getTime() - (2 * 60 + 58) * 60_000).toISOString(),
    condition: null,
    healthCheckPath: '/api/health',
    events: [],
    ...overrides,
  };
}

function event(overrides: Partial<ProductionHealthEventDto> = {}): ProductionHealthEventDto {
  return {
    id: 'ev-1',
    occurredAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
    kind: 'crashed',
    reason: 'out of memory',
    lastLogLines: [
      { at: NOW.toISOString(), stream: 'app', message: 'FATAL heap limit' },
      { at: NOW.toISOString(), stream: 'platform', message: 'restarting machine' },
    ],
    releaseId: LIVE.id,
    release: { commitSha: SHA_LIVE, state: 'live' },
    ...overrides,
  };
}

function line(message: string, stream: 'app' | 'platform' = 'app'): ProductionLogLineDto {
  return { at: NOW.toISOString(), stream, message };
}

function logs(overrides: Partial<ProductionLogsDto> = {}): ProductionLogsDto {
  return { lines: [line('GET / 200')], cursor: null, state: 'ok', ...overrides };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

type Handler = (url: URL) => Promise<Response> | Response;

/** Routes the runtime reads to their handlers; the release routes to `other`. */
function stubFetch({
  health: onHealth = () => respond(200, health()),
  logs: onLogs = () => respond(200, logs()),
  other = () => respond(500, {}),
}: { health?: Handler; logs?: Handler; other?: Handler } = {}) {
  const calls: URL[] = [];
  const mock = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://motir.test');
    calls.push(url);
    if (url.pathname === `${BASE}/health`) return onHealth(url);
    if (url.pathname === `${BASE}/logs`) return onLogs(url);
    return other(url);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls, logCalls: () => calls.filter((u) => u.pathname.endsWith('/logs')) };
}

function render(
  initial: ProductionPanelDto = panel(),
  initialHealth: ProductionHealthDto | null = health(),
  focusEventId: string | null = null,
) {
  return renderWithIntl(
    <ProductionPanel
      projectKey="ACME"
      repositoryId="row-1"
      repositoryName="shop"
      initial={initial}
      initialHealth={initialHealth}
      focusEventId={focusEventId}
    />,
    { now: NOW },
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the layout', () => {
  it('pairs Current release and Health in one row, then Crash events and Logs below', async () => {
    stubFetch();
    render(panel(), health({ events: [event()] }));
    await flush();
    const row = screen.getByTestId('production-summary-row');
    expect(row.className).toContain('lg:grid-cols-2');
    expect(within(row).getByTestId('production-current-release')).toBeTruthy();
    expect(within(row).getByTestId('production-health')).toBeTruthy();
    const order = [
      'production-summary-row',
      'production-crash-events',
      'production-logs',
      'production-release-history',
    ].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i += 1) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('with no release: the empty state spans the row, no Health or events, and Logs say when they start', async () => {
    const { mock } = stubFetch();
    render(
      panel({ application: null, currentRelease: null, previousRelease: null, releases: [] }),
      null,
    );
    await flush();
    expect(screen.getByTestId('production-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('production-health')).toBeNull();
    expect(screen.queryByTestId('production-crash-events')).toBeNull();
    expect(screen.getByTestId('production-logs').textContent).toContain(
      'Logs appear here once the first release is live.',
    );
    expect(mock).not.toHaveBeenCalled();
  });
});

describe('the health state', () => {
  const cases = [
    ['healthy', 'Healthy', 'Answering its health check at /api/health.'],
    ['unhealthy', 'Unhealthy', 'Its health check at /api/health has failed twice in a row.'],
    [
      'suspended',
      'Suspended',
      'Asleep because nothing has asked for it. The next request wakes it.',
    ],
    ['crashed', 'Crashed', 'The process stopped. Fly is restarting it.'],
  ] as const;

  for (const [state, word, text] of cases) {
    it(`draws ${state} with its own pill, its line, and how long it has held`, async () => {
      stubFetch();
      render(panel(), health({ state }));
      await flush();
      const card = screen.getByTestId('production-health');
      const pill = within(card).getByTestId('production-health-pill');
      expect(pill.getAttribute('data-health-state')).toBe(state);
      expect(pill.textContent).toBe(word);
      expect(within(card).getByTestId('production-health-line').textContent).toBe(text);
      const since = within(card).getByTestId('production-health-since');
      expect(since.textContent).toBe(`${word} for 2 hr 58 min`);
      expect(since.getAttribute('title')).toBeTruthy();
    });
  }

  it('says out of memory when the newest event is one, and names the target', async () => {
    stubFetch();
    render(panel(), health({ state: 'crashed', events: [event()] }));
    await flush();
    expect(screen.getByTestId('production-health-line').textContent).toBe(
      'The process was stopped: it ran out of memory. Fly is restarting it.',
    );
  });

  it('names the release rolling out while deploying, and says so without one', async () => {
    stubFetch();
    const building = release({
      id: 'rel-new',
      commitSha: `ccccccc${'3'.repeat(33)}`,
      state: 'building',
    });
    render(panel({ releases: [building, LIVE, PREV] }), health({ state: 'deploying' }));
    await flush();
    expect(screen.getByTestId('production-health-line').textContent).toBe(
      'Release ccccccc is rolling out. The current release keeps serving until it is live.',
    );
    cleanup();
    stubFetch();
    render(panel(), health({ state: 'deploying' }));
    await flush();
    expect(screen.getByTestId('production-health-line').textContent).toContain(
      'A new release is rolling out.',
    );
  });

  it('keeps the last state beside the probe-unreachable note, never as a sixth state', async () => {
    stubFetch();
    render(panel(), health({ state: 'healthy', condition: 'probe_unreachable' }));
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Healthy');
    expect(screen.getByTestId('production-health-unreachable').textContent).toBe(
      'Motir can’t reach shop--acme.motir.site to check it. This is the last state Motir saw; the app itself may be fine.',
    );
    cleanup();
    stubFetch();
    render(
      panel({ application: { id: 'app-1', target: 'fly', productionAddress: null } }),
      health({ condition: 'probe_unreachable' }),
    );
    await flush();
    expect(screen.getByTestId('production-health-unreachable').textContent).toContain(
      'Motir can’t reach this app to check it.',
    );
  });

  it('says the first check is pending before the first probe', async () => {
    stubFetch();
    render(panel(), health({ state: null, since: null }));
    await flush();
    expect(screen.queryByTestId('production-health-pill')).toBeNull();
    expect(screen.getByTestId('production-health').textContent).toContain(
      'Motir hasn’t checked this app yet.',
    );
  });

  it('reads health itself when the server could not, and offers Try again on a failure', async () => {
    let fail = true;
    stubFetch({ health: () => (fail ? respond(500, {}) : respond(200, health())) });
    render(panel(), null);
    expect(screen.getByTestId('production-health').textContent).toContain('Checking health…');
    await flush();
    const card = screen.getByTestId('production-health');
    expect(within(card).getByRole('alert').textContent).toContain(
      'Couldn’t read this app’s health.',
    );
    fail = false;
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Healthy');
  });

  it('re-reads every minute, and a failed quiet re-read keeps the last state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    let answer: Response | (() => Response) = () => respond(200, health({ state: 'unhealthy' }));
    stubFetch({ health: () => (typeof answer === 'function' ? answer() : answer) });
    render();
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Healthy');
    await act(async () => {
      vi.advanceTimersByTime(HEALTH_REFRESH_MS);
    });
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Unhealthy');
    answer = () => respond(503, {});
    await act(async () => {
      vi.advanceTimersByTime(HEALTH_REFRESH_MS);
    });
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Unhealthy');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('drops a late health answer that a newer one overtook', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const first = deferred();
    let n = 0;
    stubFetch({
      health: () => {
        n += 1;
        return n === 1 ? first.promise : respond(200, health({ state: 'suspended' }));
      },
    });
    render(panel(), null);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(HEALTH_REFRESH_MS);
    });
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Suspended');
    first.resolve(respond(200, health({ state: 'crashed' })));
    await flush();
    expect(screen.getByTestId('production-health-pill').textContent).toBe('Suspended');
  });
});

describe('crash events', () => {
  it('says so when there are none', async () => {
    stubFetch();
    render();
    await flush();
    expect(screen.getByTestId('production-crash-events').textContent).toContain(
      'No crashes recorded for this app.',
    );
  });

  it('words each reason, names the release, and offers Roll back on the serving release only', async () => {
    stubFetch();
    render(
      panel(),
      health({
        state: 'unhealthy',
        events: [
          event({ id: 'e1', kind: 'health_check_failed', reason: 'HTTP 503', lastLogLines: [] }),
          event({ id: 'e2', kind: 'health_check_failed', reason: 'timed out', lastLogLines: [] }),
          event({ id: 'e3', reason: 'exit code 137' }),
          event({
            id: 'e4',
            reason: 'killed',
            releaseId: PREV.id,
            release: { commitSha: SHA_PREV, state: 'replaced' },
          }),
          event({ id: 'e5', reason: 'out of memory', releaseId: null, release: null }),
        ],
      }),
    );
    await flush();
    const rows = screen.getAllByTestId('production-crash-event');
    expect(rows.map((r) => within(r).getByTestId('production-crash-reason').textContent)).toEqual([
      'Health check failed: HTTP 503',
      'Health check failed: timed out',
      'Exited with code 137',
      'Exited',
      'Out of memory',
    ]);
    expect(rows[0]!.getAttribute('data-event-kind')).toBe('health_check_failed');
    expect(rows[2]!.textContent).toContain('Release aaaaaaa');
    expect(rows[3]!.textContent).toContain('Release bbbbbbb');
    expect(rows[4]!.textContent).not.toContain('Release');
    expect(rows.map((r) => within(r).queryByTestId('production-crash-rollback') !== null)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('opens the shipped confirmation from an event’s Roll back, and re-reads health after it', async () => {
    const { calls } = stubFetch({
      other: (url) =>
        url.pathname === `${BASE}/rollback`
          ? respond(
              200,
              panel({ currentRelease: PREV, previousRelease: null, releases: [PREV, LIVE] }),
            )
          : respond(500, {}),
    });
    render(panel(), health({ state: 'crashed', events: [event()] }));
    await flush();
    fireEvent.click(screen.getByTestId('production-crash-rollback'));
    const dialog = screen.getByTestId('production-rollback-dialog');
    expect(dialog.textContent).toContain('Leaving');
    const before = calls.filter((u) => u.pathname.endsWith('/health')).length;
    fireEvent.click(screen.getByTestId('production-rollback-confirm'));
    await flush();
    expect(refresh).toHaveBeenCalled();
    expect(calls.filter((u) => u.pathname.endsWith('/health')).length).toBe(before + 1);
  });

  it('reads Rolled back since on an event whose release was rolled back, with no Roll back', async () => {
    stubFetch();
    render(
      panel(),
      health({
        events: [event({ release: { commitSha: SHA_LIVE, state: 'rolled_back' } })],
      }),
    );
    await flush();
    expect(screen.getByTestId('production-crash-rolled-back').textContent).toBe(
      'Rolled back since',
    );
    expect(screen.queryByTestId('production-crash-rollback')).toBeNull();
  });

  it('gives a member no Roll back, and an administrator without an earlier release a disabled one', async () => {
    stubFetch();
    render(panel({ isAdministrator: false, canRollback: false }), health({ events: [event()] }));
    await flush();
    expect(screen.queryByTestId('production-crash-rollback')).toBeNull();
    cleanup();
    stubFetch();
    render(panel({ previousRelease: null, canRollback: false }), health({ events: [event()] }));
    await flush();
    expect((screen.getByTestId('production-crash-rollback') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows and hides the last lines before it, collapsed by default', async () => {
    stubFetch();
    render(panel(), health({ events: [event()] }));
    await flush();
    const row = screen.getByTestId('production-crash-event');
    const toggle = within(row).getByRole('button', { name: 'Show the last 2 lines before it' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(row).queryByTestId('production-log-line')).toBeNull();
    fireEvent.click(toggle);
    expect(within(row).getAllByTestId('production-log-line')).toHaveLength(2);
    fireEvent.click(within(row).getByRole('button', { name: 'Hide the last lines' }));
    expect(within(row).queryByTestId('production-log-line')).toBeNull();
  });

  it('opens and scrolls to the event a notification named', async () => {
    stubFetch();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(panel(), health({ events: [event({ id: 'ev-9' })] }), 'ev-9');
    await flush();
    expect(scrollIntoView).toHaveBeenCalled();
    const row = screen.getByTestId('production-crash-event');
    expect(row.id).toBe('production-event-ev-9');
    expect(within(row).getAllByTestId('production-log-line')).toHaveLength(2);
  });
});

describe('the logs view', () => {
  it('reads the last hour by default and draws each line: time, stream and message', async () => {
    const { logCalls } = stubFetch({
      logs: () => respond(200, logs({ lines: [line('GET / 200'), line('started', 'platform')] })),
    });
    render();
    expect(screen.getByTestId('production-logs').textContent).toContain('Loading lines…');
    await flush();
    const [first] = logCalls();
    const since = new Date(first!.searchParams.get('since')!);
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(Date.now() - since.getTime()).toBeLessThan(3_600_000 + 60_000);
    expect(first!.searchParams.get('q')).toBeNull();
    const rows = screen.getAllByTestId('production-log-line');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain('platform');
    expect(screen.getByRole('list', { name: 'Log lines' })).toBeTruthy();
    expect(screen.queryByTestId('production-logs-masked-note')).toBeNull();
  });

  it('draws the mask as a token, keeps the text byte for byte, and says what it is', async () => {
    stubFetch({ logs: () => respond(200, logs({ lines: [line('DATABASE_URL=*** ok')] })) });
    render();
    await flush();
    expect(screen.getByTestId('production-log-message').textContent).toBe('DATABASE_URL=*** ok');
    expect(screen.getByTestId('production-log-mask').textContent).toBe('***');
    expect(screen.getByTestId('production-logs-masked-note').textContent).toContain(
      'is shown as ***',
    );
  });

  it('collapses a line over 120 characters behind its arrow, and a short line has none', async () => {
    const long = `Error: ${'x'.repeat(130)}`;
    stubFetch({ logs: () => respond(200, logs({ lines: [line(long), line('short')] })) });
    render();
    await flush();
    const [longRow, shortRow] = screen.getAllByTestId('production-log-line');
    expect(longRow!.getAttribute('data-long')).toBe('true');
    expect(within(shortRow!).queryByRole('button')).toBeNull();
    const arrow = within(longRow!).getByRole('button', { name: 'Show the full line' });
    expect(arrow.getAttribute('aria-expanded')).toBe('false');
    expect(within(longRow!).getByTestId('production-log-message').className).toContain('truncate');
    fireEvent.click(arrow);
    const open = within(longRow!).getByRole('button', { name: 'Collapse this line' });
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(within(longRow!).getByTestId('production-log-message').className).toContain(
      'whitespace-pre-wrap',
    );
  });

  it('re-reads for another range', async () => {
    const { logCalls } = stubFetch();
    render();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await flush();
    const last = logCalls().at(-1)!;
    const since = new Date(last.searchParams.get('since')!);
    expect(Date.now() - since.getTime()).toBeGreaterThan(6 * 24 * 3_600_000);
  });

  it('reads the filter once typing pauses, and says when nothing matches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logCalls } = stubFetch({
      logs: (url) => respond(200, logs({ lines: url.searchParams.get('q') ? [] : [line('a')] })),
    });
    render();
    await flush();
    const before = logCalls().length;
    fireEvent.change(screen.getByTestId('production-logs-filter'), { target: { value: 'tim' } });
    fireEvent.change(screen.getByTestId('production-logs-filter'), {
      target: { value: 'timeout' },
    });
    await act(async () => {
      vi.advanceTimersByTime(FILTER_DEBOUNCE_MS - 1);
    });
    expect(logCalls().length).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(logCalls().length).toBe(before + 1);
    expect(logCalls().at(-1)!.searchParams.get('q')).toBe('timeout');
    expect(screen.getByTestId('production-logs-empty').textContent).toBe(
      'No lines match “timeout” in the last hour.',
    );
  });

  it('says so when the range holds no lines', async () => {
    stubFetch({ logs: () => respond(200, logs({ lines: [] })) });
    render();
    await flush();
    expect(screen.getByTestId('production-logs-empty').textContent).toBe(
      'No lines in the last hour.',
    );
  });

  it('pages through Show earlier lines with the cursor, and says so when a page fails', async () => {
    let page = 0;
    const { logCalls } = stubFetch({
      logs: (url) => {
        page += 1;
        if (!url.searchParams.get('cursor'))
          return respond(200, logs({ lines: [line('new')], cursor: 'c1' }));
        if (page === 2) return respond(200, logs({ lines: [line('old')], cursor: 'c2' }));
        return respond(500, {});
      },
    });
    render();
    await flush();
    const since = logCalls()[0]!.searchParams.get('since');
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier lines' }));
    await flush();
    expect(logCalls()[1]!.searchParams.get('cursor')).toBe('c1');
    expect(logCalls()[1]!.searchParams.get('since')).toBe(since);
    expect(screen.getAllByTestId('production-log-message').map((m) => m.textContent)).toEqual([
      'new',
      'old',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier lines' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load earlier lines. Try again.');
    expect(screen.getAllByTestId('production-log-line')).toHaveLength(2);
  });

  it('says the target’s log service failed, not the app, and Try again re-reads', async () => {
    let state: ProductionLogsDto['state'] = 'unavailable';
    stubFetch({
      logs: () => respond(200, logs({ state, lines: state === 'ok' ? [line('back')] : [] })),
    });
    render();
    await flush();
    const box = screen.getByTestId('production-logs-unavailable');
    expect(box.textContent).toBe(
      'Fly didn’t return this app’s logs. That is Fly’s log service, not the app: it may still be running fine. No older lines are shown as current.Try again',
    );
    state = 'ok';
    fireEvent.click(within(box).getByRole('button', { name: 'Try again' }));
    await flush();
    expect(screen.getAllByTestId('production-log-line')).toHaveLength(1);
  });

  it('shows its own error when the read itself fails', async () => {
    stubFetch({ logs: () => respond(500, {}) });
    render();
    await flush();
    expect(screen.getByTestId('production-logs-failed').textContent).toContain(
      'Couldn’t load this app’s logs.',
    );
  });

  it('says when the route answers that there is no release', async () => {
    stubFetch({ logs: () => respond(200, logs({ state: 'no_release', lines: [] })) });
    render();
    await flush();
    expect(screen.getByTestId('production-logs').textContent).toContain(
      'Logs appear here once the first release is live.',
    );
  });

  it('names the lines as the last before sleep while the app is suspended', async () => {
    stubFetch();
    render(panel(), health({ state: 'suspended' }));
    await flush();
    expect(screen.getByTestId('production-logs').textContent).toContain(
      'The last lines before the app went to sleep.',
    );
  });

  it('drops an older read’s answer that lands after a newer filter’s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const slow = deferred();
    let n = 0;
    stubFetch({
      logs: () => {
        n += 1;
        return n === 1 ? slow.promise : respond(200, logs({ lines: [line('newer')] }));
      },
    });
    render();
    await flush();
    // The range control waits while lines load; the filter does not.
    fireEvent.change(screen.getByTestId('production-logs-filter'), { target: { value: 'GET' } });
    await act(async () => {
      vi.advanceTimersByTime(FILTER_DEBOUNCE_MS);
    });
    await flush();
    slow.resolve(respond(200, logs({ lines: [line('older')] })));
    await flush();
    expect(screen.getAllByTestId('production-log-message').map((m) => m.textContent)).toEqual([
      'newer',
    ]);
  });
});

describe('the words', () => {
  it('turns each route reason into its key', () => {
    expect(eventReasonMessage('exit code -1')).toEqual({
      key: 'events.reason.exit',
      values: { code: '-1' },
    });
    expect(eventReasonMessage('HTTP 502')).toEqual({
      key: 'events.reason.http',
      values: { status: '502' },
    });
    expect(eventReasonMessage(' Out of memory ')).toEqual({ key: 'events.reason.oom' });
    expect(eventReasonMessage('timed out')).toEqual({ key: 'events.reason.timeout' });
    expect(eventReasonMessage('SIGKILL')).toEqual({ key: 'events.reason.exited' });
    expect(isOutOfMemory('out of memory')).toBe(true);
    expect(isOutOfMemory('exit code 1')).toBe(false);
  });

  it('words a duration in its two largest units', () => {
    const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
    expect(formatStateDuration(at(0.5), NOW, 'en')).toBe('< 1 min');
    expect(formatStateDuration(at(3), NOW, 'en')).toBe('3 min');
    expect(formatStateDuration(at(120), NOW, 'en')).toBe('2 hr');
    expect(formatStateDuration(at(178), NOW, 'en')).toBe('2 hr 58 min');
    expect(formatStateDuration(at(4 * 1440), NOW, 'en')).toBe('4 days');
    expect(formatStateDuration(at(4 * 1440 + 120), NOW, 'en')).toBe('4 days 2 hr');
    expect(formatStateDuration(new Date(NOW.getTime() + 60_000), NOW, 'en')).toBe('< 1 min');
  });

  it('splits a message around the mask, and starts each range where it ends', () => {
    expect(maskSegments('a***b***')).toEqual([
      { text: 'a', mask: false },
      { text: '***', mask: true },
      { text: 'b', mask: false },
      { text: '***', mask: true },
    ]);
    expect(maskSegments('plain')).toEqual([{ text: 'plain', mask: false }]);
    expect(rangeSince('15m', NOW)).toBe('2026-11-23T14:45:00.000Z');
    expect(rangeSince('24h', NOW)).toBe('2026-11-22T15:00:00.000Z');
  });
});

describe('the runtime client', () => {
  it('sends the range, the filter and the cursor, and only the ones given', async () => {
    const { calls } = stubFetch();
    await productionRuntimeClient.readLogs('ACME', 'row-1', {
      since: 'S',
      until: 'U',
      filter: 'q1',
      cursor: 'c',
    });
    await productionRuntimeClient.readLogs('ACME', 'row-1', { since: 'S' });
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
      since: 'S',
      until: 'U',
      q: 'q1',
      cursor: 'c',
    });
    expect(Object.fromEntries(calls[1]!.searchParams)).toEqual({ since: 'S' });
  });

  it('answers the error key for a network failure and a body that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')));
    expect(await productionRuntimeClient.readHealth('ACME', 'row-1')).toEqual({
      ok: false,
      refusalKey: 'dialog.error',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('nope', { status: 200 })));
    expect(await productionRuntimeClient.readHealth('ACME', 'row-1')).toEqual({
      ok: false,
      refusalKey: 'dialog.error',
    });
  });
});
