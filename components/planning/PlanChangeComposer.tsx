'use client';

import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { CircleStop, MessageCircleQuestionMark, Paperclip, Search, Send } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Tooltip } from '@/components/ui/Tooltip';
import { PausedRunIndicator } from '@/components/planning/RunPause';
import type { PlanChangeRunPauseDto } from '@/lib/dto/planChange';
import { PlanningTargetChip } from '@/components/planning/PlanningTargetChip';
import { TargetSearchPopover } from '@/components/planning/TargetSearchPopover';
import {
  consumeTargetShortcut,
  MAX_PLANNING_TARGETS,
  type PlanningTarget,
} from '@/lib/planning/planningTargets';

// The planning chat's COMPOSER — the message input plus the TARGET search
// (Subtask MOTIR-1491; design `design/ai-chat/target-picker.mock.html`, amended
// by MOTIR-6897's `target-picker--search-and-canvas.mock.html` panels 1–5). The
// Search control (or `@` typed at a word boundary) opens `TargetSearchPopover`,
// whose OWN field takes the query; picking a row adds it to the TARGET SET the
// turn is anchored at, shown as a chip tray above the field.
//
// The picked chip goes to the TRAY, not inline into the message text (design
// panel 2): the target set is structured data the session is scoped by, not
// prose. The `@` shortcut is CONSUMED as it is typed, so the sentence the user
// was writing is never interrupted by a query token.
//
// The SET lives in the host (`PlanningWorkspaceHost`), not here, because the
// CANVAS highlights it too; this component renders it and reports adds/removes.
// The draft text lives in the rail, whose starter hints prefill it.
//
// A11Y — the combobox now lives in the POPOVER's field, not in the message:
// the message is a plain textbox again, and focus moves between the two
// explicitly — into the popover on open, back to the message caret on a pick,
// Esc or Tab (design panel 5).

/**
 * The composer's height CAP, in rows — the design's decision 1
 * (`design/ai-chat/design-notes.md`, the MULTI-LINE composer section; sheet 3).
 *
 * Eight is the last row count at which the transcript stays the LARGER region in
 * the worst case, measured at the split's FLOOR (a 327px footer: the capped field
 * plus the target tray plus the running bar) rather than at its default — the
 * floor being the binding case. It is a VERTICAL budget, so the resizable split
 * (MOTIR-6249) did not move it; a wider field only means the same paragraph
 * reaches the cap later.
 */
const COMPOSER_MAX_ROWS = 8;

/**
 * What the pinned bar says while a run is in flight, and what its control does.
 *
 * ⚠️ `stopping` IS NOT `stopped`, and the distinction is the point (MOTIR-4068).
 * The click is not the stop: the walk acts on the flag when its inbox next reads it
 * (a few seconds, MOTIR-11191 — it no longer waits for the phase boundary), so
 * between the two the surface says the run is **stopping**. A run that keeps
 * narrating after the UI called it over is worse than a slow stop.
 */
export interface RunningBar {
  /** The current narration line — the same text the transcript's live region shows. */
  line: string;
  /** The user has asked for a stop and the run's stream has not ended yet. */
  stopping: boolean;
  /**
   * The Stop. ABSENT for a viewer who may not end the run (bug MOTIR-10428): a
   * member reading someone's session without `ai:plan` sees the run working and is
   * offered nothing to press, the same answer the stop door would give them.
   */
  onStop?: () => void;
  /**
   * The planner has PAUSED and is waiting on the person (Story MOTIR-7990 ·
   * MOTIR-8010; design states 7 and 9a): the bar draws the paused indicator in the
   * spinner's place, with the same Stop. Derived from an unanswered pause, never
   * stored.
   */
  paused?: { kind: PlanChangeRunPauseDto['kind'] } | null;
}

/**
 * The ATTACH control — guide mode only (Story MOTIR-7471 · MOTIR-7486; design
 * MOTIR-7482 `planning-workspace--guide-files.mock.html` panels 1, 2, 4, 14).
 * Absent on every other composer, which is the A3.7 contract: ask, plan change
 * and debug show no attach control and take no pasted image.
 */
export interface ComposerAttach {
  /** Files picked with the control or pasted as images, in that order. */
  onFiles: (files: File[]) => void;
  /** The turn already holds its four files: the control disables with `capLabel`. */
  atCap: boolean;
  /** The control's accessible name. */
  label: string;
  /** Its tooltip. */
  tip: string;
  /** What the tooltip says at the cap. */
  capLabel: string;
  /** The picker's `accept` list — the upload allow-list. */
  accept: string;
}

