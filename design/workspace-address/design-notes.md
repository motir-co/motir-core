# Workspace address — design notes

The control for a workspace's one name under the tenant base domain
(`motir.site`, configured as `MOTIR_PUBLIC_TENANT_DOMAIN`), in WORKSPACE
settings, and the read-only echo that replaces the subdomain card in project
settings.

| Surface                               | Mock                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace settings › Public address   | [`workspace-address.mock.html`](workspace-address.mock.html) — panels 0–12                                                                                                   |
| Project settings › the workspace echo | [`../projects/public-address--workspace-echo.mock.html`](../projects/public-address--workspace-echo.mock.html) — panels A–C (a delta; see `design/projects/design-notes.md`) |

Context: Story MOTIR-4528 · Subtask MOTIR-9513; the rules are
`docs/decisions/public-tenant-addresses.md` §8 Amendment 3; the address decision
is MOTIR-9790.

## The rules the strings state

1. A workspace has ONE name. No aliases.
2. A renamed or released name stops answering at once. Nothing redirects.
3. A name held under 24 hours returns to the pool at once; one held 24 hours or
   more is held for 90 days from the change.
4. One change (a rename or a release) per 30 days. A first claim is not a change.
5. The confirm dialog states the date before the change is made.

Every date is the server's (the preview route for the dialog, the write's own
answer for a toast), shown in the viewer's locale in long form
(`26 January 2027`). The board's scenario: today is 28 October 2026, a hold ends
26 January 2027, the lock ends 27 November 2026.

## What the old pane showed that is gone

The shipped project-settings card (`PublicSubdomainCard`, drawn in
`design/projects/public-address.mock.html` panels 1, 2, 8 and 10–13) is replaced.
Removed, with nothing in their place:

- the alias rows (`Redirects here` / `Redirects`) and their state hint;
- the rename counter (`# renames left`) and the claim line promising a limited
  number of renames;
- the permanent-reservation warning (`held for ever`, `never released`) in the
  rename and remove dialogs;
- the `Remove` control and its multi-hostname list (one name now, so a release
  names one host);
- the claim field, Rename and Remove in PROJECT settings (the project page keeps
  a read-only echo only).

## Elements

Each element is named once; the panel numbers say where it is drawn.

### Access path (panel 0)

- **Rail row** — the workspace-settings rail gains `Public address` in the
  Access group, after Roles. Shipped rail row; glyph is the rail's own.
  Destination `/settings/workspace/public-address`.
- **Door card** — when the workspace is the organisation's only one, the
  workspace rail does not show, so the organisation settings page carries a Card
  titled `Public address` naming the current host (or `No name claimed yet.`)
  with a link, `Manage →` or `Claim a name →`, to the same destination.
  Card padding `--spacing-card-padding`; link ink `--el-link`.

### The pane (panels 1–12)

- **Pane card** — Card (`--radius-card`, `--shadow-subtle`, `--el-border`),
  title `Public address`, subtitle `The one name your workspace answers at.`
  (`--el-text-secondary`).
- **Name field** — Input with a `.motir.site` suffix block (suffix on
  `--el-surface`, ink `--el-text-secondary`, mono). Height `--height-input`,
  padding `--spacing-input-x`, radius `--radius-input`. The helper is the
  Input's `helperText`: the grammar hint while empty, the live preview
  (`Readers will find you at <host>`, host in `--el-text`, mono) while typing.
- **Field refusal** — the Input's error state (border `--el-danger`), message in
  `--el-danger-on-surface`. Seven messages, one per reason (strings below).
  Claim is disabled while a refusal shows.
- **Claim button** — Button primary (`--el-accent` / `--el-accent-text`,
  `--radius-btn`, `--height-btn-sm`). Disabled while the field is empty or
  refused.
- **Address row** — the shipped `AddressRow`: host (mono, `--el-text`), Pill
  `Live` (`--el-tint-mint`, `--el-text-strong`, `--radius-badge`,
  `--spacing-chip-x/y`), CopyButton, open-in-new-tab icon Button. Row padding
  `--spacing-control-x/y`, radius `--radius-control`, on `--el-surface-soft`.
  No alias rows beneath it.
