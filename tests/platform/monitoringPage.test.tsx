// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import type { PlatformHealthDTO, PlatformSignalDTO } from '@/lib/dto/platformHealth';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE MONITORING BOARD'S RENDER (Story 10.2 · MOTIR-743) — the three changed
// cards in every state the 10.2.1 delta draws, rendered with the REAL `en`
// catalogue, because the property under test is the words: a card that cannot
// read its source names the reason and shows no digit.
//
// The service is stubbed at its seam: what the cards SAY for each DTO is this
// suite's question, and `platformHealthService.test.ts` owns what the service
// returns. The staff gate is mocked the way that suite mocks it.

const { read } = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('@/lib/platform/auth', () => ({
  requirePlatformStaff: vi.fn(async () => ({
    userId: 'u1',
    email: 'ops@moooon.net',
    role: 'support',
  })),
}));
vi.mock('@/lib/services/platformHealthService', () => ({ platformHealthService: { read } }));
vi.mock('@/lib/services/platformIndexAllowanceService', () => ({
  platformIndexAllowanceService: { read: vi.fn(async () => null) },
}));
vi.mock('@/app/(admin)/admin/monitoring/_components/IndexAllowanceSection', () => ({
  IndexAllowanceSection: () => null,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: AdminMonitoringPage } = await import('@/app/(admin)/admin/monitoring/page');

const UNCHANGED: [
  PlatformSignalDTO,
  PlatformSignalDTO,
  PlatformSignalDTO,
  PlatformSignalDTO,
  PlatformSignalDTO,
] = [
  { id: 'database', state: 'healthy', values: { ms: 4, region: 'iad' }, linkOut: null },
  {
    id: 'gateway',
    state: 'healthy',
    values: { ms: 42, version: 'v1', since: '2026-10-01T00:00:00Z', threshold: 1000 },
    linkOut: null,
  },
  { id: 'schedules', state: 'healthy', values: { overdue: 0, total: 5 }, linkOut: null },
  { id: 'failedJobs', state: 'healthy', values: { standing: 0, count: 0 }, linkOut: null },
  {
    id: 'lastHealthCheck',
    state: 'healthy',
    values: { ranAt: '2026-10-02T06:00:00Z', status: 'ok' },
    linkOut: null,
  },
];

const HOSTING_IDENTITY = { app: 'motir-core', region: 'us-east-1', machineId: '—' };
const ECS_CONSOLE = 'https://us-east-1.console.aws.amazon.com/ecs/v2/clusters?region=us-east-1';
const HOSTING_SERVICES = [
  { name: 'motir-core-web', started: 2, expected: 2, release: 'motir-core-web:41', rolling: false },
  {
    name: 'motir-core-worker',
    started: 1,
    expected: 1,
    release: 'motir-core-worker:17',
    rolling: false,
  },
];

function board(hosting: PlatformSignalDTO, errors: PlatformSignalDTO): PlatformHealthDTO {
  return {
    checkedAt: '2026-10-02T12:00:00Z',
    signals: [
      UNCHANGED[0],
      hosting,
      UNCHANGED[1],
      UNCHANGED[2],
      UNCHANGED[3],
      errors,
      UNCHANGED[4],
    ],
    overdue: [],
    overdueTotal: 0,
    schedulesChecked: 5,
  };
}

const HEALTHY_HOSTING: PlatformSignalDTO = {
  id: 'hosting',
  state: 'healthy',
  values: { ...HOSTING_IDENTITY, serviceCount: 2 },
  services: HOSTING_SERVICES,
  linkOut: ECS_CONSOLE,
};
const HEALTHY_ERRORS: PlatformSignalDTO = {
  id: 'errors',
  state: 'healthy',
  values: { count: 12, windowHours: 24, threshold: 100 },
  linkOut: null,
};

async function render(hosting = HEALTHY_HOSTING, errors = HEALTHY_ERRORS): Promise<string> {
  read.mockResolvedValue(board(hosting, errors));
  const html = await renderToHtml(await AdminMonitoringPage({ searchParams: Promise.resolve({}) }));
  // Decode the entities React escapes, so the copy reads as written. `&amp;`
  // goes last, so an escaped `&amp;quot;` decodes once and not twice.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/** The text of the card titled `title` — from its title to the next card's. */
function card(html: string, title: string): string {
  const text = html.replace(/<[^>]+>/g, '|');
  const start = text.indexOf(`|${title}|`);
  expect(start, `no ${title} card`).toBeGreaterThanOrEqual(0);
  return text.slice(start, start + 900);
}

beforeEach(() => {
  read.mockReset();
});

describe('the Errors card', () => {
  it('shows the 24-hour count and the threshold when healthy', async () => {
    const errors = card(await render(), 'Errors');
    expect(errors).toContain('12 errors · 24h');
    expect(errors).toContain('Under the 100-error threshold');
  });

  it('shows the count and the threshold in the degraded copy', async () => {
    const errors = card(
      await render(HEALTHY_HOSTING, {
        ...HEALTHY_ERRORS,
        state: 'degraded',
        values: { count: 140, windowHours: 24, threshold: 100 },
      }),
      'Errors',
    );
    expect(errors).toContain('140 errors · 24h');
    expect(errors).toContain('Over the 100-error threshold');
    expect(errors).toContain('Degraded');
  });

  it.each([
    ['noReadCredential', 'No reading from Sentry'],
    ['notConfigured', 'Error reporting is off'],
    ['readFailed', 'No response from Sentry'],
  ])('unreachable / %s names the reason and renders no digit', async (reason, headline) => {
    const errors = card(
      await render(HEALTHY_HOSTING, {
        id: 'errors',
        state: 'unreachable',
        values: { reason },
        linkOut: null,
      }),
      'Errors',
    );
    // Everything up to the card's own "…not an error count of zero".
    const body = errors.slice(0, errors.indexOf('zero') + 4);
    expect(body).toContain(headline);
    expect(body).toContain('not an error count of zero');
    expect(body).not.toMatch(/\d/);
  });
});

describe('the Hosting card', () => {
  it('shows one line per service, with running against desired and its own release', async () => {
    const html = await render();
    const hosting = card(html, 'Hosting');
    expect(hosting).toContain('All 2 services steady');
    expect(hosting).toMatch(/\|motir-core-web\| 2\/2 · motir-core-web:41\|/);
    expect(hosting).toMatch(/\|motir-core-worker\| 1\/1 · motir-core-worker:17\|/);
    expect(hosting).toContain('each steady on its release. ECS cluster motir-core · us-east-1.');
    expect(hosting).toContain('ECS console');
    expect(html).toContain(`href="${ECS_CONSOLE}"`);
    // Nothing is set in weight on a healthy card.
    expect(html).not.toMatch(/<span class="font-semibold">motir-core/);
  });

  it('a short service is named in words and set in weight on its line', async () => {
    const html = await render({
      ...HEALTHY_HOSTING,
      state: 'degraded',
      values: {
        ...HEALTHY_HOSTING.values,
        reason: 'shortGroup',
        group: 'motir-core-worker',
        started: 0,
        expected: 1,
      },
      services: [HOSTING_SERVICES[0]!, { ...HOSTING_SERVICES[1]!, started: 0 }],
    });
    const hosting = card(html, 'Hosting');
    expect(hosting).toContain('motir-core-worker short · 0/1');
    expect(hosting).toContain('motir-core-worker is short: 0 of 1 tasks running.');
    expect(html).toMatch(/<span class="font-semibold">motir-core-worker<\/span> 0\/1/);
    expect(html).not.toMatch(/<span class="font-semibold">motir-core-web</);
  });

  it('a service mid-deploy is named in words with the release it is rolling to', async () => {
    const html = await render({
      ...HEALTHY_HOSTING,
      state: 'degraded',
      values: {
        ...HEALTHY_HOSTING.values,
        reason: 'mixedReleases',
        group: 'motir-core-web',
        release: 'motir-core-web:42',
      },
      services: [
        { ...HOSTING_SERVICES[0]!, release: 'motir-core-web:42', rolling: true },
        HOSTING_SERVICES[1]!,
      ],
    });
    const hosting = card(html, 'Hosting');
    expect(hosting).toContain('motir-core-web mid-deploy');
    expect(hosting).toContain('motir-core-web is mid-deploy on motir-core-web:42');
    expect(html).toMatch(/<span class="font-semibold">motir-core-web<\/span>/);
  });

  it('a service with no named release renders an em-dash for it', async () => {
    const hosting = card(
      await render({
        ...HEALTHY_HOSTING,
        values: { ...HOSTING_IDENTITY, serviceCount: 1 },
        services: [{ ...HOSTING_SERVICES[0]!, release: null }],
      }),
      'Hosting',
    );
    expect(hosting).toContain('1 service steady');
    expect(hosting).toMatch(/\|motir-core-web\| 2\/2 · —\|/);
  });

  it('noReadCredential still shows the cluster and region, with no task counts', async () => {
    const hosting = card(
      await render({
        id: 'hosting',
        state: 'unreachable',
        values: { reason: 'noReadCredential', ...HOSTING_IDENTITY },
        linkOut: ECS_CONSOLE,
      }),
      'Hosting',
    );
    expect(hosting).toContain('Answering from us-east-1');
    expect(hosting).toContain('ECS cluster motir-core · us-east-1.');
    // Everything up to the card's own "…not a count of zero" — no N/M count.
    const body = hosting.slice(0, hosting.indexOf('count of zero') + 13);
    expect(body).toContain('This is not a count of zero');
    expect(body).not.toMatch(/\d+\/\d+/);
  });

  it('readFailed names the reason and renders no digit', async () => {
    const hosting = card(
      await render({
        id: 'hosting',
        state: 'unreachable',
        values: { reason: 'readFailed' },
        linkOut: null,
      }),
      'Hosting',
    );
    const body = hosting.slice(0, hosting.indexOf('count of zero') + 13);
    expect(body).toContain('No answer from ECS');
    expect(body).not.toMatch(/\d/);
  });

  it('no line on the card names Fly', async () => {
    expect(card(await render(), 'Hosting')).not.toMatch(/\bFly\b/);
  });
});

describe('the board', () => {
  it('renders seven cards and offers no remediation control', async () => {
    const html = await render();
    for (const title of [
      'Database',
      'Hosting',
      'Gateway',
      'Scheduled jobs',
      'Failed jobs',
      'Errors',
      'Last health check',
    ]) {
      expect(html).toContain(`>${title}<`);
    }
    expect(html).not.toMatch(/<button|<form/);
  });

  it('announces load-complete and how many cards need a look', async () => {
    const green = await render();
    expect(green).toMatch(/role="status"[^>]*>System health loaded\. All 7 signals are healthy\./);

    const red = await render(
      { id: 'hosting', state: 'unreachable', values: { reason: 'readFailed' }, linkOut: null },
      { ...HEALTHY_ERRORS, state: 'degraded' },
    );
    expect(red).toContain("System health loaded. 2 of 7 signals are degraded or can't be reached.");
  });

  it('the overdue list is unchanged: a never-fired cron says Never, a missing expectation a dash', async () => {
    read.mockResolvedValue({
      ...board(HEALTHY_HOSTING, HEALTHY_ERRORS),
      overdue: [
        {
          functionId: 'system.daily-health-check',
          cron: '0 9 * * *',
          lastRunAt: null,
          expectedAt: null,
        },
        {
          functionId: 'system.attachment-gc',
          cron: '0 3 * * *',
          lastRunAt: '2026-09-30T03:00:00Z',
          expectedAt: '2026-10-01T03:00:00Z',
        },
      ],
      overdueTotal: 2,
    });
    const html = await renderToHtml(
      await AdminMonitoringPage({ searchParams: Promise.resolve({}) }),
    );
    const text = html.replace(/<[^>]+>/g, '|');
    expect(text).toContain('|system.daily-health-check|');
    expect(text).toContain('|Never|');
    expect(text).toContain('|—|');
    expect(text).toContain('|system.attachment-gc|');
    expect(text).toContain('9/30/2026');
  });
});
