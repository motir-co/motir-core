import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { publicSubdomainService } from '@/lib/services/publicSubdomainService';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { CHANGE_INTERVAL_DAYS, GRACE_HOURS, QUARANTINE_DAYS } from '@/lib/publicAddresses/nameHold';
import en from '@/messages/en.json';

/*
 * THE WORKSPACE SUBDOMAIN, REBUILT — the story's acceptance walk
 * (Story MOTIR-4528 · Subtask MOTIR-9518).
 *
 * One continuous test, so the recording shows the story in order: an owner
 * claims a name from WORKSPACE settings, renames it through the dated confirm
 * (held under a day, so it returns at once), is refused a second change inside
 * the limit, and sees the read-only echo in project settings; a second owner
 * releases a name held over a day and is shown its return date; a third
 * workspace is refused that name until its hold lapses, then releases a name it
 * took minutes ago and claims it straight back; a member sees no control.
 *
 * ── WHY THE ACCEPTANCE LANE ────────────────────────────────────────────────
 * Public addresses are cloud-only (ADR §11). `playwright.acceptance.config.ts`
 * runs cloud-on with `MOTIR_PUBLIC_TENANT_DOMAIN=motir.e2e` and records every
 * test, and `.github/workflows/acceptance-tests.yml` publishes the receipt from
 * a green run. The first assertion in the walk is that the claim field is
 * there, which the page renders only with a base domain — so a lane that lost
 * the variable fails loudly instead of filming the operator notice.
 *
 * ── WHAT IS NOT ASSERTED HERE ──────────────────────────────────────────────
 * The 24-hour and 90-day arithmetic, concurrency and erasure are the Vitest
 * gate's (`tests/publicAddresses/subdomainRules.db.test.ts`); the marketing
 * router's 404-never-redirects is its own gate. "The old name stops answering"
 * is asserted on the host contract the router reads.
 *
 * Every date the walk checks comes from a response body (the preview, the
 * write), formatted the way the page formats it, and every seeded offset is
 * built from the three `nameHold` constants.
 */

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const copy = en.settings.workspaceAddress;
const PASSWORD = 'Sup3rSecret!Pass';
const BASE = 'motir.e2e';
const OWNER_A = 'address-owner-a@motir.test';
const OWNER_B = 'address-owner-b@motir.test';
const OWNER_C = 'address-owner-c@motir.test';
const MEMBER_A = 'address-member-a@motir.test';
const CONTROL = '/settings/workspace/public-address';
const ECHO = '/settings/project/public-address';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let workspaceB = '';
let workspaceC = '';
/** Read back from the created project: `createProject` normalises an identifier. */
let identifierB = '';

/** The page's own date format: the viewer's locale, long form, UTC. */
const longDate = (iso: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));

const pathOf = (r: Response) => new URL(r.url()).pathname;
const subdomainWrite = (page: Page, method: 'PUT' | 'DELETE') =>
  page.waitForResponse(
    (r) => pathOf(r).endsWith('/public-subdomain') && r.request().method() === method,
  );
const previewRead = (page: Page) =>
  page.waitForResponse(
    (r) => pathOf(r).endsWith('/public-subdomain/preview') && r.request().method() === 'GET',
  );
const nameField = (page: Page, label = copy.field.label) =>
  page.getByRole('main').getByRole('textbox', { name: label });
const dialog = (page: Page) => page.getByRole('alertdialog');

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
  // Public, as a project with readers would be.
  await adminDb.project.update({ where: { id: project.id }, data: projectAccessData('public') });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  return { owner, workspace, project };
}

