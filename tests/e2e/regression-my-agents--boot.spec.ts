import type { Locator, Page } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import { seedCreatedRepo } from './_helpers/hosted-run-seed';
import {
  holdClone,
  refuseClone,
  releaseClone,
  seedMyAgents,
  type MyAgentsSeed,
} from './_helpers/my-agents-seed';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// WATCH YOUR AGENT BOOT (Story MOTIR-7393 · MOTIR-7402) — the story's browser
// walk and its acceptance receipt.
//
// ── THE SEAMS ─────────────────────────────────────────────────────────────────
// The fleet is the PERSISTENT fake (`MOTIR_FLEET_ORCHESTRATOR=fake`), and the
// boot is the REAL server-side driver (`agentInstanceBootService`), run by the
// job worker this lane starts. Each repository's clone is one exec through the
// fake's exec door to the terminal host (`_helpers/agent-terminal/host.ts`),
// which answers it at once unless this spec scripted that repository through
// `my-agents-seed.ts`: `holdClone` keeps the step IN PROGRESS until
// `releaseClone`, and `refuseClone` makes git refuse it — never a real network.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Create is asserted on its own `201`; every step after it on the read-out row's
// committed `data-state`, which the panel renders from the boot stream's frames
// (or, after a reload, from its first read) — never on a timer. A held clone is
// what makes a mid-boot state last long enough to assert and to watch.

test.describe.configure({ timeout: 180_000 });

const copy = en.myAgents;
const boot = copy.boot;
const WIDE = { width: 1440, height: 810 };
const REPO_OWNER = 'motir-projects-e2e';
/** The summary's words before its `{time}`. */
const lead = (message: string): string => message.split('{')[0]!.trim();

/** The panel, scoped to the live subtree. */
const panel = (page: Page): Locator => page.getByRole('main').getByTestId('agent-panel');
const readout = (page: Page): Locator => panel(page).getByTestId('agent-boot');
const steps = (page: Page): Locator => readout(page).locator('ol > li');
const screen = (page: Page): Locator =>
  panel(page).getByTestId('agent-terminal').locator('.xterm-rows');
const rowOf = (page: Page, name: string): Locator =>
  page.getByRole('table').getByTestId('agent-row').filter({ hasText: name });

const instancesResponse = (page: Page, method: string, suffix = '') =>
  page.waitForResponse(
    (res) =>
      res.request().method() === method &&
      new URL(res.url()).pathname.match(/\/api\/projects\/[^/]+\/instances/) !== null &&
      new URL(res.url()).pathname.endsWith(suffix),
    { timeout: 45_000 },
  );

/** Each step row's committed state, in order. */
async function expectStates(page: Page, states: string[]): Promise<void> {
  await expect(steps(page)).toHaveCount(states.length);
  for (const [i, state] of states.entries()) {
    await expect(steps(page).nth(i)).toHaveAttribute('data-state', state);
  }
}

async function createAgent(page: Page, name: string): Promise<string> {
  await page.getByRole('button', { name: copy.newAgent }).first().click();
  const dialog = page.getByRole('dialog', { name: copy.create.title });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(copy.create.name).fill(name);
  await dialog.getByRole('radio', { name: /^Claude Code/ }).check();
  const created = instancesResponse(page, 'POST', '/instances');
  await dialog.getByRole('button', { name: copy.create.submit }).click();
  const res = await created;
  expect(res.status()).toBe(201);
  const { instance } = (await res.json()) as { instance: { id: string } };
  await expect(dialog).toBeHidden();
  return instance.id;
}

