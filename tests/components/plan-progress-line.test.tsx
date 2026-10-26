// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import {
  PLAN_PROGRESS_POINTER_HREF,
  PlanProgressLine,
  type PlanProgressDensity,
} from '@/components/planning/PlanProgressLine';
import {
  PLAN_STALLED_AFTER_MS,
  PLAN_STEP_PHRASE_MESSAGE_KEY,
  type PlanProgressSnapshot,
  type PlanProgressStep,
  type PlanStepPhrase,
} from '@/lib/plans/planProgress';

// MOTIR-7829 — the PROGRESS LINE (design Part XXVI §26.1–26.5, §26.10–26.14).
//
// Every state is driven by a snapshot FIXTURE through the one clock
// (`usePlanProgressReading`), with the interval and `Date` faked so the tick is
// deterministic. What is pinned: the design's words for each state and phrase,
// the 1 / 2 / many form, the server-held clock (a skewed laptop never reads
// stalled), the dropped read holding the last state, the live region changing
// ONLY on a state change, and the pointer in `pane` only.

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const KIND: Record<PlanStepPhrase, PlanProgressStep['kind']> = {
  settling: 'settle',
  layingTopLevel: 'lay',
  layingChildrenOf: 'lay',
  authoring: 'author',
  draftingNew: 'author',
};

function step(
  phrase: PlanStepPhrase,
  title: string | null,
  sessionKey: string,
  startedAt = T0 - MIN,
): PlanProgressStep {
  return {
    sessionKey,
    kind: KIND[phrase],
    phrase,
    targetRef: title ? `planItem:${sessionKey}` : null,
    targetNodeId: title ? `node-${sessionKey}` : null,
    targetTitle: title,
    startedAt: iso(startedAt),
    providerWait: null,
  };
}

function snap(over: Partial<PlanProgressSnapshot> = {}): PlanProgressSnapshot {
  return {
    startedAt: iso(T0 - 4 * MIN),
    lastActivityAt: iso(T0 - 10_000),
    observedAt: iso(T0),
    authored: 1,
    proposed: 5,
    autoResume: null,
    steps: [],
    ...over,
  };
}

function mount(
  progress: PlanProgressSnapshot | null,
  opts: { density?: PlanProgressDensity; failing?: boolean; locale?: 'en' | 'zh' } = {},
) {
  const density = opts.density ?? 'pane';
  const locale = opts.locale ?? 'en';
  const messages = locale === 'zh' ? zhMessages : enMessages;
  const result = renderWithIntl(
    <PlanProgressLine progress={progress} failing={opts.failing} density={density} />,
    { locale, messages },
  );
  return {
    ...result,
    update(next: PlanProgressSnapshot | null, failing = opts.failing) {
      result.rerender(<PlanProgressLine progress={next} failing={failing} density={density} />);
    },
  };
}

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

const marker = () => screen.getByTestId('plan-live-state');
const lineText = (density: PlanProgressDensity = 'pane') =>
  screen.getByTestId(density === 'pane' ? 'plan-progress' : 'plan-progress-compact').textContent ??
  '';