export interface PlanChangeComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  targets: readonly PlanningTarget[];
  onAddTarget: (target: PlanningTarget) => void;
  onRemoveTarget: (identifier: string) => void;
  /** Submit the turn. The composer clears the draft; the TARGETS persist across
   *  turns until the user removes them (design panel 3). */
  onSubmit: (text: string) => void;
  /** The rail decides the prompt — a re-plan ASKS for the reason first
   *  (MOTIR-910), which outranks the targeted variant. */
  placeholder?: string;
  /** Pre-focus, for the re-plan ask (MOTIR-910). */
  autoFocus?: boolean;
  /**
   * Where the pre-focused caret lands, as an offset into the draft — the orb's
   * two-line debug template puts it at the end of its FIRST line (MOTIR-7050).
   * Absent → the end of the draft, as every shipped pre-fill has it.
   */
  caretAt?: number;
  disabled?: boolean;
  /**
   * The planner's PENDING question (MOTIR-2226), or null when it is not waiting
   * on one. Non-null puts the composer in its answer state: the bar above the
   * input, and Send relabelled **Answer**.
   *
   * A report changes only the transcript; a QUESTION changes the composer — which
   * is the whole reason the state lives here. Questions are rare by construction,
   * and a rare thing that looks like the common thing gets skimmed; a skimmed
   * question is a thread that dies silently with each side waiting on the other.
   * So the ask is carried by the one region that is always on screen, next to the
   * control whose behaviour it changes.
   */
  awaitingQuestion?: string | null;
  /** Jump to the pending question in the transcript. */
  onSeeQuestion?: () => void;
  /**
   * The RUNNING BAR (Story MOTIR-4054 · MOTIR-4068) — the live narration line
   * while a run works, and the **Stop** beside it. `null` when no run is in
   * flight, which is the state this component has always been in.
   *
   * ⚠️ IT TAKES THE ANSWER BAR'S SLOT, and that is a decision rather than a
   * convenience. `design/ai-chat/plan-change-run-live.mock.html` sheet 1: the
   * transcript is the only region that scrolls, so the pinned footer is the one
   * place always on screen — and the moment a stop is wanted is the moment the
   * run is visibly going wrong, which is exactly when a control on hover or below
   * a scroll does not exist. MOTIR-2225 measured the header full at `22rem`
   * (status dot + `Motir AI` + mode chip) and put the answer bar here for the
   * same reason.
   *
   * The two never coexist: awaiting an answer means the run is NOT running.
   */
  running?: RunningBar | null;
  /**
   * Offer the `@` TARGET picker. Default `true` — every shipped call site is a
   * planning turn anchored at committed work items, and none of them passes this.
   *
   * ⚠️ `false` FOR A PLAN REVISION (Story MOTIR-3595 · Subtask MOTIR-3601;
   * `design/ai-planning/design-notes.md` Part XII §B), and it is a correctness
   * flag rather than a styling one. The trigger opens `useWorkItemTargetSearch`,
   * which searches the project's COMMITTED work items; a revision is anchored at
   * the PLAN and the things it can name are PROPOSALS, which have no key to
   * mention until somebody approves them. Offering the picker there searches the
   * wrong universe and returns rows the instruction cannot act on.
   *
   * One prop rather than a second input, because a bespoke field would split the
   * placeholder/accessible-name contract, the disabled handling and the Send
   * button across two components.
   */
  mentions?: boolean;
  /** The attach control and image paste (guide only). Absent → neither exists. */
  attach?: ComposerAttach | null;
  /** Rendered above the field, under the bars — the guide's file tray. */
  beforeField?: ReactNode;
  /** Send is enabled with no words — a guide turn that carries files (A3.2). */
  canSendEmpty?: boolean;
  /** The field cannot be edited but keeps its words — files uploading. */
  readOnly?: boolean;
  /**
   * Clear the draft as the turn is submitted. Default `true`. The guide passes
   * `false` and clears it itself once the turn is SENT, because a send that
   * uploads first can fail — and a failed upload keeps the words (A3.1).
   */
  clearOnSubmit?: boolean;
  /** Drop the composer's own top rule — its slot draws one above a line that
   *  belongs to the composer (the carry's gloss, MOTIR-7932). */
  bare?: boolean;
}

