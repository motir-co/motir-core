import type { Locator, Page, Request, WebSocketRoute } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import { adminDb, db } from './_helpers/db-reset';
import { createTestPerson } from './_helpers/testPerson';
import {
  seedMyAgents,
  setCatalogUnavailable,
  resetCatalog,
  type MyAgentsSeed,
} from './_helpers/my-agents-seed';
import en from '@/messages/en.json';

// THE AGENT TERMINAL (Story MOTIR-6861 · MOTIR-6943) — the story's verification
// recipe in a browser and, for the happy path, its acceptance receipt: open a
// hibernated agent from My agents and watch it wake into a live shell, sign in
// through the coding agent's own flow, type and resize, lose and regain the
// connection, switch agents, let it hibernate, and find the sign-in kept.
//
// ── THE SEAMS (each lives in the process that uses it) ───────────────────────
// - THE FLEET is the persistent fake, shared with the web server and the job
//   worker through `MOTIR_FAKE_PERSISTENT_STATE_PATH` (the MOTIR-6877 lane).
// - THE RELAY is the real one, from its production bundle, started by
//   `playwright.acceptance.config.ts`.
// - EACH AGENT'S TERMINAL SERVER is `packages/cli`'s real server, run per fake
//   machine by `_helpers/agent-terminal/host.ts` on a real PTY, with a home
//   directory per agent that outlives its machine runs (the volume).
// - THE VENDOR SIGN-IN is `_helpers/agent-terminal/bin/claude`, a stub that
//   prints a URL, takes a pasted code and writes the credential file the
//   server's sign-in check stats. It never reaches a vendor.
// - THE IDLE WINDOW is closed by `POST /api/_test/agent-instances/idle`, which
//   runs the REAL idle check with the lifecycle clock moved forward.
// - THE DROPPED CONNECTION is Playwright's WebSocket route in front of the
//   relay: every terminal socket passes through it untouched, and the test
//   closes one to drop it.
//
// ── WAITS ────────────────────────────────────────────────────────────────────
// On the write's own response, the panel's connection word, the header's
// sign-in line (`data-state` + its text), and the terminal's own screen — a
// unique marker only the shell's OUTPUT can contain (`$((20+22))` → `42`).
// Two states that are over in a blink — the wake and the reconnect — are HELD at
// the browser (`holdRequest`) until the test has seen them, so they are asserted
// and filmed rather than raced; releasing the hold is what lets them finish.

test.describe.configure({ timeout: 180_000 });

const copy = en.myAgents;
const TYPE_DELAY_MS = 30;
const WIDE = { width: 1440, height: 810 };

/**
 * The panel, scoped to the LIVE subtree (`main`) — a page-rooted strict locator
 * could also match a streamed or outgoing copy (`tests/e2e-page-rooted-locators.test.ts`).
 */
const panel = (page: Page): Locator => page.getByRole('main').getByTestId('agent-panel');

/** The agent terminal's screen text, as xterm's DOM renderer draws it. */
const screen = (page: Page): Locator =>
  panel(page).getByTestId('agent-terminal').locator('.xterm-rows');

const connWord = (page: Page): Locator => panel(page).getByTestId('agent-conn');
const signInLine = (page: Page): Locator => panel(page).getByTestId('agent-signin');
const panelTitle = (page: Page): Locator => panel(page).getByRole('heading', { level: 2 });
const rowOf = (page: Page, name: string): Locator =>
  page.getByRole('table').getByTestId('agent-row').filter({ hasText: name });
const cardOf = (page: Page, name: string): Locator =>
  page.getByRole('main').getByTestId('agent-list-column').locator('li').filter({ hasText: name });

/** Type a line into the terminal at a readable speed, then Enter. */
async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line, { delay: TYPE_DELAY_MS });
  await page.keyboard.press('Enter');
}

/**
 * Hold the NEXT browser request whose path ends with `suffix` until `release()`
 * — so a state that lasts only as long as that request is in flight can be
 * asserted and seen. The request then goes to the server unchanged.
 */
