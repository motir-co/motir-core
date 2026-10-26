// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { PlanAtWorkMark, PlanAtWorkMarkView } from '@/components/planning/PlanAtWorkMark';
import {
  PLAN_STALLED_AFTER_MS,
  type PlanProgressSnapshot,
  type PlanProgressStep,
} from '@/lib/plans/planProgress';

// MOTIR-8417 — the Motir mark AT WORK (Story MOTIR-8413), moved by MOTIR-9213 from
// the rail header to the working turn's avatar, where it flows
// (`design/ai-chat/design-notes.md` § _The Motir mark at work_). The view is total
// over `atWork`; the wrapper reads `readPlanAtWork` through the one clock and never
// re-derives it, ORed with any other job streaming; the mark is decorative.

const T0 = Date.parse('2026-10-08T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

const AUTHOR: PlanProgressStep = {
  sessionKey: 's1',
  kind: 'author',
  phrase: 'authoring',
  targetRef: 'planItem:pi_1',
  targetNodeId: 'pi_1',
  targetTitle: 'Invoice export',
  startedAt: iso(T0 - MIN),
  providerWait: null,
};
const SETTLE: PlanProgressStep = {
  sessionKey: 's1',
  kind: 'settle',
  phrase: 'settling',
  targetRef: null,
  targetNodeId: null,
  targetTitle: null,
  startedAt: iso(T0 - 10_000),
  providerWait: null,
};

function snap(over: Partial<PlanProgressSnapshot> = {}): PlanProgressSnapshot {
  return {
    startedAt: iso(T0 - 4 * MIN),
    lastActivityAt: iso(T0 - 10_000),
    observedAt: iso(T0),
    authored: 1,
    proposed: 5,
    autoResume: null,
    steps: [AUTHOR],
    ...over,
  };
}

const mark = () => document.querySelector<HTMLElement>('[data-testid="plan-at-work-mark"]')!;
const atWork = () => mark().getAttribute('data-at-work');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PlanAtWorkMarkView — total over atWork', () => {
  it('true ⇒ the at-work form; false ⇒ the static form, and nothing else differs', () => {
    const on = render(<PlanAtWorkMarkView atWork />);
    const onHtml = on.container.innerHTML;
    expect(atWork()).toBe('true');
    cleanup();
    const off = render(<PlanAtWorkMarkView atWork={false} />);
    expect(atWork()).toBe('false');
    expect(off.container.innerHTML.replace('data-at-work="false"', 'data-at-work="true"')).toBe(
      onHtml,
    );
    expect(off.container.textContent).toBe('');
  });

  it('is the 28 px ink disc, clipping, around the inverted glyph at 17 px (MOTIR-9213)', () => {
    render(<PlanAtWorkMarkView atWork />);
    expect(mark().className).toContain('plan-at-work-mark');
    for (const c of ['size-7', 'overflow-hidden', 'rounded-full', 'bg-(--el-accent)']) {
      expect(mark().className).toContain(c);
    }
    const inverted = mark().firstElementChild!;
    expect(inverted.className).toBe('brand-inv');
    const glyph = inverted.firstElementChild!;
    expect(glyph.tagName.toLowerCase()).toBe('svg');
    expect(glyph.getAttribute('class')).toBe('brand-glyph');
    expect(glyph.getAttribute('width')).toBe('17');
    expect(glyph.getAttribute('height')).toBe('17');
  });

  it('is decorative: aria-hidden, and no role, name, live region or tab stop in its subtree', () => {
    for (const on of [true, false]) {
      render(<PlanAtWorkMarkView atWork={on} />);
      const root = mark();
      expect(root.getAttribute('aria-hidden')).toBe('true');
      for (const el of [root, ...root.querySelectorAll('*')]) {
        for (const a of ['role', 'aria-live', 'aria-atomic', 'aria-busy', 'aria-label']) {
          expect(el.hasAttribute(a)).toBe(false);
        }
        expect(el.hasAttribute('tabindex')).toBe(false);
      }
      expect(root.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
      expect(root.querySelector('svg')!.getAttribute('focusable')).toBe('false');
      cleanup();
    }
  });
});

describe('PlanAtWorkMark — off the one clock', () => {
  it('working with a card named ⇒ at work', () => {
    render(<PlanAtWorkMark progress={snap()} />);
    expect(atWork()).toBe('true');
  });

  it('a settle step with no card named yet ⇒ at work', () => {
    render(<PlanAtWorkMark progress={snap({ authored: 0, steps: [SETTLE] })} />);
    expect(atWork()).toBe('true');
  });

  it('stalled ⇒ the static form, reached by the clock alone', () => {
    render(<PlanAtWorkMark progress={snap()} />);
    expect(atWork()).toBe('true');
    act(() => {
      vi.advanceTimersByTime(PLAN_STALLED_AFTER_MS);
    });
    expect(atWork()).toBe('false');
  });

  it('a failing poll whose held steps are non-empty ⇒ the static form', () => {
    render(<PlanAtWorkMark progress={snap()} failing />);
    expect(atWork()).toBe('false');
  });

  it('no snapshot (the plan left generating) ⇒ the static form', () => {
    const r = render(<PlanAtWorkMark progress={snap()} />);
    expect(atWork()).toBe('true');
    r.rerender(<PlanAtWorkMark progress={null} />);
    expect(atWork()).toBe('false');
  });

  it('any other Motir AI job streaming ⇒ at work, with no plan at all (MOTIR-9213)', () => {
    const r = render(<PlanAtWorkMark progress={null} turnStreaming />);
    expect(atWork()).toBe('true');
    r.rerender(<PlanAtWorkMark progress={null} turnStreaming={false} />);
    expect(atWork()).toBe('false');
  });

  it('a stalled plan with no other job streaming ⇒ still; a streaming turn keeps it moving', () => {
    const r = render(<PlanAtWorkMark progress={snap()} failing />);
    expect(atWork()).toBe('false');
    r.rerender(<PlanAtWorkMark progress={snap()} failing turnStreaming />);
    expect(atWork()).toBe('true');
  });

  it('several live steps still draw ONE mark', () => {
    render(
      <PlanAtWorkMark
        progress={snap({ steps: [AUTHOR, { ...AUTHOR, sessionKey: 's2', targetNodeId: 'pi_2' }] })}
      />,
    );
    expect(document.querySelectorAll('[data-testid="plan-at-work-mark"]')).toHaveLength(1);
  });
});
