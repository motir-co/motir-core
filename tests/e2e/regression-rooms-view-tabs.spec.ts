import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  ROOMS_COUNTS,
  seedRoomsViewTabs,
  type RoomsViewTabsSeed,
} from './_helpers/rooms-view-tabs-seed';

// PLANS, APPROVALS AND RUNS OPEN ON THE WHOLE PROJECT — END TO END, AND THE
// ACCEPTANCE RECEIPT FOR IT (Story MOTIR-6179 · Subtask MOTIR-6337).
//
// The story's `## Verification`, automated, for three people on one project:
//
//   1. A VIEWER opens each room from the rail and meets EVERY record of the
//      project — no Mine / Project switch (they can act in none of the rooms)
//      and no control that acts.
//   2. A MEMBER meets the switch in each room: Mine is exactly their records,
//      Project is all of them, a switch writes `?view=`, a reload keeps it and
//      Back returns to the view before. Their Approvals Mine is EMPTY by the
//      seed, so a clean arrival lands on Project (design MOTIR-6327's default)
//      and Mine shows the Mine copy.
//   3. A CUSTOM ROLE without the runs view key or `work_item:edit` has no Runs
//      door — rail or ⌘K — and `/runs` is not-found; Plans and Approvals open
//      on Project alone, as the role's two view keys dictate.
//
// ⚠️ EVERY ROOM IS REACHED BY CLICKING ITS DOOR (the rail), because the door is
// part of the claim: a room nobody can find is not open. The one `page.goto`
// onto a room is the custom role's `/runs`, whose claim is that the URL is
// closed; and the Runs `?scope=` address, which is a URL axis rather than a door.
//
// ⚠️ DETERMINISM (`CLAUDE.md` § E2E). Each view is a real server read
// (`router.push`), so the rows and the pressed segment are rendered FROM that
// read — the assertion is the authoritative wait. Every locator is role-rooted
// or scoped to `main`; there is no fixed timeout. The pacing holds are the
// acceptance helper's `chapter` / `beat`, taken AFTER a state is proven.

test.describe.configure({ timeout: 300_000 });

const main = (page: Page) => page.getByRole('main');
const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

const SWITCH = {
  plans: "Show your conversations or the whole project's",
  approvals: "Show your approvals or the whole project's",
  runs: "Show your runs or the whole project's",
} as const;
type Room = keyof typeof SWITCH;

const ROOM = {
  plans: { rail: 'Plans', path: '/plans', heading: 'Plans' },
  approvals: { rail: 'Approval records', path: '/approvals', heading: 'Approval records' },
  runs: { rail: 'Runs', path: '/runs', heading: 'Runs' },
} as const;

/** The room's record rows, as a reader sees them. */
function rows(page: Page, room: Room): Locator {
  if (room === 'plans') {
    return main(page).getByRole('list', { name: 'Planning conversations' }).getByRole('listitem');
  }
  if (room === 'approvals') return main(page).getByTestId(/^approval-row-/);
  // Runs: every body row of the live and past tables (header rows hold no cell).
  return main(page)
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });
}

const viewSwitch = (page: Page, room: Room) =>
  main(page).getByRole('group', { name: SWITCH[room] });

