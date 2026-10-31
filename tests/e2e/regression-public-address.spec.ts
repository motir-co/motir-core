import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { pageRefresh } from './_helpers/authoritative-signal';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// ⚠️ THE ACCEPTANCE WALK FOR CUSTOMER-OWNED ADDRESSES (Story MOTIR-3878 ·
// Subtask MOTIR-4225) — the APPLICATION half of the verification recipe, paced
// for a person to watch. The public half (a visitor arriving on the new host) is
// `motir-marketing`'s own walk; this one asserts what the customer is SHOWN
// while they set the address up.
//
// ── ⚠️ THE TWO SEAMS, AND WHY A SPEC WITHOUT THEM WOULD BE GREEN FOR EVER ──
//
// The flow crosses two systems that leave this machine: the certificate platform
// and public DNS. `plan-rules/type-test.md`'s tell (d) is exactly this shape — a
// lane that cannot reach the asserted state passes permanently without asserting
// it. `lib/publicAddresses/providers.ts` binds in-memory versions of both, and
// `playwright.acceptance.config.ts` arms them on the webServer.
//
// ⚠️ AND THE ARMING NEEDED A FIX THIS CARD FOUND. That factory refused the fakes
// whenever `NODE_ENV === 'production'` — which this lane is, because it serves a
// `next build`. The flag was therefore INERT in the only lane that needs it. It
// now also asks `isE2EProdHarness()`, the seam this repository already uses for
// that collision, so arming them in a real deployment takes two deliberate
// misconfigurations rather than one. Both arms are asserted in
// `tests/publicAddresses/dnsResolverPort.test.ts`.
//
// The mounting is SELF-DETECTING here rather than merely argued: chapter 1's
// first assertion is that the workspace-address echo is present, which the pane renders
// only when a base domain is configured — so a lane that set neither variable
// fails loudly instead of filming an operator error message.
//
// ── ⚠️ TWO OF THE CARD'S ASSERTIONS ARE NOT HERE, AND BOTH ARE RECORDED ────
//
//  1. *"the TXT and CNAME records render"* (step 3). The pane renders the
//     ownership TXT and nothing else: `PublicAddressDto.dns` is built from the
//     verification token alone, and the pointing record the Fly adapter parses
//     is dropped at the mapper. Filed as MOTIR-4278. Asserting a CNAME here
//     would be asserting a screen that does not exist.
//  2. *"on a `free`-tier fixture org, Add a domain is disabled with the upgrade
//     prompt"* (step 6). MOTIR-4229 deliberately does not pre-disable it:
//     `entitlementsService.assertCanAddCustomDomain` records that `free: 0`
//     exists to make the REFUSAL the prompt's trigger "instead of an empty state
//     the pane special-cases". The prompt is covered from the refusal in
//     `tests/settings/customDomainsSection.test.tsx`.
//
// Steps 6 and 7's other arms — the read-only pane, the empty list, the error
// state — are asserted from fixtures in that same suite, where every branch is
// reachable. Re-walking them in a browser would cost a lane minute per arm and
// assert the same render.

const EMAIL = 'address-acceptance@motir.test';
const PASSWORD = 'Sup3rSecret!Pass';
/** The pane under test — also the pathname its `router.refresh()` re-reads. */
const PANE = '/settings/project/public-address';
/** The workspace Custom domains room (MOTIR-9529). */
const DOMAINS_PANE = '/settings/workspace/custom-domains';

/**
 * ⚠️ READ BACK FROM THE CREATED PROJECT, NEVER THE STRING WE PASSED.
 * `projectsService.createProject` normalises an identifier — `ROADMAP` is stored
 * as `ROADM` — and the echo shows the STORED one. A fixture that
 * asserted the string it handed in failed on the preview and looked for all the
 * world like a rendering bug; it was the seed being wrong about itself.
 */
