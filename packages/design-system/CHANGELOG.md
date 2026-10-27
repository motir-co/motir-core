# @motir/design-system

## 0.18.0

### Minor Changes

- bc5db95: `renderMock` takes a `boardWidth` (MOTIR-9758). The board was a hard-coded 64rem column, so a mock of a page that ships wider (motir-core's Billing & plans, every motir.co page at `max-w-[1400px]`) was drawn squeezed into the middle, and authors widened it by string-replacing the class in the rendered HTML. `'narrow'`, the default, keeps the 64rem column byte for byte; `'full'` draws the board at the viewport's width; any other string is one max-width class such as `'max-w-[1400px]'`, compiled like the rest of the markup. A value that is not one class falls back to `'narrow'` and is named in a comment at the top of the document, as an unknown axis is. The `BoardWidth` type is exported from `@motir/design-system/mock`.

## 0.17.1

### Patch Changes

- 4bc5737: `repository.url` (and `@motir/cli`'s `bugs.url`) now name `motir-co/motir-core`, the repository's home since the org move. npm refuses a provenance-signed publish whose `repository.url` names a different repository than the one in the provenance, so every CI publish since the move failed with E422 (MOTIR-9320). No code changes.

## 0.17.0

### Minor Changes

- 8c7aacf: New role tokens for the Motir mark at work (MOTIR-9212 · MOTIR-9213). `--el-mark-wave-1..3` are the three hues the mark cycles through while it flows on the ink circle (`--el-accent`): each wave hue (`--el-showcase-wave-1..3`) mixed toward the ink on the circle (`--el-accent-text`), 35% hue in the base and 60% in the Motir palette, light and dark. The raw wave hues fall to 1.00:1 on the circle in the palettes whose accent is a wave hue; these keep 3:1 (WCAG 1.4.11) for each role, every blend between two neighbours and every point of the ramp toward the ink, in every palette and theme. No existing token moves.

## 0.16.0

### Minor Changes

- 853486a: A `zh-Hant` font set for Traditional Chinese (MOTIR-9239). The registry gains `zh-tw`, served by Noto Sans TC, Noto Serif TC and LXGW WenKai TC, and `resolveFontSet` now tries the full language tag before its primary subtag, so `zh-TW` resolves to the Traditional set instead of falling back to the Simplified one. `theme.css` adds `[lang]:lang(zh-TW)` blocks that select the Traditional faces. No existing set or token changes.

## 0.15.1

### Patch Changes

- 61d4aed: `renderMock` no longer copies style rules its markup cannot match into a mock (MOTIR-8565). Tailwind compiles a utility only for a class the markup carries, but it copies every plain rule of `theme.css` through whole, so since 0.14.0 every mock carried the four StyleVignette canvas rules (`.style-vignette[data-style='…'] > .sv-canvas`) whether or not it rendered a vignette, and motir-core's design guard failed it for declaring rules no element carries. A rule is now dropped when every selector in it needs a class the markup lacks. A class inside `:not()`, `:is()` or `:where()` does not count as needed, `@layer utilities` is left alone, and a mock that renders the component keeps its rules.

## 0.15.0

### Minor Changes

- a26f8f7: An overlay no longer follows full screen into itself (MOTIR-8560). `Modal`, `Popover`, `Tooltip`, and the `Combobox` and `MultiSelectPicker` menus still portal into `document.fullscreenElement` while there is one, except when that element is inside the overlay: a `<video>` in a dialog going full screen used to pull the dialog into the video, which unmounted the video, dropped the browser out of full screen and reset playback. The overlay now stays where it was until full screen ends. The package exports `usePortalContainer(ref)`, the hook behind this; `useFullscreenElement()` is unchanged.

## 0.14.0

### Minor Changes

- 3a60a61: New role tokens for a warm primary button (MOTIR-8251 · MOTIR-8254). `--el-cta-warm` is the palette's decorative highlight used as a button fill, and `--el-cta-warm-text` its label: the body ink in light and the page ink in dark, because white on the motir orange measures 3.8:1 light and 3.3:1 dark while the dark labels measure 4.65:1 and 5.9:1. A consumer applies them as a treatment of `Button`'s primary variant (`bg-(--el-cta-warm) text-(--el-cta-warm-text)`). No existing token moves.

## 0.13.0

### Minor Changes

- 72e67d2: New role tokens for motir.co's live link ("Motir builds itself" in the header), whose square and words walk the palette's wave hues. `--el-live-mark-1..3` paint the square: the primary, teal and warm accent, as the hero's wave lines use them. `--el-live-text-1..3` paint the words: each hue mixed 60/40 with the primary ink, which clears AA (4.5:1) on the page and the surface in every palette and theme, where the raw teal and warm hues fall to 2.4:1 in light palettes. No existing token moves.

## 0.12.0

### Minor Changes

- Per-language font sets (MOTIR-7733). The package now exports a locale → font-set registry: `FONT_SET_REGISTRY` (the `latin`, `zh-Hans`, `ja` and `ko` sets, each with its members and default per sans / serif / mono role), `LOCALE_FONT_SET`, `FONT_SET_LOCALES`, and the resolvers `resolveFontSet`, `resolveFontSetMember` and `fontSetMemberVar`. `theme.css` composes each role token from three parts: the Type pairing's named faces (`--font-<role>-pairing`), the language's script face (`--font-script-<role>`, set by `[lang]:lang()` blocks for zh, ja and ko and reset for the Latin locales) and the pairing's generic tail (`--font-<role>-tail`). A non-default member is applied by name with `data-font-set-<role>="<member id>"`. The package loads no face: a consumer declares each member with `next/font` and sets the `--font-set-*` variable `fontSetMemberVar` names. Without those variables every stack falls back to the pairing's own faces, so a consumer that loads nothing renders as before.

## 0.11.0

### Minor Changes

- 9597082: `Combobox` gains four optional props for the signed-out language control (MOTIR-7758). An option's `lang` is rendered as the `lang` attribute on its row, and on the trigger's label while it is selected, so a list that names each language in its own script is announced in that language. `triggerIcon` draws a decorative leading glyph on the trigger only, never in the rows. `busy` marks the trigger `aria-busy` and puts a spinner in the chevron's slot without disabling it. `align="end"` lines the menu's right edge up with the trigger's, so a menu opened from a right-hand corner grows leftwards instead of running past the viewport. Existing callers are unchanged.

## 0.10.1

### Patch Changes

- ab67f23: `TokensSpecimen` no longer re-themes the page it is dropped into (MOTIR-7725). It used to wrap itself in `ThemeProvider`, whose effects write `data-theme`, `data-style`, `data-palette` and `data-type` onto `<html>` from the visitor's stored choice or the app defaults, and rewrite `data-theme` whenever the OS colour scheme changes. Nothing inside the specimen reads the theme context, so the provider is gone: the specimen now renders under whatever appearance its host applied. A consumer that relied on the specimen to set up appearance wraps it in its own `ThemeProvider`.

## 0.10.0

### Minor Changes

- c406df6: Overlays now open inside an element in native full screen (MOTIR-7658). `Modal`, `Popover`, `Tooltip`, and the `Combobox` and `MultiSelectPicker` menus portal into `document.fullscreenElement` while there is one, and into `document.body` otherwise, as before. The browser paints nothing outside a full-screen element, so before this a dialog opened there was invisible while it still held focus and scroll lock. `Modal` takes a new optional `container` prop to choose the element itself (`null` forces `document.body`), and the package exports `useFullscreenElement()`, the hook behind the default.

## 0.9.0

### Minor Changes

- d758ffa: New `--el-showcase-*` element tokens for motir.co's illustrations — the flat picture fields on the "Vibe the project" landing and "How Motir works". They are named for what they paint (`field`, `ground`, `highlight`, `decision`, `record`, `wash`, `wash-warm`, `paper`, …), each field with a `*-text` token that reads on it, and every one maps to a palette colour, so a palette re-skins them. The ground stays dark in dark mode; the Motir palette makes the highlight its Sunglow yellow, and every other palette uses its own accent.

  Also `--el-logo-mark` / `--el-logo-tile` for the wave mark on its rounded tile: the mark is the palette's identity hue (its primary fill; the cool-blue primary in Motir, whose fill is the ink CTA), the tile a pale wash of it — or a dark tile for the palettes whose hue is bright (Amber, Sienna, Citrine, Candy).

  And `--el-product-*`, one mark colour per product in motir.co's Products menu (`ai-planner`, `project-management`, `project-manager`, `ai-debugging`, `mcp`, `cli`, `claude-code-connector`, `claude-code-plugin`, `agent-fleet`, `agent-hosting`, `sandbox`), each a palette hue or a mix of two.

## 0.8.2

### Patch Changes

- 6f2f433: The `motir` palette gains a few warm touches (MOTIR-7582): the decorative accent is a warm orange, the Design type takes Citrine's gold, the peach and yellow washes warm, and two new roles, `--el-progress-fill` and `--el-editor-focus`, keep the change out of every other palette.

## 0.8.1

### Patch Changes

- adf0237: `Combobox` closes on Escape while focus is still on its trigger. The open menu takes focus from a `setTimeout(0)`, and Escape was handled only by the menu, so an Escape pressed before that timer fired was ignored: the menu stayed open, and the next click on the trigger toggled it shut. The trigger now closes an open menu on Escape and keeps focus where it is (MOTIR-7345).

## 0.8.0

### Minor Changes

- 261f7d9: Add `renderMock` on the new `@motir/design-system/mock` subpath: it renders the package's own parts into one self-contained `.mock.html` under a given style, palette and type, with Tailwind compiled over the markup and `theme.css` inlined.

## 0.7.0

### Minor Changes

- 31a6057: `ErrorState` gains an optional `retryPending` (and `retryPendingLabel`): while true, its retry button takes `Button`'s `loading` state — Spinner, `disabled`, `aria-busy` — and shows the pending label. Additive; every existing call site renders unchanged.

## 0.6.0

### Minor Changes

- 0edb859: `Combobox` options gain an optional `description`: a one-line explanation drawn
  UNDER the option's label in the menu row, and never in the trigger, which keeps
  showing the label alone. The workspace role picker uses it to say what each role
  does without squeezing that sentence into a narrow trigger, which is what the
  inline `secondary` text would have done. The accessible name stays `label`, and
  every current caller is unchanged: an option without a `description` renders
  exactly as before (MOTIR-6465).

## 0.5.1

### Patch Changes

- b216d98: In the 3D / Immersive style, a Tailwind `ring-*` now shows on every surface the style gives depth to. The style's `box-shadow` rules are unlayered, so they used to replace the ring (itself a `box-shadow` in `@layer utilities`) instead of stacking with it. That erased the ring on card-radius panels, modals, tilted tiles, `shadow-(--shadow-elevated)` overlays, raised and flat controls, and recessed text fields: canvas search matches, selections and every control's `focus-visible:ring` went blank. Each rule now composes `--tw-inset-ring-shadow`, `--tw-ring-offset-shadow` and `--tw-ring-shadow` before its depth. The resting depth is unchanged (MOTIR-6440).

## 0.5.0

### Minor Changes

- 01294f1: `Textarea` gains OPT-IN auto-grow. Pass `autoGrow` and `rows` becomes the
  MINIMUM height: the field grows with its content, line by line, up to `maxRows`,
  then stops and scrolls inside itself. A chat composer passes `rows={1}`. The
  height follows the value whoever changes it — typing, a paste, a controlled value
  set by the parent — and the field's own width, since wrapping changes with width;
  the measurement runs at layout-effect timing, so a field mounted with a
  pre-filled value paints at its final height instead of flashing one line. Line
  height, padding and border are read from the computed style rather than assumed,
  so the clamp stays exact under every palette, type scale and density. With
  `autoGrow` the manual resize handle is dropped (`resize-none`), because a
  hand-dragged height is overwritten by the next keystroke's measurement.

  Every current caller is unchanged: without `autoGrow` the field renders exactly
  as before, fixed at `rows` with `resize-y`. The forwarded ref still reaches the
  `<textarea>`, and a caller's own `onInput` is called through rather than replaced
  (MOTIR-6237).

## 0.4.3

### Patch Changes

- db891d3: An OFF `Switch`'s outer edge now clears WCAG 1.4.11's 3:1 against the page in every palette and theme. The OFF track was bordered in `--el-border-strong`, 1.52–2.41:1 on `--el-page-bg` in all twenty palette × theme pairs; the border now takes a new `--el-switch-off-border` (`--color-muted-foreground`, the OFF knob's own ink), lowest 4.54:1. `--el-border-strong`, and the input and secondary-button borders that share it, keep their mappings; the OFF fill and the OFF knob pairing are unchanged (MOTIR-5725).

## 0.4.2

### Patch Changes

- 0be8c0e: An ON `Switch`'s outer edge now clears WCAG 1.4.11's 3:1 against the page in every palette and theme. The ON track was bordered in its own fill, which fell to 1.80 / 1.47 / 1.57:1 on `--el-page-bg` in amber, citrine and candy light; the border now takes a new `--el-switch-on-border` (`--color-primary`, the palette's primary ink), lowest 4.67:1 across all twenty palette × theme pairs. The fill and the ON knob pairing are unchanged (MOTIR-5715).

## 0.4.1

### Patch Changes

- b466c07: `Switch` knobs now clear WCAG 1.4.11's 3:1 against their own track in every palette and theme. The OFF knob takes a new `--el-switch-knob-off` (`--color-muted-foreground`) instead of sharing the surface-coloured knob that was 1.01:1 / 1.00:1 on `--el-muted`; the ON knob `--el-switch-knob` now writes the primary fill's own ink (`--color-primary-foreground`), which lifts amber, citrine, candy and sienna light and garnet dark over the bar (MOTIR-5711).

## 0.4.0

### Minor Changes

- 686a872: `Combobox` gains `footer?: ReactNode`: a non-interactive note pinned below the listbox inside the open menu, outside the option indices, so keyboard navigation is unaffected. Built for the Monitoring room's minimum-level control, which says at the action that causes it that lowering also re-checks earlier issues (MOTIR-5582).

## 0.3.0

### Minor Changes

- 570ecd1: `ComboboxOption` gains `disabled?: boolean`: the option stays in the list, focusable and announced as unavailable (`aria-disabled`), reads in `--el-text-secondary`, and a click or Enter on it commits nothing. Built for the status picker's held moves (MOTIR-5528).

## 0.2.0

### Minor Changes

- 1491e94: The renamed workbench landing surface with its five tab slots and every state, the
  hero AI control taking each style's material, and the 3D / Immersive shell chrome
  reaching every signed-in surface rather than only its own canvas. The collapsed
  rail derives from `--height-control`, the avatar ramp is re-warranted on its real
  consumer, and the inert `tailwindcss-animate` classes are deleted at all four sites.
