# Starter library — design notes (MOTIR-705)

Story MOTIR-704 (the seed registry). Decision MOTIR-706 v2 fixes the entry shape,
the matching rule and the operator permission; MOTIR-709 ships the matching and
the re-point with its typed refusals; MOTIR-710 ships promote and retire. This
area draws the three surfaces those need. MOTIR-712 builds them.

| Surface                                  | Mock                                 | Section |
| ---------------------------------------- | ------------------------------------ | ------- |
| Repositories room — the seed on each row | `repositories-room--seed.mock.html`  | §1      |
| Operator console — the starter library   | `starter-library.mock.html`          | §2      |
| Operator console — promote and retire    | `starter-library--promote.mock.html` | §3      |

**Where each is reached from.** The room from **Project settings → Repositories**
(`/settings/project/repositories`). The library from the operator console's rail,
**Operations → Starters** (`/admin/starters`); the promote form from the
library's **Promote a repository** button (`/admin/starters/promote`).

**Who.** The room's seed is seen by everyone who can open the room and changed by
whoever can edit the project's repository set (the existing PATCH gate). The
library, promote and retire are **operator and superadmin only**
(`requirePlatformStaff('operator')`, R97 in
`docs/decisions/permission-inventory.md`). For **support** the Starters row is
absent and the route answers 404, exactly as Fleet settings and Audit log do.
Promote and retire are **never automatic**: each is an operator's explicit act
with a reason, written to the platform audit log.

**The plan approval step is not changed.** The card first placed the seed, its
match reason and the re-point on the approval step. Since MOTIR-5014 that step
(`RepositorySetStep`) lists no repositories and asks nothing about them
(`design/repository-set/design-notes.md` §0 and §4). The room already lists every
Motir-created row, including `proposed` ones, in its **Hosted by Motir** section
(`splitRoomSections`), so that is where a row's seed is seen and changed.

## Shared vocabulary

Display names for the closed lists (`lib/hosting/vocabulary.ts`). No new name is
invented; these are the copy for the enum values.

| Value             | Copy            |
| ----------------- | --------------- |
| `serverless`      | Serverless      |
| `fly`             | Fly             |
| `aws`             | AWS             |
| `internal_tool`   | Internal tool   |
| `mvp`             | MVP             |
| `planned_product` | Planned product |
| `small`           | Small           |
| `medium`          | Medium          |
| `large`           | Large           |

A starter's **label** (`seed_registry_entry.label`) is what people see, e.g.
"Next.js · serverless", "Initialised repository". Its **key** appears only in the
operator console, as a monospace identifier.

## Colour and shape roles (all three mocks)

The **refusal alert block** is not a new primitive: it is the shipped row's
failure treatment (`TakeoverRow`'s `role="alert"` line on
`--el-danger-surface-text`) given a tinted box, with the hue in the border and
the glyph.

