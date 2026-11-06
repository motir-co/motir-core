import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { db } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { PLANNER_FINDING_NO_PLAN_ID } from '@/lib/services/plannerFindingsService';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { mcpRouteFetch } from '../helpers/mcpRouteFetch';

// `record_planner_finding` through the REAL MCP transport (Story MOTIR-10354 ·
// Subtask MOTIR-10391): every case enters `app/api/mcp/route.ts` with a minted
// bearer token, the way an agent does, so the auth gate, the per-token permission
// gate, the registration-time strict-input rewrite, the registry, the tool, the
// service and the real tenant reads all run against real Postgres.
//
// ⚠️ ONLY MOTIR-AI IS DOUBLED, AT THE HTTP BOUNDARY. The MCP transport is handed
// `mcpRouteFetch`, not global `fetch`, so stubbing global `fetch` intercepts
// motir-ai's traffic and nothing else. That makes "no request left core" and
// "exactly one request left" real assertions on the serialized request.
//
// Each case is written so the natural assertion would pass under a broken tool:
//
//   • Refusals assert the ABSENCE of an upstream call, not only an error — a
//     check that ran after the request had gone out reads identically.
//   • The success arm reads the id from the STRUCTURED content, not the prose.
//   • The grant arm is PAIRED: a token without `ai:plan` is refused, and a token
//     with only `project:browse` + `ai:plan` (no lesson key) succeeds, so the
//     tool cannot be secretly asserting a lesson key.
//   • Failures count the upstream calls: the create route is not idempotent, so
//     a retry would store a second row for one defect.

const ENDPOINT = 'http://localhost/api/mcp';
const NAME = 'record_planner_finding';
const CREATE_PATH = '/v1/admin/planner-findings';

const REQUIRED = {
  planner: 'plan_py',
  site: 'MOTIR-12 acceptance criterion 3',
  prediction: 'STOPS',
  whatHappened: 'The runner would stop: the criterion reads the deployment.',
  evidence: 'lib/runner/rules.ts:42 at 4af7d93',
  outcome: 'reported',
} as const;

const OPTIONAL_WIRE_KEYS = [
  'baselineBranch',
  'baselineCommit',
  'planTitle',
  'cardRef',
  'correction',
  'attribution',
  'why',
  'hostedCell',
  'planpyCell',
  'fixDirection',
  'authorModel',
  'authorSessionKey',
  'rule',
] as const;

function storedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pf_stored_1',
    source: 'check_plan',
    planner: 'plan_py',
    site: REQUIRED.site,
    fingerprint: 'a'.repeat(64),
    status: 'new',
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

interface Upstream {
  calls: string[];
  inits: RequestInit[];
}

/** Stub motir-ai at the HTTP boundary; record every request that leaves core. */
function stubUpstream(answer: () => Response | Promise<Response>): Upstream {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      calls.push(String(input));
      inits.push((init ?? {}) as RequestInit);
      return answer();
    }),
  );
  return { calls, inits };
}

function bodyOf(upstream: Upstream, n = 0): Record<string, unknown> {
  const init = upstream.inits[n];
  if (!init) throw new Error(`no upstream request #${n}`);
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    fetch: mcpRouteFetch(token),
  });
  const client = new Client({ name: 'record-planner-finding-transport', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function tokenWith(
  fx: WorkItemFixture,
  permissions: readonly PermissionKey[],
  label: string,
): Promise<string> {
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label,
    fixedGrant: [...permissions],
  });
  return token;
}

async function clientFor(
  fx: WorkItemFixture,
  permissions: readonly PermissionKey[] = GRANTABLE_PERMISSIONS,
  label = 'full',
): Promise<Client> {
  return connect(await tokenWith(fx, permissions, label));
}

async function call(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name: NAME, arguments: args })) as CallToolResult;
}

const rendered = (result: unknown) => JSON.stringify(result);

function textOf(result: CallToolResult): string {
  return (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('record_planner_finding over the real transport — tools/list', () => {
  it('serves a closed schema of exactly the agreed arguments, and a description carrying its facts', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);

    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === NAME);
    expect(tool).toBeTruthy();

    const schema = tool!.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      [
        'projectKey',
        'planId',
        'planTitle',
        'cardRef',
        'planner',
        'site',
        'prediction',
        'whatHappened',
        'evidence',
        'correction',
        'outcome',
        'attribution',
        'why',
        'hostedCell',
        'planpyCell',
        'fixDirection',
        'rule',
        'authorModel',
        'authorSessionKey',
        'baseline',
      ].sort(),
    );
    expect([...(schema.required ?? [])].sort()).toEqual(
      ['projectKey', 'planner', 'site', 'prediction', 'whatHappened', 'evidence', 'outcome'].sort(),
    );
    for (const banned of [
      'source',
      'status',
      'fingerprint',
      'jobId',
      'lessonId',
      'bugKey',
      'triage',
    ]) {
      expect(schema.properties).not.toHaveProperty(banned);
    }

    // Facts the served text carries, not one fixed wording.
    const d = tool!.description ?? '';
    expect(d).toMatch(/one (planner )?defect/i);
    expect(d).toMatch(/one call per defect|one call records one/i);
    expect(d).toMatch(/only platform admins/i);
    expect(d).toMatch(/never files a bug/i);
    expect(d).toMatch(/lesson/i);
    expect(d).toMatch(/no source argument/i);
  });
});

