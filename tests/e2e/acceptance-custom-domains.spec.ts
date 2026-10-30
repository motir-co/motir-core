import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import type { PublicAddressDto } from '@/lib/dto/publicAddresses';
import en from '@/messages/en.json';

/*
 * CUSTOMER-OWNED DOMAINS — the story's acceptance walk
 * (Story MOTIR-4533 · Subtask MOTIR-9533).
 *
 * The first test is the recording: an owner reaches the workspace Custom domains
 * pane by both doors, is refused a Motir address in its own words, adds a
 * subdomain naming one of the workspace's applications in the picker, watches
 * it reach Issued with that application on its row, loses the ownership TXT and
 * sees the failure with its Re-check, restores it and recovers, then removes the
 * domain through the confirm that says nothing is reserved. The rest are the
 * arms a reviewer does not need to watch: a domain added naming no application
 * and then bound, a bound domain re-pointed, the apex records and
 * `pointing_lost`, the free-tier upsell and the read-only member.
 *
 * The workspace has TWO applications of one project, `shop` and `blog`. They
 * share the project's name, which is the case where the picker and the row tell
 * them apart by slug (design `custom-domains--application.mock.html`).
 *
 * ── WHY THE ACCEPTANCE LANE ────────────────────────────────────────────────
 * Custom domains are cloud-only and tier-gated. The main lane runs cloud-off,
 * where the entitlement path short-circuits and the pane never renders
 * (`docs/acceptance-lane-triage.md`). `playwright.acceptance.config.ts` runs
 * cloud-on with `MOTIR_E2E_FAKE_PUBLIC_ADDRESS_PROVIDERS=1` and the three
 * pointing-record variables, and `.github/workflows/acceptance-tests.yml`
 * publishes the receipt from a green run.
 *
 * ── HOW THE FAKED PORTS ARE DRIVEN ─────────────────────────────────────────
 * The resolver and the certificate provider are in-memory IN THE SERVER
 * (`lib/publicAddresses/providers.ts`). The add seeds the TXT the service just
 * minted, so *Check now* walks the real verify order. Everything after that —
 * deleting the TXT, un-pointing a host, running the five-minute sweep — goes
 * through the lane-only door `POST /api/_test/public-addresses/fakes`, which
 * this card added. A live domain is re-checked only once its last check is an
 * hour old, so before each sweep the spec ages that one row's `lastCheckedAt`
 * (the erasure-sweep walk ages a due date the same way).
 *
 * ── WHAT IS NOT DRIVEN HERE ────────────────────────────────────────────────
 * The site-origin refusal: this lane's site origin (`public.motir.e2e`) sits
 * under its tenant base (`motir.e2e`), and the tenant-base check runs first, so
 * no hostname reaches the site-origin arm. Its own sentence is asserted in
 * `tests/settings/customDomainsPane.test.tsx` and the refusal in
 * `tests/publicAddresses/customDomainStoryGate.test.ts`. A *Pending* pill is not
 * shown either: the fake issues at once by design. Service-level transitions
 * are the Vitest gate's and are not re-asserted.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const copy = en.settings.customDomains;
const PASSWORD = 'Sup3rSecret!Pass';
const OWNER = 'domains-owner@motir.test';
const MEMBER = 'domains-member@motir.test';
const FREE_OWNER = 'domains-free@motir.test';
const PANE = '/settings/workspace/custom-domains';
const SUBDOMAIN = 'app.acme.test';
const UNBOUND = 'docs.acme.test';
const APEX = 'acme.test';
/** The project both seeded applications belong to, so the name they share. */
const APP_NAME = 'Acme roadmap';
const apps = { shop: '', blog: '' };
/** The option a picker offers for one of the two same-named applications. */
const optionName = (slug: string) => `${APP_NAME} (${slug})`;
/** The Application line of a row naming that application. */
const serves = (slug: string) => `Serves ${APP_NAME} ${slug}.`;
const CNAME_TARGET = 'edge.motir.e2e';
const A_RECORD = '192.0.2.10';
const AAAA_RECORD = '2001:db8::10';
/** Copy that must never appear: one domain, one application, no primary. */
const NEVER = /primary|redirect/i;

