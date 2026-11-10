# @motir/design-system

Motir's **3-axis design system** (Colour · Style · Type), extracted from
`motir-core` into a distributable package so the same tokens + primitives that
skin the Motir app can skin planner-scaffolded products — and the design choice
a user makes in onboarding can be re-applied by the coding agent at scaffold
time. One source, no vendored copies (the drift `notes.html` #18 warns of).

See the keystone decision: [`docs/decisions/design-system-package.md`](../../docs/decisions/design-system-package.md).

> **Scope of this package (Subtask MOTIR-1526).** This package is _created and
> verifiable in isolation_ here. Rewiring `motir-core` to consume it (replacing
> its inline `lib/theme/*` + `components/ui/*` with thin re-exports of this
> package) is the **next** subtask (MOTIR-1527), and the base-starter port is
> MOTIR-1528 — so each lands as its own reviewable PR. `motir-core`'s own files
> are untouched by this PR.

## What it ships

- **`@motir/design-system/theme.css`** — the full token layer as a distributable
  stylesheet: the Tailwind v4 `@theme` block, `@custom-variant dark`, the Tier-3
  `--el-*` element tokens, every `[data-palette]` / `[data-style]` /
  `[data-type]` / `[data-surface]` override + surface-material block, and the
  **motion floor** below.
- **`@motir/design-system`** (JS entry) — the axis **registries**
  (`STYLE_IDS` / `PALETTE_IDS` / `TYPE_IDS`, `resolve*`, `is*Id`,
  `STYLE_DEFAULT_TYPE`), the **theme-apply API** (`buildThemeInitScript`,
  `resolveAxesToApplied`, `resolveAppliedAppearance`, `THEME_STORAGE_KEYS`,
  `THEME_DEFAULTS`), the applied-appearance **types**
  (`AppliedAppearanceDto`, `AppearancePreferenceDto`, `ThemePattern`, `StyleId`,
  `PaletteId`, `TypeId`), the `cn` helper, the **theme provider** (`ThemeProvider`
  / `useTheme`), the axis **pickers** (`StylePicker` / `PalettePicker` /
  `TypePicker` / `ThemeSegmentedControl`, from `AppearancePickers`) + the
  `StyleVignette` live preview, and the framework-agnostic **UI primitives** —
  among them the **date picker** (`DatePicker` / `DatePickerProps`) and its
  date-format injection exports (`DatePickerFormatProvider`,
  `useDatePickerFormat`, `resolveDatePickerFormat`, `defaultDatePickerFormatter`,
  `DEFAULT_DATE_PICKER_LOCALE`, and the `DatePickerLocale` / `DatePickerFormatter`
  types); see [DatePicker](#datepicker).

## Usage

Compose the tokens in your `globals.css` with three lines:

```css
@import 'tailwindcss';
@import '@motir/design-system/theme.css';
/* Tailwind skips node_modules: scan the package's compiled components too. */
@source '../node_modules/@motir/design-system/dist';
```

The `@import` of `theme.css` is enough for the **token** utilities, because
Tailwind v4 reads `@theme` from the imported CSS. It is not enough for the
utilities the package's **components** use. Tailwind finds class names by
scanning source files, and its automatic detection leaves out `node_modules`.
A utility that appears only inside a compiled component under `dist/` (a
display-font face, a large heading size, a two-column grid at a breakpoint) is
then never generated. The build passes and nothing warns you; the component
just renders without that style. The `@source` line tells Tailwind to scan
`dist/` as well.

The `@source` path is relative to the stylesheet it is written in. The line
above is for an `app/globals.css` at the project root. For a
`src/app/globals.css`, use `'../../node_modules/@motir/design-system/dist'`.

Inside the motir-core monorepo, motir-core itself needs no `@source` line: the
package is a workspace directory inside the project root, and Tailwind already
scans its `src/` files.

Apply a stored `{styleId, paletteId, typeId}` choice before hydration (FOUC-safe):

```tsx
import { buildThemeInitScript, resolveAxesToApplied } from '@motir/design-system';

const applied = resolveAxesToApplied(storedChoice);
// render <script dangerouslySetInnerHTML={{ __html: buildThemeInitScript(applied) }} /> in <head>
```

Use the primitives + provider as normal React components:

```tsx
import { ThemeProvider, Button, Card } from '@motir/design-system';
```

## DatePicker

### What it is

An accessible date field: a trigger that opens a month-grid calendar (the
WAI-ARIA dialog + grid pattern, with roving tabindex and the full keyboard
model). Its value is an ISO `YYYY-MM-DD` string or `null`, and `onChange`
emits the same. All of its date maths is UTC-only, so no host timezone shifts a
day. It is a `'use client'` module with no `next` or `next-intl` dependency.

```tsx
import { DatePicker } from '@motir/design-system';

<DatePicker
  value={dueDate} // 'YYYY-MM-DD' | null
  onChange={setDueDate} // (next: string | null) => void
  aria-label="Due date"
  placeholder="Select a date"
  disabled={false}
  id="due-date"
  autoOpen={false}
  onClose={() => {}}
  className="w-56"
  locale="zh-CN" // optional — see below
  formatDate={myFormatter} // optional — see below
/>;
```

### Locale and formatter inputs

The trigger shows the selected date formatted by two injected inputs:

- **locale** — `DatePickerLocale`, an opaque BCP-47-style string such as `en`
  or `zh-CN`. It is a plain `string`, not a closed union, so any app can pass its
  own locale through unchanged.
- **formatter** — `DatePickerFormatter`, the signature
  `(isoDate, locale) => string`. The picker calls it with the selected value and
  the resolved locale.

`DatePicker` takes them as two optional props, `locale` and `formatDate`.

### The default

With no `locale`, no `formatDate` and no provider, the picker uses locale `en`
(`DEFAULT_DATE_PICKER_LOCALE`) and `defaultDatePickerFormatter`, a UTC
formatter. `2026-06-03` reads `Jun 3, 2026`, the same text motir-core's
`formatDate('2026-06-03', 'en')` returns, because it calls the same Intl
options:

```ts
new Date(isoDate).toLocaleString('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
```

The default formatter maps bare `en` to `en-US` and passes every other locale
to Intl unchanged. If Intl rejects a malformed tag, it falls back to the `en-US`
output instead of throwing. Because both the parsing and the formatting are in
UTC, a date near midnight UTC (`2026-01-01`, `2026-12-31`, `2024-02-29`) reads as
its own calendar day on every host, west or east of Greenwich.

### Setting it once with the provider

Wrap a subtree in `DatePickerFormatProvider` to set either input for every
picker below it:

```tsx
import { DatePickerFormatProvider } from '@motir/design-system';

<DatePickerFormatProvider locale="zh-CN" formatDate={myFormatter}>
  <App />
</DatePickerFormatProvider>;
```

Two more exports serve code that formats a date outside the picker:
`useDatePickerFormat(props?)` returns the resolved `{ locale, formatDate }` for a
component (its `formatDate(iso)` is already bound to the locale), and the pure
`resolveDatePickerFormat(props?, provider?)` does the same resolution with no
React, so a Server Component can import it.

### Precedence

A prop beats the provider, and the provider beats the default. The locale and
the formatter are resolved **separately**, so:

- a provider that sets only one input keeps the default for the other (a
  provider with only `locale="zh-CN"` keeps the default formatter, which then
  formats in `zh-CN`);
- a nested provider overrides only the fields it sets and inherits the rest
  from the provider above it;
- an `undefined` prop falls through to the provider, then to the default.

| `locale` prop | provider `locale` | `formatDate` prop | provider `formatDate` | the trigger shows                          |
| ------------- | ----------------- | ----------------- | --------------------- | ------------------------------------------ |
| —             | —                 | —                 | —                     | `defaultDatePickerFormatter(iso, 'en')`    |
| —             | `zh-CN`           | —                 | —                     | `defaultDatePickerFormatter(iso, 'zh-CN')` |
| —             | `de-DE`           | —                 | `f`                   | `f(iso, 'de-DE')`                          |
| `zh-CN`       | `de-DE`           | —                 | `f`                   | `f(iso, 'zh-CN')`                          |
| `zh-CN`       | `de-DE`           | `g`               | `f`                   | `g(iso, 'zh-CN')`                          |

### What stays English

The locale and formatter change only the trigger's date text. The calendar's own
strings are not translated by the locale input and stay English: the month and
weekday names, `Select a date` (the default `placeholder`), `Clear date`,
`Today`, `Clear`, `Previous month` and `Next month`. Pass your own `placeholder`
and `aria-label` to localise those two.

### Wiring an app's own i18n

The package depends on no i18n library; the app maps its own locale and
formatter onto the provider, in app code. For example, with an app hook
`useAppLocale()` and the app's own date helper:

```tsx
'use client';

import { DatePickerFormatProvider, type DatePickerFormatter } from '@motir/design-system';
import { useAppLocale } from './i18n'; // your app's i18n library
import { formatAppDate } from './dates'; // your app's own formatter

// Module scope, so the provider gets the same function on every render.
const appFormatter: DatePickerFormatter = (isoDate, locale) => formatAppDate(isoDate, locale);

export function AppDatePickerFormat({ children }: { children: React.ReactNode }) {
  return (
    <DatePickerFormatProvider locale={useAppLocale()} formatDate={appFormatter}>
      {children}
    </DatePickerFormatProvider>
  );
}
```

Mount it once near the root, inside the app's i18n provider, and every
`DatePicker` below it formats in the reader's language.

## Motion — the reduced-motion floor is the PACKAGE's, not the consumer's

**`theme.css` owns the `prefers-reduced-motion` guard for every animation the
design system ships.** A consumer imports the stylesheet and is done; it does
not have to know which primitives animate, and it must not have to rediscover
the guard per surface. Two kinds live here:

- **Style-axis motion** — the `aurora` canvas drift, the `3d-immersive` tilt and
  menu unfold — gated inside the `[data-style]` block that introduced it,
  because the motion belongs to that style.
- **The motion floor** — motion that belongs to no style and renders under every
  axis combination. Today that is `.animate-spin`, which `Spinner` paints and
  `<Button loading>` inherits: under `prefers-reduced-motion: reduce` it sets
  `animation: none` and nothing else (MOTIR-3844). It is unlayered, which is what
  makes it outrank Tailwind's `@layer utilities` copy of the same class whatever
  the specificity or the `@import` order.

**Stop the rotation, keep the glyph.** A spinner is the only signal that a
control is working, so the guard stills it rather than hiding it — the ring keeps
its size, its border and its `role="status"`. A consumer whose only in-flight cue
is the rotation should pair it with a **label change**, since with the animation
stilled the word is the whole of the state.

**Adding an animation to this package means adding its guard here**, in the same
change — `tests/theme/reducedMotionSpinner.test.ts` in `motir-core` reads the
floor back off the COMPILED stylesheet for both consumer shapes, so a guard that
does not survive compilation fails there rather than in someone's browser.

## Boundary notes (how the extraction applied the ADR's rule)

The ADR's boundary rule: a file moves in **iff** its only imports are other
package files, framework peers, or `cn`. Applying it to the ADR's known lists
turned up three cases the audit's frozen list didn't fully reconcile — resolved
here, per the ADR's explicit delegation to this subtask:

- **`StyleVignette`** used the domain `IssueTypeIcon` for a single decorative
  glyph. Kept in the package, decoupled by inlining that glyph
  (`BookOpen` + `--el-type-story`) — pixel-identical, boundary-clean.
- **`Modal` / `Toast` / `ErrorState`** used `next-intl` for one aria/label string
  each. Kept in, decoupled via optional label props (`closeLabel` /
  `dialogLabel` / `retryLabel`) defaulting to the current English strings — so the
  package carries no `next-intl` dependency (§5 "framework-agnostic where it
  can"). motir-core will pass its translated labels when it consumes them (1527).
- **`DatePicker`** was coupled to the app's i18n (`useLocale` +
  `@/lib/i18n/locales` + locale-aware date formatting), so per the ADR §1 escape
  hatch ("a primitive that turns out to have a domain import the audit missed
  stays out") it stayed out of the first extraction. It is now in the package
  with an injected locale and formatter (MOTIR-10551), and carries no
  `next-intl` dependency; see [DatePicker](#datepicker).
- The token CSS ships as **`theme.css`** (the ADR §2 name; the card's provisional
  `tokens.css` was reconciled to this).

## Rendering a mock

`@motir/design-system/mock` renders the package's OWN parts into ONE
self-contained `.mock.html`, so a design mock is the parts as they actually
render rather than a hand-copied stylesheet. It is **Node-only** (it reads files
and uses `react-dom/server`), which is why it lives on its own subpath and never
on the main entry.

```ts
renderMock({
  title: string,
  panels: { label: string; element: ReactElement }[],
  axes: { styleId: string; paletteId: string; typeId: string },
  theme?: 'light' | 'dark',   // data-theme, default 'light'
  fontCss?: string,           // inlined verbatim (e.g. @font-face with data: URLs)
  boardWidth?: 'full' | 'narrow' | string, // default 'full'
}): Promise<string>
```

- Each panel is rendered with `renderToStaticMarkup` into a labelled board
  section, and `<html>` carries `data-style` / `data-palette` / `data-type` /
  `data-theme`.
- Each axis id is checked against the package's registries. An unknown or
  missing id falls back to that axis's default (the type axis to the pairing
  the resolved style uses) and the fallback is named in an HTML comment at the
  top of the document. It never throws.
- The board is the viewport's width by default (`boardWidth: 'full'`): a design
  result is reviewed at the width of the screen it is opened on, and a page's
  own column (`max-w-[46rem]`, `max-w-[1400px]`…) sits inside the board as the
  page ships it. `'narrow'` gives the 64rem column mocks had before 0.19, and
  any other string is ONE max-width class, compiled like the rest of the
  markup. A value that is not one class falls back to `'full'` with a comment,
  as an unknown axis does. Do not change the board by editing the rendered
  HTML.
- The CSS is **compiled**, not copied: Tailwind v4 (the `tailwindcss` peer's
  `compile()` API) runs over the rendered markup with this package's
  `theme.css` as input, and the result is inlined in one `<style>`.
- The document makes no network request: no stylesheet link, no script, no
  remote `@import`. Fonts fall back to the stacks `theme.css` declares unless
  you pass `fontCss`.

A script in a consuming repository (run it with `pnpm tsx`):

```tsx
// scripts/render-settings-mock.tsx
import { mkdir, writeFile } from 'node:fs/promises';
import { Button, Card, Pill } from '@motir/design-system';
import { renderMock } from '@motir/design-system/mock';

const palette = process.argv[2] ?? 'amethyst';

const html = await renderMock({
  title: 'Project settings — save bar',
  axes: { styleId: 'warm-editorial', paletteId: palette, typeId: 'motir' },
  panels: [
    {
      label: 'Unsaved changes',
      element: (
        <Card>
          <Pill status="in-progress">Unsaved</Pill>
          <Button variant="primary">Save changes</Button>
        </Card>
      ),
    },
  ],
});

await mkdir('design/settings', { recursive: true });
await writeFile('design/settings/save-bar.mock.html', html);
```

Run it again with another palette id (`pnpm tsx scripts/render-settings-mock.tsx cobalt`)
and the same parts recolour.

## Development

```bash
pnpm --filter @motir/design-system build      # tsup → dist (ESM + d.ts, 'use client' preserved)
pnpm --filter @motir/design-system typecheck   # tsc --noEmit
pnpm --filter @motir/design-system test        # vitest (registries, apply API, render)
```

`TokensSpecimen` is a live `/tokens`-style render of the whole system for
in-isolation verification; drop it into any route or render it headless.

## Releasing

Releases publish to the **public npm registry** (ADR §3) via CI. There is no
manual `npm publish` and no hand bump in the normal path.

**The normal path is a changeset.** A pull request that changes what the package
ships adds one file under `.changeset/` (`npx changeset`) naming the bump
(`patch` / `minor` / `major`) and one line for the changelog. On `main`,
`.github/workflows/release.yml` keeps a **Version Packages** pull request in sync
with every pending changeset. Merging that pull request raises `version` in
`packages/design-system/package.json`, writes the new entry into `CHANGELOG.md`,
and pushes `design-system-v<version>` on the commit that set it. That tag fires
`.github/workflows/release-design-system.yml`, which builds, verifies and
publishes. A change with no changeset is still released by the next Version
Packages merge, but the changelog will not say it shipped, so every new style,
palette, pairing or export needs its own changeset.

**Fallback, when that lane cannot run** — the hand steps the tag-triggered
workflow still accepts:

1. **Bump the version** in `packages/design-system/package.json` (semver: the
   token contract — `--el-*` names, the `data-*` attribute set, the apply API — is
   the public surface, so renaming a token or attribute is a **major** bump).
2. **Open + merge** the PR with the bump.
3. **Tag and push** — the tag version MUST equal the `package.json` version (the
   workflow guards this and fails fast otherwise):

   ```bash
   git tag design-system-v<x.y.z>          # e.g. design-system-v0.1.1
   git push origin design-system-v<x.y.z>
   ```

4. The workflow builds, verifies the tarball (`dist/**` + `theme.css`), and
   publishes `@motir/design-system@<x.y.z>` with public access. Re-running an
   already-published version is a no-op (idempotent), not a failure.

**Dry run:** trigger the workflow from the Actions tab via **Run workflow**
(`workflow_dispatch`) with **dry run** checked to build + pack without publishing.

**Auth:** the publish step uses **OIDC Trusted Publishing** — no `NPM_TOKEN` secret.
GitHub mints a short-lived id-token (`id-token: write`) that npm exchanges for a
one-time publish credential, gated by a Trusted Publisher configured on npmjs.com
for this package (org `motir-co` / repo `motir-core` / this workflow filename).
npm provenance is auto-generated on a Trusted Publish (the `repository` field in
this `package.json` satisfies its requirement).

> The **first** publish (`0.1.0`) was cut manually (`npm publish` with an
> interactive OTP), because OIDC cannot bootstrap a package that does not yet exist
> — the Trusted Publisher config lives on the package's settings page. Every release
> from `0.1.1` on flows through the workflow token-free.