| Element                                      | Colour (`--el-*`)                                                                                                                            | Shape                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Starter pill                                 | bg `--el-tint-lavender`, ink `--el-text-strong`                                                                                              | `--radius-badge`, `--spacing-chip-x/y`                                         |
| Hosting-target pill                          | bg `--el-tint-sky`, ink `--el-text-strong`                                                                                                   | same                                                                           |
| Default pill                                 | bg `--el-tint-yellow`, ink `--el-text-strong`                                                                                                | same                                                                           |
| Active pill                                  | bg `--el-tint-mint`, ink `--el-text-strong`                                                                                                  | same                                                                           |
| Retired pill                                 | bg `--el-surface`, ink `--el-text-secondary`, border `--el-border`                                                                           | same                                                                           |
| Role / use / size chips, "No hosting target" | `Pill tone="neutral"`: `--el-chip-bg`, `--el-text-secondary`, `--el-chip-border`                                                             | same                                                                           |
| "Why this starter" inset                     | bg `--el-surface-soft`, border `--el-border-soft`; ink `--el-text` / `--el-text-secondary`                                                   | `--radius-card`                                                                |
| Fact glyph, matched / not                    | `--el-success` / `--el-icon-muted`                                                                                                           | 14px icon                                                                      |
| Refusal alert                                | bg `--el-danger-surface`, border `--el-danger`, glyph `--el-danger-on-surface`, copy `--el-danger-surface-text`, emphasis `--el-text-strong` | `--radius-card`                                                                |
| Field error                                  | `--el-danger-on-surface`; the input's border `--el-danger`                                                                                   | `--radius-input`                                                               |
| Required mark `*`                            | `--el-danger-on-surface`                                                                                                                     | —                                                                              |
| Notice / toast                               | toast bg `--el-success-surface`, glyph `--el-success`, ink `--el-text-strong`                                                                | `--radius-card`, `--shadow-elevated`                                           |
| Primary / secondary / ghost / danger button  | `Button` variants; danger is `bg-(--el-danger) text-(--el-danger-text)`, its one legal pairing                                               | `--radius-btn`, `--height-btn-{sm,md}`, `--spacing-btn-x(-sm)`                 |
| Combobox trigger, listbox, option            | `Combobox`: `--el-input-border`, `--el-card`, `--el-option-active-bg`, sub-line `--el-text-secondary`, tick `--el-accent-on-surface`         | `--radius-input`, `--radius-card`, `--radius-control`, `--spacing-control-x/y` |
| Checkbox, on                                 | `--el-accent` fill, `--el-accent-text` tick                                                                                                  | `--radius-control`                                                             |
| Modal                                        | `Modal`: `--el-card`, `--shadow-modal`, scrim `--el-overlay-scrim`                                                                           | `--radius-modal`, `--spacing-card-padding`                                     |

No ink is `--el-text-muted` or `--el-text-faint`: every secondary line sits on a
tint, `--el-surface-soft` or a card, so it is `--el-text-secondary`, which clears
AA on all of them. `--el-danger-text` appears only on the danger button.

## §1 The Repositories room — the seed on each row

Mock: `repositories-room--seed.mock.html`. A DELTA on
`design/repository-set/repositories-room.mock.html`; only the changed panels.

**Composed from:** the shipped `TakeoverRow` (role `Pill`, state word,
`RepoReference`, `Helper`, `Button`), `Pill`, `Combobox`, and the room's shell.

### 1.1 What a Motir-created row gains

After the state word, two pills:

- **Starter pill** — the entry's label with a `Layers` icon.
  `aria-label="Starts from {label}"`.
- **Hosting-target pill** — the row's `hostingTarget`, with a `Cloud` icon.
  `aria-label="Hosted on {target}"`. A web row with no target shows a neutral
  **No hosting target** pill instead. A row of another role with no target shows
  no hosting pill.
- **Default pill** — beside the starter pill when `seedMatch` is
  `no_stack_signal`, `no_target` or `no_match`, so a default is never dressed as
  a match.

An **organisation** row (from your organisation) shows neither pill. Motir never
seeds a repository it did not create.

### 1.2 A row that is not created yet (`proposed`, and `failed`)

These are the states the PATCH re-point accepts (`PLAN_EDITABLE_STATES`).

- **State word:** clock icon + **Not created yet** (new copy
  `repositorySet.stateProposed`). Today's row shows no state word for these rows.
- **Why this starter** inset: one sentence, then the facts.
- **Starter** picker: a labelled `Combobox` showing the current starter's label.

The sentence, per `seedMatch`:

| `seedMatch`                    | Copy                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matched`, all met             | **Why this starter:** it deploys to {target} and is made for {a use} of this size.                                                                                                    |
| `matched`, a soft miss         | **Why this starter:** it is the closest starter that deploys to {target}. No {target} starter is made for {a use}. (or "…of this size")                                               |
| `matched`, no target (not web) | **Why this starter:** it is Motir's starter for a {role} app. Motir hosting doesn't deploy this repository, so no hosting is shown.                                                   |
| `no_stack_signal`              | **Why this starter:** the plan didn't say which stack this repository uses, so it starts from the usual starter for a web repository on {target}. Pick another if you know the stack. |
| `no_target`                    | **Why this starter:** this repository has no hosting target yet, so it starts from the usual starter for a web repository.                                                            |
| `no_match`                     | **Why this starter:** no starter is made for {a role} repository on {target} (or "with this stack"), so it starts as an initialised repository: an empty repository with a README.    |

The facts, each a glyph + label + value: **Hosting**, **Use**, **Size**, and
**Stack** when the plan named one. A met criterion takes a check
(`--el-success`); an unmet soft criterion takes a dash and "· not served"; a
missing value reads **Not set**, **Not named** or **None**. Hosting and role are
hard (never "not served" on a chosen starter); use and size are soft.

### 1.3 The Starter picker

Lists only **active** starters of the row's role that fit the row's hosting
target (`seedRegistryService.listCompatible`, `seedEntryFitsRow`), then
**Initialised repository**, which fits every row.

- Group headings: **Web starters on {target}** (or **Web starters** with no
  target; the role word follows the row), then **Any repository**.
- Each option: the label, and a sub-line of what it serves
  ("Internal tool, MVP · Small"; with no row target the target leads:
  "Fly · MVP, Planned product · Small, Medium, Large"). Initialised's sub-line:
  "An empty repository with a README".
- The current starter is the active option with a tick.
- Footer: "Only starters for a {role} repository that deploy to {target}." or
  "Only starters for a {role} repository. This repository has no hosting target
  yet."
- Picking one sends the PATCH at once (as the row's other edits do).

### 1.4 Refused re-points

The picker offers only fitting starters, so a refusal means the library or the
row changed after the list loaded. The route answers `PROJECT_REPO_SEED_REFUSED`
with a typed `refusal`; the UI renders its own sentence for each (the server's
English message is the fallback), in a refusal alert block (`role="alert"`) under the picker.
The picker keeps the **saved** starter and reloads its list.

| `refusal`          | Copy                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_mismatch`  | **{label} can't be used here.** It deploys to {its targets}, and this repository runs on {target}. The starter is unchanged. (no row target: "…and this repository has no hosting target.") |
| `retired`          | **{label} has been retired.** Motir no longer offers it, so pick another starter. The starter is unchanged.                                                                                 |
| `role_mismatch`    | **{label} can't be used here.** It is a starter for a {role} repository, and this one is {role}. The starter is unchanged.                                                                  |
| `not_editable`     | **This repository has already been created,** so it can no longer start from another starter. Reload to see it.                                                                             |
| `unknown`          | **That starter no longer exists.** Pick another starter. The starter is unchanged.                                                                                                          |
| `organization_row` | Not reachable from the room: an organisation row has no picker.                                                                                                                             |

### 1.5 A created row

Read-only: both pills stay; **Why this starter** and the picker go. The detail
line changes from the hardcoded "Hosted by Motir · seeded from the Motir Next.js
starter." to **"Hosted by Motir · started from {label}."**, or **"Hosted by Motir
· started as an initialised repository."** for `initialised`
(`repositorySet.createdDetail` takes a `{seed}` argument). **Move to my GitHub**
and the rest of the row are unchanged.

## §2 The starter library

Mock: `starter-library.mock.html`. A new console page.

**Composed from:** `AdminShell` (rail + top bar), `Card`, `Button`, `Pill`,
`Combobox` (filter triggers), `Segmented` (the status filter), the console's
table markup (as on the Ideas page), `EmptyState`, and the console pager.

### 2.1 The door

A new rail row **Starters** (`Layers` icon) in **Operations**, directly after
**Ideas**, for operator and superadmin only. Lit on `/admin/starters` and below.
New copy: `admin.shell.navStarters` = "Starters".

### 2.2 The page

- Crumb **Operations · Starters**; title **Starters**; sub: "What a repository
  Motir creates starts from. Matching picks among the active starters by role,
  hosting target, use and size. Promote a repository Motir created into a
  starter, or retire one."
- Primary button **Promote a repository** (`Plus` icon) → `/admin/starters/promote`.
- Card **Starter library**, sub-line "Newest first · {n} starters".

### 2.3 Filters

