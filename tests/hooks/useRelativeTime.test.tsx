// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import {
  RELATIVE_TIME_TICK_MS,
  observeRelativeTimePin,
  resetRelativeTimeClockForTests,
  useLiveNow,
  useRelativeTime,
} from '@/lib/hooks/useRelativeTime';
import { RelativeTimeClockAnchor } from '@/components/i18n/RelativeTimeClockAnchor';

// The live relative-time clock (MOTIR-11970). The provider's `now` is pinned once
// per request (finding #89); a client list that appends rows after load measured
// them against that pin and put a just-made row in the future ("in 3 minutes")
// while every older row stayed as old as it was at load.

const PIN = new Date('2026-11-21T21:30:00.000Z');
const MIN = 60_000;

function Label({ at, testId = 'label' }: { at: Date | string | number; testId?: string }) {
  const relativeTime = useRelativeTime();
  return <span data-testid={testId}>{relativeTime(at)}</span>;
}

function NowProbe() {
  return <span data-testid="now">{useLiveNow().toISOString()}</span>;
}

const text = (id = 'label') => screen.getByTestId(id).textContent;

async function letTicks(n: number) {
  await act(async () => {
    vi.advanceTimersByTime(n * MIN);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(PIN);
  resetRelativeTimeClockForTests();
});
afterEach(() => {
  cleanup();
  resetRelativeTimeClockForTests();
  vi.useRealTimers();
});

describe('useRelativeTime — a live clock seeded with the pinned instant', () => {
  it('measures against the pin on first paint, then ages in place a tick at a time', async () => {
    renderWithIntl(<Label at={new Date(PIN.getTime() - MIN)} />, { now: PIN });
    expect(text()).toBe('1 minute ago');

    await act(async () => {
      vi.advanceTimersByTime(3 * MIN);
    });
    expect(text()).toBe('4 minutes ago');
  });

  it('reads a row written after the pin as now, never as a future time', async () => {
    const { rerender } = renderWithIntl(<Label at={PIN} />, { now: PIN });
    await act(async () => {
      vi.advanceTimersByTime(2 * MIN);
    });
    // Written half a minute after the last tick: ahead of the clock.
    vi.setSystemTime(new Date(Date.now() + 30_000));
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN}>
        <Label at={new Date()} />
      </NextIntlClientProvider>,
    );
    expect(text()).toBe('now');
  });

  it('a component that mounts long after load reads the elapsed time at once', () => {
    // The page hydrated at the pin (the root layout's anchor observed it) …
    observeRelativeTimePin(PIN.getTime());
    // … and the drawer opens half an hour later.
    vi.setSystemTime(new Date(PIN.getTime() + 30 * MIN + 20_000));
    renderWithIntl(<Label at={new Date(PIN.getTime() - MIN)} />, { now: PIN });
    expect(text()).toBe('31 minutes ago');
  });

  it('the anchor observes the pin, so a later mount measures from the page load', () => {
    renderWithIntl(<RelativeTimeClockAnchor />, { now: PIN });
    cleanup();
    vi.setSystemTime(new Date(PIN.getTime() + 5 * MIN));
    renderWithIntl(<NowProbe />, { now: PIN });
    expect(text('now')).toBe(new Date(PIN.getTime() + 5 * MIN).toISOString());
  });

  it('a re-pin (router.refresh) starts a fresh observation from the new instant', async () => {
    renderWithIntl(<NowProbe />, { now: PIN });
    await act(async () => {
      vi.advanceTimersByTime(2 * MIN);
    });
    cleanup();
    const repin = new Date(PIN.getTime() + 2 * MIN + 15_000);
    renderWithIntl(<NowProbe />, { now: repin });
    expect(text('now')).toBe(repin.toISOString());
    // The idle older clock was dropped; observing it again starts afresh.
    observeRelativeTimePin(PIN.getTime());
    renderWithIntl(<NowProbe />, { now: PIN });
    expect(screen.getAllByTestId('now').at(-1)!.textContent).toBe(PIN.toISOString());
  });

  it('accepts an ISO string or epoch milliseconds as well as a Date', () => {
    renderWithIntl(
      <>
        <Label testId="iso" at={new Date(PIN.getTime() - 2 * MIN).toISOString()} />
        <Label testId="ms" at={PIN.getTime() - 3 * MIN} />
      </>,
      { now: PIN },
    );
    expect(text('iso')).toBe('2 minutes ago');
    expect(text('ms')).toBe('3 minutes ago');
  });

  it('one interval serves every subscriber, and it stops when the last one unmounts', () => {
    const before = vi.getTimerCount();
    const { unmount } = renderWithIntl(
      <>
        <Label testId="a" at={PIN} />
        <Label testId="b" at={PIN} />
        <Label testId="c" at={PIN} />
      </>,
      { now: PIN },
    );
    expect(vi.getTimerCount() - before).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('a subscriber leaving keeps the interval for the others, and a stale clock is dropped once idle', async () => {
    const before = vi.getTimerCount();
    const { rerender } = renderWithIntl(
      <>
        <Label testId="a" at={PIN} />
        <Label testId="b" at={PIN} />
      </>,
      { now: PIN },
    );
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN}>
        <Label testId="a" at={new Date(PIN.getTime() - MIN)} />
      </NextIntlClientProvider>,
    );
    expect(vi.getTimerCount() - before).toBe(1);
    await letTicks(1);
    expect(text('a')).toBe('2 minutes ago');
    // A re-pin while the old clock still has a subscriber: both run until the
    // old one's last subscriber leaves, then the old clock is forgotten.
    const repin = new Date(PIN.getTime() + MIN);
    renderWithIntl(<NowProbe />, { now: repin });
    expect(vi.getTimerCount() - before).toBe(2);
    cleanup();
    expect(vi.getTimerCount()).toBe(before);
    vi.setSystemTime(new Date(Date.now() + 5 * MIN));
    renderWithIntl(<NowProbe />, { now: PIN });
    // Forgotten: the old pin is observed afresh, so it reads as the pin itself.
    expect(text('now')).toBe(PIN.toISOString());
  });

  it('the test seam stops a running interval', () => {
    const before = vi.getTimerCount();
    renderWithIntl(<Label at={PIN} />, { now: PIN });
    expect(vi.getTimerCount() - before).toBe(1);
    resetRelativeTimeClockForTests();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('the tick is a minute', () => {
    expect(RELATIVE_TIME_TICK_MS).toBe(MIN);
  });
});

describe('SSR and hydration agree on first paint (finding #89)', () => {
  it('the server renders the pin itself, whatever the clock says', () => {
    vi.setSystemTime(new Date(PIN.getTime() + 10 * MIN));
    const html = renderToString(
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN} timeZone="UTC">
        <Label at={new Date(PIN.getTime() - MIN)} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('1 minute ago');
  });

  it('hydrating the server markup raises no mismatch and no ENVIRONMENT_FALLBACK', async () => {
    const { hydrateRoot } = await import('react-dom/client');
    const tree = (
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN} timeZone="UTC">
        <RelativeTimeClockAnchor />
        <Label at={new Date(PIN.getTime() - MIN)} />
      </NextIntlClientProvider>
    );
    const host = document.createElement('div');
    host.innerHTML = renderToString(tree);
    document.body.appendChild(host);
    // The browser clock is ahead of the server's by a few seconds.
    vi.setSystemTime(new Date(PIN.getTime() + 5_000));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recoverable: unknown[] = [];
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(host, tree, { onRecoverableError: (e) => recoverable.push(e) });
    });
    expect(recoverable).toEqual([]);
    const logged = [...errors.mock.calls, ...warns.mock.calls].flat().map(String).join('\n');
    expect(logged).not.toMatch(/hydrat|ENVIRONMENT_FALLBACK/i);
    expect(host.textContent).toBe('1 minute ago');
    await act(async () => {
      root.unmount();
    });
    host.remove();
    errors.mockRestore();
    warns.mockRestore();
  });
});
