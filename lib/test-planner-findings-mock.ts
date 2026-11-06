// E2E boundary seam for motir-ai's PLANNER-FINDINGS admin routes (Story
// MOTIR-10353 · MOTIR-10529): an undici intercept of `{MOTIR_AI_URL}`'s
// `/v1/admin/planner-findings…`, `POST /v1/lessons` and `GET /v1/jobs/:id` for
// the plan jobs the fixture names, installed by `instrumentation.ts` (through
// `lib/test-mock-seams.ts`) behind `E2E_TEST_PLANNER_FINDINGS=1` and dormant
// everywhere else. The same shape as `lib/test-platform-lessons-mock.ts`.
//
// The console's pages are SERVER rendered and every triage act is a Server
// Action, so `page.route` reaches none of it. State lives in a JSON fixture file
// (`MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH`), re-read on every request and
// rewritten by a write: a spec seeds it, drives the page, and reads back what the
// write stored. A request JOURNAL (`MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH`)
// gets one JSON line per request the seam answers.
//
// ⚠️ A TRANSPORT MOCK. The real `motirAiClient`, the real staff gate and the real
// audit transaction all stay in the path. What is SIMULATED is motir-ai's own wire
// behaviour, kept to `src/app.ts` and `src/services/plannerFindingService.ts`
// (`listGroups`, `triageColumns`, `updateTriage`) as read on main — and nothing
// more: no fingerprint hashing, no retention window, no date filters.
//
// ⚠️ THE JOB READ SHARES ITS PATH WITH THE JOBS SEAM. This seam claims a
// `GET /v1/jobs/:id` only when the id is a key of the fixture's `jobs`, and its
// row in the seam table sits BEFORE the jobs seam's, so every other job in the
// lane still falls through to `lib/test-ai-jobs-mock.ts`.
//
// ⚠️ NO IN-MEMORY STATE: every reply is a pure function of the fixture file.

import {
  appendFixtureFileSync,
  readFixtureFileSync,
  writeFixtureFileSync,
} from '@/lib/test-fixture-file';
import {
  PLANNER_FINDING_ATTRIBUTIONS,
  PLANNER_FINDING_OUTCOMES,
  PLANNER_FINDING_PLANNERS,
  PLANNER_FINDING_SOURCES,
  PLANNER_FINDING_STATUSES,
  type RawLesson,
  type RawPlannerFinding,
  type RawPlannerFindingAudit,
  type RawPlannerFindingGroup,
  type RawPlannerFindingGroupPage,
  type RawPlannerFindingPage,
  type RawPlannerFindingRetention,
  type RawPlannerFindingTriageResult,
} from '@/lib/ai/motirAiClient';
import type { ResultEnvelope } from '@/lib/ai/types';
import type { MockAgent } from 'undici';

/** One plan job the seam answers `GET /v1/jobs/:id` for. */
export interface PlannerFindingsFixtureJob {
  /** Defaults to `succeeded`. */
  status?: string;
  /** Served exactly as held — `stageUsage` absent stays absent, never `[]`. */
  result: Partial<ResultEnvelope> | null;
}

export interface PlannerFindingsCreatedLesson {
  id: string;
  request: Record<string, unknown>;
  createdAt: string;
}

export interface PlannerFindingsFixture {
  /** `down` answers every route this seam owns with a 503 problem. */
  mode?: 'live' | 'down';
  findings: RawPlannerFinding[];
  jobs?: Record<string, PlannerFindingsFixtureJob>;
  createdLessons?: PlannerFindingsCreatedLesson[];
}

export interface PlannerFindingsJournalLine {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  /** The parsed request body — on PATCH and POST only. */
  body?: unknown;
}

const RETENTION: RawPlannerFindingRetention = { days: 90, cutoff: null };
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

const FINDINGS_PATH = '/v1/admin/planner-findings';
const GROUPS_PATH = '/v1/admin/planner-findings/groups';
const FINDING_PATH = /^\/v1\/admin\/planner-findings\/([^/]+)$/;
const LESSONS_PATH = '/v1/lessons';
const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;

