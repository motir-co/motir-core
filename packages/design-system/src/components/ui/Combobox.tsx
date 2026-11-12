'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, LoaderCircle } from 'lucide-react';
import { cn } from '../../utils/cn';
import { usePortalContainer } from '../../utils/fullscreen';

// Run layout effects on the client, fall back to useEffect during SSR (the menu
// only mounts client-side anyway — see the `mounted` gate below).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// `false` during SSR / first hydration render, `true` on the client thereafter —
// gates the createPortal call so document.body is guaranteed present. Hydration-
// safe (matches the server's `false`) and avoids setState-in-effect.
const subscribeNoop = () => () => {};

/**
 * The LEADING-VISUAL slot, on the trigger and on every option row (MOTIR-3080).
 *
 * ⚠️ `inline-flex` is load-bearing, not decoration. The wrapper is a flex item of
 * its row, so IT is blockified — but whatever a caller passes INSIDE it is not,
 * and a plain `<span>` therefore stays `display: inline`, where width and height
 * do not apply at all. `StatusPicker`'s 10px status dot rendered as a 2 × 18
 * sliver for exactly that reason: three cards of palette work (MOTIR-1273 /
 * -2073 / -2075) measured that dot's HUE while its box was two pixels wide.
 *
 * It survived every check because the markup was right — the classes ask for
 * 10 × 10, `getComputedStyle` reports 10px, and only the USED value disagreed.
 * A used value exists only in a browser, so `tests/e2e/issue-detail-flow` MEASURES
 * it rather than asserting the element exists.
 *
 * Making the slot a flex CONTAINER blockifies its child, which is what the slot's
 * contract ("a leading visual") always implied. A lucide `<svg>` is replaced and
 * was never affected, so no existing caller's icon changes size.
 */
const ICON_SLOT = 'inline-flex shrink-0 items-center';

function useMounted() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Combobox — an accessible select/combobox primitive (Subtask 2.3.4). A trigger
 * button (`role="combobox"`, `aria-haspopup="listbox"`) opens an anchored panel
 * holding an optional type-ahead filter and a `role="listbox"` of
 * `role="option"` rows. The active option is tracked with `aria-activedescendant`
 * on whichever control holds focus (the filter input when `searchable`, else the
 * listbox) — the CommandPalette pattern that already clears the STRICT axe sweep.
 *
 * Deliberately NOT built on the Radix Popover primitive: that injects
 * `aria-haspopup="dialog"` + dialog focus semantics onto its trigger, which
 * conflicts with the listbox combobox pattern. This is a self-contained anchored
 * dropdown (click-outside + Escape + focus return handled here) so the ARIA is
 * exactly the WAI-ARIA combobox shape.
 *
 * Composed by `components/issues/TypePicker` (searchable=false, 5 options) and
 * `ParentPicker` (searchable, async candidate list).
 */
export interface ComboboxOption<T extends string> {
  value: T;
  /** Primary text — also the accessible name of the option. */
  label: string;
  /** Extra text matched by the filter (e.g. a PROD-N identifier). */
  keywords?: string;
  /** Leading visual (a kind icon); decorative — label carries the name. */
  icon?: ReactNode;
  /** Trailing muted text (e.g. the identifier). */
  secondary?: string;
  /**
   * A one-line description drawn UNDER the label in the menu row only — never in
   * the trigger, which stays the label alone (the workspace role picker's
   * "what this role does" line, MOTIR-6465). Decorative for the accessible name,
   * which stays `label`.
   */
  description?: string;
  /** Trailing rich content pinned to the option row's far end (e.g. a state
   *  Pill or a "Linked to …" chip in the PR-link picker, MOTIR-1596).
   *  Decorative — the accessible name is `label`; renders after `secondary`. */
  trailing?: ReactNode;
  /**
   * Optional section label. When consecutive options carry different `group`
   * values, a non-interactive header row is rendered at each transition (the
   * advanced filter's "Fields" / "Custom fields" / "Other" field menu). Pass
   * options pre-sorted by group; headers follow list order, so a group whose
   * every option is filtered out disappears with it. Decorative — not part of
   * the listbox's option indices, so keyboard nav is unaffected.
   */
  group?: string;
  /**
   * The option is shown but cannot be picked (MOTIR-5528 — a status move an
   * approval holds). It stays FOCUSABLE and is announced as unavailable
   * (`aria-disabled`), rather than skipped, so a keyboard reader learns the move
   * exists and why it is held; a click or Enter on it does nothing. Its label
   * reads in `--el-text-secondary`, never an opacity dim, which keeps AA.
   */
  disabled?: boolean;
  /**
   * The language the LABEL is written in (a BCP 47 code), rendered as the `lang`
   * attribute on this option's row and, when it is selected, on the trigger's
   * label (MOTIR-7758 — a language picker names each language in its own script,
   * so a reader announces 日本語 in Japanese inside an English page). Omit it and
   * the label inherits the page's language, as before.
   */
  lang?: string;
}

