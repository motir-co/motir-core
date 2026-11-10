// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { AgentTerminal } from '@/app/(authed)/my-agents/_components/AgentTerminal';
import type { TerminalSink } from '@/app/(authed)/my-agents/_components/useAgentTerminal';

// THE TERMINAL ITSELF (Story MOTIR-6861 · MOTIR-6941; MOTIR-7062 — the lane
// measures it now). `AgentPanel.test.tsx` drives it through the panel; held here
// are the terminal's own decisions, with xterm stubbed at its module (happy-dom
// has no canvas): bytes and a reset that arrive BEFORE xterm has loaded are not
// lost, the `cols × rows` tag shows for a moment on a real resize (never on the
// first fit), a reader scrolled up is offered Jump to latest rather than yanked
// down, and the theme falls back to the system colours when the host resolves none.
// MOTIR-10857: an OPEN terminal follows a theme switch — an explicit light/dark or
// palette change on <html>, or the OS appearance while the page follows the system —
// and stops watching once it closes.

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    written: Uint8Array[];
    resets: number;
    scrolledToBottom: number;
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    disposed: boolean;
    buffer: { active: { viewportY: number; baseY: number } };
    fireResize: (cols: number, rows: number) => void;
    fireScroll: () => void;
    fireWriteParsed: () => void;
  }>,
  /** What the first fit does: a terminal finding its size fires a resize. */
  firstFit: null as { cols: number; rows: number } | null,
}));
vi.mock('@xterm/xterm', () => {
  class Terminal {
    written: Uint8Array[] = [];
    resets = 0;
    scrolledToBottom = 0;
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    disposed = false;
    buffer = { active: { viewportY: 0, baseY: 0 } };
    private resizeCb: ((s: { cols: number; rows: number }) => void) | null = null;
    private scrollCb: (() => void) | null = null;
    private parsedCb: (() => void) | null = null;
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this);
    }
    loadAddon(addon: { term?: Terminal }) {
      addon.term = this;
    }
    open() {}
    write(bytes: Uint8Array) {
      this.written.push(bytes);
    }
    reset() {
      this.resets += 1;
    }
    dispose() {
      this.disposed = true;
    }
    scrollToBottom() {
      this.scrolledToBottom += 1;
    }
    onData() {}
    onResize(cb: (s: { cols: number; rows: number }) => void) {
      this.resizeCb = cb;
    }
    onScroll(cb: () => void) {
      this.scrollCb = cb;
    }
    onWriteParsed(cb: () => void) {
      this.parsedCb = cb;
    }
    fireResize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizeCb?.({ cols, rows });
    }
    fireScroll() {
      this.scrollCb?.();
    }
    fireWriteParsed() {
      this.parsedCb?.();
    }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    term?: { fireResize: (cols: number, rows: number) => void };
    fit() {
      if (xterm.firstFit) this.term?.fireResize(xterm.firstFit.cols, xterm.firstFit.rows);
    }
  },
}));

const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  xterm.instances.length = 0;
  xterm.firstFit = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
});

/** Let the dynamic xterm imports resolve and the terminal open. */
async function load() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function mount(over: Partial<Parameters<typeof AgentTerminal>[0]> = {}) {
  const sinkRef = createRef<TerminalSink | null>() as { current: TerminalSink | null };
  const onResize = vi.fn();
  const props = {
    sinkRef,
    onData: vi.fn(),
    onResize,
    inputEnabled: true,
    dimmed: false,
    label: 'Terminal',
    jumpLabel: 'Jump to latest',
    sizeLabel: (cols: number, rows: number) => `${cols} × ${rows}`,
    ...over,
  };
  const result = render(<AgentTerminal {...props} />);
  return { ...result, sinkRef, onResize, props };
}

const term = () => xterm.instances[xterm.instances.length - 1]!;

describe('AgentTerminal — before xterm has loaded', () => {
  it('queues bytes the socket writes first, and hands them to xterm in order once it opens', async () => {
    const { sinkRef } = mount();
    expect(xterm.instances).toHaveLength(0);
    // The default PTY size until the terminal has measured itself.
    expect(sinkRef.current!.size()).toEqual({ cols: 80, rows: 24 });
    sinkRef.current!.write(enc('hello '));
    sinkRef.current!.write(enc('world'));
    await load();
    expect(term().written.map((b) => new TextDecoder().decode(b))).toEqual(['hello ', 'world']);
    expect(term().resets).toBe(0);
    // Now the size is the terminal's own, and writes go straight through.
    term().cols = 132;
    term().rows = 41;
    expect(sinkRef.current!.size()).toEqual({ cols: 132, rows: 41 });
    sinkRef.current!.write(enc('!'));
    expect(term().written).toHaveLength(3);
  });

  it('a reset before it loads drops what was queued and resets the terminal on open (a reattach redraws, never repeats)', async () => {
    const { sinkRef } = mount();
    sinkRef.current!.write(enc('stale screen'));
    sinkRef.current!.reset();
    sinkRef.current!.write(enc('replay'));
    await load();
    expect(term().resets).toBe(1);
    expect(term().written.map((b) => new TextDecoder().decode(b))).toEqual(['replay']);
  });

  it('closed before it loads: no terminal is ever opened and the sink is gone', async () => {
    const { sinkRef, unmount } = mount();
    unmount();
    await load();
    expect(xterm.instances).toHaveLength(0);
    expect(sinkRef.current).toBeNull();
  });
});

