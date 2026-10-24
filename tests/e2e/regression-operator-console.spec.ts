import { writeFileSync } from 'node:fs';
import { expect, test } from './_helpers/promoted-regression';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import {
  paidOrgState,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
} from './_helpers/billing';
import type { PlatformUsageFixture } from '@/lib/test-platform-usage-mock';
import enMessages from '@/messages/en.json';

/**
 * STORY MOTIR-727 (10.1) — the operator console, walked end to end (MOTIR-735).
 *
 * Over the seeded multi-tenant estate, with motir-ai's platform reads served by the
 * acceptance lane's `E2E_TEST_PLATFORM_USAGE` mock (`lib/test-platform-usage-mock.ts`)
 * and its billing reads by the `E2E_TEST_BILLING` mock.
 *
 *  1. THE DENIED PATH FIRST — a tenant member and a tenant owner each get the
 *     ordinary 404 on every console route, and no `/admin` affordance in the shell.
 *  2. THE OPERATOR — Overview, Usage & cost at a month and All time, Tenants sorted
 *     and filtered, an org's three tabs (scope set to a project, a model expanded,
 *     Billing read-only), and ← Tenants back to the same list state.
 *
 * Every wait is on an authoritative signal — a URL the server set, a server-rendered
 * heading or row — and every locator is a role (`tests/e2e-page-rooted-locators.test.ts`).
 */

const ov = enMessages.platformAdmin.overview;
const us = enMessages.platformAdmin.usage;
const tn = enMessages.platformAdmin.tenants;
const op = enMessages.platformAdmin.orgPage;
const ob = enMessages.platformAdmin.orgBilling;
const menu = enMessages.shell.userMenu;

const OWNER = 'acceptance-console-owner@example.com';
const MEMBER = 'acceptance-console-member@example.com';

