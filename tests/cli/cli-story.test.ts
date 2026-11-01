import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';
import { runListReady } from '@/lib/mcp/tools/listReady';
import { runSearchWorkItems } from '@/lib/mcp/tools/searchWorkItems';
import { runGetWorkItem } from '@/lib/mcp/tools/getWorkItem';
import { runGetWorkItemActivity } from '@/lib/mcp/tools/getWorkItemActivity';
import { runListSprints } from '@/lib/mcp/tools/listSprints';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';
import { startMcpHttpServer, type McpTestServer } from '../helpers/mcpHttpServer';
import {
  installFakeGh,
  makeCliWorkspace,
  makeLocalRepo,
  readLinkFile,
  writeFakeAgent,
  type CliWorkspace,
  type FakeAgent,
  type FakeGh,
} from '../helpers/cliHarness';
import { randomToken } from '../helpers/random';
import { linkProjectRepo } from '../helpers/projectRepoLink';
import { grantForLegacyScopes } from '@/tests/helpers/tokenGrant';

// STORY-CLOSING suite for the Motir CLI (Story 7.9 · Subtask 7.9.5 · MOTIR-883).
//
// The per-subtask vitest under `packages/cli/test/**` covers each module in
// isolation, in-process, with the server client, the agent launcher and git all
// injected. Nothing there proves the ASSEMBLED tool works: that the tsup bundle
// `package.json#bin` points at boots, that it reaches the real routes over a
// real socket, that a status flip actually lands in Postgres as the token's
// owner, or that a `motir auto` run ends with one pull request and a `main`
// nobody advanced.
//
// ⚠️ THE TARGET MOVED (Story 11.5). This suite drove `/api/mcp` until the CLI
// stopped being an MCP client; every request below now lands on `/api/v1`
// (`v1Routes: true`, mounted by MOTIR-2379). The ASSERTIONS did not move with
// it, and that is the migration's central proof: not one expected line of
// human-readable output in this file changed. The only edits are three `--json`
// payload assertions, where ADR Amendment 16 deliberately changed the shape —
// `--json` now emits the v1 RESOURCE, which names an item by `key` rather than
// `identifier`. `cli-v1-story.test.ts` (11.5.8) holds what this suite does not:
// the harness's own dispatch, plus the scope-refused and rate-limited states.
//
// So this suite drives the BUILT BINARY as a CHILD PROCESS:
//
//   built `motir` binary  ──HTTP──▶  the real /api/v1 routes  ──▶  real Postgres
//          │                         (withV1Route + the real bearer/scope gate
//          │                          + the real rate limiter + real services)
//          ├─ spawns ──▶ a scripted FAKE AGENT (records its cwd, stdin and
//          │             $MOTIR_PROMPT_FILE; exits per fixture; never an LLM)
//          └─ shells ──▶ real `git` against real on-disk repos, and a fake `gh`
//                        that records what would have been opened
//
// No mocks anywhere in that chain (the repo's testing contract). The two fakes
// are the programs Motir deliberately does NOT own — the user's BYOK agent and
// `gh` — and both are recorded, not stubbed silent, so what the CLI asked them
// to do is itself asserted.
//
// Every command gets at least one happy path and one failure path here.

// Every test here spawns at least one child process (often several, plus real
// git), so the root lane's 15s default is too tight under a loaded CI shard —
// and a timeout there would read as a flaky CLI rather than a slow runner.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let server: McpTestServer;
let ws: CliWorkspace;

beforeAll(async () => {
  server = await startMcpHttpServer({ v1Routes: true });
});

afterAll(async () => {
  await server.close();
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  // A fresh workspace per test: `truncateAuthTables` deletes the tenant the
  // stored PAT belongs to, so a credential store carried across tests would hold
  // a token for a user that no longer exists.
  ws = makeCliWorkspace();
});

// ── fixtures ────────────────────────────────────────────────────────────────

interface LinkedProject {
  fx: WorkItemFixture;
  token: string;
  tokenId: string;
}

/** Mint a full-scope PAT for a fresh tenant — the CLI spans the whole read and
 *  write surface, so a narrower token would refuse tests that are not about
 *  scopes. What a NARROW one does is `cli-v1-story.test.ts`'s subject on the v1
 *  side, and `tests/mcp/story-roundtrip`'s on the server's. */
async function mintToken(
  fx: WorkItemFixture,
  label = 'cli',
): Promise<{ token: string; id: string }> {
  const { token, dto } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: grantForLegacyScopes([...TOKEN_SCOPES]),
  });
  return { token, id: dto.id };
}

/** A tenant the CLI is logged in to and linked against — the starting state of
 *  almost every test below. */
async function linkedProject(): Promise<LinkedProject> {
  const fx = await makeWorkItemFixture();
  const { token, id } = await mintToken(fx);
  const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);
  expect(login.exitCode).toBe(0);
  const link = await ws.run(['link', '--project', fx.projectIdentifier]);
  expect(link.exitCode).toBe(0);
  return { fx, token, tokenId: id };
}

/** Connect a repo to the workspace — the single registry a `targetRepo` pin
 *  validates against (the 7.10.3 installation mirror). */
/**
 * Connect one repository to the fixture's workspace.
 *
 * ⚠️ `provider` is a parameter because a repository Motir CANNOT DERIVE A CLONE
 * URL FOR is a distinct, load-bearing fixture (MOTIR-3588). Since a dispatch now
 * CLONES a missing checkout whose payload carries a URL, the only way to reach
 * the preserved `bootstrap_root` path — the genuine empty-folder case, where the
 * card's own work is to create the repository — is a name Motir knows without
 * knowing where it lives. `repoCloneUrl` returns null for a provider this build
 * cannot address (`lib/repos/cloneUrl.ts`), and the pin still validates because
 * an un-addressable repository stays IN the dispatch domain rather than being
 * filtered out of it (`lib/workItems/targetRepo.ts`).
 */
