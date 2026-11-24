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

## Amendment 2026-11-23 — the takeover handover (MOTIR-12125, Story MOTIR-9800)

**Design system.** Re-read for this amendment: `package.json` depends on `@motir/design-system`
(`workspace:*`, installed 0.24.1 per `packages/design-system/package.json`) and `app/globals.css` imports
`@motir/design-system/theme.css` — **both checks hold: Motir Design.** The axes are the ones this area
already draws at (`warm-editorial` · `motir` · `motir`, light), read from `app/layout.tsx`'s applied
`data-style` / `data-palette` / `data-type`. Version 0.24.1 exports `@motir/design-system/mock`, so both
delta mocks are **rendered with `renderMock`** from the package's parts on a full-width board; neither
carries a script, so both render on the design card's sandboxed frame.

**What this amendment draws, and where.** Two delta mocks, each beside the base it amends. This section
is the one spec for both (the result publishes one note file); `design/repository-set/design-notes.md`
§ _Amendment 2026-11-23_ points here.

| Delta mock                                               | Amends                                                                                                                       | Panels |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| `design/repository-set/takeover--aws-handover.mock.html` | the take-it-over flow, `design/repository-set/takeover.mock.html` (MOTIR-1938, done; no published result) — notes §14        | 25     |
| `design/hosting/production--handover.mock.html`          | the Production panel, `design/hosting/production.mock.html` (MOTIR-10024, published 2026-10-29) — this file's sections above | 21     |

Neither base mock is edited. Each is a record of its moment; the shipped code is what these deltas were
drawn against: `app/(authed)/settings/project/repositories/_components/TakeoverRow.tsx` and
`TakeoverModal.tsx` for the room and the Move dialog, and
`app/(authed)/settings/project/production/` for the panel.

### Base elements composed unchanged

- **From the take-it-over flow:** the Repositories room header and lede; the `Hosted by Motir` section
  label; the row shape (`flex gap-3 rounded-(--radius-card) border p-(--spacing-card-padding)` on the
  hosted `--el-success-surface` tint) with its role `Pill`, `Created` state word, repository link and
  the `Move to my GitHub` action; the Move dialog's chrome (`Modal` size `lg`, `SectionLabel` eyebrow,
  serif title, pinned footer with one primary); its `Notice` boxes (`--el-notice-info-bg`, soft
  `--el-surface-soft`). The **target picker, the costs step and the row states of §14.5 are unchanged**
  and still serve serverless and Fly repositories, and any AWS repository after its handover.
- **From the Production panel:** the room title and lede, the panel header with the repository's name,
  the repository picker (not redrawn; it is unchanged), the current release card's eyebrow, commit,
  address and Copy, the member note box, the loading shape and `ErrorState`, and the alert-dialog
  confirmation shape. The `live` state is the shipped panel exactly (panel 1 points at it).

### Elements (by the names the waiting work builds to)

1. **Entry affordance** — `Take over AWS hosting` (`Button secondary sm`, lucide `Cloud`) in the row's
   action strip of every **AWS-target** row, for an **organisation admin** only (takeover panel 1); and
   the take-it-over flow's own start: `Move to my GitHub` on an AWS row of an organisation with no other
   AWS repository opens the shipped Move dialog with an explanation and `Take over AWS hosting` as its one
   primary, instead of the target picker (panel 2). **Absent, not disabled,** for anyone who is not an
   organisation admin, and for serverless and Fly rows; the AWS row then says in its helper line that an
   organisation admin hands the account over (panel 3).
2. **Single-repository refusal** — the Move dialog when the organisation's AWS account holds other
   repositories (`TAKEOVER_SHARED_AWS_ACCOUNT`): the other repositories named with their project, why
   they move together (one AWS account per organisation, it leaves whole), the offer `Take over AWS
hosting`, and a status line **"Nothing has changed."** (panel 4). A non-admin sees `Close` in place of
   the offer.
3. **Handover step** — a two-step `Modal`. Step 1 (panels 5–7): **Owner email** (`Input type=email`),
   **GitHub owner** (`Input`), the list **Handed over together**, and the soft note that AWS's own steps
   are done in AWS. Step 2 (panels 8–10): the restatement, the three consequences (previews deleted and
   deploys stop; apps keep running; irreversible once the account has left), `Start handover`, its busy
   state and its refused state.
4. **Handover checklist** — a durable card at the top of the Repositories room, **`AWS hosting
handover`**, with the account id, the count of repositories, who started it and an overall pill, and
   an ordered list of eight rows (panels 11–21). It lives on the room, not in the dialog, for the reason
   §14.5 gives: it outlives the dialog, survives a reload and must be re-enterable for days.
5. **Upstream addresses list** — **Where your apps answer without Motir**, below the checklist: per
   application its own address with Copy, and per customer domain the address it must point at, with
   Copy; the note that `…motir.site` addresses stop answering when Motir's access is removed (panels
   22–25).
6. **Production panel states** (production delta) — **handing-over notice** (panels 2–5); **Grace panel**
   with `Runs until <date>`, **Download export** and the list of past exports, **Stop now** and the **Stop
   now confirmation**, and the **Grace notice banner** in its three moments (panels 6–15); the
   **Handed-over panel** for AWS and for serverless/Fly (panels 16–21).

### The checklist rows — one shape, five treatments

Rows in this order, matching `TENANT_HANDOVER_STEPS`:

