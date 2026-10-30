import { projectsService } from '@/lib/services/projectsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  postSignedWebhook,
  pullRequestPayload,
  seedGithubInstallation,
} from './_helpers/github-seed';
import {
  E2E_INSTALLATION_ACCOUNT,
  E2E_INSTALLATION_ID,
  E2E_REPO,
  E2E_REPO_SECOND,
} from './_helpers/github-const';
import { linkPr } from './_helpers/pr-link';
import { signUp } from './_helpers/shell-session';
import { resetDatabase } from './_helpers/db-reset';
import { adminDb } from '../helpers/adminDb';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';

// ACCEPTANCE — a card's repository is a THING, not a word
// (Story MOTIR-2732 · Subtask MOTIR-3043). The story's verification recipe,
// driven the way a person drives it, and recorded as the receipt Yue watches.
//
// ⚠️ WHAT THE CLIP HAS TO SHOW. Everything else in this story can be true while
// the thing a person cares about is still broken: the schema can hold a
// reference, the seams can carry it, the component can render an anchor — and
// the link can go nowhere, or a rename can leave a card pointing at a repository
// that no longer answers. Two moments carry the whole change, and each gets its
// own chapter and its own beats:
//
//   * FOLLOWING the link. A repository stops being a word the moment you can
//     click it and arrive somewhere that knows what it is.
//   * The RENAME. This is what separates a reference from a well-formatted
//     string, and it cannot be asserted below the browser without simulating the
//     thing being tested. If the card survives a rename, the model is right.
//
// ── THE SHIPPED SEAMS THIS USES ─────────────────────────────────────────────
// The repository ROWS are created through `projectRepoSetService` — the same
// service the establish flow calls — and realized against the installation
// mirror through `attachRealizedRepoRow`, which is the connect-existing path.
// The RENAME is a REAL signed `repository` / `transferred` delivery through
// `/api/github/webhook`: the product's own answer to "the repository moved or
// was renamed on the host". No stub, no direct mirror write.
//
// ⚠️ PACING vs THE LANE'S 90s PER-TEST TIMEOUT. `beat()` holds 4s and each
// chapter holds 2.5s, so the pauses alone are the budget: 9 beats + 6 chapters
// is 51s of deliberate screen time, and the run lands near 60s — the card's own
// target, with real headroom under the timeout. An earlier cut ran 17 beats and
// 89s, which passed locally with one second to spare and TIMED OUT on CI. A
// beat is spent where the reader needs to take something in — both moments of
// the follow, the old name and the new one across the rename, the hold and the
// completion — and nowhere else. Adding beats here is not free; it is the
// difference between a receipt and a red check.
//
// DETERMINISM: every wait is on an authoritative signal — a webhook's own 200
// plus its result body (the route awaits the full service handling before
// responding), a service call that has returned, or a rendered committed state.
// No `waitForTimeout` is used as synchronisation anywhere in this file.

/** UNIQUE PER RUN. The acceptance lane does not reset its database between runs,
 *  and a fixed address makes the second run fail at sign-up with "An account with
 *  this email already exists" — which surfaces as a 30s `waitForURL` timeout on
 *  `/workbench` and reads exactly like a starved renderer. Same idiom as
 *  `ai-callout-gate` / `onboarding-fresh`. */
const EMAIL = `e2e-repository-reference-${Date.now()}@example.com`;
/** What `E2E_REPO` is renamed TO, mid-clip. Deliberately unlike the original so
 *  a stale render is unmistakable on the recording rather than a subtle diff. */
const RENAMED = 'motir-demo-renamed';

type Ctx = { userId: string; workspaceId: string };

async function seedActiveProject(
  page: Page,
  identifier: string,
): Promise<{ projectId: string; ctx: Ctx }> {
  // ⚠️ NO `@/lib/db` singleton statements — see the sibling spec: a direct
  // singleton write is REFUSED under `motir_app` and a direct read returns [],
  // and neither raises. Ids come from the shipped route through the BROWSER's
  // own session.
  const res = await page.request.get('/api/workspaces/current');
  expect(res.status(), 'the auto-created workspace resolves').toBe(200);
  const { workspace, membership } = (await res.json()) as {
    workspace: { id: string };
    membership: { userId: string };
  };
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: membership.userId,
    name: 'Repository reference',
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
  return {
    projectId: project.id,
    ctx: { userId: membership.userId, workspaceId: workspace.id },
  };
}

/** Create a work item pinned to a repository ROW, through the shipped `_test`
 *  transport. `targetRepositories` takes REFERENCES — the row ids — which is the
 *  whole point of the story: the card names an object, never a string. */