describe('AgentTerminal — the theme', () => {
  it('a host that resolves no ink or paper draws in the system colours and a monospace face', async () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      color: '',
      fontFamily: '',
      backgroundColor: '',
    } as CSSStyleDeclaration);
    mount();
    await load();
    expect(term().options).toMatchObject({
      fontFamily: 'monospace',
      cursorBlink: true,
      theme: { background: 'Canvas', foreground: 'CanvasText', cursor: 'CanvasText' },
    });
  });

  it('watch-only draws no caret — the cursor is painted in the paper — and takes no key', async () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      color: 'rgb(1, 2, 3)',
      fontFamily: 'JetBrains Mono',
      backgroundColor: 'rgb(9, 9, 9)',
    } as CSSStyleDeclaration);
    mount({ watchOnly: true, inputEnabled: false });
    await load();
    expect(term().options).toMatchObject({
      disableStdin: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      fontFamily: 'JetBrains Mono',
      theme: { background: 'rgb(9, 9, 9)', foreground: 'rgb(1, 2, 3)', cursor: 'rgb(9, 9, 9)' },
    });
  });

  it('input pauses and resumes with the connection, on the open terminal', async () => {
    const { rerender, props } = mount();
    await load();
    expect(term().options['disableStdin']).toBe(false);
    rerender(<AgentTerminal {...props} inputEnabled={false} dimmed />);
    expect(term().options['disableStdin']).toBe(true);
    expect(screen.getByTestId('agent-terminal').className).toContain('opacity-60');
  });
});

/**
 * The computed styles the terminal reads, as one mutable record: a "theme switch"
 * is these values changing and then the page telling the terminal about it.
 */
function computedStyles(initial: { color: string; backgroundColor: string }) {
  const styles = { fontFamily: 'JetBrains Mono', ...initial };
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ ...styles }) as unknown as CSSStyleDeclaration,
  );
  return styles;
}

/** A controllable `prefers-color-scheme` query: `flip()` is the OS appearance changing. */
function colorSchemeQuery() {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const removed: unknown[] = [];
  const query = {
    matches: false,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
      removed.push(cb);
      listeners.delete(cb);
    },
  };
  const matchMedia = vi
    .spyOn(window, 'matchMedia')
    .mockImplementation(() => query as unknown as MediaQueryList);
  return {
    matchMedia,
    listeners,
    removed,
    flip() {
      query.matches = !query.matches;
      for (const cb of [...listeners]) cb({ matches: query.matches } as MediaQueryListEvent);
    },
  };
}

