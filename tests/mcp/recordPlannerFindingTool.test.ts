import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// `record_planner_finding` (Story MOTIR-10354 · Subtask MOTIR-10387) — the
// ADAPTER, over an in-memory `tools/list` / `callTool`, with
// `plannerFindingsService.recordFinding` mocked at its module seam. The real
// database behind the gate is the integration test (MOTIR-10390); the real
// transport with a bearer token is the end-to-end test (MOTIR-10391).
//
// What this pins: the description CARRIES its six facts (asserted as facts, not
// wording); the schema is exactly the agreed property set and strict; a refusal
// — unknown key, out-of-enum value — happens before the service is called; the
// adapter hands the key through untouched and never resolves the project itself;
// and the tool sits in every table keyed by tool name.

const recordFinding = vi.fn();
const getByKey = vi.fn();

vi.mock('@/lib/services/plannerFindingsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/plannerFindingsService')>();
  return {
    ...actual,
    plannerFindingsService: { recordFinding: (...args: unknown[]) => recordFinding(...args) },
  };
});
vi.mock('@/lib/services/projectsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/projectsService')>();
  return {
    ...actual,
    projectsService: {
      ...actual.projectsService,
      getByKey: (...args: unknown[]) => getByKey(...args),
    },
  };
});

const { buildMcpServer, MCP_TOOL_NAMES } = await import('@/lib/mcp/registry');
const { TOOL_PERMISSIONS } = await import('@/lib/mcp/toolPermissions');
const { TOOL_SCOPES } = await import('@/lib/mcp/scopes');
const { TOOL_ANNOTATIONS } = await import('@/lib/mcp/toolAnnotations');
const { EXEMPT_TOOLS } = await import('@/lib/mcp/payloads/exemptions');
const { MCP_TOOL_INPUT_SCHEMAS, MCP_TOOL_TITLES, MCP_TOOL_ANNOTATIONS } =
  await import('@/lib/apiDocs/mcpToolSchemas');
const { mcpToolRows, mcpToolFingerprint } = await import('@/lib/apiDocs/mcp');
const { RECORD_PLANNER_FINDING_PERMISSION } = await import('@/lib/services/plannerFindingsService');
const { RECORD_PLANNER_FINDING_TOOL_NAME } = await import('@/lib/mcp/tools/recordPlannerFinding');
const { PermissionDeniedError } = await import('@/lib/projects/errors');

const NAME = 'record_planner_finding';
const ctx: ServiceContext = { userId: 'user_1', workspaceId: 'ws_1' };

const VALID = {
  projectKey: 'motir',
  planner: 'plan_py',
  site: 'MOTIR-12 criterion 3',
  prediction: 'STOPS',
  whatHappened: 'The runner would stop at the criterion.',
  evidence: 'lib/runner/rules.ts:42 at 4af7d93',
  outcome: 'reported',
};

const STORED = { id: 'pf_1', source: 'check_plan', fingerprint: 'fp_1', status: 'new' };