async function mkItem(
  page: Page,
  projectId: string,
  title: string,
  targetRepositories?: string[],
): Promise<{ id: string; identifier: string }> {
  const res = await page.request.post('/api/_test/work-items', {
    data: {
      projectId,
      kind: 'task',
      title,
      ...(targetRepositories ? { targetRepositories } : {}),
    },
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
 *  ⚠️ ANCHORED on a PREFIX, not a substring. After the first merge the completion
 *  gate posts a hold comment that also names repositories, and its card sits
 *  EARLIER in the DOM — so `hasText: 'Repositories'` plus `.first()` silently
 *  retargets to that comment the moment the feature starts working. */
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

/** Deliver one `pull_request` event and assert the OUTCOME the sync reported. */
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
      title: `feat: ${args.identifier} the repository reference`,
      headRef: `subtask/${args.identifier.toLowerCase()}-repository-reference`,
      state: args.action === 'closed' ? 'closed' : 'open',
      merged: args.merged ?? false,
      repo: args.repo,
    }),
  );
  const body = await res.text();
  expect(res.status(), `${args.repo.name} ${args.action} → ${body.slice(0, 400)}`).toBe(200);
  expect(
    (JSON.parse(body) as { result: Record<string, unknown> }).result,
    `${args.repo.name} ${args.action}`,
  ).toMatchObject({ event: 'pull_request', outcome: args.expectOutcome });
}

/** Realize a proposed row against the installation mirror — the connect-existing
 *  path, so the row names a repository that actually exists on the host. */
async function realize(
  rowId: string,
  repo: typeof E2E_REPO | typeof E2E_REPO_SECOND,
  ctx: Ctx,
): Promise<void> {
  const mirrored = await withWorkspaceContext(ctx, (tx) =>
    githubRepoRepository.findConnectedByWorkspaceAndName(
      ctx.workspaceId,
      repo.owner,
      repo.name,
      tx,
    ),
  );
  expect(mirrored, `the mirror carries ${repo.owner}/${repo.name}`).not.toBeNull();
  // ⚠️ RELEASE a stale claim first. `project_repository.github_repo_id` is
  // GLOBALLY unique — one connected repository belongs to at most one project's
  // set, which is the right product rule — and the acceptance lane does NOT
  // reset its database between runs. So a second local run finds the mirrored
  // repository already claimed by the previous run's project and fails with
  // `RealizedRepoAlreadyClaimedError`, which reads as a product defect and is a
  // fixture artefact. Cleared through `adminDb` because the claimant belongs to
  // ANOTHER workspace, which this run's service context cannot reach — and must
  // not be able to.
  await adminDb.projectRepo.updateMany({
    where: { githubRepoId: mirrored!.id },
    data: { githubRepoId: null, state: 'proposed' },
  });
  await projectRepoSetService.attachRealizedRepoRow(rowId, mirrored!.id, ctx);
}

