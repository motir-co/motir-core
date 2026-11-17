import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { MOTIR_AI_REQUEST_TIMEOUT_MS } from '@/lib/ai/motirAiClient';
import { buildMcpServer, MCP_TOOL_NAMES } from '@/lib/mcp/registry';
import { PERMISSION_NOT_GRANTED_CODE } from '@/lib/mcp/permissionGate';
import { TOOL_PERMISSIONS } from '@/lib/mcp/toolPermissions';
import { TOOL_SCOPES } from '@/lib/mcp/scopes';
import { TOOL_ANNOTATIONS } from '@/lib/mcp/toolAnnotations';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture } from '../fixtures';
import { linkAllWorkspaceReposIntoProject } from '../fixtures/codeContextFixtures';
import type { WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE NAME-RECORD DOOR (MOTIR-11649 · story MOTIR-11497) — `record_name_occurrences` and
// `lookup_name_occurrences` as an MCP client sees them: `buildMcpServer` behind an
// in-memory `Client`, over real Postgres, with the real permission gate, the real key
// resolution inside the token's workspace, the real service, the real client and
// `aiFetch`. The ONE stub is the global `fetch` at motir-ai's origin, and it is also the
// recorder: a refusal is proved to have called nobody by an EMPTY recorder, not by the
// shape of its error text, and what crossed the boundary is read off the recorded request.
//
// ⚠️ What this suite does NOT prove: motir-ai's own two routes are stubbed, so whether
// they map an organisation, split a batch or degrade correctly is not asked here; and
// plan.py does not run at all. A green result is evidence about THIS door only.

const AI_URL = 'http://motir-ai.names.test';
const SERVICE_TOKEN = 'svc-token-11649';
const OWNER = 'moooon-B-V';
const REPO_REF = `${OWNER}/motir-core`;
const RECORD = 'record_name_occurrences';
const LOOKUP = 'lookup_name_occurrences';
const TOOLS = [RECORD, LOOKUP] as const;
const LOOKUP_ROUTE = `${AI_URL}/v1/code-graph/name-occurrences/lookup`;
const RECORD_ROUTE = `${AI_URL}/v1/code-graph/name-occurrences/record`;
const PLANNING_GRANT: PermissionKey[] = ['project:browse', 'ai:plan'];
const COMMIT = 'c0ffee'.padEnd(40, '7');
/**
 * The two names a code-graph credential would go by; neither may cross this door. Built
 * from parts so this file does not itself carry the names the credential guard
 * (`name-occurrences-credential-guard.test.ts`) holds at zero across the tree.
 */
const CREDENTIAL_NAMES = new RegExp(
  [['MOTIR', 'CODEGRAPH', ''].join('_'), ['CODEGRAPH', 'READ', 'SECRET'].join('_')].join('|'),
);

interface AiCall {
  url: string;
  headers: Record<string, string>;
  rawBody: string;
  body: Record<string, unknown>;
}
const aiCalls: AiCall[] = [];
let aiReply: (call: AiCall, signal: AbortSignal | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' },
  });

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).origin !== AI_URL) throw new Error(`unexpected outbound call: ${url}`);
    const rawBody = String(init?.body);
    const call: AiCall = {
      url,
      headers: headersOf(init),
      rawBody,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    };
    aiCalls.push(call);
    return aiReply(call, init?.signal ?? undefined);
  });
}

async function connect(ctx: ServiceContext, grant?: readonly PermissionKey[]): Promise<Client> {
  const server = grant
    ? buildMcpServer(
        () => ctx,
        () => [...grant],
      )
    : buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'name-occurrences-door-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function call(
  name: (typeof TOOLS)[number],
  args: Record<string, unknown>,
  opts: { ctx?: ServiceContext; grant?: readonly PermissionKey[] } = {},
): Promise<CallToolResult> {
  const client = await connect(opts.ctx ?? fx.ctx, opts.grant);
  try {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  } finally {
    await client.close();
  }
}

function answer(res: CallToolResult): Record<string, unknown> {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as Record<string, unknown>;
}

interface NameEntry {
  name: string;
  occurrences: { path: string; startLine: number; endLine: number; blob: string }[];
}
const namesOf = (res: CallToolResult) => answer(res)['names'] as NameEntry[];

