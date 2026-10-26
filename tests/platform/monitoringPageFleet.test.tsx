// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToHtml } from '../helpers/serverPageHarness';
import en from '@/messages/en.json';
import type { PlatformHealthDTO } from '@/lib/dto/platformHealth';

// /admin/monitoring with the Fleet section (MOTIR-7319 · design MOTIR-7314 frames
// 5 and 8). The real page module, rendered through Fizz, with the staff gate and
// the four service reads stubbed at their module boundaries — their own suites
// prove what they return. What this file proves is what the PAGE does with them:
//
//   · a failed Fleet read leaves Panel 8 and the Index-allowance section on the
//     page, and that card alone says it could not read;
//   · each fleet card owns its own failure;
//   · the reads are paged by their OWN params, and the kills read is the last 24 h.

const { gate, healthRead, indexRead, listRunningOrgs, listKills, listPools } = vi.hoisted(() => ({
  gate: vi.fn(),
  healthRead: vi.fn(),
  indexRead: vi.fn(),
  listRunningOrgs: vi.fn(),
  listKills: vi.fn(),
  listPools: vi.fn(),
}));

vi.mock('@/lib/platform/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/auth')>()),
  requirePlatformStaff: gate,
}));
vi.mock('@/lib/services/platformHealthService', () => ({
  platformHealthService: { read: healthRead },
}));
vi.mock('@/lib/services/platformIndexAllowanceService', () => ({
  platformIndexAllowanceService: { read: indexRead },
}));
vi.mock('@/lib/services/platformFleetMonitorService', () => ({
  platformFleetMonitorService: { listRunningOrgs, listKills },
}));
vi.mock('@/lib/services/platformFleetPoolsService', () => ({
  platformFleetPoolsService: { listPools },
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator, createFormatter } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
    getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
  };
});

const PRINCIPAL = { userId: 'u_staff', email: 'ops@moooon.net', role: 'support' };
const HEALTH: PlatformHealthDTO = {
  checkedAt: '2026-10-02T12:00:00.000Z',
  signals: [],
  overdue: [],
  overdueTotal: 0,
  schedulesChecked: 12,
} as unknown as PlatformHealthDTO;

const m = en.platformAdmin.monitoring;

/** The Pools section's four kinds, all on Fly — the smallest well-formed read. */
const POOL_BLOCKS = [
  { fleetKind: 'ci_runner', provider: 'fly' },
  { fleetKind: 'hosted_agent', provider: 'fly' },
  { fleetKind: 'code_graph_index', provider: 'fly' },
  { fleetKind: 'agent_instance', provider: 'fly' },
];

async function renderPage(searchParams: Record<string, string> = {}): Promise<HTMLElement> {
  const mod = await import('@/app/(admin)/admin/monitoring/page');
  const tree = await mod.default({ searchParams: Promise.resolve(searchParams) });
  document.body.innerHTML = await renderToHtml(tree);
  return document.body;
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  gate.mockResolvedValue(PRINCIPAL);
  healthRead.mockResolvedValue(HEALTH);
  indexRead.mockResolvedValue({ meter: 'disabled' });
  listRunningOrgs.mockResolvedValue({
    meter: 'enabled',
    window: { windowMinutes: 10, periodMinutes: 5, judgedAt: HEALTH.checkedAt },
    rows: [],
    total: 0,
    mismatched: 0,
    ciRunners: 0,
    hostedAgents: 0,
    agentInstances: 0,
    page: 1,
    pageSize: 25,
    pageCount: 1,
  });
  listKills.mockResolvedValue({
    meter: 'enabled',
    since: HEALTH.checkedAt,
    rows: [],
    total: 0,
    failed: 0,
    page: 1,
    pageSize: 25,
    pageCount: 1,
  });
  listPools.mockResolvedValue({ blocks: POOL_BLOCKS });
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
  document.body.innerHTML = '';
});

beforeAll(async () => {
  // Pay the page's module graph once, under the hook timeout.
  gate.mockResolvedValue(PRINCIPAL);
  healthRead.mockResolvedValue(HEALTH);
  indexRead.mockResolvedValue({ meter: 'disabled' });
  listRunningOrgs.mockResolvedValue({ meter: 'disabled' });
  listKills.mockResolvedValue({ meter: 'disabled' });
  listPools.mockResolvedValue({ blocks: POOL_BLOCKS });
  await renderPage();
}, 120_000);