const json = { headers: { 'content-type': 'application/json' } };
const problemJson = { headers: { 'content-type': 'application/problem+json' } };

type Reply = { statusCode: number; data: object; responseOptions: typeof json };

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

function fixturePath(): string | undefined {
  return process.env['MOTIR_AI_PLANNER_FINDINGS_FIXTURE_PATH'];
}

function journalPath(): string | undefined {
  return process.env['MOTIR_AI_PLANNER_FINDINGS_JOURNAL_PATH'];
}

const EMPTY = (): PlannerFindingsFixture => ({ mode: 'live', findings: [] });

/** An absent, unreadable or half-written fixture reads as an empty live store. */
function readFixture(): PlannerFindingsFixture {
  const p = fixturePath();
  if (!p) return EMPTY();
  try {
    const parsed = JSON.parse(readFixtureFileSync(p)) as Partial<PlannerFindingsFixture> | null;
    if (!parsed || !Array.isArray(parsed.findings)) return EMPTY();
    return parsed as PlannerFindingsFixture;
  } catch {
    return EMPTY();
  }
}

function writeFixture(fixture: PlannerFindingsFixture): void {
  const p = fixturePath();
  if (p) writeFixtureFileSync(p, JSON.stringify(fixture, null, 2));
}

function journal(line: PlannerFindingsJournalLine): void {
  const p = journalPath();
  if (!p) return;
  try {
    appendFixtureFileSync(p, `${JSON.stringify(line)}\n`);
  } catch {
    // A journal is evidence for the spec, never a reason to fail the request.
  }
}

function problem(status: number, code: string, detail: string): Reply {
  return {
    statusCode: status,
    data: { type: 'about:blank', code, title: code, status, detail },
    responseOptions: problemJson,
  };
}

function ok(data: object, statusCode = 200): Reply {
  return { statusCode, data, responseOptions: json };
}

const pathOf = (p: string) => p.split('?')[0]!;

function queryOf(p: string): URLSearchParams {
  return new URL(p, 'http://x').searchParams;
}

function parseBody(raw: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function member<T extends string>(
  q: URLSearchParams,
  key: string,
  values: readonly T[],
): T | undefined {
  const v = q.get(key);
  if (v === null || v === '') return undefined;
  if (!(values as readonly string[]).includes(v)) {
    throw new Refusal(400, 'validation_error', `'${key}' must be one of: ${values.join(', ')}`);
  }
  return v as T;
}

function pageLimit(q: URLSearchParams): number {
  const raw = q.get('limit');
  if (raw === null || raw === '') return PAGE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Refusal(400, 'validation_error', "'limit' must be a positive integer");
  }
  return Math.min(n, PAGE_MAX);
}

/** Newest first by `createdAt`, `id` descending on a tie — motir-ai's list order. */
function newestFirst(a: RawPlannerFinding, b: RawPlannerFinding): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  // Ids are unique, so the tie-break never ties.
  return a.id < b.id ? 1 : -1;
}

/** The rows the list filters keep — shared by the findings and the groups read. */
function filtered(fixture: PlannerFindingsFixture, q: URLSearchParams): RawPlannerFinding[] {
  const source = member(q, 'source', PLANNER_FINDING_SOURCES);
  const planner = member(q, 'planner', PLANNER_FINDING_PLANNERS);
  const attribution = member(q, 'attribution', PLANNER_FINDING_ATTRIBUTIONS);
  const outcome = member(q, 'outcome', PLANNER_FINDING_OUTCOMES);
  const status = member(q, 'status', PLANNER_FINDING_STATUSES);
  const excludeStatus = member(q, 'excludeStatus', PLANNER_FINDING_STATUSES);
  const fingerprint = q.get('fingerprint') || undefined;
  return fixture.findings
    .filter(
      (f) =>
        (source === undefined || f.source === source) &&
        (planner === undefined || f.planner === planner) &&
        (attribution === undefined || (f.attribution ?? 'unattributed') === attribution) &&
        (outcome === undefined || f.outcome === outcome) &&
        (fingerprint === undefined || f.fingerprint === fingerprint) &&
        (status === undefined || f.status === status) &&
        (excludeStatus === undefined || f.status !== excludeStatus),
    )
    .sort(newestFirst);
}

