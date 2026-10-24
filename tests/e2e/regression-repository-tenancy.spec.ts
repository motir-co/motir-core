import { expect, test } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import {
  paidOrgState,
  pinContextCookies,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  TIERS,
} from './_helpers/billing';
import { seedGithubInstallation } from './_helpers/github-seed';
import { E2E_REPO } from './_helpers/github-const';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { workspacesService } from '@/lib/services/workspacesService';
import enMessages from '@/messages/en.json';

// A REPOSITORY BELONGS TO THE ORGANISATION — THE ACCEPTANCE RECEIPT
// (Story MOTIR-4669 · Subtask MOTIR-4685). The story's verification recipe,
// performed in a browser.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// One number: the second project pays NOTHING. Before this story a repository
// was connected to a WORKSPACE, so the same repository in two workspaces of one
// organisation was two connections and two code graphs built from identical
// bytes — and a user who wanted their code in a second project was asked to go
// and connect it again, with no way to tell that Motir already had it.
//
// So the clip's centre of gravity is chapter 2: the SAME repository appears in a
// project in a DIFFERENT WORKSPACE, reading `already indexed · shared`, and the
// index ledger does not grow. Chapters 3–5 then show the tier doing its other
// job — one inventory that knows who uses what, and two removals that share a
// word and not a blast radius.
//
// ── ⚠️ WHY THIS LANE, DECIDED BEFORE A LINE WAS WRITTEN (the card's own AC) ──
//
// `docs/acceptance-lane-triage.md`: the acceptance lane's server is CLOUD-ON with
// `E2E_TEST_GITHUB_REPOS`, `MOTIR_AI_URL` and `E2E_TEST_CODE_HEALTH`; the main
// lane is NONE of those. This walk needs a git host to exist at all, so the main
// lane would not fail it — it would pass it, off a short-circuited path, which is
// the MOTIR-2601 trap that document exists to name. It stays in the acceptance
// lane.
//
// ── ⚠️ HOW THE CONNECT BEAT REACHES GITHUB, AND WHAT THAT COSTS ─────────────
//
// NAMED rather than glossed. The App install round trip runs on GITHUB'S OWN
// SERVERS — a user picks repositories on github.com and is redirected back — so
// no browser step can perform it. Chapter 1 therefore performs the connect by
// calling `seedGithubInstallation`, which is
// `githubInstallationService.persistInstallation`: the EXACT function the
// post-install redirect (MOTIR-1588) and the webhook grant-mirror both call, and
// the one that enqueues the first index. Everything the clip then shows is the
// shipped product reading real rows.
//
// What is NOT faked anywhere: the picker, both settings pages, every read, both
// removals, the org-admin gate, and the index ledger the "nothing re-indexes"
// claim is measured against.
//
// ── PACING ──────────────────────────────────────────────────────────────────
//
// Five chapters, each a thing a person can watch happen. Nothing navigates that
// does not show something new, and the two beats worth pausing on — the
// one-segment picker in chapter 1 and `already indexed · shared` in chapter 2 —
// are the story's thesis and its payoff, in that order.

const pick = enMessages.repositoryPicker;
const inv = enMessages.github.inventory;
const disc = enMessages.github.orgDisconnect;

const OWNER = 'acceptance-repo-tenancy@example.com';

// ⚠️ ITS OWN TIMEOUT, BECAUSE ITS PACING DOES NOT FIT THE LANE DEFAULT
// (MOTIR-4876). This spec holds 17 beats at `BEAT_MS` (4000ms) and 5 chapters at
// `CHAPTER_HOLD_MS` (2500ms) — **80.5s of deliberate hold** — against the
// `playwright.acceptance.config.ts` per-test default of 90s. That left 9.5s for
// every navigation, click, DB read and assertion in the whole walk, and MEASURED
// on a production build against a private database the test takes **89,891ms**:
// it was passing by 109 MILLISECONDS. Green here has been luck, not headroom,
// and the tell is a timeout that prints NO call log — it lands inside a hold
// rather than inside a locator operation, which is what makes this shape read as
// a hang instead of as a budget.
//
// The holds are the POINT — this lane records a clip a reviewer watches
// (`docs/decisions/acceptance-video.md`), so the pacing is the deliverable and
// shortening it to fit is the wrong trade. 180s is the same figure
// `acceptance-workbench.spec.ts` and `acceptance-planning-overlay.spec.ts`
// already take for the same reason.
test.describe.configure({ timeout: 180_000 });