let workspaceId = '';

const pathOf = (r: Response) => new URL(r.url()).pathname;
const domainsBase = () => `/api/workspaces/${workspaceId}/custom-domains`;
const addWrite = (page: Page) =>
  page.waitForResponse((r) => pathOf(r) === domainsBase() && r.request().method() === 'POST');
const verifyWrite = (page: Page) =>
  page.waitForResponse((r) => pathOf(r).endsWith('/verify') && r.request().method() === 'POST');
const bindWrite = (page: Page) =>
  page.waitForResponse(
    (r) => pathOf(r).startsWith(`${domainsBase()}/`) && r.request().method() === 'PATCH',
  );
const removeWrite = (page: Page) =>
  page.waitForResponse(
    (r) => pathOf(r).startsWith(`${domainsBase()}/`) && r.request().method() === 'DELETE',
  );
const pane = (page: Page) => page.getByRole('main');
/** A domain row — the `li` the pane marks with its status. */
const rows = (page: Page) => pane(page).locator('li[data-status]');
const row = (page: Page, host: string) => rows(page).filter({ hasText: host });

/** The committed row, read from the list route rather than from the pane. */
async function storedRow(page: Page, host: string): Promise<PublicAddressDto | undefined> {
  const res = await page.request.get(domainsBase());
  expect(res.status()).toBe(200);
  return ((await res.json()) as PublicAddressDto[]).find((a) => a.hostname === host);
}

/** Flip the server's faked ports and run the sweep once (see the header). */
async function fakes(
  page: Page,
  body: {
    txt?: { name: string; values: string[] };
    pointing?: { hostname: string; pointed: boolean };
    sweep?: boolean;
  },
) {
  const res = await page.request.post('/api/_test/public-addresses/fakes', { data: body });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as { sweep: { scanned: number; changed: number } | null };
}