/** One cursor page: the cursor is the last item's key, opaque to the caller. */
function paged<T>(
  items: T[],
  keyOf: (item: T) => string,
  q: URLSearchParams,
): { page: T[]; nextCursor: string | null } {
  const limit = pageLimit(q);
  const cursor = q.get('cursor');
  let start = 0;
  if (cursor) {
    const at = items.findIndex((item) => keyOf(item) === cursor);
    if (at < 0) throw new Refusal(400, 'validation_error', "'cursor' is not a page this list gave");
    start = at + 1;
  }
  const page = items.slice(start, start + limit);
  const more = start + limit < items.length;
  return { page, nextCursor: more && page.length > 0 ? keyOf(page[page.length - 1]!) : null };
}

function listFindings(q: URLSearchParams): RawPlannerFindingPage {
  const { page, nextCursor } = paged(filtered(readFixture(), q), (f) => f.id, q);
  return { findings: page, nextCursor, retention: RETENTION };
}

function listGroups(q: URLSearchParams): RawPlannerFindingGroupPage {
  const byFingerprint = new Map<string, RawPlannerFinding[]>();
  for (const row of filtered(readFixture(), q)) {
    const rows = byFingerprint.get(row.fingerprint) ?? [];
    rows.push(row);
    byFingerprint.set(row.fingerprint, rows);
  }
  const groups: RawPlannerFindingGroup[] = [...byFingerprint].map(([fingerprint, rows]) => ({
    fingerprint,
    count: rows.length,
    planIds: [...new Set(rows.map((r) => r.planId))],
    // `filtered` sorts newest first, so the first row is the newest.
    latest: rows[0]!,
  }));
  groups.sort(
    (a, b) => newestFirst(a.latest, b.latest) || (a.fingerprint < b.fingerprint ? -1 : 1),
  );
  const { page, nextCursor } = paged(groups, (g) => g.fingerprint, q);
  return { groups: page, nextCursor, retention: RETENTION };
}

type TriageColumns = Partial<
  Pick<
    RawPlannerFinding,
    | 'attribution'
    | 'why'
    | 'hostedCell'
    | 'planpyCell'
    | 'fixDirection'
    | 'status'
    | 'lessonId'
    | 'bugKey'
    | 'triageNote'
  >
>;

const TRIAGE_FIELDS = [
  'attribution',
  'why',
  'hostedCell',
  'planpyCell',
  'fixDirection',
  'status',
  'lessonId',
  'bugKey',
  'note',
] as const;
const TEXT_FIELDS = ['why', 'hostedCell', 'planpyCell', 'fixDirection'] as const;

/** A present string must be non-blank; absent is `undefined`. The strict reading. */
function text(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Refusal(400, 'validation_error', `'${key}' must be a non-empty string`);
  }
  return v;
}

function bodyMember<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    throw new Refusal(400, 'validation_error', `'${key}' must be one of: ${values.join(', ')}`);
  }
  return v as T;
}

