import { projectsService } from '@/lib/services/projectsService';
import {
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import { E2E_REPO, E2E_REPO_SECOND } from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import { signUp } from './_helpers/shell-session';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';

// A work item that ships in MORE THAN ONE repository (Story MOTIR-2725 ·
// Subtask MOTIR-2730), PROMOTED out of the acceptance lane into the lane that
// runs on every pull request.
//
// ── WHY IT MOVED, and why now (MOTIR-3009) ──────────────────────────────────
// MOTIR-2725 is `done` and its receipt is frozen, so this spec has discharged
// its purpose and owes a disposition — promote or retire, no third route
// (`docs/decisions/acceptance-receipt-lifecycle.md` §3). The disposition was
// already decided in `docs/acceptance-lane-triage.md` ("promote alongside" the
// repository-reference row) and is executed here, by MOTIR-2999 — the story
// that made it due, because the lifecycle this spec walks through changed under
// it. The rule that forced the ordering is worth stating: a receipt must NOT be
// edited to describe today. So the spec left the lane FIRST, and only then was
// its status assertion updated — as a regression test, which is a thing you may
// update when the product deliberately changes.
//
// The promotion is the sanctioned one-line import swap (`_helpers/promoted-regression`),
// so every `chapter()` and `beat()` call stands and NO assertion was touched in
// the move — the mechanism exists precisely so a cleanup cannot quietly drop
// coverage.
//
// What it still proves, on every PR: a card that carries two repositories names
// both, reads the same way in the quick view, holds after the first merge naming
// the repository still outstanding, and completes on the second.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW, and why the pacing is load-bearing: the entire
// product change is a PAUSE. The card holds at In Review after the first merge
// and completes after the second, and a recording that blinks past that has met
// every acceptance criterion and proved nothing. Both merges therefore get their
// own chapter and their own beats.
//
// ── THE SHIPPED SEAM THIS USES, named per the card ──────────────────────────
// Steps 4 and 5 are `pull_request` webhook deliveries through the REAL
// `/api/github/webhook`, HMAC-signed with the shipped `postSignedWebhook` +
// `pullRequestPayload` helpers (Story 7.10's E2E, `tests/e2e/github.spec.ts`).
// No new mechanism, and no stub: the signature gate, the resolver, the two
// pre-existing completion gates and MOTIR-2729's new one all run for real.
//
// The ONE thing those helpers could not do is address a SECOND repository —
// they were written when a work item had one. They are extended additively
// (`E2E_REPO_SECOND`, an optional `repo` on the payload builder, optional extra
// repos on the installation seed), so every existing caller produces the same
// payload and the same connected set it always did.
//
// DETERMINISM: every wait is on an authoritative signal — the webhook's own 200
// plus its result body (the route awaits the full service handling before
// responding), then a rendered status. Never a timeout, never a re-render that
// happens to be slow enough.
//
// ⚠️ `E2E_REPO_SECOND.defaultBranch` is `trunk`, deliberately. The gate compares
// each merge against that repository's OWN mirrored default branch, and a
// fixture where both repositories default to `main` cannot tell a correct
// comparison from a hard-coded one.

const EMAIL = 'e2e-repository-set@example.com';

async function seedActiveProject(
  page: Page,
  identifier: string,
): Promise<{ projectId: string; userId: string; workspaceId: string }> {
  // ⚠️ NO `@/lib/db` singleton statements. `tests/rls/test-singleton-statement-guard`
  // ratchets that population DOWN over `tests/e2e/**`, because a direct singleton
  // write is REFUSED under `motir_app` and a direct read returns [] — neither
  // raises, so a spec seeded that way fails in a way nobody can read. The ids come
  // from the shipped `/api/workspaces/current`, through the BROWSER's own session
  // (which the clip needs signed in anyway), and the project through the service.
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Repository set',
    identifier,
  });
  // ⚠️ PIN IT ACTIVE (MOTIR-4876), the way the product's own create door does.
  // This used to read "no active-project write is needed: `getActiveProject`
  // falls back to the workspace's first non-archived project, and this
  // workspace has exactly one". Both halves were true and the second one
  // stopped being: a default project is SEEDED per workspace on the first
  // authed request (MOTIR-4870), and `signUp` above makes that request — so by
  // the time this runs the workspace holds the seeded project AND this one, the
  // seeded one is already pinned, and the fallback never gets a say. Creating a
  // project through the SERVICE skips the pin that `createProjectAction` and
  // `startNewAiProjectAction` both perform, which is exactly the gap this
  // closes; the browser is otherwise left in a project this fixture never
  // wrote to.
  await projectsService.setActiveProject({
    userId: membership.userId,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { projectId: project.id, userId: membership.userId, workspaceId: workspace.id };
}

/** Create a work item through the shipped `_test` route — the spec's data
 *  prerequisite, not the surface under test. `targetRepos` rides
 *  `CreateWorkItemInput`, so a two-repository card needs no test-only path. */
async function mkItem(
  page: Page,
  projectId: string,
  title: string,
  targetRepos?: string[],
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: { projectId, kind: 'task', title, ...(targetRepos ? { targetRepos } : {}) },
  });
  expect(res.status(), `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; identifier: string };
}

async function transition(page: Page, id: string, statusKey: string): Promise<void> {
  const res = await page.request.patch(`/api/_test/work-items?id=${id}&status=${statusKey}`);
  expect(res.status(), `transition → ${statusKey}`).toBe(200);
}

/** The detail rail's Repositories field card.
 *
 *  ⚠️ ANCHORED on the card's own text, not a substring. After the first merge the
 *  gate posts a hold comment naming the repositories it is still waiting on, and
 *  that comment's card sits EARLIER in the DOM — so a `hasText: 'Repositories'`
 *  filter plus `.first()` silently retargets to the comment the moment the
 *  feature starts working. The rail card's text BEGINS with its label. */
function repositoriesCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ hasText: /^Repositories/ })
    .first();
}

function statusCard(page: Page) {
  return page
    .locator('[data-surface="card"]')
    .filter({ has: page.getByRole('button', { name: 'Edit Status' }) });
}

/** Deliver one `pull_request` event and assert the OUTCOME the sync reported —
 *  the committed-state signal the next step reads the page on. */
async function deliver(
  page: Page,
  args: {
    action: 'opened' | 'closed';
    identifier: string;
    number: number;
    repo: typeof E2E_REPO | typeof E2E_REPO_SECOND;
    merged?: boolean;
    expectOutcome: string;
  },
): Promise<void> {
  const res = await postSignedWebhook(
    page.request,
    'pull_request',
    pullRequestPayload({
      action: args.action,
      number: args.number,
      title: `feat: ${args.identifier} the repository set`,
      headRef: `subtask/${args.identifier.toLowerCase()}-repository-set`,
      state: args.action === 'closed' ? 'closed' : 'open',
      merged: args.merged ?? false,
      repo: args.repo,
    }),
  );
  // Carry the BODY into the failure message: a 500 here is a server-side fault
  // in the sync, and a bare status code sends the reader to the server log to
  // find out which one.
  const body = await res.text();
  expect(res.status(), `${args.repo.name} ${args.action} → ${body.slice(0, 400)}`).toBe(200);
  expect(
    (JSON.parse(body) as { result: Record<string, unknown> }).result,
    `${args.repo.name} ${args.action}`,
  ).toMatchObject({ event: 'pull_request', outcome: args.expectOutcome });
}

test('a card that ships in two repositories holds until BOTH have merged', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2725');

  await signUp(page, EMAIL);
  const wsRes = await page.request.get('/api/workspaces/current');
  expect(wsRes.status()).toBe(200);
  const workspaceId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;
  const { projectId, userId } = await seedActiveProject(page, 'RSET');
  const installation = await seedGithubInstallation(workspaceId, [E2E_REPO_SECOND]);
  const ctx = { userId, workspaceId };
  for (const repoSpec of [E2E_REPO, E2E_REPO_SECOND]) {
    const row = await projectRepoSetService.addRow(
      projectId,
      { role: 'other', name: repoSpec.name },
      ctx,
    );
    const mirror = installation.repos.find((repo) => repo.name === repoSpec.name);
    if (!mirror) throw new Error(`missing mirrored repository ${repoSpec.name}`);
    await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, ctx);
  }

  const twoRepo = await mkItem(page, projectId, 'Ships in two repositories', [
    E2E_REPO.name,
    E2E_REPO_SECOND.name,
  ]);
  const noRepo = await mkItem(page, projectId, 'Ships nowhere in particular');
  await transition(page, twoRepo.id, 'in_progress');

  // ── 1 — the card names BOTH repositories, in order ────────────────────────
  await chapter('Open a card that ships in two repositories', async () => {
    await page.goto(`/items/${twoRepo.identifier}`);
    const card = repositoriesCard(page);
    await expect(card).toBeVisible();
    await beat();

    // Both, in the order the card carries them, with the first marked as the
    // one a dispatch routes to.
    await expect(card.getByText(E2E_REPO.name, { exact: true })).toBeVisible();
    await expect(card.getByText(E2E_REPO_SECOND.name, { exact: true })).toBeVisible();
    await expect(card.getByText('primary', { exact: true })).toBeVisible();
    await beat();
  });

  // ── 2 — the same two repositories, the same words, in the quick view ──────
  await chapter('Open the same item’s quick view from the list', async () => {
    await page.goto('/items');
    // The list row's peek trigger is a STRETCHED link (`absolute inset-0`,
    // `IssueListTable.tsx`) that spans the WHOLE row, so its bounding-box centre
    // sits over the Assignee column — which intercepts a default centre-click.
    // A person clicks the row's TITLE, on the left, where the stretched link is
    // the topmost element; `position` reproduces that rather than forcing the
    // click past an interception that is real.
    await page
      .getByRole('link', { name: `${twoRepo.identifier} ${'Ships in two repositories'}` })
      .first()
      .click({ position: { x: 40, y: 12 } });
    await expect(page).toHaveURL(new RegExp(`peek=${twoRepo.identifier}`));
    const peek = page.getByRole('dialog');
    await expect(peek).toBeVisible();
    await beat();

    // Scoped to the peek's RAIL (`<dl>`): each repository name also appears in
    // the Development section below, on its awaiting row — which is the feature
    // working, not a duplicate to dedupe away. The rail is what this chapter is
    // about.
    const peekRail = peek.locator('dl').first();
    await expect(peekRail.getByText(E2E_REPO.name, { exact: true })).toBeVisible();
    await expect(peekRail.getByText(E2E_REPO_SECOND.name, { exact: true })).toBeVisible();
    await expect(peekRail.getByText('primary', { exact: true })).toBeVisible();
    await beat();
    await page.keyboard.press('Escape');
  });

  // ── 3 — a card that carries none reads as deliberate, not broken ──────────
  await chapter('Open a card that names no repository at all', async () => {
    await page.goto(`/items/${noRepo.identifier}`);
    const card = repositoriesCard(page);
    await expect(card.getByText('None', { exact: true })).toBeVisible();
    await expect(card.getByText(/Optional/)).toBeVisible();
    await beat();

    // No error, and nothing asking the reader to fill it in — scoped to the CARD.
    // A page-wide `getByRole('alert')` always matches the toast root's empty live
    // region ("Notifications (F8)"), which is app chrome on every page and says
    // nothing about this field.
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card.getByRole('button', { name: /add repositor/i })).toHaveCount(0);
    await beat();
  });

  // ⚠️ BOTH pull requests are linked and opened BEFORE the first merge. Since
  // MOTIR-10135 completion counts the card's LINKED pull requests, not its
  // repository list: a repository with no pull request no longer holds the card,
  // so the hold below is the DELIVERY set's (`deferred_incomplete_delivery_set`,
  // MOTIR-3659) — the second repository's pull request is open. The surface still
  // names that repository as outstanding, which is what this chapter shows.
  const headRef = `subtask/${twoRepo.identifier.toLowerCase()}-repository-set`;

  // ── 4 — the first merge, and the HOLD. The product change. ────────────────
  await chapter('Merge the FIRST repository — the card holds', async () => {
    await linkPr(page, { workItemId: twoRepo.id, repo: E2E_REPO, number: 5101, headRef });
    await deliver(page, {
      action: 'opened',
      identifier: twoRepo.identifier,
      number: 5101,
      repo: E2E_REPO,
      expectOutcome: 'transitioned',
    });
    await linkPr(page, {
      workItemId: twoRepo.id,
      repo: E2E_REPO_SECOND,
      number: 5102,
      headRef,
    });
    await deliver(page, {
      action: 'opened',
      identifier: twoRepo.identifier,
      number: 5102,
      repo: E2E_REPO_SECOND,
      expectOutcome: 'noop',
    });
    await deliver(page, {
      action: 'closed',
      identifier: twoRepo.identifier,
      number: 5101,
      repo: E2E_REPO,
      merged: true,
      // THE ASSERTION THIS STORY EXISTS FOR: not `transitioned`.
      expectOutcome: 'deferred_incomplete_delivery_set',
    });

    await page.goto(`/items/${twoRepo.identifier}`);
    // Still held — the hold, on the surface. The status it holds AT became
    // `Implemented` with MOTIR-2999 (an open pull request whose build has not
    // reported is delivered, not reviewable); what this chapter asserts is
    // unchanged, which is that the card did NOT complete on the first merge.
    await expect(statusCard(page).getByText('Implemented', { exact: true })).toBeVisible();
    await beat();

    // And the surface says WHICH repository is still outstanding — the hold plus
    // its explanation, not just the hold.
    const card = repositoriesCard(page);
    await expect(card.getByText(/1 of 2 delivered/)).toBeVisible();
    await expect(card.getByText(new RegExp(`${E2E_REPO_SECOND.name}.*outstanding`))).toBeVisible();
    await beat();
    await beat();
  });

  // ── 5 — the second merge completes it ─────────────────────────────────────
  await chapter('Merge the SECOND repository — the card completes', async () => {
    await deliver(page, {
      action: 'closed',
      identifier: twoRepo.identifier,
      number: 5102,
      repo: E2E_REPO_SECOND,
      merged: true,
      expectOutcome: 'transitioned',
    });

    await page.goto(`/items/${twoRepo.identifier}`);
    await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
    await beat();

    // The exact caption, not /delivered/i — each row also carries its state word
    // in an `sr-only` span (the non-colour a11y cue), so a loose match resolves
    // to three elements the moment both repositories land.
    await expect(repositoriesCard(page).getByText('All delivered.')).toBeVisible();
    await beat();
    await beat();
  });
});