/** Make one live row due a re-check, then sweep. */
async function sweepNow(page: Page, host: string) {
  await adminDb.publicAddress.updateMany({
    where: { hostname: host },
    data: { lastCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  });
  const { sweep } = await fakes(page, { sweep: true });
  expect(sweep?.scanned).toBeGreaterThan(0);
}

/** Choose an option in an application picker inside `scope`. */
async function pick(page: Page, scope: ReturnType<Page['getByRole']>, option: string) {
  await scope.getByRole('combobox', { name: copy.dialog.appLabel }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/**
 * Add a domain, choosing `application` in the picker: an application's slug, or
 * `null` for `No application yet`. Asserts the POST carried that choice.
 */
async function addDomain(
  page: Page,
  host: string,
  application: keyof typeof apps | null,
): Promise<PublicAddressDto> {
  await pane(page).getByRole('button', { name: copy.add }).click();
  const dialog = page.getByRole('dialog', { name: copy.dialog.title });
  await dialog.getByRole('textbox', { name: copy.dialog.label }).fill(host);
  // Two applications: nothing is preselected, so Add waits for the choice.
  await expect(dialog.getByRole('button', { name: copy.add })).toBeDisabled();
  await pick(page, dialog, application ? optionName(application) : copy.dialog.appNone);
  const added = addWrite(page);
  await dialog.getByRole('button', { name: copy.add }).click();
  const res = await added;
  expect(res.request().postDataJSON()).toEqual({
    hostname: host,
    applicationId: application ? apps[application] : null,
  });
  expect(res.status(), await res.text()).toBe(201);
  const dto = (await res.json()) as PublicAddressDto;
  expect(dto).toMatchObject({ hostname: host, status: 'unverified' });
  await expect(dialog).toHaveCount(0);
  return dto;
}

/** Check now on an unverified row, and wait for Issued. */
async function checkNow(page: Page, host: string) {
  const verified = verifyWrite(page);
  await row(page, host).getByRole('button', { name: copy.action.checkNow }).click();
  const res = await verified;
  expect(res.status(), await res.text()).toBe(200);
  await expect(row(page, host).getByText(copy.status.issued, { exact: true })).toBeVisible();
}

/** A hosted application of the workspace, as the picker lists it. */
async function seedApplication(workspace: string, project: string, slug: string, position: string) {
  const repo = await adminDb.projectRepo.create({
    data: {
      workspaceId: workspace,
      projectId: project,
      role: 'web',
      name: slug,
      position,
      seedSource: 'initialised',
    },
  });
  const app = await adminDb.hostedApplication.create({
    data: {
      workspaceId: workspace,
      projectId: project,
      projectRepositoryId: repo.id,
      target: 'fly',
      slug,
    },
  });
  return app.id;
}

async function seedOwner(email: string, name: string, workspaceName: string, key: string) {
  const owner = await usersService.createUser({ email, password: PASSWORD, name });
  const { workspace } = await workspacesService.createWorkspace({
    name: workspaceName,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: `${workspaceName} roadmap`,
    identifier: key,
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  await adminDb.project.update({ where: { id: project.id }, data: projectAccessData('public') });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { owner, workspace, project };
}

test.beforeAll(async () => {
  await resetDatabase();

  const a = await seedOwner(OWNER, 'Ada Owner', 'Acme', 'ROADMAP');
  workspaceId = a.workspace.id;
  apps.shop = await seedApplication(a.workspace.id, a.project.id, 'shop', 'a0');
  apps.blog = await seedApplication(a.workspace.id, a.project.id, 'blog', 'a1');
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: a.workspace.id },
    select: { organizationId: true },
  });
  // A paid tier: `free: 0` is the upsell, which the free-tier test asserts.
  await adminDb.organization.update({
    where: { id: organizationId },
    data: {
      scaledTrackerSubscription: { status: 'active', priceId: 'price_e2e', quantity: 1 } as never,
    },
  });
  // A second workspace in the same organization reveals the workspace tier, so
  // the settings rail lists its rooms (`lib/workspaces/tierDisclosure.ts`).
  await workspacesService.createWorkspace({
    name: 'Acme Labs',
    ownerUserId: a.owner.id,
    organizationId,
  });
  // The workspace's own name, so Public address shows the door to this pane.
  // Written as the row a claim writes: the base domain is the SERVER's.
  await adminDb.publicAddress.create({
    data: {
      workspaceId: a.workspace.id,
      hostname: 'acme.motir.e2e',
      kind: 'workspace_subdomain',
      status: 'active',
    },
  });

  const member = await usersService.createUser({
    email: MEMBER,
    password: PASSWORD,
    name: 'Mia Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: a.workspace.id });
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: a.workspace.id,
    projectId: a.project.id,
  });

  await seedOwner(FREE_OWNER, 'Fay Free', 'Freebird', 'FREE');
});

test('a workspace owner adds a domain, watches it go live, loses and restores its TXT, and removes it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4533');
  let added: PublicAddressDto | undefined;

  await chapter('Two doors into Custom domains: the settings rail and Public address', async () => {
    await signIn(page, OWNER, PASSWORD);
    await page.goto('/settings/workspace/public-address');
    const door = pane(page).getByRole('link', {
      name: en.settings.workspaceAddress.customDomainsLink,
    });
    await expect(door).toBeVisible({ timeout: FIRST_PAINT_MS });
    await beat();
    await door.click();
    await page.waitForURL((url) => url.pathname === PANE);
    await expect(pane(page).getByText(copy.empty.title)).toBeVisible();

    await page.goto('/settings/workspace/public-address');
    const rail = page.getByRole('navigation', { name: en.settings.workspace.eyebrow });
    await rail.getByRole('link', { name: en.settings.workspace.nav.customDomains }).click();
    await page.waitForURL((url) => url.pathname === PANE);
    await expect(pane(page).getByText(copy.empty.title)).toBeVisible();
    await expect(pane(page).getByRole('button', { name: copy.add })).toBeVisible();
    await expect(pane(page).getByText(NEVER)).toHaveCount(0);
    await beat();
  });

  await chapter(
    'A Motir address is refused in its own words, and the dialog stays open',
    async () => {
      await pane(page).getByRole('button', { name: copy.add }).click();
      const dialog = page.getByRole('dialog', { name: copy.dialog.title });
      await dialog.getByRole('textbox', { name: copy.dialog.label }).fill('shop.motir.e2e');
      await pick(page, dialog, optionName('shop'));
      const refused = addWrite(page);
      await dialog.getByRole('button', { name: copy.add }).click();
      const res = await refused;
      expect(res.status()).toBe(422);
      await expect(
        dialog.getByText(
          copy.refuse.tenantBase.replace('{host}', 'shop.motir.e2e').replace('{base}', 'motir.e2e'),
        ),
      ).toBeVisible();
      await beat();
      await dialog.getByRole('button', { name: copy.dialog.cancel }).click();
      await expect(rows(page)).toHaveCount(0);
    },
  );

  await chapter(
    'Adding a subdomain for the shop: Unverified, with the TXT and the CNAME',
    async () => {
      added = await addDomain(page, SUBDOMAIN, 'shop');
      const r = row(page, SUBDOMAIN);
      await expect(r.getByText(copy.status.unverified, { exact: true })).toBeVisible();
      await expect(r.getByRole('cell', { name: `_motir-verify.${SUBDOMAIN}` })).toBeVisible();
      await expect(r.getByRole('cell', { name: added.verification!.value })).toBeVisible();
      await expect(r.getByRole('cell', { name: 'CNAME', exact: true })).toBeVisible();
      await expect(r.getByRole('cell', { name: CNAME_TARGET })).toBeVisible();
      await expect(r.getByRole('cell', { name: 'A', exact: true })).toHaveCount(0);
      await expect(r.getByRole('cell', { name: 'AAAA', exact: true })).toHaveCount(0);
      await expect(r.getByRole('button', { name: copy.action.copy }).first()).toBeVisible();
      await beat();
    },
  );

  await chapter('Check now: ownership proven, the certificate Issued', async () => {
    const verified = verifyWrite(page);
    await row(page, SUBDOMAIN).getByRole('button', { name: copy.action.checkNow }).click();
    const res = await verified;
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ hostname: SUBDOMAIN, status: 'issued' });

    const r = row(page, SUBDOMAIN);
    await expect(r.getByText(copy.status.issued, { exact: true })).toBeVisible();
    await expect(r.getByRole('link', { name: SUBDOMAIN })).toHaveAttribute(
      'href',
      `https://${SUBDOMAIN}`,
    );
    // The application chosen in the picker, by name and slug.
    await expect(r.getByText(serves('shop'))).toBeVisible();
    await expect(pane(page).getByText(NEVER)).toHaveCount(0);
    await beat();
  });

  await chapter('The ownership TXT disappears: Failed, naming the record to restore', async () => {
    await fakes(page, { txt: { name: added!.verification!.name, values: [] } });
    await sweepNow(page, SUBDOMAIN);
    await expect
      .poll(async () => {
        const stored = await storedRow(page, SUBDOMAIN);
        return [stored?.status, stored?.failureKind];
      })
      .toEqual(['failed', 'txt_lost']);

    await page.reload();
    const r = row(page, SUBDOMAIN);
    await expect(r.getByText(copy.status.failed, { exact: true })).toBeVisible();
    const banner = r.locator('[data-failure="txt_lost"]');
    await expect(banner.getByText(copy.fail.txt)).toBeVisible();
    await expect(banner.getByRole('cell', { name: `_motir-verify.${SUBDOMAIN}` })).toBeVisible();
    await expect(banner.getByRole('button', { name: copy.action.recheck })).toBeVisible();
    await beat();
  });

  await chapter('The TXT is restored and Re-check brings it back to Issued', async () => {
    await fakes(page, {
      txt: { name: added!.verification!.name, values: [added!.verification!.value] },
    });
    const verified = verifyWrite(page);
    await row(page, SUBDOMAIN).getByRole('button', { name: copy.action.recheck }).click();
    const res = await verified;
    expect(res.status(), await res.text()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'issued', failureKind: null });

    const r = row(page, SUBDOMAIN);
    await expect(r.getByText(copy.status.issued, { exact: true })).toBeVisible();
    await expect(r.locator('[data-failure]')).toHaveCount(0);
    await beat();
  });

  await chapter('Removing it: nothing is reserved, and the address stops answering', async () => {
    await row(page, SUBDOMAIN).getByRole('button', { name: copy.action.remove }).click();
    const confirm = page.getByRole('dialog', {
      name: copy.remove.title.replace('{host}', SUBDOMAIN),
    });
    await expect(confirm.getByText(copy.remove.body)).toBeVisible();
    await beat();
    const removed = removeWrite(page);
    await confirm.getByRole('button', { name: copy.remove.confirm }).click();
    expect((await removed).status()).toBe(204);

    await expect(row(page, SUBDOMAIN)).toHaveCount(0);
    await page.reload();
    await expect(pane(page).getByText(copy.empty.title)).toBeVisible();
    await expect(row(page, SUBDOMAIN)).toHaveCount(0);
    const host = await page.request.get(`/api/public/hosts/${SUBDOMAIN}`);
    expect(host.status()).toBe(404);
    await beat();
  });
});

