'use client';

import '@xterm/xterm/css/xterm.css';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { ChevronDown } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { Button } from '@/components/ui/Button';
import type { TerminalSink } from './useAgentTerminal';

// THE TERMINAL (Story MOTIR-6861 · MOTIR-6941; `design/my-agents/design-notes.md`
// § the agent panel, panel 5) — xterm.js on the design system's code ground.
//
// - Its colours are the theme's: the region carries `--el-code-bg` / `--el-code-text`
//   and xterm draws on the region's resolved paper with the host's resolved ink and
//   the code ground's selection colours (`terminalTheme` below), so it follows
//   light and dark like every code block.
// - It fills its box, refits to whole cells on every size change, reports the new
//   size (the hook sends `resize`) and shows `cols × rows` for a moment.
// - It scrolls inside itself; a reader scrolled up is not yanked down, and
//   **Jump to latest** appears instead.
//
// ⚠️ It never logs, stores or reports a byte it writes or reads (Q8): output goes
// to xterm, input goes to `onData`, and that is all.

/** How long the `cols × rows` tag stays after a resize. */
const SIZE_TAG_MS = 1_500;

/** A computed fill, or `fallback` when the token resolved to nothing (or to transparent). */
function resolvedFill(node: Element | null, fallback: string): string {
  const fill = node ? getComputedStyle(node).backgroundColor : '';
  return fill && fill !== 'transparent' && fill !== 'rgba(0, 0, 0, 0)' ? fill : fallback;
}

/**
 * The xterm theme, every colour read off the design system as the browser
 * resolved it — no hue is invented here.
 *
 * - INK is the host's `--el-code-text` (a computed `color` is always concrete).
 * - PAPER is the region's `--el-code-bg`, handed over as a concrete colour: a
 *   transparent theme background is not honoured by xterm's viewport, which then
 *   paints its own black under the ink — the dark-on-black the acceptance
 *   recording caught (MOTIR-6943).
 * - The SELECTION is `--el-code-selection-bg` (focused) and
 *   `--el-code-selection-inactive-bg` (unfocused), read off two hidden swatches.
 *   Left unset, xterm 6 paints its own white at 30%, which on the light code
 *   ground is all but invisible (MOTIR-10856). The selected text keeps its ink.
 * - A watch-only terminal draws no caret: its cursor is painted in the paper.
 */
function terminalTheme(
  host: HTMLElement,
  swatches: { selection: Element | null; inactiveSelection: Element | null },
  watchOnly: boolean,
) {
  const ink = getComputedStyle(host).color || 'CanvasText';
  const paper =
    (host.parentElement && getComputedStyle(host.parentElement).backgroundColor) || 'Canvas';
  return {
    background: paper,
    foreground: ink,
    cursor: watchOnly ? paper : ink,
    selectionBackground: resolvedFill(swatches.selection, 'Highlight'),
    selectionInactiveBackground: resolvedFill(swatches.inactiveSelection, 'Highlight'),
  };
}

