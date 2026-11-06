import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPlannerFinding,
  type CreatePlannerFindingRequest,
  type RawPlannerFinding,
} from '@/lib/ai/motirAiClient';
import {
  MotirAiBadRequestError,
  MotirAiConfigError,
  MotirAiUnauthorizedError,
  MotirAiUnavailableError,
} from '@/lib/ai/errors';

// THE PLANNER-FINDING SEAM (Subtask MOTIR-10385 · Story MOTIR-10354) — the
// `motirAiClient` function onto motir-ai's `POST /v1/admin/planner-findings`.
//
// Three properties carry this card, and a status assertion shows none of them:
//
//   1. The field names cross a repo boundary as strings, so the test asserts the
//      SERIALIZED body, key by key.
//   2. An omitted optional is ABSENT from the JSON (motir-ai's `optional()`
//      refuses a present blank), and nothing outside the request type — `jobId`,
//      `status`, `fingerprint`, `aiProjectId`… — ever reaches the wire.
//   3. ONE request per call. The route is not idempotent, so a retry could store
//      a duplicate row: asserted as the `fetch` mock's CALL COUNT on a failure.

const AI_URL = 'http://motir-ai.test';
const TOKEN = 'svc_token';

const REQUIRED: CreatePlannerFindingRequest = {
  coreOrganizationId: 'org_1',
  coreWorkspaceId: 'ws_1',
  coreProjectId: 'pj_1',
  planId: 'plan_1',
  source: 'check_plan',
  planner: 'plan_py',
  site: 'MOTIR-12 acceptance criterion 3',
  prediction: 'STOPS',
  whatHappened: 'The runner would stop: the criterion reads the deployment.',
  evidence: 'lib/runner/rules.ts:42 at 4af7d93',
  outcome: 'reported',
};

const OPTIONALS = {
  planTitle: 'Plan title',
  cardRef: 'MOTIR-12',
  authorModel: 'model-x',
  authorSessionKey: 'session-1',
  baselineBranch: 'main',
  baselineCommit: '4af7d93',
  correction: 'Split the criterion at the deploy boundary.',
  attribution: 'corpus',
  why: 'The pack never names the deploy boundary.',
  hostedCell: 'author/criteria',
  planpyCell: 'author:subtask',
  fixDirection: 'Add a rule to kind-container.md.',
  rule: 'plan-rules/kind-container.md:12',
} satisfies Partial<CreatePlannerFindingRequest>;

const FORBIDDEN_KEYS = [
  'aiProjectId',
  'status',
  'fingerprint',
  'jobId',
  'lessonId',
  'bugKey',
] as const;