test('a domain added naming no application serves nothing until it is bound, then re-points', async ({
  page,
}) => {
  await signIn(page, OWNER, PASSWORD);
  await page.goto(PANE);
  await expect(pane(page).getByRole('button', { name: copy.add })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });

  await addDomain(page, UNBOUND, null);
  await checkNow(page, UNBOUND);
  const r = row(page, UNBOUND);
  await expect(r.getByText(copy.app.none)).toBeVisible();
  await r.getByRole('button', { name: copy.action.showDns }).click();
  const records = await r.locator('table').allTextContents();
  expect(records.length).toBeGreaterThan(0);

  // Bind it: the control reads Choose, and the confirm says what changes.
  await r.getByRole('button', { name: `${copy.app.choose} for ${UNBOUND}` }).click();
  let dialog = page.getByRole('dialog', { name: copy.app.title.replace('{host}', UNBOUND) });
  await expect(dialog.getByRole('button', { name: copy.app.save })).toBeDisabled();
  await pick(page, dialog, optionName('blog'));
  await expect(
    dialog.getByText(copy.app.confirm.replace('{host}', UNBOUND).replace('{app}', APP_NAME)),
  ).toBeVisible();
  let bound = bindWrite(page);
  await dialog.getByRole('button', { name: copy.app.save }).click();
  let res = await bound;
  expect(res.request().postDataJSON()).toEqual({ applicationId: apps.blog });
  expect(res.status(), await res.text()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(r.getByText(serves('blog'))).toBeVisible();
  await expect(r).toHaveAttribute('data-status', 'issued');

  // Re-point it at the other application: the row names it, nothing else moves.
  await r.getByRole('button', { name: `${copy.app.change} for ${UNBOUND}` }).click();
  dialog = page.getByRole('dialog', { name: copy.app.title.replace('{host}', UNBOUND) });
  await pick(page, dialog, optionName('shop'));
  bound = bindWrite(page);
  await dialog.getByRole('button', { name: copy.app.save }).click();
  res = await bound;
  expect(res.request().postDataJSON()).toEqual({ applicationId: apps.shop });
  expect(res.status(), await res.text()).toBe(200);
  await expect(r.getByText(serves('shop'))).toBeVisible();

  const stored = await storedRow(page, UNBOUND);
  expect(stored).toMatchObject({ status: 'issued', applicationId: apps.shop, failureKind: null });
  await page.reload();
  await expect(row(page, UNBOUND)).toHaveAttribute('data-status', 'issued');
  await expect(row(page, UNBOUND).getByText(serves('shop'))).toBeVisible();
  await row(page, UNBOUND).getByRole('button', { name: copy.action.showDns }).click();
  expect(await row(page, UNBOUND).locator('table').allTextContents()).toEqual(records);
});

