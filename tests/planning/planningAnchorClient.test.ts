import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPlanningAnchor } from '@/lib/planning/planningAnchorClient';

// MOTIR-4727 — the CLIENT half of the planning-workspace anchor read.
//
// The point of the unit is the three-way split the route test cannot see from
// the server side: a `404` is an ANSWER (there is no anchor you may see) and
// resolves `null`; any other non-`2xx` is a FAILURE and throws; and an abort is
// neither — it propagates so a superseded fetch is distinguishable from a failed
// one. Folding them together is what would make an outage look like a missing
// work item.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ANCHOR = {
  anchor: { id: 'w1', identifier: 'MOTIR-4725', title: 'The overlay', kind: 'story' },
  ancestors: [{ id: 'e1', identifier: 'MOTIR-653', title: 'Epic 8: Launch readiness' }],
  hasChildren: true,
  folders: [{ id: 'f1', name: 'To do' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPlanningAnchor', () => {
  it('returns the anchor and its ancestors on 200, and addresses the route by key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ANCHOR));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPlanningAnchor('MOTIR-4725')).resolves.toEqual(ANCHOR);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/work-items/planning-anchor?key=MOTIR-4725');
    expect(init.headers.Accept).toBe('application/json');
  });

  it('percent-encodes the key rather than pasting it into the query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(ANCHOR));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPlanningAnchor('MOTIR-1&mode=project');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/work-items/planning-anchor?key=MOTIR-1%26mode%3Dproject',
    );
  });

  it('degrades a missing `ancestors` array to `[]` rather than undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ anchor: ANCHOR.anchor })));
    await expect(fetchPlanningAnchor('MOTIR-4725')).resolves.toEqual({
      anchor: ANCHOR.anchor,
      ancestors: [],
      hasChildren: false,
      folders: [],
    });
  });

  it('reads a missing `hasChildren` as a LEAF (MOTIR-7621)', async () => {
    // Arriving beside an item always shows it; arriving inside a childless one
    // shows an empty level. So the unknown case takes the safe arrival.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ anchor: ANCHOR.anchor, ancestors: [] })),
    );
    await expect(fetchPlanningAnchor('MOTIR-4725')).resolves.toMatchObject({
      hasChildren: false,
    });
  });

  it('resolves NULL on 404 — the no-existence-leak answer, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 'NOT_FOUND' }, 404)));
    await expect(fetchPlanningAnchor('MOTIR-99999')).resolves.toBeNull();
  });

  it('THROWS on any other non-2xx — an outage must not read as a missing item', async () => {
    for (const status of [400, 401, 403, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ code: 'NOPE' }, status)));
      await expect(fetchPlanningAnchor('MOTIR-4725')).rejects.toThrow(String(status));
    }
  });

  it('passes the AbortSignal through and lets an abort propagate', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = fetchPlanningAnchor('MOTIR-4725', controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});