async function holdRequest(
  page: Page,
  suffix: string,
): Promise<{ held: Promise<Request>; release: () => Promise<void> }> {
  const pattern = (url: URL) => url.pathname.endsWith(suffix);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let seen: (req: Request) => void = () => {};
  const held = new Promise<Request>((resolve) => (seen = resolve));
  let taken = false;
  await page.route(pattern, async (route) => {
    if (taken) return route.fallback();
    taken = true;
    seen(route.request());
    await gate;
    await route.fallback();
  });
  return {
    held,
    release: async () => {
      open();
      await page.unroute(pattern);
    },
  };
}

/**
 * Call the app's API FROM THE PAGE, so the request carries every cookie the
 * browser holds — including the active-workspace cookie, which is `Secure` on a
 * production build and so is not sent by Playwright's own request client over
 * plain http.
 */
async function api(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON — kept as text for the assertion message
      }
      return { status: res.status, json };
    },
    { method, url, body },
  );
}

async function createAgent(page: Page, seed: MyAgentsSeed, name: string): Promise<string> {
  const base = `/api/projects/${seed.projectIdentifier}/instances`;
  const res = await api(page, 'POST', base, { name, profileId: 'claude' });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  const { instance } = res.json as { instance: { id: string } };
  // The create settles the boot inline; the list read is the authoritative state.
  await expect
    .poll(
      async () => {
        const list = await api(page, 'GET', base);
        const rows = (list.json as { instances: Array<{ id: string; state: string }> }).instances;
        return rows.find((row) => row.id === instance.id)?.state;
      },
      { timeout: 30_000 },
    )
    .toBe('running');
  return instance.id;
}

async function letIdleWindowPass(page: Page, ids: string[]): Promise<void> {
  const res = await api(page, 'POST', '/api/_test/agent-instances/idle', {
    instanceIds: ids,
    advanceMinutes: 31,
  });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ results: Object.fromEntries(ids.map((id) => [id, 'idle'])) });
}

/** The PTY's width, read from the shell itself (`stty size` → "rows cols"). */
async function shellColumns(page: Page, marker: string): Promise<number> {
  await typeLine(page, `echo ${marker}=$(stty size | cut -d' ' -f2)`);
  const found = new RegExp(`${marker}=(\\d+)`);
  await expect(screen(page)).toContainText(found);
  const text = await screen(page).innerText();
  const all = [...text.matchAll(new RegExp(found, 'g'))];
  return Number(all[all.length - 1]![1]);
}

