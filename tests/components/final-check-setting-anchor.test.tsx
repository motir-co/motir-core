// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  FINAL_CHECK_RING_FADE_MS,
  FINAL_CHECK_RING_HOLD_MS,
  FINAL_CHECK_RING_REDUCED_MS,
  FinalCheckSettingAnchor,
} from '@/app/(authed)/settings/project/ai-planning/_components/FinalCheckSettingAnchor';
import {
  AI_PLANNING_SETTINGS_HREF,
  FINAL_CHECK_SETTING_HREF,
  FINAL_CHECK_SETTING_ID,
} from '@/app/(authed)/backlog/_components/aiSprintPlanShared';

// THE RUN THE FINAL CHECK ROW'S LANDING (MOTIR-11548), built to
// `design/ai-chat/design-notes.md` § "⭐ The final check, §3 amended" §3b (MOTIR-11547):
// the row carries `id="final-check"`, and arriving at that hash rings it — held 0.6 s, faded
// over 1.4 s, removed — or, under `prefers-reduced-motion`, shows it 2 s with no fade.

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function setHash(hash: string) {
  window.history.replaceState(null, '', `/settings/project/ai-planning${hash}`);
}

function mount() {
  return render(
    <FinalCheckSettingAnchor>
      <span>Run the final check</span>
    </FinalCheckSettingAnchor>,
  );
}

const row = () => screen.getByTestId('ai-planning-final-check-row');
const arrival = () => row().getAttribute('data-arrival');
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
  setHash('');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the link target', () => {
  it('is the shared settings path plus the row’s id, not a second literal', () => {
    expect(FINAL_CHECK_SETTING_ID).toBe('final-check');
    expect(FINAL_CHECK_SETTING_HREF).toBe(`${AI_PLANNING_SETTINGS_HREF}#final-check`);
    expect(FINAL_CHECK_SETTING_HREF).toBe('/settings/project/ai-planning#final-check');
  });
});

describe('FinalCheckSettingAnchor', () => {
  it('carries the id and draws no ring when the page opens without the hash', () => {
    mount();
    expect(row().id).toBe('final-check');
    expect(row().textContent).toBe('Run the final check');
    expect(arrival()).toBeNull();
    expect(row().className).not.toContain('ring-2');
    advance(5000);
    expect(arrival()).toBeNull();
  });

  it('opened at #final-check, it rings the row, holds 0.6 s, fades over 1.4 s and is removed', () => {
    setHash('#final-check');
    mount();
    expect(arrival()).toBe('ring');
    expect(row().className).toContain('ring-2 ring-(--el-highlight)');

    advance(FINAL_CHECK_RING_HOLD_MS - 1);
    expect(arrival()).toBe('ring');
    advance(1);
    expect(arrival()).toBe('fading');
    expect(row().className).toContain('ring-transparent');
    expect(row().className).toContain('transition-shadow');
    expect(row().className).toContain(`duration-[${FINAL_CHECK_RING_FADE_MS}ms]`);

    advance(FINAL_CHECK_RING_FADE_MS);
    expect(arrival()).toBeNull();
    expect(row().className).not.toContain('ring');
  });

  it('under prefers-reduced-motion it shows for 2 s and is removed with no fade', () => {
    setReducedMotion(true);
    setHash('#final-check');
    mount();
    expect(arrival()).toBe('ring');
    advance(FINAL_CHECK_RING_REDUCED_MS - 1);
    expect(arrival()).toBe('ring');
    advance(1);
    expect(arrival()).toBeNull();
    expect(row().className).not.toContain('transition');
  });

  it('a later hashchange to the anchor rings it again; another hash does not', () => {
    mount();
    act(() => {
      setHash('#elsewhere');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(arrival()).toBeNull();

    act(() => {
      setHash('#final-check');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(arrival()).toBe('ring');
    advance(FINAL_CHECK_RING_HOLD_MS);
    advance(FINAL_CHECK_RING_FADE_MS);
    expect(arrival()).toBeNull();

    // Away and back: the ring starts over from the top.
    act(() => {
      setHash('');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    act(() => {
      setHash('#final-check');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(arrival()).toBe('ring');
  });

  it('leaving the anchor mid-ring clears it at once', () => {
    setHash('#final-check');
    mount();
    expect(arrival()).toBe('ring');
    act(() => {
      setHash('');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(arrival()).toBeNull();
  });
});
