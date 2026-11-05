# Approval records — design notes

Design reference for the `approvals` UI area: the **Approval records** room
(Story [MOTIR-5299](motir:cmtyy44dv01mqhvtxgsqdd250) · Subtask
[MOTIR-5300](motir:cmtyy44gy01mshvtx6hmyi1r3)). It is the layout source of truth
for **MOTIR-5302** (the room and its rail row), which carries it in `blocked_by`,
and it states the ORDER and the SECTION VOCABULARY that **MOTIR-5301** (the read)
builds to.

| Surface                       | Asset                                        | Notes                                                                                                                                                                                 |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Approval records room** | **`approvals-room.mock.html`** (HTML mockup) | A · the room for a reader holding `approval:view_any` · B · the same room for a reader without it · C · the rail row in place · D · three empty states · E · narrow (`< md`), in `zh` |

**Two files, no `.png`.** The card asked for a committed export; `CLAUDE.md`
§ _Design assets — TWO files per surface_ (`docs/decisions/design-result.md`
AMENDMENT 4) retired exports, so this asset is the notes and the mock. The
viewport measurements below were taken from a local render, which is not
committed.

---

## What this room IS, and what it is NOT

**It is a RECORD.** Every approval a reader is entitled to see in the active
project, **pending first, then decided**, each decided row naming who decided,
when, and against which version of the subject. It answers _what has been decided
here, and by whom_.

It is **not** either of the two surfaces that already carry the word:

| surface                                                         | what it answers                        | why this room is not it                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| the Workbench **To approve** tab (`/workbench`)                 | _what should I decide next?_           | a QUEUE: its correctness is that it empties. A decided row leaves on the next load. This room keeps it. The tab is unchanged by this asset. |
| the settings **Approvals** room (`/settings/project/approvals`) | _which gates does this project raise?_ | CONFIGURATION, gated on `workflow:manage`. It holds no approval at all.                                                                     |

The room reads the SAME rows the tab reads for its pending half, plus the decided
ones the tab forgets on purpose, plus, for a reader holding `approval:view_any`,
other people's.

## The NAME — _Approval records_ / _审批记录_

**Rail, page heading and command palette all read _Approval records_** (`zh`:
_审批记录_).

The card asked for one word. **Every one-word candidate either collides or lies,
so this asset overrules "one word" and records why:**

| candidate                | verdict                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Approvals_              | **collides.** It is the settings room's title and its settings-rail label (`settings.approvals.title`, `settings.nav.approvals`).                                                       |
| _Decisions_              | **collides twice.** `decision` is a work TYPE (`lib/issues/workItemTypeMeta.ts`) and `decision_approval` a gate kind. A rail row reading _Decisions_ reads as a list of decision cards. |
| _Reviews_                | **collides.** The row's own button reads _Review_, and a pull-request review is a different object.                                                                                     |
| _Sign-offs_ / _Approved_ | **lies.** `changes_requested` is a decision with a person's name on it, and it is not a sign-off.                                                                                       |
| _Approval records_       | **true for every row it holds, and distinct from both rooms above.** It is the story's own noun (_"holding every approval record"_).                                                    |

## The two views: ONE room, two contents

**The view is decided by ONE permission, `approval:view_any`, and never by a
role.** The built-in Admin role set carries it, workspace owners and admins hold
it through the always-pass rail, and a custom role can be granted it. The panels
are labelled by the permission for that reason.

| panel | reader                            | holds                                                                                                        |
| ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **A** | holds `approval:view_any`         | every approval of the project that is `awaiting`, `approved` or `changes_requested`, other people's included |
| **B** | does not hold `approval:view_any` | approvals **routed to them and `awaiting`**, plus approvals **they decided** (`decidedById` = the reader)    |