test.describe('The agent terminal', () => {
  let seed: MyAgentsSeed;
  test.beforeEach(async () => {
    seed = await seedMyAgents(Date.now().toString(36));
  });

  test('open a hibernated agent into a live shell, sign in, and find the sign-in kept after it hibernates', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6861');
    // Wide enough that the list stays beside the panel (two columns from 1024px of
    // content); the recording scales it into its 1280 × 720 frame.
    await page.setViewportSize(WIDE);
    await signIn(page, seed.email, seed.password);
    const firstId = await createAgent(page, seed, 'yue-claude');
    const secondId = await createAgent(page, seed, 'yue-second');
    await letIdleWindowPass(page, [firstId]);

    // Every terminal socket to the relay passes through here untouched; the
    // test keeps the latest so it can drop it (step 4).
    const sockets: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
    await page.routeWebSocket(/\/v1\/terminal$/, (ws) => {
      sockets.push({ page: ws, server: ws.connectToServer() });
    });

    await page.getByRole('link', { name: 'My agents' }).click();
    await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
    await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'hibernated');

    await chapter(
      'Open a hibernated agent — it wakes into a live shell, no second click',
      async () => {
        const wake = await holdRequest(page, '/wake');
        await rowOf(page, 'yue-claude').click();
        await wake.held;
        await expect(panelTitle(page)).toContainText('yue-claude');
        // The list is still there, beside the panel.
        await expect(cardOf(page, 'yue-claude')).toBeVisible();
        await expect(cardOf(page, 'yue-claude')).toHaveAttribute('aria-current', 'true');
        await expect(panel(page)).toContainText(copy.progress.waking);
        await beat();
        const woke = page.waitForResponse(
          (res) => res.request().method() === 'POST' && res.url().endsWith('/wake'),
        );
        await wake.release();
        expect((await woke).status()).toBe(200);
        await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
        await expect(screen(page)).toContainText('~/workspace$');
      },
    );

    await chapter('Not signed in — sign in with the coding agent’s own flow', async () => {
      await expect(signInLine(page)).toHaveAttribute('data-state', 'signed_out');
      await expect(signInLine(page)).toContainText('Not signed in');
      await beat();
      await panel(page).getByTestId('agent-terminal').click();
      await typeLine(page, 'claude');
      await expect(screen(page)).toContainText('Type /login to sign in');
      await typeLine(page, '/login');
      await expect(screen(page)).toContainText('claude.invalid/oauth/authorize');
      await expect(screen(page)).toContainText('Paste code here');
      await typeLine(page, 'e2e-pasted-code-4821');
      await expect(screen(page)).toContainText('Login successful.');
      // The server re-checks every 5 s while attached and pushes the change.
      await expect(signInLine(page)).toHaveAttribute('data-state', 'signed_in', {
        timeout: 20_000,
      });
      await expect(signInLine(page)).toHaveText('Signed in to Claude Code');
      await typeLine(page, '/exit');
      await expect(screen(page)).toContainText(/~\/workspace\$\s*$/);
    });

    await chapter(
      'Type a command and see its output; resize and see the terminal reflow',
      async () => {
        await typeLine(page, 'export PET=otter');
        await typeLine(page, 'echo MARK-$((20+22))');
        await expect(screen(page)).toContainText('MARK-42');
        const wide = await shellColumns(page, 'COLS');
        await page.setViewportSize({ width: 1180, height: WIDE.height });
        // The size tag is the terminal announcing its new size, after the resize
        // frame went to the server; what the shell reads next is the new width.
        await expect(panel(page).getByText(/^\d+ × \d+$/)).toBeVisible();
        // Below 1024px of content the list steps aside and the panel takes the
        // row, so the width changes — the shell sees whatever the terminal fit.
        const resized = await shellColumns(page, 'RESIZED');
        expect(resized).not.toBe(wide);
        await page.setViewportSize(WIDE);
        await expect(cardOf(page, 'yue-second')).toBeVisible();
      },
    );

    await chapter('Drop the connection — it reconnects to the same shell', async () => {
      const ticket = await holdRequest(page, '/terminal-ticket');
      const dropped = sockets[sockets.length - 1]!;
      await dropped.server.close();
      await dropped.page.close({ code: 4000, reason: 'the test dropped the connection' });
      await ticket.held;
      await expect(connWord(page)).toHaveText(copy.panel.conn.reconnecting);
      await expect(panel(page).getByText(copy.panel.strip.reconnecting)).toBeVisible();
      await beat();
      await ticket.release();
      await expect(connWord(page)).toHaveText(copy.panel.conn.live);
      await panel(page).getByTestId('agent-terminal').click();
      await typeLine(page, 'echo PET-is-$PET');
      // The variable set before the drop: the same shell, not a new one.
      await expect(screen(page)).toContainText('PET-is-otter');
    });

    await chapter('Open the second agent — and a reload reopens it from the address', async () => {
      await cardOf(page, 'yue-second').click();
      await expect(panelTitle(page)).toContainText('yue-second');
      await expect(page).toHaveURL(new RegExp(`[?&]agent=${secondId}`));
      await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
      await expect(screen(page)).toContainText('~/workspace$');
      await beat();
      await page.reload();
      await expect(panelTitle(page)).toContainText('yue-second');
      await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
    });

    await chapter('Close the panel — thirty quiet minutes later it hibernates', async () => {
      await panel(page).getByRole('button', { name: 'Close yue-second' }).click();
      await expect(panel(page)).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]agent=/);
      await letIdleWindowPass(page, [firstId, secondId]);
      // The reload's server-rendered read follows the idle door's own response.
      await page.reload();
      for (const name of ['yue-claude', 'yue-second']) {
        await expect(rowOf(page, name)).toHaveAttribute('data-state', 'hibernated');
      }
    });

    await chapter('Reopen it — a fresh machine, and it is still signed in', async () => {
      const wake = await holdRequest(page, '/wake');
      await rowOf(page, 'yue-claude').click();
      await wake.held;
      await expect(panel(page)).toContainText(copy.progress.waking);
      const woke = page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().endsWith('/wake'),
      );
      await wake.release();
      expect((await woke).status()).toBe(200);
      await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
      await expect(screen(page)).toContainText('~/workspace$');
      // The first sign-in frame of the new machine's server: the credential file
      // on the agent's home survived the hibernation.
      await expect(signInLine(page)).toHaveAttribute('data-state', 'signed_in');
      await expect(signInLine(page)).toHaveText('Signed in to Claude Code');
      await panel(page).getByTestId('agent-terminal').click();
      await typeLine(page, 'echo PET-is-${PET:-gone}');
      // …and it IS a fresh machine: the old shell's variable went with it.
      await expect(screen(page)).toContainText('PET-is-gone');
    });
  });

  test('refusals: another member, a failed agent, an agent without a terminal', async ({
    page,
    browser,
  }) => {
    await signIn(page, seed.email, seed.password);
    const ownId = await createAgent(page, seed, 'yue-claude');
    const base = {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      ownerId: seed.userId,
      profileId: 'claude',
      imageTag: 'ghcr.io/motir-co/motir-sandbox:claude',
      imageDigest: 'sha256:seed',
      region: 'iad',
    };
    const failed = await adminDb.agentInstance.create({
      data: {
        ...base,
        name: 'yue-failed',
        state: 'failed',
        failureReason: 'no capacity in the region',
      },
    });
    const oldImage = await adminDb.agentInstance.create({
      data: {
        ...base,
        name: 'yue-old-image',
        state: 'running',
        terminalServer: 'absent',
        terminalServerDigest: 'sha256:seed',
      },
    });

    // A failed agent shows its reason and the way out.
    await page.goto(`/my-agents?agent=${failed.id}`);
    await expect(panelTitle(page)).toContainText('yue-failed');
    await expect(panel(page)).toContainText('no capacity in the region');
    await expect(panel(page)).toContainText(copy.failedWayOut);
    await expect(panel(page).getByRole('button', { name: copy.panel.wake })).toBeVisible();

    // An agent from before the terminal says so, in the design's words. This
    // receipt was recorded before an update could be offered (MOTIR-6862), so the
    // catalog is held at "could not check" here: with no newer image on offer, the
    // face reads as it did. The offered-update face is the update story's receipt.
    setCatalogUnavailable(true);
    try {
      await page.goto(`/my-agents?agent=${oldImage.id}`);
      await expect(panelTitle(page)).toContainText('yue-old-image');
      await expect(panel(page)).toContainText(copy.panel.noTerminal.title);
      await expect(panel(page)).toContainText(copy.panel.noTerminal.body);
      await expect(connWord(page)).toHaveText(copy.panel.conn.unavailable);
    } finally {
      resetCatalog();
    }

    // Another MEMBER of the same project — who holds `instance:use` — opening the
    // first member's agent address sees the refusal, never the agent…
    const tag = Date.now().toString(36);
    const other = await createTestPerson({
      email: `agents-other-${tag}@example.com`,
      password: seed.password,
      name: 'Otto Other',
    });
    await db.workspaceMembership.create({
      data: {
        workspaceId: seed.workspaceId,
        userId: other.id,
        workspaceRole: 'member',
        activeProjectId: seed.projectId,
      },
    });
    const context = await browser.newContext();
    try {
      const otherPage = await context.newPage();
      await signIn(otherPage, other.email, seed.password);
      await otherPage.goto(`/my-agents?agent=${ownId}`);
      await expect(panel(otherPage)).toContainText(copy.panel.unavailable.title);
      await expect(panel(otherPage)).not.toContainText('yue-claude');
      await expect(panel(otherPage).getByTestId('agent-terminal')).toHaveCount(0);
      // …and the SERVER refuses them a terminal, whatever the page shows.
      const refused = await api(
        otherPage,
        'POST',
        `/api/projects/${seed.projectIdentifier}/instances/${ownId}/terminal-ticket`,
      );
      expect(refused.status).toBe(403);
      expect((refused.json as { code: string }).code).toBe('not_owner');
    } finally {
      await context.close();
    }
  });
});
