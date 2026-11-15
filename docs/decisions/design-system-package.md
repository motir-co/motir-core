# ADR: `@motir/design-system` — package boundary + cross-repo distribution

- **Status:** Accepted (2026-07-02, drafted for Yue's review). This is the
  keystone decision Story **MOTIR-1524** ("Package the 3-axis design system as
  `@motir/design-system`") builds against — the extraction (MOTIR-1526), the
  starter port (MOTIR-1528), and the agent-applies-choice work all depend on the
  shapes fixed here. **No runtime ships in this ADR** — it fixes contracts only.
- **Story / Subtask:** MOTIR-1524 (design-system packaging) · Subtask **MOTIR-1525**
  (this decision). `blocks` MOTIR-1526 (extract the package) + MOTIR-1528 (starter
  imports the package).
- **Supersedes / superseded by:** none. **Retires** the
  `nextjs-prisma-vercel-starter-with-design` prototype (see §3.1 — it is superseded
  by this package, not adopted as a consumer).
- **Amended by:** [`brand-asset-distribution.md`](./brand-asset-distribution.md)
  (MOTIR-3724, 2026-08-27) — this ADR is **silent** about Motir's own brand assets,
  because the brand mark did not exist when it was accepted (MOTIR-1150 landed five
  weeks later). That ADR adds the test §1's import rule cannot make and this one
  never contemplated: **who INSTALLS the package**. Read the two together.
- **Generalised by:** [`app-shell-over-packages.md`](./app-shell-over-packages.md)
  (MOTIR-4297, 2026-09-03) — this ADR fixed the boundary for ONE package, chosen because its
  consumers are other repositories. That one fixes the shape for every package in
  `packages/*`, including the ones with a single in-repo consumer, and takes §1's import rule
  and §5's barrel rule as its own. Where the two could differ — whether a context should be a
  second REPOSITORY rather than a package — it defers to this document's reasoning and names
  the condition under which a package inherits it.
- **Builds on:** the three-axis design system shipped by Story 7.3 (Colour /
  Style / Type on `<html>` via `data-theme` + `data-palette` + `data-style` +
  `data-type`), the `@motir/cli` workspace-package precedent (`packages/cli`,
  Subtask 7.9.1), and the token architecture in
  [`docs/design-system.md`](../design-system.md) + [`DESIGN.md`](../DESIGN.md).

---

## Context

Motir dogfoods its own 3-axis design system: the same registries + tokens that
skin the Motir app are meant to be the design system a **planner-scaffolded
product** ships with, and the design choice a user makes in the onboarding
`DesignStep` / the account-settings Appearance pane is meant to be re-applied by
the coding agent when it scaffolds that product. Today all of it lives **inside
`motir-core`** — `lib/theme/*`, the `app/globals.css` token layers, and the
`components/ui/*` + `components/theme/*` primitives. It is reachable only by
copy-paste from another repo.

That copy-paste already happened once: `nextjs-prisma-vercel-starter-with-design`
is a **partial, hand-copied port** — 2 of the 7 `lib/theme/*` files
(`init-script.ts`, `types.ts`), 12 of the 33 `components/ui/*` primitives, a
`lib/contexts/theme-context.tsx`, an `app/tokens` route, and its **own**
`globals.css`. It has already drifted from motir-core's shipped system. Two hand
copies of one design system is exactly the "two design systems" failure
`notes.html` mistake #18 warns about, and the "never plan a monorepo split /
retroactive vendoring later" prompt-hint under mistake #17 (line 969) applies
directly: the shared boundary is drawn **once, up front, with a real
distribution contract** — not vendored and reconciled later.

**Who actually consumes this package (the load-bearing frame).** Per `notes.html`
mistake #22, a Motir-pipeline artifact is optimized for its **internal pipeline
consumer**, not a hypothetical external GitHub developer. The consumers here are:

1. **`motir-core`** — dogfoods the system (workspace dep).
2. **`nextjs-prisma-vercel-starter`** — a **planner input**, not a user product;
   the planner forks it and plans on top (mistake #22).
3. **The coding/scaffold agent** — which, at scaffold time, must `install` the
   package and re-apply the user's stored `{styleId, paletteId, typeId}` choice
   with **zero credential friction**.

Every decision below optimizes for those three, in that order.

---

## Decision

### 1. The package boundary — what moves in, what stays

`@motir/design-system` is a new workspace package at
`motir-core/packages/design-system` (a sibling of `packages/cli`). Its **name**
is `@motir/design-system`; its **license is MIT** from the relicensing on
(MOTIR-11318, which relicensed it from `GPL-3.0-only` so the closed gateway can
consume it; versions published before that release keep their `GPL-3.0-only`
terms).

**The boundary rule (what makes a file shareable):** a file moves into the
package **iff** its only imports are (a) other package files, (b) framework peers
(`react` / `react-dom` / `next` / `lucide-react` / `@radix-ui/*` / `tailwind-merge`),
and (c) the classname helper `cn`. A file that imports **any Motir domain module**
(`@/lib/dto/workItems`, `@/lib/workItems/*`, `@/lib/issues/*`,
`@/components/issues/*`) or **app-infra** (`@/lib/i18n/locales`, `@/lib/shortcuts`,
`@/lib/blob/allowlist`, the app's session/router) **stays in motir-core**. This
rule was validated against the actual import graph (see the audit in §Evidence).

> **⚠️ THE IMPORT RULE IS NECESSARY AND NOT SUFFICIENT — a second test runs BEFORE
> it** ([`brand-asset-distribution.md`](./brand-asset-distribution.md), MOTIR-3724).
> An artifact that IDENTIFIES Motir — the wave band, the wordmark, the lockup, an app
> icon, an OG template — stays out of this package however clean its imports are,
> because this package's declared consumers (§Context) build products that are not
> Motir. `components/brand/BrandMark.tsx` passes the rule above cleanly and is
> excluded anyway; it ships as `@motir/brand`. The rule below is unchanged — a file
> that FAILS it still stays in motir-core.

**IN the package:**

| Group                         | Files                                                                                                                                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3-axis registries             | `lib/theme/{palettes,styles,typography,types,appearance-resolution,init-script,tilt}.ts`                                                                                                                                                                                                            | Pure data + resolvers. **`tilt.ts` moves too** — it is part of `lib/theme/*` and the `3d-immersive` style depends on it (the card's file list omitted it; include it).                                                                                                                                                                                                                                                                                                                |
| Applied-appearance type       | `AppliedAppearanceDto` (+ `AppearancePreferenceDto`)                                                                                                                                                                                                                                                | **Currently at `@/lib/dto/appearancePreference`** — `init-script.ts` and `appearance-resolution.ts` import it. It is part of the public apply contract (§4), so it **must re-home into the package** (e.g. `packages/design-system/src/appearance.ts`); motir-core re-exports from `@/lib/dto/appearancePreference` for its existing importers. **This is the one cross-boundary import inside `lib/theme/*`** — resolving it is a hard prerequisite for the extraction (MOTIR-1526). |
| Token CSS                     | the `app/globals.css` layers: the `@theme` block (Tier-0 `--color-*` + generic scales), `@custom-variant dark`, the Tier-3 `--el-*` element tokens, the `[data-palette='…']` / `[data-style='…']` / `[data-type='…']` override blocks, and the surface-material `[data-style] [data-surface]` rules | Shipped as a preset + a `.css` — see §2.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Theme context/init            | `lib/contexts/theme-context.tsx` (the client provider) + `components/theme/{AppearancePickers,StyleVignette}.tsx` + `HandDrawnFilter.tsx` + `ImmersiveTilt.tsx`                                                                                                                                     | `AppearancePickers` consumes the context + registries; `StyleVignette` is the shipped preview specimen. All four are design-system-only.                                                                                                                                                                                                                                                                                                                                              |
| Framework-agnostic primitives | the `components/ui/*` primitives with **no Motir-domain coupling**: `Button, Card, Input, Textarea, FormField, Modal, Pill, Popover, Combobox, SectionLabel, Segmented, Switch, Spinner, Tooltip, Toast, EmptyState, ErrorState, DatePicker, MultiSelectPicker, ColorSwatchPicker`                  | These import only `cn` + peers.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The `cn` helper               | `lib/utils/cn.ts`                                                                                                                                                                                                                                                                                   | Imported by ~30 primitives; wraps `tailwind-merge` (already a dep). Moves in as a package util; motir-core re-exports it from `@/lib/utils/cn` to avoid churn.                                                                                                                                                                                                                                                                                                                        |
| The `/tokens` specimen        | a token-specimen surface (route or exported page component)                                                                                                                                                                                                                                         | Consumers get a live spec without rebuilding it.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**STAYS in motir-core (app-coupled — the boundary rule excludes them):**
`components/ui/{TreeTable, ReadinessBadge, CommandPalette, AppLayout, Sidebar,
SidebarDrawer, SidebarToggle, MarkdownEditor, MarkdownView, markdownEditorMentions,
useRowWindow}` and `charts/*` — each imports work-item DTOs, `@/components/issues/*`,
i18n, shortcuts, or blob/allowlist. All routes, and every Motir business component
(board, work-item detail, reports, triage, settings surfaces). These **consume**
the package; they do not live in it.

> The exact primitive-by-primitive in/out split is applied by the extraction
> subtask (MOTIR-1526) using the boundary rule above — this ADR fixes the **rule**
> and the known lists, not a frozen manifest. A primitive that turns out to have a
> domain import the audit missed stays out; one that is domain-free moves in.

### 2. Token CSS shipping form — a Tailwind v4 `@theme` preset **and** a `.css`

The tokens ship in **two artifacts a consumer imports, never copy-pastes**:

1. **`@motir/design-system/theme.css`** — the full token layer: `@theme` block,
   `@custom-variant dark`, the `--el-*` Tier-3 tokens, and all `[data-palette]` /
   `[data-style]` / `[data-type]` / `[data-surface]` override blocks. A consumer's
   `globals.css` does `@import 'tailwindcss'; @import '@motir/design-system/theme.css';`
   and gets the entire swap system. Because Tailwind v4 reads `@theme` from imported
   CSS, the utilities generated from `--color-*` (and the `--el-*`/shape tokens the
   components consume) are available with no extra config.
2. **The registries as JS** (`@motir/design-system` main entry) — `STYLE_IDS`,
   `PALETTE_IDS`, `TYPE_IDS`, `STYLE_DEFAULT_TYPE`, the `resolve*` / `is*Id` guards,
   and the apply API (§4). These are the data behind the CSS, used by the picker UI
   and the init-script.

Rationale for shipping BOTH: the `.css` is what a `globals.css` composes; the JS is
what the picker + init-script + agent read. Neither subsumes the other. The package
`exports` map exposes `.` (JS) and `./theme.css` (CSS) as distinct entry points.

### 3. Distribution mechanism — **publish to the PUBLIC npm registry** as a versioned dep

The crux. Options weighed:

| Option                        | Verdict                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public npm, versioned dep** | **CHOSEN.**                                                                                                                                                                                                                                                                                                                                                     |
| Private npm registry          | Rejected — the package is open source by design (MIT from 0.23.0, MOTIR-11318; earlier versions `GPL-3.0-only`); a private registry adds scaffold-time **auth friction** (the agent + every scaffolded product would need registry creds) for zero benefit. Directly violates the "zero credential friction for the scaffold agent" optimization (mistake #22). |
| Git dependency                | Rejected — the package lives in a **subdirectory** of `motir-core`; git deps handle subpaths poorly, pin to a commit/tag (no semver ranges), and pull the whole repo. Awkward updates.                                                                                                                                                                          |
| Vendored / sync-script copy   | Rejected — reintroduces the drift the `-with-design` prototype already demonstrated; "two design systems" (mistake #18). This is the anti-pattern the whole story exists to kill.                                                                                                                                                                               |

**The mechanism:** `motir-core/packages/design-system` is the single source. It is
**published to the public npm registry as `@motir/design-system`** (MIT from 0.23.0,
MOTIR-11318; earlier versions `GPL-3.0-only`). Because
it is open-source, the public registry costs nothing and imposes **no auth at install
time** — the scaffold agent and any scaffolded product `pnpm add @motir/design-system`
like any public package.

- **motir-core** consumes it via the **pnpm workspace** (`packages/*`, `workspace:*`)
  during development, and publishes the built package on release.
- **`nextjs-prisma-vercel-starter`** (and every scaffolded product) depends on the
  **published** `@motir/design-system@^<major>` with a caret range.
- **Updates:** a scaffolded product gets patch/minor updates through normal
  `pnpm update` within its pinned major. Breaking changes bump the major (semver);
  the token contract (`--el-*` names, the `data-*` attribute set, the apply API) is
  the semver surface — renaming a token or attribute is a major bump.
- **Version pinning:** the starter pins `^<major>`; the CI that scaffolds a product
  pins the same, so a scaffold is reproducible.

**Publish setup (for MOTIR-1526):** `packages/design-system/package.json` carries
`"publishConfig": { "access": "public" }`, an `exports` map (`.` + `./theme.css`),
`peerDependencies` (§4), a `files` allowlist (built `dist` + `theme.css`), and a
`tsup` build (mirroring `@motir/cli`). Publishing itself is a release-time step, not
part of the extraction PR.

### 3.1 The `-with-design` prototype is **SUPERSEDED**, not adopted

`nextjs-prisma-vercel-starter-with-design` is a partial hand copy that predates the
package idea and has already drifted. It is **retired**: the **base**
`nextjs-prisma-vercel-starter` becomes the single consumer by importing
`@motir/design-system` (MOTIR-1528), which is strictly a superset of what the
prototype hand-copied. Once the base starter imports the package, the `-with-design`
fork is archived. There is exactly **one** source of the design system (the package)
and no second copy to keep in sync.

### 4. The theme-apply contract for consumers (the stable seam for the agent)

The public API a consumer calls to APPLY a stored `{pattern, styleId, paletteId,
typeId}` choice is **exactly what motir-core ships today** (Story 7.3.61) — this ADR
freezes it as the package's public surface so MOTIR-1526 exports it unchanged and the
agent-applies-choice subtask (MOTIR-1528's sibling) has a stable seam.

**The applied state = four attributes on `<html>`** (set before hydration to avoid
FOUC):

```
<html data-theme="light|dark"      // resolved from pattern (system→matchMedia at runtime)
      data-style="<styleId>"        // Axis 2 — shape/silhouette/elevation
      data-palette="<paletteId>"    // Axis 1 — the --el-* colour swap
      data-type="<typeId>">         // Axis 3 — the --font-* role pairing
```

> Note: the CSS keys the shape axis on **`data-style`** (e.g.
> `[data-style='glassmorphism']`), not `data-display-style` as the card phrased it —
> the accurate attribute is `data-style`.

**Public API (re-exported verbatim from the package):**

- **`buildThemeInitScript(serverPref: AppliedAppearanceDto | null): string`** — returns
  the inline pre-hydration `<script>` body that sets the four attributes (and reconciles
  the localStorage cache). `serverPref` = the signed-in user's applied appearance, or
  `null` for anonymous (reads localStorage + resolves via the baked-in registries). Also
  exports `themeInitScript` (the anonymous baseline).
- **`resolveAxesToApplied(axes): AppliedAppearanceDto`** and
  **`resolveAppliedAppearance(server, local): AppliedAppearanceDto`** — resolve raw stored
  axis values (a DB row or a localStorage snapshot) to the four concrete ids, applying the
  **type-axis precedence** (a pinned `typeId` wins, else the active style's `defaultTypeId`).
- **`THEME_STORAGE_KEYS`** (`motir.theme.{pattern,style,palette,type}`) and
  **`THEME_DEFAULTS`** — the localStorage cache contract.
- **The registries** — `STYLE_IDS` / `PALETTE_IDS` / `TYPE_IDS`, `STYLE_DEFAULT_TYPE`,
  `resolveStyle` / `resolvePalette` / `resolveType` / `resolvePattern`, and the
  `isStyleId` / `isPaletteId` / `isTypeId` / `isThemePattern` guards.
- **The types** — `AppliedAppearanceDto`, `AppearancePreferenceDto`, `ThemePattern`,
  `StyleId`, `PaletteId`, `TypeId`.
- **The provider + pickers** — `theme-context` (the client `ThemeProvider` + `useTheme`),
  `AppearancePickers`, `StyleVignette`.

**How the scaffold agent uses it:** to apply a stored choice, the agent (a) adds
`@import '@motir/design-system/theme.css'` to the product's `globals.css`, and (b) renders
`buildThemeInitScript(applied)` (where `applied = resolveAxesToApplied(storedChoice)`) in the
root layout `<head>`. That is the entire seam — no bespoke per-product theming code.

### 5. Peer deps + framework assumptions

- **`peerDependencies`:** `react` `^19`, `react-dom` `^19`, `next` `^16`,
  `tailwindcss` `^4`. (Both motir-core and both starters are on Next 16.2.6 / React
  19.2.4 / Tailwind v4 today — this pins the current reality, not an aspiration.)
- **`next` is a peer only for the primitives that use it** (`next/font`,
  `next/navigation`); the **registries + resolvers + init-script are pure TS with
  zero framework imports** and are RSC-safe / usable in any bundler. `tailwindcss` is
  a peer for consuming the `@theme` preset.
- **RSC boundary is preserved as-is:** registries and pure helpers are server-safe; the
  interactive primitives + provider keep their `'use client'` directives exactly as they
  ship in motir-core today. The package does not change any component's client/server
  status.

---

## Consequences

- **MOTIR-1526** (extract the package) is now fully specified: move the IN-set per the
  boundary rule, **re-home `AppliedAppearanceDto`** into the package (the one cross-boundary
  import), ship `theme.css` + the JS entry via `exports`, wire the `tsup` build + publish
  config mirroring `@motir/cli`, and switch motir-core to consume via `workspace:*` (its
  `lib/utils/cn`, `lib/theme/*`, and the moved primitives become thin re-exports so no
  app-side import path churns).
- **MOTIR-1528** (starter imports the package) is now a **superset swap**, not a re-port:
  the base starter adds the dep + the `@import`, deletes any hand-copied theme code, and
  the `-with-design` fork is archived.
- **The agent-applies-choice work** builds on the frozen §4 seam.
- **One design system, one source.** No vendored second copy; drift is structurally
  impossible (mistake #18 avoided). The open-core boundary is honored — the package is
  open source (MIT from 0.23.0, MOTIR-11318; earlier versions `GPL-3.0-only`).

---

## Evidence (verified against shipped `main`, 2026-07-02)

- **`lib/theme/*` is self-contained except one type:** the only `@/`-import inside
  `lib/theme/*` is `AppliedAppearanceDto` from `@/lib/dto/appearancePreference` (in
  `init-script.ts` + `appearance-resolution.ts`). Everything else resolves within
  `lib/theme/*`.
- **The applied attribute set is `data-theme` + `data-style` + `data-palette` +
  `data-type`** — confirmed in `lib/theme/init-script.ts` (`d.setAttribute(...)`) and
  `lib/theme/types.ts` (the axis doc). The CSS keys shape on `[data-style='…']` (27×
  `3d-immersive`, 20× `retrofuturism`, etc. in `globals.css`).
- **The primitive coupling split** (which `components/ui/*` are domain-free vs.
  app-coupled) is drawn from the actual import audit: `cn` (30×) is universal;
  `@/lib/dto/workItems`, `@/components/issues/IssueTypeIcon`, `@/lib/workItems/quickSearch`,
  `@/lib/issues/parentRules`, `@/lib/i18n/locales`, `@/lib/shortcuts`,
  `@/lib/blob/allowlist` mark the app-coupled primitives that stay.
- **Versions:** `motir-core` and both starters ship `next@16.2.6`, `react@19.2.4`,
  `tailwindcss@^4` (`package.json`).
- **Workspace precedent:** `packages/cli` (`@motir/cli`, `GPL-3.0-only`, `tsup` build,
  `exports`/`files`/`bin`) is the shape MOTIR-1526 mirrors.
- **The prototype's partiality:** `nextjs-prisma-vercel-starter-with-design` carries only
  `lib/theme/{init-script,types}.ts` (2 of 7), 12 `components/ui/*` (of 33), a
  `lib/contexts/theme-context.tsx`, and its own `globals.css` — a drifted hand copy.
