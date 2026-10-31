# Workspace address — design notes

The control for a workspace's one name under the tenant base domain
(`motir.site`, configured as `MOTIR_PUBLIC_TENANT_DOMAIN`), in WORKSPACE
settings, and the read-only echo that replaces the subdomain card in project
settings.

| Surface                                          | Mock                                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace settings › Public address              | [`workspace-address.mock.html`](workspace-address.mock.html) — panels 0–12                                                                                                             |
| Project settings › the workspace echo            | [`../projects/public-address--workspace-echo.mock.html`](../projects/public-address--workspace-echo.mock.html) — panels A–C (a delta; see `design/projects/design-notes.md`)           |
| Workspace settings › Custom domains              | [`custom-domains.mock.html`](custom-domains.mock.html) — panels 0–12 (see [Custom domains](#custom-domains) below)                                                                     |
| Custom domains › the application a domain serves | [`custom-domains--application.mock.html`](custom-domains--application.mock.html) — panels A–F, a delta (see [The application a domain serves](#the-application-a-domain-serves) below) |

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

## Custom domains

A NEW surface in this area: `custom-domains.mock.html`, panels 0–12, amended
by the delta `custom-domains--application.mock.html`, panels A–F (see
[The application a domain serves](#the-application-a-domain-serves)). It sits
beside the Public address room and amends that room's pane by one line (the
**Address-pane link**, panel 0 ②); the Public address mock is cited, not
edited. This section names no work item.

### The rules the strings state

These come from the customer-domain decision published on the hosting story's
decision page (a domain is the workspace's; an issued host serves the
workspace's hosted application or a no-application state; no primary, no Motir
redirect; removal drops the row and the host stops answering at once; nothing is
reserved) and from `docs/decisions/public-tenant-addresses.md`:

1. Ownership is proven by the TXT record `_motir-verify.<host>` before any
   certificate is requested (§5).
2. The pointing record is a CNAME for a subdomain and A + AAAA for a root
   domain; a root under a multi-label public suffix is a root and never gets a
   CNAME (§5's records table). The A and AAAA values are motir-edge's OWN
   dedicated IPv4 and IPv6, the pair that app holds for customer
   certificates; the note under the records says they are Motir's own. The
   values are configuration (`MOTIR_PUBLIC_ADDRESS_A_RECORDS`,
   `MOTIR_PUBLIC_ADDRESS_AAAA_RECORDS`, `MOTIR_PUBLIC_ADDRESS_CNAME_TARGET`); an
   unset list omits its row rather than drawing a blank or an invented value.
3. The certificate is Fly's, at Motir's edge (§6); its states are the pill's.
4. The tier gate is `custom_domains` with the `maxCustomDomains` cap (§9).
5. Hostnames are refused by `normaliseCustomHostname` — malformed, under the
   tenant base, under the Motir site — before anything is stored.
6. There is NO primary address, no make-primary action and no redirect between
   a customer's domains. Nothing in this surface mentions one.

### Elements

Each element is named once; the panel numbers say where it is drawn.

- **Rail row** (panel 0 ①) — `Custom domains` in the workspace rail's Access
  group, directly under `Public address`. Shipped rail row and glyph.
  Destination `/settings/workspace/custom-domains`. Shown to every member.
- **Address-pane link** (panel 0 ②) — one line under the Public address pane's
  address row: `Use your own domain instead →`, ink `--el-link`, to the same
  destination.
- **Domains list** (panels 1–4, 6–12) — a Card (`--radius-card`,
  `--shadow-subtle`, `--el-border`, padding `--spacing-card-padding`), title
  `Custom domains`, subtitle `Serve this workspace's application on a domain you
own.` (`--el-text-secondary`). Each domain is a row in the address row's
  grammar: `--el-surface-soft` fill, `--el-border`, `--radius-control`, padding
  `--spacing-control-y` / `--spacing-control-x`, min height `--height-control`;
  the host in mono on `--el-text` (on `--el-link` once issued). Empty: the
  shipped EmptyState. Loading: two `--height-control` Skeleton rows; Add stays
  enabled.
- **Add-domain dialog** (panel 5; delta panel A) — Modal (`--radius-modal`,
  `--shadow-modal`) with two fields: the Domain Input (`--height-input`,
  `--spacing-input-x`, `--radius-input`) and the **application picker** below
  it, each with a helper on `--el-text-secondary`; Cancel (ghost) and
  `Add domain` (primary, disabled while the domain is empty, and while no
  choice is made when the workspace has several applications). Each refusal is
  the Input's error state (border `--el-danger`) with its message on
  `--el-danger-on-surface`. Focus is trapped (dialog, Domain, Application,
  Cancel, Add domain) and returns to the Add button on close.
- **Application picker** (delta panels A, C) — the shipped Combobox, single
  select: its trigger in the Input's box (`--height-input`,
  `--spacing-input-x`, `--radius-input`, `--el-border`) with the chevron on
  `--el-icon-muted`; its listbox (`--radius-card`, `--shadow-elevated`) of rows
  (`--spacing-control-y` / `--spacing-control-x`, `--radius-control`, the
  active row on `--el-option-active-bg`), each the application's name on
  `--el-text` with its slug in mono on `--el-text-identifier`, then a divider
  and `No application yet`. A long name truncates in the option and the
  trigger. No application in the workspace: the picker is absent and a settled
  line on `--el-text-secondary` stands in its place; Add domain stays enabled
  and the domain is added naming none. One application: preselected. Several:
  nothing preselected. It has no loading or failed-to-load state of its own:
  the applications are read on the server with the rest of the pane, so a
  failed read is the pane's load-error state and an empty workspace is the
  absent-picker state.
- **DNS records panel** (panels 6–7, behind `Show DNS records` once issued) — a
  table on `--el-page-bg` inside the row, `--el-border`, `--radius-control`;
  headers and the note on `--el-text-secondary`; values mono. Each value has a
  CopyButton (`--radius-control`, `--spacing-control-x`) that announces
  `Copied`. Unverified: the pointing record(s) then the TXT. Pending: the
  pointing record only. An apex's A and AAAA rows are the edge's own addresses
  (rule 2) and the note under them says so (delta panel F); a record list that
  is not configured omits its row.
- **Status pill** (every row) — the shipped Pill: hue in the tint background,
  label on `--el-text-strong`, radius `--radius-badge`, padding
  `--spacing-chip-x` / `--spacing-chip-y`, with a dot. `Unverified` →
  `--el-tint-yellow`; `Pending` → `--el-tint-sky`; `Issued` → `--el-tint-mint`;
  `Failed` → `--el-tint-rose`. The word always carries the state.
- **Application line** (panels 8, 12; delta panels B, E) — 13px on
  `--el-text`, under the host of an issued domain, reading as a sentence and
  not a badge. Bound: `Serves <name> <slug>.`, the name strong and the slug in
  mono on `--el-text-identifier`. Unbound: the domain names no application and
  so serves nothing yet — it promises nothing about serving later, because an
  unbound domain answers no application until an owner binds it. Naming an
  application that is no longer listed: says so, and never falls back to the
  unbound words. No error styling for either. A long name wraps inside the
  line. Beneath it the certificate line on `--el-text-secondary`.
- **Application control** (delta panels B–D) — a ghost Button beside the
  Application line, wrapping under it at a narrow width: `Change application`
  on a bound or no-longer-listed row, `Choose application` on an unbound one;
  its accessible name names the domain. It opens THE application picker in a
  Modal titled for the domain, the current application preselected and ticked
  (nothing preselected when it is no longer listed), and Save (primary)
  disabled until the selection differs. Once it differs the Modal states what
  changes — which application the domain serves, at once on save — and what
  does not: the certificate, the DNS records at the provider and the domain's
  status. Saving: Save shows the spinner and `Saving…`, both buttons and the
  trigger disabled, the row unchanged. Failed: the message on
  `--el-danger-on-surface` above the footer, Save reads `Retry`, the row still
  names what it named before. Absent for a member who cannot manage. The write
  is `PATCH /api/workspaces/[workspaceId]/custom-domains/[addressId]` to
  `customDomainService.bind`, which refuses an application that is not the
  workspace's; it changes only which application the domain names — no
  certificate is re-issued, no DNS record changes, and the host keeps answering
  throughout.
- **Failure banner with action** (panels 9–10) — the callout's danger form:
  `--el-tint-rose` fill, `--el-danger` left border, words on
  `--el-text-strong`, the expected record in mono on `--el-text-strong`, and one
  Button. `role="alert"` only when the status changes to a failure. Its three
  kinds are the status job's failure reasons: ownership record lost (Re-check),
  pointing record lost (Re-check, naming the record that moved and the value it
  now answers), issuance failed (Retry and Remove, with the platform's reason
  verbatim). While re-checking, the action is disabled with a spinner and
  `Checking…`; the result arrives as the row's status changing.
- **Remove confirm** (panel 11) — Modal; the body on `--el-text-secondary`;
  Cancel (ghost) and `Remove domain` (danger: `--el-danger` fill with
  `--el-danger-text`). Removing: both disabled, spinner, `Removing…`. Failed:
  the message on `--el-danger-on-surface` above the footer and the danger button
  reads `Retry`. Success: the row leaves the list and a Toast confirms (hue in
  the border and glyph, words on `--el-text`).
- **Tier upsell** (panels 2, 3) — not entitled: the accent callout
  (`--el-tint-lavender`, `--el-accent` border, `--el-text-strong`) replaces Add
  and names the Scaled plan, with `See plans` (primary). At the cap: Add
  disabled, and the count as text under it (`5 of 5 domains`, strong ink) with a
  `See plans` link.
- **Read-only line** (panel 12) — for a member who cannot manage: every action
  absent (not disabled) and `Only a workspace owner or admin can add or remove
domains.` on `--el-text-secondary`.

### Strings (en)

| Key                         | String                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domains.rail`              | Custom domains                                                                                                                                                                                             |
| `domains.addressLink`       | Use your own domain instead →                                                                                                                                                                              |
| `domains.title`             | Custom domains                                                                                                                                                                                             |
| `domains.subtitle`          | Serve this workspace's application on a domain you own.                                                                                                                                                    |
| `domains.add`               | Add domain                                                                                                                                                                                                 |
| `domains.empty.title`       | No custom domains yet                                                                                                                                                                                      |
| `domains.empty.body`        | Add a domain like shop.acme.com. You create two DNS records, Motir issues the certificate, and the domain serves this workspace's application.                                                             |
| `domains.cap`               | {used} of {max} domains                                                                                                                                                                                    |
| `domains.upsell.title`      | Custom domains are included on the Scaled plan.                                                                                                                                                            |
| `domains.upsell.body`       | Your application keeps answering at {host} on every plan. Upgrade to serve it on a domain you own.                                                                                                         |
| `domains.upsell.cta`        | See plans                                                                                                                                                                                                  |
| `domains.dialog.title`      | Add a domain                                                                                                                                                                                               |
| `domains.dialog.label`      | Domain                                                                                                                                                                                                     |
| `domains.dialog.helper`     | A subdomain like shop.acme.com or a root domain like acme.com.                                                                                                                                             |
| `domains.dialog.appLabel`   | Application                                                                                                                                                                                                |
| `domains.dialog.appHelper`  | The application this domain will serve. You can change it later on the domain's row.                                                                                                                       |
| `domains.dialog.appChoose`  | Choose an application                                                                                                                                                                                      |
| `domains.dialog.appNone`    | No application yet                                                                                                                                                                                         |
| `domains.dialog.noApps`     | This workspace has no hosted application yet. The domain is added naming none, and you can choose its application on its row once one exists.                                                              |
| `domains.refuse.tenantBase` | {host} is a Motir address. Your workspace already answers under {base} — set that name in Public address.                                                                                                  |
| `domains.refuse.siteOrigin` | {host} belongs to Motir. Add a domain you own.                                                                                                                                                             |
| `domains.refuse.malformed`  | Enter only the domain, like shop.acme.com — no https:// and no path.                                                                                                                                       |
| `domains.refuse.taken`      | {host} is already connected to another Motir workspace. If it is yours, remove it there first.                                                                                                             |
| `domains.refuse.cap`        | Your plan includes {max} custom domains and all {max} are in use. Remove one, or see plans.                                                                                                                |
| `domains.status.unverified` | Unverified                                                                                                                                                                                                 |
| `domains.status.pending`    | Pending                                                                                                                                                                                                    |
| `domains.status.issued`     | Issued                                                                                                                                                                                                     |
| `domains.status.failed`     | Failed                                                                                                                                                                                                     |
| `domains.records.heading`   | {count, plural, one {Create this record at your DNS provider, then check.} other {Create these # records at your DNS provider, then check.}}                                                               |
| `domains.records.apexNote`  | A root domain cannot take a CNAME, so it points at Motir's own addresses, which motir-edge holds for customer domains. If they ever change we will tell you before they do.                                |
| `domains.pending`           | Ownership confirmed. Issuing the certificate — this usually takes a few minutes. This page updates on its own.                                                                                             |
| `domains.app.serves`        | Serves {app} {slug}.                                                                                                                                                                                       |
| `domains.app.none`          | This domain names no application, so it serves nothing yet.                                                                                                                                                |
| `domains.app.gone`          | The application this domain named is no longer available, so it serves nothing.                                                                                                                            |
| `domains.app.change`        | Change application                                                                                                                                                                                         |
| `domains.app.choose`        | Choose application                                                                                                                                                                                         |
| `domains.app.controlLabel`  | {action} for {host}                                                                                                                                                                                        |
| `domains.app.title`         | Application for {host}                                                                                                                                                                                     |
| `domains.app.save`          | Save                                                                                                                                                                                                       |
| `domains.app.saving`        | Saving…                                                                                                                                                                                                    |
| `domains.app.confirm`       | {host} serves {app} as soon as you save. Its certificate, the DNS records at your provider and its status stay as they are.                                                                                |
| `domains.app.confirmNone`   | {host} stops serving {previous} as soon as you save, and serves nothing until you choose an application. Its certificate, the DNS records at your provider and its status stay as they are.                |
| `domains.app.error`         | The application was not changed. Try again in a moment.                                                                                                                                                    |
| `domains.cert`              | Certificate renews on its own · valid until {date}                                                                                                                                                         |
| `domains.fail.txt`          | We can no longer see your ownership record                                                                                                                                                                 |
| `domains.fail.txtBody`      | Restore this TXT record at your DNS provider:                                                                                                                                                              |
| `domains.fail.pointing`     | {host} no longer points at Motir                                                                                                                                                                           |
| `domains.fail.pointingBody` | The {type} record now answers {found}. Set it back to:                                                                                                                                                     |
| `domains.fail.issuance`     | The certificate could not be issued                                                                                                                                                                        |
| `domains.fail.issuanceBody` | The certificate authority said:                                                                                                                                                                            |
| `domains.action.checkNow`   | Check now                                                                                                                                                                                                  |
| `domains.action.recheck`    | Re-check                                                                                                                                                                                                   |
| `domains.action.retry`      | Retry                                                                                                                                                                                                      |
| `domains.action.checking`   | Checking…                                                                                                                                                                                                  |
| `domains.action.showDns`    | Show DNS records                                                                                                                                                                                           |
| `domains.action.copy`       | Copy                                                                                                                                                                                                       |
| `domains.action.copied`     | Copied                                                                                                                                                                                                     |
| `domains.action.remove`     | Remove                                                                                                                                                                                                     |
| `domains.remove.title`      | Remove {host}?                                                                                                                                                                                             |
| `domains.remove.body`       | It stops serving your application at once. Nothing is reserved: you can add it again later, and another workspace can add it if it proves ownership. The DNS records at your provider are yours to delete. |
| `domains.remove.confirm`    | Remove domain                                                                                                                                                                                              |
| `domains.remove.removing`   | Removing…                                                                                                                                                                                                  |
| `domains.remove.error`      | The domain was not removed. Try again in a moment.                                                                                                                                                         |
| `domains.remove.toast`      | {host} removed                                                                                                                                                                                             |
| `domains.remove.toastBody`  | It no longer serves your application.                                                                                                                                                                      |
| `domains.readOnly`          | Only a workspace owner or admin can add or remove domains.                                                                                                                                                 |

### The application a domain serves

The delta `custom-domains--application.mock.html`, panels A–F, amends
`custom-domains.mock.html` (cited, not edited): panel A amends panel 5, panel B
amends panel 8, panel E amends panel 12, and panel F REPLACES panel 6's apex
half and its note. Panels C and D are new: the Application control and its
change. Every other panel — 0–4, 7, 9–11 and panel 6's subdomain half — stands
as drawn. The elements are the **Add-domain dialog**, **Application picker**,
**Application line**, **Application control** and **DNS records panel** above;
the strings are the table above.

**Supersedes.** Of the pane's design of record this amendment changes three
things: the Add-domain dialog's single control (the hostname Input) becomes two,
the hostname and the application picker; the Application line
`Serves <app>, this workspace's application.` becomes the chosen application by
name, with an unbound variant that promises nothing about serving later and a
no-longer-listed variant; and rule 2's sentence about the apex A value's
address becomes the edge's own dedicated IPv4 and IPv6. It ADDS one
element the record did not have, the **Application control**. It drops nothing
else: the Domains list, Status pill, Failure banner with action, the DNS
records panel's ownership TXT and pointing rows, Remove confirm, Tier upsell,
read-only line, the empty, loading and load-error states, every refusal string
and every other panel stay as they are.

**Unbound stays unbound until an owner binds it.** A domain added naming no
application is not attached to the workspace's first application when one
appears: an issued, certified host silently starting to serve whichever
application came first is a change to what a customer's domain points at that
nobody asked for. The row states the state and offers the control; the host
keeps answering no application until the owner acts.

**The interface the picker consumes.** One entry per hosted application of the
workspace, `{ id, name }` — the name shown with its slug, the id sent as
`applicationId` on add (`POST /api/workspaces/[workspaceId]/custom-domains`,
which accepts `{ hostname, applicationId? }`) and on the re-point (`PATCH
…/custom-domains/[addressId]`). No read returning it exists in the product
today: `hostedApplicationService` reads per repository and per application, and
`hostedApplicationRepository.listSlugsInWorkspace` returns slugs without ids.

### Ink

As the rest of this area: secondary copy on `--el-text-secondary`; no text on
`--el-text-muted` or `--el-text-faint`; refusal text on
`--el-danger-on-surface`; `--el-danger-text` only on the danger Button's fill. A
failure's hue lives in the banner's border and tint, never in its words.