**What is identical in both:** the rail, the heading, the section headings, the
row, the pager, the order and the empty-state titles. **What differs:** which
rows arrive, the subtitle line under the heading, the section empty-state body
lines, and ONE conditional column (below). **The view is never shown as a
permission.** No banner, chip or sentence tells a reader which view they have.
The subtitle describes the rows, not the reader's access.

| string   | A (holds the key)                                               | B (does not)                                          |
| -------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| subtitle | _Every approval in this project — waiting first, then decided._ | _Approvals waiting on you, and the ones you decided._ |
| `zh`     | _本项目的全部审批——先列等待中的，再列已决定的。_                | _等待你处理的审批，以及你已决定的审批。_              |

## The ORDER — stated, for both halves

**One list, two sections, pending ABOVE decided.** The boundary is in the DTO
(MOTIR-5301), never inferred from a state field downstream.

| section                 | holds                           | sort                                                | why                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Awaiting a decision** | `state = awaiting`              | **`createdAt` ascending**, ties by `id` ascending   | **ADOPTED from `findAwaitingRoutedTo`.** A record room does not change what a pending row IS: it is still work stalled behind a question, and the oldest has stalled the longest. And in view B this half is exactly the tab's rows, so it must list them in the tab's order or the two surfaces disagree about the same gates. |
| **Decided**             | `approved`, `changes_requested` | **`decidedAt` descending**, ties by `id` descending | Most recently decided first. A reader opens a record to find what just happened, and the next question after that is always the one before it. There is no queue precedent here, so this is a decision rather than an inheritance.                                                                                              |

**The window runs across the concatenation.** The room shows ONE pager (the
shipped `IssueListPager`, composed unchanged) over pending-then-decided as a
single ordered list. Its denominator is **pending total + decided total**. A page
that holds rows from both sections renders both headings. A page that starts
inside the decided half renders only the _Decided_ heading. **Each section
heading carries its own section total**, so a reader on page 3 still knows how
many are waiting. How that window is computed is MOTIR-5301's. What the page
needs is these two totals and the rows in this order.

## The WORDS — every state, settled

| `ApprovalGateState` | where it appears                | word (en / zh)                                                                                           |
| ------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `awaiting`          | section **Awaiting a decision** | the row's own Decide cell. _Review_ when the reader may decide, the **Awaiting** pill when they may not. |
| `approved`          | section **Decided**             | **Approved** / **已批准** (the shipped `approvalGate.state.approved` pill, `--el-tint-mint`)             |
| `changes_requested` | section **Decided**             | **Changes requested** / **已要求修改** (the shipped pill, `--el-tint-peach`)                             |
| `superseded`        | **NOWHERE in this room**        | not shown in either view                                                                                 |

**Section headings:** **Awaiting a decision** / **等待决定** · **Decided** /
**已决定**. _Decided_ is true of `changes_requested`, because sending something
back is a decision. _Approved_ would be false for a real subset of the section.

### `superseded` is NOT in the room, in either view

ADR §6b writes a null `decidedById` to mean _the question was withdrawn and
nobody decided it_. View B excludes it for free (it is neither routed-and-awaiting
nor decided-by-me). **View A excludes it on purpose:**

- **It is not a record of a decision.** Listing it beside decisions lets a reader
  conclude something was decided when it was abandoned. A room called _records_
  becomes less trustworthy than no room.
- **It is not pending either,** so neither section is true for it, and a third
  section would hold rows that are mostly noise. Every republish of a design
  writes one, so they would outnumber the real decisions.
- **The question it withdrew is still here.** A gate is superseded by a newer
  gate on the same (work item, kind). That newer gate is in this room, as a
  pending or decided row.
- **The audit set has no field for WHEN it was withdrawn.** `decidedAt` is null
  and `updatedAt` is not an audit column, so there would be nothing true to sort
  it by.

The **Withdrawn** pill therefore never renders here. It stays the frame's and the
tab's, which draw it where a withdrawn gate can actually be met.

### Empty states — three, and none of them is about access

