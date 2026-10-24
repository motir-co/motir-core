import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { pageRefresh } from './_helpers/authoritative-signal';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectAccessData } from '@/tests/helpers/projectAccess';

/*
 * ── LOCATOR DISCIPLINE (MOTIR-5115) ────────────────────────────────────────
 *
 * Every locator this file takes after a navigation is role-based or scoped to
 * `pane` (the shell's live `<main>`). React keeps the OUTGOING subtree mounted
 * while the incoming one streams and Playwright resolves locators BEFORE
 * filtering on visibility, so a page-rooted `getByText` matches both copies and
 * strict mode fails on a page that is perfectly correct (`CLAUDE.md` § *a
 * boundary makes every unscoped locator a race*; MOTIR-3725 / MOTIR-3737 are the
 * first two recorded sites and MOTIR-3725's is this surface's sibling pane).
 *
 * Every string this file reads is a `<span>` or a `<p>` inside a `<div>` —
 * `AddressRow` for a hostname, `Pill` for the status chip, `FormField` for the
 * refusal and the count — so there is no role to ask for and SCOPING is the
 * remedy rather than a fallback. Scoping also keeps every assertion BYTE
 * IDENTICAL, which is what this card is allowed to change and what it is not.
 *
 * RELEASING A WORKSPACE SUBDOMAIN — the browser-level acceptance
 * (Story MOTIR-4451 · Subtask MOTIR-4457).
 *
 * `regression-public-address.spec.ts` (MOTIR-4225) walks claim → add a custom
 * domain → certificate states → make primary → rename, with the old address
 * still redirecting. This spec is the step it could not reach because it did not
 * exist: **release**, and the reservation that outlives it.
 *
 * ── ⚠️ WHY A NEW SPEC RATHER THAN FOUR MORE CHAPTERS IN THAT ONE ───────────
 *
 * MOTIR-4457 says to EXTEND MOTIR-4225's lifecycle rather than start a second
 * one, and that instruction is about the FIXTURES and the way the pane is
 * reached — both of which this file takes from it, deliberately, down to the
 * read-the-identifier-back note below. It is not an instruction to edit that
 * file, because that file is an ACCEPTANCE RECEIPT for story MOTIR-3878:
 * `docs/decisions/acceptance-receipt-lifecycle.md` freezes a receipt once its
 * story is accepted, and appending this story's steps to it would both edit
 * history and film MOTIR-4451's work under MOTIR-3878's name.
 *
 * ── ⚠️ THE CLOUD LANE, AND THE ONE VARIABLE IT WAS MISSING ─────────────────
 *
 * Public addresses are cloud-only (ADR §11), so this is a `cloud-*` spec and
 * runs in `playwright.cloud.config.ts`. That lane did NOT set
 * `MOTIR_PUBLIC_TENANT_DOMAIN`; without it the pane renders an operator
 * explanation and no claim field, and this walk would assert against that
 * instead of against the room. The variable is added there by this card, with
 * the same value the acceptance lane uses.
 *
 * The MOUNTING is SELF-DETECTING rather than merely argued: step 1's first
 * assertion is that the claim field is present, which the pane renders only when
 * a base domain is configured — so a lane that lost the variable fails loudly
 * instead of passing vacuously (the MOTIR-2601 shape, one lane over).
 *
 * ── ⚠️ WHAT THIS SPEC DELIBERATELY DOES NOT ASSERT ────────────────────────
 *
 * The REDIRECT behaviour of the released hostnames. A released address no longer
 * resolves at all, and the retired-alias `301` is MOTIR-4447's subject — an open
 * defect. Asserting it here would couple this spec to that bug's fix.
 */

const EMAIL = 'address-release@motir.test';
const PASSWORD = 'Sup3rSecret!Pass';
const BASE = 'motir.e2e';
/** The pane under test — also the pathname its `router.refresh()` re-reads. */
const PANE = '/settings/project/public-address';

/**
 * ⚠️ READ BACK FROM THE CREATED PROJECT, NEVER THE STRING WE PASSED —
 * MOTIR-4225's own note, and it costs an hour to rediscover.
 * `projectsService.createProject` NORMALISES an identifier (`ROADMAP` is stored
 * as `ROADM`), and the pane's live preview shows the STORED one.
 */
let identifier = '';

test.describe.configure({ mode: 'serial' });

/**
 * ⚠️ 120 s, matching `cloud-public-redirect.spec.ts` one file over, and NOT the
 * 10× override MOTIR-4423 is open about. This walk is seven steps of ordinary
 * form-and-confirm interaction with no certificate wait in it — the one thing in
 * this area that legitimately takes twenty seconds is issuance, and release
 * touches no certificate at all.
 */
test.describe.configure({ timeout: 120_000 });

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
});

