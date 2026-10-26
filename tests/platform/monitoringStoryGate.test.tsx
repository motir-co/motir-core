import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { db } from '@/lib/db';
import type { PlatformSignalDTO, PlatformSignalId } from '@/lib/dto/platformHealth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import { platformHealthService } from '@/lib/services/platformHealthService';
import { databaseHealthRepository } from '@/lib/repositories/databaseHealthRepository';
import { flyDeploymentStatusProvider } from '@/lib/deployment/adapters/fly/flyMachinesStatus';
import { deploymentStatusProvider, usingFakeDeploymentStatus } from '@/lib/deployment/providers';
import { httpGatewayStatusReader } from '@/lib/gateway/statusClient';
import { GatewayStatusMalformedError } from '@/lib/gateway/statusErrors';
import { gatewayStatusReader, usingFakeGatewayStatus } from '@/lib/gateway/statusProvider';
import { httpErrorCountReader } from '@/lib/monitoring/sentryErrorCount';
import { errorCountReader, usingFakeErrorCount } from '@/lib/monitoring/errorCountProvider';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';

// STORY 10.2's INTEGRATION GATE (MOTIR-744) — the assembled board, not its parts.
//
// Each provider card proves its own client and verdict. What none of them can
// prove is the board's promise once all three are in it: one broken provider
// never blanks the page, no unreachable card ever carries a number, and the words
// on screen are the data behind them. So this suite runs the REAL service against
// the real Postgres and the REAL staff gate — only `getSession()` is mocked, the
// one `vi.mock` CLAUDE.md allows — with the three providers stubbed at their
// readers, and renders the REAL page from what `read()` returned.
//
// `app/(admin)/layout.tsx`'s 404 for a non-staff session is asserted by
// `adminRouteGate.test.ts`; this suite asserts the second layer the ADR requires,
// that the page and the service refuse on their own.

let session: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => session),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));
// The page's second section is a different story's (MOTIR-4595) and reads the
// code-graph ledger; it is not under test here.
vi.mock('@/lib/services/platformIndexAllowanceService', () => ({
  platformIndexAllowanceService: { read: vi.fn(async () => null) },
}));
vi.mock('@/app/(admin)/admin/monitoring/_components/IndexAllowanceSection', () => ({
  IndexAllowanceSection: () => null,
}));

const { default: AdminMonitoringPage } = await import('@/app/(admin)/admin/monitoring/page');

/** Every signal id, so a future eighth card falls under the never-a-zero sweep. */
const ALL_IDS: readonly PlatformSignalId[] = [
  'database',
  'hosting',
  'gateway',
  'schedules',
  'failedJobs',
  'errors',
  'lastHealthCheck',
];

/** The three providers this story added, each with the stub that breaks it. */
const PROVIDERS = {
  errors: () => vi.spyOn(httpErrorCountReader, 'read').mockRejectedValue(new Error('Sentry 502')),
  hosting: () =>
    vi.spyOn(flyDeploymentStatusProvider, 'read').mockRejectedValue(new Error('Fly 401')),
  gateway: () =>
    vi.spyOn(httpGatewayStatusReader, 'read').mockRejectedValue(new Error('gateway timeout')),
} as const;