- **Rename / Release** — Button secondary (Rename) and ghost (Release) under the
  row. Disabled, never hidden, while the lock is active.
- **Lock line** — text under the actions, `--el-text-secondary` with the date in
  `--el-text-strong`. Shown only while a lock is active (and after a release).
- **Rename editor** — the Name field pre-filled with the current label, label
  `New name`, with the same refusals; `Review` (primary) opens the dated
  confirm, `Cancel` (ghost) restores the row.
- **Dated confirm** — Modal (`--radius-modal`, `--shadow-modal`). A callout
  carries the settled line and the return date: warn callout (`--el-tint-yellow`,
  left border `--el-warning`) for a rename, danger callout (`--el-tint-rose`,
  left border `--el-danger`) for a release, ink `--el-text-strong`. Two
  variants, always drawn side by side: held 24 hours or more (a date), held
  under 24 hours (right away). Then the no-redirect line, the conditional
  application-host line (only when the count is above zero; the count has no
  source until the application record exists), and the lock that will follow.
  Primary action Button danger (`--el-danger` fill, `--el-danger-text` ink — the
  one legal use); while submitting both actions are disabled and the primary
  shows a spinner and `Renaming…` / `Releasing…`.
- **Toast** — the shipped Toast: success (border and glyph `--el-success`) after
  claim, rename and release; danger (border `--el-danger`, glyph
  `--el-danger-on-surface`) for a refused change, with the control returned to
  its prior state. Words on `--el-text` / `--el-text-secondary`.
- **Released notice** — a callout (`--el-tint-lavender`) above the empty field:
  the released host and its date, or `Anyone can claim it now.` The field never
  keeps the released label.
- **Read-only line** — for a member who cannot manage, the subtitle becomes
  `Only workspace owners and admins can change this.` and every control (field,
  Claim, Rename, Release) is absent. Copy and open stay.
- **Loading** — PageSkeleton-style rows (`--el-muted`, `--radius-control`) in the card.
- **Load error** — one line and a `Try again` Button.
- **Narrow layout** — at 390 wide the host wraps, Copy and open stay on the row,
  the Pill drops under it, Rename and Release go full width; the dialog's
  actions stack, the danger action first.

### The project-settings echo (delta panels A–C)

- **Echo card** — Card titled `Workspace address`. Claimed: the workspace host
  in an address row (no Pill, no actions but Copy and open), a line
  `This project's public page is at motir.co/p/<KEY>.`, and the link
  `Change in workspace settings →`. Unclaimed: the project's `motir.co/p/<KEY>`
  address and `Claim a name for the workspace →`. Both links go to
  `/settings/workspace/public-address`. Same for every role.
- The echo shows the workspace HOST, not a project path under it: the address
  decision moved public projects to `motir.co/p/<KEY>` and gives the workspace
  host to the default application.

## Strings (en)

Namespace `settings.workspaceAddress`. The zh strings are added from these keys.