describe('/admin/monitoring — the Fleet section', () => {
  it('renders after Panel 8 and the Index allowance when both reads answer', async () => {
    const root = await renderPage();
    const text = root.textContent ?? '';
    expect(text).toContain(m.title);
    expect(text).toContain(m.overdue.title);
    expect(text).toContain(m.indexAllowance.disabled.title);
    expect(text).toContain(m.fleet.orgs.empty.title);
    expect(text).toContain(m.fleet.kills.empty.title);
    expect(text.indexOf(m.indexAllowance.disabled.title)).toBeLessThan(
      text.indexOf(m.fleet.orgs.title),
    );
  });

  it('a failed Fleet read leaves Panel 8 and the Index-allowance section on the page', async () => {
    listRunningOrgs.mockRejectedValue(new Error('motir-ai timed out'));
    const root = await renderPage();
    const text = root.textContent ?? '';
    expect(text).toContain(m.overdue.title);
    expect(text).toContain(m.overdue.empty);
    expect(text).toContain(m.indexAllowance.disabled.title);
    const orgs = root.querySelector('[data-testid="fleet-orgs"]')!;
    expect(orgs.getAttribute('data-state')).toBe('failed');
    expect(orgs.textContent).toContain(m.fleet.orgs.error.title);
    // The other fleet card is a separate read and renders on its own.
    expect(root.querySelector('[data-testid="fleet-kills"]')!.getAttribute('data-state')).toBe(
      'empty',
    );
    // The error is logged, never rendered.
    expect(text).not.toContain('motir-ai timed out');
    expect(errorLog).toHaveBeenCalled();
  });

  it('both fleet reads failing still renders the rest of the page, each card with its own error', async () => {
    listRunningOrgs.mockRejectedValue(new Error('down'));
    listKills.mockRejectedValue(new Error('down'));
    const root = await renderPage();
    expect(root.textContent).toContain(m.overdue.title);
    expect(root.textContent).toContain(m.indexAllowance.disabled.title);
    expect(root.querySelector('[data-testid="fleet-orgs"]')!.getAttribute('data-state')).toBe(
      'failed',
    );
    expect(root.querySelector('[data-testid="fleet-kills"]')!.getAttribute('data-state')).toBe(
      'failed',
    );
  });

  it('off-cloud: one disabled card', async () => {
    listRunningOrgs.mockResolvedValue({ meter: 'disabled' });
    listKills.mockResolvedValue({ meter: 'disabled' });
    const root = await renderPage();
    expect(root.querySelector('[data-testid="fleet-disabled"]')).not.toBeNull();
    expect(root.textContent).toContain(m.fleet.disabled.pill);
  });

  it('pages each list by its own param and reads the kills over the last 24 hours', async () => {
    await renderPage({ page: '3', fleetPage: '2', killsPage: '4' });
    expect(listRunningOrgs).toHaveBeenCalledWith(PRINCIPAL, { page: 2 }, expect.any(Date));
    const [, input, now] = listKills.mock.calls[0]!;
    expect(input.page).toBe(4);
    expect((now as Date).getTime() - (input.since as Date).getTime()).toBe(24 * 60 * 60_000);
    // The Stopped list's `page` is the Index-allowance read's, never the fleet's.
    expect(indexRead).toHaveBeenCalledWith(PRINCIPAL, expect.objectContaining({ page: '3' }));
  });

  it('a junk page param is page 1 (left to the service)', async () => {
    await renderPage({ fleetPage: 'abc', killsPage: '-2' });
    expect(listRunningOrgs).toHaveBeenCalledWith(PRINCIPAL, { page: undefined }, expect.any(Date));
    expect(listKills.mock.calls[0]![1].page).toBeUndefined();
  });

  // ── MOTIR-7321's coverage top-up: the page's own Panel 8 around the Fleet section ──

  it('renders each signal state in words, with its link-out, and the overdue rows', async () => {
    healthRead.mockResolvedValue({
      ...HEALTH,
      signals: [
        {
          id: 'database',
          state: 'healthy',
          values: { ms: 4, region: 'fra' },
          linkOut: 'https://console.neon.tech',
        },
        {
          id: 'lastHealthCheck',
          state: 'degraded',
          values: { ranAt: '2026-10-01T06:00:00.000Z', status: 'ok' },
          linkOut: null,
        },
        { id: 'errors', state: 'unreachable', values: { reason: 'notConfigured' }, linkOut: null },
        { id: 'schedules', state: 'healthy', values: { overdue: 2, total: 12 }, linkOut: null },
        { id: 'failedJobs', state: 'healthy', values: { standing: 0, count: 0 }, linkOut: null },
        { id: 'hosting', state: 'unreachable', values: { reason: 'notManaged' }, linkOut: null },
      ],
      overdue: [
        {
          functionId: 'system.fleet-debit-monitor',
          cron: '*/5 * * * *',
          lastRunAt: '2026-10-02T11:00:00.000Z',
          expectedAt: '2026-10-02T11:05:00.000Z',
        },
        { functionId: 'system.never', cron: '0 * * * *', lastRunAt: null, expectedAt: null },
      ],
      overdueTotal: 2,
    });
    const root = await renderPage();
    const text = root.textContent ?? '';
    expect(text).toContain('Reachable · 4 ms');
    expect(text).toContain(m.signal.database.linkOut);
    expect(text).toContain(m.state.degraded);
    expect(text).toContain(m.signal.errors.unreachable.notConfigured);
    expect(text).toContain(m.state.unreachable);
    expect(text).toContain('system.fleet-debit-monitor');
    // A job that never fired is a WORD, not a dash.
    expect(text).toContain(m.overdue.never);
    expect(text).toContain('2 overdue');
  });

  it('a fleet read failing with a non-Error is logged as `unknown`', async () => {
    listKills.mockRejectedValue('a bare string');
    const root = await renderPage();
    expect(root.querySelector('[data-testid="fleet-kills"]')!.getAttribute('data-state')).toBe(
      'failed',
    );
    expect(errorLog).toHaveBeenCalledWith('[admin/monitoring] the fleet kills read failed', {
      detail: 'unknown',
    });
  });
});