beforeEach(() => {
  // Only the interval and the clock: Radix's own timers stay real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(['pane', 'compact'] as const)('PlanProgressLine — %s', (density) => {
  it('renders nothing for a null snapshot', () => {
    const { container } = mount(null, { density });
    expect(container.textContent).toBe('');
  });

  it('starting — Starting…, no step words, no counts while M = 0', () => {
    mount(
      snap({
        authored: 0,
        proposed: 0,
        startedAt: iso(T0 - 20_000),
        lastActivityAt: iso(T0 - 2_000),
      }),
      { density },
    );
    const text = density === 'pane' ? marker().textContent : lineText('compact');
    expect(text).toContain('Starting…');
    expect(screen.queryByTestId('plan-progress-steps')).toBeNull();
    expect(lineText(density)).not.toContain('authored');
    expect(lineText(density)).toContain('<1 min');
    expect(lineText(density)).toContain('last activity just now');
  });

  it.each<[PlanStepPhrase, string | null, string]>([
    ['settling', null, 'Settling the conversation'],
    ['layingTopLevel', null, "Laying the project's top level"],
    ['layingChildrenOf', 'Billing settings', 'Laying: Billing settings'],
    ['authoring', 'Invoice export', 'Authoring: Invoice export'],
    ['draftingNew', null, 'Drafting a new item'],
  ])('working — %s reads as the design words', (phrase, title, words) => {
    mount(snap({ steps: [step(phrase, title, 's1')] }), { density });
    const el = screen.getByTestId('plan-progress-steps');
    expect(el.textContent).toBe(words);
    expect(el.getAttribute('title')).toBe(words);
    expect(lineText(density)).toContain('1 of 5 authored');
    expect(lineText(density)).not.toContain('more');
  });

  it('an untargeted step beside targeted ones: the earliest is in words, +N more counts the rest', () => {
    mount(
      snap({
        steps: [
          step('draftingNew', null, 'a', T0 - 2 * MIN),
          step('authoring', 'Invoice export', 'b', T0 - MIN),
        ],
      }),
      { density },
    );
    expect(screen.getByTestId('plan-progress-steps').textContent).toBe('Drafting a new item');
    expect(lineText(density)).toContain('+1 more');
  });

  it('6 concurrent steps — one in words, +5 more; a long title keeps its full text in `title`', () => {
    const long =
      'The progress line on the planning surface and the plan page, with a very long tail';
    mount(
      snap({
        steps: [
          step('authoring', long, 'a', T0 - 3 * MIN),
          step('authoring', 'B', 'b'),
          step('authoring', 'C', 'c'),
          step('layingTopLevel', null, 'd'),
          step('authoring', 'E', 'e'),
          step('draftingNew', null, 'f'),
        ],
      }),
      { density },
    );
    const el = screen.getByTestId('plan-progress-steps');
    expect(el.getAttribute('title')).toBe(`Authoring: ${long}`);
    expect(el.className).toContain('truncate');
    expect(lineText(density)).toContain('+5 more');
  });

  it('writing — counts, elapsed and last activity, no step words', () => {
    mount(snap({ steps: [] }), { density });
    expect(screen.queryByTestId('plan-progress-steps')).toBeNull();
    const text = lineText(density);
    expect(text).toContain('1 of 5 authored');
    expect(text).toContain('4 min');
    expect(text).toContain('last activity 10 s ago');
    if (density === 'pane') expect(marker().textContent).toBe('Being written');
    else expect(text).toContain('Being written');
  });

  it('stalled — the stalled label in the warning role, no step words', () => {
    mount(
      snap({
        startedAt: iso(T0 - 22 * MIN),
        lastActivityAt: iso(T0 - 16 * MIN),
        steps: [step('authoring', 'Invoice export', 's1', T0 - 16 * MIN)],
      }),
      { density },
    );
    expect(screen.queryByTestId('plan-progress-steps')).toBeNull();
    expect(lineText(density)).toContain('no activity for 16 min');
    expect(lineText(density)).toContain('22 min');
    const host = density === 'pane' ? marker() : screen.getByTestId('plan-progress-compact');
    expect(host.textContent).toContain('Stalled');
    expect(host.getAttribute('data-state')).toBe('stalled');
    expect(host.querySelector('.bg-\\(--el-warning\\)')).not.toBeNull();
  });

  it('the Workbench pointer is in pane only', () => {
    mount(snap({ steps: [step('authoring', 'X', 's1')] }), { density });
    const pointer = screen.queryByTestId('plan-progress-pointer');
    if (density === 'pane') {
      expect(pointer).not.toBeNull();
      expect(pointer!.getAttribute('href')).toBe(PLAN_PROGRESS_POINTER_HREF);
      expect(PLAN_PROGRESS_POINTER_HREF).toBe('/workbench?tab=planning');
      expect(pointer!.getAttribute('aria-label')).toBe(
        'You can leave — this plan keeps being written. Follow it from Workbench › Planning.',
      );
      expect(pointer!.textContent).toBe('Follow from Workbench');
    } else {
      expect(pointer).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    }
  });
});