export function PlanChangeComposer({
  draft,
  onDraftChange,
  targets,
  onAddTarget,
  onRemoveTarget,
  onSubmit,
  placeholder,
  autoFocus = false,
  caretAt,
  disabled = false,
  awaitingQuestion = null,
  onSeeQuestion,
  running = null,
  mentions = true,
  attach = null,
  beforeField = null,
  canSendEmpty = false,
  readOnly = false,
  clearOnSubmit = true,
  bare = false,
}: PlanChangeComposerProps) {
  const t = useTranslations('planningWorkspace.targets');
  const tc = useTranslations('planningWorkspace.conversation');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // TRUE while an IME is composing — and for the rest of the task in which the
  // composition ENDS. See `onCompositionEnd` for why the tail matters.
  const composingRef = useRef(false);
  const caretPlacedRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Where focus goes back to when the search closes: the caret the person left
  // in the message, or — opened from the control before any caret was placed —
  // the end of the draft (design panel 5).
  const returnCaretRef = useRef<number | null>(null);
  // Has the person put a caret in the message themselves? Until then a caret
  // read off the field is the browser's default, not a place to return to.
  const caretPlacedByUserRef = useRef(false);

  const resolvedPlaceholder =
    placeholder ??
    (targets.length > 0 ? tc('composerPlaceholderTargets') : tc('composerPlaceholder'));
  const atLimit = targets.length >= MAX_PLANNING_TARGETS;
  // Closed while the turn is in flight too: the composer is locked, so an open
  // search would be a control the user cannot act on.
  const open = mentions && searchOpen && !disabled;

  // A PRE-FILLED draft — a starter chip's text, MOTIR-6210's seeded first turn —
  // is present before any typing, and a textarea whose value was set at mount
  // does not guarantee the caret lands at its end the way a one-line input does.
  // Placed ONCE: on every later focus the caret belongs to whoever moved it (a
  // click into the middle of a sentence, a Tab back into a half-typed draft).
  useEffect(() => {
    if (!autoFocus || caretPlacedRef.current) return;
    const el = inputRef.current;
    if (!el) return;
    caretPlacedRef.current = true;
    const at = caretAt === undefined ? el.value.length : Math.min(caretAt, el.value.length);
    el.setSelectionRange(at, at);
    // `caretAt` is read at the one placement only, like the rest of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  /** Open the search, remembering where the message caret should come back to. */
  function openSearch(caret: number | null) {
    returnCaretRef.current = caret;
    setSearchOpen(true);
  }

  /** Close the search and hand focus back to the message, at its caret. */
  function closeSearch(nextDraft: string = draft) {
    setSearchOpen(false);
    const caret = Math.min(returnCaretRef.current ?? nextDraft.length, nextDraft.length);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function pick(target: PlanningTarget) {
    onAddTarget(target);
    // A pick CLOSES the search (design panel 5's decision): most turns anchor
    // at one item, and a second is one more `@` or one more click.
    closeSearch();
  }

  /**
   * Is this Enter CONFIRMING an IME candidate rather than sending a message?
   *
   * Three signals, because no one of them is enough:
   *
   *  - `nativeEvent.isComposing` — the standard flag, true for every keydown
   *    dispatched while a composition session is open.
   *  - `keyCode === 229` — the legacy "the IME swallowed this key" code, still
   *    what some engines report where `isComposing` is not set.
   *  - `composingRef` — the WebKit guard. **Safari fires `compositionend`
   *    BEFORE the keydown of the Enter that confirmed the candidate**, so that
   *    keydown arrives with `isComposing: false` and both signals above miss it.
   *    Tracking the session ourselves and holding the flag to the end of the
   *    task is the only thing that catches it.
   *
   * Reported against assistant-ui (#8199, #8319), vercel-labs/agent-browser
   * (#1379) and bytedance/deer-flow (#1540) — one bug, four composers, and the
   * reason `isComposing` alone is not the fix it looks like.
   */
  function confirmsComposition(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    return composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // (1) An IME is composing — or has just finished. Do NOTHING: the Enter
    // belongs to the candidate, and sending a half-written message is the
    // failure people typing Chinese or Japanese would hit on their first turn.
    if (event.key === 'Enter' && confirmsComposition(event)) return;

    // (2) The search owns its keys in its OWN field now, so nothing here is
    // intercepted for it — an Enter in the message always means the message.

    // (3) Enter SENDS and (4) Shift+Enter breaks the line. A textarea submits no
    // form of its own, so the send is explicit — and it goes through
    // `requestSubmit()` rather than calling `submit()` directly, so the trim,
    // the empty-message refusal and the `disabled` guard keep exactly one home.
    //
    // (5) ↑/↓ are never intercepted, so the caret moves between lines the way
    // it does in any other multi-line field.
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  /** The Search control — toggles the search. The caret it returns to is the
   *  one the message had, when the person had placed one. */
  function toggleSearch() {
    if (open) {
      closeSearch();
      return;
    }
    const el = inputRef.current;
    openSearch(el && caretPlacedByUserRef.current ? (el.selectionStart ?? null) : null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !canSendEmpty) || disabled || readOnly) return;
    onSubmit(text);
    if (clearOnSubmit) onDraftChange('');
  }

  /** A pasted IMAGE joins the turn's files; pasted text stays text (design
   *  panel 2). Only with the attach control — no other composer takes files. */
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!attach) return;
    const images = Array.from(event.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (images.length === 0) return;
    event.preventDefault();
    attach.onFiles(images);
  }

  // The inset slot holds the search trigger at 6px and, in guide mode, the
  // attach control beside it at 34px (design panel 1); the field's left padding
  // clears whichever are present.
  const insetPadding =
    mentions && attach ? 'pl-[60px]' : mentions || attach ? 'pl-8' : 'pl-(--spacing-input-x)';

  return (
    <form
      onSubmit={submit}
      className={bare ? 'relative px-3 py-3' : 'relative border-t border-(--el-border) px-3 py-3'}
    >
      {running !== null ? <PlanChangeRunningBar running={running} /> : null}

      {/* THE ANSWER BAR — a sibling above the field, where the target tray sits.
          Not an alert: nothing failed, the planner is simply waiting. Its copy
          names the state in words, so the live region announces it when the log
          updates, and the state is carried by THREE cues that are not colour —
          a word, a glyph, and the position of a control that changed. */}
      {awaitingQuestion !== null ? (
        <div
          data-testid="plan-change-awaiting"
          className="mb-2 flex items-start gap-2 rounded-(--radius-card) bg-(--el-warning-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) text-(--el-warning-text)"
        >
          <MessageCircleQuestionMark className="size-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] font-semibold tracking-wide uppercase">
              {tc('awaitingAnswer')}
            </span>
            <span className="block text-xs">{awaitingQuestion}</span>
          </div>
          {onSeeQuestion ? (
            // A real button, not link-coloured text on a tint (the AA rule for
            // this recipe).
            <button
              type="button"
              onClick={onSeeQuestion}
              className="shrink-0 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-[11px] font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
            >
              {tc('seeQuestion')}
            </button>
          ) : null}
        </div>
      ) : null}

      {mentions && targets.length > 0 ? (
        <div
          role="group"
          aria-label={t('trayLabel', { count: targets.length })}
          data-testid="planning-target-tray"
          className="mb-2 flex flex-wrap items-center gap-1.5"
        >
          <span className="font-mono text-[10px] font-semibold tracking-wider text-(--el-text-secondary) uppercase">
            {t('trayLabel', { count: targets.length })}
          </span>
          {targets.map((target) => (
            <PlanningTargetChip
              key={target.identifier}
              target={target}
              onRemove={onRemoveTarget}
              disabled={disabled}
            />
          ))}
          {atLimit ? (
            <span className="text-[11px] text-(--el-text-muted)">
              {t('limitReached', { max: MAX_PLANNING_TARGETS })}
            </span>
          ) : null}
        </div>
      ) : null}

      {beforeField}

      {open ? (
        <TargetSearchPopover targets={targets} onPick={pick} onClose={() => closeSearch()} />
      ) : null}

      {/* ⚠️ `items-end`, NOT `items-center` — the design's decision 2. Send is a
          SIBLING of the field in this row, not a child of it, so a growing field
          walks Send (and the absolutely-positioned `@` trigger) down the box as
          the caret moves away from them. Bottom-aligning holds both a fixed
          distance from the caret's last line. The stated price: at rest the row
          is `--height-input` and Send is `--height-btn-sm`, so Send sits 6px
          lower than today's centring — the one visible change to a composer
          nobody has typed into. */}
      <div className="flex items-end gap-2">
        {/* A plain wrapper since MOTIR-6897: the COMBOBOX moved into the
            search popover's own field, so the message is an ordinary textbox
            with or without `mentions` (and without them there is no control,
            no shortcut and no combobox role at all — the MOTIR-3601 contract). */}
        <div
          // ⚠️ NOT a flex row any more. `Textarea` renders its field inside the
          // design system's `FormField` wrapper, and a flex child with no
          // `flex-1` of its own would size to content instead of filling the
          // row. Block flow lets the wrapper fill this container and the field
          // fill the wrapper, which is the geometry the design draws.
          className="relative min-w-0 flex-1"
        >
          {mentions ? (
            // THE SEARCH CONTROL (design panel 1) — the shipped trigger's slot,
            // testid and geometry, with a magnifier instead of `@`. The tooltip
            // hangs off a wrapper because a DISABLED button fires no pointer
            // events, and at the cap the tooltip is the only place the reason
            // is said on the control itself.
            <Tooltip
              content={
                atLimit ? (
                  t('limitReached', { max: MAX_PLANNING_TARGETS })
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    {t('trigger')}
                    <kbd className="rounded-(--radius-kbd) border border-current px-(--spacing-kbd-x) font-mono text-[10px]">
                      @
                    </kbd>
                  </span>
                )
              }
              delayMs={300}
            >
              {/* `bottom-1.5` rather than vertical centring: 6px above the
                  field's bottom edge however tall the field has grown
                  (decision 2 of the multi-line composer). */}
              <span className="absolute bottom-1.5 left-1.5 z-10 inline-flex">
                <button
                  type="button"
                  onClick={toggleSearch}
                  disabled={disabled || atLimit}
                  aria-label={t('trigger')}
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  data-testid="planning-target-trigger"
                  className={`inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) hover:bg-(--el-card) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${open ? 'bg-(--el-tint-lavender) text-(--el-accent-on-surface)' : 'text-(--el-text-secondary)'}`}
                >
                  <Search className="size-4" aria-hidden="true" />
                </button>
              </span>
            </Tooltip>
          ) : null}
          {attach ? (
            // THE ATTACH CONTROL (MOTIR-7482 panel 1) — the search trigger's
            // geometry, one slot to its right. The picker is a hidden input the
            // button opens, so the control is a real, keyboard-reachable button.
            <Tooltip content={attach.atCap ? attach.capLabel : attach.tip} delayMs={300}>
              <span
                className={`absolute bottom-1.5 z-10 inline-flex ${mentions ? 'left-[34px]' : 'left-1.5'}`}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || readOnly || attach.atCap}
                  aria-label={attach.label}
                  data-testid="guide-attach-trigger"
                  className="inline-flex items-center justify-center rounded-(--radius-control) p-(--spacing-icon-btn) text-(--el-text-secondary) hover:bg-(--el-card) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                >
                  <Paperclip className="size-4" aria-hidden="true" />
                </button>
              </span>
            </Tooltip>
          ) : null}
          {attach ? (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={attach.accept}
              data-testid="guide-attach-input"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                // Cleared so picking the same file again still fires a change.
                event.target.value = '';
                if (picked.length > 0) attach.onFiles(picked);
              }}
            />
          ) : null}
          <Textarea
            ref={inputRef}
            autoGrow
            rows={1}
            maxRows={COMPOSER_MAX_ROWS}
            value={draft}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              // Cleared on the NEXT task, deliberately. WebKit fires this
              // BEFORE the keydown of the Enter that confirmed the candidate,
              // so clearing it synchronously would hand that keydown a field
              // that looks idle — which is the bug this flag exists for.
              setTimeout(() => {
                composingRef.current = false;
              }, 0);
            }}
            onChange={(event) => {
              const el = event.target;
              // THE `@` SHORTCUT (design panel 4): an `@` typed at a word
              // boundary opens the search and is CONSUMED, so the draft keeps
              // no stray `@` and the caret stays where it was.
              const shortcut =
                mentions && !open
                  ? consumeTargetShortcut(draft, el.value, el.selectionStart ?? el.value.length)
                  : null;
              if (shortcut) {
                onDraftChange(shortcut.text);
                caretPlacedByUserRef.current = true;
                openSearch(shortcut.caret);
                return;
              }
              onDraftChange(el.value);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            readOnly={readOnly}
            onKeyUp={() => {
              caretPlacedByUserRef.current = true;
            }}
            onClick={() => {
              caretPlacedByUserRef.current = true;
            }}
            disabled={disabled}
            // Pre-focused for a re-plan so the reason can be typed straight away
            // (MOTIR-910): the workspace is a full-screen route whose primary act
            // IS this composer.
            autoFocus={autoFocus}
            placeholder={resolvedPlaceholder}
            // The accessible name TRACKS the prompt (MOTIR-910's contract): a
            // screen reader must hear the same ask the placeholder shows.
            aria-label={resolvedPlaceholder}
            // The composer's own tokens, overriding the primitive's defaults
            // (`cn` is `twMerge`, and this className is last). Three of them are
            // the multi-line change rather than a carry-over:
            //
            //  • `min-h-(--height-input)` replaces `h-(--height-input)` — the
            //    shipped 44px becomes the FLOOR instead of the height, and the
            //    primitive writes the measured height above it.
            //  • the VERTICAL PADDING is DERIVED, not the `--spacing-input-y`
            //    token: one row has to come to `--height-input` exactly, which
            //    is `(--height-input − line-height − both borders) ÷ 2`. The
            //    token's 12px gives 46px — a visible 2px growth on a field
            //    nobody has typed into. Written as the arithmetic so it stays
            //    exact under every density and type scale the axes produce.
            //  • `focus:ring-0 focus:ring-offset-0` retires the primitive's
            //    plain-`focus` ring, which paints on a mouse click and carries
            //    an offset. The composer's ring is `focus-visible` and
            //    offsetless, as it has always been, and `twMerge` cannot reach
            //    across the two modifiers to do this for us.
            //
            // The placeholder paints on this field's OWN `--el-surface` fill
            // (4.17:1 for muted), and it is load-bearing here — the prompt IS
            // the placeholder, and the accessible name tracks it. Secondary is
            // 6.24:1 on that surface.
            className={`min-h-(--height-input) py-[calc((var(--height-input)-(var(--text-sm)*var(--text-sm--line-height))-2px)/2)] min-w-0 rounded-(--radius-input) border border-(--el-border) bg-(--el-surface) pr-(--spacing-input-x) ${insetPadding} text-sm text-(--el-text) placeholder:text-(--el-text-secondary) focus:ring-0 focus:ring-offset-0 focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none disabled:opacity-60`}
          />
        </div>
        {/* Send gains the WORD "Answer" while a question is pending — the third
            cue, and the one that says what pressing it will do. */}
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={disabled || readOnly || (draft.trim().length === 0 && !canSendEmpty)}
          aria-label={awaitingQuestion !== null ? tc('answer') : tc('send')}
        >
          <Send className="size-4" aria-hidden="true" />
          {awaitingQuestion !== null ? <span>{tc('answer')}</span> : null}
        </Button>
      </div>
    </form>
  );
}

