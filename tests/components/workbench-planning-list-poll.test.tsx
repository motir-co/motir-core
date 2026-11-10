// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import type { WorkbenchPlanningPageDto, WorkbenchPlanningRowDto } from '@/lib/dto/home';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';

// THE PLANNING TAB'S LIVE ISLAND — the poll's remaining arms (Story MOTIR-7820 ·
// MOTIR-7832, the story's coverage floor). `workbench-planning-tab.test.tsx`
// (MOTIR-7831) proves the island's behaviour; these are the arms of
// `PlanningList.tsx` it leaves unreached, each a real thing the network or the
// document can do:
//   · a read that ANSWERS but not 200 — a dropped read like a rejected one;
//   · an outcome read that finds the plan STILL generating — the row is dropped quietly;
//   · a row held across two polls — its outcome is read ONCE, not per poll;
//   · a tick behind a read still out — no second read until it settles;
//   · a `visibilitychange` to HIDDEN — no read;
//   · leaving the tab with a read in flight — the read is aborted;
// `PlanningRow`'s title door (a plain click opens the target's quick view), and
// `planningOutcomeOf`'s one unread arm, a plan APPROVED between two polls.
//
// The island's own unreachable arms are named in `vitest.coverage.plan-progress.config.ts`.

const { push, refresh, shallowPush } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  shallowPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push, prefetch: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams('tab=planning'),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush, shallowReplace: vi.fn() }));

const { PlanningList } = await import('../../app/(authed)/workbench/_components/PlanningList');
const { TabWindowHarness, planningWindowAnswer } = await import('../helpers/workbenchTabWindow');
const { planningOutcomeOf } =
  await import('../../app/(authed)/workbench/_components/planningOutcome');
const { PLANNING_TAB_CEILING } = await import('@/lib/services/workbenchPlanningService');

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function progress(): PlanProgressSnapshot {
  return {
    startedAt: iso(T0 - 180_000),
    lastActivityAt: iso(T0 - 5_000),
    observedAt: iso(T0),
    authored: 1,
    proposed: 5,
    autoResume: null,
    steps: [],
  };
}

function row(planId: string): WorkbenchPlanningRowDto {
  return {
    planId,
    sessionId: `sess-${planId}`,
    title: null,
    projectName: 'Acme Web',
    targets: [{ key: 'ACME-12', title: 'Per-key API quotas' }],
    author: { source: 'native', harness: null, model: null, origin: 'user' },
    createdAt: iso(T0 - 180_000),
    progress: progress(),
  };
}

function page(items: WorkbenchPlanningRowDto[], total = items.length): WorkbenchPlanningPageDto {
  return { items, total, page: 1, pageSize: PLANNING_TAB_CEILING };
}

function mount(seed: WorkbenchPlanningPageDto) {
  // Under the Workbench's one read (MOTIR-8581): a poll tick is its `reread()`.
  return renderWithIntl(
    <TabWindowHarness tab="planning">
      <PlanningList
        seed={seed}
        projectName="Acme Web"
        label="Planning"
        empty={<p>No plans being written</p>}
      />
    </TabWindowHarness>,
    { locale: 'en', messages: en },
  );
}

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** The Planning read's answer — the one window read, carrying `body` as its page. */
const planning = (body: WorkbenchPlanningPageDto) => json(planningWindowAnswer(body));

async function poll(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await act(async () => {});
  }
}

