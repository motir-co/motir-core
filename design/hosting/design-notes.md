# Hosting — Production of a Motir repository

**Design system.** Read `package.json` (depends on `@motir/design-system`, `workspace:*`, installed
0.19.0 per `packages/design-system/package.json`) and `app/globals.css` (imports
`@motir/design-system/theme.css`): **both checks hold, so this is on Motir Design.** The project's own
axes come from `app/layout.tsx` (`data-style`, `data-palette`, `data-type`, applied per viewer); the mock
is drawn at the defaults the shipped settings mocks use: `warm-editorial` · `motir` · `motir`, light
theme. Version 0.19.0 exports `@motir/design-system/mock`, so the mock **is rendered with `renderMock`**
from the package's parts (`Button`, `Card`, `Pill`, `Spinner`, `EmptyState`, `ErrorState`) on a
full-width board; Tailwind is compiled over the markup with the package's `theme.css`, so every colour,
radius, padding and height is a token the style and palette axes flip.

**Surface.** `production.mock.html` (19 panels) — the **Production** room of project settings for one
Motir repository (Story MOTIR-9797, design card MOTIR-10024). A new area, a new surface; there is no
earlier design of it, so this is a full mock, not a delta.

**Drawn against** (composed, not redrawn):

- the project settings shell and rail registry — `lib/settings/projectSettingsNav.ts`,
  `app/(authed)/settings/project/layout.tsx`;
- the **Environment** room (`design/environment/environment.mock.html` · `design-notes.md`, MOTIR-9959,
  shipped as `app/(authed)/settings/project/environment/`): its `max-w-[46rem]` column, serif title and
  lede, its repository picker (`?repository=`, Motir repositories only, a customer repository never
  offered), its not-found state, its member note box and its tokens are reused here unchanged;
- the deployment read already shown per repository — `lib/services/repoDeploymentService.ts` (the
  shipped `repo_deployment` ingestion, whose GitHub states this design maps to words, below);
- the hide-or-disable rule of `design/projects/design-notes.md` § _Amendment 2026-08-08_ (hide an entry
  point the actor cannot use, disable an in-place control with its reason, guard the destination);
- the address decision MOTIR-9790 (`<app>--<workspace>.motir.site`; no address while the workspace has
  claimed no label) — `design/workspace-address/` owns that room and is only linked to here.

## Where it lives, and why it is its own room

motir-core has **no per-repository page**: a repository is a row of the Repositories room
(`/settings/project/repositories`, gated on `repository:manage` and hidden from members) and the
Environment room picks one with `?repository=`. The Production panel has a member view, so — exactly as
Environment — it is **its own project settings room**, beside Environment:

| Registry field   | Value                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `id`             | `production`                                                                                     |
| `group`          | `general`, directly after `environment`                                                          |
| `href`           | `/settings/project/production`                                                                   |
| `icon`           | lucide `Rocket`                                                                                  |
| `labelKey`       | `nav.production` → **Production**                                                                |
| `viewPermission` | `project:browse` — every member who can browse the project sees the row and the panel            |
| `permission`     | `project:administer` — the project's administration permission; it alone shows **Roll back**     |
| hidden when      | the project holds no repository Motir hosts (panel 19): no row, no empty panel, no disabled link |

The selected repository is in the address so a link reopens the same view:
`/settings/project/production?repository=<rowId>`. With no `repository` the first Motir repository of the
project's set (in set order) is selected. **The way back** is the rail, as in every settings room. A
project with several Motir repositories shows **one panel per repository**, reached through the picker,
and the **panel header names the repository** so a screenshot or a shared link is never ambiguous.

**A customer repository shows no entry at all**: it is never in the picker, a project holding only
customer repositories has no Production row (panel 19), and its direct address answers the not-found
state (panel 16).

## Elements (named once each)

- **Production rail entry** — the `Production` row in the project settings rail, after Environment
  (panels 1, 2).
- **Repository picker** — the Environment room's single-select trigger and listbox, listing the
  project's Motir repositories by name with their role beneath (panel 1).
- **Panel header** — the repository's name with its folder glyph, above the cards.
- **Current release card** — the release serving production: the eyebrow `Serving production`, the
  short commit hash and the commit's subject line, the relative time (absolute time in the `title` on
  hover), the **state pill**, the **trigger** line, the **production address** and its **copy control**
  (or the **no-address note**), and the **Roll back control** (panels 3–7, 11, 17, 18).
