import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listFailedGatewayUsageGroups,
  replayFailedGatewayUsageGroup,
  type RawFailedUsageGroup,
  type RawFailedUsageReplayWrite,
} from '@/lib/ai/motirAiClient';
import { MotirAiBadRequestError, MotirAiUnavailableError } from '@/lib/ai/errors';

// MOTIR-11794 — Usage & cost's Failed usage transport: the group read and the
// replay of one group, over motir-ai's `/v1/admin/gateway-usage/failed-groups`.
// A malformed 200 is an outage, never an empty list or a replay of nothing.

const GROUP: RawFailedUsageGroup = {
  error: 'Value out of range for the type integer.',
  rows: 7352,
  organizations: 41,
  oldestReceivedAt: '2026-11-12T03:18:00.000Z',
  newestReceivedAt: '2026-11-14T22:51:00.000Z',
};

const WRITE: RawFailedUsageReplayWrite = {
  replay: { error: GROUP.error, reset: 7352, applied: 7340, failedAgain: 12, pending: 0 },
  audit: {
    action: 'ai.gateway_usage.replay',
    actorCoreUserId: 'u_op',
    at: '2026-11-19T10:00:00.000Z',
    before: { error: GROUP.error, failedRows: 7352, organizations: 41 },
    after: { applied: 7340, failedAgain: 12, pending: 0 },
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function stub(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function call(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls[0] as unknown as [string, RequestInit];
}

beforeEach(() => {
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('listFailedGatewayUsageGroups', () => {
  it('GETs the groups with the service credential', async () => {
    const fetchMock = stub(json({ groups: [GROUP] }));
    expect(await listFailedGatewayUsageGroups()).toEqual([GROUP]);
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/gateway-usage/failed-groups');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer svc-token');
  });

  it('answers an empty read as no groups', async () => {
    stub(json({ groups: [] }));
    expect(await listFailedGatewayUsageGroups()).toEqual([]);
  });

  it.each([
    ['no body', 'not json'],
    ['no groups', {}],
    ['a group missing its count', { groups: [{ ...GROUP, rows: '7352' }] }],
    ['a group that is not an object', { groups: [null] }],
  ])('treats a 200 with %s as an outage', async (_label, body) => {
    stub(
      typeof body === 'string'
        ? new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
        : json(body),
    );
    await expect(listFailedGatewayUsageGroups()).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('maps a problem answer to its typed error', async () => {
    stub(json({ type: 'about:blank', code: 'unauthorized', title: 'x', status: 401 }, 401));
    await expect(listFailedGatewayUsageGroups()).rejects.toBeInstanceOf(Error);
  });
});

describe('replayFailedGatewayUsageGroup', () => {
  it('POSTs the group and the acting staff member, and answers the replay and its audit', async () => {
    const fetchMock = stub(json(WRITE));
    expect(await replayFailedGatewayUsageGroup(GROUP.error, 'u_op')).toEqual(WRITE);
    const [url, init] = call(fetchMock);
    expect(url).toBe('https://ai.test/v1/admin/gateway-usage/failed-groups/replay');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      error: GROUP.error,
      actorCoreUserId: 'u_op',
    });
  });

  it('carries a no-op replay’s null audit through', async () => {
    const noop = {
      replay: { error: 'gone', reset: 0, applied: 0, failedAgain: 0, pending: 0 },
      audit: null,
    };
    stub(json(noop));
    expect(await replayFailedGatewayUsageGroup('gone', 'u_op')).toEqual(noop);
  });

  it.each([
    ['no replay', { audit: null }],
    ['a replay missing a count', { replay: { ...WRITE.replay, pending: null }, audit: null }],
    ['no audit key', { replay: WRITE.replay }],
    ['a replay that is not an object', { replay: 'done', audit: null }],
  ])('treats a 200 with %s as an outage', async (_label, body) => {
    stub(json(body));
    await expect(replayFailedGatewayUsageGroup('x', 'u_op')).rejects.toBeInstanceOf(
      MotirAiUnavailableError,
    );
  });

  it('maps a validation problem to a bad request', async () => {
    stub(
      json(
        {
          type: 'about:blank',
          code: 'validation_error',
          title: 'Invalid',
          status: 400,
          detail: "'error' must be a string",
        },
        400,
      ),
    );
    await expect(replayFailedGatewayUsageGroup('x', 'u_op')).rejects.toBeInstanceOf(
      MotirAiBadRequestError,
    );
  });
});