/** motir-ai's `triageColumns`: a status carries exactly its own id and clears the others. */
function triageColumns(body: Record<string, unknown>): TriageColumns {
  if (TRIAGE_FIELDS.every((k) => body[k] === undefined)) {
    throw new Refusal(
      400,
      'validation_error',
      `at least one of ${TRIAGE_FIELDS.join(', ')} is required`,
    );
  }
  const columns: TriageColumns = {};
  const attribution = bodyMember(body, 'attribution', PLANNER_FINDING_ATTRIBUTIONS);
  if (attribution) columns.attribution = attribution;
  for (const k of TEXT_FIELDS) {
    const v = text(body, k);
    if (v !== undefined) columns[k] = v;
  }
  const lessonId = text(body, 'lessonId');
  const bugKey = text(body, 'bugKey');
  const note = text(body, 'note');
  const status = bodyMember(body, 'status', PLANNER_FINDING_STATUSES);
  if (status === undefined) {
    if (lessonId !== undefined || bugKey !== undefined || note !== undefined) {
      throw new Refusal(
        400,
        'validation_error',
        "'lessonId', 'bugKey' and 'note' are set with the 'status' they belong to",
      );
    }
    return columns;
  }
  if (status === 'promoted_to_lesson' && lessonId === undefined) {
    throw new Refusal(400, 'validation_error', "'lessonId' is required for promoted_to_lesson");
  }
  if (status === 'filed_as_bug' && bugKey === undefined) {
    throw new Refusal(400, 'validation_error', "'bugKey' is required for filed_as_bug");
  }
  if (lessonId !== undefined && status !== 'promoted_to_lesson') {
    throw new Refusal(400, 'validation_error', "'lessonId' belongs to promoted_to_lesson only");
  }
  if (bugKey !== undefined && status !== 'filed_as_bug') {
    throw new Refusal(400, 'validation_error', "'bugKey' belongs to filed_as_bug only");
  }
  if (note !== undefined && status !== 'dismissed') {
    throw new Refusal(400, 'validation_error', "'note' belongs to dismissed only");
  }
  return {
    ...columns,
    status,
    lessonId: lessonId ?? null,
    bugKey: bugKey ?? null,
    triageNote: note ?? null,
  };
}

/**
 * motir-ai's `updateTriage`, minus the fingerprint recompute: a write whose every
 * given column equals the stored one stores nothing and answers `audit: null`.
 */
function triage(id: string, body: Record<string, unknown>): RawPlannerFindingTriageResult {
  const actor = body['actorCoreUserId'];
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw new Refusal(400, 'validation_error', "'actorCoreUserId' is required");
  }
  const columns = triageColumns(body);
  const fixture = readFixture();
  const finding = fixture.findings.find((f) => f.id === id);
  if (!finding) throw new Refusal(404, 'not_found', `planner finding ${id} not found`);

  const changed = (Object.keys(columns) as (keyof TriageColumns)[]).filter(
    (k) => columns[k] !== undefined && columns[k] !== finding[k],
  );
  if (changed.length === 0) return { finding, audit: null };

  const at = new Date().toISOString();
  const before = Object.fromEntries(changed.map((k) => [k, finding[k]]));
  Object.assign(finding, Object.fromEntries(changed.map((k) => [k, columns[k]])));
  finding.triagedBy = actor;
  finding.triagedAt = at;
  finding.updatedAt = at;
  writeFixture(fixture);
  const audit: RawPlannerFindingAudit = {
    action: 'ai.planner_finding.triage',
    findingId: id,
    actorCoreUserId: actor,
    at,
    before,
    after: Object.fromEntries(changed.map((k) => [k, finding[k]])),
  };
  return { finding, audit };
}

/** `POST /v1/lessons`: append the request, answer a lesson echoing it. */
function createLesson(body: Record<string, unknown>): RawLesson {
  const fixture = readFixture();
  const created = fixture.createdLessons ?? [];
  const id = `les_pf_${created.length + 1}`;
  const createdAt = new Date().toISOString();
  created.push({ id, request: body, createdAt });
  fixture.createdLessons = created;
  writeFixture(fixture);
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '');
  return {
    id,
    scope: 'tenant',
    aiProjectId: `aip_${str('coreProjectId')}`,
    mistakeType: str('mistakeType'),
    title: str('title'),
    body: str('body'),
    why: str('why'),
    howToApply: str('howToApply'),
    categories: [],
    sourceRef: typeof body['sourceRef'] === 'string' ? body['sourceRef'] : null,
    enabled: true,
    createdAt,
    updatedAt: createdAt,
    lastOccurredAt: createdAt,
    recurrenceCount: 1,
    injected: true,
    injectionBlock: null,
  };
}