- **State pill** — one per release state (table below).
- **Trigger line** — what started the release: `Merge of #<n>`, `Redeploy · production settings
changed`, `Restored by rollback · <name>`, or `Deploy of <ref> · <name>` (the deploy-a-ref entry a
  release promotion uses).
- **Production address** — `shop--acme.motir.site` as a link that opens in a new tab (with a visible
  glyph and a screen-reader `(opens in a new tab)`), followed by **Copy**, which reads **Copied** for two
  seconds (panel 18).
- **No-address note** — when the workspace has claimed no `motir.site` label: one line linking to the
  **Public address** room (panel 17), per MOTIR-9790 §1.
- **Release history list** — newest first, one row per release: commit, time, trigger, state pill; the
  **address only on the live row**; a failed row carries its **one-line reason**. Five rows per page and
  a **Show more releases** control — never an unbounded list.
- **Roll back control** — one `secondary` button on the current release card with a one-line helper,
  **for project administrators only**. Disabled, with its reason inline, when there is no earlier
  release (panel 11).
- **Roll back confirmation** — an alert dialog naming the release being **left** and the one it
  **returns to** (commit, subject, absolute time), saying it reverts running code and environment values
  and **not the database schema**, with **Roll back** (primary) and **Cancel** (panels 8–10).
- **Failed-newer note** — the status line above the card when the newest release failed (panel 5).
- **Read-only member note** — the Environment room's note box above the card for a member (panel 12).
- **Empty state** — before the first release (panel 13).

## The permission rule

- The room and every release are visible to anyone who can browse the project (`project:browse`).
- **Roll back appears only for the project's administration permission (`project:administer`).** For
  any other member it is **absent — not disabled** — from the card, the history and everywhere else, and
  the read-only note says who can roll back (panel 12). The routes' refusal stays the authority; hiding
  the control is presentation.
- For an administrator, Roll back is **disabled with its reason** only when there is no earlier release
  (panel 11) — the hide-or-disable rule: the person can act in principle, the state forbids it now.

## Release states — what is stored, and the word shown

The shipped ingestion stores GitHub's deployment states; the panel shows a closed set of five words.

| Shown         | Stored deployment state (`repo_deployment`) | Pill                              | Glyph         |
| ------------- | ------------------------------------------- | --------------------------------- | ------------- |
| `Building`    | `queued`, `pending`, `in_progress`          | `Pill status="in-progress"` (sky) | `Spinner`     |
| `Live`        | `success` (the current release)             | `Pill severity="success"` (mint)  | `Activity`    |
| `Failed`      | `failure`, `error`                          | `Pill severity="danger"` (rose)   | `CircleAlert` |
| `Replaced`    | `inactive` (a later release took over)      | `Pill tone="neutral"`             | —             |
| `Rolled back` | `inactive` (left by a rollback)             | `Pill severity="warning"` (peach) | `RotateCcw`   |

