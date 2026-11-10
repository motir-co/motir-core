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
// - Its colours are the theme's: the host carries `--el-code-bg` / `--el-code-text`
//   and xterm is handed their RESOLVED values. xterm paints with concrete colours,
//   not CSS variables, so they are resolved again whenever the applied theme
//   changes (MOTIR-10857) — a light/dark or palette switch on <html>, which is
//   also how the OS appearance arrives while the page follows the system — and
//   the open terminal follows light and dark like every code block.
// - It fills its box, refits to whole cells on every size change, reports the new
//   size (the hook sends `resize`) and shows `cols × rows` for a moment.
// - It scrolls inside itself; a reader scrolled up is not yanked down, and
//   **Jump to latest** appears instead.
//
// ⚠️ It never logs, stores or reports a byte it writes or reads (Q8): output goes
// to xterm, input goes to `onData`, and that is all.

/** How long the `cols × rows` tag stays after a resize. */
const SIZE_TAG_MS = 1_500;

/** The <html> attributes that carry an explicit theme choice (`app/layout.tsx`, the theme context). */
const THEME_ATTRIBUTES = ['data-theme', 'data-palette'];
/** The OS appearance; watched as a backstop beside the attribute observer (see `watchTheme`). */
const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';

type TerminalColours = { background: string; foreground: string; cursor: string };

/**
 * The terminal's colours as the theme currently resolves them: the INK is the
 * host's computed `color` (`--el-code-text`) and the PAPER the region's computed
 * `backgroundColor` (`--el-code-bg`) — a computed colour is always a concrete
 * value in a browser, so no hue is invented here. A transparent theme background
 * is not honoured by xterm's viewport, which then paints its own black under the
 * ink — the dark-on-black the acceptance recording caught (MOTIR-6943) — so the
 * paper is passed as a colour too. A watch-only terminal draws no caret: its
 * cursor is painted in the paper.
 */
function resolveColours(el: HTMLElement, watchOnly: boolean): TerminalColours {
  const ink = getComputedStyle(el).color || 'CanvasText';
  const paper =
    (el.parentElement && getComputedStyle(el.parentElement).backgroundColor) || 'Canvas';
  return { background: paper, foreground: ink, cursor: watchOnly ? paper : ink };
}

/**
 * Calls `onChange` whenever the applied theme may have changed, and answers the
 * function that stops watching. The attribute observer on <html> (the one
 * `components/brand/HeroWaves.tsx` keeps too) is the route every switch takes
 * today: the CSS keys its dark ramp on `[data-theme]`, and while the page follows
 * the system the theme context writes the OS appearance to `data-theme` after
 * `prefers-color-scheme` flips. The query is watched too, as a backstop for a
 * surface whose colours follow it directly; when it fires before the attribute
 * has been written, the colours have not changed yet and the caller's equality
 * check makes it a no-op.
 */
function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: THEME_ATTRIBUTES,
  });
  const scheme =
    typeof window.matchMedia === 'function' ? window.matchMedia(COLOR_SCHEME_QUERY) : null;
  scheme?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    scheme?.removeEventListener('change', onChange);
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
    let unwatchTheme: (() => void) | null = null;
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
      let colours = resolveColours(el, watchOnlyRef.current);
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
        theme: colours,
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
      // The theme switched under an open terminal: resolve the colours again and
      // hand xterm a NEW theme object (it re-renders on the assignment). An event
      // that changed nothing — another attribute's sibling write, the media query
      // flipping while an explicit choice holds — leaves the terminal alone.
      unwatchTheme = watchTheme(() => {
        const next = resolveColours(el, watchOnlyRef.current);
        if (
          next.background === colours.background &&
          next.foreground === colours.foreground &&
          next.cursor === colours.cursor
        )
          return;
        colours = next;
        t.options.theme = next;
      });
    })();

    window.addEventListener('resize', refit);
    return () => {
      disposed = true;
      window.removeEventListener('resize', refit);
      observer?.disconnect();
      unwatchTheme?.();
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
