import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page, Request } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn } from './_helpers/shell-session';
import { seedMyAgents, type MyAgentsSeed } from './_helpers/my-agents-seed';
import en from '@/messages/en.json';

// CHAT WITH YOUR AGENT (Story MOTIR-6863 · MOTIR-7019) — the story's recipe in a
// browser and, for the happy path, its acceptance receipt: open a hibernated
// Claude Code agent on its Chat tab and watch it wake into an empty chat, ask it
// something and watch the reply and its tool call stream in, follow up on the
// same session, stop a long answer, come back to the session from the list, chat
// with Codex, and see the three agents that cannot chat say why — Aider, a Claude
// subscription, and (un-paced, in the second test) an agent that is not signed
// in and one on an image from before the chat.
//
// ── THE SEAMS ────────────────────────────────────────────────────────────────
// Everything between the browser and the vendor binary is REAL: the ticket
// route, the relay's chat channel (`scripts/relay.ts`, its production bundle),
// `packages/cli`'s chat server and turn runner, and the Claude Code and Codex
// ADAPTERS. Only the binaries are stubs — `_helpers/agent-terminal/bin/claude`
// and `bin/codex`, which replay the adapters' own recorded streams at a human
// pace, keep Claude Code's session store as the binary does, answer only the
// invocations `docs/decisions/agent-chat.md` records, and never reach a vendor.
//   - WHICH SIGN-IN `claude auth status` reports is the agent's own environment,
//     seeded per agent through the host's setup sidecar: `yue-claude` carries an
//     API-key sign-in, `yue-claude-sub` does not (Q2).
//   - WHAT THE STUBS RECEIVED — every argv, prompt and signal — is recorded per
//     agent, and read back here: the `--resume <id>` of a follow-up, the SIGINT
//     of a Stop, and the `-p` a subscription never gets.
//
// ── WAITS ────────────────────────────────────────────────────────────────────
// On the Chat tab's own state: the connection word, the empty face, the caret a
// streaming reply carries, a tool row's `data-kind` and `aria-expanded`, the
// end-of-turn marker's `data-reason`, the session rows, the disabled tab's
// `aria-disabled`, the relay's close code on the socket. The one short-lived
// state — the wake — is HELD at the browser until it has been seen.

test.describe.configure({ timeout: 240_000 });

const copy = en.myAgents;
const chatCopy = copy.panel.chat;
const TYPE_DELAY_MS = 15;
const WIDE = { width: 1440, height: 810 };

const HOMES = process.env['MOTIR_E2E_AGENT_HOMES']!;
const SETUP_PATH = process.env['MOTIR_E2E_AGENT_SETUP_PATH']!;