async function seedRepoSet(f: WorkItemFixture): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: f.workspaceId,
    installation: {
      installationId: `inst-${f.workspaceId}`,
      accountLogin: OWNER,
      accountType: 'Organization',
    },
    repos: ['motir-core', 'motir-ai'].map((name) => ({
      providerRepoId: `repo-${name}-${f.workspaceId}`,
      owner: OWNER,
      name,
      defaultBranch: 'main',
      archived: false,
    })),
  });
  await linkAllWorkspaceReposIntoProject({ ...f.ctx, projectId: f.projectId });
}

let fx: WorkItemFixture;
const lookupArgs = (extra: Record<string, unknown> = {}) => ({
  projectKey: fx.projectIdentifier,
  repo: 'motir-core',
  names: ['readFile'],
  ...extra,
});
const occurrence = (i: number) => ({
  blob: `${String(i).padStart(4, '0')}`.padEnd(40, 'a'),
  name: `name${String(i)}`,
  startLine: i + 1,
  endLine: i + 2,
});
const recordArgs = (extra: Record<string, unknown> = {}) => ({
  projectKey: fx.projectIdentifier,
  repo: 'motir-core',
  occurrences: [occurrence(0)],
  ...extra,
});
const argsFor = (tool: (typeof TOOLS)[number], projectKey?: string) => {
  const args = tool === LOOKUP ? lookupArgs() : recordArgs();
  return projectKey === undefined ? args : { ...args, projectKey };
};

/** motir-ai's ordinary look-up answer: the asked names, each with what `held` gives it. */
function lookupReply(held: Record<string, NameEntry['occurrences']> = {}) {
  return (c: AiCall) =>
    json({
      commit: COMMIT,
      names: (c.body['names'] as string[]).map((name) => ({ name, occurrences: held[name] ?? [] })),
    });
}

beforeEach(async () => {
  await truncateAuthTables();
  aiCalls.length = 0;
  aiReply = (c) =>
    c.url === RECORD_ROUTE
      ? json({ recorded: (c.body['occurrences'] as unknown[]).length })
      : lookupReply()(c);
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', SERVICE_TOKEN);
  stubFetch();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fx = await makeWorkItemFixture();
  await seedRepoSet(fx);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the door — listing, tables, the ai:plan gate, the tenant', () => {
  it('a planning token lists both tools, and every table a tool must appear in carries them', async () => {
    const client = await connect(fx.ctx, PLANNING_GRANT);
    const { tools } = await client.listTools();
    await client.close();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of TOOLS) {
      expect(byName.has(name), name).toBe(true);
      expect(MCP_TOOL_NAMES, name).toContain(name);
      expect(TOOL_PERMISSIONS[name], name).toBe('ai:plan');
      expect(TOOL_SCOPES[name], name).toBeDefined();
      expect(TOOL_ANNOTATIONS[name], name).toBeDefined();
    }
    const props = (name: string) =>
      Object.keys(byName.get(name)!.inputSchema.properties ?? {}).sort();
    expect(props(LOOKUP)).toEqual(['commit', 'names', 'projectKey', 'repo']);
    expect(props(RECORD)).toEqual(['occurrences', 'projectKey', 'repo']);
  });

  it.each(TOOLS)(
    '%s without ai:plan is refused at the door, with zero outbound calls',
    async (tool) => {
      const res = await call(tool, argsFor(tool), {
        grant: GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan'),
      });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(PERMISSION_NOT_GRANTED_CODE);
      expect(aiCalls).toEqual([]);
    },
  );

  it.each(TOOLS)(
    '%s with another workspace’s key is the plain not-found, with zero outbound calls',
    async (tool) => {
      const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
      await seedRepoSet(other);
      const res = await call(tool, argsFor(tool, other.projectIdentifier));
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain('PROJECT_NOT_FOUND');
      expect(aiCalls).toEqual([]);
    },
  );
});