export interface ComboboxProps<T extends string> {
  options: ComboboxOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Accessible name for the trigger + listbox. */
  label: string;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Empty-listbox content. A string, or rich nodes (e.g. a "no matches" line
   *  plus a hint sub-line — use block `<span>`s, since this renders in a `<p>`). */
  emptyText?: ReactNode;
  loading?: boolean;
  loadingText?: string;
  disabled?: boolean;
  /** id for the trigger button. */
  id?: string;
  className?: string;
  /**
   * Mount already-open (Subtask 2.5.5) — for an inline-edit cell that renders the
   * picker on a single click, so the menu is open immediately (mirrors
   * `DatePicker`'s `autoOpen`). Focus lands on the search input / listbox.
   */
  autoOpen?: boolean;
  /**
   * Fired whenever the menu transitions open → closed (a pick, Escape,
   * click-outside, or toggling the trigger). The inline-edit cell uses it to
   * leave edit mode and return to the static pill/avatar (Subtask 2.5.5).
   */
  onClose?: () => void;
  /**
   * Server-driven search mode (Subtask 6.9.2 — the link picker). When
   * `onQueryChange` is provided the type-ahead query is CONTROLLED by the parent
   * (`query`) and client-side filtering is SKIPPED — `options` is taken as the
   * server's authoritative result for the current query (the parent debounces
   * its fetch off `onQueryChange`, the same contract as `MultiSelectPicker`).
   * Omit both for the default self-filtering behaviour. The parent owns the
   * query lifecycle, so opening the menu does NOT reset it.
   */
  query?: string;
  onQueryChange?: (query: string) => void;
  /**
   * A non-interactive note pinned BELOW the listbox, inside the open menu
   * (MOTIR-5582 — the Monitoring room's minimum-level control says, at the
   * action that causes it, that lowering also re-checks earlier issues). It is
   * not an option: keyboard navigation and the listbox's option indices are
   * unaffected, and it is announced as ordinary text. Omit it for no note.
   */
  footer?: ReactNode;
  /**
   * A leading glyph drawn on the TRIGGER only, before the selected label (or the
   * placeholder), and never in the option rows — unlike an option's `icon`,
   * which is drawn in both (MOTIR-7758: the signed-out language control's
   * `Languages` glyph). Decorative: it is rendered `aria-hidden`, and the
   * trigger's accessible name stays `label`.
   */
  triggerIcon?: ReactNode;
  /**
   * The value the trigger shows is being applied (MOTIR-7758). The trigger is
   * marked `aria-busy` and a spinner takes the chevron's 16px slot, so the
   * trigger keeps its size. It does NOT disable the control — a caller that
   * wants that passes `disabled` as well. Pair it with a polite status that says
   * what is happening; this prop draws nothing a reader hears.
   */
  busy?: boolean;
  /**
   * Which edge of the trigger the menu lines up with (MOTIR-7758). `start`
   * (the default) aligns the menu's left edge with the trigger's, as before;
   * `end` aligns the RIGHT edges, so a menu wider than a trigger that sits in a
   * right-hand corner grows leftwards instead of running past the viewport.
   */
  align?: 'start' | 'end';
}

// Walk up from a node to the nearest ancestor that clips overflow, classifying
// it as scrolling (overflow auto/scroll — the menu can be scrolled into view)
// or a hard `hidden`/`clip` box (no scroll — the menu is trapped). Used by the
// inline (in-dialog) branch to decide whether to clamp + flip the menu (only a
// hard non-scrolling clip needs it). Stops at <body>; returns null if nothing
// up the chain clips.
function nearestClipBox(el: HTMLElement): { box: HTMLElement; scrolls: boolean } | null {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === 'auto' || oy === 'scroll') return { box: node, scrolls: true };
    if (oy === 'hidden' || oy === 'clip') return { box: node, scrolls: false };
    node = node.parentElement;
  }
  return null;
}