test.beforeAll(async () => {
  await resetDatabase();

  const a = await seedOwner(OWNER_A, 'Ada Owner', 'Acme', 'ROADMAP');
  const member = await usersService.createUser({
    email: MEMBER_A,
    password: PASSWORD,
    name: 'Mia Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: a.workspace.id });
  await projectsService.setActiveProject({
    userId: member.id,
    workspaceId: a.workspace.id,
    projectId: a.project.id,
  });

  // Owner B holds `globex`, taken more than a day ago (the grace is built from
  // GRACE_HOURS), with no change on its ledger — so a release is allowed and
  // the name is held.
  const b = await seedOwner(OWNER_B, 'Ben Owner', 'Globex', 'GLOBE');
  workspaceB = b.workspace.id;
  identifierB = b.project.identifier;
  await publicSubdomainService.claim(b.workspace.id, 'globex', b.owner.id);
  await adminDb.publicAddress.update({
    where: { hostname: `globex.${BASE}` },
    data: { createdAt: new Date(Date.now() - (GRACE_HOURS + 1) * HOUR_MS) },
  });

  const c = await seedOwner(OWNER_C, 'Cy Owner', 'Initech', 'INIT');
  workspaceC = c.workspace.id;
});

test('a workspace owner claims, renames and releases its one public name', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-4528');

  await chapter('The way in: the organisation page’s door to Public address', async () => {
    await signIn(page, OWNER_A, PASSWORD);
    await page.goto('/settings/organization');
    const door = page.getByRole('link', { name: copy.door.claim });
    await expect(door).toBeVisible({ timeout: FIRST_PAINT_MS });
    await beat();
    await door.click();
    await page.waitForURL((url) => url.pathname === CONTROL);
    await expect(page.getByRole('heading', { name: copy.title, level: 1 })).toBeVisible();
    // The mounting check — see the header.
    await expect(nameField(page)).toBeVisible();
    await beat();
  });

  await chapter('The field refuses a bad name and a reserved one, in their own words', async () => {
    const claim = page.getByRole('button', { name: copy.claim });
    await nameField(page).fill('ac');
    await expect(page.getByRole('main').getByText('Use at least 3 characters.')).toBeVisible();
    await expect(claim).toBeDisabled();
    await beat();
    await nameField(page).fill('admin');
    await expect(
      page.getByRole('main').getByText('“admin” is reserved. Choose another name.'),
    ).toBeVisible();
    await expect(claim).toBeDisabled();
    await beat();
  });

  await chapter('Claiming acme — one address row, Live, nothing else', async () => {
    await nameField(page).fill('acme');
    await expect(
      page.getByRole('main').getByText(`Readers will find you at acme.${BASE}`),
    ).toBeVisible();
    await beat();
    const claimed = subdomainWrite(page, 'PUT');
    await page.getByRole('button', { name: copy.claim }).click();
    const res = await claimed;
    expect(res.status(), await res.text()).toBe(201);

    const main = page.getByRole('main');
    await expect(main.getByText(`acme.${BASE}`, { exact: true })).toBeVisible();
    await expect(main.getByText(copy.row.live, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: copy.row.copy })).toBeVisible();
    await expect(page.getByRole('link', { name: copy.row.open })).toHaveAttribute(
      'href',
      `https://acme.${BASE}`,
    );
    await expect(main.getByText(/Redirects/)).toHaveCount(0);
    await expect(main.getByText(/renames? left/i)).toHaveCount(0);
    await beat();
  });

  let renameNextChange = '';
  await chapter(
    'Renaming through the dated confirm — held under a day, it returns at once',
    async () => {
      await page.getByRole('button', { name: copy.rename, exact: true }).click();
      await nameField(page, copy.field.renameLabel).fill('acme-labs');
      const previewed = previewRead(page);
      await page.getByRole('button', { name: copy.review }).click();
      const preview = await previewed;
      expect(preview.status(), await preview.text()).toBe(200);
      expect(((await preview.json()) as { outcome: string }).outcome).toBe('return_now');

      // Only now is the dialog asserted: it opens after the preview answered.
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByText(`acme.${BASE} stops answering now.`)).toBeVisible();
      await expect(dialog(page).getByText(copy.confirm.returnsNow)).toBeVisible();
      await expect(dialog(page).getByText(copy.confirm.noRedirectRename)).toBeVisible();
      await beat();

      const renamed = subdomainWrite(page, 'PUT');
      await dialog(page).getByRole('button', { name: copy.confirm.rename }).click();
      const res = await renamed;
      expect(res.status(), await res.text()).toBe(200);
      const dto = (await res.json()) as { hostname: string; nextChangeAllowedAt: string };
      expect(dto.hostname).toBe(`acme-labs.${BASE}`);
      renameNextChange = dto.nextChangeAllowedAt;

      const main = page.getByRole('main');
      await expect(main.getByText(`acme-labs.${BASE}`, { exact: true })).toBeVisible();
      await expect(main.getByText(`acme.${BASE}`, { exact: true })).toHaveCount(0);
      await beat();
    },
  );

  await chapter('The old name stops answering; the new one answers', async () => {
    const old = await page.request.get(`/api/public/hosts/acme.${BASE}`, { maxRedirects: 0 });
    expect(old.status()).toBe(404);
    expect(old.headers()['cache-control']).toContain('no-store');
    expect(old.headers()['location']).toBeUndefined();
    const fresh = await page.request.get(`/api/public/hosts/acme-labs.${BASE}`, {
      maxRedirects: 0,
    });
    expect(fresh.status(), await fresh.text()).toBe(200);
  });

  await chapter('A second change inside the limit is refused, with the date as text', async () => {
    // The lock ends CHANGE_INTERVAL_DAYS after the change.
    const expected = Date.now() + CHANGE_INTERVAL_DAYS * DAY_MS;
    expect(Math.abs(new Date(renameNextChange).getTime() - expected)).toBeLessThan(DAY_MS);

    const rename = page.getByRole('button', { name: copy.rename, exact: true });
    const release = page.getByRole('button', { name: copy.release, exact: true });
    await expect(rename).toBeDisabled();
    await expect(release).toBeDisabled();
    await expect(
      page
        .getByRole('main')
        .getByText(
          `You can change the name again on ${longDate(renameNextChange)}. A rename and a release each count as one change, once every 30 days.`,
        ),
    ).toBeVisible();

    // A disabled control sends nothing.
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/public-subdomain')) writes.push(`${r.method()} ${r.url()}`);
    });
    await rename.click({ force: true });
    await release.click({ force: true });
    await expect(dialog(page)).toHaveCount(0);
    expect(writes).toEqual([]);
    await beat();
  });

  await chapter('Project settings echoes the workspace name, read-only', async () => {
    await page.goto(ECHO);
    const main = page.getByRole('main');
    await expect(page.getByRole('heading', { name: copy.echo.title })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(main.getByText(`acme-labs.${BASE}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: copy.row.copy })).toBeVisible();
    await expect(main.getByRole('textbox', { name: copy.field.label })).toHaveCount(0);
    await expect(main.getByRole('button', { name: /^(Rename|Release|Remove)$/ })).toHaveCount(0);
    const change = page.getByRole('link', { name: copy.echo.change });
    await expect(change).toHaveAttribute('href', CONTROL);
    await beat();
    await change.click();
    await page.waitForURL((url) => url.pathname === CONTROL);
    await expect(
      page.getByRole('main').getByText(`acme-labs.${BASE}`, { exact: true }),
    ).toBeVisible();
    await beat();
  });

  let globexReturnsAt = '';
  await chapter(
    'Releasing a name held over a day — the dialog states its return date',
    async () => {
      await signIn(page, OWNER_B, PASSWORD);
      await page.goto(CONTROL);
      await expect(page.getByRole('main').getByText(`globex.${BASE}`, { exact: true })).toBeVisible(
        {
          timeout: FIRST_PAINT_MS,
        },
      );

      const previewed = previewRead(page);
      await page.getByRole('button', { name: copy.release, exact: true }).click();
      const preview = await previewed;
      expect(preview.status(), await preview.text()).toBe(200);
      const body = (await preview.json()) as { outcome: string; returnsAt: string };
      expect(body.outcome).toBe('quarantine');
      // The hold runs QUARANTINE_DAYS from now.
      expect(
        Math.abs(new Date(body.returnsAt).getTime() - (Date.now() + QUARANTINE_DAYS * DAY_MS)),
      ).toBeLessThan(DAY_MS);
      globexReturnsAt = body.returnsAt;

      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).getByText(`globex.${BASE} stops answering now.`)).toBeVisible();
      await expect(
        dialog(page).getByText(`Anyone can claim it from ${longDate(body.returnsAt)}.`),
      ).toBeVisible();
      await expect(dialog(page).getByText(copy.confirm.noRedirectRelease)).toBeVisible();
      await beat();

      const released = subdomainWrite(page, 'DELETE');
      await dialog(page).getByRole('button', { name: copy.confirm.release }).click();
      const res = await released;
      expect(res.status(), await res.text()).toBe(200);
      expect(((await res.json()) as { returnsAt: string }).returnsAt).toBe(body.returnsAt);

      const main = page.getByRole('main');
      await expect(
        main.getByText(
          `globex.${BASE} was released. It is held until ${longDate(body.returnsAt)}, then anyone can claim it.`,
        ),
      ).toBeVisible();
      await expect(main.getByText(/the next change is allowed on/)).toBeVisible();
      await expect(nameField(page)).toHaveValue('');
      await beat();
    },
  );

  await chapter('With no name, project settings shows the project’s own address', async () => {
    await page.goto(ECHO);
    await expect(page.getByRole('heading', { name: copy.echo.title })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByRole('main').getByText(new RegExp(`/p/${identifierB}$`))).toBeVisible();
    await expect(page.getByRole('link', { name: copy.echo.claim })).toHaveAttribute(
      'href',
      CONTROL,
    );
    await expect(page.getByRole('main').getByRole('textbox')).toHaveCount(0);
    await beat();
  });

  await chapter('Another workspace is refused the held name until its hold lapses', async () => {
    await signIn(page, OWNER_C, PASSWORD);
    await page.goto(CONTROL);
    await expect(nameField(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await nameField(page).fill('globex');
    const refused = subdomainWrite(page, 'PUT');
    await page.getByRole('button', { name: copy.claim }).click();
    const res = await refused;
    expect(res.status()).toBe(409);
    await expect(
      page
        .getByRole('main')
        .getByText(
          `globex.${BASE} was released recently and is held until ${longDate(globexReturnsAt)}. Anyone can claim it from then.`,
        ),
    ).toBeVisible();
    await beat();

    // Move the hold into the past, the way time would — never by waiting.
    await adminDb.publicHostnameReservation.updateMany({
      where: { retiredFromWorkspaceId: workspaceB },
      data: { expiresAt: new Date(Date.now() - HOUR_MS) },
    });
    const lapsed = await page.request.put(`/api/workspaces/${workspaceC}/public-subdomain`, {
      data: { label: 'globex' },
    });
    expect(lapsed.status(), await lapsed.text()).toBe(201);
    await page.reload();
    await expect(page.getByRole('main').getByText(`globex.${BASE}`, { exact: true })).toBeVisible();
    await beat();
  });

  await chapter(
    'A name taken minutes ago returns at once — and can be claimed straight back',
    async () => {
      const previewed = previewRead(page);
      await page.getByRole('button', { name: copy.release, exact: true }).click();
      const preview = await previewed;
      expect(((await preview.json()) as { outcome: string }).outcome).toBe('return_now');
      await expect(dialog(page).getByText(copy.confirm.returnsNow)).toBeVisible();
      await beat();

      const released = subdomainWrite(page, 'DELETE');
      await dialog(page).getByRole('button', { name: copy.confirm.release }).click();
      const res = await released;
      expect(res.status(), await res.text()).toBe(200);
      expect(((await res.json()) as { returnsAt: string | null }).returnsAt).toBeNull();
      await expect(
        page.getByRole('main').getByText(`globex.${BASE} was released. Anyone can claim it now.`),
      ).toBeVisible();
      await beat();

      await nameField(page).fill('globex');
      const reclaimed = subdomainWrite(page, 'PUT');
      await page.getByRole('button', { name: copy.claim }).click();
      const again = await reclaimed;
      expect(again.status(), await again.text()).toBe(201);
      await expect(
        page.getByRole('main').getByText(`globex.${BASE}`, { exact: true }),
      ).toBeVisible();
      await beat();
    },
  );

  await chapter('A member sees the address and no control at all', async () => {
    await signIn(page, MEMBER_A, PASSWORD);
    await page.goto(CONTROL);
    const main = page.getByRole('main');
    await expect(main.getByText(`acme-labs.${BASE}`, { exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(main.getByText(copy.readOnly)).toBeVisible();
    await expect(main.getByRole('textbox')).toHaveCount(0);
    await expect(main.getByRole('button', { name: copy.claim })).toHaveCount(0);
    await expect(main.getByRole('button', { name: copy.rename, exact: true })).toHaveCount(0);
    await expect(main.getByRole('button', { name: copy.release, exact: true })).toHaveCount(0);
    await beat();
  });
});