/** Run one route: down mode, typed refusals and the journal, in one place. */
function answer(
  req: { path: unknown; method: string; body?: unknown },
  handle: (path: string, q: URLSearchParams, body: Record<string, unknown> | null) => Reply,
): Reply {
  const raw = String(req.path);
  const path = pathOf(raw);
  const q = queryOf(raw);
  const method = String(req.method).toUpperCase();
  const withBody = method === 'PATCH' || method === 'POST';
  const body = withBody ? parseBody(req.body) : null;
  let reply: Reply;
  if (readFixture().mode === 'down') {
    reply = problem(503, 'service_unavailable', 'motir-ai is down (planner-findings fixture)');
  } else {
    try {
      reply = handle(path, q, body);
    } catch (err) {
      // Only motir-ai's own refusals are answers; anything else is a bug in this fake.
      if (!(err instanceof Refusal)) throw err;
      reply = problem(err.status, err.code, err.message);
    }
  }
  journal({
    method,
    path,
    query: Object.fromEntries(q),
    status: reply.statusCode,
    ...(withBody ? { body: body ?? String(req.body) } : {}),
  });
  return reply;
}

/** Is this job id one the fixture names? Cheap, and never throws. */
function namedJob(path: string): string | null {
  const m = pathOf(path).match(JOB_PATH);
  if (!m) return null;
  const id = decodeURIComponent(m[1]!);
  const jobs = readFixture().jobs;
  return jobs && Object.prototype.hasOwnProperty.call(jobs, id) ? id : null;
}

export function installPlannerFindingsBoundaryMock(agent: MockAgent): void {
  const origin = (process.env['MOTIR_AI_URL'] ?? '').replace(/\/+$/, '');
  if (!origin) return;
  const pool = agent.get(origin);

  // GET /v1/admin/planner-findings/groups — registered BEFORE the id route, as
  // motir-ai's app registers it, so `groups` is never read as an id.
  pool
    .intercept({ path: (p: string) => pathOf(p) === GROUPS_PATH, method: 'GET' })
    .reply<object>((req) => answer(req, (_p, q) => ok(listGroups(q))))
    .persist();

  // GET /v1/admin/planner-findings — one cursor page, newest first.
  pool
    .intercept({ path: (p: string) => pathOf(p) === FINDINGS_PATH, method: 'GET' })
    .reply<object>((req) => answer(req, (_p, q) => ok(listFindings(q))))
    .persist();

  // GET · PATCH /v1/admin/planner-findings/:id
  for (const method of ['GET', 'PATCH'] as const) {
    pool
      .intercept({
        path: (p: string) => pathOf(p) !== GROUPS_PATH && FINDING_PATH.test(pathOf(p)),
        method,
      })
      .reply<object>((req) =>
        answer({ ...req, method }, (path, _q, body) => {
          const id = decodeURIComponent(path.match(FINDING_PATH)![1]!);
          if (method === 'GET') {
            const finding = readFixture().findings.find((f) => f.id === id);
            return finding
              ? ok(finding)
              : problem(404, 'not_found', `planner finding ${id} not found`);
          }
          if (!body) return problem(400, 'validation_error', 'body is not JSON');
          return ok(triage(id, body));
        }),
      )
      .persist();
  }

  // POST /v1/lessons — the promote's lesson create.
  pool
    .intercept({ path: (p: string) => pathOf(p) === LESSONS_PATH, method: 'POST' })
    .reply<object>((req) =>
      answer({ ...req, method: 'POST' }, (_p, _q, body) =>
        body ? ok(createLesson(body), 201) : problem(400, 'validation_error', 'body is not JSON'),
      ),
    )
    .persist();

  // GET /v1/jobs/:id — ONLY for the plan jobs the fixture names; every other id
  // falls through to the jobs seam, registered after this one.
  pool
    .intercept({ path: (p: string) => namedJob(p) !== null, method: 'GET' })
    .reply<object>((req) =>
      answer({ ...req, method: 'GET' }, (path) => {
        const jobId = namedJob(path);
        const job = jobId ? readFixture().jobs?.[jobId] : undefined;
        // Named when undici matched; gone only if the spec rewrote the fixture since.
        if (!jobId || !job) return problem(404, 'not_found', `job ${path} not found`);
        return ok({ jobId, status: job.status ?? 'succeeded', result: job.result });
      }),
    )
    .persist();
}