| #   | Row label                             | Step (`TENANT_HANDOVER_STEPS`) | Row body when it needs one                                   |
| --- | ------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| 1   | Previews removed                      | `destroy_previews`             | —                                                            |
| 2   | Deploy role for your CI created       | `create_deploy_role`           | —                                                            |
| 3   | Apps reachable without Motir          | `open_upstream`                | — (the Upstream addresses list sits below the card)          |
| 4   | Account email moved                   | `move_email`                   | **waiting on you:** the one-time code field + `Confirm code` |
| 5   | AWS's own steps                       | `await_standalone`             | **waiting on you:** what to do in AWS + `Check again`        |
| 6   | Motir's access removed                | `remove_access`                | —                                                            |
| 7   | Account left Motir's AWS Organization | `leave_organization`           | —                                                            |
| 8   | Each repository transferred           | `transfer_repositories`        | one line per repository with its own state                   |

| Status (`TENANT_HANDOVER_STEP_STATUSES`) | Word           | Glyph                                   | Row fill               | Word ink                   |
| ---------------------------------------- | -------------- | --------------------------------------- | ---------------------- | -------------------------- |
| `pending`                                | Pending        | lucide `Circle`, `--el-icon-muted`      | `--el-card`            | `--el-text-strong`         |
| `running`                                | Running        | `Spinner sm`                            | `--el-notice-info-bg`  | `--el-text-strong`         |
| `waiting_on_you`                         | Waiting on you | lucide `Hand`, `--el-warning`           | `--el-warning-surface` | `--el-text-strong`         |
| `done`                                   | Done           | lucide `CircleCheckBig`, `--el-success` | `--el-card`            | `--el-text-strong`         |
| `failed`                                 | Failed         | lucide `TriangleAlert`, `--el-danger`   | `--el-danger-surface`  | `--el-danger-surface-text` |

Every state pairs a glyph with a word (no state rests on colour). The row running or waiting carries
`aria-current="step"`. A **failed** row shows the step's `lastError` in words and **Retry**
(`Button secondary sm`, `RefreshCw`), which resumes **at that step**; done rows stay done (panel 18).
Panel 21 draws the one row in all five treatments side by side, so it renders from one component.

**The two rows that wait on the new owner.** _Account email moved_ takes the one-time code AWS mails to
the new address: one `Input` (`inputmode=numeric`, `autocomplete=one-time-code`) and `Confirm code`,
nothing else; a refused code (`HANDOVER_EMAIL_CODE_REFUSED`) is the field's error, the row still waiting
(panels 14–15). _AWS's own steps_ lists what the owner does in AWS (root sign-in and password, payment
method, contact details, customer agreement), links AWS's sign-in page in a new tab, and offers **Check
again**; still not ready shows the step's `missing` list in plain words (panels 16–17).

### No payment detail, no root credential — anywhere

**No element on any panel of either mock accepts a payment detail or a root credential.** The only
inputs are Owner email, GitHub owner and the one-time code. The handover step's note and the AWS's-own-
steps row both say, in words, that those things are done in AWS and that Motir never asks for them. The
one-time code is passed to AWS and never stored (`lib/dto/tenantAccountHandover.ts`); the copy says so
under the field.

### The permission rule

- **Take over AWS hosting, the handover step, the checklist's answers (code, Check again, Retry):**
  organisation **owner and admin** only — the route's `TENANT_HANDOVER_ADMIN_ONLY` stays the authority;
  hiding is presentation (hide-or-disable rule, `design/projects/design-notes.md` § Amendment 2026-08-08).
- **Download export, the past exports' Download links, Stop now, the final export's Download:**
  organisation admins only. A project member who is not one sees the window, the date, the list
  read-only and a member note saying who can act — **no** Download, **no** Stop now (production panels
  10, 18).
- **No deploy, redeploy, rollback or deploy-a-ref control** appears in the handing-over, grace or
  handed-over state, for anyone: the current release card loses Roll back, and the Grace and
  Handed-over panels carry none. The shipped refusal of every deploy of a taken-over repository
  (MOTIR-12127) remains the authority.

### Production panel — the three handover states

