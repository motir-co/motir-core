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
      theme: {
        background: 'Canvas',
        foreground: 'CanvasText',
        cursor: 'CanvasText',
        selectionBackground: 'Highlight',
        selectionInactiveBackground: 'Highlight',
      },
    });
  });

  // MOTIR-10856: left unset, xterm 6 paints its own white at 30% — invisible on
  // the light code ground. The selection is the code ground's own selection
  // tokens, as the browser resolved them on two hidden swatches.
  it('passes the resolved code-selection tokens to xterm, focused and unfocused', async () => {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((node: Element) => {
      const cls = node.getAttribute('class') ?? '';
      const fill = cls.includes('bg-(--el-code-selection-inactive-bg)')
        ? 'rgb(214, 210, 238)'
        : cls.includes('bg-(--el-code-selection-bg)')
          ? 'rgb(196, 190, 235)'
          : cls.includes('bg-(--el-code-bg)')
            ? 'rgb(243, 244, 246)'
            : '';
      return {
        ...real(node),
        color: 'rgb(55, 53, 47)',
        fontFamily: 'JetBrains Mono',
        backgroundColor: fill,
      } as CSSStyleDeclaration;
    });
    const { container } = mount();
    await load();
    expect(term().options['theme']).toEqual({
      background: 'rgb(243, 244, 246)',
      foreground: 'rgb(55, 53, 47)',
      cursor: 'rgb(55, 53, 47)',
      selectionBackground: 'rgb(196, 190, 235)',
      selectionInactiveBackground: 'rgb(214, 210, 238)',
    });
    // The swatches are never seen or read out.
    const swatches = container.querySelectorAll('span[hidden]');
    expect([...swatches].map((s) => s.className)).toEqual([
      'bg-(--el-code-selection-bg)',
      'bg-(--el-code-selection-inactive-bg)',
    ]);
  });

  it.each(['transparent', 'rgba(0, 0, 0, 0)'])(
    'a selection token that resolves to %s falls back to the system Highlight, never to xterm’s default',
    async (unresolved) => {
      vi.spyOn(window, 'getComputedStyle').mockReturnValue({
        color: 'rgb(1, 2, 3)',
        fontFamily: 'JetBrains Mono',
        backgroundColor: unresolved,
      } as CSSStyleDeclaration);
      mount();
      await load();
      expect(term().options['theme']).toMatchObject({
        selectionBackground: 'Highlight',
        selectionInactiveBackground: 'Highlight',
      });
    },
  );

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