test('an owner releases the workspace subdomain, and the names stay held for ever', async ({
  page,
  chapter,
  beat,
}) => {
  /** The shell's live region — see LOCATOR DISCIPLINE in the header. */
  const pane = page.getByRole('main');

  await chapter('The room, and a claim', async () => {
    await signIn(page, EMAIL, PASSWORD);
    await page.goto(PANE);

    await expect(page.getByRole('heading', { name: 'Public address' })).toBeVisible();
    // ⚠️ THE MOUNTING CHECK — see the header. No base domain, no claim field.
    await expect(page.getByRole('textbox', { name: 'Subdomain' })).toBeVisible();

    await page.getByRole('textbox', { name: 'Subdomain' }).fill('acme');
    await page.getByRole('button', { name: 'Claim subdomain' }).click();
    await expect(pane.getByText(`acme.${BASE}/${identifier}`)).toBeVisible();
    await beat();
  });

  await chapter(
    'A rename, so a retained alias exists — the alias is what makes release interesting',
    async () => {
      await page.getByRole('button', { name: 'Rename' }).click();
      await page.getByRole('textbox', { name: 'Subdomain' }).last().fill('acme-inc');
      // `PublicSubdomainCard` repaints on `router.refresh()` and cannot patch in
      // place — `renamesLeft` is server-derived (ADR §8 Amendment 2 counts names
      // BURNT, so a browser cannot re-derive it even in principle). Wait on the
      // refresh rather than spend the assertion's budget on it (MOTIR-4399,
      // disposition (c)).
      const renamed = pageRefresh(page, PANE);
      await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
      await renamed;

      await expect(pane.getByText(`acme-inc.${BASE}/${identifier}`)).toBeVisible();
      await expect(pane.getByText(`acme.${BASE}`, { exact: true })).toBeVisible();
      await beat();
    },
  );

  await chapter(
    'The Remove confirm says what it is about to take — BOTH hostnames, separately',
    async () => {
      await page.getByRole('button', { name: 'Remove' }).click();

      // ⚠️ THE POINT OF THIS SPEC. A component test can be made to pass while the
      // assembled page renders a summary, so both hostnames are asserted as
      // SEPARATE visible strings — and the assertion fails if the confirm ever
      // collapses them into "and any previous addresses".
      const confirm = page.getByRole('dialog');
      await expect(confirm.getByText('These 2 addresses will stop answering:')).toBeVisible();
      await expect(confirm.getByText(`acme-inc.${BASE}`, { exact: true })).toBeVisible();
      await expect(confirm.getByText(`acme.${BASE}`, { exact: true })).toBeVisible();

      // The promise the whole amendment turns on, in the customer's words.
      await expect(confirm.getByText(/held for ever/)).toBeVisible();
      await expect(confirm.getByText(/Nobody can claim them again/)).toBeVisible();
      // And the half that makes the action worth performing.
      await expect(confirm.getByText(/Your public projects go back to/)).toBeVisible();
      await beat();
    },
  );

  await chapter('Cancel changes nothing — the classic defect only a browser sees', async () => {
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    // Still claimed, still the same two rows.
    await expect(pane.getByText(`acme-inc.${BASE}/${identifier}`)).toBeVisible();
    await expect(pane.getByText('Active')).toBeVisible();
    await beat();
  });

  await chapter('Removing it — the pane returns to the unclaimed state', async () => {
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove subdomain' }).click();

    // The unclaimed state IS the claim field coming back, with no address rows
    // and no trace of the released label (the asset's decision: the reservation
    // holds a digest, so there is no hostname left to show).
    await expect(page.getByRole('button', { name: 'Claim subdomain' })).toBeVisible();
    await expect(pane.getByText(`acme-inc.${BASE}/${identifier}`)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Remove' })).toBeHidden();
    await beat();
  });

  await chapter(
    'The released label is REFUSED on re-claim — the reservation, made visible',
    async () => {
      // ⚠️ THE OTHER POINT OF THIS SPEC. This is the only place the reservation is
      // observable to a person, and it closes the loop the ADR amendment opened.
      // The refusal must be RENDERED, not merely returned.
      await page.getByRole('textbox', { name: 'Subdomain' }).fill('acme-inc');
      await page.getByRole('button', { name: 'Claim subdomain' }).click();
      await expect(pane.getByText(/is already in use/)).toBeVisible();

      // The retired ALIAS label too — the case a kind-filter mistake would let
      // through, and the one a customer is likeliest to try.
      await page.getByRole('textbox', { name: 'Subdomain' }).fill('acme');
      await page.getByRole('button', { name: 'Claim subdomain' }).click();
      await expect(pane.getByText(/is already in use/)).toBeVisible();
      await beat();
    },
  );

  await chapter('A DIFFERENT label is still claimable, so the refusal is specific', async () => {
    await page.getByRole('textbox', { name: 'Subdomain' }).fill('acme-two');
    await page.getByRole('button', { name: 'Claim subdomain' }).click();
    await expect(pane.getByText(`acme-two.${BASE}/${identifier}`)).toBeVisible();
    await expect(pane.getByText('Active')).toBeVisible();

    // ⚠️ AND THE CAP DID NOT RESET. Two names were burnt by the release, so the
    // fresh claim starts at three of five — ADR §8 Amendment 2, read off the
    // surface a customer actually sees rather than out of the DTO.
    await expect(pane.getByText('3 renames left.')).toBeVisible();
    await beat();
  });

  await chapter('The custom-domain section was untouched throughout', async () => {
    // Release acts only on the kinds `reservesItsHostname` names. Asserted once,
    // at the end, because the claim it supports is about the WHOLE walk.
    await expect(page.getByRole('heading', { name: 'Your own domain' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a domain' })).toBeVisible();
    await beat();
  });
});