| Application state (`HostedApplicationState`) | What the panel shows                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`                                       | the shipped panel, unchanged (production delta panel 1 → `production.mock.html` panels 3–19)                                                                                                      |
| `handing_over`                               | the **handing-over notice** (info, `role=status`) above the current release card without Roll back; an admin's notice links to the handover in Repositories                                       |
| `grace`                                      | the **Grace notice banner** (newest recorded notice), then the **Grace panel**: `Runs until` with the date and time, `Grace window` pill, Database exports, Stop it early                         |
| `handed_over`                                | the **Handed-over panel**: AWS → account id + upstream address, each with Copy; serverless/Fly → `Stopped` with the date, the final export kept 30 days, Download for admins, or the expired line |

**The Grace notice banner, three moments:** `transferred` — info (`--el-notice-info-bg`, `Info`);
`seven_days` — warning (`--el-warning-surface`, `Clock`); `one_day` — warning (`TriangleAlert`). The
`stopped` notice is not a banner: the Handed-over panel is the stop's own record.

### Every drawn state and the data it shows

| Mock · panels          | State                                                                                                                                                    | Data, from the work that defines it                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| takeover 1–3           | Entry affordance (admin, flow start, absent for non-admin; absent on serverless/Fly)                                                                     | the row's hosting target (MOTIR-9791 vocabulary) and the viewer's organisation role                                                                         |
| takeover 4             | Single-repository refusal                                                                                                                                | `SharedTenantAccountError.repositories` — MOTIR-12131                                                                                                       |
| takeover 5–7           | Handover step: empty, invalid email, GitHub owner not found                                                                                              | `TenantHandoverInputError` field `ownerEmail` / `githubOwner` — MOTIR-12131; the repositories of the tenant account — MOTIR-12131                           |
| takeover 8–10          | confirmation, submitting, start refused                                                                                                                  | `TENANT_ACCOUNT_NOT_READY`, `TENANT_HANDOVER_ALREADY_STARTED` — MOTIR-12131                                                                                 |
| takeover 11–21         | checklist: loading, all pending, running, waiting (code, wrong code, AWS steps, still not ready), failed + Retry, transferring, all done, five-state row | `TenantAccountHandoverDto.steps[]` (`step`, `status`, `lastError`, `missing`) and `awsAccountId` — MOTIR-12131; step and status values — MOTIR-12126        |
| takeover 22–25         | Upstream addresses: loading, no customer domains, customer domains, error                                                                                | `TenantAccountHandoverDto.applications[]` (`upstreamAddress`, `customerDomains[].host/upstreamAddress`) — MOTIR-12131, MOTIR-12129                          |
| production 2–5         | handing over: admin, member, loading, error                                                                                                              | `HostedApplication.state = handing_over` — MOTIR-12126                                                                                                      |
| production 6–10, 14–15 | grace: three banner moments, exports none / some / in progress / failed, non-admin, loading, error                                                       | `state = grace`, `stopsAt` — MOTIR-12126, MOTIR-12132; `latestGraceNotice` — MOTIR-12136; `HostedApplicationExportDto[]` and the export route — MOTIR-12134 |
| production 11–13       | Stop now confirmation, stopping, stop failed                                                                                                             | `stopApplication`, `APPLICATION_STOP_FAILED` with its step — MOTIR-12135                                                                                    |
| production 16          | handed over, AWS                                                                                                                                         | `awsAccountId`, the application's `upstreamAddress` — MOTIR-12131                                                                                           |
| production 17–19       | handed over, serverless/Fly: admin, member, final export expired                                                                                         | `handedOverAt` — MOTIR-12135; the `final` export and its `expiresAt` — MOTIR-12134                                                                          |
| production 20–21       | handed over: loading, error                                                                                                                              | —                                                                                                                                                           |

### Tokens and parts added by this amendment

| Element                          | Part                                                                                                   | Colour (`--el-*`)                                                                                                                               | Shape                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Take over AWS hosting            | `Button secondary sm` + `Cloud`                                                                        | package                                                                                                                                         | package                                                 |
| Handover dialogs                 | `Modal` (`lg`; the confirmation an `alertdialog`)                                                      | `--el-page-bg`, `--el-border`                                                                                                                   | `--radius-modal`, `--shadow-modal`                      |
| Fields                           | `Input` with label, helper and error                                                                   | package                                                                                                                                         | `--radius-input`, `--height-input`                      |
| Handed over together list        | list in a bordered box                                                                                 | `--el-card`, `--el-border`, rows `--el-border-soft`                                                                                             | `--radius-card`, `--spacing-control-x/y`                |
| Handover card                    | `Card`-shaped section + `SectionLabel` + `Pill`                                                        | `--el-card`, `--el-border`                                                                                                                      | `--radius-card`, `--spacing-card-padding`               |
| Checklist row                    | `<li>` (table above)                                                                                   | table above; detail `--el-text-secondary`                                                                                                       | `--spacing-card-padding-12`                             |
| Code field / Check again / Retry | `Input` / `Button secondary sm`                                                                        | package                                                                                                                                         | package                                                 |
| Addresses                        | `<code>` + Copy (`Button`-shaped, `sm`)                                                                | `--el-text-identifier`; Copy border `--el-button-border`                                                                                        | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm` |
| Notices and banners              | `Notice` (the shipped takeover recipe)                                                                 | info `--el-notice-info-bg`; warning `--el-warning-surface`; soft `--el-surface-soft`; danger `--el-danger-surface` + `--el-danger-surface-text` | `--radius-card`, `--spacing-card-padding`               |
| Grace / handed-over pills        | `Pill severity="warning"` / `tone="neutral"`                                                           | package tints + `--el-text-strong`                                                                                                              | `--radius-badge`                                        |
| Stop now                         | `Button secondary sm` + `OctagonX`, ink `--el-danger-on-surface`; the dialog's primary `Button danger` | `--el-danger-on-surface`; `--el-danger` / `--el-danger-text` only on the danger fill                                                            | package                                                 |
| Exports rows                     | list rows + `Download` link                                                                            | `--el-link`; meta `--el-text-secondary`                                                                                                         | `--spacing-control-x-12`, `--spacing-control-y-8`       |

Captions and helpers are `--el-text-secondary` throughout; `--el-text-muted` and `--el-text-faint` are
not used. **Parts the package lacks:** none — the checklist row and the handover card are product-local
compositions of `Card`, `Pill`, `Spinner`, `Input` and `Button`.

### Copy (English; the build card adds the keys and their translations)

Entry `Take over AWS hosting`. Refusal title `<repo> moves with <n> other repositories`, status
`Nothing has changed. <repo> is still hosted by Motir, and so are the others.` Step titles `Hand
<org>'s AWS account over` / `Start the handover?`; fields `Owner email` (helper `The address that will
own the AWS account. AWS emails a one-time code here.`) and `GitHub owner` (helper `The GitHub account or
organisation that receives the repositories.`); errors `Enter an email address, like name@acme.com.`,
`No GitHub account or organisation is called <login>.` Checklist words `Pending · Running · Waiting on
you · Done · Failed`; `Code from AWS`, `Confirm code`, `AWS didn't accept that code.`; `Check again`,
`Not ready yet — AWS still needs:`; `Retry`. Addresses heading `Where your apps answer without Motir`.
Production: `This app is being handed over`; `Runs until`; `Grace window`; `Database exports`;
`Download export` / `Exporting…`; `No exports yet.`; `Stop it early`; `Stop now`; `Stop <repo> now?`;
`Stopping…`; `Handed over`; `Stopped`; `Final database export`. Banner lines as drawn in panels 6–8,
matching the `hosting.graceNotice.*` keys MOTIR-12136 shipped.