async function connectRepo(
  fx: WorkItemFixture,
  name: string,
  opts: { provider?: string } = {},
): Promise<void> {
  const provider = opts.provider ?? 'github';
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}-${provider}` },
    create: {
      installationId: `inst-${fx.workspaceId}-${provider}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider,
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `repo-${name}-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      archived: false,
      provider,
    },
  });
  await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: repo.id,
    name,
  });
}

interface LeafOptions {
  targetRepo?: string;
  type?: 'code' | 'manual';
  executor?: 'coding_agent' | 'human';
  descriptionMd?: string;
  /** Born already in a sprint (the create-into-sprint path) — what `motir
   *  sprint`'s fixtures need. */
  sprintId?: string;
}

/** A ready (todo, unblocked, childless) leaf. */
async function leaf(
  fx: WorkItemFixture,
  title: string,
  opts: LeafOptions = {},
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, ...opts },
    fx.ctx,
  );
}

/** A story — the parent whose CHILDREN `motir show` lays out in build waves. */
async function story(fx: WorkItemFixture, title: string): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'story', title }, fx.ctx);
}

/** A subtask under `parentId` — a sibling in that story's own dependency DAG. */
async function child(
  fx: WorkItemFixture,
  parentId: string,
  title: string,
  opts: LeafOptions = {},
): Promise<WorkItemDto> {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title, parentId, ...opts },
    fx.ctx,
  );
}

/** `from` is_blocked_by `to`. */
async function block(fx: WorkItemFixture, fromId: string, toId: string): Promise<void> {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'is_blocked_by' }, fx.ctx);
}

/** `from` relates_to `to` (the service persists the reciprocal row too). */
async function relate(fx: WorkItemFixture, fromId: string, toId: string): Promise<void> {
  await workItemsService.linkWorkItems({ fromId, toId, kind: 'relates_to' }, fx.ctx);
}

/** Walk an item to `done` through the LEGAL hops — there is no direct
 *  `todo → done` edge in the default workflow, so a satisfied blocker has to be
 *  driven the way the product drives one. */
async function markDone(fx: WorkItemFixture, id: string): Promise<void> {
  for (const status of ['in_progress', 'in_review', 'done']) {
    await workItemsService.updateStatus(id, status, fx.ctx);
  }
}

/** A planned sprint. */
async function sprint(fx: WorkItemFixture, name: string): Promise<SprintDto> {
  return sprintsService.createSprint(fx.projectId, { name }, fx.ctx);
}

// ── reading a rendered table back ───────────────────────────────────────────

/**
 * Parse one `formatTable` block out of CLI output, by COLUMN OFFSET rather than
 * by splitting on whitespace.
 *
 * The offsets come from the `───` underline, which is the only thing that
 * survives an EMPTY cell: `BLOCKED BY` is blank on every unblocked row, and a
 * `/\s{2,}/` split silently merges the columns either side of it — turning a
 * six-column row into five and quietly mis-reading every assertion below it.
 */
interface ParsedTable {
  headers: string[];
  rows: Record<string, string>[];
}

function tableAfter(output: string, heading: RegExp): ParsedTable {
  const lines = output.split('\n');
  const at = lines.findIndex((line) => heading.test(line));
  if (at === -1) throw new Error(`No line matching ${heading} in:\n${output}`);

  let cursor = at + 1;
  while (cursor < lines.length && lines[cursor]?.trim() === '') cursor += 1;
  const headerLine = lines[cursor] ?? '';
  const underline = lines[cursor + 1] ?? '';
  if (underline.trim() === '' || !/^[─ ]+$/.test(underline)) {
    throw new Error(`Expected a table under ${heading}, got:\n${headerLine}\n${underline}`);
  }

  const spans: [number, number][] = [];
  for (const match of underline.matchAll(/─+/g)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  const cut = (line: string): string[] => spans.map(([s, e]) => line.slice(s, e).trim());

  const headers = cut(headerLine);
  const rows: Record<string, string>[] = [];
  for (let r = cursor + 2; r < lines.length; r += 1) {
    const line = lines[r] ?? '';
    // A blank line ends the table; so does the mark LEGEND / the cycle warning,
    // which `withLegend` appends with no separating blank line.
    if (line.trim() === '' || /^[✓↗⚠]/.test(line.trimStart())) break;
    const cells = cut(line);
    rows.push(Object.fromEntries(headers.map((h, c) => [h, cells[c] ?? ''])));
  }
  return { headers, rows };
}

/** One row of a parsed table, by its KEY cell. */
function rowFor(table: ParsedTable, key: string): Record<string, string> {
  const row = table.rows.find((r) => r['KEY'] === key);
  if (!row) throw new Error(`No row for ${key} in ${JSON.stringify(table.rows)}`);
  return row;
}

/** The `structuredContent` of a tool call, as the CLI receives it over the
 *  wire — the value every edge assertion below is compared AGAINST, so a key
 *  renamed on either side of the seam fails here. */
function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

interface EdgeSummary {
  key: string;
  title: string;
  status: string;
}
interface EdgeBlock {
  blockedBy: EdgeSummary[];
  blocks: EdgeSummary[];
}

/**
 * The `search_work_items` envelope that selects ONE sprint's items.
 *
 * Spelled out here rather than imported from `packages/cli/src/render.ts` on
 * purpose: this suite drives the BUILT binary, so importing the CLI's own
 * source to build the expectation would let a wrong envelope agree with itself.
 * (It is also the grammar the /items URL and saved filters use, which is why
 * `motir sprint` can never disagree with the web app about sprint membership.)
 */
function sprintItemsFilter(sprintId: string) {
  return {
    version: 'v1',
    combinator: 'and' as const,
    conditions: [{ field: 'sprint', operator: 'is_any_of' as const, value: [sprintId] }],
  };
}

/** Re-read an item's authoritative state (status + recorded session branch). */
async function stateOf(fx: WorkItemFixture, id: string): Promise<WorkItemDto> {
  return workItemsService.getWorkItem(id, fx.ctx);
}

/** A workspace wired for a session-branch run: a real repo checkout with a real
 *  on-disk origin, a fake `gh`, and a scripted agent. */
function repoRun(name: string): {
  repo: ReturnType<typeof makeLocalRepo>;
  gh: FakeGh;
  agent: FakeAgent;
} {
  return {
    repo: makeLocalRepo(ws.root, name),
    gh: installFakeGh(ws.binDir),
    agent: writeFakeAgent(join(ws.root, '.agent')),
  };
}

// ── auth + linking ──────────────────────────────────────────────────────────

describe('auth + linking', () => {
  it('stores a valid PAT and reports the owner; `auth status` reads it back live', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await mintToken(fx);

    const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);
    expect(login.exitCode).toBe(0);
    expect(login.output).toContain(fx.owner.email);

    const status = await ws.run(['auth', 'status', '--server', server.url]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(fx.owner.email);
    expect(status.stdout).toContain(fx.workspace.name);
    // The stored secret is never echoed back in full.
    expect(status.stdout).not.toContain(token);
  });

  it('rejects an INVALID token at login and stores nothing', async () => {
    const login = await ws.run(['auth', 'login', '--server', server.url, '--token', 'not-a-token']);

    expect(login.exitCode).toBe(1);
    expect(login.stderr).toContain('Run `motir auth login`');

    const status = await ws.run(['auth', 'status', '--server', server.url]);
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain('Not logged in');
  });

  it('rejects a REVOKED token — the same uniform auth failure as an invalid one', async () => {
    const fx = await makeWorkItemFixture();
    const { token, id } = await mintToken(fx);
    await apiTokensService.deleteToken(fx.ownerId, id);

    const login = await ws.run(['auth', 'login', '--server', server.url, '--token', token]);

    expect(login.exitCode).toBe(1);
    expect(login.stderr).toContain('Run `motir auth login`');
  });

  it('errors with guidance when a command runs outside any linked folder', async () => {
    const fx = await makeWorkItemFixture();
    const { token } = await mintToken(fx);
    await ws.run(['auth', 'login', '--server', server.url, '--token', token]);

    for (const command of [['ready'], ['status'], ['next', '--print'], ['open', 'PROD-1']]) {
      const result = await ws.run(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No Motir project link found');
      expect(result.stderr).toContain('Run `motir link`');
    }
  });

  it('runs the WHOLE read surface on MOTIR_TOKEN alone, with no config file (MOTIR-1876)', async () => {
    // The CI / container / fresh-box shape, through the REAL binary: no `auth
    // login` ever runs, the config home does not exist, and the entire
    // configuration is two env vars. Before the ladder, `MOTIR_TOKEN` was read at
    // login only, so this machine had no route in at all — which is why the
    // sandbox had to bind-mount a host-minted credential.
    const fx = await makeWorkItemFixture();
    const { token } = await mintToken(fx);
    const item = await leaf(fx, 'Reachable on the env credential');
    const noConfig = ws.path('never-created-config-home');
    const env = {
      MOTIR_CONFIG_HOME: noConfig,
      MOTIR_TOKEN: token,
      MOTIR_SERVER: server.url,
    };

    // `link` first — it is itself a consumer of the ladder, and it writes the
    // (secret-free) project binding the read commands need.
    const link = await ws.run(['link', '--project', fx.projectIdentifier], { env });
    expect(link.exitCode).toBe(0);

    for (const command of [['ready'], ['status'], ['open', item.identifier]]) {
      const result = await ws.run(command, { env });
      expect(result.exitCode, `${command.join(' ')}: ${result.stderr}`).toBe(0);
    }

    // `doctor` reports the credential as present and NAMES the tier it came from.
    const doctor = await ws.run(['doctor', '--json'], { env });
    const report = JSON.parse(doctor.stdout) as {
      checks: { id: string; status: string; detail?: string }[];
    };
    const auth = report.checks.find((c) => c.id === 'auth');
    expect(auth?.status).toBe('pass');
    expect(auth?.detail).toContain('via environment (MOTIR_TOKEN)');
    expect(doctor.stdout).not.toContain(token);

    // Nothing was persisted anywhere — the property the read-only sandbox mount
    // depends on, asserted by absence so it holds regardless of uid.
    expect(existsSync(noConfig)).toBe(false);
  });

  it('resolves `.motir.json` by walking UP from a subdirectory', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'Visible from anywhere');
    const deep = ws.path('motir-core', 'lib', 'services');
    mkdirSync(deep, { recursive: true });

    const ready = await ws.run(['ready', '--json'], { cwd: deep });

    expect(ready.exitCode).toBe(0);
    expect(JSON.parse(ready.stdout)).toHaveLength(1);
  });
});

// ── read parity ─────────────────────────────────────────────────────────────

describe('read parity — the CLI never disagrees with the app about "ready"', () => {
  it('`motir ready --json` ≡ the list_ready tool ≡ the /ready set for the same user', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'Alpha');
    await leaf(fx, 'Beta');
    const blocked = await leaf(fx, 'Gamma (blocked)');
    const blocker = await leaf(fx, 'Delta (the blocker)');
    await block(fx, blocked.id, blocker.id);

    const cli = await ws.run(['ready', '--json']);
    const cliKeys = (JSON.parse(cli.stdout) as { key: string }[]).map((i) => i.key);

    // The set `GET /api/ready` renders: that route is a thin caller of exactly
    // this service method (app/api/ready/route.ts), so this IS the page's set.
    const page = await workItemsService.listReady(fx.projectId, {}, fx.ctx);

    expect(cli.exitCode).toBe(0);
    expect(cliKeys).toEqual(page.items.map((i) => i.key));
    // …and the blocked item is in neither.
    expect(cliKeys).not.toContain(blocked.identifier);
    expect(cliKeys).toContain(blocker.identifier);
  });

  it('`motir status` reports the pulse, and refuses an unknown project', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'One');

    const pulse = await ws.run(['status', '--json']);
    expect(pulse.exitCode).toBe(0);
    expect(JSON.parse(pulse.stdout)).toMatchObject({
      projectKey: fx.projectIdentifier,
      readyCount: 1,
    });

    // A link pointing at a project this token cannot see fails at link time —
    // the CLI never writes a binding it has not proven.
    const bad = await ws.run(['link', '--project', 'NOPE']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('not accessible');
  });
});