URL-backed: `?role=&status=&target=&page=`, surviving a reload.

- **Role** — Combobox: Any role, web, api, mobile, shared, infra, other.
- **Status** — segmented: **Active** (default) · Retired · All.
- **Hosting target** — Combobox: Any target, Serverless, Fly, AWS, **Not deployed
  by Motir hosting** (entries with no target).

### 2.4 The table

25 entries to a page, newest first. Columns:

| Column       | Content                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starter      | label (600, `--el-text`), key (mono, `--el-text-identifier`), and "Also answers to {legacy key}" when it has legacy keys                                                          |
| Role · stack | "web · nextjs"; `initialised` reads "any role · any stack"                                                                                                                        |
| Serves       | two chip rows: uses, then sizes (neutral pills). Every value of a list reads **Every use** / **Every size**                                                                       |
| Hosting      | a target pill per target; none reads **Not deployed by Motir hosting** (`--el-text-secondary`)                                                                                    |
| Status       | **Active** (mint) or **Retired** (grey); a role default also carries **Default** (yellow)                                                                                         |
| Provenance   | "Shipped with Motir" (no `promoted_from`), or "Promoted by **{email}** on {date} from {owner/repo} at {ref}"; a retired entry adds "Retired by **{email}** on {date}: “{reason}”" |
| (action)     | **Retire** (secondary, sm, `Archive` icon) on an active non-default entry; a default shows a lock + "Default for web" / "Default for every role"; a retired entry has none        |

A retired row is quieted with `--el-surface-soft`.

### 2.5 States

- **Filtered** — the target filter applied (`?target=fly`), one row.
- **Retired** — the Retired filter, the retired entry with its retire provenance.
- **Empty** — `EmptyState` with the `Layers` glyph: title **No starters match
  these filters**, body "No active starter for a {role} repository deploys to
  {target}. Clear the filters to see the whole library." (generic: "No starter
  matches these filters."), and **Clear filters**.
- **Pager** — "Showing {from}–{to} of {total}", previous / next icon buttons,
  disabled at the ends.

## §3 Promote and retire

Mock: `starter-library--promote.mock.html`.

**Composed from:** `FormField`, `Input`, `Textarea`, `Checkbox`, `Combobox`,
`Button`, `Modal` (`role="alertdialog"`), `Toast`, and the refusal alert block
(below).

### 3.1 The promote form (`/admin/starters/promote`)

Title **Promote a repository**; sub "Motir copies the repository at the ref into
its own organisation and offers the copy as a starter to new repositories that
fit it. Repositories that already exist are not changed."

| Field                         | Control           | Helper                                                                                                                             |
| ----------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Repository Motir created \*   | Combobox (search) | the picked row's "{project} · {role} · {state}"                                                                                    |
| Ref \*                        | Input (mono)      | "A branch, tag or commit. The starter is copied from it."                                                                          |
| Role \*                       | Combobox          | —                                                                                                                                  |
| Stack \*                      | Input (mono)      | "What the planner calls this stack, in lower case."                                                                                |
| Label \*                      | Input             | "What people see on their repository."                                                                                             |
| Key \*                        | Input (mono)      | "Lower-case letters, digits and hyphens. Also the name of the copy in motir-co. It can't be changed later."                        |
| Uses it serves \*             | Checkbox group    | —                                                                                                                                  |
| Sizes it serves \*            | Checkbox group    | —                                                                                                                                  |
| Hosting targets it deploys to | Checkbox group    | "Each one must be listed in the repository's motir.hosting.json at the ref. Tick none for a starter Motir hosting doesn't deploy." |
| Reason \*                     | Textarea          | "Written to the audit log with your name."                                                                                         |

**Nothing is pre-ticked**, even when the source row has a use, size or target:
what a starter serves is the operator's claim. **Review promotion** is disabled
until every required field is filled and at least one use and one size are
ticked. **Cancel** returns to the library.