async function connect(): Promise<Client> {
  const server = buildMcpServer(() => ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

function textOf(res: unknown): string {
  return ((res as CallToolResult).content ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
}

async function listed() {
  const client = await connect();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === NAME);
  expect(tool).toBeDefined();
  return tool!;
}

async function call(args: Record<string, unknown>) {
  const client = await connect();
  return client.callTool({ name: NAME, arguments: args });
}

beforeEach(() => {
  vi.clearAllMocks();
  recordFinding.mockResolvedValue(STORED);
});

describe('record_planner_finding — tools/list', () => {
  it('is listed with a short title and a description carrying its six facts', async () => {
    const tool = await listed();
    expect(tool.title!.length).toBeLessThanOrEqual(64);
    const d = tool.description!;

    // One call records one defect, one call per defect.
    expect(d).toMatch(/one planner defect/i);
    expect(d).toMatch(/one call per defect/i);
    // Readable only by platform admins.
    expect(d).toMatch(/only platform admins can read/i);
    // Never files a bug or a lesson.
    expect(d).toMatch(/never files a bug/i);
    expect(d).toMatch(/lesson/i);
    // No source argument; always a check_plan finding.
    expect(d).toMatch(/no source argument/i);
    expect(d).toContain('check_plan');
    // A repeat call writes a second row.
    expect(d).toMatch(/repeat call writes a second row/i);
    // The planning permission, not lesson management.
    expect(d).toMatch(/planning permission/i);
    expect(d).toMatch(/not lesson management/i);
  });

  it('serves a strict schema with exactly the agreed property set', async () => {
    const schema = (await listed()).inputSchema as unknown as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(
      ['projectKey', 'planner', 'site', 'prediction', 'whatHappened', 'evidence', 'outcome'].sort(),
    );
    expect(Object.keys(schema.properties).sort()).toEqual(
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
        'authorModel',
        'authorSessionKey',
        'baseline',
      ].sort(),
    );
    expect(Object.keys(schema.properties['baseline']!.properties!).sort()).toEqual([
      'branch',
      'commit',
    ]);
    for (const banned of [
      'source',
      'status',
      'fingerprint',
      'rule',
      'jobId',
      'lessonId',
      'bugKey',
      'triage',
    ]) {
      expect(schema.properties).not.toHaveProperty(banned);
    }
  });
});

describe('record_planner_finding — refusals before the service', () => {
  it.each(['source', 'status', 'rule'])('refuses an unknown key `%s` by name', async (key) => {
    const res = await call({ ...VALID, [key]: 'in_loop' });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(key);
    expect(recordFinding).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['planner', 'gpt'],
    ['prediction', 'MAYBE'],
    ['outcome', 'ignored'],
    ['attribution', 'nobody'],
  ])('refuses %s outside its closed set, naming the field', async (field, value) => {
    const res = await call({ ...VALID, [field]: value });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(field);
    expect(recordFinding).toHaveBeenCalledTimes(0);
  });
});

describe('record_planner_finding — the relay', () => {
  it('hands the key as typed, the context and the rest of the input to the service once', async () => {
    const args = {
      ...VALID,
      planId: 'plan_never_existed',
      cardRef: 'MOTIR-12',
      attribution: 'corpus',
      baseline: { branch: 'main', commit: '4af7d93' },
    };

    const res = await call(args);

    expect(res.isError, textOf(res)).toBeFalsy();
    expect(recordFinding).toHaveBeenCalledTimes(1);
    const [key, passedCtx, input] = recordFinding.mock.calls[0]!;
    expect(key).toBe('motir');
    expect(passedCtx).toMatchObject(ctx);
    const { projectKey: _drop, ...rest } = args;
    expect(input).toEqual(rest);
    expect(input).not.toHaveProperty('projectKey');
    expect(getByKey).toHaveBeenCalledTimes(0);
  });

  it('answers with the stored id first and the structured identity', async () => {
    const res = await call(VALID);

    expect(res.isError).toBeFalsy();
    const firstLine = textOf(res).split('\n')[0]!;
    expect(firstLine).toContain('pf_1');
    expect((res as CallToolResult).structuredContent).toEqual(STORED);
  });

  it.each([
    ['MotirAiBadRequestError', new MotirAiBadRequestError("'prediction' must be one of", 400)],
    ['MotirAiUnavailableError', new MotirAiUnavailableError('store is restarting')],
    ['MotirAiConfigError', new MotirAiConfigError('MOTIR_AI_URL is not set')],
  ])('returns %s as a tool error with the upstream message, after ONE call', async (_n, err) => {
    recordFinding.mockRejectedValue(err);

    const res = await call(VALID);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(err.message);
    expect(recordFinding).toHaveBeenCalledTimes(1);
  });

  it('returns a permission refusal as the standard permission error', async () => {
    recordFinding.mockRejectedValue(new PermissionDeniedError('pj_1', 'ai:plan'));

    const res = await call(VALID);

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('PERMISSION_DENIED');
    expect(textOf(res)).toContain('ai:plan');
    expect(recordFinding).toHaveBeenCalledTimes(1);
  });
});

describe('record_planner_finding — every table keyed by tool name', () => {
  it('is registered, permissioned, scoped, annotated, exempt, generated and summarised', () => {
    expect(RECORD_PLANNER_FINDING_TOOL_NAME).toBe(NAME);
    expect(MCP_TOOL_NAMES).toContain(NAME);
    expect(TOOL_PERMISSIONS[NAME]).toBe('ai:plan');
    expect(TOOL_PERMISSIONS[NAME]).toBe(RECORD_PLANNER_FINDING_PERMISSION);
    expect(TOOL_SCOPES[NAME]).toBe('work_items:write');
    expect(TOOL_ANNOTATIONS[NAME]).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(EXEMPT_TOOLS[NAME].trim().length).toBeGreaterThan(0);
    expect(MCP_TOOL_INPUT_SCHEMAS[NAME]).toBeDefined();
    expect(MCP_TOOL_TITLES[NAME]).toBeDefined();
    expect(MCP_TOOL_ANNOTATIONS[NAME]).toBeDefined();
    const row = mcpToolRows().find((r) => r.name === NAME);
    expect(row?.summary.trim().length).toBeGreaterThan(0);
    expect(mcpToolFingerprint(NAME)).toMatch(/^[0-9a-f]{12}$/);
    expect(mcpToolFingerprint(NAME)).not.toBe('000000000000');
  });
});