### What this amendment does not draw

The serverless and Fly takeover before the transfer (the shipped take-it-over flow, unchanged); emails
(MOTIR-12136 ships them); routes, services and jobs; the customer's own DNS; the story's browser test and
acceptance video.

---

## Amendment 2026-11-23 — live app operations: Health, Crash events, Logs, When idle, Usage and the crash notification (MOTIR-12101 · Story MOTIR-9799)

**Delta mock:** `production--live-app-ops.mock.html` (25 panels, revised twice on 2026-11-23: the full-width layout and the collapsed long log lines below). It **amends** § _Elements (named once
each)_ and § _Panels and states_ above, and the mock `production.mock.html`, which stays as drawn. Every
element MOTIR-10024 drew (the current release card, the release history, Roll back and its confirmation,
the read-only note, the empty state, the not-found state) is composed unchanged from the shipped
components (`CurrentReleaseCard`, `ReleaseHistoryList`, `RollbackDialog`, `ProductionEmptyState`,
`ProductionHeader`, `ProductionRepositoryPicker`), rendered with `renderMock` against `messages/en.json`.

**Design system.** Unchanged from the head of this file: `package.json` depends on
`@motir/design-system` (`workspace:*`, 0.19.x) and `app/globals.css` imports
`@motir/design-system/theme.css` — **on Motir Design**. Axes `warm-editorial` · `motir` · `motir`, light,
full-width board. Parts used: `Card`, `Pill`, `Button`, `Segmented`, `Input`, `Spinner`, `Switch` (via the
shipped preferences card), `EmptyState` (via the shipped empty state).

**Access path.** Nothing new: the five sections live **inside the existing Production panel** of each
Motir repository, reached through the project settings rail's **Production** row and the repository
picker (panels 1–2 of the base mock). The crash notification's row opens
`/settings/project/production?repository=<rowId>&event=<eventId>`, which selects that repository and
scrolls its **Crash events** list to the event.

### Order in the panel

Current release (shipped) → **Health** → **Crash events** → **Logs** → **When idle** → **Usage** →
Release history (shipped). Each new section is its own `Card` with a serif `text-lg` heading, the
Release history's heading grammar.

### Width — the panel uses the whole content area (revision, Mo 2026-11-23)

Mo's review: _"the design should utilize the width of the screen, logs can be long, don't just use the
center of the screen."_ So this delta **changes the Production page's column**, which the base mock and
`app/(authed)/settings/project/production/page.tsx` draw as `mx-auto max-w-[46rem]`:

- **The page is full width**: `flex w-full flex-col gap-6`, the header, the repository picker and the
  repository heading left-aligned at the top. No `max-w` on the page or on any section below.
- **Paired summary cards** share a row from the `lg` breakpoint: `grid gap-6 lg:grid-cols-2` holds
  **Current release | Health**, and **When idle | Usage**. Below `lg` they stack in the order above.