/** A message as a literal pattern — several carry parentheses. */
const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const PLATFORM_FIXTURE =
  process.env['MOTIR_AI_PLATFORM_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-platform-fixture.json';

test('platform staff walk the console end to end; a tenant member and owner are denied', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-727');

  await resetDatabase();
  resetBillingFixture();

  // ── The estate: two tenants, each its owner's; the second owner also a member of the first.
  const acme = await seedBillingOwner(page, OWNER);
  setOrgBillingState(acme.organizationId, paidOrgState({ balance: 4_420 }));
  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  const other = await seedBillingOwner(memberPage, MEMBER);
  await adminDb.organizationMembership.create({
    data: { organizationId: acme.organizationId, userId: other.ownerId, role: 'member' },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: acme.workspaceId, userId: other.ownerId, workspaceRole: 'member' },
  });
  const acmeOrg = await adminDb.organization.update({
    where: { id: acme.organizationId },
    data: { name: 'Acme Console Corp' },
  });
  const otherOrg = await adminDb.organization.update({
    where: { id: other.organizationId },
    data: { name: 'Bravo Console Ltd' },
  });
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: acme.projectId } });

  const fixture: PlatformUsageFixture = {
    orgs: [
      {
        id: acme.organizationId,
        scale: 3,
        workspaces: [
          { id: acme.workspaceId, scale: 2, projects: [{ id: acme.projectId, scale: 1 }] },
        ],
      },
      {
        id: other.organizationId,
        scale: 1,
        workspaces: [{ id: other.workspaceId, scale: 1, projects: [] }],
      },
    ],
    runs: [
      {
        kind: 'coding',
        id: 'run_console_1',
        coreOrganizationId: acme.organizationId,
        coreWorkspaceId: acme.workspaceId,
        coreProjectId: acme.projectId,
        model: 'claude-opus-4-6',
        startedAt: new Date().toISOString(),
        credits: 42,
      },
    ],
  };
  writeFileSync(PLATFORM_FIXTURE, JSON.stringify(fixture), 'utf8');

  const consoleRoutes = [
    '/admin',
    '/admin/usage',
    '/admin/tenants',
    `/admin/tenants/${acme.organizationId}`,
  ];

  await chapter('The console does not exist for a tenant member or a tenant owner', async () => {
    for (const [who, p] of [
      ['member', memberPage],
      ['owner', page],
    ] as const) {
      for (const route of consoleRoutes) {
        const res = await p.goto(route);
        expect(res?.status(), `${who} ${route}`).toBe(404);
      }
      // No affordance either: the account menu offers no Platform admin row.
      await p.goto('/workbench');
      await p.getByRole('button', { name: menu.account }).click();
      await expect(p.getByRole('link', { name: literal(menu.platformAdmin) })).toHaveCount(0);
      await p.keyboard.press('Escape');
    }
    await memberContext.close();
    await beat();
  });

  // The owner is made platform staff; the gate reads a fresh row per request.
  await adminDb.user.update({ where: { email: OWNER }, data: { platformRole: 'superadmin' } });

  await chapter(
    'The operator opens the console from the account menu: the estate overview',
    async () => {
      await page.goto('/workbench');
      await page.getByRole('button', { name: menu.account }).click();
      await page.getByRole('link', { name: literal(menu.platformAdmin) }).click();
      await expect(page).toHaveURL(/\/admin$/);
      await expect(page.getByRole('heading', { name: ov.title, level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: ov.feed.title })).toBeVisible();
      // The feed carries the tenants created and the run motir-ai recorded.
      await expect(page.getByRole('row', { name: literal(ov.feed.kind.coding_run) })).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'Usage & cost — the estate by category and by model, for a month and for All time',
    async () => {
      await page.goto('/admin/usage');
      await expect(page.getByRole('heading', { name: us.title, level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: us.categories.title })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: us.models.title.planning_tokens }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: us.models.title.agent_tokens })).toBeVisible();
      await expect(
        page.getByRole('row', { name: literal(us.categories.notCharged) }),
      ).toBeVisible();

      await page.getByRole('button', { name: us.period.allTime }).click();
      await expect(page).toHaveURL(/[?&]period=all/);
      await expect(page.getByRole('heading', { name: us.categories.title })).toBeVisible();
      await expect(
        page.getByRole('heading', { name: us.models.title.planning_tokens }),
      ).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'Tenants — the list on arrival, the estate total first, sorted and filtered',
    async () => {
      await page.goto('/admin/tenants');
      await expect(page.getByRole('heading', { name: tn.title, level: 1 })).toBeVisible();
      await expect(page.getByRole('row', { name: literal(tn.estateRow) })).toBeVisible();
      await expect(page.getByRole('link', { name: literal(acmeOrg.name) })).toBeVisible();
      await expect(page.getByRole('link', { name: literal(otherOrg.name) })).toBeVisible();

      await page
        .getByRole('link', { name: enMessages.platformAdmin.usage.category.ci, exact: true })
        .click();
      await expect(page).toHaveURL(/[?&]sort=ci/);

      const filter = page.getByRole('search').getByRole('searchbox');
      await filter.fill(acmeOrg.slug);
      await filter.press('Enter');
      await expect(page).toHaveURL(new RegExp(`[?&]q=${acmeOrg.slug}`));
      await expect(page).toHaveURL(/[?&]sort=ci/);
      await expect(page.getByRole('link', { name: literal(otherOrg.name) })).toHaveCount(0);
      // The estate total still describes the whole estate.
      await expect(page.getByRole('row', { name: literal(tn.estateRow) })).toBeVisible();
      await beat();
    },
  );

  const listUrl = page.url();

  await chapter(
    'The org: Overview, then Usage & cost scoped to a project with a model open',
    async () => {
      await page.getByRole('link', { name: literal(acmeOrg.name) }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/tenants/${acme.organizationId}`));
      await expect(page.getByRole('heading', { name: acmeOrg.name, level: 1 })).toBeVisible();
      const tabs = page.getByRole('navigation', { name: op.tabsLabel });
      await expect(tabs.getByRole('link', { name: op.tabs.overview })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByRole('heading', { name: op.members.title })).toBeVisible();

      await tabs.getByRole('link', { name: op.tabs.usage }).click();
      await expect(page).toHaveURL(/[?&]tab=usage/);
      await page
        .getByRole('combobox', { name: enMessages.platformAdmin.orgUsage.scope })
        .selectOption(`project:${project.id}`);
      await expect(page).toHaveURL(new RegExp(`[?&]scope=project%3A${project.id}`));
      await page
        .getByRole('button', {
          name: literal(enMessages.platformAdmin.usage.category.planning_tokens),
        })
        .click();
      await expect(page.getByRole('row', { name: /claude-opus-4-6/ })).toBeVisible();
      await expect(page.getByRole('row', { name: /claude-sonnet-4-6/ })).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'Billing & plans — the tenant’s own page, read-only — and ← Tenants back to the same list',
    async () => {
      const tabs = page.getByRole('navigation', { name: op.tabsLabel });
      await tabs.getByRole('link', { name: op.tabs.billing }).click();
      await expect(page).toHaveURL(/[?&]tab=billing/);
      await expect(page.getByRole('heading', { name: ob.bill.title })).toBeVisible();
      await expect(page.getByRole('heading', { name: ob.payment.title })).toBeVisible();
      // No tenant action, under any of the names the tenant's page gives them.
      await expect(
        page.getByRole('button', {
          name: /change plan|manage payment|customer portal|top up|upgrade/i,
        }),
      ).toHaveCount(0);
      await expect(page.getByRole('link', { name: /customer portal|manage payment/i })).toHaveCount(
        0,
      );

      // ← Tenants is the back button, not the sidebar's row of the same name.
      await page
        .getByRole('link', { name: op.back, exact: true })
        .and(page.locator('a[href^="/admin/tenants?"]'))
        .click();
      await expect(page).toHaveURL(listUrl);
      await expect(page.getByRole('search').getByRole('searchbox')).toHaveValue(acmeOrg.slug);
      await beat();
    },
  );
});
