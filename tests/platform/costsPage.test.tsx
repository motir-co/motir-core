import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import en from '@/messages/en.json';
import type { CostsPageDTO, CostsRowDTO } from '@/lib/dto/platformCosts';
import { platformReadService } from '@/lib/services/platformReadService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { deferred, renderFirstFlush, renderToHtml } from '../helpers/serverPageHarness';

// THE CONSOLE'S COSTS PAGE (MOTIR-11712; design MOTIR-11711, Panels 1–8). The
// page gate runs for real over a real session and the real `platformRole`
// column — the session is the one thing mocked. The read is stubbed at the
// service so every state the design draws can be reached; the service has its own
// suite (`tests/platform/platformCosts.test.ts`).

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: Page, metadata, dynamic } = await import('@/app/(admin)/admin/costs/page');

let seq = 0;
async function signIn(): Promise<void> {
  const user = await createTestUser({ email: `ops+costs-page-${++seq}@example.test` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentSession = { user: { id: user.id } };
}

const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/<!-- -->/g, '');

function row(period: string, over: Partial<CostsRowDTO> = {}): CostsRowDTO {
  return {
    period,
    partial: false,
    estimate: false,
    awsMicroUsd: 208_500_000,
    modelsMicroUsd: 348_420_000,
    totalMicroUsd: 556_920_000,
    awsLines: [
      {
        kind: 'service',
        service: 'Amazon Elastic Container Service',
        amountMicroUsd: 71_760_000,
        share: 0.344,
      },
      { kind: 'tax', service: '', amountMicroUsd: 12_000_000, share: 0.0575 },
      { kind: 'credit', service: '', amountMicroUsd: -16_500_000, share: -0.079 },
      { kind: 'refund', service: '', amountMicroUsd: -1_000_000, share: -0.0048 },
    ],
    modelLines: [
      { provider: 'anthropic', amountMicroUsd: 300_000_000, share: 0.861 },
      { provider: 'mystery', amountMicroUsd: 48_420_000, share: 0.139 },
    ],
    ...over,
  };
}

function costs(over: Partial<CostsPageDTO> = {}): CostsPageDTO {
  return {
    view: { kind: 'day', month: '2026-11' },
    today: '2026-11-18',
    awsAvailable: true,
    modelsAvailable: true,
    awsFetchedAt: '2026-11-18T06:12:00.000Z',
    rows: [
      row('2026-11-17'),
      row('2026-11-18', { partial: true, estimate: true, modelLines: [], modelsMicroUsd: 0 }),
    ],
    totals: {
      awsMicroUsd: 3_707_020_000,
      modelsMicroUsd: 7_233_540_000,
      totalMicroUsd: 10_940_560_000,
      partial: true,
    },
    empty: false,
    options: ['2026-11', '2026-10', '2025-02'],
    ...over,
  };
}

const render = async (searchParams: Record<string, string>) =>
  decode(await renderToHtml(await Page({ searchParams: Promise.resolve(searchParams) })));

beforeEach(async () => {
  currentSession = null;
  await truncateAuthTables();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the Costs page', () => {
  it('answers 404 to anyone who is not platform staff, reading nothing', async () => {
    const read = vi.spyOn(platformReadService, 'getCosts');
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toBeInstanceOf(
      NotFoundSentinel,
    );
    expect(read).not.toHaveBeenCalled();
    expect(metadata).toEqual({ title: 'Costs' });
    expect(dynamic).toBe('force-dynamic');
  });

  it('Panel 1 — the Day view: header, Fetched line, figures, rows, Partial and Estimate', async () => {
    await signIn();
    const read = vi.spyOn(platformReadService, 'getCosts').mockResolvedValue(costs());
    const html = await render({});
    expect(read.mock.calls[0]![1]).toMatchObject({ kind: 'day' });

    expect(html).toContain('<h1 class="font-serif text-2xl text-(--el-text)">Costs</h1>');
    expect(html).toContain('Tenant usage and credits are on Usage & cost.');
    expect(html).toContain('Showing November 2026, by day (UTC)');
    expect(html).toContain('AWS figures fetched Nov 18, 06:12 UTC');
    expect(html).toContain('<option value="2025-02">February 2025</option>');
    expect(html).toContain('$3,707.02');
    expect(html).toContain('$10,940.56');
    expect(html).toContain('November 2026 · so far');
    expect(html).toContain('By day');
    expect(html).toContain('Day (UTC)');
    expect(html).toContain('aria-label="Show what made up Tue, Nov 17"');
    expect(html).toContain('aria-label="Show what made up Wed, Nov 18"');
    expect(html).toContain('data-testid="costs-partial"');
    expect(html).toContain('data-testid="costs-estimate"');
    expect(html).toContain('$556.92');
    // The drill-downs stay closed until a row is opened.
    expect(html).not.toContain('data-testid="costs-drilldown"');
    expect(html).not.toContain('costs-unavailable');
  });

  it('Panels 2 and 3 — the Month view has a year picker; the Year view has none', async () => {
    await signIn();
    vi.spyOn(platformReadService, 'getCosts').mockResolvedValueOnce(
      costs({
        view: { kind: 'month', year: '2026' },
        rows: [row('2026-10'), row('2026-11', { partial: true, estimate: true })],
        options: ['2026', '2025'],
      }),
    );
    let html = await render({ view: 'month', year: '2026' });
    expect(html).toContain('Showing 2026, by month');
    expect(html).toContain('Show what made up October 2026');
    expect(html).toContain('<option value="2025">2025</option>');
    expect(html).toContain('By month');

    vi.spyOn(platformReadService, 'getCosts').mockResolvedValueOnce(
      costs({
        view: { kind: 'year' },
        rows: [row('2025'), row('2026', { partial: true })],
        totals: { awsMicroUsd: 1, modelsMicroUsd: 1, totalMicroUsd: 2, partial: false },
        options: [],
      }),
    );
    html = await render({ view: 'year' });
    expect(html).toContain('Showing every year with recorded cost');
    expect(html).toContain('Show what made up 2025');
    expect(html).not.toContain('<select');
    expect(html).toContain('All years<');
    expect(html).not.toContain('All years · so far');
  });

  it('Panel 4 — AWS unavailable: em dashes and its error, Models still drawn, no Fetched line', async () => {
    await signIn();
    vi.spyOn(platformReadService, 'getCosts').mockResolvedValue(
      costs({
        awsAvailable: false,
        awsFetchedAt: null,
        rows: [row('2026-11-17', { awsMicroUsd: null, totalMicroUsd: null, awsLines: [] })],
        totals: { awsMicroUsd: null, modelsMicroUsd: 5, totalMicroUsd: null, partial: true },
      }),
    );
    const html = await render({ view: 'day', month: '2026-11' });
    expect(html).toContain('data-testid="costs-unavailable-aws"');
    expect(html).toContain('AWS costs can’t be shown right now');
    expect(html).toContain('aria-label="Unavailable">—');
    expect(html).not.toContain('AWS figures fetched');
    expect(html).toContain('$348.42');
  });

  it('Panel 5 — Models unavailable: the mirror', async () => {
    await signIn();
    vi.spyOn(platformReadService, 'getCosts').mockResolvedValue(
      costs({
        modelsAvailable: false,
        rows: [row('2026-11-17', { modelsMicroUsd: null, totalMicroUsd: null, modelLines: [] })],
        totals: { awsMicroUsd: 5, modelsMicroUsd: null, totalMicroUsd: null, partial: false },
      }),
    );
    const html = await render({});
    expect(html).toContain('data-testid="costs-unavailable-models"');
    expect(html).toContain('Model costs can’t be shown right now');
    expect(html).not.toContain('costs-unavailable-aws');
  });

  it('Panel 6 — both unavailable: one error, no figures, no rows', async () => {
    await signIn();
    vi.spyOn(platformReadService, 'getCosts').mockResolvedValue(
      costs({ awsAvailable: false, modelsAvailable: false, awsFetchedAt: null }),
    );
    const html = await render({});
    expect(html).toContain('data-testid="costs-unavailable-both"');
    expect(html).toContain('Costs can’t be shown right now');
    expect(html).not.toContain('costs-figure-');
    expect(html).not.toContain('data-testid="costs-rows"');
  });

  it('Panel 7 — Empty: one card naming the range, no figures, no rows', async () => {
    await signIn();
    vi.spyOn(platformReadService, 'getCosts').mockResolvedValue(
      costs({ view: { kind: 'day', month: '2025-02' }, empty: true }),
    );
    const html = await render({ view: 'day', month: '2025-02' });
    expect(html).toContain('No costs recorded for February 2025');
    expect(html).toContain('Choose another month to see its costs.');
    expect(html).not.toContain('costs-figure-');
  });

  it('Panel 8 — Loading: the header and toolbar flush first, the bars pulse behind aria-busy', async () => {
    await signIn();
    const pending = deferred<CostsPageDTO>();
    vi.spyOn(platformReadService, 'getCosts').mockReturnValue(pending.promise);
    const flush = await renderFirstFlush(await Page({ searchParams: Promise.resolve({}) }));
    const shell = decode(flush.shell);
    expect(shell).toContain('Costs</h1>');
    expect(shell).toContain('Showing November 2026, by day (UTC)');
    pending.resolve(costs());
    // The fallback (aria-busy, its status label, the bars) was streamed ahead of
    // the figures it stands in for.
    const complete = decode(await flush.complete());
    expect(complete).toContain('Loading costs');
    expect(complete.indexOf('aria-busy="true"')).toBeGreaterThan(-1);
    expect(complete.indexOf('aria-busy="true"')).toBeLessThan(complete.indexOf('$556.92'));
  });
});

describe('the drill-down', () => {
  const labels = {
    aws: 'AWS by service',
    models: 'Models by provider',
    service: 'Service',
    provider: 'Provider',
    amount: 'Amount',
    share: 'Share',
    tax: 'Tax',
    credits: 'Credits',
    refund: 'Refund',
  };
  const format = createFormatter({ locale: 'en', timeZone: 'UTC' });

  it('draws AWS by service then Tax, Credits and Refund, and Models by provider name', async () => {
    const { CostsDrillDown } = await import('@/app/(admin)/admin/costs/_components/CostsDrillDown');
    const html = decode(
      await renderToHtml(
        <CostsDrillDown
          format={format}
          row={row('2026-11-17', {
            modelLines: [
              ...row('2026-11-17').modelLines,
              { provider: 'zero', amountMicroUsd: 0, share: null },
            ],
          })}
          awsAvailable
          modelsAvailable
          labels={labels}
        />,
      ),
    );
    expect(html).toContain('data-testid="costs-breakdown-aws"');
    expect(html).toContain('AWS by service');
    expect(html).toContain('$208.50');
    expect(html).toContain('Amazon Elastic Container Service');
    expect(html).toContain('34.4%');
    expect(html).toContain('style="width:34%"');
    expect(html).toContain('<span class="font-medium">Tax</span>');
    expect(html).toContain('<span class="font-medium">Credits</span>');
    expect(html).toContain('<span class="font-medium">Refund</span>');
    // A negative line carries U+2212 and draws no bar.
    expect(html).toContain('\u2212$16.50');
    expect(html).toContain('\u22127.9%');
    expect(html.match(/style="width:/g)).toHaveLength(4);
    expect(html).toContain('Models by provider');
    expect(html).toContain('Anthropic');
    expect(html).toContain('mystery');
    expect(html).toContain('>—<');
  });

  it('draws no breakdown for a source that is unavailable or holds no figure', async () => {
    const { CostsDrillDown } = await import('@/app/(admin)/admin/costs/_components/CostsDrillDown');
    const html = await renderToHtml(
      <CostsDrillDown
        format={format}
        row={row('2026-11-17', { modelsMicroUsd: null })}
        awsAvailable={false}
        modelsAvailable
        labels={labels}
      />,
    );
    expect(html).not.toContain('costs-breakdown-aws');
    expect(html).not.toContain('costs-breakdown-models');
  });
});