// ── Monitoring · Pools (MOTIR-9563 · design MOTIR-9561) ─────────────────────

describe('/admin/monitoring — the Pools section', () => {
  it('renders last, after the Fleet section, one block per kind', async () => {
    const root = await renderPage();
    const text = root.textContent ?? '';
    expect(text.indexOf(m.fleet.kills.title)).toBeLessThan(text.indexOf(m.pools.subtitle));
    expect(root.querySelectorAll('[data-testid^="pool-"]')).toHaveLength(4);
    expect(listPools).toHaveBeenCalledWith(PRINCIPAL, expect.any(Date));
  });

  it('a rejected pools read renders one error in its section; the rest of the page still renders', async () => {
    listPools.mockRejectedValue(new Error('pool read timed out'));
    const root = await renderPage();
    const text = root.textContent ?? '';
    expect(text).toContain(m.overdue.title);
    expect(text).toContain(m.indexAllowance.disabled.title);
    expect(root.querySelector('[data-testid="fleet-orgs"]')!.getAttribute('data-state')).toBe(
      'empty',
    );
    expect(root.querySelector('[data-testid="pools-failed"]')!.textContent).toContain(
      m.pools.sectionError.title,
    );
    expect(text).not.toContain('pool read timed out');
    expect(errorLog).toHaveBeenCalledWith('[admin/monitoring] the fleet pools read failed', {
      detail: 'pool read timed out',
    });
  });

  it('carries the Pools pagers through every pager link, and drops a junk one', async () => {
    listRunningOrgs.mockResolvedValue({
      meter: 'enabled',
      window: { windowMinutes: 10, periodMinutes: 5, judgedAt: HEALTH.checkedAt },
      rows: [],
      total: 60,
      mismatched: 0,
      ciRunners: 0,
      hostedAgents: 0,
      agentInstances: 0,
      page: 1,
      pageSize: 25,
      pageCount: 3,
    });
    const root = await renderPage({
      poolRequests_ci_runner: '2',
      poolEvents_hosted_agent: 'abc',
    });
    const next = root.querySelector('[data-testid="fleet-orgs"] nav a')!.getAttribute('href')!;
    const params = new URLSearchParams(next.slice(1));
    expect(params.get('poolRequests_ci_runner')).toBe('2');
    expect(params.has('poolEvents_hosted_agent')).toBe(false);
  });

  it('adds no client island and no form', async () => {
    const root = await renderPage();
    const section = root.querySelector('[data-testid="pools-section"]')!;
    expect(section.querySelectorAll('button, form, input, select')).toHaveLength(0);
  });
});
