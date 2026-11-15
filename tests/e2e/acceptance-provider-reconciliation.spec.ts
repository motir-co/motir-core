import { writeFileSync } from 'node:fs';
import { test, expect } from './_helpers/acceptance-video';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signUpToOnboarding } from './_helpers/shell-session';
import type { RawProviderReconciliation } from '@/lib/ai/motirAiClient';
import type { PlatformUsageFixture } from '@/lib/test-platform-usage-mock';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-11350 — a platform admin reads the month's provider bills beside what
 * Motir recorded, on Usage & cost, walked as the story's acceptance receipt
 * (MOTIR-11387; design MOTIR-11375's `…--provider-bills.mock.html`).
 *
 * The page reads motir-ai on the SERVER, so a browser route stub could not reach it.
 * motir-ai's reconciliation read is answered in the application's own process by the
 * lane's `E2E_TEST_PLATFORM_USAGE` mock (`lib/test-platform-usage-mock.ts`), from the
 * fixture this spec writes: every request re-reads the file, so a chapter changes
 * what motir-ai says by rewriting it.
 *
 *  1. The admin opens the console from the account menu, reaches Usage & cost and
 *     picks LAST month from the period switch (always in the switch, always closed).
 *  2. Per provider and UTC day: recorded beside billed and the gap, each day's source
 *     (API, balance snapshot, export); the day past tolerance marked, with its
 *     estimated rows, its finding's differing side and its per-model breakdown.
 *  3. A failed read and the provider with no bill source, each drawn distinctly from
 *     a reconciled day; the unreconciled provider listed for the month.
 *  4. Read-only: the section holds only disclosure controls, nothing that writes.
 *  5. A month with nothing recorded: the empty state; motir-ai answering the route
 *     with a 503 problem+json: the section's error state. The page renders around
 *     both.
 *
 * NO LOADING STATE is asserted: the section renders in the page's one server render
 * (no `loading.tsx`, no in-page `<Suspense>`, MOTIR-11376), so there is none to
 * observe. Every wait is a URL the server set or a server-rendered heading or row,
 * every locator a role.
 */

const us = enMessages.platformAdmin.usage;
const rc = us.reconciliation;
const nav = enMessages.platformAdmin.nav;
const menu = enMessages.shell.userMenu;

const STAFF = 'acceptance-provider-bills-staff@example.com';
const PLATFORM_FIXTURE =
  process.env['MOTIR_AI_PLATFORM_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-platform-fixture.json';

/** A message as a literal pattern — several carry punctuation. */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));

/** Last UTC month, and the one before it — both in the switch's 24, both closed. */
const ym = (back: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    .toISOString()
    .slice(0, 7);
};
const MONTH = ym(1);
const QUIET_MONTH = ym(2);
const D1 = `${MONTH}-01`;
const D2 = `${MONTH}-02`;
const at = (day: string, time: string) => `${day}T${time}.000Z`;
const nextDay = (day: string) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The page's own UTC day label (`Mon, Sep 1`), so a row is found by what it shows. */
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

