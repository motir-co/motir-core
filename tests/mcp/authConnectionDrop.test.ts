import type net from 'node:net';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, dbPool } from '@/lib/db';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { oauthConnectionsService } from '@/lib/services/oauthConnectionsService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { OAuthAccessTokenRejectedError } from '@/lib/oauth/errors';
import {
  MCP_AUTH_RETRY_AFTER_SECONDS,
  McpAuthUnavailableError,
  verifyMcpToken,
} from '@/lib/mcp/auth';
import { DEFAULT_TOKEN_GRANT } from '@/lib/tokens/grant';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { trackServerWork } from '../helpers/serverWork';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/nextjs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/nextjs')>()),
  captureException: sentry.captureException,
}));

// MOTIR-10168 — `/api/mcp` answered 401 `invalid_token` to a VALID token whenever
// the token check's database connection dropped. `withMcpAuth` (mcp-handler
// 1.1.0) catches every throw out of the verifier, `console.error`s it and answers
// the same 401 a bad token gets, so on 2026-10-26 a Fly machine waking from
// suspend told every MCP client its credential was rejected, and nothing reached
// Sentry.
//
// The first case below is the production shape, on the REAL `@/lib/db` pool: the
// sockets under its idle clients are destroyed and the request arrives before the
// pool has noticed, so the token lookup is written to a dead connection. Before
// the fix that request answered 401. The errors the other cases feed the verifier
// are the driver's own message for that drop (`Connection terminated
// unexpectedly`), which `tests/ideas/publicIdeasConnectionDrop.test.ts` measures
// coming out of the real driver and `isConnectionError` classifies.

/** What `pg` raises when the socket under an in-flight query closes. */
const connectionDropped = () => new Error('Connection terminated unexpectedly');

beforeEach(async () => {
  await truncateAuthTables();
  sentry.captureException.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function mintToken(): Promise<string> {
  const fx = await makeWorkItemFixture();
  const { token } = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
    label: 'mcp-connection-drop',
    fixedGrant: DEFAULT_TOKEN_GRANT,
  });
  return token;
}

async function post(token: string): Promise<Response> {
  const { POST } = await import('@/app/api/mcp/route');
  return trackServerWork(
    POST(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }) as never,
    ),
    'POST /api/mcp',
  );
}

const bare = () => new Request('http://localhost/api/mcp', { method: 'POST' });

describe('POST /api/mcp on a pooled connection that is already dead', () => {
  it('serves the request — the token lookup is retried once on a fresh connection', async () => {
    const token = await mintToken();
    const pool = dbPool();
    expect(pool, 'the app pool is measurable').not.toBeNull();
    const handedOut = new Set<PoolClient>();
    const track = (client: PoolClient) => void handedOut.add(client);
    pool!.on('acquire', track);
    try {
      expect((await post(token)).status).toBe(200); // warm the pool
    } finally {
      pool!.off('acquire', track);
    }
    expect(handedOut.size).toBeGreaterThan(0);

    const verify = vi.spyOn(apiTokensService, 'verify');
    // The intermediary hangs up; the request arrives before the pool notices.
    for (const client of handedOut) {
      (client as unknown as { connection: { stream: net.Socket } }).connection.stream.destroy();
    }
    const res = await post(token);

    expect(res.status).toBe(200);
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.text()).toContain('"tools"'); // the tools/list answer, as an SSE event
    expect(verify).toHaveBeenCalledTimes(2); // the dropped attempt, then the retry
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('a token check that loses its connection', () => {
  it('once: the PAT arm retries and resolves the actor', async () => {
    const token = await mintToken();
    const verify = vi.spyOn(apiTokensService, 'verify').mockRejectedValueOnce(connectionDropped());

    const info = await verifyMcpToken(bare(), token);

    expect(info?.token).toBe(token);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('twice: the PAT arm raises McpAuthUnavailableError carrying the driver error', async () => {
    const dropped = connectionDropped();
    vi.spyOn(apiTokensService, 'verify').mockRejectedValue(dropped);

    const err = await verifyMcpToken(bare(), 'motir_pat_any').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpAuthUnavailableError);
    expect((err as McpAuthUnavailableError).code).toBe('MCP_AUTH_UNAVAILABLE');
    expect((err as Error).cause).toBe(dropped);
  });

  it('twice: the route answers 503 with Retry-After — never 401 — and reports it to Sentry', async () => {
    const token = await mintToken();
    const verify = vi.spyOn(apiTokensService, 'verify').mockRejectedValue(connectionDropped());

    const res = await post(token);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(MCP_AUTH_RETRY_AFTER_SECONDS));
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'MCP_AUTH_UNAVAILABLE' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException.mock.calls[0]![0]).toBeInstanceOf(McpAuthUnavailableError);
  });

  it('on the OAuth arm: once is retried, and twice answers 503', async () => {
    const resolve = vi
      .spyOn(oauthConnectionsService, 'resolveAccessToken')
      .mockRejectedValueOnce(connectionDropped())
      .mockRejectedValueOnce(new OAuthAccessTokenRejectedError('unknown'));

    // The retry ran and reached a real refusal, which is still the plain 401.
    expect(await verifyMcpToken(bare(), 'oauth-access-token')).toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(2);

    resolve.mockReset().mockRejectedValue(connectionDropped());
    const res = await post('oauth-access-token');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(MCP_AUTH_RETRY_AFTER_SECONDS));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('what is not a dropped connection keeps its answer', () => {
  it('an unknown, revoked or expired token is still 401 with WWW-Authenticate', async () => {
    const fx = await makeWorkItemFixture();
    const revoked = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'revoked',
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });
    await apiTokensService.deleteToken(fx.ownerId, revoked.dto.id);
    const expired = await apiTokensService.create(fx.ownerId, fx.workspaceId, {
      label: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
      fixedGrant: DEFAULT_TOKEN_GRANT,
    });

    for (const token of ['motir_pat_deadbeef', revoked.token, expired.token]) {
      const res = await post(token);
      expect(res.status, token.slice(0, 14)).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer /);
      expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    }
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('a refusal is not retried', async () => {
    const lookup = vi.spyOn(apiTokenRepository, 'findByTokenHash');
    expect(await verifyMcpToken(bare(), 'motir_pat_deadbeef')).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('any other error is a fault the route re-throws, not a 401 and not a retry', async () => {
    const token = await mintToken();
    const fault = new Error('a defect, not a dropped connection');
    const verify = vi.spyOn(apiTokensService, 'verify').mockRejectedValue(fault);

    await expect(post(token)).rejects.toBe(fault);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});
