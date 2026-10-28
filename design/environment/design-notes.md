# Environment — a Motir repository's values per environment

**Design system.** Read `package.json` (depends on `@motir/design-system`, `workspace:*`, installed
0.18.0 per `packages/design-system/package.json`) and `app/globals.css` (imports
`@motir/design-system/theme.css`): **both checks hold, so this is on Motir Design.** The project's own
axes come from `app/layout.tsx` (`data-style`, `data-palette`, `data-type`, applied per viewer); the
mock is drawn at the defaults the shipped settings mocks use: `warm-editorial` · `motir` · `motir`,
light theme. Version 0.18.0 exports `@motir/design-system/mock`, so the mock **is rendered with
`renderMock`** from the package's parts (`Button`, `Card`, `Input`, `Switch`, `Pill`, `Spinner`,
`EmptyState`, `ErrorState`); Tailwind is compiled over the markup with the package's `theme.css`, so
every colour, radius, padding and height in it is a token the style and palette axes flip.

**Surface.** `environment.mock.html` (20 panels). One area, one surface; there is no earlier design of
it, so this is a full mock, not a delta.

**Drawn against.** The shipped project settings shell: `lib/settings/projectSettingsNav.ts` (the rail
registry and its view/write keys), `app/(authed)/settings/project/layout.tsx` (the area guards), the
Repositories room page (`app/(authed)/settings/project/repositories/page.tsx`: `max-w-[46rem]`
column, serif `text-3xl` title, `text-sm` lede), the shipped tablist in
`app/(authed)/settings/project/workflow/_components/WorkflowEditor.tsx`, and the rule of
`design/projects/design-notes.md` § _Amendment 2026-08-08_ (hide an entry point, disable an in-place
control with its reason, guard the destination).

## Where it lives, and why it is its own room

A project's repositories live in the Repositories room (`/settings/project/repositories`, drawn in
`design/repository-set/`), and that room's rail row is gated on `repository:manage` — HIDDEN from a
member by the 2026-08-08 rule. A section inside it could never be read by a member, and this surface
has a member view. So Environment is **its own project settings room**:

| Registry field   | Value                                                                              |
| ---------------- | ---------------------------------------------------------------------------------- |
| `id`             | `environment`                                                                      |
| `group`          | `general`, directly after `repositories`                                           |
| `href`           | `/settings/project/environment`                                                    |
| `icon`           | lucide `Variable`                                                                  |
| `labelKey`       | `nav.environment` → **Environment**                                                |
| `viewPermission` | `project:browse` — a member who can browse the project sees the row                |
| `permission`     | `repository:manage` — the write key; the room disables its controls without it     |
| hidden when      | the project holds no repository Motir hosts (panel 19): a room with nothing to set |

The selected repository and tab are in the address so a link reopens the same view:
`/settings/project/environment?repository=<rowId>&environment=production|preview|release`. With no
`repository` the first Motir repository of the project's set (in set order) is selected; with no
`environment`, Production.

## Elements (named once each)

- **Environment rail entry** — the `Environment` row in the project settings rail (panels 1, 2).
- **Repository selector** — a labelled single-select trigger listing the project's repositories that
  Motir hosts, by name with their role beneath. **A customer repository is never offered** (panel 1).
- **Environment tabs** — `Production`, `Preview`, and `Release`. Release is drawn **only** when the
  project is live and the selected repository is in a train; otherwise it is absent — not disabled,
  not hidden behind a menu (panel 4).
- **Entry list** — one row per entry: the name (monospace), the value, and the actions. A column head
  (`Name`, `Value`) sits above it.
- **Plain value display** — the value in monospace, readable, with `Edit` and `Delete`.
- **Secret 'set' display** — the name, the **Set** marker (a neutral pill with a lock glyph) and the
  helper `Secret · value hidden`, with `Replace` and `Delete`. **No dots, no masked characters, no
  reveal control**: nothing suggests a value exists to show (precedent: Vercel's _sensitive_
  environment variables and GitHub Actions secrets, both write-only after save).
- **Add-entry row** — `Name` field, `Value` field, `Secret` switch, `Save`, with the helper line
  beneath. With the switch on, the value field is a password input with autocomplete off.
- **Replace flow** — the secret's row swaps to an **empty** password field (`New value`), never
  prefilled, with `Save` and `Cancel` and its helper (panel 15).
- **Delete confirmation** — an alert dialog naming the entry and the environment (panel 16).
- **Reserved-name refusal** — an inline alert under the add row naming the reserved name; the same
  wording in every tab (panels 11–13).
