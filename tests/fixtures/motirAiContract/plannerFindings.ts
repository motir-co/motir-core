import type {
  RawLesson,
  RawPlannerFinding,
  RawPlannerFindingAudit,
  RawPlannerFindingGroup,
  RawPlannerFindingGroupPage,
  RawPlannerFindingPage,
  RawPlannerFindingTriageResult,
} from '@/lib/ai/motirAiClient';
import type { ResultEnvelope } from '@/lib/ai/types';

/**
 * motir-ai's PLANNER-FINDINGS admin routes, as their bodies are shaped (Story
 * MOTIR-10353 · MOTIR-10527): `FindingGroupDto` (`fingerprint`, `count`,
 * `planIds`, `latest`), `TriageResult` (`finding`, `audit`) and
 * `FindingAuditRecord` (`action`, `findingId`, `actorCoreUserId`, `at`, `before`,
 * `after`) from motir-ai `src/services/plannerFindingService.ts` (main de8bbb9),
 * and a plan job's `stageUsage` and `dryRun` result members.
 *
 * TYPED with motir-core's own `Raw*` client types on purpose, as
 * `platformLessons.ts` is: a field motir-core stops declaring fails the
 * typecheck here.
 *
 * `plannerFindingsFake` is the integration gates' stand-in for motir-ai at
 * `fetch`: a small stateful store answering exactly the routes the console
 * crosses. It keeps motir-ai's ONE rule that matters to the audit trail — a
 * PATCH whose every field already equals the stored value answers
 * `audit: null` — and reimplements nothing else (no fingerprint hashing, no
 * retention, no filter beyond `status`, `excludeStatus`, `fingerprint`,
 * `cursor` and `limit`), so a wrong expectation cannot hide in a rich fake. An
 * unrecorded route THROWS.
 */

export const RETENTION = { days: 90, cutoff: '2026-08-08T00:00:00.000Z' } as const;

/** One stored finding, every column the wire carries. */
export function recordedFinding(
  over: Partial<RawPlannerFinding> & Pick<RawPlannerFinding, 'id'>,
): RawPlannerFinding {
  return {
    coreOrganizationId: '__ORG__',
    coreWorkspaceId: '__WS__',
    coreProjectId: '__PROJECT__',
    aiProjectId: 'aip_recorded',
    planId: 'plan_only_in_motir_ai',
    jobId: null,
    planTitle: 'A plan motir-core never stored',
    cardRef: 'ACME-12',
    source: 'in_loop',
    planner: 'hosted',
    authorModel: 'claude-opus',
    authorSessionKey: null,
    baselineBranch: 'main',
    baselineCommit: '33e9b29aa0b1c2d3e4f5',
    site: `leaf:${over.id}`,
    prediction: 'STOPS',
    whatHappened: 'The leaf named a test file that does not exist at main.',
    evidence: 'read_file src/export/csvWriter.test.ts → not found',
    correction: 'Name the test file that exists.',
    outcome: 'fixed',
    rule: 'context-refs-exist',
    attribution: null,
    why: null,
    hostedCell: null,
    planpyCell: null,
    fixDirection: null,
    fingerprint: `fp_${over.id}`,
    status: 'new',
    lessonId: null,
    bugKey: null,
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...over,
  };
}

/** A plan job's result carrying the dry run's two usage lines and its counts. */
export const PRICED_JOB_RESULT: Partial<ResultEnvelope> = {
  stageUsage: [
    {
      stage: 'review',
      model: 'claude-opus',
      inputTokens: 120_000,
      outputTokens: 9_000,
      sessions: 3,
      costMicroUsd: 2_475_000,
    },
    {
      stage: 'repair',
      model: 'claude-opus',
      inputTokens: 40_000,
      outputTokens: 6_000,
      cacheReadTokens: 10_000,
      sessions: 2,
      costMicroUsd: 1_050_000,
    },
  ],
  dryRun: {
    outcome: 'ran',
    counts: { findingsAccepted: 5, fixed: 4, reported: 1, fixFailed: 0 },
  },
};

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Override = (call: FakeCall) => Response | Promise<Response> | undefined;