/** MutationObserver records are delivered after the write; let them land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const LIGHT = { color: 'rgb(20, 20, 20)', backgroundColor: 'rgb(240, 240, 240)' };
const DARK = { color: 'rgb(230, 230, 230)', backgroundColor: 'rgb(30, 30, 30)' };

describe('AgentTerminal — following a theme switch (MOTIR-10857)', () => {
  it('an explicit light → dark switch on <html> re-applies the paper and ink to the open terminal', async () => {
    const styles = computedStyles(LIGHT);
    mount();
    await load();
    expect(term().options['theme']).toEqual({
      background: LIGHT.backgroundColor,
      foreground: LIGHT.color,
      cursor: LIGHT.color,
    });

    Object.assign(styles, DARK);
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    expect(term().options['theme']).toEqual({
      background: DARK.backgroundColor,
      foreground: DARK.color,
      cursor: DARK.color,
    });
    // The same terminal, not a reopened one.
    expect(xterm.instances).toHaveLength(1);
  });

  it('a palette switch re-applies them too', async () => {
    const styles = computedStyles(LIGHT);
    mount();
    await load();
    Object.assign(styles, { color: 'rgb(1, 50, 90)', backgroundColor: 'rgb(220, 235, 250)' });
    document.documentElement.setAttribute('data-palette', 'cobalt');
    await settle();
    expect(term().options['theme']).toMatchObject({
      background: 'rgb(220, 235, 250)',
      foreground: 'rgb(1, 50, 90)',
    });
  });

  it('following the system, an OS appearance change re-applies them with no attribute changing', async () => {
    const scheme = colorSchemeQuery();
    const styles = computedStyles(LIGHT);
    mount();
    await load();
    expect(scheme.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    Object.assign(styles, DARK);
    act(() => scheme.flip());
    expect(term().options['theme']).toEqual({
      background: DARK.backgroundColor,
      foreground: DARK.color,
      cursor: DARK.color,
    });
    // And back again.
    Object.assign(styles, LIGHT);
    act(() => scheme.flip());
    expect(term().options['theme']).toMatchObject({ background: LIGHT.backgroundColor });
  });

  it('a browser with no matchMedia still follows an explicit switch', async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    try {
      const styles = computedStyles(LIGHT);
      mount();
      await load();
      Object.assign(styles, DARK);
      document.documentElement.setAttribute('data-theme', 'dark');
      await settle();
      expect(term().options['theme']).toMatchObject({ background: DARK.backgroundColor });
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original });
    }
  });

  it('a watch-only terminal keeps its cursor painted in the NEW paper', async () => {
    const styles = computedStyles(LIGHT);
    mount({ watchOnly: true, inputEnabled: false });
    await load();
    expect(term().options['theme']).toMatchObject({ cursor: LIGHT.backgroundColor });
    Object.assign(styles, DARK);
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    expect(term().options['theme']).toEqual({
      background: DARK.backgroundColor,
      foreground: DARK.color,
      cursor: DARK.backgroundColor,
    });
  });

  it('a change that resolves the same colours leaves the theme as it was', async () => {
    computedStyles(LIGHT);
    mount();
    await load();
    const before = term().options['theme'];
    document.documentElement.setAttribute('data-theme', 'light');
    await settle();
    expect(term().options['theme']).toBe(before);
  });

  it('closing the terminal stops watching both routes', async () => {
    const scheme = colorSchemeQuery();
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const styles = computedStyles(LIGHT);
    const { unmount } = mount();
    await load();
    expect(scheme.listeners.size).toBe(1);
    const [listener] = [...scheme.listeners];
    const t = term();
    const themeAtClose = t.options['theme'];

    unmount();
    expect(scheme.removed).toEqual([listener]);
    expect(scheme.listeners.size).toBe(0);
    expect(disconnect).toHaveBeenCalled();

    // A switch after closing reaches nothing.
    Object.assign(styles, DARK);
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();
    expect(t.options['theme']).toBe(themeAtClose);
  });

  it('closed before xterm loads: nothing is ever watched', async () => {
    const scheme = colorSchemeQuery();
    const { unmount } = mount();
    unmount();
    await load();
    expect(scheme.matchMedia).not.toHaveBeenCalled();
  });
});

describe('AgentTerminal — size and scroll', () => {
  it('the first fit reports its size silently; a later resize shows `cols × rows` for a moment', async () => {
    vi.useFakeTimers();
    xterm.firstFit = { cols: 100, rows: 30 };
    const { onResize, container } = mount();
    await load();
    // The hook is told the size the terminal found, but nothing is announced.
    expect(onResize).toHaveBeenCalledWith(100, 30);
    expect(container.textContent).not.toContain('100 × 30');

    act(() => term().fireResize(120, 40));
    expect(onResize).toHaveBeenLastCalledWith(120, 40);
    expect(container.textContent).toContain('120 × 40');
    act(() => vi.advanceTimersByTime(1_000));
    // A second resize inside the moment restarts it, and shows the newer size.
    act(() => term().fireResize(90, 20));
    expect(container.textContent).toContain('90 × 20');
    expect(container.textContent).not.toContain('120 × 40');
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toContain('90 × 20');
    act(() => vi.advanceTimersByTime(500));
    expect(container.textContent).not.toContain('90 × 20');
  });

  it('a reader scrolled up is offered Jump to latest, which scrolls to the bottom; at the bottom it goes', async () => {
    mount();
    await load();
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();

    term().buffer.active = { viewportY: 10, baseY: 50 };
    act(() => term().fireScroll());
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(term().scrolledToBottom).toBe(1);

    // New output while still scrolled up keeps the offer; reaching the bottom drops it.
    act(() => term().fireWriteParsed());
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
    term().buffer.active = { viewportY: 50, baseY: 50 };
    act(() => term().fireWriteParsed());
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('closing the terminal disposes xterm and lets go of the sink', async () => {
    const { sinkRef, unmount } = mount();
    await load();
    const t = term();
    unmount();
    expect(t.disposed).toBe(true);
    expect(sinkRef.current).toBeNull();
  });
});