- **Read-only member view** — values readable, secrets as Set, the add row and every Edit, Replace and
  Delete control shown **disabled**, each with the tooltip; a note above the card (panel 17).
- **Recent changes list** — under the card, for the selected repository and tab: who, the action
  (`added` / `replaced` / `deleted`), the entry name, a `Secret` pill when the entry is secret, and
  when. **Never a value** (panels 3, 20).
- **Customer-repository case** — never in the selector; its direct address shows the not-found state
  (panel 18).
- **No-Motir-repository case** — a project holding only customer repositories has no Environment rail
  row (panel 19).

## Panels and states

| #   | State                              | What it shows                                                                                         |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Access path, administrator         | Rail with Environment after Repositories (ringed for the reader), selector open, customer repo absent |
| 2   | Access path, member                | Rail without Details / Repositories / Members; Environment present                                    |
| 3   | Populated                          | Production, two secrets and two plain values, Release tab drawn, recent changes beneath               |
| 4   | Release tab hidden                 | Only Production and Preview                                                                           |
| 5   | Empty                              | Empty state for the tab plus the add row                                                              |
| 6   | Loading                            | Spinner line and three skeleton bars (`aria-busy`)                                                    |
| 7   | Error — list                       | `ErrorState` with `Try again`                                                                         |
| 8   | Error — save / delete              | Inline row alerts, each with `Try again`                                                              |
| 9   | Saving                             | The saving rows' controls disabled with a spinner; Save shows its loading state                       |
| 10  | Add validation                     | Empty name; duplicate in this environment; invalid characters                                         |
| 11  | Reserved — PORT, Production        | Inline refusal naming `PORT`                                                                          |
| 12  | Reserved — DATABASE_URL, Preview   | Inline refusal naming `DATABASE_URL`                                                                  |
| 13  | Reserved — MOTIR\_\*, Release      | Inline refusal naming `MOTIR_TOKEN`                                                                   |
| 14  | Secret just saved                  | Success status line; the row is already Set; the add row is cleared                                   |
| 15  | Replace                            | Empty write-only field with Save and Cancel                                                           |
| 16  | Delete confirmation                | Alert dialog                                                                                          |
| 17  | Read-only member                   | Note, disabled controls, the tooltip drawn open on Replace                                            |
| 18  | Customer repository at its address | Not-found empty state with `Back to Environment`                                                      |
| 19  | No Motir repository                | Rail without the Environment row                                                                      |
| 20  | Recent changes, empty              | The empty sentence                                                                                    |

Behaviour the panels imply: a duplicate name in the same environment is refused before the request
(the server's upsert would otherwise replace silently — the list's `Edit` is the way to change a
value); the reserved-name check runs on the client for the immediate message **and** is the server's
refusal (`reserved_environment_name`), whose copy is the same; after a secret is saved the form never
holds its value again (the field is cleared on success, on failure it keeps it so the person can retry).

## Copy (message keys under `settings.environment`)