| Key                         | en                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `nav.label`                 | Public address                                                                                                   |
| `door.title`                | Public address                                                                                                   |
| `door.claimed`              | {host} — one name for the workspace.                                                                             |
| `door.none`                 | No name claimed yet.                                                                                             |
| `door.manage`               | Manage →                                                                                                         |
| `door.claim`                | Claim a name →                                                                                                   |
| `title`                     | Public address                                                                                                   |
| `subtitle`                  | The one name your workspace answers at.                                                                          |
| `readOnly`                  | Only workspace owners and admins can change this.                                                                |
| `none`                      | No name claimed yet.                                                                                             |
| `field.label`               | Name                                                                                                             |
| `field.renameLabel`         | New name                                                                                                         |
| `field.hint`                | Lowercase letters, digits and single hyphens; 3–30 characters. A workspace has one name.                         |
| `field.preview`             | Readers will find you at {host}                                                                                  |
| `claim`                     | Claim name                                                                                                       |
| `refusal.tooShort`          | Use at least 3 characters.                                                                                       |
| `refusal.badGrammar`        | Use only lowercase letters, digits and hyphens.                                                                  |
| `refusal.doubleHyphen`      | A name can’t contain two hyphens in a row — that’s kept for application addresses.                               |
| `refusal.tooLong`           | Use 30 characters or fewer.                                                                                      |
| `refusal.taken`             | {host} is taken. Try another name.                                                                               |
| `refusal.reserved`          | “{label}” is reserved. Choose another name.                                                                      |
| `refusal.quarantined`       | {host} was released recently and is held until {date}. Anyone can claim it from then.                            |
| `row.live`                  | Live                                                                                                             |
| `row.copy`                  | Copy address                                                                                                     |
| `row.open`                  | Open in a new tab                                                                                                |
| `rename`                    | Rename                                                                                                           |
| `release`                   | Release                                                                                                          |
| `lock`                      | You can change the name again on {date}. A rename and a release each count as one change, once every 30 days.    |
| `lockShort`                 | You can change the name again on {date}.                                                                         |
| `review`                    | Review                                                                                                           |
| `cancel`                    | Cancel                                                                                                           |
| `confirm.renameTitle`       | Rename to {host}?                                                                                                |
| `confirm.releaseTitle`      | Release {host}?                                                                                                  |
| `confirm.stops`             | {host} stops answering now.                                                                                      |
| `confirm.returnsOn`         | Anyone can claim it from {date}.                                                                                 |
| `confirm.returnsNow`        | Anyone can claim it right away — you held it for less than 24 hours.                                             |
| `confirm.noRedirectRename`  | Nothing redirects from the old address to the new one, so update any links you have shared.                      |
| `confirm.noRedirectRelease` | Nothing redirects. Your public projects stay at their motir.co addresses.                                        |
| `confirm.appHosts`          | {count, plural, one {# application address} other {# application addresses}} ({pattern}) stop answering with it. |
| `confirm.lockAfterRename`   | You can’t change the name again until {date}.                                                                    |
| `confirm.lockAfterRelease`  | You can’t claim or change a name until {date}.                                                                   |
| `confirm.rename`            | Rename                                                                                                           |
| `confirm.renaming`          | Renaming…                                                                                                        |
| `confirm.release`           | Release name                                                                                                     |
| `confirm.releasing`         | Releasing…                                                                                                       |
| `toast.claimed`             | {host} is yours                                                                                                  |
| `toast.renamed`             | Renamed to {host}                                                                                                |
| `toast.renamedBody`         | {old} no longer answers.                                                                                         |
| `toast.released`            | {host} released                                                                                                  |
| `toast.refusedTitle`        | Name not changed                                                                                                 |
| `toast.refusedLimit`        | You can change it again on {date}.                                                                               |
| `toast.refusedTaken`        | {host} was just taken. Try another name.                                                                         |
| `toast.refusedQuarantined`  | {host} is held until {date}.                                                                                     |
| `released.held`             | {host} was released. It is held until {date}, then anyone can claim it.                                          |
| `released.free`             | {host} was released. Anyone can claim it now.                                                                    |
| `released.lock`             | You can claim a name now. After that, the next change is allowed on {date}.                                      |
| `loadError`                 | The address couldn’t be loaded.                                                                                  |
| `retry`                     | Try again                                                                                                        |
| `echo.title`                | Workspace address                                                                                                |
| `echo.claimedSub`           | The name your workspace answers at.                                                                              |
| `echo.noneSub`              | Your workspace has no name yet.                                                                                  |
| `echo.projectPage`          | This project's public page is at {url}.                                                                          |
| `echo.projectPageShort`     | This project's public page.                                                                                      |
| `echo.change`               | Change in workspace settings →                                                                                   |
| `echo.claim`                | Claim a name for the workspace →                                                                                 |

## Ink

Secondary copy is `--el-text-secondary` everywhere (it clears AA on every
surface). `--el-text-muted` and `--el-text-faint` carry no text. Danger text is
`--el-danger-on-surface`; `--el-danger-text` appears only on the danger
Button's `--el-danger` fill.