let identifier = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await resetDatabase();
  const owner = await usersService.createUser({
    email: EMAIL,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Roadmap',
    identifier: 'ROADMAP',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  identifier = project.identifier;
  // Public, because a private project has no address to give.
  await adminDb.project.update({
    where: { id: project.id },
    data: projectAccessData('public'),
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });
  // A paid tier: `free: 0` refuses the FIRST domain by design, and chapter 3 is
  // about the connection flow rather than about the cap.
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
    select: { organizationId: true },
  });
  await adminDb.organization.update({
    where: { id: organizationId },
    data: {
      scaledTrackerSubscription: {
        status: 'active',
        priceId: 'price_e2e',
        quantity: 1,
      } as never,
    },
  });
});

test('a project admin gives their public project an address of its own', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-3878');

  await chapter('The room, reached from the settings rail', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await page.goto(PANE);

    await expect(page.getByRole('heading', { name: 'Public address' })).toBeVisible();
    // ⚠️ THE MOUNTING CHECK. The workspace-address echo renders only when a base
    // domain is configured; without `MOTIR_PUBLIC_TENANT_DOMAIN` the pane shows
    // an operator explanation and this walk would film that instead of the room.
    await expect(page.getByRole('heading', { name: 'Workspace address' })).toBeVisible();
    await beat();
  });

  await chapter('The workspace name is claimed in workspace settings', async () => {
    // Story MOTIR-4528 moved the subdomain's control to workspace settings
    // (ADR §3: a subdomain is a property of the WORKSPACE). This room echoes it
    // read-only and links there; the claim, rename and release walk is
    // `cloud-workspace-address.spec.ts`'s.
    const claimLink = page.getByRole('link', { name: 'Claim a name for the workspace →' });
    await expect(claimLink).toHaveAttribute('href', '/settings/workspace/public-address');
    await expect(page.getByRole('textbox', { name: 'Name' })).toHaveCount(0);
    // Unclaimed, the echo names the project's own public address instead.
    await expect(page.getByRole('main').getByText(new RegExp(`/p/${identifier}$`))).toBeVisible();
    await beat();
  });

  await chapter('Connecting a domain the customer owns', async () => {
    // A customer domain is the WORKSPACE's (MOTIR-9529): the project room keeps
    // no control for it, and the workspace Custom domains room is where it is
    // added.
    await page.goto(DOMAINS_PANE);
    await page.getByRole('button', { name: 'Add domain' }).click();
    // The dialog is LABELLED 'Add a domain' and contains a field labelled
    // 'Domain', so a bare `getByLabel` matches both — scoped to the textbox.
    await page.getByRole('textbox', { name: 'Domain' }).fill('roadmap.acme.test');
    // The pane adds the row from the write's own answer, then re-reads; arm the
    // refresh BEFORE the click so the wait covers the RSC round trip too.
    const domainAdded = pageRefresh(page, DOMAINS_PANE);
    await page.getByRole('dialog').getByRole('button', { name: 'Add domain' }).click();
    await domainAdded;

    // The row itself: the host also appears in its own DNS records (the TXT
    // name and the pointing record), so a bare text match is ambiguous.
    await expect(
      page.getByRole('main').locator('li[data-status]').filter({ hasText: 'roadmap.acme.test' }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByText('Unverified')).toBeVisible();
    // The ownership record is shown on an unverified row, without a click.
    await expect(page.getByRole('cell', { name: '_motir-verify.roadmap.acme.test' })).toBeVisible();
    await beat();
  });

  await chapter('Verifying it, and watching the certificate arrive', async () => {
    // The fake resolver answers whatever token the service just minted, so
    // *Check now* walks the real add → verify → issue order — including the
    // rule that a certificate is never requested before the TXT verifies.
    await page.getByRole('button', { name: 'Check now' }).click();
    // Waits on the ROW's own text, never on a timer.
    await expect(page.getByRole('main').getByText('Issued')).toBeVisible({ timeout: 20_000 });
    await beat();
  });
});