describe('record_planner_finding over the real transport — a valid call', () => {
  it('records once, names the acting project on the wire, and returns the stored id', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, {
      projectKey: fx.projectIdentifier,
      ...REQUIRED,
      cardRef: 'MOTIR-12',
      attribution: 'corpus',
      why: 'The pack never names the deploy boundary.',
      baseline: { branch: 'main', commit: '4af7d93' },
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const structured = result.structuredContent as { id?: unknown };
    expect(structured.id).toBe('pf_stored_1');
    expect(textOf(result).split('\n')[0]).toContain('pf_stored_1');

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]).toContain(CREATE_PATH);
    expect(upstream.inits[0]!.method).toBe('POST');

    const body = bodyOf(upstream);
    expect(body['source']).toBe('check_plan');
    expect(body['coreProjectId']).toBe(fx.projectId);
    expect(body['coreWorkspaceId']).toBe(fx.workspaceId);
    expect(typeof body['coreOrganizationId']).toBe('string');
    expect((body['coreOrganizationId'] as string).length).toBeGreaterThan(0);
    expect(body['baselineBranch']).toBe('main');
    expect(body['baselineCommit']).toBe('4af7d93');
    expect(body).not.toHaveProperty('baseline');
  });

  it('sends only the half of a baseline given, and no optional key at all when none is given', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const half = await call(client, {
      projectKey: fx.projectIdentifier,
      ...REQUIRED,
      baseline: { branch: 'main' },
    });
    const bare = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(half.isError, textOf(half)).toBeFalsy();
    expect(bare.isError, textOf(bare)).toBeFalsy();
    expect(upstream.calls).toHaveLength(2);

    const halfBody = bodyOf(upstream, 0);
    expect(halfBody['baselineBranch']).toBe('main');
    expect(halfBody).not.toHaveProperty('baselineCommit');
    expect(halfBody).not.toHaveProperty('baseline');

    const bareBody = bodyOf(upstream, 1);
    for (const key of OPTIONAL_WIRE_KEYS) {
      expect(bareBody).not.toHaveProperty(key);
    }
    expect(Object.values(bareBody)).not.toContain(null);
    expect(Object.values(bareBody)).not.toContain('');
  });

  it('sends the rule the check names, trimmed, as the key motir-ai groups on (MOTIR-10468)', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, {
      projectKey: fx.projectIdentifier,
      ...REQUIRED,
      rule: ' src/jobs/planningEngine.ts:3090 ',
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(bodyOf(upstream)['rule']).toBe('src/jobs/planningEngine.ts:3090');
  });

  it('sends the no-plan marker when planId is omitted', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(PLANNER_FINDING_NO_PLAN_ID.length).toBeGreaterThan(0);
    expect(bodyOf(upstream)['planId']).toBe(PLANNER_FINDING_NO_PLAN_ID);
  });

  it('forwards a planId that is no plan in core, and its title, verbatim as text', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, {
      projectKey: fx.projectIdentifier,
      ...REQUIRED,
      planId: 'planpy_run_2026_11_05_never_in_core',
      planTitle: 'Billing export, local plan.py run',
    });

    expect(result.isError, textOf(result)).toBeFalsy();
    const body = bodyOf(upstream);
    expect(body['planId']).toBe('planpy_run_2026_11_05_never_in_core');
    expect(body['planTitle']).toBe('Billing export, local plan.py run');
  });
});