A reader with no records has simply not been asked anything yet. **No empty state
mentions a permission, access, a role or an administrator.** All three use the
shipped `EmptyState` primitive's text grammar, with no action, because nothing a
reader can press creates an approval (the same call `workbench.empty.approvals`
makes).

| state               | where                                              | en                                                                                                                                                                                                                            | zh                                                                                                                                     |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **nothing at all**  | replaces both sections and the pager               | title _No approvals yet_. body A: _When a work item in this project waits on a decision, it appears here, and it stays here once it is decided._ body B: _Approvals asked of you, and the ones you decide, will appear here._ | _还没有审批_ · A: _本项目中等待决定的工作项会出现在这里，决定之后也会保留。_ · B: _请你处理的审批，以及你决定的审批，都会出现在这里。_ |
| **nothing pending** | one line under the **Awaiting a decision** heading | A: _Nothing in this project is waiting on a decision._ · B: _Nothing is waiting on you._                                                                                                                                      | A: _本项目中没有等待决定的审批。_ · B: _没有等待你处理的审批。_                                                                        |
| **nothing decided** | one line under the **Decided** heading             | A: _No approval in this project has been decided yet._ · B: _You have not decided an approval in this project yet._                                                                                                           | A: _本项目中还没有已决定的审批。_ · B: _你在本项目中还没有决定过审批。_                                                                |

**Both section headings always render when there is at least one row anywhere**,
with `0` as the section total. The empty section's line then makes the half
legible instead of a missing heading making it look broken.

## The ROW — COMPOSED from `design/workbench/`, not redrawn