describe('PlanProgressLine — the clock', () => {
  it('turns stalled when time passes the threshold with no new snapshot, and recovers on a fresh one', () => {
    const { update } = mount(
      snap({
        lastActivityAt: iso(T0 - 14 * MIN),
        steps: [step('authoring', 'Invoice export', 's1', T0 - 14 * MIN)],
      }),
    );
    expect(marker().textContent).toBe('Being written');
    expect(screen.getByTestId('plan-progress-steps')).toBeTruthy();

    tick(MIN + 1_000);
    expect(PLAN_STALLED_AFTER_MS).toBe(15 * MIN);
    expect(marker().textContent).toBe('Stalled');
    expect(screen.queryByTestId('plan-progress-steps')).toBeNull();

    // A read that sees a later lastActivityAt — recovered.
    const now = T0 + MIN + 1_000;
    update(
      snap({
        observedAt: iso(now),
        lastActivityAt: iso(now - 5_000),
        steps: [step('authoring', 'Next item', 's2', now - 5_000)],
      }),
    );
    expect(marker().textContent).toBe('Being written');
    expect(screen.getByTestId('plan-progress-steps').textContent).toBe('Authoring: Next item');
  });

  it('holds the server clock: a client 5 min fast reads 4 min since activity, not 9, and not stalled', () => {
    vi.setSystemTime(T0 + 5 * MIN);
    mount(
      snap({
        lastActivityAt: iso(T0 - 4 * MIN),
        steps: [step('authoring', 'Invoice export', 's1', T0 - 4 * MIN)],
      }),
    );
    expect(marker().textContent).toBe('Being written');
    expect(lineText()).toContain('last activity 4 min ago');
    tick(30_000);
    expect(lineText()).toContain('last activity 4 min ago');
    expect(lineText()).not.toContain('9 min');
  });

  it('the elapsed and last-activity texts move on the tick (10-second steps)', () => {
    mount(snap({ lastActivityAt: iso(T0 - 1_000) }));
    expect(lineText()).toContain('last activity just now');
    tick(10_000);
    expect(lineText()).toContain('last activity 10 s ago');
    tick(15_000);
    expect(lineText()).toContain('last activity 20 s ago');
    tick(40_000);
    expect(lineText()).toContain('last activity 1 min ago');
    expect(lineText()).toContain('5 min');
  });

  it('a dropped read HOLDS the last state across the threshold, and the marker says Reconnecting', () => {
    mount(
      snap({
        lastActivityAt: iso(T0 - 14 * MIN),
        steps: [step('authoring', 'Invoice export', 's1', T0 - 14 * MIN)],
      }),
      { failing: true },
    );
    expect(marker().textContent).toBe('Reconnecting — showing the last update');
    tick(2 * MIN);
    // Not stalled: only a read can declare it (§26.10). The step words hold.
    expect(marker().getAttribute('data-state')).toBe('reconnecting');
    expect(lineText()).not.toContain('no activity for');
    expect(screen.getByTestId('plan-progress-steps').textContent).toBe('Authoring: Invoice export');
    // Elapsed keeps ticking — it is a fact about the snapshot.
    expect(lineText()).toContain('6 min');
  });

  it('a hold taken while failing is released when the read recovers', () => {
    const s = snap({
      lastActivityAt: iso(T0 - 14 * MIN),
      steps: [step('authoring', 'Invoice export', 's1', T0 - 14 * MIN)],
    });
    const { update } = mount(s, { failing: true });
    tick(2 * MIN);
    expect(marker().getAttribute('data-state')).toBe('reconnecting');
    update(s, false);
    expect(marker().textContent).toBe('Stalled');
  });

  it('the live region changes only on a STATE change — never on a tick or a step moving', () => {
    const { update } = mount(
      snap({
        lastActivityAt: iso(T0 - 5_000),
        steps: [step('authoring', 'Item A', 'a', T0 - 5_000)],
      }),
    );
    const live = screen.getByRole('status');
    expect(live).toBe(marker());
    expect(live.getAttribute('aria-live')).toBe('polite');
    const seen = new Set<string>([live.textContent ?? '']);
    for (let i = 0; i < 10; i += 1) {
      tick(1_000);
      seen.add(screen.getByRole('status').textContent ?? '');
    }
    // The step moves from A to B on a new read.
    const now = T0 + 10_000;
    update(
      snap({
        observedAt: iso(now),
        lastActivityAt: iso(now - 1_000),
        steps: [step('authoring', 'Item B', 'b', now - 1_000)],
      }),
    );
    expect(screen.getByTestId('plan-progress-steps').textContent).toBe('Authoring: Item B');
    seen.add(screen.getByRole('status').textContent ?? '');
    expect([...seen]).toEqual(['Being written']);
    // The progress button is NOT live.
    expect(screen.getByTestId('plan-progress').closest('[aria-live]')).toBeNull();

    // working → stalled changes it once.
    tick(PLAN_STALLED_AFTER_MS);
    expect(screen.getByRole('status').textContent).toBe('Stalled');
  });

  it('the details popover lists every step whole, the counts and the pointer sentence', async () => {
    mount(
      snap({
        steps: [
          step('authoring', 'A very long title that the line truncates', 'a', T0 - 2 * MIN),
          step('draftingNew', null, 'b', T0 - 30_000),
        ],
      }),
    );
    const button = screen.getByTestId('plan-progress');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      fireEvent.click(button);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Plan progress details' });
    expect(dialog.textContent).toContain('Working on now');
    expect(dialog.textContent).toContain('Authoring: A very long title that the line truncates');
    expect(dialog.textContent).toContain('Drafting a new item');
    expect(dialog.textContent).toContain('running 2 min');
    expect(dialog.textContent).toContain('1 of 5 authored');
    expect(dialog.textContent).toContain('Follow from Workbench');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('the popover says no step is reported when the planner reports none', async () => {
    mount(snap({ steps: [] }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-progress'));
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      'No step reported — the planner may not report its steps.',
    );
  });
});

describe('PlanProgressLine — copy', () => {
  function resolve(messages: Record<string, unknown>, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
        messages,
      );
  }

  it('every PLAN_STEP_PHRASE_MESSAGE_KEY resolves in en AND zh', () => {
    for (const key of Object.values(PLAN_STEP_PHRASE_MESSAGE_KEY)) {
      expect(typeof resolve(enMessages, key), `en ${key}`).toBe('string');
      expect(typeof resolve(zhMessages, key), `zh ${key}`).toBe('string');
    }
  });

  const zhPlanReview = (zhMessages as unknown as { planReview: Record<string, string> }).planReview;

  it.each<[string, PlanProgressSnapshot, string]>([
    ['starting', snap({ authored: 0, proposed: 0, lastActivityAt: iso(T0) }), '正在启动…'],
    ['writing', snap(), zhPlanReview.liveWriting!],
    ['stalled', snap({ lastActivityAt: iso(T0 - 16 * MIN) }), '已停滞'],
  ])('zh — %s', (state, s, word) => {
    mount(s, { locale: 'zh' });
    expect(marker().textContent).toBe(word);
    if (state === 'writing') {
      expect(lineText()).toContain('已编写 1/5 项');
      expect(lineText()).toContain('4 分钟');
      expect(lineText()).toContain('最近活动 10 秒前');
    }
    if (state === 'stalled') expect(lineText()).toContain('已 16 分钟 无活动');
  });

  it('zh — working, every phrase and the pointer', () => {
    mount(
      snap({
        steps: [
          step('authoring', '发票导出', 'a', T0 - 3 * MIN),
          step('layingChildrenOf', '账单', 'b'),
          step('layingTopLevel', null, 'c'),
          step('settling', null, 'd'),
          step('draftingNew', null, 'e'),
        ],
      }),
      { locale: 'zh' },
    );
    expect(screen.getByTestId('plan-progress-steps').textContent).toBe('正在编写：发票导出');
    expect(lineText()).toContain('另有 4 项');
    expect(screen.getByTestId('plan-progress-pointer').textContent).toBe('在工作台跟进');
  });

  it('zh — a dropped read', () => {
    mount(snap(), { locale: 'zh', failing: true });
    expect(marker().getAttribute('data-state')).toBe('reconnecting');
    expect(marker().textContent).toBe(zhPlanReview.liveReconnecting);
  });
});