Every state carries a word and, where the hue is a tint, a glyph too, so no state rests on colour alone
(finding #35). The hue lives in the tint background with `--el-text-strong` ink (the Pill recipe), so
every pill clears AA in both themes.

## Panels and states

| #   | State                            | What it shows                                                                                      |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Access path, administrator       | Rail with Production after Environment (ringed for the reader), picker open, customer repo absent  |
| 2   | Access path, member              | Member's rail (no Details / Repositories / Members); Production present; read-only panel           |
| 3   | Live — populated default         | Current release card with address, Copy, trigger and Roll back; five history rows; Show more       |
| 4   | Building                         | The card still shows the serving release; a Building row tops the history, no address              |
| 5   | Live with a failed newer release | Two Failed rows with their reasons; the failed-newer note; the older release still Live            |
| 6   | Rolled back                      | The earlier release Live again, `Restored by rollback · Dana Ito`; the release it left Rolled back |
| 7   | Redeploy after a settings change | A Building row with the same commit and the redeploy trigger; a `Deploy of v1.4.0` row             |
| 8   | Roll back confirmation           | Leaving / Returning to, the schema sentence, Cancel and Roll back                                  |
| 9   | Confirmation — submitting        | Primary busy (`Rolling back…`), both buttons disabled, `aria-busy`, not dismissible                |
| 10  | Confirmation — error             | Inline danger box; the newer release still serving; `Try again`                                    |
| 11  | Roll back unavailable            | One release only: Roll back disabled with its reason (administrator)                               |
| 12  | Read-only member view            | The note; no Roll back anywhere                                                                    |
| 13  | Empty                            | `EmptyState`: nothing in production yet, what starts the first release                             |
| 14  | Loading                          | Spinner line, a card skeleton and three history bars (`aria-busy`)                                 |
| 15  | Error                            | `ErrorState` with `Try again`; nothing stale shown as live                                         |
| 16  | Not found                        | A customer repository or one the viewer cannot see: not-found with `Back to Production`            |
| 17  | Live, no address yet             | The no-address note linking to Public address                                                      |
| 18  | Address copied                   | `Copied`, announced through a polite live region                                                   |
| 19  | No Motir repository              | The rail without the Production row                                                                |

Behaviour the panels imply: Roll back targets **only the previous release** — there is no
pick-any-release control; after a confirmed rollback the panel updates from the response (the card and
the top of history), with no full-page refresh; a Building row never shows an address, because nothing
is serving it yet; the history repeats the address on the live row only.

## Copy (message keys under `settings.production`)

| Key                        | English                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav.production`           | Production                                                                                                                                                           |
| `title`                    | Production                                                                                                                                                           |
| `lede`                     | What is live for each of this project’s apps, what the last merges did, and how to undo a bad release.                                                               |
| `repositoryLabel`          | Repository                                                                                                                                                           |
| `current.eyebrow`          | Serving production                                                                                                                                                   |
| `state.building`           | Building                                                                                                                                                             |
| `state.live`               | Live                                                                                                                                                                 |
| `state.failed`             | Failed                                                                                                                                                               |
| `state.replaced`           | Replaced                                                                                                                                                             |
| `state.rolledBack`         | Rolled back                                                                                                                                                          |
| `trigger.merge`            | Merge of #{number}                                                                                                                                                   |
| `trigger.redeploy`         | Redeploy · production settings changed                                                                                                                               |
| `trigger.rollback`         | Restored by rollback · {name}                                                                                                                                        |
| `trigger.ref`              | Deploy of {ref} · {name}                                                                                                                                             |
| `address.newTab`           | (opens in a new tab)                                                                                                                                                 |
| `address.copy` / `.copied` | Copy / Copied                                                                                                                                                        |
| `address.copyAria`         | Copy {address}                                                                                                                                                       |
| `address.none`             | No address yet — claim a motir.site address for the workspace in {link}.                                                                                             |
| `address.noneLink`         | Public address                                                                                                                                                       |
| `rollback.action`          | Roll back                                                                                                                                                            |
| `rollback.helper`          | Returns production to the release before this one.                                                                                                                   |
| `rollback.unavailable`     | There is no earlier release to return to yet.                                                                                                                        |
| `history.heading`          | Release history                                                                                                                                                      |
| `history.more`             | Show more releases                                                                                                                                                   |
| `failedNewer`              | The newest release failed, so nothing that is serving changed. {commit} is still live.                                                                               |
| `reason.build`             | The build failed before deploying.                                                                                                                                   |
| `reason.migration`         | The migration failed: {detail}                                                                                                                                       |
| `reason.deploy`            | The deploy failed before taking traffic.                                                                                                                             |
| `dialog.title`             | Roll back {repository}?                                                                                                                                              |
| `dialog.leaving`           | Leaving                                                                                                                                                              |
| `dialog.returning`         | Returning to                                                                                                                                                         |
| `dialog.body`              | Production goes back to that release’s code and environment values at {address}. The database schema is not reverted: migrations the newer release ran stay applied. |
| `dialog.bodyNoAddress`     | Production goes back to that release’s code and environment values. The database schema is not reverted: migrations the newer release ran stay applied.              |
| `dialog.confirm`           | Roll back                                                                                                                                                            |
| `dialog.submitting`        | Rolling back…                                                                                                                                                        |
| `dialog.cancel`            | Cancel                                                                                                                                                               |
| `dialog.error`             | The rollback didn’t complete. {commit} is still serving production. Try again.                                                                                       |
| `dialog.retry`             | Try again                                                                                                                                                            |
| `readOnly.note`            | You can see every release. Only project administrators can roll back.                                                                                                |
| `empty.title`              | Nothing in production yet                                                                                                                                            |
| `empty.body`               | Merge a pull request into main and Motir builds it and puts it live here, with its address.                                                                          |
| `loading`                  | Loading releases…                                                                                                                                                    |
| `loadError.title`          | Couldn’t load the releases                                                                                                                                           |
| `loadError.body`           | Production is not affected. Try again in a moment.                                                                                                                   |
| `retry`                    | Try again                                                                                                                                                            |
| `notFound.title`           | Repository not found                                                                                                                                                 |
| `notFound.body`            | Motir runs production only for the repositories it hosts. Choose one of this project’s repositories.                                                                 |
| `notFound.back`            | Back to Production                                                                                                                                                   |

Where the copy comes from: the schema sentence restates the story's rule (rollback reverts code, not
the schema); the dialog's Leaving / Returning to pair follows Vercel's _Instant Rollback_ and Render's
_Rollback_ confirmations, which both name the deployment being restored; the state words follow GitHub's
own environment page (`Active` / `Inactive` / `Failure`), re-worded for a person; everything else is new.

## Tokens and parts, element by element

| Element                         | Part / markup                                               | Colour (`--el-*`)                                                                                        | Shape                                                                                  |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Rail row                        | product-local (the settings rail row)                       | text `--el-text-secondary`; active `--el-surface` fill + `--el-text`                                     | `--radius-control`, `px-(--spacing-control-x-8)`, `py-(--spacing-control-y-4)`         |
| Page title / lede               | shipped settings header markup                              | `--el-text` / `--el-text-secondary`                                                                      | —                                                                                      |
| Repository picker               | the shipped `Combobox` in code (trigger + listbox here)     | border `--el-border`, fill `--el-page-bg`, selected option `--el-surface`                                | `--radius-input`, `h-(--height-control-40)`; list `--radius-card`, `--shadow-elevated` |
| Panel header                    | `h2` + lucide `FolderGit2`                                  | `--el-text`; glyph `--el-text-secondary`                                                                 | —                                                                                      |
| Current release / history       | `Card`                                                      | package                                                                                                  | package                                                                                |
| Eyebrow, times, trigger line    | text                                                        | `--el-text-secondary`                                                                                    | —                                                                                      |
| Commit hash / subject           | `<code>` / text                                             | `--el-text-identifier` / `--el-text`                                                                     | —                                                                                      |
| State pill                      | `Pill` (`status` / `severity` / `tone`, table above)        | package tints + `--el-text-strong`                                                                       | `--radius-badge`, `--spacing-chip-x/y`                                                 |
| Address link                    | `<a target="_blank">` + lucide `ExternalLink`               | `--el-link`                                                                                              | —                                                                                      |
| Copy                            | `Button variant="ghost" size="sm"`                          | package                                                                                                  | package                                                                                |
| No-address note                 | text + lucide `Info` + link                                 | `--el-text-secondary`; link `--el-link`                                                                  | —                                                                                      |
| Roll back                       | `Button variant="secondary" size="sm"` + `RotateCcw`        | package                                                                                                  | package                                                                                |
| Failed reason                   | text + lucide `CircleAlert`                                 | text `--el-text`; glyph `--el-danger-on-surface` (never `--el-danger-text`)                              | —                                                                                      |
| Failed-newer note / member note | `<p role="status">` / `<p role="note">` (Environment's box) | `--el-surface-soft` fill, `--el-border-soft`; ink `--el-text` / `--el-text-secondary`                    | `--radius-card`, `--spacing-card-padding-12/8`                                         |
| Confirmation                    | `Modal` with `role="alertdialog"` in code                   | `--el-page-bg`, `--el-border`, scrim `--el-overlay-scrim`; title `--el-text`, body `--el-text-secondary` | `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`                           |
| Confirmation error              | inline `role="alert"` box                                   | `--el-danger-surface` fill, `--el-danger-surface-text` ink                                               | `--radius-card`, `--spacing-card-padding-12/8`                                         |
| Show more                       | `Button variant="ghost" size="sm"`                          | package                                                                                                  | package                                                                                |
| Loading                         | `Spinner` + skeleton bars                                   | bars `--el-muted`                                                                                        | `--radius-control`                                                                     |
| Empty / error / not found       | `EmptyState` / `ErrorState`                                 | package                                                                                                  | package                                                                                |

Every caption, helper, time and trigger sits in `--el-text-secondary`, which clears AA on the page and on
every surface; `--el-text-muted` and `--el-text-faint` are not used by this surface.

**Parts the package lacks:** none. The rail row and the Combobox trigger are the shipped product-local
markup the Environment room already uses.

## What this design does not draw

Routes, error codes and the data shape; logs, health, usage or credits (the running-an-app story); the
Environment room (it is linked, not redrawn); the deploy-a-ref entry point itself (only its history row);
the address model and the Public address room; any customer-repository surface beyond its absence.