/** Click the rail door, and wait on the room's own heading — the authoritative landing. */
async function openFromRail(page: Page, room: Room): Promise<void> {
  const r = ROOM[room];
  await rail(page).getByRole('link', { name: r.rail, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === r.path);
  await expect(page.getByRole('heading', { name: r.heading, level: 1 })).toBeVisible();
}

/** Assert which segment is pressed — rendered from the view the server SERVED. */
async function expectServed(page: Page, room: Room, view: 'Mine' | 'Project'): Promise<void> {
  const other = view === 'Mine' ? 'Project' : 'Mine';
  const group = viewSwitch(page, room);
  await expect(group.getByRole('button', { name: view, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(group.getByRole('button', { name: other, exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
}

/** Press a segment and wait on the URL, the pressed state and the served rows. */
async function switchTo(
  page: Page,
  room: Room,
  view: 'Mine' | 'Project',
  expectedRows: number,
): Promise<void> {
  await viewSwitch(page, room).getByRole('button', { name: view, exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get('view') === view.toLowerCase());
  await expectServed(page, room, view);
  await expect(rows(page, room)).toHaveCount(expectedRows);
}

async function signInAs(page: Page, email: string, password: string): Promise<void> {
  await signIn(page, email, password);
  await expect(rail(page).getByRole('link', { name: 'Work Items' })).toBeVisible();
}

let seed: RoomsViewTabsSeed;

test.beforeEach(async () => {
  await resetDatabase();
  seed = await seedRoomsViewTabs(`r${Date.now().toString(36)}`);
});

test('a Viewer sees every record of the project, and a Member gets their own view beside it', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6179');

  await chapter('A Viewer opens Plans, Approvals and Runs — the whole project', async () => {
    await signInAs(page, seed.viewerEmail, seed.password);
    for (const room of ['plans', 'approvals', 'runs'] as const) {
      await expect(
        rail(page).getByRole('link', { name: ROOM[room].rail, exact: true }),
      ).toBeVisible();
    }
    // Nothing that acts: no Plan-with-AI launcher anywhere in the shell.
    await expect(page.getByRole('button', { name: 'Plan with AI' })).toHaveCount(0);
  });

  for (const room of ['plans', 'approvals', 'runs'] as const) {
    await chapter(`The Viewer's ${ROOM[room].rail}: every record, no switch`, async () => {
      await openFromRail(page, room);
      await expect(rows(page, room)).toHaveCount(ROOMS_COUNTS[room].project);
      await expect(viewSwitch(page, room)).toHaveCount(0);
      if (room === 'approvals') {
        await expect(
          main(page).getByText('Every approval in this project — waiting first, then decided.'),
        ).toBeVisible();
        await expect(main(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
      }
    });
    await beat();
  }

  await chapter('A Member opens Plans — their own conversations first', async () => {
    await signInAs(page, seed.memberEmail, seed.password);
    await openFromRail(page, 'plans');
    // Mine has a row, so a clean arrival serves Mine.
    await expectServed(page, 'plans', 'Mine');
    await expect(rows(page, 'plans')).toHaveCount(ROOMS_COUNTS.plans.member);
    await expect(rows(page, 'plans').filter({ hasText: seed.memberPlanTitle })).toHaveCount(1);
  });
  await beat();

  await chapter('Project shows everyone’s — and the address says so', async () => {
    await switchTo(page, 'plans', 'Project', ROOMS_COUNTS.plans.project);
    for (const title of seed.ownerPlanTitles) {
      await expect(rows(page, 'plans').filter({ hasText: title })).toHaveCount(1);
    }
    // A reload keeps the view…
    await page.reload();
    await expectServed(page, 'plans', 'Project');
    await expect(rows(page, 'plans')).toHaveCount(ROOMS_COUNTS.plans.project);
    // …and Back returns to the view before it.
    await page.goBack();
    await expect(page).toHaveURL((url) => url.searchParams.get('view') === null);
    await expectServed(page, 'plans', 'Mine');
    await expect(rows(page, 'plans')).toHaveCount(ROOMS_COUNTS.plans.member);
  });
  await beat();

  await chapter('Approvals: nothing is theirs yet, so the room opens on the project', async () => {
    await openFromRail(page, 'approvals');
    await expectServed(page, 'approvals', 'Project');
    await expect(rows(page, 'approvals')).toHaveCount(ROOMS_COUNTS.approvals.project);
    await viewSwitch(page, 'approvals').getByRole('button', { name: 'Mine', exact: true }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get('view') === 'mine');
    await expectServed(page, 'approvals', 'Mine');
    // The Mine copy, not the project's.
    await expect(
      main(page).getByText('Approvals asked of you, and the ones you decide, will appear here.'),
    ).toBeVisible();
    await expect(rows(page, 'approvals')).toHaveCount(ROOMS_COUNTS.approvals.member);
  });
  await beat();

  await chapter('Runs: the runs they started, then every run', async () => {
    await openFromRail(page, 'runs');
    await expectServed(page, 'runs', 'Mine');
    await expect(rows(page, 'runs')).toHaveCount(ROOMS_COUNTS.runs.member);
    await switchTo(page, 'runs', 'Project', ROOMS_COUNTS.runs.project);
    await switchTo(page, 'runs', 'Mine', ROOMS_COUNTS.runs.member);
  });
  await beat();
});

test('a Member narrowing Runs to one work item keeps their own view, and All runs keeps it too', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6179');
  await signInAs(page, seed.memberEmail, seed.password);
  // `?scope=` is a URL axis (WHICH work item), `?view=` the other (WHOSE runs).
  await page.goto(`/runs?scope=${encodeURIComponent(seed.storyKey)}&view=mine`);
  await expectServed(page, 'runs', 'Mine');
  // Two runs are scoped to the story; one of them is the Member's.
  await expect(rows(page, 'runs')).toHaveCount(ROOMS_COUNTS.runs.memberInStory);
  await switchTo(page, 'runs', 'Project', 2);
  await switchTo(page, 'runs', 'Mine', ROOMS_COUNTS.runs.memberInStory);

  await main(page).getByRole('link', { name: 'All runs' }).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get('scope') === null && url.searchParams.get('view') === 'mine',
  );
  await expectServed(page, 'runs', 'Mine');
  await expect(rows(page, 'runs')).toHaveCount(ROOMS_COUNTS.runs.member);
});

test('a custom role without the runs view key has no Runs door, and /runs is not-found', async ({
  page,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-6179');
  await signInAs(page, seed.customEmail, seed.password);

  // No Runs row in the rail…
  await expect(rail(page).getByRole('link', { name: 'Plans', exact: true })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Runs', exact: true })).toHaveCount(0);

  // …and none in the command palette.
  const isMac = await page.evaluate(() => /mac|iphone|ipad|ipod/i.test(navigator.platform));
  await page.keyboard.press(`${isMac ? 'Meta' : 'Control'}+k`);
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  // A positive control first, so the absence below is a filtered answer and not an
  // empty palette: the role's Approvals door IS offered here.
  await page.keyboard.type('Approval');
  await expect(palette.getByRole('option', { name: 'Go to Approval records' })).toBeVisible();
  await page.keyboard.press(`${isMac ? 'Meta' : 'Control'}+a`);
  await page.keyboard.type('Runs');
  await expect(palette.getByRole('option', { name: /\bRuns\b/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  // Plans and Approvals open on Project alone — the role's two view keys, no act key.
  await openFromRail(page, 'plans');
  await expect(rows(page, 'plans')).toHaveCount(ROOMS_COUNTS.plans.project);
  await expect(viewSwitch(page, 'plans')).toHaveCount(0);
  await openFromRail(page, 'approvals');
  await expect(rows(page, 'approvals')).toHaveCount(ROOMS_COUNTS.approvals.project);
  await expect(viewSwitch(page, 'approvals')).toHaveCount(0);

  // The URL is closed too: the response itself is a 404.
  const response = await page.goto('/runs');
  expect(response?.status()).toBe(404);
});