test('a repository is a link you can follow, and a rename does not break the card', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2732');
  // ISOLATION (Bug MOTIR-3248). Pull-request numbers are a namespace SHARED
  // across the whole lane: `github_pull_request` is @@unique([repoId, number])
  // and every spec's `seedGithubInstallation` upserts the SAME mirrored repo
  // row, so a spec that does not reset inherits its predecessors' deliveries —
  // and WHICH specs precede it is a shard partition that moves whenever any
  // file is added to the lane. This spec used to rely on landing in a friendly
  // partition; it no longer does. The cascade that makes the reset reach those
  // rows is measured in `tests/db-reset-cascade.test.ts`, and the thousand-block
  // this file owns is enforced by `tests/e2e-pull-request-number-blocks.test.ts`.
  // Both layers on purpose: the reset makes this spec independent of what ran
  // before it, the block makes it independent of anyone else remembering to.
  await resetDatabase();

  await signUp(page, EMAIL);
  const { projectId, ctx } = await seedActiveProject(page, 'RREF');
  await seedGithubInstallation(ctx.workspaceId, [E2E_REPO_SECOND]);

  // The PROJECT's own repository rows — the objects a card now points at.
  const web = await projectRepoSetService.addRow(
    projectId,
    { role: 'web', name: E2E_REPO.name },
    ctx,
  );
  const api = await projectRepoSetService.addRow(
    projectId,
    { role: 'api', name: E2E_REPO_SECOND.name },
    ctx,
  );
  // A THIRD row that is left `proposed` on purpose — a repository the plan asks
  // for and nobody has created. It exists nowhere but this project.
  const planned = await projectRepoSetService.addRow(
    projectId,
    { role: 'infra', name: 'motir-demo-infra' },
    ctx,
  );
  await realize(web.id, E2E_REPO, ctx);
  await realize(api.id, E2E_REPO_SECOND, ctx);

  const oneRepo = await mkItem(page, projectId, 'Ships in the web repository', [web.id]);
  const proposedItem = await mkItem(page, projectId, 'Ships somewhere not built yet', [planned.id]);
  const twoRepo = await mkItem(page, projectId, 'Ships in two repositories', [web.id, api.id]);
  await transition(page, twoRepo.id, 'in_progress');

  // ── 1 — the card names its repository ─────────────────────────────────────
  await chapter('Open a card that ships in a repository', async () => {
    await page.goto(`/items/${oneRepo.identifier}`);
    const card = repositoriesCard(page);
    await expect(card).toBeVisible();
    await beat();
    // A LINK, not a label — that is the whole change, and it is visible before
    // anyone clicks anything.
    await expect(card.getByRole('link', { name: E2E_REPO.name })).toBeVisible();
    // Its ROLE rides beside it: the card says WHAT the repository is, not only
    // which one.
    await expect(card.getByText('web', { exact: true })).toBeVisible();
  });

  // ── 2 — FOLLOW it. The assertion the whole story is for. ──────────────────
  await chapter('Follow the repository — it is an object, not a word', async () => {
    await repositoriesCard(page).getByRole('link', { name: E2E_REPO.name }).click();
    // The destination the design drew: the project's OWN repository row, not the
    // host. A `proposed` row has no host repository at all, so a link out to
    // GitHub would be dead for exactly the state this redraw exists to express.
    await expect(page).toHaveURL(/\/settings\/project\/repositories/);
    await beat();
    // And the page that answers knows this repository.
    await expect(page.getByText(E2E_REPO.name).first()).toBeVisible();
    await beat();
  });

  // ── 3 — the same repository, the same words, in the quick view ────────────
  await chapter('Open the same card’s quick view from the list', async () => {
    await page.goto('/items');
    // The row's peek trigger is a STRETCHED link spanning the whole row, whose
    // bounding-box centre sits over the Assignee column and intercepts a default
    // centre-click. A person clicks the TITLE, on the left.
    await page
      .getByRole('link', { name: `${oneRepo.identifier} Ships in the web repository` })
      .first()
      .click({ position: { x: 40, y: 12 } });
    await expect(page).toHaveURL(new RegExp(`peek=${oneRepo.identifier}`));
    const peek = page.getByRole('dialog');
    await expect(peek).toBeVisible();
    // Scoped to the peek's RAIL: the name also appears in the Development
    // section below, which is the feature working, not a duplicate to dedupe.
    const peekRail = peek.locator('dl').first();
    await expect(peekRail.getByRole('link', { name: E2E_REPO.name })).toBeVisible();
    await beat();
    await page.keyboard.press('Escape');
  });

  // ── 4 — THE RENAME. What separates a reference from a string. ─────────────
  await chapter('Rename the repository — the card follows it', async () => {
    await page.goto(`/items/${oneRepo.identifier}`);
    await expect(repositoriesCard(page).getByRole('link', { name: E2E_REPO.name })).toBeVisible();

    // The product's own answer to "it moved or was renamed on the host": a real
    // signed `repository` delivery through the real webhook route.
    const res = await postSignedWebhook(page.request, 'repository', {
      action: 'transferred',
      installation: { id: Number(E2E_INSTALLATION_ID) },
      repository: {
        id: Number(E2E_REPO.providerRepoId),
        name: RENAMED,
        owner: { login: E2E_INSTALLATION_ACCOUNT.login },
        default_branch: E2E_REPO.defaultBranch,
      },
    });
    const body = await res.text();
    expect(res.status(), `rename → ${body.slice(0, 400)}`).toBe(200);
    expect((JSON.parse(body) as { result: Record<string, unknown> }).result).toMatchObject({
      event: 'repository',
    });

    await page.goto(`/items/${oneRepo.identifier}`);
    const card = repositoriesCard(page);
    // The card shows the NEW name…
    await expect(card.getByRole('link', { name: RENAMED })).toBeVisible();
    await expect(card.getByText(E2E_REPO.name, { exact: true })).toHaveCount(0);
    await beat();
    // …and still points at the SAME row. Nothing wrote to the work item; a
    // name-copying model would have needed a sweep here, and the cards it
    // missed would be silently wrong.
    await expect(card.getByRole('link', { name: RENAMED })).toHaveAttribute(
      'href',
      new RegExp(`/settings/project/repositories#${RENAMED}`),
    );
    await beat();
  });

  // ── 5 — a repository that does not exist yet reads as exactly that ────────
  await chapter('A card pinned to a repository nobody has created', async () => {
    await page.goto(`/items/${proposedItem.identifier}`);
    const card = repositoriesCard(page);
    await expect(card.getByRole('link', { name: 'motir-demo-infra' })).toBeVisible();
    // NOT "awaiting a pull request". Awaiting promises a pull request someone
    // could open, and a proposed row has no default branch to open one against —
    // the reader's next action is the establish step, somewhere else entirely.
    await expect(card.getByText('Not created', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Repository not created yet')).toBeVisible();
    await expect(page.getByText('No pull request yet')).toHaveCount(0);
    await beat();
  });

  // ── 6 — two repositories: the hold, then the completion ───────────────────
  await chapter('A card in TWO repositories holds until both have merged', async () => {
    await page.goto(`/items/${twoRepo.identifier}`);
    const card = repositoriesCard(page);
    await expect(card.getByRole('link', { name: RENAMED })).toBeVisible();
    await expect(card.getByRole('link', { name: E2E_REPO_SECOND.name })).toBeVisible();

    // ⚠️ 8xxx — THIS SPEC'S OWN BLOCK. Pull-request numbers are a SHARED
    // namespace across the acceptance lane: `playwright.acceptance.config.ts`
    // reuses one database for a whole shard, and nothing between specs resets
    // it, so `(repo, number)` collides across FILES. Every other spec already
    // takes a thousand-block of its own — `github.spec.ts` 4xxx,
    // `repository-set.spec.ts` 5xxx, `acceptance-implemented-lifecycle` 6xxx,
    // `acceptance-scoped-run` 7xxx — and this file was the one duplicating a
    // neighbour's (6101/6102, the lifecycle spec's). It only ever passed
    // because the two happened to land in different shards; the shard
    // partition changes whenever a spec file is ADDED, and the collision then
    // makes the second spec's `opened` delivery resolve to the first spec's
    // change request, so its card never reaches Implemented. Take a new block
    // rather than reusing one.
    // ⚠️ BOTH pull requests are linked AND OPENED before the first merges. Since
    // MOTIR-3674 the title naming `twoRepo.identifier` associates nothing, so the
    // links are what tie the deliveries to the card. Since MOTIR-10135 the
    // item completes when every LINKED pull request has merged onto its trunk
    // — the repository set no longer holds it — so the hold below is the
    // DELIVERY-set gate (MOTIR-3659) waiting on the second link, and it only
    // holds if that second pull request is linked before the first merges.
    //
    // ⚠️ AND IT NAMES THE REPOSITORY BY ITS CURRENT NAME, which in THIS spec is
    // the renamed one. The two doors do not resolve a repository the same way,
    // and that asymmetry is this file's whole subject: a delivery arrives with a
    // `providerRepoId` and is rename-proof, while `link_pull_request` takes
    // coordinates a person can type and resolves by owner and name. So the
    // deliveries below keep using `E2E_REPO` — its id is what they match on —
    // and the link has to say `RENAMED` or the repository is not found (a 404
    // from the link door, which is the shape this got wrong first time).
    const refHeadRef = `subtask/${twoRepo.identifier.toLowerCase()}-repository-reference`;
    await linkPr(page, {
      workItemId: twoRepo.id,
      repo: { ...E2E_REPO, name: RENAMED },
      number: 8101,
      headRef: refHeadRef,
    });

    await deliver(page, {
      action: 'opened',
      identifier: twoRepo.identifier,
      number: 8101,
      repo: E2E_REPO,
      expectOutcome: 'transitioned',
    });
    await linkPr(page, {
      workItemId: twoRepo.id,
      repo: E2E_REPO_SECOND,
      number: 8102,
      headRef: refHeadRef,
    });
    await deliver(page, {
      action: 'opened',
      identifier: twoRepo.identifier,
      number: 8102,
      repo: E2E_REPO_SECOND,
      expectOutcome: 'noop',
    });
    await deliver(page, {
      action: 'closed',
      identifier: twoRepo.identifier,
      number: 8101,
      repo: E2E_REPO,
      merged: true,
      // The hold — not `transitioned`: the linked 8102 has not merged yet.
      expectOutcome: 'deferred_incomplete_delivery_set',
    });
    await page.goto(`/items/${twoRepo.identifier}`);
    // Held, not completed — the hold is this chapter's claim. The status it
    // holds AT is `Implemented` since MOTIR-2999: the pull request is open and
    // no build has reported, so the card is delivered and not yet reviewable.
    // (This story's receipt has not frozen — it is still in review — so the
    // spec records today's product rather than owing a disposition.)
    await expect(statusCard(page).getByText('Implemented', { exact: true })).toBeVisible();
    await beat();

    await deliver(page, {
      action: 'closed',
      identifier: twoRepo.identifier,
      number: 8102,
      repo: E2E_REPO_SECOND,
      merged: true,
      expectOutcome: 'transitioned',
    });
    await page.goto(`/items/${twoRepo.identifier}`);
    await expect(statusCard(page).getByText('Done', { exact: true })).toBeVisible();
    await beat();
  });
});