describe('lookup_name_occurrences — order, misses, caps, the forwarded request', () => {
  it('answers in the order ASKED although motir-ai answers shuffled', async () => {
    const asked = ['zeta', 'alpha', 'mid'];
    aiReply = () =>
      json({
        commit: COMMIT,
        names: ['mid', 'zeta', 'alpha'].map((name) => ({
          name,
          occurrences: [{ path: `lib/${name}.ts`, startLine: 1, endLine: 2, blob: 'b'.repeat(40) }],
        })),
      });
    const names = namesOf(await call(LOOKUP, lookupArgs({ names: asked })));
    expect(names).toHaveLength(asked.length);
    asked.forEach((name, k) => {
      expect(names[k]!.name).toBe(name);
      expect(names[k]!.occurrences[0]!.path).toBe(`lib/${name}.ts`);
    });
  });

  it('a name motir-ai answers empty keeps its own position as a miss; two occurrences both travel', async () => {
    const two = [
      { path: 'lib/a.ts', startLine: 3, endLine: 9, blob: '1'.repeat(40) },
      { path: 'lib/b.ts', startLine: 12, endLine: 12, blob: '2'.repeat(40) },
    ];
    aiReply = lookupReply({ held: two });
    const out = answer(await call(LOOKUP, lookupArgs({ names: ['absent', 'held', 'gone'] })));
    expect(out['names']).toEqual([
      { name: 'absent', occurrences: [] },
      { name: 'held', occurrences: two },
      { name: 'gone', occurrences: [] },
    ]);
    expect(out).toMatchObject({ commit: COMMIT, note: null, reason: null });
  });

  it('200 names is the cap, not a refusal: all 200 are forwarded and answered in order', async () => {
    const asked = Array.from({ length: 200 }, (_, i) => `n${String(199 - i)}`);
    const names = namesOf(await call(LOOKUP, lookupArgs({ names: asked })));
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]!.body['names']).toEqual(asked);
    expect(names.map((n) => n.name)).toEqual(asked);
  });

  it.each([
    [
      '201 names',
      Array.from({ length: 201 }, (_, i) => `n${String(i)}`),
      'NAME_OCCURRENCE_NAMES_TOO_MANY',
    ],
    ['an empty list', [], 'NAME_OCCURRENCE_NAMES_EMPTY'],
    ['a duplicate', ['a', 'b', 'a'], 'NAME_OCCURRENCE_NAMES_DUPLICATE'],
  ])(
    '%s is refused as the door’s own error, with zero outbound calls',
    async (_label, names, code) => {
      const res = await call(LOOKUP, lookupArgs({ names }));
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(code);
      expect(aiCalls).toEqual([]);
    },
  );

  it('a bare name and owner/name in another case forward ONE identical request', async () => {
    const extra = { commit: COMMIT, names: ['b', 'a'] };
    answer(await call(LOOKUP, lookupArgs({ ...extra, repo: 'motir-core' })));
    answer(await call(LOOKUP, lookupArgs({ ...extra, repo: REPO_REF.toUpperCase() })));
    expect(aiCalls.map((c) => c.url)).toEqual([LOOKUP_ROUTE, LOOKUP_ROUTE]);
    expect(aiCalls[0]!.body).toEqual({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      repoRef: REPO_REF,
      commit: COMMIT,
      names: ['b', 'a'],
    });
    expect(aiCalls[1]!.rawBody).toBe(aiCalls[0]!.rawBody);
  });
});

describe('record_name_occurrences — the batch, verbatim, and the service’s count', () => {
  it('forwards three occurrences in asked order with all four fields, and reports the service’s count', async () => {
    const batch = [occurrence(2), occurrence(0), occurrence(1)];
    // The service's number, deliberately NOT the batch length: the door must not recompute it.
    aiReply = () => json({ recorded: 1 });
    const out = answer(await call(RECORD, recordArgs({ occurrences: batch })));
    expect(out).toEqual({ recorded: 1, note: null, reason: null });
    expect(aiCalls.map((c) => c.url)).toEqual([RECORD_ROUTE]);
    expect(aiCalls[0]!.body).toEqual({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
      repoRef: REPO_REF,
      occurrences: batch,
    });
  });

  it('2,000 occurrences are forwarded whole and answered 2,000', async () => {
    const batch = Array.from({ length: 2_000 }, (_, i) => occurrence(i));
    const out = answer(await call(RECORD, recordArgs({ occurrences: batch })));
    expect(out['recorded']).toBe(2_000);
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0]!.body['occurrences']).toEqual(batch);
  });
});

