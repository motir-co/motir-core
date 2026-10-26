import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

// `GET /api/hosted-runs/models` (MOTIR-6483) — the Run hosted picker's read.
//
// The compliant-session gate is the one thing stubbed (a route test has no
// cookie jar), and `fetch` is stubbed at the motir-ai seam; the route, the
// service and the client are the shipped path.
//
// Pinned: 200 with motir-ai's list for a signed-in member; the gate's own 401
// passed through for a signed-out caller, with motir-ai never asked; and 503
// with the stable `hosted_models_unavailable` code — never a 200 with an empty
// list — when motir-ai cannot answer.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const { GET } = await import('@/app/api/hosted-runs/models/route');

const LIST = {
  models: [{ id: 'claude-opus-5-5', provider: 'anthropic' }],
  default: 'claude-opus-5-5',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  requireCompliantWorkspaceContext.mockResolvedValue({
    ok: true,
    ctx: { userId: 'user_1', workspaceId: 'ws_1' },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/hosted-runs/models', () => {
  it('answers 200 with the offered list for a signed-in member', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(LIST)),
    );
    const res = await GET(new Request('http://localhost/api/hosted-runs/models'));
    expect(res.status).toBe(200);
    // Each model carries its agent-run capacity (MOTIR-9629); the capacity read is
    // not configured here, so every model reads available.
    expect(await res.json()).toEqual({
      ...LIST,
      models: LIST.models.map((m) => ({ ...m, capacity: { verdict: 'available' } })),
    });
  });

  it('answers 401 for a signed-out caller and never asks motir-ai', async () => {
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET(new Request('http://localhost/api/hosted-runs/models'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 with a stable code when motir-ai is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const res = await GET(new Request('http://localhost/api/hosted-runs/models'));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; models?: unknown };
    expect(body.code).toBe('hosted_models_unavailable');
    expect(body).not.toHaveProperty('models');
  });
});