test.describe('Watch your agent boot', () => {
  let seed: MyAgentsSeed;
  let api = '';
  let web = '';
  test.beforeEach(async () => {
    const tag = Date.now().toString(36);
    seed = await seedMyAgents(tag);
    // Two repositories, seeded in clone order: one Cloning row each.
    for (const name of [`api-${tag}`, `web-${tag}`]) {
      await seedCreatedRepo(seed.workspaceId, seed.organizationId, seed.projectId, {
        owner: REPO_OWNER,
        name,
      });
    }
    api = `${REPO_OWNER}/api-${tag}`;
    web = `${REPO_OWNER}/web-${tag}`;
  });
  test.afterEach(() => {
    releaseClone(api);
    releaseClone(web);
  });

  test('create opens the panel at once, the boot reads out live through a reload, a wake skips the clones, and a refused clone fails in words', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7393');
    await page.setViewportSize(WIDE);
    await signIn(page, seed.email, seed.password);
    await page.getByRole('link', { name: 'My agents' }).click();
    await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();

    // The second repository's clone waits until the reload chapter releases it.
    holdClone(web);

    let id = '';
    await chapter(
      'Press Create — the dialog closes and the new agent’s panel opens at once',
      async () => {
        id = await createAgent(page, 'yue-claude');
        await expect(page).toHaveURL(new RegExp(`[?&]agent=${id}`));
        await expect(panel(page).getByRole('heading', { level: 2 })).toContainText('yue-claude');
        await expect(readout(page)).toHaveAttribute('data-outcome', 'booting');
        await expect(readout(page)).toContainText(boot.title.create);
      },
    );
    await beat();

    await chapter('Every step ticks through in order, one row per repository', async () => {
      await expect(steps(page)).toHaveCount(6);
      await expect(steps(page).nth(0)).toContainText(boot.step.provision);
      await expect(steps(page).nth(1)).toContainText(boot.step.machineStart);
      await expect(steps(page).nth(2)).toContainText(`${lead(boot.step.clone)} ${api}`);
      await expect(steps(page).nth(3)).toContainText(`${lead(boot.step.clone)} ${web}`);
      await expect(steps(page).nth(4)).toContainText(boot.step.terminalCheck);
      await expect(steps(page).nth(5)).toContainText(boot.step.ready);
      for (const i of [0, 1, 2]) {
        await expect(steps(page).nth(i)).toHaveAttribute('data-state', 'done', {
          timeout: 45_000,
        });
      }
      await expect(steps(page).nth(3)).toHaveAttribute('data-state', 'in_progress');
    });
    await beat();

    await chapter(
      'Reload mid-boot — the panel comes back on the same step, then finishes',
      async () => {
        await page.reload();
        await expect(page).toHaveURL(new RegExp(`[?&]agent=${id}`));
        await expectStates(page, ['done', 'done', 'done', 'in_progress', 'waiting', 'waiting']);
        await beat();
        releaseClone(web);
        await expect(readout(page)).toHaveAttribute('data-outcome', 'running', { timeout: 45_000 });
        await expect(readout(page)).toContainText(lead(boot.summary.create));
        // The shell's prompt: `$` as the image's user, `#` where the host runs as root.
        await expect(screen(page)).toContainText(/~\/workspace[$#]/, { timeout: 30_000 });
      },
    );
    await beat();

    await chapter('Hibernate, then Wake — the clones are skipped, the home is kept', async () => {
      const idle = await page.request.post('/api/_test/agent-instances/idle', {
        data: { instanceIds: [id], advanceMinutes: 31 },
      });
      expect(await idle.json()).toEqual({ results: { [id]: 'idle' } });
      await panel(page).getByRole('button', { name: `Close yue-claude` }).click();
      await page.reload();
      await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'hibernated');
      await page.getByRole('button', { name: 'Actions for yue-claude' }).click();
      const woke = instancesResponse(page, 'POST', '/wake');
      await page
        .getByRole('menu', { name: 'Actions for yue-claude' })
        .getByRole('menuitem', { name: copy.menu.wake })
        .click();
      expect((await woke).status()).toBe(200);
      await rowOf(page, 'yue-claude').click();
      await expect(readout(page)).toHaveAttribute('data-outcome', 'running', { timeout: 45_000 });
      await expect(readout(page)).toContainText(lead(boot.summary.wake));
      await readout(page).getByRole('button', { name: boot.showSteps }).click();
      await expectStates(page, ['done', 'done', 'skipped', 'skipped', 'done', 'done']);
      await expect(steps(page).nth(2)).toContainText(boot.skipped.clone);
    });
    await beat();

    await chapter(
      'A repository that can’t be cloned — the step fails in words, with Wake and Delete',
      async () => {
        refuseClone(
          web,
          `remote: Repository not found.\nfatal: repository 'https://github.com/${web}.git/' not found`,
        );
        await createAgent(page, 'yue-broken');
        await expect(panel(page).getByRole('heading', { level: 2 })).toContainText('yue-broken');
        await expect(readout(page)).toHaveAttribute('data-outcome', 'failed', { timeout: 45_000 });
        await expect(steps(page).nth(2)).toHaveAttribute('data-state', 'done');
        await expect(steps(page).nth(3)).toHaveAttribute('data-state', 'failed');
        await expect(steps(page).nth(3)).toContainText(
          boot.detail.cloneNoAccess.replace('{repository}', web),
        );
        await expect(readout(page).getByRole('button', { name: copy.panel.wake })).toBeVisible();
        await expect(readout(page).getByRole('button', { name: copy.panel.delete })).toBeVisible();
      },
    );
    await beat();

    await chapter('In Chinese, the read-out speaks Chinese', async () => {
      await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);
      await page.reload();
      await expect(readout(page)).toHaveAttribute('data-outcome', 'failed');
      await expect(steps(page).nth(0)).toContainText(zh.myAgents.boot.step.provision);
      await expect(steps(page).nth(1)).toContainText(zh.myAgents.boot.step.machineStart);
      await expect(steps(page).nth(3)).toContainText(`${lead(zh.myAgents.boot.step.clone)} ${web}`);
      await expect(steps(page).nth(5)).toContainText(zh.myAgents.boot.step.ready);
    });
  });
});