test('an apex domain is offered A and AAAA, and an un-pointed one fails with its records', async ({
  page,
}) => {
  await signIn(page, OWNER, PASSWORD);
  await page.goto(PANE);
  await expect(pane(page).getByRole('button', { name: copy.add })).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });

  await addDomain(page, APEX, 'shop');
  let r = row(page, APEX);
  await expect(r.getByRole('cell', { name: 'A', exact: true })).toBeVisible();
  await expect(r.getByRole('cell', { name: A_RECORD })).toBeVisible();
  await expect(r.getByRole('cell', { name: 'AAAA', exact: true })).toBeVisible();
  await expect(r.getByRole('cell', { name: AAAA_RECORD })).toBeVisible();
  await expect(r.getByRole('cell', { name: 'CNAME', exact: true })).toHaveCount(0);
  await expect(r.getByText(copy.records.apexNote)).toBeVisible();

  const verified = verifyWrite(page);
  await r.getByRole('button', { name: copy.action.checkNow }).click();
  expect((await verified).status()).toBe(200);
  await expect(r.getByText(copy.status.issued, { exact: true })).toBeVisible();

  await fakes(page, { pointing: { hostname: APEX, pointed: false } });
  try {
    await sweepNow(page, APEX);
    await expect
      .poll(async () => {
        const stored = await storedRow(page, APEX);
        return [stored?.status, stored?.failureKind];
      })
      .toEqual(['failed', 'pointing_lost']);
  } finally {
    // The fake is the SERVER's for the rest of the run; leave it pointed.
    await fakes(page, { pointing: { hostname: APEX, pointed: true } });
  }

  await page.reload();
  r = row(page, APEX);
  const banner = r.locator('[data-failure="pointing_lost"]');
  await expect(
    banner.getByText(copy.fail.pointing.replace('{host}', APEX), { exact: true }),
  ).toBeVisible();
  await expect(banner.getByRole('cell', { name: A_RECORD })).toBeVisible();
  await expect(banner.getByRole('cell', { name: AAAA_RECORD })).toBeVisible();
  await expect(banner.getByRole('button', { name: copy.action.recheck })).toBeVisible();
  await expect(pane(page).getByText(NEVER)).toHaveCount(0);
});