describe('record_planner_finding over the real transport — refused before the boundary', () => {
  it.each([
    ['prediction', 'MAYBE'],
    ['outcome', 'closed'],
    ['attribution', 'infra'],
    ['planner', 'other'],
  ])('refuses %s=%s by naming the field, and sends nothing', async (field, value) => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, {
      projectKey: fx.projectIdentifier,
      ...REQUIRED,
      [field]: value,
    });

    expect(result.isError).toBe(true);
    expect(rendered(result)).toContain(field);
    expect(upstream.calls).toEqual([]);
  });

  it.each([
    ['source', 'check_plan'],
    ['source', 'in_loop'],
    ['status', 'triaged'],
  ])(
    'refuses the unknown key %s (=%s) by name, never dropping or forwarding it',
    async (key, value) => {
      const fx = await makeWorkItemFixture();
      const client = await clientFor(fx);
      const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

      const result = await call(client, {
        projectKey: fx.projectIdentifier,
        ...REQUIRED,
        [key]: value,
      });

      expect(result.isError).toBe(true);
      expect(rendered(result)).toContain(key);
      expect(upstream.calls).toEqual([]);
    },
  );

  it('refuses a missing required field by name, and sends nothing', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));
    const { evidence: _omit, ...withoutEvidence } = REQUIRED;

    const result = await call(client, { projectKey: fx.projectIdentifier, ...withoutEvidence });

    expect(result.isError).toBe(true);
    expect(rendered(result)).toContain('evidence');
    expect(upstream.calls).toEqual([]);
  });

  it('refuses a key from an unrelated workspace, and no request carries its project id', async () => {
    const mine = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
    const theirs = await makeWorkItemFixture({ name: 'Rival', identifier: 'ZZZ' });
    const client = await clientFor(mine);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, { projectKey: theirs.projectIdentifier, ...REQUIRED });

    expect(result.isError).toBe(true);
    expect(upstream.calls).toEqual([]);
    expect(upstream.inits.map((i) => String(i.body ?? ''))).not.toContainEqual(
      expect.stringContaining(theirs.projectId),
    );
  });
});

describe('record_planner_finding over the real transport — the grant asks ai:plan, not a lesson key', () => {
  it('refuses a token holding every grantable key except ai:plan, naming it, and sends nothing', async () => {
    const fx = await makeWorkItemFixture();
    expect(GRANTABLE_PERMISSIONS).toContain('ai:plan');
    const withheld = GRANTABLE_PERMISSIONS.filter((k) => k !== 'ai:plan');
    const client = await clientFor(fx, withheld, 'no-ai-plan');
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError).toBe(true);
    expect(rendered(result)).toContain('ai:plan');
    expect(upstream.calls).toEqual([]);
  });

  it('admits a token holding only project:browse and ai:plan — no lesson key', async () => {
    const fx = await makeWorkItemFixture();
    const grant: PermissionKey[] = ['project:browse', 'ai:plan'];
    expect(grant).not.toContain('lesson:manage');
    expect(grant).not.toContain('lesson:reinforce');
    const client = await clientFor(fx, grant, 'browse-and-plan');
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(upstream.calls).toHaveLength(1);
  });

  it('admits a token minted with the CLI grant, the credential motir check plan runs under', async () => {
    const fx = await makeWorkItemFixture();
    expect(CLI_TOKEN_GRANT).toContain('ai:plan');
    const client = await clientFor(fx, CLI_TOKEN_GRANT, 'cli');
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError, textOf(result)).toBeFalsy();
    expect(upstream.calls).toHaveLength(1);
  });
});

describe('record_planner_finding over the real transport — upstream answers', () => {
  it('surfaces a 400 validation_error with its detail, after exactly one request', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const detail = "'whatHappened' must not be blank";
    const upstream = stubUpstream(() =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'validation_error',
          status: 400,
          code: 'validation_error',
          detail,
        },
        400,
      ),
    );

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(detail);
    expect(upstream.calls).toHaveLength(1);
  });

  it('surfaces a 503 as an error and does not retry', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'internal_error',
          status: 503,
          code: 'internal_error',
          detail: 'store is restarting',
        },
        503,
      ),
    );

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
  });

  it('surfaces a thrown transport error as an error and does not retry', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      });
    });

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
  });

  it('a repeat call writes a second row: two calls, two requests, two successes', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow(), 201));
    const args = { projectKey: fx.projectIdentifier, ...REQUIRED };

    const first = await call(client, args);
    const second = await call(client, args);

    expect(first.isError, textOf(first)).toBeFalsy();
    expect(second.isError, textOf(second)).toBeFalsy();
    expect(upstream.calls).toHaveLength(2);
  });

  it('never reads a 201 with no string id as recorded', async () => {
    const fx = await makeWorkItemFixture();
    const client = await clientFor(fx);
    const upstream = stubUpstream(() => jsonResponse(storedRow({ id: 42 }), 201));

    const result = await call(client, { projectKey: fx.projectIdentifier, ...REQUIRED });

    expect(result.isError).toBe(true);
    expect(upstream.calls).toHaveLength(1);
  });
});
