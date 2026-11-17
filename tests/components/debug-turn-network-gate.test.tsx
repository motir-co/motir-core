// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// THE DEBUG TURN'S TWO DOORS, AT THE NETWORK BOUNDARY (Story MOTIR-7042 ·
// MOTIR-7051).
//
// `planning-surface-seed.test.tsx` and `ai-callout-menu.test.tsx` pin the two
// doors against a STUBBED conversation hook — what the host hands the hook, and
// how often. This file removes that stub: the host, the REAL
// `usePlanChangeConversation` and the REAL `planChangeClient` run, and the only
// fake is `fetch` itself. So "sends once" and "sends nothing" are counted as
// requests leaving the browser:
//
//  · the widget's accept → exactly ONE `POST /api/ai/ask`, carrying the report
//    and its triage-bug anchor, read and answered as any turn is — and
//    a reopen on the same page sends no second one;
//  · the orb's "Debug with Motir AI" row → the composer holds the template, and
//    NO request other than the mount's own session READ leaves the page.

vi.mock('next/navigation', () => ({
  usePathname: () => '/backlog',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="review-canvas-stub" />,
}));

import { PlanningWorkspaceHost } from '@/components/planning/PlanningWorkspaceHost';
import { PlanWithAIFab } from '@/components/planning/PlanWithAIFab';
import { resetPickAutoSendClaimsForTests } from '@/lib/planning/pickAutoSend';
import { handSurfaceSeed, resetSurfaceSeedForTests } from '@/lib/planning/surfaceSeed';

const REPORT =
  'Board drag drops the card one column short\n\nDragging a card into the rightmost column puts it in the column to its left.';
const PREFILL = 'Something is broken. What happens: \nWhat should happen instead: ';
const REPLY = 'The diagnosis is on PROD-412, in Triage.';

function turn(seq: number, over: Partial<PlanChangeTurnDto>): PlanChangeTurnDto {
  return {
    id: `t${seq}`,
    seq,
    role: 'user',
    body: REPORT,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'ask',
    intentCorrected: false,
    citations: [],
    authorId: 'u1',
    createdAt: '2026-09-30T10:00:00.000Z',
    ...over,
  } as PlanChangeTurnDto;
}
function thread(turns: PlanChangeTurnDto[]): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    targetKeys: [],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-09-30T10:00:00.000Z',
    origin: 'conversation',
    createdAt: '2026-09-30T09:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    turns,
    workItemRefs: {},
  };
}

// ── The network ───────────────────────────────────────────────────────────────

interface Sent {
  method: string;
  path: string;
  body: unknown;
}
const sent: Sent[] = [];
const posts = () => sent.filter((r) => r.method === 'POST');
const posted = (path: string) => posts().filter((r) => r.path === path);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const sseDone = () =>
  new Response('event: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });

/** The server this page talks to: a project thread with no conversation yet,
 *  and an ask that is answered. Anything else is a 404 — and recorded all the same. */
async function server(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
  sent.push({ method, path: url.pathname, body });

  const user = turn(0, { jobId: 'ask-1', anchorKey: 'PROD-412' } as Partial<PlanChangeTurnDto>);
  if (method === 'GET' && url.pathname === '/api/ai/plan-change/session') {
    return json({ session: null, earlier: null });
  }
  if (method === 'POST' && url.pathname === '/api/ai/ask') {
    return json({ jobId: 'ask-1', turnId: 't0', session: thread([turn(0, { jobId: 'ask-1' })]) });
  }
  if (method === 'GET' && /^\/api\/ai\/ask\/[^/]+\/stream$/.test(url.pathname)) return sseDone();
  if (method === 'POST' && url.pathname === '/api/ai/ask/settle') {
    // Every turn is READ (AMENDMENT 5 · MOTIR-9232): the report's ask job settles
    // as an answer, with no debug job behind it.
    return json({
      outcome: 'answered',
      session: thread([
        user,
        turn(1, {
          role: 'assistant',
          body: REPLY,
          jobId: 'ask-1',
          intent: null,
          citations: ['PROD-412'],
        } as Partial<PlanChangeTurnDto>),
      ]),
    });
  }
  return new Response(null, { status: 404 });
}

function host() {
  return (
    <PlanningWorkspaceHost
      projectKey="PROD"
      projectName="Prod"
      launch={parsePlanningLaunch({ mode: 'project', from: 'project' })}
      anchorId={null}
      onClose={() => {}}
      initialTarget={null}
      canManage={false}
    />
  );
}

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(server));
  resetSurfaceSeedForTests();
  resetPickAutoSendClaimsForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the widget’s accept, counted on the wire', () => {
  it('sends ONE `POST /api/ai/ask` — the report, anchored — and follows it to the answer', async () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    renderWithIntl(host());

    // The authoritative end of the run: the answer is on the thread.
    expect(await screen.findByText(REPLY)).toBeTruthy();

    expect(posted('/api/ai/ask')).toEqual([
      {
        method: 'POST',
        path: '/api/ai/ask',
        body: { body: REPORT, isAnswer: false, anchorKey: 'PROD-412' },
      },
    ]);
    // The ask job alone, settled once: no debug job follows it.
    expect(posted('/api/ai/ask/settle').map((r) => r.body)).toEqual([
      { jobId: 'ask-1', sessionId: 's1' },
    ]);
  });

  it('a REOPEN on the same page sends nothing more', async () => {
    handSurfaceSeed({ kind: 'send', body: REPORT, anchorKey: 'PROD-412' });
    const first = renderWithIntl(host());
    await screen.findByText(REPLY);
    first.unmount();

    const before = sent.length;
    renderWithIntl(host());
    // Wait for the reopened rail's own mount read, then let it settle.
    await waitFor(() => expect(sent.length).toBeGreaterThan(before));
    await act(async () => {});

    expect(posted('/api/ai/ask')).toHaveLength(1);
    expect(sent.slice(before).every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('the orb’s debug row, counted on the wire', () => {
  it('pre-fills the composer and NOTHING but the mount’s session read leaves the page', async () => {
    // The real menu hands the seed…
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(screen.getByRole('button', { name: 'Motir AI' }));
    fireEvent.click(screen.getByRole('link', { name: /Debug with Motir AI/ }));
    expect(sent).toEqual([]);
    cleanup();

    // …and the real surface, with the real conversation hook, takes it.
    renderWithIntl(host());
    await waitFor(() =>
      expect(sent).toContainEqual({
        method: 'GET',
        path: '/api/ai/plan-change/session',
        body: null,
      }),
    );
    await act(async () => {});

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(PREFILL);
    expect(posts()).toEqual([]);
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/ai/plan-change/session']);
  });
});