test('a free-tier workspace is offered the upgrade instead of Add domain', async ({ page }) => {
  await signIn(page, FREE_OWNER, PASSWORD);
  await page.goto(PANE);
  await expect(pane(page).getByText(copy.upsell.title)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(pane(page).getByRole('link', { name: copy.upsell.cta })).toBeVisible();
  await expect(pane(page).getByRole('button', { name: copy.add })).toHaveCount(0);
});

test('a member who cannot manage domains reads the list, with no Add or Remove', async ({
  page,
}) => {
  await signIn(page, MEMBER, PASSWORD);
  await page.goto(PANE);
  await expect(pane(page).getByText(copy.readOnly)).toBeVisible({ timeout: FIRST_PAINT_MS });
  // The apex domain the owner left behind in the previous test.
  await expect(row(page, APEX)).toBeVisible();
  await expect(pane(page).getByRole('button', { name: copy.add })).toHaveCount(0);
  await expect(pane(page).getByRole('button', { name: copy.action.remove })).toHaveCount(0);
  await expect(pane(page).getByRole('button', { name: copy.action.recheck })).toHaveCount(0);
  // The application each issued row serves is read, never changed.
  await expect(row(page, UNBOUND).getByText(serves('shop'))).toBeVisible();
  await expect(pane(page).getByRole('button', { name: new RegExp(copy.app.change) })).toHaveCount(
    0,
  );
  await expect(pane(page).getByRole('button', { name: new RegExp(copy.app.choose) })).toHaveCount(
    0,
  );
});