describe('a forward that fails is an ANSWER — a miss with a state, never a tool error', () => {
  const failures: [string, () => Response | Promise<Response>][] = [
    ['a 5xx', () => json({ code: 'internal', title: 'Internal', status: 500 }, 500)],
    [
      'a transport failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    // A motir-ai that predates the routes: its 404 must degrade the check, never fail it.
    [
      'a 404 for a route this motir-ai lacks',
      () => json({ code: 'not_found', title: 'Not Found', status: 404 }, 404),
    ],
  ];

  function expectLookupMiss(res: CallToolResult, asked: string[]): void {
    const out = answer(res);
    expect((out['names'] as NameEntry[]).map((n) => n.name)).toEqual(asked);
    for (const entry of out['names'] as NameEntry[]) expect(entry.occurrences).toEqual([]);
    expect(typeof out['note']).toBe('string');
    expect((out['note'] as string).trim()).not.toBe('');
    expect(out['note'] as string).not.toContain('\n');
    expect(out['reason']).toEqual(expect.any(String));
  }

  function expectRecordZero(res: CallToolResult): void {
    const out = answer(res);
    expect(out['recorded']).toBe(0);
    expect((out['note'] as string).trim()).not.toBe('');
    expect(out['reason']).toEqual(expect.any(String));
  }

  it.each(failures)(
    '%s: the look-up answers a miss per name with a state sentence',
    async (_l, reply) => {
      aiReply = reply;
      const asked = ['b', 'a', 'c'];
      expectLookupMiss(await call(LOOKUP, lookupArgs({ names: asked })), asked);
      expect(aiCalls).toHaveLength(1);
    },
  );

  it.each(failures)('%s: the record answers 0 with a state sentence', async (_l, reply) => {
    aiReply = reply;
    expectRecordZero(await call(RECORD, recordArgs()));
    expect(aiCalls).toHaveLength(1);
  });

  it('a forward that never answers is driven past the client’s deadline: the same quiet miss', async () => {
    // Fake ONLY the timer functions, and only once the request is in flight, so the
    // suite's Postgres client is never under fake time.
    aiReply = (_c, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason as Error));
      });
    for (const tool of TOOLS) {
      aiCalls.length = 0;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const pending = call(tool, argsFor(tool));
      await vi.waitFor(() => expect(aiCalls).toHaveLength(1), { interval: 5, timeout: 10_000 });
      vi.advanceTimersByTime(MOTIR_AI_REQUEST_TIMEOUT_MS);
      vi.useRealTimers();
      const res = await pending;
      if (tool === LOOKUP) {
        expectLookupMiss(res, ['readFile']);
        expect(answer(res)['reason']).toBe('ai_unreachable');
      } else {
        expectRecordZero(res);
        expect(answer(res)['reason']).toBe('ai_unreachable');
      }
    }
  });

  it('motir-ai’s own degraded 200 is carried as it said it, and the door adds nothing on top', async () => {
    const state = 'the organisation has no code-graph tenant yet, so nothing was recorded';
    aiReply = (c) =>
      c.url === RECORD_ROUTE
        ? json({ recorded: 0, state })
        : json({
            commit: null,
            names: (c.body['names'] as string[]).map((name) => ({ name, occurrences: [] })),
            state,
          });
    const looked = answer(await call(LOOKUP, lookupArgs({ names: ['x', 'y'] })));
    expect(looked).toEqual({
      commit: null,
      names: [
        { name: 'x', occurrences: [] },
        { name: 'y', occurrences: [] },
      ],
      note: state,
      reason: 'record_unanswered',
    });
    expect(answer(await call(RECORD, recordArgs()))).toEqual({
      recorded: 0,
      note: state,
      reason: 'record_unanswered',
    });
  });
});

describe('no code-graph credential crosses this door', () => {
  it('each successful call makes exactly one request, to its route, carrying only the motir-ai bearer', async () => {
    answer(await call(LOOKUP, lookupArgs({ commit: COMMIT })));
    answer(await call(RECORD, recordArgs()));
    expect(aiCalls.map((c) => c.url)).toEqual([LOOKUP_ROUTE, RECORD_ROUTE]);
    for (const c of aiCalls) {
      const credentialHeaders = Object.entries(c.headers).filter(([k]) =>
        /auth|token|secret|key|credential|cookie/i.test(k),
      );
      expect(credentialHeaders).toEqual([['authorization', `Bearer ${SERVICE_TOKEN}`]]);
      expect(c.rawBody).not.toMatch(CREDENTIAL_NAMES);
    }
  });
});