const FIRST_PROMPT = 'list the top-level folders in this repo and say what each is for';
/** The shell's prompt: `\\w\\$ ` — `$`, or `#` for a root runner. */
const PROMPT = /~\/workspace[$#]/;
const OLDER_SESSION = '7d0e3b52-91a4-4c6e-8f2d-0b6a93c1e5f7';
const STUB_FIXTURES = path.join(__dirname, '_helpers', 'agent-terminal', 'fixtures');

// ── Locators ─────────────────────────────────────────────────────────────────

/** The panel, scoped to the LIVE subtree (`main`). */
const panel = (page: Page): Locator => page.getByRole('main').getByTestId('agent-panel');
const connWord = (page: Page): Locator => panel(page).getByTestId('agent-conn');
const panelTitle = (page: Page): Locator => panel(page).getByRole('heading', { level: 2 });
const tabButton = (page: Page, name: 'Terminal' | 'Chat'): Locator =>
  panel(page)
    .getByRole('navigation', { name: copy.panel.tabs.label })
    .getByRole('button', { name, exact: true });
const chatTab = (page: Page): Locator => panel(page).getByTestId('agent-chat-tab');
const transcript = (page: Page): Locator => chatTab(page).getByTestId('chat-transcript');
const promptBox = (page: Page): Locator =>
  chatTab(page).getByRole('textbox', { name: chatCopy.prompt.label });
/**
 * The LATEST of the prompt and end-of-turn rows, in document order. The transcript
 * WINDOWS its rows (only the ones near the viewport are in the DOM), so a count of
 * turn ends says nothing; but pinned to the latest event, the rendered range is
 * contiguous and reaches the bottom, so once the newest turn has ended its marker
 * is the last of these — and until then its prompt is.
 */
const latestMarker = (page: Page): Locator =>
  transcript(page).locator(
    'xpath=(.//*[@data-testid="chat-user" or @data-testid="chat-turn-end"])[last()]',
  );

/** The newest turn has ended, for this reason. */
async function expectTurnEnded(page: Page, reason: 'completed' | 'stopped'): Promise<void> {
  await expect(latestMarker(page)).toHaveAttribute('data-testid', 'chat-turn-end');
  await expect(latestMarker(page)).toHaveAttribute('data-reason', reason);
}

/**
 * Back to the latest event after an interaction that scrolled the transcript up
 * (opening a row scrolls it into view). The scroll position is read from the
 * scroller itself; when it is not at the bottom the tab offers Jump to latest.
 */
async function backToLatest(page: Page): Promise<void> {
  const scrolledUp = await transcript(page).evaluate(
    (el) => el.scrollHeight - el.scrollTop - el.clientHeight > 48,
  );
  if (!scrolledUp) return;
  const jump = chatTab(page).getByRole('button', { name: copy.panel.jumpLatest });
  await jump.click();
  await expect(jump).toHaveCount(0);
}
const toolRows = (page: Page): Locator => transcript(page).getByTestId('chat-tool-row');
const screen = (page: Page): Locator =>
  panel(page).getByTestId('agent-terminal').locator('.xterm-rows');
/** A list row by its agent name, not a longer one it prefixes (`yue-claude` / `yue-claude-sub`). */
const exactName = (name: string): RegExp => new RegExp(`${name}(?!-)`);
const rowOf = (page: Page, name: string): Locator =>
  page
    .getByRole('table')
    .getByTestId('agent-row')
    .filter({ hasText: exactName(name) });
const cardOf = (page: Page, name: string): Locator =>
  page
    .getByRole('main')
    .getByTestId('agent-list-column')
    .locator('li')
    .filter({ hasText: exactName(name) });

// ── The machine side ─────────────────────────────────────────────────────────

interface AgentSetup {
  env?: Record<string, string>;
  files?: Array<{ path: string; content: string; mtime?: string }>;
  chatServer?: boolean;
}

/** Seed what an agent's machine boots with (host.ts reads it on every boot). */
function setUpAgent(id: string, setup: AgentSetup): void {
  let all: Record<string, AgentSetup> = {};
  try {
    all = JSON.parse(readFileSync(SETUP_PATH, 'utf8')) as Record<string, AgentSetup>;
  } catch {
    // first agent of the run
  }
  all[id] = setup;
  mkdirSync(path.dirname(SETUP_PATH), { recursive: true });
  writeFileSync(SETUP_PATH, JSON.stringify(all));
}

/** Claude Code's project directory for the agent's `~/workspace`, relative to its home. */
function claudeProjectDir(id: string): string {
  const cwd = path.join(HOMES, id, 'workspace');
  return path.join(
    '.motir-sandbox/agent-config/.claude/projects',
    cwd.replace(/[^A-Za-z0-9]/g, '-'),
  );
}

interface StubCall {
  cli: string;
  pid: number;
  args?: string[];
  prompt?: string;
  signal?: string;
  refused?: string;
}

/** Everything the stub CLIs received on one agent, in order. */
function stubCalls(id: string): StubCall[] {
  try {
    return readFileSync(path.join(HOMES, '.calls', `${id}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as StubCall);
  } catch {
    return [];
  }
}

const turnCalls = (id: string): StubCall[] =>
  stubCalls(id).filter((call) => call.args?.[0] === '-p' || call.args?.[0] === 'exec');

// ── The app side ─────────────────────────────────────────────────────────────

/** Call the app's API from the page, so the request carries every cookie the browser holds. */
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

async function createAgent(
  page: Page,
  seed: MyAgentsSeed,
  name: string,
  profileId: string,
): Promise<string> {
  const base = `/api/projects/${seed.projectIdentifier}/instances`;
  const res = await api(page, 'POST', base, { name, profileId });
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
}

/** Hold the NEXT browser request whose path ends with `suffix` until `release()`. */
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

/** Type a prompt at a readable speed and send it. */
async function ask(page: Page, prompt: string): Promise<void> {
  await promptBox(page).click();
  await page.keyboard.type(prompt, { delay: TYPE_DELAY_MS });
  await chatTab(page).getByRole('button', { name: chatCopy.send, exact: true }).click();
  await expect(transcript(page).getByTestId('chat-user').last()).toHaveText(prompt);
}

/**
 * Open an agent's Chat tab and wait for it to be live — from the list beside an
 * open panel, or from the table when no panel is open.
 */
async function openChat(page: Page, name: string): Promise<void> {
  const panelOpen = (await panel(page).count()) > 0;
  await (panelOpen ? cardOf(page, name) : rowOf(page, name)).click();
  await expect(panelTitle(page)).toContainText(name);
  await tabButton(page, 'Chat').click();
  await expect(tabButton(page, 'Chat')).toHaveAttribute('aria-current', 'page');
  await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
}

test.describe('Chat with your agent', () => {
  let seed: MyAgentsSeed;
  test.beforeEach(async () => {
    seed = await seedMyAgents(Date.now().toString(36));
  });

  test('chat with a Claude Code agent and a Codex one, stop a turn, resume a session, and see who cannot chat', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-6863');
    await page.setViewportSize(WIDE);
    await signIn(page, seed.email, seed.password);
    const claudeId = await createAgent(page, seed, 'yue-claude', 'claude');
    const codexId = await createAgent(page, seed, 'yue-codex', 'codex');
    const aiderId = await createAgent(page, seed, 'yue-aider', 'aider');
    const subId = await createAgent(page, seed, 'yue-claude-sub', 'claude');
    // yue-claude: an Anthropic API key in its own environment, and an older
    // session in its Claude Code store from the day before.
    setUpAgent(claudeId, {
      env: { MOTIR_E2E_CLAUDE_SIGNIN: 'api_key' },
      files: [
        {
          path: path.join(claudeProjectDir(claudeId), `${OLDER_SESSION}.jsonl`),
          content: readFileSync(
            path.join(STUB_FIXTURES, 'claude', 'store', `${OLDER_SESSION}.jsonl`),
            'utf8',
          ),
          mtime: '2026-09-29T09:00:00.000Z',
        },
      ],
    });
    // yue-codex: signed in through the terminal earlier (the credential FILE the
    // sign-in check stats; its content is a placeholder, never a credential).
    setUpAgent(codexId, {
      files: [{ path: '.motir-sandbox/agent-config/.codex/auth.json', content: '{"stub":"e2e"}' }],
    });
    // yue-claude-sub: signed in with a Claude subscription through the terminal —
    // the credential FILE the sign-in check stats (a placeholder), and no key in
    // its environment.
    setUpAgent(subId, {
      files: [
        {
          path: '.motir-sandbox/agent-config/.claude/.credentials.json',
          content: '{"stub":"e2e"}',
        },
      ],
    });
    setUpAgent(aiderId, {});
    await letIdleWindowPass(page, [claudeId]);

    await page.getByRole('link', { name: 'My agents' }).click();
    await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
    await expect(rowOf(page, 'yue-claude')).toHaveAttribute('data-state', 'hibernated');

    await chapter(
      'Open a hibernated agent and choose Chat — it wakes into an empty chat',
      async () => {
        const wake = await holdRequest(page, '/wake');
        await rowOf(page, 'yue-claude').click();
        await wake.held;
        await expect(panelTitle(page)).toContainText('yue-claude');
        await tabButton(page, 'Chat').click();
        await expect(page).toHaveURL(/[?&]tab=chat/);
        await expect(chatTab(page)).toContainText(copy.progress.waking);
        const woke = page.waitForResponse(
          (res) => res.request().method() === 'POST' && res.url().endsWith('/wake'),
        );
        await wake.release();
        expect((await woke).status()).toBe(200);
        await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
        await expect(chatTab(page).getByTestId('chat-empty')).toBeVisible();
        await expect(promptBox(page)).toBeEnabled();
      },
    );

    let sessionId = '';
    await chapter('Ask it something — the reply streams in; open its tool call', async () => {
      await ask(page, FIRST_PROMPT);
      // The command row arrives collapsed, and the reply streams word by word.
      const row = toolRows(page).first();
      await expect(row).toHaveAttribute('data-kind', 'command');
      await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
      await expect(transcript(page).getByTestId('chat-caret')).toBeVisible();
      await expectTurnEnded(page, 'completed');
      await expect(transcript(page).getByTestId('chat-text').last()).toContainText(
        'the database schema and its migrations',
      );
      const first = turnCalls(claudeId);
      expect(first).toHaveLength(1);
      expect(first[0]!.prompt).toBe(FIRST_PROMPT);
      const flag = first[0]!.args!.indexOf('--session-id');
      expect(flag).toBeGreaterThan(0);
      sessionId = first[0]!.args![flag + 1]!;
      // Open the tool call: its command and its output. Then close it again.
      await row.getByRole('button').click();
      await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
      await expect(row.getByRole('button')).toContainText('ls -d */');
      await expect(row.getByTestId('chat-tool-body')).toContainText('packages/');
      await beat();
      await row.getByRole('button').click();
      await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
      await expect(row.getByTestId('chat-tool-body')).toHaveCount(0);
      await backToLatest(page);
    });

    await chapter('Follow up — the same session is resumed', async () => {
      await ask(page, 'Which of those holds the database schema?');
      await expectTurnEnded(page, 'completed');
      await expect(transcript(page).getByTestId('chat-text').last()).toContainText(
        'prisma/schema.prisma',
      );
      // The second turn resumed the FIRST turn's session, by its id.
      const calls = turnCalls(claudeId);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args).toContain('--resume');
      expect(calls[1]!.args![calls[1]!.args!.indexOf('--resume') + 1]).toBe(sessionId);
    });

    await chapter('Stop a long answer mid-stream', async () => {
      await ask(page, 'Now walk me through lib/ in detail, folder by folder.');
      // Streaming: the caret is on the reply and the box offers Stop.
      await expect(transcript(page).getByTestId('chat-caret')).toBeVisible();
      await chatTab(page).getByRole('button', { name: chatCopy.stop, exact: true }).click();
      await expectTurnEnded(page, 'stopped');
      await expect(latestMarker(page)).toContainText(chatCopy.turn.stoppedWhy);
      await beat();
      // The runner's Stop reached the CLI as SIGINT (Q6), on the third turn.
      const calls = stubCalls(claudeId);
      const third = calls.filter((call) => call.args?.[0] === '-p')[2]!;
      expect(third.args![third.args!.indexOf('--resume') + 1]).toBe(sessionId);
      expect(calls).toContainEqual(expect.objectContaining({ pid: third.pid, signal: 'SIGINT' }));
      await expect(chatTab(page).getByRole('button', { name: chatCopy.send })).toBeVisible();
    });

    await chapter('Close it, come back, and pick the session up from the list', async () => {
      await panel(page).getByRole('button', { name: 'Close yue-claude', exact: true }).click();
      await expect(panel(page)).toHaveCount(0);
      await openChat(page, 'yue-claude');
      await expect(chatTab(page).getByTestId('chat-empty')).toBeVisible();
      await chatTab(page).getByRole('button', { name: chatCopy.sessions.label }).click();
      const list = page.getByRole('dialog', {
        name: chatCopy.sessions.title.replace('{name}', 'yue-claude'),
      });
      const rows = list.getByTestId('chat-session-row');
      // Newest first: this chat, then the older session from the day before.
      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText(FIRST_PROMPT);
      await expect(rows.nth(1)).toContainText('Tidy the README and list the files');
      await rows.nth(0).click();
      await expect(chatTab(page).getByText(chatCopy.resumed, { exact: true })).toBeVisible();
      // The earlier turns, read back from Claude Code's own store.
      // The earlier turns, read back from Claude Code's own store: the latest of
      // them is the stopped question, after the follow-up's answer.
      await expect(latestMarker(page)).toHaveText(
        'Now walk me through lib/ in detail, folder by folder.',
      );
      await expect(transcript(page).getByTestId('chat-text').last()).toContainText(
        'prisma/schema.prisma',
      );
      await ask(page, 'What have we covered so far?');
      await expect(transcript(page).getByTestId('chat-caret')).toBeVisible();
      await expectTurnEnded(page, 'completed');
      await expect(transcript(page).getByTestId('chat-text').last()).toContainText(
        'seven top-level folders',
      );
      const last = turnCalls(claudeId).at(-1)!;
      expect(last.args![last.args!.indexOf('--resume') + 1]).toBe(sessionId);
    });

    await chapter('Chat with Codex — a command and a file change', async () => {
      await openChat(page, 'yue-codex');
      await expect(chatTab(page).getByTestId('chat-empty')).toBeVisible();
      await ask(page, 'Count the entries in tests/ and note it in NOTES.md');
      await expectTurnEnded(page, 'completed');
      await expect(toolRows(page)).toHaveCount(2);
      await expect(toolRows(page).nth(0)).toHaveAttribute('data-kind', 'command');
      const edit = toolRows(page).nth(1);
      await expect(edit).toHaveAttribute('data-kind', 'edit');
      await expect(edit.getByRole('button')).toContainText('NOTES.md');
      await edit.getByRole('button').click();
      // Codex reports the path and the kind of change, not the change itself.
      await expect(edit.getByTestId('chat-tool-body')).toContainText(
        chatCopy.tool.noDiff.replace('{agent}', 'Codex'),
      );
      await beat();
      const calls = turnCalls(codexId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual([
        'exec',
        '--json',
        '-c',
        'sandbox_mode="workspace-write"',
        '-',
      ]);
    });

    await chapter('Aider cannot chat — its terminal still can', async () => {
      await cardOf(page, 'yue-aider').click();
      await expect(panelTitle(page)).toContainText('yue-aider');
      const disabled = panel(page).getByTestId('agent-chat-tab-disabled');
      await expect(disabled).toHaveAttribute('aria-disabled', 'true');
      // The terminal attaches first, so the panel has stopped re-rendering before
      // the pointer moves. The tip is CSS `group-hover`, and a re-render under a
      // resting pointer does not always re-apply :hover in headless Chromium,
      // so the hover is re-issued until the tip shows (it was red once in CI,
      // on 1b9a610, with the tip never drawn).
      await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
      await expect(screen(page)).toContainText(PROMPT);
      const tip = page.getByRole('tooltip', { name: chatCopy.unsupported });
      await expect(async () => {
        await page.mouse.move(0, 0);
        await disabled.hover();
        await expect(tip).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      await expect(chatTab(page)).toHaveCount(0);
    });

    await chapter(
      'Claude Code on a subscription — the chat says why, the terminal works',
      async () => {
        await openChat(page, 'yue-claude-sub');
        await expect(chatTab(page).getByTestId('chat-refusal')).toHaveText(
          chatCopy.subscription.body,
        );
        await expect(chatTab(page)).toContainText(chatCopy.subscription.title);
        await expect(promptBox(page)).toHaveCount(0);
        await beat();
        // The gate asked the CLI who is signed in, and never started a turn.
        const calls = stubCalls(subId);
        expect(calls.some((call) => call.args?.join(' ') === 'auth status --json')).toBe(true);
        expect(calls.filter((call) => call.args?.includes('-p'))).toEqual([]);
        await chatTab(page).getByRole('button', { name: chatCopy.openTerminal }).click();
        await expect(tabButton(page, 'Terminal')).toHaveAttribute('aria-current', 'page');
        await expect(connWord(page)).toHaveText(copy.panel.conn.live);
        await expect(screen(page)).toContainText(PROMPT);
      },
    );
  });

  test('an agent that is not signed in, and one on an image from before the chat', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await signIn(page, seed.email, seed.password);
    const signedOutId = await createAgent(page, seed, 'yue-codex-new', 'codex');
    const oldImageId = await createAgent(page, seed, 'yue-old-image', 'claude');
    // A Codex agent nobody has signed in yet: no credential file on its home.
    setUpAgent(signedOutId, {});
    // An image from before the chat: its server answers `/v1/chat` with 404.
    setUpAgent(oldImageId, { env: { MOTIR_E2E_CLAUDE_SIGNIN: 'api_key' }, chatServer: false });

    // Every chat socket passes through untouched; the test keeps the close codes
    // the relay sent the browser.
    const closes: number[] = [];
    await page.routeWebSocket(/\/v1\/chat$/, (ws) => {
      const server = ws.connectToServer();
      server.onClose((code, reason) => {
        if (code !== undefined) closes.push(code);
        void ws.close({ code, reason });
      });
    });

    // Not signed in: the tab says so and points at the Terminal — no error.
    await page.goto(`/my-agents?agent=${signedOutId}&tab=chat`);
    await expect(panelTitle(page)).toContainText('yue-codex-new');
    await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
    const notice = chatTab(page).getByTestId('chat-notice');
    await expect(notice).toContainText(chatCopy.notice.notSignedIn.replace('{agent}', 'Codex'));
    await expect(notice.getByRole('button', { name: chatCopy.openTerminal })).toBeVisible();
    await expect(transcript(page).getByTestId('chat-error')).toHaveCount(0);
    await expect(chatTab(page).getByTestId('chat-refusal')).toHaveCount(0);

    // An image from before the chat: the relay closes the chat 4411, and the tab
    // shows the no-chat-server face.
    await page.goto(`/my-agents?agent=${oldImageId}&tab=chat`);
    await expect(panelTitle(page)).toContainText('yue-old-image');
    await expect(chatTab(page)).toContainText(chatCopy.noServer.title);
    await expect(chatTab(page)).toContainText(chatCopy.noServer.body);
    await expect(connWord(page)).toHaveText(copy.panel.conn.unavailable);
    await expect.poll(() => closes).toContain(4411);
    // Its terminal is unaffected.
    await tabButton(page, 'Terminal').click();
    await expect(connWord(page)).toHaveText(copy.panel.conn.live, { timeout: 30_000 });
    await expect(screen(page)).toContainText(PROMPT);
  });
});