/**
 * THE RUNNING BAR — the live line and the STOP, in the pinned footer
 * (MOTIR-4068). Its own component since bug MOTIR-10428, because two slots draw
 * it: the composer, and the read-only slot that replaces the composer for a
 * member who may read a running session but not end it — the same bar, with no
 * Stop.
 *
 * NOT an alert and NOT a warning tint: nothing has failed, a run is simply
 * working. It reuses `--el-surface-soft`, which is the fill the shipped progress
 * row already carries, so this is that row moved into the region that never
 * scrolls and given a control — composition, not a new treatment
 * (`design/ai-chat/plan-change-run-live.mock.html` sheet 4's token map).
 */
export function PlanChangeRunningBar({ running }: { running: RunningBar }) {
  const tc = useTranslations('planningWorkspace.conversation');
  // The pinned bar's Stop — one control, drawn by the running bar and the paused one.
  const stopButton = running.onStop ? (
    <Button
      variant="secondary"
      size="sm"
      onClick={running.onStop}
      disabled={running.stopping}
      leftIcon={<CircleStop className="size-4" aria-hidden="true" />}
      data-testid="plan-change-stop"
    >
      {running.stopping ? tc('stoppingAction') : tc('stop')}
    </Button>
  ) : null;
  if (running.paused) {
    return <PausedRunIndicator kind={running.paused.kind} finishing={false} stop={stopButton} />;
  }
  return (
    <div
      data-testid="plan-change-running-bar"
      className="mb-2 flex items-center gap-2 rounded-(--radius-card) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8)"
    >
      <Spinner size="sm" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-xs text-(--el-text-secondary)">
        {running.stopping ? tc('stopping') : running.line}
      </span>
      {/* SECONDARY, never destructive. A stop is a DECISION, and the whole
          card turns on it not reading as one: if stopping looks like throwing
          work away, people wait runs out instead and the control is
          decorative. So no `--el-danger`, and the label is a word rather than
          an icon alone. */}
      {stopButton}
    </div>
  );
}