function storedRow(over: Partial<RawPlannerFinding> = {}): RawPlannerFinding {
  return {
    ...REQUIRED,
    id: 'pf_1',
    source: 'check_plan',
    planner: 'plan_py',
    site: REQUIRED.site,
    fingerprint: 'f'.repeat(64),
    status: 'new',
    planId: 'plan_1',
    aiProjectId: 'aip_1',
    jobId: null,
    planTitle: null,
    cardRef: null,
    authorModel: null,
    authorSessionKey: null,
    baselineBranch: null,
    baselineCommit: null,
    correction: null,
    rule: null,
    why: null,
    hostedCell: null,
    planpyCell: null,
    fixDirection: null,
    lessonId: null,
    bugKey: null,
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    createdAt: '2026-11-06T12:00:00.000Z',
    updatedAt: '2026-11-06T12:00:00.000Z',
    attribution: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problem(code: string, status: number, detail: string): Response {
  return jsonResponse({ type: 'about:blank', code, title: code, status, detail }, status);
}

function stub(response: Response | Error): ReturnType<typeof vi.fn> {
  const fetchMock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0]![1].body as string);
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', AI_URL);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('createPlannerFinding — the request on the wire', () => {
  it('POSTs once to /v1/admin/planner-findings with the bearer token and a JSON body', async () => {
    const fetchMock = stub(jsonResponse(storedRow(), 201));

    await createPlannerFinding(REQUIRED);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${AI_URL}/v1/admin/planner-findings`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(typeof init.body).toBe('string');
  });

  it('serializes exactly the required fields when no optional is supplied', async () => {
    const fetchMock = stub(jsonResponse(storedRow(), 201));

    await createPlannerFinding(REQUIRED);

    const body = sentBody(fetchMock);
    expect(body).toEqual(REQUIRED);
    for (const key of Object.keys(OPTIONALS)) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('carries every optional field the caller supplied, by its exact name', async () => {
    const fetchMock = stub(jsonResponse(storedRow(), 201));

    await createPlannerFinding({ ...REQUIRED, ...OPTIONALS });

    expect(sentBody(fetchMock)).toEqual({ ...REQUIRED, ...OPTIONALS });
  });

  it('leaves out an optional set to undefined — absent, never null', async () => {
    const fetchMock = stub(jsonResponse(storedRow(), 201));

    await createPlannerFinding({ ...REQUIRED, cardRef: 'MOTIR-12', planTitle: undefined });

    const raw = fetchMock.mock.calls[0]![1].body as string;
    expect(raw).not.toContain('null');
    expect(sentBody(fetchMock)).toEqual({ ...REQUIRED, cardRef: 'MOTIR-12' });
  });

  it('never sends a key outside the request type, whatever is cast onto the input', async () => {
    const fetchMock = stub(jsonResponse(storedRow(), 201));
    const polluted = {
      ...REQUIRED,
      ...Object.fromEntries(FORBIDDEN_KEYS.map((k) => [k, `x_${k}`])),
    } as unknown as CreatePlannerFindingRequest;

    await createPlannerFinding(polluted);

    const body = sentBody(fetchMock);
    for (const key of FORBIDDEN_KEYS) {
      expect(body).not.toHaveProperty(key);
    }
    expect(Object.keys(body).sort()).toEqual(Object.keys(REQUIRED).sort());
  });

  it('cannot form an in_loop request: source is the literal check_plan', async () => {
    const fetchMock = stub(jsonResponse(storedRow(), 201));
    // @ts-expect-error — `source` is the literal type 'check_plan'.
    const inLoop: CreatePlannerFindingRequest = { ...REQUIRED, source: 'in_loop' };
    expect(inLoop.source).toBe('in_loop');

    await createPlannerFinding(REQUIRED);
    expect(sentBody(fetchMock)['source']).toBe('check_plan');
  });
});

describe('createPlannerFinding — the answer', () => {
  it('resolves a 201 with a string id to the stored row', async () => {
    const row = storedRow({ id: 'pf_42', fingerprint: 'abc', status: 'new' });
    stub(jsonResponse(row, 201));

    const result = await createPlannerFinding(REQUIRED);

    expect(result).toEqual(row);
    expect(result.id).toBe('pf_42');
    expect(result.source).toBe('check_plan');
    expect(result.fingerprint).toBe('abc');
    expect(result.status).toBe('new');
  });

  it('throws MotirAiUnavailableError on a 2xx whose body has no string id', async () => {
    stub(jsonResponse({ ...storedRow(), id: 7 }, 201));

    await expect(createPlannerFinding(REQUIRED)).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('maps a 400 validation_error to MotirAiBadRequestError naming the field', async () => {
    stub(problem('validation_error', 400, "'prediction' must be one of: STOPS, SETTLES, THRU"));

    const err = await createPlannerFinding(REQUIRED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MotirAiBadRequestError);
    expect((err as Error).message).toContain("'prediction' must be one of");
  });

  it.each([
    [401, 'service_unauthorized'],
    [403, 'permission_denied'],
  ])('maps a %i %s problem to MotirAiUnauthorizedError', async (status, code) => {
    stub(problem(code, status, `upstream said ${code}`));

    const err = await createPlannerFinding(REQUIRED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MotirAiUnauthorizedError);
    expect((err as Error).message).toContain(`upstream said ${code}`);
  });

  it('maps a 5xx to MotirAiUnavailableError with the upstream reason, after ONE request', async () => {
    const fetchMock = stub(problem('internal_error', 503, 'store is restarting'));

    const err = await createPlannerFinding(REQUIRED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MotirAiUnavailableError);
    expect((err as Error).message).toContain('store is restarting');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a transport failure to MotirAiUnavailableError with its code, after ONE request', async () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    });
    const fetchMock = stub(failure);

    const err = await createPlannerFinding(REQUIRED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MotirAiUnavailableError);
    expect((err as Error).message).toContain('ECONNREFUSED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a timeout to MotirAiUnavailableError naming the deadline, after ONE request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = createPlannerFinding(REQUIRED).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await pending;

    expect(err).toBeInstanceOf(MotirAiUnavailableError);
    expect((err as Error).message).toContain('did not respond within');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('createPlannerFinding — configuration', () => {
  it.each(['MOTIR_AI_URL', 'MOTIR_AI_SERVICE_TOKEN'])(
    'throws MotirAiConfigError and makes no request when %s is unset',
    async (name) => {
      vi.stubEnv(name, '');
      const fetchMock = stub(jsonResponse(storedRow(), 201));

      await expect(createPlannerFinding(REQUIRED)).rejects.toBeInstanceOf(MotirAiConfigError);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
