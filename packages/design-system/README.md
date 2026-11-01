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
  `StyleVignette` live preview, and the framework-agnostic **UI primitives**.

## Usage

Compose the tokens in your `globals.css` (Tailwind v4 reads `@theme` from the
imported CSS, so utilities generate with no extra config):

```css
@import 'tailwindcss';
@import '@motir/design-system/theme.css';
```

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
- **`DatePicker`** is genuinely coupled to the app's i18n (`useLocale` +
  `@/lib/i18n/locales` + locale-aware date formatting). Per the ADR §1 escape
  hatch ("a primitive that turns out to have a domain import the audit missed
  stays out"), it is **excluded** from this extraction; decoupling it (inject a
  formatter/locale) is a follow-up for the consume/port work.
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

Releases publish to the **public npm registry** (ADR §3) via CI — the
`.github/workflows/release-design-system.yml` workflow, triggered by a
package-scoped git tag. There is no manual `npm publish` in the normal path.

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