beforeEach(() => {
  push.mockReset();
  refresh.mockReset();
  shallowPush.mockReset();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PlanningList — the poll’s remaining arms', () => {
  it('a read that answers 500 is a dropped read: the rows stand, and three say so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ code: 'INTERNAL' }, 500)),
    );
    mount(page([row('p1')]));

    await poll(2);
    expect(screen.getByTestId('plan-progress-compact').textContent).not.toContain('Reconnecting');
    await poll();
    expect(screen.getByTestId('plan-progress-compact').textContent).toContain('Reconnecting');
    expect(screen.getByTestId('planning-row-p1')).toBeTruthy();
  });

  it('a held row whose plan is STILL generating is dropped quietly, never labelled "no longer being written"', async () => {
    const fetchMock = vi.fn(async (input: string) =>
      String(input) === '/api/plans/p1'
        ? json({ status: 'generating', decisionReason: null })
        : planning(page([row('p2')], 1)),
    );
    vi.stubGlobal('fetch', fetchMock);
    mount(page([row('p1'), row('p2')], 2));

    await poll(2);
    // It left the window, it did not finish: the row goes, with no outcome line.
    expect(screen.queryByTestId('planning-row-p1')).toBeNull();
    expect(screen.getByTestId('planning-row-p2')).toBeTruthy();
    expect(document.body.textContent).not.toContain('No longer being written');
    // Two polls ran; the plan was read once.
    const planReads = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/plans/p1');
    expect(planReads).toHaveLength(1);
  });

  it('a still-generating answer that lands after the row is back in the window leaves it alone', async () => {
    let answer: ((res: Response) => void) | null = null;
    const slow = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input) === '/api/plans/p1') return slow;
        polls += 1;
        return planning(polls === 1 ? page([row('p2')], 1) : page([row('p1'), row('p2')], 2));
      }),
    );
    mount(page([row('p1'), row('p2')], 2));

    await poll(2);
    expect(screen.getByTestId('planning-row-p1').dataset['held']).not.toBe('true');
    await act(async () => {
      answer?.(json({ status: 'generating', decisionReason: null }));
    });
    expect(screen.getByTestId('planning-row-p1')).toBeTruthy();
  });

  it('a tick behind a read still out starts no second read; one follows once it settles', async () => {
    let fail: ((err: Error) => void) | null = null;
    const slow = new Promise<never>((_, reject) => {
      fail = reject;
    });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return slow;
      return planning(page([row('p1')], 1));
    });
    vi.stubGlobal('fetch', fetchMock);
    mount(page([row('p1')], 1));

    await poll(); // read 1, still in flight
    await poll(); // behind it: no second read (MOTIR-8102's rule, the window hook's)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      fail?.(new Error('offline'));
    });
    await act(async () => {});
    // The pending tick reads once the first settles, and a success clears the run.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await poll(2);
    expect(screen.getByTestId('plan-progress-compact').textContent).not.toContain('Reconnecting');
  });

  it('a `visibilitychange` to HIDDEN starts no read', async () => {
    const fetchMock = vi.fn(async () => planning(page([row('p1')], 1)));
    vi.stubGlobal('fetch', fetchMock);
    mount(page([row('p1')], 1));

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it('leaving the tab with a read in flight aborts it, and its late answer changes nothing', async () => {
    let resolve: ((res: Response) => void) | null = null;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((r) => {
          resolve = r;
        });
      }),
    );
    const view = mount(page([row('p1')], 1));

    await poll();
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolve?.(planning(page([row('p1'), row('p2')], 2)));
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('PlanningRow — the title door', () => {
  it('a plain click on a TARGETED title opens that item’s quick view over the tab', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(page([row('p1')], 1))),
    );
    mount(page([row('p1')], 1));

    const title = screen.getByRole('link', { name: 'Per-key API quotas' });
    fireEvent.click(title);
    expect(shallowPush).toHaveBeenCalledWith('/workbench?tab=planning&peek=ACME-12');
  });
});

describe('planningOutcomeOf — the arm the island’s suite leaves unread', () => {
  it('a plan APPROVED between two polls is still the written outcome, with the approved door', () => {
    expect(planningOutcomeOf({ status: 'approved', decisionReason: null })).toEqual({
      chipKey: 'planned',
      lineKey: 'plannedLine',
      planStatus: 'approved',
    });
  });

  // Bug MOTIR-9006: being approved between two polls — the written outcome, and the row's
  // door is the planning surface, where the approval's progress is drawn.
  it('a plan being APPROVED between two polls is the written outcome, with its own status', () => {
    expect(planningOutcomeOf({ status: 'approving', decisionReason: null })).toEqual({
      chipKey: 'planned',
      lineKey: 'plannedLine',
      planStatus: 'approving',
    });
  });
});