- **Crash events, Logs and Release history span the full width**, each alone on its row.
- **The Logs view has no scroll bar** (second revision, Mo 2026-11-23: _"don't use scroll bar for the
  logs, long logs can be collapsed by default and click an arrow button to show the full log"_). The
  lines sit in a plain full-width list (`--radius-card`, `--el-surface-soft`, `--el-border-soft`,
  `aria-label="Log lines"`), with no `max-h`, no `overflow-auto` and no sideways scroll. How far back
  it reaches is the time range plus **Show earlier lines**, as before.
- **A long line is collapsed by default.** A line whose message is over 120 characters (a mask token
  counts as 3) shows on one line, cut with an ellipsis (`truncate` in a `minmax(0,1fr)` column). An
  **arrow button** at the start of the row opens it: `ChevronRight` collapsed, `ChevronDown` open, a
  `size-5` icon button (`--radius-control`, ink `--el-text-secondary`, hover `--el-muted` with ink
  `--el-text`), `aria-expanded`, labelled _Show the full line_ / _Collapse this line_ (also its
  tooltip). Opened, the full message wraps in place (`break-words whitespace-pre-wrap`) and the other
  rows stay as they are (panel 10a). A short line has no arrow; its arrow column stays empty so the
  time column lines up. Each line opens on its own, and the open state is not kept across reloads.
- A crash event's last lines use the same rows, so a long stack-trace line there is collapsed with
  the same arrow (panel 3).
- The "Wrap long lines" switch from the first revision is **removed**: the arrow replaces it.
- The Roll back confirmation is the shipped `RollbackDialog`, unchanged; it is drawn in
  `production.mock.html` (panels 8–10), so this delta no longer repeats it.

New copy: `logs.line.expand` — _Show the full line_; `logs.line.collapse` — _Collapse this line_.

### Elements (named once each — the code cards build them by these names)

| Element                               | What it is                                                                                                                                                                                                                   | Built by    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Health state**                      | One state per application: `healthy`, `unhealthy`, `suspended`, `crashed`, `deploying`, a one-line explanation, and how long it has held (relative, absolute on hover); the **health probe unreachable** qualifier under it. | MOTIR-12109 |
| **Crash events**                      | The application's events, newest first: reason in plain words, time, release, the last log lines (collapsed by default), and **Roll back** for an administrator.                                                             | MOTIR-12109 |
| **Logs view**                         | Recent lines, newest first (time · stream · message, monospace), a time-range control, a text filter, the mask token, Show earlier lines, and its non-happy states.                                                          | MOTIR-12109 |
| **Idle policy control** ("When idle") | Suspend when idle / Always on, editable by an administrator; switching, refused and read-only states.                                                                                                                        | MOTIR-12110 |
| **Usage** ("Usage this period")       | This period's compute and database usage per unit, the credits for each, the credits charged, and **credits exhausted**.                                                                                                     | MOTIR-12110 |
| **Crash notification**                | The drawer row (summary + excerpt) and its row in Account › Notifications.                                                                                                                                                   | MOTIR-12113 |

### Health state — tone per state

| State       | Word      | `Pill`                                                                                       | Glyph (lucide)  | Line                                  |
| ----------- | --------- | -------------------------------------------------------------------------------------------- | --------------- | ------------------------------------- |
| `healthy`   | Healthy   | `severity="success"` (mint)                                                                  | `Activity`      | `health.line.healthy`                 |
| `unhealthy` | Unhealthy | `severity="warning"` (peach)                                                                 | `AlertTriangle` | `health.line.unhealthy`               |
| `crashed`   | Crashed   | `severity="danger"` (rose)                                                                   | `ServerCrash`   | `health.line.crashed` / `.crashedOom` |
| `deploying` | Deploying | `status="in-progress"` — the release **Building** pill's tone, same meaning                  | `Spinner`       | `health.line.deploying`               |
| `suspended` | Suspended | `tone="neutral"` — asleep is inactive, not a judgement (the `archived`/`replaced` reasoning) | `Moon`          | `health.line.suspended`               |

Five distinct tones; ink `--el-text-strong` on every tint (the Pill recipe). **Probe unreachable is never
a sixth state**: the last known pill stays and a `WifiOff` note box (the shipped failed-newer note's
recipe: `--el-surface-soft`, `--el-border-soft`, `--radius-card`, `--spacing-card-padding-12/8`, ink
`--el-text`, glyph `--el-text-secondary`) names the address and since when.

### Permission split

- **Roll back** (on a crash event) and the **When idle** control are for the project's administration
  permission (`project:administer`) only. For any other member they are **absent, not disabled**: no
  button on an event, and When idle reads as text with "Only project administrators can change this."
- **Every other element** — Health, Crash events (with their lines), Logs, Usage — is visible to every
  member who can browse the project. The read-only note widens to say so (panel 22).
- **Roll back from an event reuses the shipped confirmation** (`RollbackDialog`, base panel 8) unchanged
  (panel 4): it returns production to the release before the current one, exactly as the card's own
  Roll back does. There is no second rollback flow and no "roll back to this event's release".
- **Top up credits** is shown to an administrator; a member reads "An organisation owner or admin can top
  up credits." The button links to the organisation's billing page.
- Log lines and event lines are shown **as the server returns them, already masked** (MOTIR-12105). The
  page never unmasks or re-masks.

### Usage — units and credits-exhausted, from the approved decision (MOTIR-12100, page v1)

The units and the out-of-credits behaviour are drawn from the decision page, quoted:

- Rate: _"`credits = quantity × (Motir list-price USD per unit ÷ $0.006)`. That is 1 credit per
  Linux-equivalent minute."_ → the footnote "1 credit is one Linux-equivalent minute."
- Units: _"Fly: `runningSeconds` at the release's size … Serverless … Lambda `runningSeconds` at 1769 MB
  and `invocations`. AWS function: Lambda GB-seconds. AWS container: `vcpuSeconds` and `gbSeconds` …
  Database port: `computeSeconds` and `storageBytes`."_ and _"Compute on the database is `computeSeconds ÷
3600` CU-hours on Neon and ACU-hours on Aurora."_, _"Storage is GB-hours."_ → one row per unit, shown
  in the human unit: machine **hours** at its size (Fly), **GB-seconds** and **requests** (Lambda),
  **vCPU-hours** and **GB-hours** (AWS container), **CU-hours** / **ACU-hours** and **GB-hours** (database).
- Charge: _"After a UTC day ends, that day's slices are summed per application and debited once, as
  `ceil(Σ Linux-equivalent minutes)` whole credits."_ → "Each day's usage is charged once, after midnight
  UTC, rounded up to a whole credit, so today's is not in the total yet." The total is the sum of the
  daily debits, so it can exceed the rows' sum by under one credit a day.
- Period: the current calendar month in UTC, to the last charged day ("1–22 Nov 2026").
- Out of credits: _"The project's Usage section shows the state `credits_exhausted` with the balance."_
  and _"Motir never stops or deletes a production app for being out of credits."_ → panel 20's peach box
  (`--el-tint-peach`, ink `--el-text-strong`, `--el-border`), "Out of credits · balance −312 credits".
- _"After 7 days still below zero, an `always_on` application is switched to `suspend` through the
  idle-policy path."_ → "If the balance is still below zero on 30 Nov, Motir switches it to Suspend when
  idle". The date is the day the balance went below zero plus 7.
- _"`always_on` is refused while the balance is below zero. A top-up that brings the balance to zero or
  above lifts the refusal. It does not switch an application back by itself."_ → panel 18: Always on
  disabled in the segmented control, with "Top up credits, then set it again."
- _"An application whose target cannot suspend is not switched … The panel shows `credits_exhausted`
  and says that this application cannot be suspended, so it keeps accruing until the balance is topped
  up."_ → panel 21.
- **Motir's own cost per unit** (_"recorded on every slice beside its credits"_) is **never shown**: only
  quantities and credits.

### Panels and states

| #   | State                                                                                                                               | Elements                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 0   | Healthy — populated default, administrator                                                                                          | all five, plus the shipped card and history |
| 1   | Unhealthy, a health-check-failed event on top                                                                                       | Health, Crash events                        |
| 2   | Suspended, logs show the last lines before sleep, next request wakes it                                                             | Health, Logs                                |
| 3   | Crashed (out of memory), last lines expanded, Roll back                                                                             | Health, Crash events                        |
| 5   | Deploying beside the shipped Building row                                                                                           | Health, history                             |
| 6   | Health probe unreachable                                                                                                            | Health                                      |
| 7   | Crash recovered after Roll back; event kept as history, no Roll back on it                                                          | card, Health, Crash events, history         |
| 8   | Logs filtered                                                                                                                       | Logs                                        |
| 9   | Logs filtered, no match                                                                                                             | Logs                                        |
| 10  | Logs with a masked secret                                                                                                           | Logs                                        |
| 10a | A long line opened by its arrow (the others stay collapsed)                                                                         | Logs                                        |
| 11  | Logs unavailable from the target                                                                                                    | Logs                                        |
| 12  | Logs loading                                                                                                                        | Logs                                        |
| 13  | No release yet: shipped empty state; When idle editable; Logs and Usage say they start with the first release; no Health, no events | empty state, When idle, Logs, Usage         |
| 14  | When idle — Always on, editable                                                                                                     | When idle                                   |
| 15  | When idle — switching                                                                                                               | When idle                                   |
| 16  | When idle — refused (AWS container)                                                                                                 | When idle                                   |
| 17  | When idle — read-only                                                                                                               | When idle                                   |
| 18  | When idle — Always on refused below zero                                                                                            | When idle                                   |
| 19  | Usage                                                                                                                               | Usage                                       |
| 20  | Credits exhausted (can suspend)                                                                                                     | Health, When idle, Usage                    |
| 21  | Credits exhausted (AWS container, cannot suspend)                                                                                   | Usage                                       |
| 22  | Read-only member view                                                                                                               | all, no Roll back, When idle read-only      |
| 23  | Crash notification in the drawer (unread crash, unread failed check, read)                                                          | NotificationRow                             |
| 24  | Its row in Account › Notifications                                                                                                  | NotificationPreferencesCard                 |

### Copy — final English, keyed by purpose (under `settings.production` unless noted)

| Key                                                                              | English                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health.heading`                                                                 | Health                                                                                                                                                                                                                       |
| `health.state.healthy` · `.unhealthy` · `.suspended` · `.crashed` · `.deploying` | Healthy · Unhealthy · Suspended · Crashed · Deploying                                                                                                                                                                        |
| `health.since`                                                                   | {state} for {duration} (title: the absolute date and time)                                                                                                                                                                   |
| `health.line.healthy`                                                            | Answering its health check at {path}.                                                                                                                                                                                        |
| `health.line.unhealthy`                                                          | Its health check at {path} has failed twice in a row.                                                                                                                                                                        |
| `health.line.suspended`                                                          | Asleep because nothing has asked for it. The next request wakes it.                                                                                                                                                          |
| `health.line.crashed`                                                            | The process stopped. {target} is restarting it.                                                                                                                                                                              |
| `health.line.crashedOom`                                                         | The process was stopped: it ran out of memory. {target} is restarting it.                                                                                                                                                    |
| `health.line.deploying`                                                          | Release {commit} is rolling out. The current release keeps serving until it is live.                                                                                                                                         |
| `health.unreachable`                                                             | Motir can’t reach {address} to check it, since {time}. This is the last state Motir saw; the app itself may be fine.                                                                                                         |
| `events.heading`                                                                 | Crash events                                                                                                                                                                                                                 |
| `events.empty`                                                                   | No crashes recorded for this app.                                                                                                                                                                                            |
| `events.reason.exit`                                                             | Exited with code {code}                                                                                                                                                                                                      |
| `events.reason.exited`                                                           | Exited                                                                                                                                                                                                                       |
| `events.reason.oom`                                                              | Out of memory                                                                                                                                                                                                                |
| `events.reason.http`                                                             | Health check failed: HTTP {status}                                                                                                                                                                                           |
| `events.reason.timeout`                                                          | Health check failed: timed out                                                                                                                                                                                               |
| `events.release`                                                                 | Release {commit}                                                                                                                                                                                                             |
| `events.rolledBackSince`                                                         | Rolled back since                                                                                                                                                                                                            |
| `events.showLines`                                                               | Show the last {count} lines before it                                                                                                                                                                                        |
| `events.hideLines`                                                               | Hide the last lines                                                                                                                                                                                                          |
| `events.rollback`                                                                | Roll back (the shipped `rollback.action`)                                                                                                                                                                                    |
| `logs.heading` · `logs.order`                                                    | Logs · Newest first                                                                                                                                                                                                          |
| `logs.range.label` · `.15m` · `.1h` · `.24h` · `.7d`                             | Time range · 15 min · 1 hour · 24 hours · 7 days                                                                                                                                                                             |
| `logs.filter`                                                                    | Filter lines                                                                                                                                                                                                                 |
| `logs.stream.app` · `.platform`                                                  | app · platform                                                                                                                                                                                                               |
| `logs.more`                                                                      | Show earlier lines                                                                                                                                                                                                           |
| `logs.masked`                                                                    | Every secret value from this app’s Environment is shown as \*\*\*.                                                                                                                                                           |
| `logs.asleep`                                                                    | The last lines before the app went to sleep.                                                                                                                                                                                 |
| `logs.noMatch`                                                                   | No lines match “{filter}” in the last {range}.                                                                                                                                                                               |
| `logs.unavailable`                                                               | {target} didn’t return this app’s logs. That is {target}’s log service, not the app: it may still be running fine. No older lines are shown as current.                                                                      |
| `logs.retry`                                                                     | Try again                                                                                                                                                                                                                    |
| `logs.loading`                                                                   | Loading lines…                                                                                                                                                                                                               |
| `logs.noRelease`                                                                 | Logs appear here once the first release is live.                                                                                                                                                                             |
| `idle.heading`                                                                   | When idle                                                                                                                                                                                                                    |
| `idle.option.suspend` · `.alwaysOn`                                              | Suspend when idle · Always on                                                                                                                                                                                                |
| `idle.help.suspend`                                                              | The app sleeps when nothing asks for it, and wakes on the next request. The first request after a sleep is slower.                                                                                                           |
| `idle.help.alwaysOn`                                                             | The app keeps running all the time, so no request ever waits for it to wake. It uses credits every hour.                                                                                                                     |
| `idle.default`                                                                   | New apps start with Suspend when idle. It applies to the first release.                                                                                                                                                      |
| `idle.switching`                                                                 | Applying to the running release…                                                                                                                                                                                             |
| `idle.switchingNote`                                                             | The same build is redeployed with the new setting. Nothing is rebuilt.                                                                                                                                                       |
| `idle.refusal.unsupported`                                                       | (shipped) On {target}, a {shape} can only stay always on, so it can’t suspend when idle. + This app keeps running all the time.                                                                                              |
| `idle.refusal.credits`                                                           | Always on isn’t available while your organisation’s credit balance is below zero. Top up credits, then set it again.                                                                                                         |
| `idle.readOnly`                                                                  | Only project administrators can change this.                                                                                                                                                                                 |
| `usage.heading`                                                                  | Usage this period                                                                                                                                                                                                            |
| `usage.period`                                                                   | {start}–{end} (dates, UTC)                                                                                                                                                                                                   |
| `usage.col.what` · `.amount` · `.credits`                                        | What it used · Amount · Credits                                                                                                                                                                                              |
| `usage.unit.flyMachine`                                                          | Fly machine · {size}                                                                                                                                                                                                         |
| `usage.unit.lambdaCompute` · `.lambdaRequests`                                   | Function compute (GB-seconds) · Function requests                                                                                                                                                                            |
| `usage.unit.containerCpu` · `.containerMemory`                                   | AWS container · vCPU · AWS container · memory                                                                                                                                                                                |
| `usage.unit.dbCompute` · `.dbStorage`                                            | {provider} database compute · {provider} database storage                                                                                                                                                                    |
| `usage.total`                                                                    | Credits charged this period                                                                                                                                                                                                  |
| `usage.footnote`                                                                 | 1 credit is one Linux-equivalent minute. Each day’s usage is charged once, after midnight UTC, rounded up to a whole credit, so today’s is not in the total yet.                                                             |
| `usage.noRelease`                                                                | Nothing used yet. Usage starts with the first live release.                                                                                                                                                                  |
| `usage.exhausted.title`                                                          | Out of credits · balance {balance}                                                                                                                                                                                           |
| `usage.exhausted.body`                                                           | This app keeps running. If the balance is still below zero on {date}, Motir switches it to Suspend when idle, so it sleeps when nothing asks for it. Motir never stops or deletes a production app for being out of credits. |
| `usage.exhausted.bodyCannotSuspend`                                              | This app runs as an AWS container, which can’t be suspended, so it keeps running always on and keeps using credits until the balance is topped up. Motir never stops or deletes a production app for being out of credits.   |
| `usage.exhausted.topUp`                                                          | Top up credits                                                                                                                                                                                                               |
| `usage.exhausted.member`                                                         | An organisation owner or admin can top up credits.                                                                                                                                                                           |
| `readOnly.note` (amended)                                                        | You can see every release, its health, logs and usage. Only project administrators can roll back or change when it sleeps.                                                                                                   |
| `notifications.summary.productionAppCrashed`                                     | {event, select, health_check_failed {<s>{repository}</s> is failing its health check in production} other {<s>{repository}</s> crashed in production}}                                                                       |
| `notifications.excerpt.productionAppCrashed`                                     | {reason} · {project}                                                                                                                                                                                                         |
| `settings.account.notifications.events.production_app_crashed.label` / `.desc`   | (shipped by MOTIR-12106) A production app crashed / An app Motir hosts for a project you administer crashed or failed its health check.                                                                                      |

### Tokens and parts, element by element

- Section cards: `Card` (its own `--radius-card`, `--spacing-card-padding`, `--shadow-card`); headings
  `font-serif text-lg font-semibold text-(--el-text)`; secondary lines `--el-text-secondary` (never
  `--el-text-muted` on a tinted surface).
- Log list: `--el-surface-soft` box, `--el-border-soft` rules, `--radius-card`; rows
  `px-(--spacing-control-x-12)` `py-(--spacing-control-y-4)` (`-2` in an event's lines); time
  `font-mono text-xs --el-text-secondary`; stream `Pill tone="neutral"` for `app`, `tone="awaiting"`
  (yellow) for `platform` so the target's own lines stand apart; message `font-mono text-xs --el-text`.
- **Mask token** `***`: `--el-tint-yellow` fill, `--el-text-strong` ink, `--radius-control`,
  `px-(--spacing-chip-x-2)`; the same token for every secret, with a title naming it.
- Crash event glyphs: `ServerCrash` in `--el-danger-on-surface` (crash), `AlertTriangle` in
  `--el-text-secondary` (failed check); release hash `--el-text-identifier`.
- Logs unavailable: `AlertTriangle` in `--el-danger-on-surface`, note box as the unreachable qualifier,
  `Button variant="secondary"` Try again; the toolbar is disabled and no lines render.
- When idle: `Segmented` (its own control tokens); refusal note box; switching `Spinner` + `role=status`.
- Usage: a plain table, header `text-[11px] uppercase --el-text-secondary` (the preferences card's
  column grammar), quantities `font-mono text-xs`; credits-exhausted box `--el-tint-peach` +
  `--el-text-strong` + `--el-border`, `Button variant="primary"` Top up credits.
- Notification row: the shipped `NotificationRow` grammar, actorless (glyph promoted into the avatar
  slot), glyph `ServerCrash`, badge **`--el-notif-production-crashed`** — a **new Tier-3 token, proposed
  for `globals.css`, mapped to `--color-destructive`** beside the other `--el-notif-*` hues (the mock
  declares it over `--el-danger`).

### Proposed additions

- **Product-local:** `--el-notif-production-crashed` (above). No new design-system part: every element
  composes `Card`, `Pill`, `Button`, `Segmented`, `Input`, `Spinner`.

### What this amendment does not draw

- **A customer (organization-seeded) repository shows none of these elements**: it has no Production
  room at all (base panel 16, not found; panel 19, no row).
- **No element shows or changes the project's phase.**
- No Motir own-cost figure, no rate table, no per-slice detail, and no log download or live tail.

## Amendment 2026-11-23 — the credits-exhausted notification (MOTIR-12166 · Decision MOTIR-12100 §9)

**Delta mock:** `production--credits-exhausted-notification.mock.html` (2 panels). It **amends** §
_Amendment 2026-11-23 — live app operations_ above, whose panels 23 and 24 of
`production--live-app-ops.mock.html` draw only the crash notification. That mock stays as drawn.

Decision MOTIR-12100 §9 settles that when an organisation's balance goes below zero while a production
app runs, the app keeps running and **administrators are notified once per transition**, and that after
7 days still below zero an always-on app that can suspend is switched to suspend when idle. This
amendment draws that notification. Both panels are the shipped `NotificationRow` and
`NotificationPreferencesCard` rendered with the new event type, against `messages/en.json`.

**Who receives it.** Every **owner and admin of the organisation** (the credits are the organisation's,
not a project's), once per transition below zero: a later pass still below zero, or an app that starts
while the balance is already below zero, writes nothing. A top-up clears the transition, so the next drop
below zero notifies again. A member who is not an owner or admin never receives it, though the
preferences row is listed for everyone, as the crash row is.

**Where it leads.** The row opens `/settings/organization/billing`, where credits are topped up — the
same destination as the Usage section's **Top up credits** button.

### Panels

| #   | Panel                                                                                                   | Composes                    |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | The row in the drawer: unread with one app · unread with five apps (the first three and a count) · read | NotificationRow             |
| 2   | Its row in Account › Notifications, appended last, after the crash row                                  | NotificationPreferencesCard |

### Copy — final English (under `notifications` unless noted)

| Key                                                                                  | English                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `summary.productionCreditsExhausted`                                                 | Your organization's credits are below zero while {count, plural, one {<s>{apps}</s> is} other {<s>{apps}</s> are}} live in production |
| `excerpt.productionCreditsExhausted`                                                 | From {date}, always-on apps suspend when idle                                                                                         |
| `appsMore`                                                                           | {count, plural, one {# more} other {# more}}                                                                                          |
| `settings.account.notifications.events.production_credits_exhausted.label` / `.desc` | Credits ran out while apps are live / Your organization's credit balance went below zero while Motir hosts its apps in production.    |

- `{apps}` is the repository names of the organisation's **running** production apps (a live release,
  on a repository Motir made) **in the workspace whose bell shows the row**, oldest first, joined as a
  list in the reader's language; past three it reads the first three and "{count} more". The bell is a
  per-workspace surface, so every workspace that holds a running app gets its own row.
- `{date}` is the day the 7-day switch falls on (the transition plus 7 days), short month and day in the
  reader's calendar. It comes **first** in the excerpt because the excerpt is one truncated line and the
  date is what the administrator acts on. A payload without the date draws no excerpt at all, never a
  sentence with a hole in it.
- No balance or amount is named: the row says that the credits ran out, the billing page says by how much.

### Tokens and parts

- The shipped `NotificationRow` grammar, **actorless** (the glyph promoted into the avatar slot, no
  initial and no fallback name), glyph `Coins` — the credits themselves.
- Badge **`--el-notif-credits-exhausted`**, a new Tier-3 token in `packages/design-system/theme.css`
  beside the other `--el-notif-*` hues, mapped to **`--color-warning`**: not danger, because the apps keep
  running and nothing is lost yet, but something waits on the administrator — the hue the access-refused
  and review-to-run rows take for the same reason.
- The preferences row is the shipped matrix row: label `--el-text`, description `--el-text-secondary`,
  both channels on by default. Email has no producer yet, as the crash row's has none; the cell is the
  person's standing choice for when one ships.

### What this amendment does not draw

- No notification on the 7-day switch itself: the excerpt names its date, and the Production panel's
  Usage section and **When idle** control show the switched state.
- No email; no change to the drawer's layout, the bell, or any other row.