const RECONCILIATION: RawProviderReconciliation = {
  period: MONTH,
  providers: [
    {
      provider: 'anthropic',
      relativeTolerance: 0.05,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: D1,
          recordedMicroUsd: 12_000_000,
          billedMicroUsd: 14_500_000,
          source: 'api',
          status: 'reconciled',
          readAt: at(nextDay(D1), '03:10:00'),
          gapMicroUsd: 2_500_000,
          pastTolerance: true,
          perModel: [
            { model: 'claude-opus-4-6', recordedMicroUsd: 9_000_000, billedMicroUsd: 11_500_000 },
            { model: 'claude-sonnet-4-6', recordedMicroUsd: 3_000_000, billedMicroUsd: 3_000_000 },
          ],
          estimatedRowCount: 4,
        },
        {
          day: D2,
          recordedMicroUsd: 10_000_000,
          billedMicroUsd: 10_100_000,
          source: 'api',
          status: 'reconciled',
          readAt: at(nextDay(D2), '03:10:00'),
          gapMicroUsd: 100_000,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
    {
      provider: 'deepseek',
      relativeTolerance: 0.1,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: D1,
          recordedMicroUsd: 2_000_000,
          billedMicroUsd: 2_050_000,
          source: 'balance_snapshot',
          status: 'reconciled',
          readAt: at(nextDay(D1), '00:05:00'),
          gapMicroUsd: 50_000,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
        {
          day: D2,
          recordedMicroUsd: 1_800_000,
          billedMicroUsd: null,
          source: 'none',
          status: 'failed',
          readAt: at(nextDay(D2), '00:05:00'),
          gapMicroUsd: null,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
    {
      provider: 'openai',
      relativeTolerance: 0.05,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: D1,
          recordedMicroUsd: 4_000_000,
          billedMicroUsd: 4_000_000,
          source: 'export',
          status: 'reconciled',
          readAt: at(nextDay(D1), '06:00:00'),
          gapMicroUsd: 0,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
    {
      provider: 'moonshotai',
      relativeTolerance: 0.05,
      absoluteToleranceMicroUsd: 500_000,
      days: [
        {
          day: D1,
          recordedMicroUsd: 700_000,
          billedMicroUsd: null,
          source: 'none',
          status: 'unreconciled',
          readAt: null,
          gapMicroUsd: null,
          pastTolerance: false,
          perModel: [],
          estimatedRowCount: null,
        },
      ],
    },
  ],
  findings: [
    {
      provider: 'anthropic',
      day: D1,
      recordedMicroUsd: 12_000_000,
      billedMicroUsd: 14_500_000,
      gapMicroUsd: 2_500_000,
      models: [
        {
          model: 'claude-opus-4-6',
          recordedMicroUsd: 9_000_000,
          billedMicroUsd: 11_500_000,
          gapMicroUsd: 2_500_000,
        },
      ],
      estimatedRowCount: 4,
      differingSide: 'gateway',
    },
  ],
  unreconciledProviders: ['moonshotai'],
};

function writeFixture(extra: Partial<PlatformUsageFixture> = {}) {
  const fixture: PlatformUsageFixture = {
    orgs: [],
    providerReconciliation: { [MONTH]: RECONCILIATION },
    ...extra,
  };
  writeFileSync(PLATFORM_FIXTURE, JSON.stringify(fixture), 'utf8');
}

test('a platform admin reads a month of provider bills beside what Motir recorded', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-11350');
  test.setTimeout(240_000);

  await resetDatabase();
  writeFixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await signUpToOnboarding(page, STAFF);
  await adminDb.user.update({ where: { email: STAFF }, data: { platformRole: 'support' } });

  const main = page.getByRole('main');
  const bills = main.getByRole('region', { name: rc.title });
  const days = (provider: string) =>
    bills.getByRole('table', { name: fill(rc.summary.days, { provider }) });
  const dayRow = (provider: string, day: string) =>
    days(provider).getByRole('row', { name: literal(dayLabel(day)) });

  await chapter('The admin opens Usage & cost from the console and picks last month', async () => {
    await page.goto('/workbench');
    await page.getByRole('button', { name: menu.account }).click();
    await page.getByRole('link', { name: literal(menu.platformAdmin) }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByRole('link', { name: nav.usage }).click();
    await expect(page).toHaveURL(/\/admin\/usage/);
    await expect(page.getByRole('heading', { name: us.title, level: 1 })).toBeVisible();

    await main.getByRole('combobox', { name: us.period.month }).selectOption(MONTH);
    await expect(page).toHaveURL(new RegExp(`[?&]period=${MONTH}`));
    await expect(bills.getByRole('heading', { name: rc.title, level: 2 })).toBeVisible();
    await expect(main.getByRole('heading', { name: us.categories.title })).toBeVisible();
    await beat();
  });

  await chapter(
    'Each provider, day by day: recorded beside billed, the gap, and the source',
    async () => {
      // A provider card opens on its own when a day is past tolerance or failed.
      const anthropic = dayRow('Anthropic', D1);
      await expect(anthropic).toBeVisible();
      for (const figure of ['$12.00', '$14.50', '+$2.50', rc.source.api]) {
        await expect(anthropic).toContainText(figure);
      }
      await expect(dayRow('DeepSeek', D1)).toContainText(rc.source.balance_snapshot);
      await expect(dayRow('DeepSeek', D1)).toContainText('$2.05');

      // OpenAI reconciled cleanly, so its card stays closed until the admin opens it.
      await bills.getByText('OpenAI', { exact: true }).click();
      await expect(dayRow('OpenAI', D1)).toBeVisible();
      for (const figure of ['$4.00', rc.source.export]) {
        await expect(dayRow('OpenAI', D1)).toContainText(figure);
      }
      await beat();
    },
  );

  await chapter(
    'The day past tolerance: marked, its estimated rows, its side and its models',
    async () => {
      const row = dayRow('Anthropic', D1);
      await expect(row).toContainText(rc.pastTolerance);
      await expect(row).toContainText('4 rows estimated');

      const findings = bills.getByRole('table', { name: literal(rc.findings.title) });
      const finding = findings.getByRole('row', { name: literal(dayLabel(D1)) });
      await expect(finding).toContainText('Anthropic');
      await expect(finding).toContainText('claude-opus-4-6');
      await expect(finding).toContainText(rc.side.gateway);

      await row
        .getByRole('button', { name: fill(rc.perModel.aria, { day: dayLabel(D1) }) })
        .click();
      const breakdown = days('Anthropic').getByRole('row', { name: /claude-opus-4-6/ });
      await expect(breakdown).toBeVisible();
      await expect(breakdown).toContainText('$11.50');
      await expect(days('Anthropic').getByRole('row', { name: /claude-sonnet-4-6/ })).toBeVisible();
      await beat();
    },
  );

  await chapter('A failed read and a provider with no bill source, each drawn apart', async () => {
    const failed = dayRow('DeepSeek', D2);
    await expect(failed).toContainText(rc.status.failed);
    await expect(failed).not.toContainText(rc.status.reconciled);
    await expect(dayRow('DeepSeek', D1)).toContainText(rc.status.reconciled);

    const noSource = bills.getByRole('heading', { name: rc.unreconciled.title });
    await expect(noSource).toBeVisible();
    await expect(bills.getByRole('listitem').filter({ hasText: 'Moonshot AI' })).toBeVisible();

    await bills.getByText('Moonshot AI', { exact: true }).last().click();
    const moonshot = dayRow('Moonshot AI', D1);
    await expect(moonshot).toContainText(rc.status.unreconciled);
    await expect(moonshot).toContainText(rc.source.none);
    await expect(moonshot).not.toContainText(rc.status.reconciled);
    await beat();
  });

  await chapter('Read-only: the section offers no control that writes', async () => {
    // Only disclosures: each provider card's summary and the per-model expanders.
    // No form, no link, no field, and no other button.
    await expect(bills.locator('form')).toHaveCount(0);
    await expect(bills.getByRole('link')).toHaveCount(0);
    await expect(bills.getByRole('textbox')).toHaveCount(0);
    await expect(bills.getByRole('combobox')).toHaveCount(0);
    const controls = await bills
      .locator('button, summary, input, select, textarea, [role="button"]')
      .evaluateAll((els) =>
        els.map((el) => ({ tag: el.tagName, label: el.getAttribute('aria-label') ?? '' })),
      );
    expect(controls.filter((c) => c.tag === 'BUTTON').length).toBeGreaterThan(0);
    for (const c of controls) {
      if (c.tag === 'SUMMARY') continue;
      expect(c.tag).toBe('BUTTON');
      expect(c.label).toMatch(/^Show the bill for .+ by model$/);
    }
    await beat();
  });

  await chapter('A month with nothing recorded, and motir-ai not answering', async () => {
    await main.getByRole('combobox', { name: us.period.month }).selectOption(QUIET_MONTH);
    await expect(page).toHaveURL(new RegExp(`[?&]period=${QUIET_MONTH}`));
    await expect(
      bills.getByText(fill(rc.empty.title, { month: monthLabel(QUIET_MONTH) })),
    ).toBeVisible();
    await expect(main.getByRole('heading', { name: us.categories.title })).toBeVisible();
    await beat();

    writeFixture({ providerReconciliationError: true });
    await main.getByRole('combobox', { name: us.period.month }).selectOption(MONTH);
    await expect(page).toHaveURL(new RegExp(`[?&]period=${MONTH}`));
    await expect(bills.getByRole('heading', { name: rc.error.title })).toBeVisible();
    await expect(bills.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: us.title, level: 1 })).toBeVisible();
    await expect(main.getByRole('heading', { name: us.categories.title })).toBeVisible();
    await beat();
  });
});