/** Wire all three as configured, each answering healthily. */
function configureAll() {
  vi.stubEnv('MOTIR_E2E_FAKE_ERROR_COUNT', '');
  vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '');
  vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_STATUS', '');
  vi.stubEnv('SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
  vi.stubEnv('SENTRY_READ_TOKEN', 'sntrys_read');
  vi.stubEnv('SENTRY_ORG', 'moooon');
  vi.stubEnv('SENTRY_PROJECT', 'motir-core');
  vi.stubEnv('FLY_APP_NAME', 'motir-core');
  vi.stubEnv('FLY_REGION', 'iad');
  vi.stubEnv('FLY_MACHINE_ID', 'web1');
  vi.stubEnv('FLY_DEPLOYMENT_READ_TOKEN', 'fo1_read');
  vi.stubEnv('MOTIR_GATEWAY_URL', 'https://gateway.example.test');

  vi.spyOn(httpErrorCountReader, 'read').mockResolvedValue({
    count: 12,
    projectId: '42',
    org: 'moooon',
  });
  vi.spyOn(flyDeploymentStatusProvider, 'read').mockResolvedValue({
    groups: [
      { name: 'app', started: 2, total: 2, expected: 2 },
      { name: 'worker', started: 1, total: 1, expected: 1 },
    ],
    releases: ['deployment-01K6'],
  });
  vi.spyOn(httpGatewayStatusReader, 'read').mockResolvedValue({
    latencyMs: 87,
    version: 'v0.18.3',
    startTime: '2026-10-01T00:00:00.000Z',
  });
}