| Key                                        | English                                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav.environment`                          | Environment                                                                                                                                                                            |
| `title`                                    | Environment                                                                                                                                                                            |
| `lede`                                     | Values your app reads when it runs. Set them once per environment; Motir passes them to the app on its next deploy.                                                                    |
| `repositoryLabel`                          | Repository                                                                                                                                                                             |
| `tablistLabel`                             | Environment                                                                                                                                                                            |
| `tab.production`                           | Production                                                                                                                                                                             |
| `tab.preview`                              | Preview                                                                                                                                                                                |
| `tab.release`                              | Release                                                                                                                                                                                |
| `column.name`                              | Name                                                                                                                                                                                   |
| `column.value`                             | Value                                                                                                                                                                                  |
| `set`                                      | Set                                                                                                                                                                                    |
| `secretHidden`                             | Secret · value hidden                                                                                                                                                                  |
| `edit` / `replace` / `delete`              | Edit / Replace / Delete                                                                                                                                                                |
| `editAria`                                 | Edit {name}                                                                                                                                                                            |
| `replaceAria`                              | Replace {name}                                                                                                                                                                         |
| `deleteAria`                               | Delete {name}                                                                                                                                                                          |
| `add.heading`                              | Add a value                                                                                                                                                                            |
| `add.namePlaceholder`                      | NAME                                                                                                                                                                                   |
| `add.valuePlaceholder`                     | Value                                                                                                                                                                                  |
| `add.secret`                               | Secret                                                                                                                                                                                 |
| `add.save`                                 | Save                                                                                                                                                                                   |
| `add.helper`                               | A secret can be replaced or deleted, never shown again — not to you, not to anyone.                                                                                                    |
| `error.nameRequired`                       | Enter a name.                                                                                                                                                                          |
| `error.duplicate`                          | {name} is already set in {environment}. Edit it in the list instead.                                                                                                                   |
| `error.invalidName`                        | Use letters, digits and underscores, not starting with a digit.                                                                                                                        |
| `error.reserved`                           | {name} is reserved: PORT, DATABASE*URL and MOTIR*\* names are set by Motir. Choose another name.                                                                                       |
| `saved.secret`                             | {name} saved as a secret. Its value is hidden from now on.                                                                                                                             |
| `saved.plain`                              | {name} saved.                                                                                                                                                                          |
| `replace.placeholder`                      | New value                                                                                                                                                                              |
| `replace.aria`                             | New value for {name}                                                                                                                                                                   |
| `replace.helper`                           | The current value stays hidden. Saving replaces it on the next deploy.                                                                                                                 |
| `replace.cancel`                           | Cancel                                                                                                                                                                                 |
| `delete.title`                             | Delete {name} from {environment}?                                                                                                                                                      |
| `delete.body`                              | The app stops receiving {name} in {environment} on its next deploy. Preview and Release keep their own values. This cannot be undone. — the second sentence names the OTHER drawn tabs |
| `delete.confirm`                           | Delete                                                                                                                                                                                 |
| `delete.cancel`                            | Cancel                                                                                                                                                                                 |
| `empty.title`                              | No values in {environment} yet                                                                                                                                                         |
| `empty.production`                         | Your live app gets these. Add the first one below.                                                                                                                                     |
| `empty.preview`                            | Every pull request’s preview gets these. Add the first one below.                                                                                                                      |
| `empty.release`                            | The release your train builds gets these. Add the first one below.                                                                                                                     |
| `loading`                                  | Loading values…                                                                                                                                                                        |
| `loadError.title`                          | Couldn’t load the values                                                                                                                                                               |
| `loadError.body`                           | Nothing was changed. Try again in a moment.                                                                                                                                            |
| `retry`                                    | Try again                                                                                                                                                                              |
| `saveError`                                | Couldn’t save {name}. Nothing was changed.                                                                                                                                             |
| `deleteError`                              | Couldn’t delete {name}. It is still set.                                                                                                                                               |
| `readOnly.note`                            | You can read these values. Only project administrators can change them.                                                                                                                |
| `readOnly.tooltip`                         | Only project administrators can change environment values.                                                                                                                             |
| `changes.heading`                          | Recent changes · {environment}                                                                                                                                                         |
| `changes.added` / `.replaced` / `.deleted` | added / replaced / deleted                                                                                                                                                             |
| `changes.secret`                           | Secret                                                                                                                                                                                 |
| `changes.empty`                            | No changes yet. Each change to this environment is listed here — who made it and when, never the value.                                                                                |
| `notFound.title`                           | Repository not found                                                                                                                                                                   |
| `notFound.body`                            | Motir keeps no environment for this repository. Choose one of the project’s repositories that Motir hosts.                                                                             |
| `notFound.back`                            | Back to Environment                                                                                                                                                                    |

Where the copy comes from: the reserved-name sentence restates the platform rule (`PORT`,
`DATABASE_URL`, `MOTIR_*`) the server enforces; the read-only tooltip and note follow the 2026-08-08
amendment's "says why" rule; the write-only helper lines follow Vercel's sensitive-variable and GitHub
Actions secret wording (a value is entered, never read back); everything else is new.

## Tokens and parts, element by element

| Element                        | Part / markup                                         | Colour (`--el-*`)                                                                                       | Shape                                                                                  |
| ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Rail row                       | product-local (SidebarNav's settings row)             | text `--el-text-secondary`; active `--el-surface` fill + `--el-text`                                    | `--radius-control`, `px-(--spacing-control-x-8)`, `py-(--spacing-control-y-4)`         |
| Page title / lede              | shipped settings header markup                        | `--el-text` / `--el-text-secondary`                                                                     | —                                                                                      |
| Repository selector            | trigger + listbox (the shipped `Combobox` in code)    | border `--el-border`, fill `--el-page-bg`, selected option `--el-surface`                               | `--radius-input`, `h-(--height-control-40)`; list `--radius-card`, `--shadow-elevated` |
| Section card                   | `Card`                                                | package                                                                                                 | package                                                                                |
| Environment tabs               | product-local (the Workflow editor's tablist)         | selected `--el-text` + `--el-text` underline; others `--el-text-secondary`; rule `--el-border`          | `px-(--spacing-control-x-12)`, `py-(--spacing-control-y-8)`                            |
| Entry name                     | `<code>`                                              | `--el-text-identifier`                                                                                  | —                                                                                      |
| Plain value                    | text                                                  | `--el-text`                                                                                             | —                                                                                      |
| Set marker                     | `Pill tone="neutral"` + lucide `Lock` (`aria-hidden`) | package (`--el-chip-bg`, `--el-text-secondary`)                                                         | `--radius-badge`                                                                       |
| Row actions                    | `Button variant="ghost" size="sm"`                    | package                                                                                                 | package                                                                                |
| Add row                        | `Input`, `Switch`, `Button variant="primary"`         | invalid name: border `--el-danger`                                                                      | package                                                                                |
| Inline refusal / validation    | `<p role="alert">`                                    | `--el-danger-on-surface` (never `--el-danger-text`)                                                     | —                                                                                      |
| Save / delete failure          | inline alert + `Button variant="secondary" size="sm"` | `--el-danger-surface` fill, `--el-danger-surface-text` ink                                              | `--radius-card`, `--spacing-card-padding-12/8`                                         |
| Secret-saved status            | `<p role="status">`                                   | `--el-success-surface` fill, `--el-text-strong` ink                                                     | `--radius-card`, `--spacing-card-padding-12/8`                                         |
| Member note                    | `<p role="note">`                                     | `--el-surface-soft` fill, `--el-text-secondary` ink, `--el-border-soft`                                 | `--radius-card`, `--spacing-card-padding-12/8`                                         |
| Tooltip                        | `Tooltip` in code (drawn open here)                   | `--el-tooltip-bg` / `--el-tooltip-text`                                                                 | `--radius-control`, `--spacing-tooltip-x/y`                                            |
| Delete confirmation            | `Modal` with `role="alertdialog"` in code             | `--el-page-bg`, `--el-border`; title `--el-text`, body `--el-text-secondary`; `Button variant="danger"` | `--radius-modal`, `--shadow-modal`                                                     |
| Loading                        | `Spinner` + skeleton bars                             | bars `--el-muted`                                                                                       | `--radius-control`                                                                     |
| List error / not found / empty | `ErrorState` / `EmptyState`                           | package                                                                                                 | package                                                                                |
| Recent changes                 | ordered list                                          | rows `--el-text`, names `--el-text-identifier`, time `--el-text-secondary`, rule `--el-border-soft`     | `py-(--spacing-control-y-4)`                                                           |

Every caption, helper and time sits in `--el-text-secondary`, which clears AA on the page and on every
surface; `--el-text-muted` and `--el-text-faint` are not used.

**Parts the package lacks.** None proposed for `@motir/design-system`. Product-local: the settings
rail row and the environment tablist (both already shipped in the app), and the entry row (a
composition of `Pill`, `Button` and text).

## Accessibility contract

- **Tabs.** `role="tablist"` labelled `Environment`; each tab is a `button` with `role="tab"`,
  `aria-selected`, roving `tabIndex` (0 on the selected, −1 on the rest); Left/Right move between tabs,
  Home/End jump to the ends, Enter/Space selects; the list beneath is the `tabpanel`
  (`aria-labelledby` the selected tab). When Release is absent it is not in the DOM.
- **Secret switch.** The package `Switch` (`role="switch"`, `aria-checked`), labelled `Secret` by its
  visible label; Space toggles. Turning it on changes the value field's `type` to `password` and sets
  `autocomplete="off"`; the change is not announced separately (the label already says what it is).
- **Inline refusal.** The message is `role="alert"`, linked from the name field by
  `aria-describedby`, with `aria-invalid="true"` on the field; focus stays in the name field. The same
  for the three validation messages.
- **Set marker.** The lock glyph is `aria-hidden`; the accessible text is `Set` plus the visible
  `Secret · value hidden`. There is no value in the DOM, in an attribute or in a hidden element.
- **Replace.** Focus moves to the empty field; Escape is `Cancel` and returns focus to `Replace`.
- **Row actions.** Every icon-less action carries an `aria-label` naming its entry (`Delete API_KEY`).
- **Disabled controls (member).** Rendered `aria-disabled` and focusable so the tooltip is reachable
  by keyboard; the tooltip text is also the note above the card, so nothing depends on hover.
- **Delete confirmation.** `role="alertdialog"`, labelled by its title and described by its body;
  focus starts on `Cancel`; Escape cancels and returns focus to the row's `Delete`.
- **Saving.** The saving row's controls are disabled and the `Spinner` is labelled `Saving`; the
  success line is `role="status"`.
- **Loading.** The list container is `aria-busy="true"` with a polite live region.