// ── motir show — the item DETAIL read (7.9.13) ──────────────────────────────

describe('motir show — the detail read against a real tree', () => {
  it('renders the header, readiness, lineage and all three edge groups from ONE real read', async () => {
    const { fx } = await linkedProject();
    const parent = await story(fx, 'The terminal read surface');
    const target = await child(fx, parent.id, 'Wire the detail read', {
      descriptionMd: '## Why\n\nBecause the terminal should show a plan.\n',
    });
    const blocker = await child(fx, parent.id, 'Ship the aggregate');
    const dependent = await child(fx, parent.id, 'Document the read');
    const cousin = await leaf(fx, 'An unrelated note');
    await block(fx, target.id, blocker.id);
    await block(fx, dependent.id, target.id);
    await relate(fx, target.id, cousin.id);

    const show = await ws.run(['show', target.identifier]);
    expect(show.exitCode).toBe(0);

    // The tool's OWN payload — every edge assertion below reads its expected
    // value out of this, never out of a hardcoded string, so a key renamed in
    // the DTO or in the CLI's mirror fails HERE rather than rendering blank.
    const detail = structured<{
      item: { identifier: string; title: string; kind: string };
      readiness: { ready: boolean; openBlockers: { identifier: string }[] };
      ancestors: { identifier: string }[];
      blockedBy: { item: { identifier: string } }[];
      blocks: { item: { identifier: string } }[];
      relatesTo: { item: { identifier: string } }[];
    }>(await runGetWorkItem({ key: target.identifier }, fx.ctx));

    expect(show.stdout).toContain(detail.item.identifier);
    expect(show.stdout).toContain(detail.item.title);
    expect(show.stdout).toContain(detail.item.kind);

    // READINESS — the SERVER's verdict, rendered, not re-derived by the CLI.
    expect(detail.readiness.ready).toBe(false);
    const readiness = show.stdout.split('READINESS\n')[1]?.split('\n')[0] ?? '';
    for (const b of detail.readiness.openBlockers) expect(readiness).toContain(b.identifier);

    // LINEAGE — root → self.
    const lineage = show.stdout.split('LINEAGE\n')[1]?.split('\n')[0] ?? '';
    expect(lineage).toBe(
      [...detail.ancestors.map((a) => a.identifier), target.identifier].join(' › '),
    );

    // The three edge groups, each against the tool's own list.
    const section = (name: string): string =>
      show.stdout.split(`${name} (`)[1]?.split('\n\n')[0] ?? '';
    expect(detail.blockedBy.map((l) => l.item.identifier)).toEqual([blocker.identifier]);
    expect(detail.blocks.map((l) => l.item.identifier)).toEqual([dependent.identifier]);
    expect(detail.relatesTo.map((l) => l.item.identifier)).toEqual([cousin.identifier]);
    for (const [name, links] of [
      ['BLOCKED BY', detail.blockedBy],
      ['BLOCKS', detail.blocks],
      ['RELATES TO', detail.relatesTo],
    ] as const) {
      const body = section(name);
      expect(body).not.toBe('');
      for (const link of links) expect(body).toContain(link.item.identifier);
    }

    // The CHILDREN table belongs to the PARENT, so the leaf reports none —
    // and reports it as the empty line, not an empty table.
    expect(show.stdout).toContain('CHILDREN (0)\nno children');
    // The raw Markdown body is printed verbatim: it is what a human pastes
    // into an agent, not something the terminal reformats.
    expect(show.stdout).toContain('## Why');
  });

  it('fails an unknown key and a key in ANOTHER tenant the SAME way (404-not-403)', async () => {
    const { fx } = await linkedProject();
    await leaf(fx, 'Something this tenant can see');

    // A well-formed key that does not exist in a project this token CAN read.
    const unknown = await ws.run(['show', `${fx.projectIdentifier}-9999`]);
    expect(unknown.exitCode).toBe(1);

    // A real item, in a project this token cannot see at all.
    const other = await makeWorkItemFixture({ name: 'Other Co', identifier: 'OTHR' });
    const hidden = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Their secret roadmap item' },
      other.ctx,
    );
    const foreign = await ws.run(['show', hidden.identifier]);

    expect(foreign.exitCode).toBe(1);
    // The existence contract: a cross-tenant key reads as NOT FOUND, never as
    // "forbidden" — a 403 would confirm the item exists — and never leaks the
    // title.
    expect(foreign.stderr.toLowerCase()).not.toContain('forbidden');
    expect(foreign.stderr.toLowerCase()).not.toContain('permission');
    expect(foreign.output).not.toContain('Their secret roadmap item');

    // A malformed key never reaches the server at all.
    const malformed = await ws.run(['show', 'not-a-key']);
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain('is not a work item key');
  });
});

// ── motir show --activity / --comments — the DISCUSSION (MOTIR-2000) ────────
//
// The consumer half of `get_work_item_activity` (MOTIR-1999), driven the way the
// rest of this suite drives things: real comments and real revisions in real
// Postgres, read back through the real tool by the BUILT binary. What is
// asserted against is the tool's own page, never a hardcoded string — so a key
// renamed on either side of the seam fails here rather than rendering blank.