async function seedStaff(): Promise<void> {
  const user = await createTestUser({ email: 'ops+gate@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  session = { user: { id: user.id } };
}

async function readBoard() {
  const { requirePlatformStaff } = await import('@/lib/platform/auth');
  return platformHealthService.read(await requirePlatformStaff('support'));
}

function byId(signals: PlatformSignalDTO[]) {
  return Object.fromEntries(signals.map((s) => [s.id, s])) as Record<
    PlatformSignalId,
    PlatformSignalDTO
  >;
}

/** The never-a-zero rule over the WHOLE board: no unreachable card carries a number. */
function expectNoNumberOnUnreachable(signals: PlatformSignalDTO[]) {
  for (const s of signals) {
    if (s.state !== 'unreachable') continue;
    const numeric = Object.entries(s.values).filter(([, v]) => typeof v === 'number');
    expect(numeric, `${s.id} (${String(s.values['reason'])}) carries a number`).toEqual([]);
  }
}

const fetchGuard = vi.fn(async () => {
  throw new Error('a provider reached the network in a test');
});

beforeAll(async () => {
  // Warm the page's module graph outside any case's clock.
  await import('@/app/(admin)/admin/monitoring/page');
}, 120_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.stubGlobal('fetch', fetchGuard);
  fetchGuard.mockClear();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
  await seedStaff();
  // A fresh daily-health-check run, so the Last health check card is green and
  // every unreachable card on the board is one this suite broke on purpose.
  await adminDb.jobRun.create({
    data: {
      functionId: 'system.daily-health-check',
      eventName: 'scheduled.system.daily-health-check',
      eventId: 'evt_gate',
      lane: 'engine',
      attempt: 1,
      status: 'succeeded',
      startedAt: new Date(),
    },
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('one provider failing never takes the board down', () => {
  it.each(Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>)(
    'with %s failing, all seven signals return and only that one is unreachable',
    async (failing) => {
      configureAll();
      PROVIDERS[failing]();

      const { signals } = await readBoard();
      expect(signals.map((s) => s.id).sort()).toEqual([...ALL_IDS].sort());
      const unreachable = signals.filter((s) => s.state === 'unreachable').map((s) => s.id);
      expect(unreachable).toEqual([failing]);
      expectNoNumberOnUnreachable(signals);
    },
  );

  it('with all three failing together, the board still returns', async () => {
    configureAll();
    for (const breakIt of Object.values(PROVIDERS)) breakIt();

    const { signals } = await readBoard();
    expect(signals).toHaveLength(ALL_IDS.length);
    const board = byId(signals);
    for (const id of ['errors', 'hosting', 'gateway'] as const) {
      expect(board[id].state).toBe('unreachable');
    }
    expect(board.database.state).toBe('healthy');
    expectNoNumberOnUnreachable(signals);
  });
});

describe('⚠️ never a zero, over every unreachable reason', () => {
  it('no unreachable signal, for any id or reason, carries a numeric value', async () => {
    const reasonsSeen = new Set<string>();
    const scenarios: Array<() => void> = [
      // Nothing configured: notManaged / notConfigured everywhere.
      () => {
        vi.stubEnv('FLY_APP_NAME', '');
        vi.stubEnv('SENTRY_DSN', '');
        vi.stubEnv('MOTIR_GATEWAY_URL', '');
      },
      // Configured but credential-less: noReadCredential on Errors and Hosting.
      () => {
        configureAll();
        vi.stubEnv('SENTRY_READ_TOKEN', '');
        vi.stubEnv('FLY_DEPLOYMENT_READ_TOKEN', '');
      },
      // Configured and failing: readFailed / noAnswer.
      () => {
        configureAll();
        for (const breakIt of Object.values(PROVIDERS)) breakIt();
      },
      // The gateway answered, and the answer was rejected (MOTIR-9641).
      () => {
        configureAll();
        vi.spyOn(httpGatewayStatusReader, 'read').mockRejectedValue(
          new GatewayStatusMalformedError('httpStatus', 'gateway status answered 503', 503),
        );
      },
      // The database itself unreachable.
      () => {
        configureAll();
        vi.spyOn(databaseHealthRepository, 'ping').mockRejectedValue(new Error('ECONNREFUSED'));
      },
    ];
    for (const arrange of scenarios) {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.stubGlobal('fetch', fetchGuard);
      arrange();
      const { signals } = await readBoard();
      expect(signals.map((s) => s.id).sort()).toEqual([...ALL_IDS].sort());
      expectNoNumberOnUnreachable(signals);
      for (const s of signals) {
        if (s.state === 'unreachable') reasonsSeen.add(`${s.id}:${String(s.values['reason'])}`);
      }
    }
    // The sweep actually reached the reasons this story added.
    for (const reason of [
      'hosting:notManaged',
      'hosting:noReadCredential',
      'hosting:readFailed',
      'errors:notConfigured',
      'errors:noReadCredential',
      'errors:readFailed',
      'gateway:notConfigured',
      'gateway:noAnswer',
      'gateway:badAnswer',
      'database:unreachable',
    ]) {
      expect(reasonsSeen, reason).toContain(reason);
    }
  });
});

describe('the service-to-page seam', () => {
  async function renderPage(): Promise<string> {
    const html = await renderToHtml(
      await AdminMonitoringPage({ searchParams: Promise.resolve({}) }),
    );
    return html
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  }

  it('a healthy board renders each card from the DTO it read', async () => {
    configureAll();
    const text = await renderPage();
    expect(text).toContain('12 errors · 24h');
    expect(text).toContain('app 2/2 · worker 1/1');
    expect(text).toContain('all on release deployment-01K6');
    expect(text).toContain('Reachable · 87 ms');
    expect(text).toContain('motir-gateway v0.18.3');
    expect(text).toContain('System health loaded. All 7 signals are healthy.');
  });

  it('a degraded board renders the degraded copy each verdict carries', async () => {
    configureAll();
    vi.spyOn(httpErrorCountReader, 'read').mockResolvedValue({
      count: 140,
      projectId: '42',
      org: 'moooon',
    });
    vi.spyOn(flyDeploymentStatusProvider, 'read').mockResolvedValue({
      groups: [
        { name: 'app', started: 1, total: 2, expected: 2 },
        { name: 'worker', started: 1, total: 1, expected: 1 },
      ],
      releases: ['deployment-01K6'],
    });
    vi.spyOn(httpGatewayStatusReader, 'read').mockResolvedValue({
      latencyMs: 2400,
      version: 'v0.18.3',
      startTime: '2026-10-01T00:00:00.000Z',
    });

    const text = await renderPage();
    expect(text).toContain('140 errors · 24h');
    expect(text).toContain('Over the 100-error threshold');
    expect(text).toContain('app is short: 1 of 2 machines started');
    expect(text).toContain('Slow · 2400 ms');
    expect(text).toContain("3 of 7 signals are degraded or can't be reached.");
  });

  it('an unreachable board renders the reasons and no count on those cards', async () => {
    configureAll();
    for (const breakIt of Object.values(PROVIDERS)) breakIt();

    const text = await renderPage();
    expect(text).toContain('No response from Sentry');
    expect(text).toContain('No answer from Fly');
    expect(text).toContain('No answer from the gateway');
    expect(text).not.toContain('errors · 24h');
    expect(text).not.toMatch(/app \d+\/\d+/);
    expect(text).not.toContain('Reachable · 87 ms');
  });
});

describe('the Gateway card names a rejected answer (MOTIR-9641)', () => {
  async function renderPage(): Promise<string> {
    const html = await renderToHtml(
      await AdminMonitoringPage({ searchParams: Promise.resolve({}) }),
    );
    return html
      .replace(/<!-- -->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  }

  it('an empty version says the gateway answered and why it was rejected', async () => {
    configureAll();
    vi.spyOn(httpGatewayStatusReader, 'read').mockRejectedValue(
      new GatewayStatusMalformedError('noVersion', 'gateway status carried no version'),
    );
    const text = await renderPage();
    expect(text).toContain('Unreadable answer from the gateway');
    expect(text).toContain(
      'The gateway answered, but its status could not be read: it carried no version.',
    );
    expect(text).not.toContain('No answer from the gateway');
    expect(text).not.toContain('got no answer within');
  });

  it('a 503 names the status it answered with', async () => {
    configureAll();
    vi.spyOn(httpGatewayStatusReader, 'read').mockRejectedValue(
      new GatewayStatusMalformedError('httpStatus', 'gateway status answered 503', 503),
    );
    const text = await renderPage();
    expect(text).toContain(
      'The gateway answered, but its status could not be read: it answered HTTP 503.',
    );
  });
});

describe('staff-only, audited, and offline', () => {
  it('a non-staff session is refused by the page and by the service', async () => {
    const user = await createTestUser({ email: 'owner@customer.test' });
    session = { user: { id: user.id } };

    // The page answers the app's 404 (Next's not-found sentinel), as the layout
    // does — never a thrown NotPlatformStaffError (MOTIR-7613).
    await expect(AdminMonitoringPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'NEXT_HTTP_ERROR_FALLBACK;404',
    );
    const { requirePlatformStaff } = await import('@/lib/platform/auth');
    await expect(requirePlatformStaff('support')).rejects.toBeInstanceOf(NotPlatformStaffError);
  });

  it('writes one health.read audit row per read, before the probes run', async () => {
    configureAll();
    let rowsWhenProbed = -1;
    const ping = databaseHealthRepository.ping.bind(databaseHealthRepository);
    vi.spyOn(databaseHealthRepository, 'ping').mockImplementation(async (tx) => {
      rowsWhenProbed = await adminDb.platformAuditLog.count({ where: { action: 'health.read' } });
      return ping(tx);
    });

    await readBoard();
    expect(rowsWhenProbed).toBe(1);
    expect(await adminDb.platformAuditLog.count({ where: { action: 'health.read' } })).toBe(1);
  });

  it('makes no network call: every factory is bound to a reader this suite stubs', async () => {
    configureAll();
    expect(gatewayStatusReader()).toBe(httpGatewayStatusReader);
    expect(errorCountReader()).toBe(httpErrorCountReader);
    expect(await deploymentStatusProvider()).toBe(flyDeploymentStatusProvider);

    await readBoard();
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it('the three E2E fake flags are inert in a production build without the harness', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('E2E_PROD_HARNESS', '');
    vi.stubEnv('MOTIR_E2E_FAKE_ERROR_COUNT', '1');
    vi.stubEnv('MOTIR_E2E_FAKE_DEPLOYMENT_STATUS', '1');
    vi.stubEnv('MOTIR_E2E_FAKE_GATEWAY_STATUS', '1');
    expect([usingFakeErrorCount(), usingFakeDeploymentStatus(), usingFakeGatewayStatus()]).toEqual([
      false,
      false,
      false,
    ]);
  });
});