**This asset does not draw a second approvals row.** The row is
`design/workbench/design-notes.md` § 20 (_The To-approve tab's ROW_) as amended by
§ 22 (the row OPENS the approval overlay, no chevron), and its shipped markup is
`app/(authed)/workbench/_components/ApprovalsList.tsx`'s `ApprovalRow`. The mock
reproduces that markup, element for element, including:

- which field each cell reads (§ 20 _WHICH FIELD each element of the row reads_),
- the 44px row and the `< md` two-line reflow,
- the settled treatment (`--el-text-secondary` ink on the kind and title, the
  state pill in the Decide cell),
- the whole-row door writing `?approval=<key>&approvalKind=<kind>` with
  `shallowPush` (§ 22 _THE ADDRESS_), so the room stays mounted under the overlay
  and closing returns to the same page of it.

**A pending row opens the overlay exactly as the tab's row does. A decided row
opens it too** (§ 22 Panels 8a–8b draw the decided states). **Nothing in this room
decides**: the only verb on any row is the tab's _Review_ door. See _What this
asset does NOT decide_ for the address caveat on decided rows.

### What this room ADDS to the row — three elements, each justified

| addition                       | where                                                                                                                                                                                | what it reads                                                                                                                                                                                                                       | why the tab does not have it                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · the PERSON column**      | view A only, a fifth grid column inserted before the Decide cell, header **Decided by** in the Decided section and **Asked of** in the Awaiting section (`zh` _决定人_ / _请谁处理_) | Decided: `decidedByLabel`, which survives the decider's deletion (schema prose on `ApprovalGate`), never a join on the nullable FK. Awaiting: `routedToId`'s display name, or _No one_ / _无人_ when the gate was routed to nobody. | In view B every decided row was decided by the reader and every pending row is routed to them, so the column would repeat their own name on every row. **It is a CONDITIONAL ELEMENT OF ONE ROW, keyed on the DTO's `fullView` flag, not a second row.** |
| **2 · the DECIDED time**       | Decided section, the third column, header **Decided** (`zh` _决定时间_), in place of _Waited_                                                                                        | `decidedAt`, relative in the cell and ABSOLUTE in its `title`, the same recipe as the tab's `waitingSince` cell                                                                                                                     | A queue measures how long a thing has waited. A record measures when it was settled.                                                                                                                                                                     |
| **3 · the VERSION decided on** | Decided section, the subject cell's meta line, replacing _N files · &lt;current sha&gt;_ with **on `&lt;version&gt;`** (`zh` _基于 `&lt;version&gt;`_)                               | `subjectVersion`, the ADR's field that carries the whole claim                                                                                                                                                                      | A decided row that does not say WHICH bytes were approved is a list entry, not a record. The tab's meta reads the subject's CURRENT sha, which is wrong for a decision made against an earlier one.                                                      |

**How a long opaque version renders:** the first **8 characters** in
`font-mono text-xs`, the same slice `ApprovalsList` already applies to
`commitSha`. The **full value** goes in the element's `title`, so it can be read
and selected without widening the row. A null `subjectVersion` (a decision older
than the audit columns) renders the shipped `workbench.approvals.noVersion`
string, _no version_ / _无版本号_. It never renders blank.

### The grid — the tab's, plus one column in view A

| view | template                                                                                      |
| ---- | --------------------------------------------------------------------------------------------- |
| B    | `minmax(10rem,1fr) 268px 88px 132px`, **byte-identical to `ApprovalsList`'s `GRID_TEMPLATE`** |
| A    | `minmax(10rem,1fr) 228px 88px 144px 132px`                                                    |

At the stated viewport the content column is 896px (864 inside the list's 16px
side padding). **View A narrows the work-item track from 268px to 228px, and that
is the one track this room changes.** With the tab's 268px, the added person
column left the subject cell 168px wide, and a decided row's version truncated to
_on b33…_. That would hide the one field that makes the row a record. The first
local render showed it. At 228px, view A's fixed tracks and four 16px gaps take
656px, which leaves **208px for the subject cell**. That fits _Design result · on
b33c4e45_ whole. The work-item title truncates earlier, with its key still whole,
and the title stays one click away. A person name longer than 144px truncates,
with the full label in `title`.

**The section heading band** sits inside the same card as a `role="rowgroup"`
header row. It uses the shipped column-header recipe (`h-10`,
`bg-(--el-surface-soft)`, `text-[11px] font-semibold tracking-wider uppercase
text-(--el-text-secondary)`), and its FIRST cell carries the section title and
its total in the shipped count chip (`bg-(--el-count-bg)` /
`text-(--el-count-text)`). So the two sections are two header rows in one table,
not two tables. The column labels ride in the same band.

## The ENTRANCE — a primary project row, after _Reports_

**Drawn in Panel C, in place among the twelve shipped rows** (`SidebarNav.tsx`
`primaryItems`: Workbench, Issues, Ready, Runs, Boards, Roadmap, Plans, Backlog,
Dashboard, Triage, Reports, Code).

| decision     | value                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **label**    | _Approval records_ / _审批记录_. The same string is the page heading and the palette entry, all read from one catalog key.                                                                                                                                                                                                      |
| **glyph**    | lucide **`Stamp`**: the mark put on a thing that has been decided. It is unused anywhere in `app/`, `components/` or `lib/`. `Inbox` is Triage's and the To-approve tab's, `ClipboardCheck` is the `review` work type's, and `ShieldCheck` is the settings Approvals row's. Reusing any of them would point at another surface. |
| **position** | **13th, directly after _Reports_ and before _Code_.**                                                                                                                                                                                                                                                                           |
| **badge**    | **None.**                                                                                                                                                                                                                                                                                                                       |
| **gating**   | `browse-only` in `PROJECT_NAV_ACCESS`. Every reader of the project has records of their own, and `approval:view_any` WIDENS the room rather than opening it, so gating the row on the key would hide a reader's own decisions from them.                                                                                        |

**Why after Reports.** Placement is an argument. Beside the Workbench the row
would read as a second queue, and the Workbench's _To approve_ tab already is that
queue. Down by _Reports_ it reads as what it is: a record you consult when you
need to know what was decided, not a list you work through.

**Why no badge.** `countAwaitingMe` already feeds the Workbench strip's _To
approve_ count. A second number over nearly the same question, computed over a
slightly different set (view A counts other people's gates too), is two counts
that disagree with a delay.

**The command palette** offers the same destination because `AppCommandPalette`
reads the same `PROJECT_NAV_ACCESS` map the rail reads. It is not drawn
separately: registering the row in the map is the whole of its design.

## Narrow (`< md`) — Panel E, in `zh`

The row takes § 20's narrow reflow unchanged: two stacked lines (_subject + time_,
then _work item_), and the Decide cell below. The column-header band is dropped,
as § 20 drops it. **The section header row survives as a heading line**, because
it names a section rather than a column. **View A's person element joins the
second line** after the work item, prefixed _决定人_ / _请谁处理_ (en: _Decided by_ /
_Asked of_), so the value is never an unlabelled name.

## Measurements — viewport 1200 × 900, light, `data-style` default

Measured in Chromium on a local render of the mock (Panel A's frame). The render
is not committed.

| element                                     | measure                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| rail                                        | 240px wide. Rows `h-(--height-control)` at `gap-0.5`, the shipped `Sidebar`'s own |
| content column                              | 896px (1200 − 240 − 2 × 32 gutter)                                                |
| page heading block                          | serif `text-2xl` title + `text-sm` subtitle, 20px gap to the list                 |
| section header row                          | 40px                                                                              |
| data row                                    | 44px (the tab's)                                                                  |
| pager band                                  | 41px (the shipped `IssueListPager`, single-page state)                            |
| subject cell width, view A / view B         | 208px / 328px                                                                     |
| person column (view A)                      | 144px                                                                             |
| Panel A: 3 pending + 5 decided rows + pager | the list runs y 108 → 582 of the content box, above the 900 fold                  |
| narrow (388px, `zh`)                        | a pending row 105px, a decided row 94–95px, section header 40px                   |

## Token map — this room's own elements

Everything the row uses is § 20's token map (with its 2026-09-11 amendment: a
settled row's ink is `--el-text-secondary`). This room adds:

| element                  | colour                                                                                                   | shape                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| section header row       | `--el-surface-soft` fill, `--el-border` rule, `--el-text-secondary` labels                               | `h-10`, inside the list's `--radius-card` |
| section title            | `--el-text`, `text-[11px] font-semibold uppercase`                                                       | —                                         |
| section total chip       | `--el-count-bg` / `--el-count-text`                                                                      | `--radius-badge` · `--spacing-chip-x`     |
| person cell              | `--el-text-secondary`                                                                                    | `text-xs`, truncates                      |
| version (`on 9840d00e`)  | `--el-text-secondary`, `font-mono`                                                                       | `text-xs`                                 |
| section empty line       | `--el-text-secondary`                                                                                    | `text-sm`, `px-4 py-3`                    |
| room empty state         | `--el-text` title, `--el-text-subtitle` body, `--el-icon-muted` `Stamp` glyph (the primitive's own inks) | the `EmptyState` primitive's own box      |
| rail row glyph (`Stamp`) | the rail's own row ink                                                                                   | the rail row's `h-4 w-4`                  |

No raw hex, no private colour alias and no raw shape utility anywhere in the
asset.

## What this asset does NOT decide

- **The read's shape, its pagination arithmetic, or its permission mechanics.**
  MOTIR-5301 owns those. This asset states what the page NEEDS (below) and
  nothing about how it is computed.
- **The overlay's address.** § 22 addresses a gate by (work item, kind) and opens
  the LATEST gate for that pair. So a decided row whose work item has since been
  asked the same kind of question again opens that newer question. **The ROW
  itself is the record** (who, when, which version), so nothing about the record
  depends on what the door opens. Addressing a historical gate by id would be an
  amendment to § 22, not something this room draws.
- **The To-approve tab, its predicate, badge, pager or empty state.** Unchanged.
- **The role editor.** `approval:view_any`'s label and description are
  MOTIR-5305's copy, and the switch appears there once the key is enforced.
- **Filtering, search, export or a kind facet.** Out of the story.
- **The `zh` catalogue.** Every string here is a DRAFT for MOTIR-5302's catalog
  entry.

## GIVES / TAKES — every card this asset names

| card                                              | GIVES                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | TAKES                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **MOTIR-5302** (the room + its door)              | The route's layout, both views, the name and every string (en + zh drafts), the three row additions, the grid templates, the section header row, the three empty states, the rail row (label, `Stamp` glyph, position after Reports, no badge, `browse-only`), narrow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Nothing. It builds what is drawn here and owns the catalog. |
| **MOTIR-5301** (the read)                         | **REQUIREMENTS on its DTO, stated here so it does not choose them:** (1) **two sections, in this order**, named in the DTO as **`awaiting`** then **`decided`**; (2) `awaiting` holds `state = awaiting` sorted **`createdAt asc, id asc`**; `decided` holds `state IN (approved, changes_requested)` sorted **`decidedAt desc, id desc`**; (3) **`superseded` is in NEITHER section, in either view**; (4) a **total per section** and one window over the concatenation; (5) a **`fullView` boolean** the surface reads for copy and for the person column, never as an input; (6) per row, beyond `ApprovalQueueRowDto`: `decidedAt`, `subjectVersion`, `decidedByLabel` (decided rows) and the routed-to display name (awaiting rows, view A). | Nothing it does not already own.                            |
| **MOTIR-5305** (the permission)                   | The panel labels: the room follows `approval:view_any`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Nothing. Its copy renders in the role editor, not here.     |
| **MOTIR-5303 / MOTIR-5304** (the tests)           | The two views, the three empty states and the "a decided record is still there afterwards" moment they assert against.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Nothing.                                                    |
| **MOTIR-5299** (the story)                        | Its open words (the decided heading, `superseded`'s fate) settled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Nothing.                                                    |
| **MOTIR-5214 / MOTIR-5222** (the overlay)         | Nothing. Its door is composed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Nothing.                                                    |
| **MOTIR-4879 / MOTIR-5147** (the tab and its row) | Nothing. The row is composed, and the tab is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Nothing.                                                    |
| **MOTIR-5292** (the decide-any key)               | Nothing. Whether a pending row in view A carries _Review_ follows the row's existing `canDecide`, which that key already decides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Nothing.                                                    |

## Context refs

- `design/workbench/design-notes.md` § 20 and § 22 · `design/workbench/approvals-row.mock.html` · `design/workbench/approval-overlay.mock.html`
- `app/(authed)/workbench/_components/ApprovalsList.tsx`: the row this composes, its grid, its settled branch
- `app/(authed)/_components/SidebarNav.tsx`: the twelve project rows · `lib/settings/projectNavAccess.ts`: the one map
- `lib/repositories/approvalGateRepository.ts`: `findAwaitingRoutedTo`'s `createdAt asc`
- `prisma/schema.prisma`, `model ApprovalGate`: the audit set, `decidedByLabel`, `subjectVersion`
- `lib/settings/projectSettingsNav.ts`: the settings Approvals row this room is named apart from

## The REVIEW PATH in the Approvals room — the approval-record line (2026-11-04)

**AMENDS** `design/approvals/approvals-room.mock.html` **without editing it**. A decided approve-and-merge record carries one `--el-text-secondary` line under its sentence saying how its commits were reviewed: _reviewed by agent at {commits}_, _review skipped by {who}_, _review dismissed by {who}_ or _not reviewed by an agent_. It is drawn in `design/workbench/approvals-row--review-path.mock.html` Panel A3, over the shipped records list; the copy keys are in `design/github/design-notes.md` § 32.9 and § 32.10.