describe('motir show --activity / --comments — the discussion, from a real tenant', () => {
  /** A card with a threaded conversation AND a real change trail on it. */
  async function argumentativeItem(fx: WorkItemFixture): Promise<WorkItemDto> {
    const item = await leaf(fx, 'A card people argued about');
    const root = await commentsService.addComment(
      item.id,
      { bodyMd: '## Rationale\n\nArchived because the surface moved.\n\nA second paragraph.' },
      fx.ctx,
    );
    await commentsService.addComment(
      item.id,
      { bodyMd: 'Agreed — the mirror product does the same.', parentCommentId: root.id },
      fx.ctx,
    );
    // A real revision, so the merged view has both row kinds to interleave.
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    return item;
  }

  it('appends the stream ONLY when asked, and prints what the tool returned', async () => {
    const { fx } = await linkedProject();
    const item = await argumentativeItem(fx);

    // NEITHER flag: the read is exactly what it was before this card existed.
    const plain = await ws.run(['show', item.identifier]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).not.toContain('ACTIVITY');
    expect(plain.stdout).not.toContain('COMMENTS');

    const shown = await ws.run(['show', item.identifier, '--activity']);
    expect(shown.exitCode, shown.stderr).toBe(0);
    // The flag only ADDS: the detail block is byte-identical to the flagless read.
    expect(shown.stdout.startsWith(plain.stdout)).toBe(true);

    const page = structured<{
      entries: (
        | { type: 'comment'; thread: { bodyMd: string; replies: { bodyMd: string }[] } }
        | { type: 'history'; entry: { parts: { kind: string }[] } }
      )[];
      totalComments: number;
      totalChanges: number;
      nextCursor: string | null;
    }>(await runGetWorkItemActivity({ key: item.identifier }, fx.ctx));

    // Both counts come from the tool's own totals — the root AND its reply.
    expect(page.totalComments).toBe(2);
    expect(shown.stdout).toContain(`ACTIVITY\n${page.totalComments} comments`);
    expect(shown.stdout).toContain(`${page.totalChanges} changes`);

    // Every comment body, IN FULL — the no-truncation rule this whole read
    // exists to honour (a cut-off rationale is worse than one you know to page).
    for (const entry of page.entries) {
      if (entry.type !== 'comment') continue;
      for (const line of entry.thread.bodyMd.split('\n')) {
        if (line.trim() !== '') expect(shown.stdout).toContain(line);
      }
      for (const reply of entry.thread.replies) expect(shown.stdout).toContain(reply.bodyMd);
    }
    // …with the reply nested one level under its root.
    expect(shown.stdout).toContain('↳ reply ');
    // …and the history entry rendered from its typed parts, not from prose.
    expect(shown.stdout).toContain('changed status');
    // The whole stream fits, so the page is the whole story and says nothing else.
    expect(page.nextCursor).toBeNull();
    expect(shown.stdout).not.toContain('MORE —');
  });

  it('`--comments` prints the threads only, and an empty card says so explicitly', async () => {
    const { fx } = await linkedProject();
    const item = await argumentativeItem(fx);

    const comments = await ws.run(['show', item.identifier, '--comments']);
    expect(comments.exitCode, comments.stderr).toBe(0);
    expect(comments.stdout).toContain('COMMENTS\n2 comments');
    expect(comments.stdout).toContain('Agreed — the mirror product does the same.');
    // The history is a DIFFERENT view — this one carries none of it.
    expect(comments.stdout).not.toContain('changed status');

    // A card nobody has said anything about: an explicit line, never a bare
    // blank and never an error.
    const quiet = await leaf(fx, 'Nobody has commented on this');
    const empty = await ws.run(['show', quiet.identifier, '--comments']);
    expect(empty.exitCode, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('No comments yet.');
  });

  it('refuses BOTH flags at once rather than silently picking a stream', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'One stream or the other');

    const both = await ws.run(['show', item.identifier, '--activity', '--comments']);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('cannot be combined');
  });

  it('`--json` emits the activity page UNALTERED beside the aggregate', async () => {
    const { fx, token } = await linkedProject();
    const item = await argumentativeItem(fx);

    const asJson = await ws.run(['show', item.identifier, '--comments', '--json']);
    expect(asJson.exitCode, asJson.stderr).toBe(0);
    const payload = JSON.parse(asJson.stdout) as { key: string; activity: unknown };

    // Since MOTIR-2340 the aggregate IS the v1 resource — no `item` wrapper and
    // no `identifier`, because the resource names itself by `key` (ADR §7).
    expect(payload.key).toBe(item.identifier);
    // Byte for byte the ROUTE's own body — cursor and totals included, so a
    // script can tell there is more to read. Read back through the endpoint the
    // CLI actually calls rather than through the MCP tool, which is a different
    // producer with its own shape.
    const page = await fetch(
      `${server.url}/api/v1/work-items/${item.identifier}/activity?view=comments`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(page.status).toBe(200);
    expect(payload.activity).toEqual(await page.json());
  });

  it('needs NOTHING beyond the `read` scope `motir login` mints', async () => {
    // The device-authorization grant is fixed at CLI_TOKEN_SCOPES; a flag that
    // needed a wider one would be unreachable for every terminal connected the
    // normal way. Driven on a token carrying `read` ALONE — narrower even than
    // that grant — so the claim is proven, not assumed.
    const fx = await makeWorkItemFixture();
    const item = await argumentativeItem(fx);
    const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'read-only',
      fixedGrant: grantForLegacyScopes(['read']),
    });
    const env = { MOTIR_TOKEN: token, MOTIR_SERVER: server.url };

    const link = await ws.run(['link', '--project', fx.projectIdentifier], { env });
    expect(link.exitCode, link.stderr).toBe(0);

    for (const flag of ['--activity', '--comments']) {
      const result = await ws.run(['show', item.identifier, flag], { env });
      expect(result.exitCode, `${flag}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Archived because the surface moved.');
    }
  });
});

// ── motir sprints / motir sprint (7.9.14) ───────────────────────────────────

describe('motir sprints — the project’s sprints', () => {
  it('prints exactly the list_sprints set, in sequence order, with the ACTIVE one marked', async () => {
    const { fx } = await linkedProject();
    const first = await sprint(fx, 'Foundations');
    const second = await sprint(fx, 'The read surface');
    await sprint(fx, 'Zed the last one');
    await sprintsService.startSprint(second.id, {}, fx.ctx);

    const printed = await ws.run(['sprints']);
    expect(printed.exitCode).toBe(0);

    const { sprints } = structured<{
      sprints: { name: string; state: string; sequence: number }[];
    }>(await runListSprints({ projectKey: fx.projectIdentifier }, fx.ctx));
    const expected = [...sprints].sort((a, b) => a.sequence - b.sequence);

    const table = tableAfter(printed.stdout, /\d+ sprints?:/);
    expect(table.rows.map((r) => r['NAME'])).toEqual(expected.map((s) => s.name));
    expect(table.rows.map((r) => r['STATE'])).toEqual(expected.map((s) => s.state));

    // The active marker is on the active sprint and on nothing else.
    const marked = table.rows.filter((r) => r[''] === '*').map((r) => r['NAME']);
    expect(marked).toEqual(['The read surface']);
    expect(printed.stdout).toContain(first.name);
  });

  it('refuses an unknown --state rather than silently listing everything', async () => {
    const { fx } = await linkedProject();
    await sprint(fx, 'Foundations');

    const bad = await ws.run(['sprints', '--state', 'halfway']);

    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('Unknown sprint state');
    expect(bad.stderr).toContain('planned');
  });
});

describe('motir sprint — ONE sprint’s work items', () => {
  it('resolves the ACTIVE sprint by default, and by id and by name PREFIX', async () => {
    const { fx } = await linkedProject();
    const planned = await sprint(fx, 'Foundations');
    const active = await sprint(fx, 'The read surface');
    await sprintsService.startSprint(active.id, {}, fx.ctx);
    await leaf(fx, 'In the active sprint', { sprintId: active.id });
    await leaf(fx, 'In the planned one', { sprintId: planned.id });

    // No argument → the active sprint.
    const byDefault = await ws.run(['sprint']);
    expect(byDefault.exitCode).toBe(0);
    expect(byDefault.stdout).toContain(`${active.name}  [active]`);
    expect(byDefault.stdout).toContain('In the active sprint');
    expect(byDefault.stdout).not.toContain('In the planned one');

    // By id.
    const byId = await ws.run(['sprint', planned.id]);
    expect(byId.exitCode).toBe(0);
    expect(byId.stdout).toContain(`${planned.name}  [planned]`);
    expect(byId.stdout).toContain('In the planned one');

    // By name PREFIX — "Found" is unambiguous.
    const byPrefix = await ws.run(['sprint', 'Found']);
    expect(byPrefix.exitCode).toBe(0);
    expect(byPrefix.stdout).toContain(`${planned.name}  [planned]`);
  });

  it('collects the WHOLE sprint across a real nextCursor boundary', async () => {
    const { fx } = await linkedProject();
    const active = await sprint(fx, 'The big one');
    await sprintsService.startSprint(active.id, {}, fx.ctx);
    // The tool clamps `limit` to 50, and the CLI pages AT that cap — so a
    // sprint of 55 cannot be collected without following a cursor.
    const SIZE = 55;
    for (let i = 1; i <= SIZE; i += 1) {
      await leaf(fx, `Item number ${i}`, { sprintId: active.id });
    }

    // Prove the boundary is REAL: one page at the cap leaves a cursor behind.
    const filter = sprintItemsFilter(active.id);
    const firstPage = structured<{ items: unknown[]; total: number; nextCursor: string | null }>(
      await runSearchWorkItems({ projectKey: fx.projectIdentifier, filter, limit: 50 }, fx.ctx),
    );
    expect(firstPage.total).toBe(SIZE);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();

    const printed = await ws.run(['sprint']);
    expect(printed.exitCode).toBe(0);

    // The printed count is the server's own total, and the table really carries
    // that many rows — the CLI never prints a short table that reads as whole.
    expect(printed.stdout).toContain(`${firstPage.total} work items:`);
    expect(printed.stdout).not.toContain('could not be collected');
    const table = tableAfter(printed.stdout, /\d+ work items:/);
    expect(table.rows).toHaveLength(SIZE);
    // …including the rows only the SECOND page could have carried.
    expect(table.rows.map((r) => r['TITLE'])).toContain(`Item number ${SIZE}`);

    // `--json` agrees with the table and with the server's total.
    const asJson = await ws.run(['sprint', '--json']);
    const payload = JSON.parse(asJson.stdout) as { items: unknown[]; total: number };
    expect(payload.total).toBe(SIZE);
    expect(payload.items).toHaveLength(SIZE);
  });

  it('errors with guidance when NO sprint is active', async () => {
    const { fx } = await linkedProject();
    await sprint(fx, 'Planned but never started');

    const none = await ws.run(['sprint']);

    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain('No sprint is active');
    expect(none.stderr).toContain('motir sprints');
  });
});

// ── the dependency-EDGE seam (7.9.0f → 7.9.16) ──────────────────────────────
//
// The point of this file for THIS increment. The per-package suites render the
// edge columns against a SCRIPTED server — i.e. against the CLI's own idea of
// the payload, which is precisely the shape that can be wrong. These drive the
// REAL tool output back through the REAL renderer, so a key renamed on either
// side of the seam fails here instead of rendering a silently empty column.

describe('the dependency-edge columns — real tool output through the real renderer', () => {
  it('`motir ready` names what each row BLOCKS, matching list_ready’s own block', async () => {
    const { fx } = await linkedProject();
    const a = await leaf(fx, 'A — the one to do first');
    const b = await leaf(fx, 'B — waits on A');
    const c = await leaf(fx, 'C — also waits on A');
    await block(fx, b.id, a.id);
    await block(fx, c.id, a.id);

    const ready = await ws.run(['ready']);
    expect(ready.exitCode).toBe(0);

    const tool = structured<{ items: { key: string; dependencies: EdgeBlock }[] }>(
      await runListReady({ projectKey: fx.projectIdentifier }, fx.ctx),
    );
    const toolRow = tool.items.find((i) => i.key === a.identifier);
    expect(toolRow?.dependencies.blocks.map((e) => e.key).sort()).toEqual(
      [b.identifier, c.identifier].sort(),
    );

    const table = tableAfter(ready.stdout, /\d+ ready work items?:/);
    expect(table.headers).toContain('BLOCKS');
    const cell = rowFor(table, a.identifier)['BLOCKS'] ?? '';
    for (const edge of toolRow?.dependencies.blocks ?? []) expect(cell).toContain(edge.key);

    // B and C are BLOCKED, so they are not in the ready set at all — the column
    // describes the rows that ARE there, it does not invent them.
    expect(table.rows.map((r) => r['KEY'])).toEqual([a.identifier]);
    // A ready row's own blockers are satisfied by definition, so the reverse
    // column would be dead on every row and is deliberately absent.
    expect(table.headers).not.toContain('BLOCKED BY');
  });

  it('`motir sprint` names a row’s live blockers and MARKS the satisfied one', async () => {
    const { fx } = await linkedProject();
    const active = await sprint(fx, 'The read surface');
    await sprintsService.startSprint(active.id, {}, fx.ctx);
    const a = await leaf(fx, 'A — the blocker', { sprintId: active.id });
    const finished = await leaf(fx, 'D — already finished', { sprintId: active.id });
    const open = await leaf(fx, 'E — still open', { sprintId: active.id });
    const b = await leaf(fx, 'B — waits on three things', { sprintId: active.id });
    await block(fx, b.id, a.id);
    await block(fx, b.id, finished.id);
    await block(fx, b.id, open.id);
    await markDone(fx, finished.id);

    const printed = await ws.run(['sprint']);
    expect(printed.exitCode).toBe(0);

    const filter = sprintItemsFilter(active.id);
    const tool = structured<{ items: { identifier: string; dependencies: EdgeBlock }[] }>(
      await runSearchWorkItems({ projectKey: fx.projectIdentifier, filter, limit: 50 }, fx.ctx),
    );
    const toolRow = tool.items.find((i) => i.identifier === b.identifier);
    expect(toolRow?.dependencies.blockedBy.map((e) => e.key).sort()).toEqual(
      [a.identifier, finished.identifier, open.identifier].sort(),
    );

    const table = tableAfter(printed.stdout, /\d+ work items:/);
    expect(table.headers).toEqual(
      expect.arrayContaining([
        'KEY',
        'KIND',
        'STATUS',
        'PRIORITY',
        'BLOCKED BY',
        'BLOCKS',
        'TITLE',
      ]),
    );
    const cell = rowFor(table, b.identifier)['BLOCKED BY'] ?? '';

    // Every blocker the tool reported is named — including the finished one,
    // which is what the ✓ is FOR. The contract is that a satisfied blocker is
    // DISTINGUISHABLE from a live one, not that it is hidden: a reader has to
    // be able to answer "why is this not moving" from the row, and "it isn't,
    // that one is done" is part of the answer.
    for (const edge of toolRow?.dependencies.blockedBy ?? []) expect(cell).toContain(edge.key);
    expect(cell).toContain(`${finished.identifier}✓`);
    expect(cell).not.toContain(`${a.identifier}✓`);
    expect(cell).not.toContain(`${open.identifier}✓`);
    // The live blockers come first — they are what the wait is actually about.
    expect(cell.indexOf(a.identifier)).toBeLessThan(cell.indexOf(finished.identifier));
    expect(printed.stdout).toContain('✓ = already done');

    // A row nothing gates renders BLANK, never a zero and never a false block.
    expect(rowFor(table, a.identifier)['BLOCKED BY']).toBe('');
    expect(rowFor(table, a.identifier)['BLOCKS']).toContain(b.identifier);
  });

  it('truncates a wide cell with +n while `--json` carries the FULL block', async () => {
    const { fx } = await linkedProject();
    const hub = await leaf(fx, 'The hub everything waits on');
    const waiting: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const dependent = await leaf(fx, `Dependent ${i}`);
      await block(fx, dependent.id, hub.id);
      waiting.push(dependent.identifier);
    }

    const ready = await ws.run(['ready']);
    const cell = rowFor(tableAfter(ready.stdout, /\d+ ready work items?:/), hub.identifier)[
      'BLOCKS'
    ];
    // Five edges, a budget of three: the cell must NOT print all five, and must
    // say how many it withheld rather than truncating silently.
    expect(cell).toContain('+2');
    expect(waiting.filter((key) => cell?.includes(key))).toHaveLength(3);

    // The abbreviation is a TERMINAL-WIDTH concern only — the machine view
    // never lies, and it matches the tool byte for byte.
    const asJson = await ws.run(['ready', '--json']);
    const rows = JSON.parse(asJson.stdout) as { key: string; dependencies: EdgeBlock }[];
    const jsonRow = rows.find((r) => r.key === hub.identifier);
    const tool = structured<{ items: { key: string; dependencies: EdgeBlock }[] }>(
      await runListReady({ projectKey: fx.projectIdentifier }, fx.ctx),
    );
    expect(jsonRow?.dependencies).toEqual(
      tool.items.find((i) => i.key === hub.identifier)?.dependencies,
    );
    expect(jsonRow?.dependencies.blocks.map((e) => e.key).sort()).toEqual([...waiting].sort());
  });

  it('EXCLUDES an archived blocker from every edge column (the MOTIR-1328 rule)', async () => {
    const { fx } = await linkedProject();
    const active = await sprint(fx, 'The read surface');
    await sprintsService.startSprint(active.id, {}, fx.ctx);
    const live = await leaf(fx, 'A live blocker', { sprintId: active.id });
    const stale = await leaf(fx, 'A blocker that was archived', { sprintId: active.id });
    const waiting = await leaf(fx, 'Waiting on both', { sprintId: active.id });
    await block(fx, waiting.id, live.id);
    await block(fx, waiting.id, stale.id);
    await workItemsService.archiveWorkItem(stale.id, fx.ctx);

    const printed = await ws.run(['sprint']);
    expect(printed.exitCode).toBe(0);

    const table = tableAfter(printed.stdout, /\d+ work items:/);
    const cell = rowFor(table, waiting.identifier)['BLOCKED BY'] ?? '';
    expect(cell).toContain(live.identifier);
    // An archived blocker is a STALE edge: it must not appear, and it must not
    // read as something the reader has to go and finish.
    expect(cell).not.toContain(stale.identifier);
    expect(printed.stdout).not.toContain(stale.identifier);
  });
});

// ── motir show — the build-order WAVE view (7.9.16b) ────────────────────────

describe('motir show — build-order waves over a real Postgres DAG', () => {
  it('layers a real fan-out / fan-in DAG into the correct waves', async () => {
    const { fx } = await linkedProject();
    const parent = await story(fx, 'A story with a real shape');
    // Two roots; W1 fans OUT to two dependents; W4 fans IN from two blockers.
    const w1 = await child(fx, parent.id, 'Migration');
    const w2 = await child(fx, parent.id, 'Design');
    const w3 = await child(fx, parent.id, 'Service');
    const w4 = await child(fx, parent.id, 'Route');
    const w5 = await child(fx, parent.id, 'UI');
    await block(fx, w3.id, w1.id);
    await block(fx, w4.id, w1.id);
    await block(fx, w4.id, w2.id);
    await block(fx, w5.id, w3.id);
    await block(fx, w5.id, w4.id);

    const show = await ws.run(['show', parent.identifier]);
    expect(show.exitCode).toBe(0);

    const table = tableAfter(show.stdout, /CHILDREN \(5\)/);
    expect(show.stdout).toContain('CHILDREN (5) — build order');
    expect(table.headers).toEqual(['WAVE', 'KEY', 'KIND', 'STATUS', 'BLOCKED BY', 'TITLE']);

    const waveOf = (item: WorkItemDto): string => rowFor(table, item.identifier)['WAVE'] ?? '';
    // Wave 1 is the story's LOCAL ready set — exactly the independently
    // buildable children, nothing more.
    expect(
      table.rows
        .filter((r) => r['WAVE'] === '1')
        .map((r) => r['KEY'])
        .sort(),
    ).toEqual([w1.identifier, w2.identifier].sort());
    expect(waveOf(w3)).toBe('2');
    expect(waveOf(w4)).toBe('2');
    expect(waveOf(w5)).toBe('3');

    // The fan-in row NAMES both of its blockers, so the reason for the wait is
    // answerable from the row.
    const fanIn = rowFor(table, w4.identifier)['BLOCKED BY'] ?? '';
    expect(fanIn).toContain(w1.identifier);
    expect(fanIn).toContain(w2.identifier);
    expect(rowFor(table, w1.identifier)['BLOCKED BY']).toBe('');

    // `--json` carries the same order machine-readably, and its per-child edge
    // block matches the tool's — the same drift check, one level down.
    // ⚠️ `key`, not `identifier`: since MOTIR-2340 `--json` emits the v1
    // RESOURCE, which names a work item by its `MOTIR-<n>` key everywhere (ADR
    // §7). The MCP tool below still says `identifier`, and the two are compared
    // across that rename rather than assumed to agree.
    const asJson = await ws.run(['show', parent.identifier, '--json']);
    const payload = JSON.parse(asJson.stdout) as {
      children: { key: string; wave: number | null; dependencies: EdgeBlock }[];
    };
    expect(new Map(payload.children.map((c) => [c.key, c.wave]))).toEqual(
      new Map([
        [w1.identifier, 1],
        [w2.identifier, 1],
        [w3.identifier, 2],
        [w4.identifier, 2],
        [w5.identifier, 3],
      ]),
    );
    const tool = structured<{ children: { identifier: string; dependencies: EdgeBlock }[] }>(
      await runGetWorkItem({ key: parent.identifier }, fx.ctx),
    );
    for (const jsonChild of payload.children) {
      const toolChild = tool.children.find((c) => c.identifier === jsonChild.key);
      expect(jsonChild.dependencies).toEqual(toolChild?.dependencies);
    }
  });

  it('a DONE blocker and an ARCHIVED one both stop gating — neither delays a wave', async () => {
    const { fx } = await linkedProject();
    const parent = await story(fx, 'A story part-way through');
    const finished = await child(fx, parent.id, 'Already shipped');
    const stale = await child(fx, parent.id, 'Archived after a re-plan');
    const open = await child(fx, parent.id, 'Still to do');
    const target = await child(fx, parent.id, 'Waits on all three');
    await block(fx, target.id, finished.id);
    await block(fx, target.id, stale.id);
    await block(fx, target.id, open.id);
    await markDone(fx, finished.id);
    await workItemsService.archiveWorkItem(stale.id, fx.ctx);

    const show = await ws.run(['show', parent.identifier]);
    expect(show.exitCode).toBe(0);

    // The archived child leaves the aggregate entirely.
    const table = tableAfter(show.stdout, /CHILDREN \(3\)/);
    expect(table.rows.map((r) => r['KEY'])).not.toContain(stale.identifier);

    const cell = rowFor(table, target.identifier)['BLOCKED BY'] ?? '';
    expect(cell).toContain(open.identifier);
    expect(cell).toContain(`${finished.identifier}✓`);
    // The archived edge is gone from the cell, and — the part a fixture-based
    // unit test cannot prove — it does not push the row down a wave either.
    expect(cell).not.toContain(stale.identifier);
    expect(rowFor(table, target.identifier)['WAVE']).toBe('2');
    expect(rowFor(table, open.identifier)['WAVE']).toBe('1');
    expect(rowFor(table, finished.identifier)['WAVE']).toBe('1');
  });

  it('a blocked_by CYCLE cannot be seeded at all — Postgres rejects the closing edge', async () => {
    const { fx } = await linkedProject();
    const parent = await story(fx, 'A story someone tried to tangle');
    const first = await child(fx, parent.id, 'One');
    const second = await child(fx, parent.id, 'Two');
    await block(fx, second.id, first.id);

    // 7.9.15 was authored expecting to SEED a cycle here — "which the plan rules
    // forbid but the DB permits" — and drive `show`'s cycle marker end-to-end.
    // Against shipped reality that premise is false: `enforce_work_item_link_no_cycle`
    // (migration 20260531231110) walks the `is_blocked_by` chain from the new
    // edge's far end on EVERY insert and raises `WI_LINK_CYCLE` (SQLSTATE 23514)
    // if the walk reaches the near end. It is a TRIGGER, so no write path evades
    // it — not the service, not the repository, not a raw insert. So the
    // assertable fact is the invariant itself, which is the stronger one: the
    // renderer's cycle branch is UNREACHABLE from data the product can hold.
    // (Its own behaviour stays covered by MOTIR-1848's `assignChildWaves` /
    // `cycleMembers` unit cases, which can hand it the impossible input.)
    await expect(block(fx, first.id, second.id)).rejects.toThrow();
    await expect(
      adminDb.workItemLink.create({
        data: {
          workspaceId: fx.workspaceId,
          fromId: first.id,
          toId: second.id,
          kind: 'is_blocked_by',
          createdById: fx.ownerId,
        },
      }),
    ).rejects.toThrow(/WI_LINK_CYCLE/);

    // …and the surface stays honest: a total order, no cycle marker.
    const show = await ws.run(['show', parent.identifier]);
    expect(show.exitCode).toBe(0);
    expect(show.stdout).not.toContain('dependency CYCLE');
    const table = tableAfter(show.stdout, /CHILDREN \(2\)/);
    expect(rowFor(table, first.identifier)['WAVE']).toBe('1');
    expect(rowFor(table, second.identifier)['WAVE']).toBe('2');
  });
});

// ── single dispatch ─────────────────────────────────────────────────────────

describe('single dispatch — motir next / run / done', () => {
  it('`next --print` claims the item and prints the SERVER prompt byte-identically', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Print me', {
      type: 'code',
      descriptionMd: 'Do the work.\n\n## Acceptance criteria\n\n- It works\n',
    });

    const next = await ws.run(['next', '--print']);

    expect(next.exitCode).toBe(0);
    expect((await stateOf(fx, item.id)).status).toBe('in_progress');
    // The prompt is a pure function of server state, so the expected text can be
    // assembled independently and compared BYTE FOR BYTE — the contract that the
    // CLI assembles no prompt grammar of its own.
    // The CLI declares it posts the self-report file (`agentReport=1`,
    // MOTIR-8810) and the decisions in it (`agentReportDecisions=1`,
    // MOTIR-10000), so the server text it receives is the file-route rendering.
    const expected = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      item.identifier,
      fx.ctx,
      { runnerPostsAgentReport: true, runnerPostsDecisions: true },
    );
    expect(next.stdout).toBe(expected.prompt);
    // Diagnostics go to stderr, so `motir next --print | pbcopy` pipes the prompt
    // and nothing else.
    expect(next.stderr).toContain('Dispatch:');
    expect(next.stderr).toContain(item.identifier);
  });

  it('reports nothing to do rather than failing when the ready set is empty', async () => {
    await linkedProject();

    const next = await ws.run(['next', '--print']);

    expect(next.exitCode).toBe(0);
    expect(next.stderr).toContain('No ready work items');
  });

  it('`next --agent` on a successful agent lands the item Implemented', async () => {
    const { fx } = await linkedProject();
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    const item = await leaf(fx, 'Agent runs this', { type: 'code' });

    const next = await ws.run(['next', '--agent', agent.command]);

    expect(next.exitCode).toBe(0);
    // Implemented, not In Review, since MOTIR-2999: a finished agent has pushed
    // its work, and only a green build makes the card reviewable.
    expect((await stateOf(fx, item.id)).status).toBe('implemented');
    // BYOK's delivery contract: the prompt reaches the agent on BOTH channels.
    const [invocation] = agent.invocations();
    expect(invocation?.stdin).toContain(item.identifier);
    expect(invocation?.promptFromFile).toBe(invocation?.stdin);
    expect(invocation?.cwd).toBe(ws.root);
  });

  it('a FAILING agent leaves the item In Progress, exits with its code, and is skipped next time', async () => {
    const { fx } = await linkedProject();
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ exit: 3 }]);
    const first = await leaf(fx, 'This one breaks', { type: 'code' });
    const second = await leaf(fx, 'The next one');

    const failed = await ws.run(['next', '--agent', agent.command]);

    expect(failed.exitCode).toBe(3);
    expect(failed.stderr).toContain('agent exited 3');
    expect((await stateOf(fx, first.id)).status).toBe('in_progress');

    // The exclude list is PERSISTED, so the next process moves past it.
    const nextUp = await ws.run(['next', '--print']);
    expect(nextUp.stderr).toContain('Skipping 1 previously-failed item');
    expect(nextUp.stdout).toContain(second.identifier);

    // …and `--reset` puts it back in the running (it is In Progress now, so the
    // reset is observable as the skip line disappearing).
    const reset = await ws.run(['next', '--print', '--reset']);
    expect(reset.stderr).toContain('Cleared 1 excluded item');
  });

  it('`run <key>` refuses a NOT-READY item by name, and dispatches it under --force', async () => {
    const { fx } = await linkedProject();
    const blocker = await leaf(fx, 'The blocker');
    const blocked = await leaf(fx, 'The blocked one');
    await block(fx, blocked.id, blocker.id);

    const refused = await ws.run(['run', blocked.identifier, '--print']);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`${blocked.identifier} is not ready`);
    expect(refused.stderr).toContain(blocker.identifier);
    expect(refused.stderr).toContain('--force');
    expect((await stateOf(fx, blocked.id)).status).toBe('todo');

    const forced = await ws.run(['run', blocked.identifier, '--print', '--force']);
    expect(forced.exitCode).toBe(0);
    expect(forced.stderr).toContain('dispatching anyway (--force)');
    expect((await stateOf(fx, blocked.id)).status).toBe('in_progress');
  });

  it('`done` closes an in_progress item directly, and --via walks it through review', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Close me out');
    await ws.run(['run', item.identifier, '--print']);

    // Since MOTIR-1625, `in_progress → done` IS an edge of the default workflow
    // (review is optional), so the bare hop succeeds.
    const done = await ws.run(['done', item.identifier]);
    expect(done.exitCode).toBe(0);
    expect((await stateOf(fx, item.id)).status).toBe('done');

    // --via still walks an explicitly-named intermediate status, for a workflow
    // (or a team) that wants the review hop recorded.
    const other = await leaf(fx, 'Close me out via review');
    await ws.run(['run', other.identifier, '--print']);
    const viaReview = await ws.run(['done', other.identifier, '--via', 'in_review']);
    expect(viaReview.exitCode).toBe(0);
    expect((await stateOf(fx, other.id)).status).toBe('done');
  });

  it('`done` rejects an illegal hop with the allowed targets', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Not startable yet');

    // A fresh item is `todo`, and `todo → done` is not an edge — the CLI surfaces
    // the workflow's allowed targets rather than inventing a path.
    const illegal = await ws.run(['done', item.identifier]);
    expect(illegal.exitCode).toBe(1);
    expect(illegal.stderr).toContain('In Progress');
    expect((await stateOf(fx, item.id)).status).toBe('todo');
  });

  it('`done` refuses a key AND --session together, and needs one of them', async () => {
    await linkedProject();

    const both = await ws.run(['done', 'PROD-1', '--session', 'motir/auto-1']);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain('not both');

    const neither = await ws.run(['done']);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain('A work item key is required');
  });
});

// ── repo routing: the two workspace shapes ──────────────────────────────────

describe('repo routing — where the agent actually runs', () => {
  it('EMPTY root: the scaffold item runs at the root, and the next one routes INTO the checkout it created', async () => {
    const { fx } = await linkedProject();
    // ⚠️ A repository Motir cannot derive a clone URL for — which is what makes
    // this the GENUINE bootstrap (MOTIR-3588). A github-connected repository
    // with a missing checkout is now CLONED rather than dispatched at the root,
    // and rightly so; the path this test owns is the other one, where there is
    // nothing to clone from and the card's own work is to create it.
    await connectRepo(fx, 'motir-core', { provider: 'bitbucket' });
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    // The bootstrap agent does what its prompt says: it creates the checkout.
    agent.script([{ create: 'motir-core' }, {}]);

    // The link binds with NO repo entries — checkouts resolve by convention.
    expect(readLinkFile(ws.root)).not.toHaveProperty('repos');

    const scaffold = await leaf(fx, 'Scaffold the repo', { targetRepo: 'motir-core' });
    const followUp = await leaf(fx, 'Then build in it', { targetRepo: 'motir-core' });

    const first = await ws.run(['run', scaffold.identifier, '--agent', agent.command]);
    expect(first.exitCode).toBe(0);
    // The label no longer claims the PROMPT creates the checkout — it does not;
    // its first command is `git worktree add`. It names the card instead.
    expect(first.stderr).toContain('"motir-core" does not exist yet; this work item creates it');
    expect(agent.invocations()[0]?.cwd).toBe(ws.root);
    expect(existsSync(ws.path('motir-core'))).toBe(true);

    const second = await ws.run(['run', followUp.identifier, '--agent', agent.command]);
    expect(second.exitCode).toBe(0);
    expect(agent.invocations()[1]?.cwd).toBe(ws.path('motir-core'));
    expect(second.stderr).toContain('motir-core checkout (convention)');
  });

  it('TWO-checkout root: each item is dispatched into ITS repo, and an unpinned one at the root', async () => {
    const { fx } = await linkedProject();
    await connectRepo(fx, 'motir-core');
    await connectRepo(fx, 'motir-ai');
    mkdirSync(ws.path('motir-core'), { recursive: true });
    mkdirSync(ws.path('motir-ai'), { recursive: true });
    const agent = writeFakeAgent(join(ws.root, '.agent'));

    const core = await leaf(fx, 'A core item', { targetRepo: 'motir-core' });
    const ai = await leaf(fx, 'An AI item', { targetRepo: 'motir-ai' });
    // No pin, and TWO connected repos → the server says "I cannot say" rather
    // than guessing, and the CLI runs at the root.
    const unpinned = await leaf(fx, 'An unpinned item');

    await ws.run(['run', core.identifier, '--agent', agent.command]);
    await ws.run(['run', ai.identifier, '--agent', agent.command]);
    const last = await ws.run(['run', unpinned.identifier, '--agent', agent.command]);

    expect(agent.invocations().map((i) => i.cwd)).toEqual([
      ws.path('motir-core'),
      ws.path('motir-ai'),
      ws.root,
    ]);
    expect(last.stderr).toContain('the item pins no repo');
  });

  it('a bootstrap that produced NO checkout is reported as suspect — in `next` AND in `auto`', async () => {
    const { fx } = await linkedProject();
    // The genuine bootstrap fixture — see the sibling test above for why the
    // provider is the thing that makes it one.
    await connectRepo(fx, 'motir-core', { provider: 'bitbucket' });
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    // Exit 0, create nothing — the silent-failure shape a real agent can produce.
    agent.script([{ exit: 0 }]);
    const item = await leaf(fx, 'Scaffold that fails quietly', { targetRepo: 'motir-core' });

    const next = await ws.run(['run', item.identifier, '--agent', agent.command]);
    expect(next.stderr).toContain('Suspect dispatch');
    expect(next.stderr).toContain('motir link add motir-core');

    // In the unattended loop the same silence is a FAILED dispatch, not a
    // warning: every later item routed at that repo would repeat the bootstrap.
    const second = await leaf(fx, 'Another one for the same repo', { targetRepo: 'motir-core' });
    const auto = await ws.run(['auto', '--agent', agent.command, '--max', '1']);

    expect(auto.exitCode).toBe(1);
    expect(auto.stderr).toContain('bootstrap checkout missing');
    expect((await stateOf(fx, second.id)).status).toBe('in_progress');
  });
});

// ── the auto loop + session-branch integration ──────────────────────────────

describe('motir auto — the session-branch run', () => {
  it('cascades through the dependency chain, integrates onto ONE branch, and opens ONE pull request', async () => {
    const { fx } = await linkedProject();
    await connectRepo(fx, 'motir-core');
    const { repo, gh, agent } = repoRun('motir-core');
    agent.script([{ integrate: { file: 'a.txt' } }, { integrate: { file: 'b.txt' } }]);
    const mainBefore = repo.originMain();

    const a = await leaf(fx, 'A — the dependency', { targetRepo: 'motir-core', type: 'code' });
    const b = await leaf(fx, 'B — depends on A', { targetRepo: 'motir-core', type: 'code' });
    await block(fx, b.id, a.id);

    const auto = await ws.run(['auto', '--agent', agent.command]);
    expect(auto.exitCode).toBe(0);

    // THE CASCADE: B was NOT ready when the run started — only integrating A made
    // it so, and the loop's per-iteration `next_ready` re-query picked it up.
    const invocations = agent.invocations();
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.stdin).toContain(a.identifier);
    expect(invocations[1]?.stdin).toContain(b.identifier);

    const stateA = await stateOf(fx, a.id);
    const stateB = await stateOf(fx, b.id);
    const branch = stateA.sessionBranch;
    expect(branch).toMatch(/^motir\/auto-\d{8}-\d{6}$/);
    // Both land at Implemented — the run's own report. The branch's build is
    // what moves them on to In Review (MOTIR-2999), and no check has run here.
    expect(stateA.status).toBe('implemented');
    expect(stateB.status).toBe('implemented');
    // B INHERITED the lineage: the server, not the CLI, put it on A's branch.
    expect(stateB.sessionBranch).toBe(branch);
    expect(invocations[1]?.stdin).toContain(`Integrate the commit into ${branch}`);

    // THE RUN RECORDS ITS LEGS (MOTIR-8632). `auto` opens with an empty set and
    // re-opens per card; each re-open must append the card as a leg, or every
    // per-card event 422s and the run page shows a run with no cards.
    const runs = await adminDb.dispatchRun.findMany({
      where: { command: 'auto', projectId: fx.projectId },
      include: { cards: { orderBy: { position: 'asc' } } },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cards.map((leg) => [leg.workItemId, leg.position])).toEqual([
      [a.id, 0],
      [b.id, 1],
    ]);
    // The loop's per-card events landed on those legs rather than being refused.
    expect(runs[0]!.cards.every((leg) => leg.disposition !== 'queued')).toBe(true);

    // ONE pull request for the one repo the run touched.
    const prs = gh.pullRequests();
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ head: branch, base: 'main', cwd: repo.path });
    expect(prs[0]?.title).toContain('2 work items');
    expect(prs[0]?.body).toContain(a.identifier);
    expect(prs[0]?.body).toContain(b.identifier);
    // The close-out instruction, and the honest answer if the PR is REJECTED.
    expect(prs[0]?.body).toContain(`motir done --session ${branch}`);
    expect(prs[0]?.body).toContain('rejected');
    // The run's summary says what it actually did — built and pushed — and names
    // CI as what makes the cards reviewable (MOTIR-3004/3006). "Awaiting your
    // merge" would tell the operator the lifecycle is finished when it is not.
    expect(auto.stderr).toContain('Implemented — CI decides when these become reviewable (2)');

    // NO AUTO-MERGE: the branch exists on origin, `main` is exactly where it was,
    // and `gh pr merge` was never even attempted.
    expect(repo.hasBranchOnOrigin(branch as string)).toBe(true);
    expect(repo.originMain()).toBe(mainBefore);
    expect(gh.invocations().some((call) => call.args.join(' ').includes('pr merge'))).toBe(false);

    // The close-out round trip: every item on the branch → Done, branch cleared.
    const done = await ws.run(['done', '--session', branch as string]);
    expect(done.exitCode).toBe(0);
    expect(done.stderr).toContain('2 completed');
    for (const id of [a.id, b.id]) {
      const state = await stateOf(fx, id);
      expect(state.status).toBe('done');
      expect(state.sessionBranch).toBeNull();
    }
  });

  it('SKIPS what an agent cannot do — an unexpanded story and human work — and says so', async () => {
    const { fx } = await linkedProject();
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));

    const codeItem = await leaf(fx, 'Real work', { type: 'code' });
    const human = await leaf(fx, 'Sign the contract', { type: 'manual', executor: 'human' });
    // A childless story IS legitimately ready — it is a PLANNING item, not work.
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Unexpanded story' },
      fx.ctx,
    );

    const auto = await ws.run(['auto', '--agent', agent.command]);

    expect(agent.invocations()).toHaveLength(1);
    expect(agent.invocations()[0]?.stdin).toContain(codeItem.identifier);
    expect(auto.stderr).toContain('needs planning');
    // ADR `manual-work-gate.md` §8 (MOTIR-7477): the starter's own manual card.
    expect(auto.stderr).toContain("waiting on you in Motir's Waiting on you");
    expect(auto.stderr).not.toContain('needs a human');
    // A skipped item is NOT dispatched, so it is not transitioned either.
    expect((await stateOf(fx, story.id)).status).toBe('todo');
    expect((await stateOf(fx, human.id)).status).toBe('todo');
  });

  it('halts on the first agent failure, and continues past it under --keep-going', async () => {
    const { fx } = await linkedProject();
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    agent.script([{ exit: 2 }]);
    await leaf(fx, 'Breaks first', { type: 'code' });
    await leaf(fx, 'Breaks second', { type: 'code' });

    const halted = await ws.run(['auto', '--agent', agent.command]);
    expect(halted.exitCode).toBe(1);
    expect(agent.invocations()).toHaveLength(1);
    expect(halted.stderr).toContain('halted on the first agent failure');

    const kept = await ws.run(['auto', '--agent', agent.command, '--reset', '--keep-going']);
    // Both were attempted this time (the first is In Progress now, so the second
    // is the only ready one left — the run ends drained, not halted).
    expect(kept.stderr).toContain('the ready set is drained');
    expect(agent.invocations()).toHaveLength(2);
  });

  it('`--max` caps the run, and `--print` / a missing agent are refused with guidance', async () => {
    const { fx } = await linkedProject();
    installFakeGh(ws.binDir);
    const agent = writeFakeAgent(join(ws.root, '.agent'));
    for (const title of ['One', 'Two', 'Three']) await leaf(fx, title, { type: 'code' });

    const capped = await ws.run(['auto', '--agent', agent.command, '--max', '2']);
    expect(agent.invocations()).toHaveLength(2);
    expect(capped.stderr).toContain('--max reached');

    const bad = await ws.run(['auto', '--agent', agent.command, '--max', 'lots']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('--max must be a positive whole number');

    // `--print` is refused — an unattended loop has nobody to paste a prompt.
    // The flag IS registered on `auto` (program.ts) precisely so commander hands
    // it to `autoCommand`'s guard rather than rejecting it as unknown: the user
    // gets the sentence that says what to do instead, not a generic parse error
    // (MOTIR-1828). This asserts the guard's own text end-to-end through the
    // built binary, which is the only place the registration can be proven.
    const printed = await ws.run(['auto', '--print', '--agent', agent.command]);
    expect(printed.exitCode).toBe(1);
    expect(printed.stderr).toContain('`motir auto` cannot run in --print mode.');
    expect(printed.stderr).toContain('motir next --print');

    const agentless = await ws.run(['auto']);
    expect(agentless.exitCode).toBe(1);
    expect(agentless.stderr).toContain('needs an agent to run');
  });
});

describe('motir batch — the frozen snapshot', () => {
  // `batch` carried the IDENTICAL unregistered-`--print` defect (MOTIR-1830):
  // it merged after MOTIR-1828's fix, which was applied to `auto` alone. The
  // package suite now audits the registration for every command
  // (`optionRegistrationAudit.test.ts`); this is the same refusal proven through
  // the shipped binary, beside its `auto` twin above.
  it('`--print` is refused by the GUARD, not as an unknown option', async () => {
    await linkedProject();
    const printed = await ws.run(['batch', '--print', '--agent', 'echo']);
    expect(printed.exitCode).toBe(1);
    expect(printed.stderr).toContain('`motir batch` cannot run in --print mode.');
    expect(printed.stderr).toContain('motir next --print');
    expect(printed.stderr).not.toContain('unknown option');
  });
});

// ── the help surface (the 7.9.12 assembled check) ───────────────────────────

describe('help — against the BUILT binary', () => {
  /** `heading → command names`, parsed back out of the rendered overview. */
  function commandGroups(overview: string): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    let heading: string | undefined;
    for (const line of overview.split('\n')) {
      const title = /^([A-Z][A-Z ]*:)\s*$/.exec(line)?.[1];
      if (title !== undefined) {
        heading = title;
        if (title.endsWith('COMMANDS:') || title === 'HELP TOPICS:') groups.set(title, []);
        continue;
      }
      if (heading === undefined || !groups.has(heading)) continue;
      if (line.trim() === '') {
        heading = undefined;
        continue;
      }
      const item = /^ {2}(\S+)/.exec(line);
      if (item?.[1]) groups.get(heading)?.push(item[1]);
    }
    return groups;
  }

  it('`motir`, `motir help` and `motir --help` all exit 0 on STDOUT with the identical overview', async () => {
    const [bare, helpCommand, helpFlag] = await Promise.all([
      ws.run([]),
      ws.run(['help']),
      ws.run(['--help']),
    ]);

    for (const result of [bare, helpCommand, helpFlag]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('SETUP COMMANDS:');
    }
    expect(helpCommand.stdout).toBe(bare.stdout);
    expect(helpFlag.stdout).toBe(bare.stdout);
  });

  it('lists EVERY command the story shipped, each exactly once, under a group heading', async () => {
    const overview = (await ws.run(['help'])).stdout;
    const listed = [...commandGroups(overview).values()].flat();

    // This is the assertion the package's own unit tests cannot make: it reads
    // the REAL binary's help, so a later command subtask that forgets to declare
    // its group shows up here as a real command missing from real help.
    for (const command of [
      'login',
      'logout',
      'auth',
      'link',
      'doctor',
      'ready',
      'status',
      'sprints',
      'sprint',
      'show',
      'open',
      'next',
      'run',
      'auto',
      'batch',
      'plan',
      'done',
      'help',
    ]) {
      expect(listed.filter((name) => name === command)).toEqual([command]);
    }
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('fails an unknown command with one line and a hint, not a stack trace', async () => {
    const bogus = await ws.run(['bogus']);

    expect(bogus.exitCode).toBe(1);
    expect(bogus.stderr).toContain('Unknown command "bogus"');
    expect(bogus.stderr).not.toContain('at Object');
  });
});

// ── attribution ─────────────────────────────────────────────────────────────

describe('attribution — every write lands as the PAT owner', () => {
  it('records the token owner in the revision trail for each transition', async () => {
    const { fx } = await linkedProject();
    const item = await leaf(fx, 'Walk the lifecycle');

    await ws.run(['run', item.identifier, '--print']);
    await ws.run(['done', item.identifier, '--via', 'in_review']);

    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: item.id },
      orderBy: { changedAt: 'asc' },
    });
    // create + the three status hops the CLI drove.
    expect(revisions.length).toBeGreaterThanOrEqual(4);
    expect(new Set(revisions.map((r) => r.changedById))).toEqual(new Set([fx.ownerId]));
  });
});