test('a repository is connected once, to the organisation, and the second project pays nothing', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4669');

  await resetDatabase();
  resetBillingFixture();
  const seed = await seedBillingOwner(page, OWNER);
  // ⚠️ A PAID TIER, because the FREE one caps an organisation at ONE WORKSPACE
  // and this story is about what crosses a workspace boundary. Not a convenience:
  // on the free plan the second workspace cannot exist at all —
  // `entitlementsService.assertWithinWorkspaceCap` refuses the create.
  //
  // Set on the ORG ROW, not through the billing fixture. `pmTierForOrg` reads
  // `isMeta` / `scaledTrackerSubscription` / `aiIncludedSeat` off the row via
  // `findCapContextInTx`; the motir-ai fixture answers a DIFFERENT question
  // (spend and balance) and does not reach the cap. Writing the fixture alone
  // leaves the cap free — which is how this first ran, and is worth the sentence.
  setOrgBillingState(seed.organizationId, paidOrgState({ tier: TIERS.pro, balance: 4420 }));
  await db.organization.update({
    where: { id: seed.organizationId },
    data: { aiIncludedSeat: true },
  });

  // A SECOND workspace in the SAME organisation, with a project of its own —
  // the fixture the whole story is about. In a one-workspace org the
  // workspace-keyed answer and the org-keyed answer are the same answer, so a
  // single-workspace walk could not show what changed.
  const { workspace: second } = await workspacesService.createWorkspace({
    name: 'Second workspace',
    ownerUserId: seed.ownerId,
    organizationId: seed.organizationId,
  });
  const secondProject = await projectsService.createProject({
    workspaceId: second.id,
    actorUserId: seed.ownerId,
    name: 'Beacon',
    identifier: 'BEAC',
  });

  const repoRef = `${E2E_REPO.owner}/${E2E_REPO.name}`;

  await chapter('An organisation with nothing connected is offered a PICKER', async () => {
    await page.goto('/settings/project/repositories');
    // Authoritative: the room's own heading, never a spinner's absence.
    await expect(page.getByRole('heading', { name: 'Repositories' }).first()).toBeVisible();
    await beat();

    // ⚠️ THE STORY'S THESIS, AND THE FIRST THING THE CLIP SHOWS. "Nothing to
    // pick" is NOT an empty state whose job is to send somebody to another page:
    // that turns one intent into two errands, which is the defect this story
    // removes one tier up. So the zero case is the same picker with ONE segment.
    await page.getByRole('button', { name: pick.add }).click();
    await expect(page.getByText(pick.segment.connect, { exact: true })).toBeVisible();
    await beat();

    // …and it says what will happen, rather than where to go.
    await expect(page.getByText(/lands in .* at the same time/)).toBeVisible();
    // The organisation's segment is ABSENT — there is nothing in it yet.
    await expect(page.getByText(/already connected/)).toHaveCount(0);
    await beat();

    await page.keyboard.press('Escape');
  });

  await chapter('Connecting it once — and it indexes once', async () => {
    // The connect itself runs on github.com (see the header): this performs the
    // same service call the post-install redirect makes, and it is the call that
    // enqueues the first index.
    await seedGithubInstallation(seed.workspaceId);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Repositories' }).first()).toBeVisible();
    await beat();

    // ⚠️ CONNECTING IS NOT LINKING, and the walk shows the difference rather than
    // hiding it. The organisation now HAS the repository; this project uses it
    // once somebody picks it — which is the same picker, now with two segments
    // instead of one.
    await page.getByRole('button', { name: pick.add }).click();
    await expect(page.getByText(/already connected/)).toBeVisible();
    await beat();

    const firstLink = page.waitForResponse(
      (r) => /\/repositories\/add$/.test(r.url()) && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: new RegExp(E2E_REPO.name) }).click();
    expect((await firstLink).status()).toBe(201);
    await expect(page.getByText(repoRef).first()).toBeVisible();
    await beat();
  });

  await chapter(
    'A project in ANOTHER workspace picks it up — already indexed, and shared',
    async () => {
      // The whole point: a different workspace of the same organisation.
      await pinContextCookies(page, {
        workspaceId: second.id,
        organizationId: seed.organizationId,
      });
      await db.workspaceMembership.update({
        where: { userId_workspaceId: { userId: seed.ownerId, workspaceId: second.id } },
        data: { activeProjectId: secondProject.id },
      });

      await page.goto('/settings/project/repositories');
      await expect(page.getByRole('heading', { name: 'Repositories' }).first()).toBeVisible();
      await beat();

      await page.getByRole('button', { name: pick.add }).click();
      // ⚠️ THE PAYOFF. The organisation's repository is OFFERED here, and the chip
      // says why it is free: the graph exists, belongs to the organisation, and
      // is not rebuilt because a second project picked it up.
      const option = page.getByRole('button', { name: new RegExp(E2E_REPO.name) });
      await expect(option).toBeVisible();
      await expect(page.getByText(pick.alreadyIndexed, { exact: true }).first()).toBeVisible();
      await beat();

      // Wait on the WRITE's own response, never on the row appearing: the row is
      // optimistic and would be there before the server had agreed.
      const linked = page.waitForResponse(
        (r) => /\/repositories\/add$/.test(r.url()) && r.request().method() === 'POST',
      );
      await option.click();
      expect((await linked).status()).toBe(201);
      await expect(page.getByText(repoRef).first()).toBeVisible();
      await beat();

      // …and NOTHING re-indexed. Asserted against the ledger — an authoritative
      // read, not the absence of a spinner. ONE succeeded index run exists in the
      // whole organisation, the one chapter 2 paid for.
      const indexRuns = await db.jobRun.count({
        where: { functionId: 'system.code-graph-index' },
      });
      expect(indexRuns).toBeLessThanOrEqual(1);
      // Two project links, one repository — the claim in two numbers.
      const repo = await db.githubRepo.findFirstOrThrow({ where: { name: E2E_REPO.name } });
      expect(await db.projectRepo.count({ where: { githubRepoId: repo.id } })).toBe(2);
      await beat();
    },
  );

  await chapter('The organisation knows who uses what', async () => {
    await page.goto('/settings/organization/git');
    await expect(page.getByRole('heading', { name: inv.title })).toBeVisible();
    await beat();

    // ONE row for a repository two projects use — and the count is on the row AT
    // REST, which is the whole disclosure argument: a warning inside a dialog is
    // read past, a count that was on screen all along is not.
    await expect(page.getByText(repoRef).first()).toBeVisible();
    const usedBy = page.getByRole('button', { name: /Used by 2 projects/ });
    await expect(usedBy).toBeVisible();
    await beat();

    // Expanded, it names them.
    await usedBy.click();
    // Scoped to `#main`: the project switcher in the top bar also says "Beacon",
    // and a page-wide match would resolve to whichever the DOM offered first —
    // which is the switcher, and would pass without the chip ever rendering.
    await expect(page.locator('#main').getByText('Beacon')).toBeVisible();
    await beat();
  });

  await chapter('The two removals share a word and not a blast radius', async () => {
    // Remove from THIS project — the quiet one. Its copy spends its length on
    // what does NOT happen.
    await page.goto('/settings/project/repositories');
    await expect(page.getByRole('heading', { name: 'Repositories' }).first()).toBeVisible();
    await page.getByRole('button', { name: pick.remove.action }).first().click();
    await expect(page.getByText(/other projects keep it/)).toBeVisible();
    await beat();

    const removed = page.waitForResponse(
      (r) => /\/repositories\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: pick.remove.confirm }).click();
    expect((await removed).status()).toBeLessThan(300);
    await beat();

    // The organisation still has it, and the first project still uses it — the
    // inventory now reads ONE project.
    await page.goto('/settings/organization/git');
    await expect(page.getByRole('button', { name: /Used by 1 project/ })).toBeVisible();
    await beat();

    // And the ORGANISATION-level one, which names every affected project BEFORE
    // it runs — the disclosure, not a warning after the fact. It is the
    // REPOSITORY's Disconnect: since MOTIR-8216 the room also lists each GitHub
    // account with a Disconnect of its own, above the inventory.
    await page
      .locator(`#main ul:not([aria-label="${enMessages.github.accounts.title}"])`)
      .getByRole('button', { name: new RegExp(disc.confirm) })
      .first()
      .click();
    await expect(page.getByText(/1 project loses this repository/)).toBeVisible();
    // …and it makes no permanence claim: re-adding inside the window cancels it.
    await expect(page.getByText(/cancels the removal/)).toBeVisible();
    await beat();
  });
});