The repository picker lists only repositories Motir created. A customer's own
repository is never listed. A row not created yet, or being handed to its owner,
is listed disabled with the reason in its sub-line ("not created yet", "being
handed over to its owner"). Footer: "Only repositories Motir created."

### 3.2 The confirm

`Modal role="alertdialog"`: **Promote {repo name} to a starter?** Body: "Motir
copies **{owner/repo}** at **{ref}** into **motir-co/{key}** and adds
**{label}** to the library. From then on matching can choose it for a new {role}
repository it fits. Repositories that already exist are not changed." Then a
definition list of role · stack, uses, sizes, hosting and reason. Buttons
**Back** · **Promote** (primary). Nothing is copied until **Promote**.

### 3.3 Refusals

Every refusal keeps the form filled. Source and manifest refusals are a refusal
alert block at the top of the form; field refusals sit under their field.

| Error (route)                                         | Where                         | Copy                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SeedPromotionSourceRefused` `taken_over`             | alert                         | **This repository can't be promoted.** It is being handed over to its owner, or already has been, so it is no longer Motir's to copy.                                                                           |
| … `not_created`                                       | alert                         | **This repository can't be promoted.** Only a repository Motir created can be, and this one is still {state}.                                                                                                   |
| … `organization_row`                                  | alert                         | **This repository can't be promoted.** It is the organisation's own repository, and Motir never copies a customer's code.                                                                                       |
| … `not_motir_held`                                    | alert                         | **This repository can't be promoted.** {owner/repo} is no longer in a GitHub organisation Motir holds.                                                                                                          |
| … `not_found`                                         | alert                         | **This repository can't be promoted.** It no longer exists. Pick another.                                                                                                                                       |
| `SeedPromotionRefNotFound`                            | under Ref                     | "{ref}" is not a branch, tag or commit of {owner/repo}.                                                                                                                                                         |
| `SeedPromotionManifestRefused` `missing`              | alert                         | **motir.hosting.json refuses this promotion.** The repository has no motir.hosting.json at {ref}, so it can't claim a hosting target. Add the file at that ref, or untick every hosting target.                 |
| … `invalid`                                           | alert                         | **motir.hosting.json refuses this promotion.** The file at {ref} is invalid: **{field}** {reason}. Plus a mono line "motir.hosting.json · {field}".                                                             |
| … `target_not_declared`                               | alert + under Hosting targets | **motir.hosting.json refuses this promotion.** It does not list **{target}** in targets (it lists {declared}). Untick {Target}, or add it to the file. Field: "{Target} is not in motir.hosting.json at {ref}." |
| `SeedRegistryInvalidField` (a value outside its list) | under its field               | "{value}" is not a {size / use / hosting target / role}. Choose from {the list}.                                                                                                                                |
| `SeedRegistryKeyTaken`                                | under Key                     | The key {key} is already taken.                                                                                                                                                                                 |
| `SeedPromotionTemplateNameTaken`                      | under Key                     | motir-co/{key} already exists and is not this starter's copy. Choose another key, or remove that repository first.                                                                                              |

The manifest is read only when at least one hosting target is ticked (MOTIR-710).

### 3.4 Retire

**Retire** on a library row opens `Modal role="alertdialog"`:
**Retire {label}?** Body: "Matching stops choosing it and the Starter picker
stops offering it. Repositories already created from it keep their code. A
repository not created yet that names it can't be created from it until someone
picks another starter." A required **Reason** textarea ("Written to the audit log
with your name."). Buttons **Cancel** · **Retire starter** (danger), disabled
until a reason is typed.

A role's default (`SeedEntryIsDefault`) shows no Retire action on its row. If one
is retired anyway, the confirm shows the alert **This starter can't be retired.**
"“{key}” is the default starter for a {role} repository. Changing a default is a
decision, not an operator action." (for `initialised`: "…for every role…") and a
single **Close**.

### 3.5 Done

Back on the library with a toast (`role="status"`):

- Promote: "Promoted. New {role} repositories on {target} can now start from
  {label}." (no target: "New {role} repositories can now start from {label}.")
  The new row is first and tinted `--el-tint-yellow` for the visit.
- Retire: "Retired. {label} is no longer offered to new repositories." The row
  leaves the Active filter.