export function AgentTerminal({
  sinkRef,
  onData,
  onResize,
  inputEnabled,
  dimmed,
  label,
  jumpLabel,
  sizeLabel,
  overlay,
  watchOnly = false,
}: {
  sinkRef: RefObject<TerminalSink | null>;
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Typing reaches the shell only while live; otherwise it is paused, not lost into a dead socket. */
  inputEnabled: boolean;
  dimmed: boolean;
  label: string;
  jumpLabel: string;
  sizeLabel: (cols: number, rows: number) => string;
  /** A face drawn over the terminal (connecting, the session limit). */
  overlay?: ReactNode;
  /**
   * The run's session (MOTIR-7029): watch-only, so no caret is drawn and no key
   * is taken — the server drops input to it anyway.
   */
  watchOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const selectionSwatch = useRef<HTMLSpanElement | null>(null);
  const inactiveSelectionSwatch = useRef<HTMLSpanElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const handlers = useRef({ onData, onResize });
  const sizeLabelRef = useRef(sizeLabel);
  const inputRef = useRef(inputEnabled);
  const watchOnlyRef = useRef(watchOnly);
  useLayoutEffect(() => {
    inputRef.current = inputEnabled;
    handlers.current = { onData, onResize };
    sizeLabelRef.current = sizeLabel;
  });
  const [scrolledUp, setScrolledUp] = useState(false);
  const [sizeTag, setSizeTag] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let fit: FitAddon | null = null;
    let observer: ResizeObserver | null = null;
    let tagTimer: ReturnType<typeof setTimeout> | null = null;
    const pending: Uint8Array[] = [];
    let pendingReset = false;

    // The sink exists before xterm has loaded, so a socket that attaches first
    // loses nothing: bytes queue until the terminal is there.
    sinkRef.current = {
      write(bytes) {
        if (term.current) term.current.write(bytes);
        else pending.push(bytes);
      },
      reset() {
        if (term.current) term.current.reset();
        else {
          pending.length = 0;
          pendingReset = true;
        }
      },
      size() {
        return term.current
          ? { cols: term.current.cols, rows: term.current.rows }
          : { cols: 80, rows: 24 };
      },
    };

    const refit = () => {
      try {
        fit?.fit();
      } catch {
        // not laid out yet
      }
    };

    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;
      const style = getComputedStyle(el);
      const t = new XTerm({
        // Whatever input state was asked for before xterm loaded holds from the start.
        disableStdin: !inputRef.current,
        ...(watchOnlyRef.current
          ? {
              cursorBlink: false,
              cursorStyle: 'bar' as const,
              cursorInactiveStyle: 'none' as const,
            }
          : { cursorBlink: true }),
        fontFamily: style.fontFamily || 'monospace',
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 5_000,
        theme: terminalTheme(
          el,
          {
            selection: selectionSwatch.current,
            inactiveSelection: inactiveSelectionSwatch.current,
          },
          watchOnlyRef.current,
        ),
      });
      fit = new Fit();
      t.loadAddon(fit);
      t.open(el);
      term.current = t;
      if (pendingReset) t.reset();
      for (const bytes of pending.splice(0)) t.write(bytes);
      // The first fit is the terminal finding its size, not a resize to announce.
      let settled = false;
      t.onData((data) => handlers.current.onData(data));
      t.onResize(({ cols, rows }) => {
        handlers.current.onResize(cols, rows);
        if (!settled) return;
        setSizeTag(sizeLabelRef.current(cols, rows));
        if (tagTimer) clearTimeout(tagTimer);
        tagTimer = setTimeout(() => setSizeTag(null), SIZE_TAG_MS);
      });
      refit();
      settled = true;
      const checkScroll = () => {
        const buf = t.buffer.active;
        setScrolledUp(buf.viewportY < buf.baseY);
      };
      t.onScroll(checkScroll);
      t.onWriteParsed(checkScroll);
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(refit);
        observer.observe(el);
      }
    })();

    window.addEventListener('resize', refit);
    return () => {
      disposed = true;
      window.removeEventListener('resize', refit);
      observer?.disconnect();
      if (tagTimer) clearTimeout(tagTimer);
      term.current?.dispose();
      term.current = null;
      sinkRef.current = null;
    };
  }, [sinkRef]);

  useEffect(() => {
    if (term.current) term.current.options.disableStdin = !inputEnabled;
  }, [inputEnabled]);

  return (
    <div
      role="region"
      aria-label={label}
      className="relative min-h-0 flex-1 bg-(--el-code-bg) font-mono text-(--el-code-text)"
    >
      {/* The selection colours, resolved by the browser and read once xterm loads. */}
      <span ref={selectionSwatch} hidden className="bg-(--el-code-selection-bg)" />
      <span ref={inactiveSelectionSwatch} hidden className="bg-(--el-code-selection-inactive-bg)" />
      <div
        ref={host}
        data-testid="agent-terminal"
        className={`absolute inset-0 px-3 py-2.5 font-mono text-(--el-code-text) transition-opacity ${
          dimmed ? 'opacity-60' : ''
        }`}
      />
      {scrolledUp ? (
        <Button
          variant="secondary"
          size="sm"
          className="absolute right-4 bottom-2.5 bg-(--el-card)"
          leftIcon={<ChevronDown aria-hidden="true" />}
          onClick={() => term.current?.scrollToBottom()}
        >
          {jumpLabel}
        </Button>
      ) : null}
      {sizeTag ? (
        <span
          aria-hidden="true"
          className="absolute right-3 bottom-2.5 rounded-(--radius-badge) border border-(--el-border) bg-(--el-card) px-(--spacing-chip-x) font-mono text-[11px] text-(--el-text)"
        >
          {sizeTag}
        </span>
      ) : null}
      {overlay ? <div className="absolute inset-0 flex bg-(--el-code-bg)">{overlay}</div> : null}
    </div>
  );
}