// The tallest the listbox grows when it has the room (20rem — `max-h-80`, the
// static fallback). Every branch also clamps it to the measured space, so this
// only decides how much of a long list shows before it scrolls. Raised from
// 16rem by MOTIR-11096: once an in-modal menu could reach past the dialog panel,
// 16rem still showed only ~5 options of a long picker.
const LIST_MAX_HEIGHT = 320;

// The element a `position: fixed` descendant of `el` is laid out against, or
// null when that is the viewport. A transform (the centered Modal panel's
// `-translate-x/y-1/2`, which Tailwind v4 emits as the `translate` property), a
// filter, a backdrop-filter (the glassmorphism material), `contain` or a
// matching `will-change` all make an ancestor the containing block for fixed
// descendants — so a fixed child of the Modal panel is positioned relative to
// the PANEL, not the viewport.
function fixedContainingBlock(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.documentElement) {
    const s = getComputedStyle(node);
    const set = (v: string | undefined) => !!v && v !== 'none';
    if (
      set(s.transform) ||
      set(s.translate) ||
      set(s.scale) ||
      set(s.rotate) ||
      set(s.perspective) ||
      set(s.filter) ||
      set(s.backdropFilter) ||
      /\b(paint|layout|strict|content)\b/.test(s.contain || '') ||
      /\b(transform|translate|scale|rotate|perspective|filter)\b/.test(s.willChange || '')
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

// An element's padding box in viewport coordinates — the edge its overflow
// clips at (and, for a containing block, the box fixed offsets are measured
// from).
function paddingBox(el: HTMLElement): {
  top: number;
  left: number;
  bottom: number;
  right: number;
} {
  const r = el.getBoundingClientRect();
  const top = r.top + el.clientTop;
  const left = r.left + el.clientLeft;
  // happy-dom reports clientHeight/Width 0; fall back to the border box there.
  const height = el.clientHeight || r.height;
  const width = el.clientWidth || r.width;
  return { top, left, bottom: top + height, right: left + width };
}

// The right edge of the viewport a `position: fixed` box is laid out against —
// the layout viewport, which excludes a vertical scrollbar (`innerWidth` does not).
function viewportRight(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

export function Combobox<T extends string>({
  options,
  value,
  onChange,
  label,
  placeholder = 'Select…',
  searchable = false,
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  loading = false,
  loadingText = 'Loading…',
  disabled = false,
  id,
  className,
  autoOpen = false,
  onClose,
  query: controlledQuery,
  onQueryChange,
  footer,
  triggerIcon,
  busy = false,
  align = 'start',
}: ComboboxProps<T>) {
  // A DISABLED combobox never opens — not even when it mounts with `autoOpen`
  // (MOTIR-6173). An inline editor that mounts open for an actor who may not
  // write used to hand them a live menu whose pick the server then refused
  // (MOTIR-4822); the trigger was disabled, the menu was not.
  const [open, setOpen] = useState(autoOpen && !disabled);
  // Server-driven mode (6.9.2): when `onQueryChange` is provided the query is
  // controlled by the parent and client filtering is bypassed (the server's
  // `options` are authoritative). Otherwise the query is internal state.
  const serverFiltered = onQueryChange !== undefined;
  const [internalQuery, setInternalQuery] = useState('');
  const query = serverFiltered ? (controlledQuery ?? '') : internalQuery;
  const setQuery = (q: string) => (serverFiltered ? onQueryChange(q) : setInternalQuery(q));
  const [activeIndex, setActiveIndex] = useState(0);
  // The menu is portaled to <body> by default, so it escapes any clipping
  // ancestor — a short table's overflow:hidden
  // (bug-inline-edit-clipped-when-table-short) OR the Advanced-filter popover's
  // overflow-hidden + overflow-y-auto body (MOTIR-1346). We render INLINE only
  // inside a focus-trapping MODAL (the shared Modal primitive — `data-surface=
  // "modal"`; `aria-modal` covers any other), where a portaled menu would land
  // outside the dialog's focus scope (focus-trap war → a click on it hangs /
  // dismisses) AND the modal centers with a CSS transform that breaks a fixed-
  // positioned child's coords. A NON-modal Radix Popover (the filter builder,
  // promote-sprint, mark-duplicate — `data-surface="popover"`) carries
  // `role="dialog"` for a11y but does NOT trap focus, so it portals safely —
  // keyed on the modal surface, NOT `role`, so those popovers escape the clip
  // too. Only render the portal once mounted, since createPortal needs document.body.
  const mounted = useMounted();
  // Viewport-anchored position for the portaled menu + the listbox's available
  // height, recomputed from the trigger rect on open / scroll / resize.
  const [menuStyle, setMenuStyle] = useState<CSSProperties | null>(null);
  const [listMaxHeight, setListMaxHeight] = useState(LIST_MAX_HEIGHT);
  // Inline (in-dialog) branch only: whether the menu is flipped ABOVE the
  // trigger because there's more room there than below within the dialog's
  // overflow-hidden clip box (bug-combobox-menu-clipped-inside-modal).
  const [inlineAbove, setInlineAbove] = useState(false);
  // Inline (in-dialog) branch, SCROLLING clip only (a `Modal.Body`): the fixed
  // offsets that lift the menu out of the scroll box while keeping it in the
  // DOM — and so inside the dialog's focus scope (MOTIR-7655). Null otherwise.
  const [inlineFixed, setInlineFixed] = useState<CSSProperties | null>(null);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The portal target: the element in native full screen while there is one,
  // else <body> — the browser paints nothing outside a full-screen element
  // (MOTIR-7658) — unless that element is inside the menu (MOTIR-8560).
  const fullscreenContainer = usePortalContainer(menuRef);

  const filtered = useMemo(() => {
    // Server-driven mode: `options` is already the query's result — never filter
    // it again client-side (a substring re-filter would hide trigram / token
    // matches the server legitimately returned).
    if (serverFiltered || !searchable || query.trim() === '') return options;
    const needle = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(needle) ||
        (o.secondary ? o.secondary.toLowerCase().includes(needle) : false) ||
        (o.keywords ? o.keywords.toLowerCase().includes(needle) : false),
    );
  }, [options, query, searchable, serverFiltered]);

  const selected = value != null ? (options.find((o) => o.value === value) ?? null) : null;

  // The active row, clamped to the (possibly just-filtered) list — DERIVED, not
  // an effect, so a shrinking filter never needs a setState-in-effect.
  const active = filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : 0;

  // Anchor the portaled menu to the trigger in VIEWPORT coordinates (position:
  // fixed), flipping above the trigger when there's more room there, and capping
  // the listbox height to the available space so it never runs off-screen.
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4; // matches the old mt-1
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const placeBelow = spaceBelow >= spaceAbove;
    const avail = Math.max(120, placeBelow ? spaceBelow : spaceAbove);
    // Reserve room for the optional search input + container padding.
    setListMaxHeight(Math.max(80, Math.min(LIST_MAX_HEIGHT, avail - (searchable ? 52 : 12))));
    const style: CSSProperties = {
      position: 'fixed',
      minWidth: Math.round(rect.width),
    };
    // `end` pins the menu's right edge to the trigger's, so it grows leftwards.
    if (align === 'end') style.right = Math.round(viewportRight() - rect.right);
    else style.left = Math.round(rect.left);
    if (placeBelow) style.top = Math.round(rect.bottom + gap);
    else style.bottom = Math.round(viewportH - rect.top + gap);
    setMenuStyle(style);
  }, [searchable, align]);

  // The in-dialog branch renders INLINE (an absolute child of the trigger),
  // so — unlike the body-portaled branch — it cannot escape the modal's
  // `overflow-hidden` panel: an absolute child contributes nothing to the
  // dialog body's scroll height, so a menu taller than the room below the
  // trigger is simply CLIPPED, not scrolled-to (bug-combobox-menu-clipped-
  // inside-modal). Mirror the portaled branch's logic against the DIALOG's
  // clip box instead of the viewport: measure the space above/below the
  // trigger inside the dialog, flip to whichever side is taller, and clamp the
  // listbox height to it so the menu scrolls INTERNALLY and always fits.
  const updateInlinePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    // Find the nearest ancestor that CLIPS the inline menu. A NON-scrolling
    // `overflow: hidden` clip — the centered Modal panel's `overflow-hidden
    // max-h-[90vh]` box — traps the menu, so clamp + flip against THAT box
    // (bug-combobox-menu-clipped-inside-modal). A SCROLLING clip lifts the menu
    // out with fixed positioning instead (MOTIR-7655, below), bounded above by
    // the scroll box's visible top so it never lands under the panel's header
    // (the regression the first clamp-against-the-scroll-box cut caused).
    const clip = nearestClipBox(trigger);
    if (!clip) {
      setInlineFixed(null);
      setInlineAbove(false);
      setListMaxHeight(LIST_MAX_HEIGHT); // == the max-h-80 fallback
      return;
    }
    if (clip.scrolls) {
      // A SCROLLING clip (`Modal.Body`, a popover's scroll body) does trap an
      // absolute menu after all: the menu extends the box's scroll area, the
      // part past its visible edge is cut, and the box grows a second
      // scrollbar — on a short dialog body that leaves one option visible
      // (MOTIR-7655). Lift the menu out instead: `position: fixed`, still in
      // the DOM. A fixed box is clipped only by the ancestors on its
      // containing-block chain, so the scroll box stops clipping it while the
      // panel (the containing block, through its transform) still bounds it.
      const rect = trigger.getBoundingClientRect();
      const gap = 4; // matches mt-1 / mb-1
      const inset = 8; // stay a hair inside the panel's rounded clip edge
      const cb = fixedContainingBlock(trigger);
      // The region the menu may paint in: never above the scroll box's visible
      // top (that is the dialog's header), and never past the viewport or any
      // clip at or above the containing block (the panel) — which lets the
      // menu overlay the dialog's footer, as a dropdown should.
      let top = Math.max(0, paddingBox(clip.box).top);
      let bottom = window.innerHeight;
      let node: HTMLElement | null = cb;
      while (node && node !== document.body && node !== document.documentElement) {
        const oy = getComputedStyle(node).overflowY;
        if (oy === 'hidden' || oy === 'clip' || oy === 'auto' || oy === 'scroll') {
          const b = paddingBox(node);
          top = Math.max(top, b.top);
          bottom = Math.min(bottom, b.bottom);
        }
        node = node.parentElement;
      }
      const spaceBelow = bottom - rect.bottom - gap - inset;
      const spaceAbove = rect.top - top - gap - inset;
      const placeAbove = spaceAbove > spaceBelow;
      const avail = Math.max(80, placeAbove ? spaceAbove : spaceBelow);
      // The menu's own chrome (search input, padding, footer note), measured
      // when it is laid out; the portaled branch's budget before that.
      const menu = menuRef.current;
      const list = listRef.current;
      const measured = menu && list ? menu.offsetHeight - list.offsetHeight : 0;
      const chrome = measured > 0 ? measured : searchable ? 52 : 12;
      setListMaxHeight(Math.max(80, Math.min(LIST_MAX_HEIGHT, avail - chrome)));
      // Fixed offsets are measured from the containing block's padding box
      // (the viewport when there is none).
      const origin = cb
        ? paddingBox(cb)
        : { top: 0, left: 0, bottom: window.innerHeight, right: viewportRight() };
      const style: CSSProperties = {
        position: 'fixed',
        minWidth: Math.round(rect.width),
      };
      if (align === 'end') style.right = Math.round(origin.right - rect.right);
      else style.left = Math.round(rect.left - origin.left);
      if (placeAbove) style.bottom = Math.round(origin.bottom - (rect.top - gap));
      else style.top = Math.round(rect.bottom + gap - origin.top);
      setInlineAbove(placeAbove);
      setInlineFixed(style);
      return;
    }
    setInlineFixed(null);
    const rect = trigger.getBoundingClientRect();
    const clipRect = clip.box.getBoundingClientRect();
    const gap = 4; // matches mt-1 / mb-1
    const inset = 8; // stay a hair inside the panel's rounded clip edge
    const spaceBelow = clipRect.bottom - rect.bottom - gap - inset;
    const spaceAbove = rect.top - clipRect.top - gap - inset;
    const placeAbove = spaceAbove > spaceBelow;
    setInlineAbove(placeAbove);
    const avail = Math.max(80, placeAbove ? spaceAbove : spaceBelow);
    // Reserve room for the optional search input + container padding (same
    // budget as the portaled branch).
    setListMaxHeight(Math.max(80, Math.min(LIST_MAX_HEIGHT, avail - (searchable ? 52 : 12))));
  }, [searchable, align]);

  // On open: focus the right control (the only side effect — query/active reset
  // happens in openMenu so this effect never calls setState).
  useEffect(() => {
    if (!(open && mounted)) return;
    const t = setTimeout(() => {
      if (searchable) inputRef.current?.focus();
      else listRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, mounted, searchable]);

  // Position the menu before paint, and keep it glued to the trigger while open
  // (ancestor scroll uses capture so a scrolling table re-anchors the menu).
  // Skip entirely for the inline (in-dialog) branch — it positions via CSS.
  useIsomorphicLayoutEffect(() => {
    if (!(open && mounted)) return;
    if (triggerRef.current?.closest('[data-surface="modal"],[aria-modal="true"]')) return;
    updatePosition();
    const onReflow = () => updatePosition();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, mounted, updatePosition, filtered.length]);

  // Inline (in-dialog) counterpart: measure the menu against the dialog's clip
  // box before paint and keep it clamped while open (re-measure on resize, and
  // on capture-phase scroll so a scrolling dialog body re-anchors it).
  useIsomorphicLayoutEffect(() => {
    if (!(open && mounted)) return;
    if (!triggerRef.current?.closest('[data-surface="modal"],[aria-modal="true"]')) return;
    updateInlinePosition();
    const onReflow = () => updateInlinePosition();
    window.addEventListener('scroll', onReflow, true);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('scroll', onReflow, true);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, mounted, updateInlinePosition, filtered.length]);

  // Click-outside closes, restoring focus to the trigger. The menu is portaled
  // out of containerRef, so a click on it must also count as "inside".
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the active row in view.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, open]); // eslint-disable-line react-hooks/exhaustive-deps

  function openMenu() {
    if (disabled) return;
    // Uncontrolled mode resets its own type-ahead on open; server-driven mode
    // leaves the query to the parent (it owns the lifecycle — resets on form
    // open / relationship change), so reopening keeps the current results.
    if (!serverFiltered) setInternalQuery('');
    const sel = value != null ? options.findIndex((o) => o.value === value) : -1;
    setActiveIndex(sel >= 0 ? sel : 0);
    setOpen(true);
  }

  // Close the menu, notifying the consumer (Subtask 2.5.5's inline-edit cell
  // leaves edit mode on close). Every close path funnels through here.
  function closeMenu() {
    setOpen(false);
    onClose?.();
  }

  function closeAndRefocus() {
    closeMenu();
    triggerRef.current?.focus();
  }

  function commit(i: number) {
    if (disabled) return;
    const opt = filtered[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    closeAndRefocus();
  }

  function onListKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(Math.min(active + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(Math.max(active - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeAndRefocus();
    }
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      openMenu();
    } else if (open && e.key === 'Escape') {
      // The open menu takes focus from a `setTimeout(0)` (the on-open effect),
      // so an Escape pressed before that fires lands HERE, not on the list.
      // Ignoring it left the menu open, and the next click on the trigger then
      // toggled it SHUT — the picker closed for good (MOTIR-7345). Focus is
      // already on the trigger, so close without moving it.
      e.preventDefault();
      closeMenu();
    }
  }

  const activeId = filtered.length > 0 ? optionId(active) : undefined;
  // A `role="listbox"` MUST own `role="option"` children, so the listbox role
  // only applies when options are actually rendered. While loading or with no
  // matches the panel holds a status message instead — present it as a
  // `role="status"` live region (announced to AT, and not an empty/childless
  // listbox, which is a critical `aria-required-children` axe violation). The
  // empty state is the link picker's DEFAULT on-open state since the 6.9.2
  // query-driven retrofit, so this is now reachable on every open.
  const hasOptions = !loading && filtered.length > 0;

  // Portal out to escape a short table's overflow:hidden — UNLESS we're inside a
  // focus-trapping dialog, where an inline menu is required (see the `mounted`
  // comment above).
  //
  // ⚠️ This is SETTLED IN A LAYOUT EFFECT, not read during render. It used to be
  // read during render on the stated invariant that "the only ref-null case is
  // autoOpen, used solely by inline-edit cells (always in a table, never a
  // dialog)". That invariant no longer holds: the quick-view peek's editable
  // rail (MOTIR-2563) is an `autoOpen` caller INSIDE the modal. The render-time
  // read fails permanently for it — `useMounted` returns `true` on the very
  // first client render, `triggerRef.current` is still null at that point, and
  // `subscribeNoop` means nothing ever re-renders to correct it. The menu then
  // portals to <body>, lands outside the dialog's focus scope, and every one of
  // its options is `aria-hidden` to assistive tech and to the accessibility
  // tree. A layout effect runs after the ref attaches and before paint, so the
  // branch is right for click-opened AND mount-opened menus alike.
  const [inDialog, setInDialog] = useState(false);
  useIsomorphicLayoutEffect(() => {
    setInDialog(!!triggerRef.current?.closest('[data-surface="modal"],[aria-modal="true"]'));
  }, [open]);

  const menuInner = (
    <>
      {searchable ? (
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label={searchPlaceholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onListKeyDown}
          placeholder={searchPlaceholder}
          className="border-(--el-border) bg-(--el-page-bg) mb-1 w-full rounded-(--radius-input) border px-(--spacing-control-x) py-(--spacing-control-y) text-sm focus-visible:outline-none"
        />
      ) : null}
      <div
        ref={listRef}
        id={listId}
        role={hasOptions ? 'listbox' : 'status'}
        aria-label={label}
        tabIndex={hasOptions && !searchable ? 0 : -1}
        aria-activedescendant={hasOptions && !searchable ? activeId : undefined}
        onKeyDown={hasOptions && !searchable ? onListKeyDown : undefined}
        // Both branches cap height to their measured available space (inline
        // style wins over the max-h-80 fallback): the portaled menu against the
        // viewport, the inline (in-dialog) menu against the dialog's clip box —
        // so an over-tall list scrolls internally instead of being clipped.
        style={{ maxHeight: listMaxHeight }}
        className="max-h-80 overflow-y-auto focus:outline-none"
      >
        {loading ? (
          <p className="text-(--el-text-muted) px-2.5 py-2 text-sm">{loadingText}</p>
        ) : filtered.length === 0 ? (
          <p className="text-(--el-text-muted) px-2.5 py-2 text-sm">{emptyText}</p>
        ) : (
          filtered.map((opt, i) => {
            const isSelected = opt.value === value;
            const isActive = i === active;
            // A non-interactive group header at each group transition (in list
            // order, so a fully-filtered group's header drops with it). Not an
            // option row — keyboard nav over `filtered` is unaffected.
            const header =
              opt.group !== undefined && opt.group !== filtered[i - 1]?.group ? (
                <div
                  key={`group-${opt.group}`}
                  role="presentation"
                  className="px-(--spacing-control-x) pt-2 pb-1 font-mono text-[11px] font-semibold tracking-wider text-(--el-text-eyebrow) uppercase"
                >
                  {opt.group}
                </div>
              ) : null;
            return (
              <Fragment key={opt.value}>
                {header}
                <div
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={opt.disabled ? true : undefined}
                  lang={opt.lang}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => commit(i)}
                  className={cn(
                    'flex items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm',
                    opt.disabled ? 'cursor-default' : 'cursor-pointer',
                    isActive ? 'bg-(--el-option-active-bg)' : '',
                    opt.disabled ? 'text-(--el-text-secondary)' : 'text-(--el-text)',
                  )}
                >
                  {opt.icon ? (
                    <span aria-hidden className={ICON_SLOT}>
                      {opt.icon}
                    </span>
                  ) : null}
                  {opt.description ? (
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{opt.label}</span>
                      <span className="text-(--el-text-secondary) max-w-[18rem] text-xs leading-snug whitespace-normal">
                        {opt.description}
                      </span>
                    </span>
                  ) : (
                    <span className="truncate">{opt.label}</span>
                  )}
                  {opt.secondary ? (
                    // --el-text-identifier (= --color-slate, the -secondary
                    // weight), NOT -muted: muted (#787671) fails AA (4.16:1) on
                    // the panel surface (#f6f5f4) at this 12px size (the
                    // sidebar-caption contrast lesson) — identifier/slate clears it.
                    <span className="text-(--el-text-identifier) ml-auto truncate text-xs">
                      {opt.secondary}
                    </span>
                  ) : null}
                  {opt.trailing ? (
                    // Rich trailing content (a Pill / chip). Pinned right; takes
                    // the `ml-auto` itself when there is no `secondary` before it.
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1.5',
                        opt.secondary ? 'ml-1.5' : 'ml-auto',
                      )}
                    >
                      {opt.trailing}
                    </span>
                  ) : null}
                  {isSelected ? (
                    // The selected-row check uses the accent (matching
                    // MultiSelectPicker) — unifies the check-icon colour across
                    // the two pickers (was bare ink here, accent there).
                    <Check
                      className="ml-1 h-4 w-4 shrink-0 text-(--el-accent-on-surface)"
                      aria-hidden
                    />
                  ) : null}
                </div>
              </Fragment>
            );
          })
        )}
      </div>
      {footer ? (
        <p className="border-(--el-border-soft) mt-1 max-w-[18rem] border-t px-(--spacing-control-x) pt-2 pb-1 text-xs leading-relaxed text-(--el-text-secondary)">
          {footer}
        </p>
      ) : null}
    </>
  );

  // The shared menu panel. In a dialog: an inline absolute panel (the original,
  // proven layout). Otherwise: a body-portaled panel with viewport-anchored
  // fixed positioning that escapes every overflow ancestor.
  const menu = inDialog ? (
    <div
      ref={menuRef}
      data-menu-surface=""
      style={inlineFixed ?? undefined}
      className={cn(
        'z-50 w-max max-w-[18rem] rounded-(--radius-card) bg-(--el-page-bg) p-(--spacing-card-padding-4)',
        'shadow-(--shadow-elevated) border border-(--el-border)',
        // Lifted out of a scrolling clip (MOTIR-7655): positioned by
        // `inlineFixed`. Otherwise an absolute child of the trigger that flips
        // above it when the dialog has more room there, so a tall list near the
        // modal's bottom edge isn't clipped (clamped + scrolled).
        inlineFixed
          ? null
          : cn(
              'absolute min-w-full',
              align === 'end' ? 'right-0' : 'left-0',
              inlineAbove ? 'bottom-full mb-1' : 'top-full mt-1',
            ),
      )}
    >
      {menuInner}
    </div>
  ) : (
    <div
      ref={menuRef}
      data-menu-surface=""
      // Width sizes to the widest option but never narrower than the trigger
      // (minWidth set in updatePosition) and is capped so a long label can't run
      // off-screen. Hidden until positioned to avoid a first-paint flash at 0,0.
      style={menuStyle ?? { position: 'fixed', visibility: 'hidden' }}
      className={cn(
        'z-50 w-max max-w-[18rem] rounded-(--radius-card) bg-(--el-page-bg) p-(--spacing-card-padding-4)',
        'shadow-(--shadow-elevated) border border-(--el-border)',
      )}
    >
      {menuInner}
    </div>
  );

  return (
    // `data-inner-dismiss` while the menu is open — see MultiSelectPicker:
    // an enclosing Radix layer's onEscapeKeyDown checks it so Esc closes the
    // MENU (our own handler) instead of dismissing the whole layer.
    <div ref={containerRef} data-inner-dismiss={open ? true : undefined} className="relative">
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'border-(--el-border) bg-(--el-page-bg) flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-input) border px-(--spacing-control-x) text-sm',
          'focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2',
          'disabled:opacity-50',
          className,
        )}
      >
        {triggerIcon ? (
          <span aria-hidden className={ICON_SLOT}>
            {triggerIcon}
          </span>
        ) : null}
        {selected ? (
          <>
            {selected.icon ? (
              <span aria-hidden className={ICON_SLOT}>
                {selected.icon}
              </span>
            ) : null}
            <span lang={selected.lang} className="text-(--el-text) truncate">
              {selected.label}
            </span>
            {selected.secondary ? (
              // identifier (= slate, the -secondary weight): AA on the trigger surface at 12px (as above).
              <span className="text-(--el-text-identifier) ml-auto truncate text-xs">
                {selected.secondary}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-(--el-text-muted) truncate">{placeholder}</span>
        )}
        {busy ? (
          // The spinner takes the chevron's 16px slot, so the trigger keeps its size.
          <LoaderCircle
            data-combobox-busy=""
            className="text-(--el-icon-muted) ml-auto h-4 w-4 shrink-0 animate-spin"
            aria-hidden
          />
        ) : (
          <ChevronsUpDown className="text-(--el-icon-muted) ml-auto h-4 w-4 shrink-0" aria-hidden />
        )}
      </button>

      {open
        ? inDialog
          ? menu
          : mounted
            ? createPortal(menu, fullscreenContainer ?? document.body)
            : null
        : null}
    </div>
  );
}