export interface PlannerFindingsFake {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly calls: FakeCall[];
  readonly findings: Map<string, RawPlannerFinding>;
  readonly jobs: Map<string, { status: string; result: Partial<ResultEnvelope> | null }>;
  readonly lessons: { id: string; request: Record<string, unknown> }[];
  /** Answer a call before the store does; `undefined` falls through to the store. */
  override(fn: Override | null): void;
  /** A deep copy of the store, to compare before and after. */
  snapshot(): string;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function problem(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const FINDING = /^\/v1\/admin\/planner-findings\/([^/]+)$/;
const JOB = /^\/v1\/jobs\/([^/]+)$/;
const TRIAGE_COLUMNS = ['attribution', 'why', 'hostedCell', 'planpyCell', 'fixDirection'] as const;

function newestFirst(a: RawPlannerFinding, b: RawPlannerFinding): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

export function plannerFindingsFake(seed: RawPlannerFinding[] = []): PlannerFindingsFake {
  const findings = new Map(seed.map((f) => [f.id, structuredClone(f)]));
  const jobs: PlannerFindingsFake['jobs'] = new Map();
  const lessons: PlannerFindingsFake['lessons'] = [];
  const calls: FakeCall[] = [];
  let override: Override | null = null;

  function rows(q: Record<string, string>): RawPlannerFinding[] {
    return [...findings.values()]
      .filter(
        (f) =>
          (!q['status'] || f.status === q['status']) &&
          (!q['excludeStatus'] || f.status !== q['excludeStatus']) &&
          (!q['fingerprint'] || f.fingerprint === q['fingerprint']),
      )
      .sort(newestFirst);
  }

  function page<T>(items: T[], key: (t: T) => string, q: Record<string, string>) {
    const limit = Number(q['limit'] ?? 50);
    const start = q['cursor'] ? items.findIndex((i) => key(i) === q['cursor']) + 1 : 0;
    const slice = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return { slice, nextCursor: more ? key(slice[slice.length - 1]!) : null };
  }

  function list(q: Record<string, string>): RawPlannerFindingPage {
    const { slice, nextCursor } = page(rows(q), (f) => f.id, q);
    return { findings: slice, nextCursor, retention: RETENTION };
  }

  function groups(q: Record<string, string>): RawPlannerFindingGroupPage {
    const by = new Map<string, RawPlannerFinding[]>();
    for (const f of rows(q)) by.set(f.fingerprint, [...(by.get(f.fingerprint) ?? []), f]);
    const all: RawPlannerFindingGroup[] = [...by].map(([fingerprint, rs]) => ({
      fingerprint,
      count: rs.length,
      planIds: [...new Set(rs.map((r) => r.planId))],
      latest: rs[0]!,
    }));
    const { slice, nextCursor } = page(all, (g) => g.fingerprint, q);
    return { groups: slice, nextCursor, retention: RETENTION };
  }

  function triage(id: string, body: Record<string, unknown>): RawPlannerFindingTriageResult {
    const before = findings.get(id)!;
    const wanted: Partial<RawPlannerFinding> = {};
    for (const k of TRIAGE_COLUMNS) {
      if (body[k] !== undefined) (wanted as Record<string, unknown>)[k] = body[k];
    }
    if (body['status'] !== undefined) {
      wanted.status = body['status'] as RawPlannerFinding['status'];
      wanted.lessonId = (body['lessonId'] as string | undefined) ?? null;
      wanted.bugKey = (body['bugKey'] as string | undefined) ?? null;
      wanted.triageNote = (body['note'] as string | undefined) ?? null;
    }
    const changed = (Object.keys(wanted) as (keyof RawPlannerFinding)[]).filter(
      (k) => wanted[k] !== before[k],
    );
    if (changed.length === 0) return { finding: before, audit: null };
    const at = '2026-11-06T12:00:00.000Z';
    const after: RawPlannerFinding = {
      ...before,
      ...wanted,
      triagedBy: String(body['actorCoreUserId']),
      triagedAt: at,
    };
    findings.set(id, after);
    const audit: RawPlannerFindingAudit = {
      action: 'ai.planner_finding.triage',
      findingId: id,
      actorCoreUserId: String(body['actorCoreUserId']),
      at,
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
    };
    return { finding: after, audit };
  }

  function createLesson(body: Record<string, unknown>): RawLesson {
    const id = `lsn_fake_${lessons.length + 1}`;
    lessons.push({ id, request: body });
    const text = (k: string) => String(body[k] ?? '');
    return {
      id,
      scope: 'tenant',
      aiProjectId: 'aip_recorded',
      mistakeType: text('mistakeType'),
      title: text('title'),
      body: text('body'),
      why: text('why'),
      howToApply: text('howToApply'),
      sourceRef: null,
      enabled: true,
      createdAt: '2026-11-06T12:00:00.000Z',
      updatedAt: '2026-11-06T12:00:00.000Z',
      lastOccurredAt: '2026-11-06T12:00:00.000Z',
      injected: true,
      injectionBlock: null,
    };
  }

  async function answer(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(String(input));
    const call: FakeCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const forced = override ? await override(call) : undefined;
    if (forced) return forced;

    const { method, path, query, body } = call;
    if (method === 'GET' && path === '/v1/admin/planner-findings') return json(list(query));
    if (method === 'GET' && path === '/v1/admin/planner-findings/groups') {
      return json(groups(query));
    }
    const finding = path.match(FINDING);
    if (finding) {
      const id = decodeURIComponent(finding[1]!);
      if (!findings.has(id)) return problem(404, 'not_found', `planner finding ${id} not found`);
      if (method === 'GET') return json(findings.get(id));
      if (method === 'PATCH') return json(triage(id, body ?? {}));
    }
    if (method === 'POST' && path === '/v1/lessons') return json(createLesson(body ?? {}), 201);
    const job = path.match(JOB);
    if (method === 'GET' && job) {
      const id = decodeURIComponent(job[1]!);
      const held = jobs.get(id);
      if (!held) return problem(404, 'not_found', `job ${id} not found`);
      return json({ jobId: id, status: held.status, result: held.result });
    }
    throw new Error(`unrecorded motir-ai call: ${method} ${path}`);
  }

  return {
    fetch: answer,
    calls,
    findings,
    jobs,
    lessons,
    override(fn) {
      override = fn;
    },
    snapshot() {
      return JSON.stringify({ findings: [...findings], lessons });
    },
  };
}
