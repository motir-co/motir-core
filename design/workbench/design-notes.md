# Workbench — design notes

Design reference for the `workbench` UI area — **`/workbench`, the signed-in
landing surface** (Story [MOTIR-4777](motir:cmtqhxi4v000uhvphhq0lndce), drawn by
the MOTIR-4779 design gate). It is the layout source of truth for **MOTIR-4782**
(the page) and **MOTIR-4783** (the sweep), and both carry it in `blocked_by`.

**AMENDED by MOTIR-4851** (Story
[MOTIR-4850](motir:cmtrqmg1o001yhwphuhguhxni)) with the two things the first
revision handed forward: **how the surface PAGES** and **how its work tabs are
ORDERED**. Both were in § _What this asset does NOT decide_; both are now drawn,
and that section no longer carries them. It is the layout source of truth for
**MOTIR-4852** (the reads) and **MOTIR-4853** (the page), which carry it in
`blocked_by`.

**AMENDED by MOTIR-5216** (Story
[MOTIR-5213](motir:cmtxm4uzd00ebhztxrhk7nfo3), 2026-09-13): **the strip is
RE-ORDERED** so To approve leads, and **the landing CASCADES** — the bare
`/workbench` resolves to the first of To approve · In progress · To do with
anything in it. Every tab becomes addressable and the bare path stops being one
of their addresses. § _21 · AMENDED by MOTIR-5216_ is the record; the sections
it changes carry a pointer to it. It is the layout source of truth for
**MOTIR-5217** (the order), **MOTIR-5218** (the addresses) and **MOTIR-5221**
(the resolver), which carry it in `blocked_by`.

| Surface                               | Asset                                          | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `/workbench` landing page**     | **`workbench.mock.html`** (HTML mockup)        | The whole surface, multi-panel: the door · To do · In progress · Recently finished · Watching grouped · the all-empty page · every tab's empty state · narrow · **the pager, in five states**. Exports to `workbench.png`.                                                                                                                                        |
| **The `To approve` tab's ROW** (§ 20) | **`approvals-row.mock.html`** (HTML mockup)    | The row and every state it can be in. **Its disclosure is superseded by the overlay below** (§ 20's dated amendment). Exports to `approvals-row.png`.                                                                                                                                                                                                             |
| **The approval OVERLAY** (§ 22)       | **`approval-overlay.mock.html`** (HTML mockup) | An approval decided full screen over the tab, the frame edge to edge under the exit row: anatomy · a taller-than-the-screen subject and a short screen · see-but-not-decide · unregistered kind / subject gone · not available / loading · refused in place · narrow in `zh` · every `ApprovalGateState` · the row's new door. Exports to `approval-overlay.png`. |
| **The work tabs GROUPED** (§ 36)      | **`workbench--grouped.mock.html`** (delta)     | To do, In progress and Recently finished drawn under their runnable container: the group row with its count and chevron, member head vs context head, standalone rows, the pager over rows, live holds, narrow, dark, zh. No export (AMENDMENT 4).                                                                                                                |

**Panels:** A the door · **B the landing cascade** · 1 To do · 2 In progress · 3 Recently finished ·
4 Watching, grouped · 5 the all-empty page · 6 every tab's empty state ·
7 narrow (`< md`) · **8 a paged tab, and the kind order** · **9 a single-page
tab** · **10 an empty tab, with no pager** · **11 Watching over an offset page
(+ 11b a page inside one band)** · **12 the pager at narrow, and in `zh`**.
**There is no no-project panel** — see below.

---

## ⚠️ THIS AREA WAS `design/home/` — the rename, and what carried across

**`design/home/` no longer exists.** The area, the mock and the export are
RENAMED — `home.mock.html` → `workbench.mock.html`, `home.png` →
`workbench.png` — and every panel of the old asset is carried across rather than
redrawn. The surface is the same surface; what changed is its NAME, its ADDRESS
and the shape of its one list.

Leaving an asset folder called `home` under a surface called Workbench is the
same drift [MOTIR-3171](motir:cmt0obeog002yi2ph44d93i6a) and
[MOTIR-3173](motir:cmt0p18t800m9i2php78xgcwn) were filed for, one layer down: a
reader navigates the design tree by area name exactly as they navigate the app
by route, and a folder that still says `home` sends the next person to an asset
they will think is stale.

**Panel-by-panel carry-over, so nothing is lost in the move:**

| old                   | new                           | what happened                                                                                                   |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A the door            | **A the door**                | Rail row relabelled and re-addressed; the 308 added; the glyph decision recorded (below).                       |
| 1 populated (My work) | **1 To do**                   | Same frame, same row, same columns — the rows are now the `todo`-category slice.                                |
| —                     | **2 In progress**             | NEW tab. Same frame; the rows are the `in_progress` category, including Implemented and In Review.              |
| —                     | **3 Recently finished**       | NEW tab, and a dataset this surface has never shown. Fifth column, window caption, `Done` and `Cancelled` rows. |
| 2 Watching            | **4 Watching, grouped**       | Same membership, same rows; the two GROUPS and their band are new.                                              |
| 3 the all-empty page  | **5 the all-empty page**      | Five tabs to be empty in; the both-zero count suppression is unchanged and now suppresses five.                 |
| 4 both empty states   | **6 every tab's empty state** | Two became five.                                                                                                |
| 5 narrow              | **7 narrow**                  | The row collapse is unchanged; the STRIP now scrolls (measured, below).                                         |
| 6 no active project   | **REMOVED**                   | The Workbench has no no-project state, and the panel drew a defect rather than a design — see below.            |

---

## What the surface is, and why it splits

A signed-in member opens Motir to answer **"what am I doing, and what have I
just done?"**. The shipped `/home` answered half of it: one list — assignee OR
reporter, deduped, active-project-scoped — plus Watching. This asset splits that
one list along the axis a person actually works on: **lifecycle**.

**And it splits on `workflow_status.CATEGORY`, never on a status KEY.** A
project defines its own statuses as `workflow_status` rows, so a tab keyed on
`'in_review'` is a tab that empties the day somebody renames a column. The
default workflow's four `in_progress`-category statuses — In Progress, Planning,
Implemented, In Review — all land in one tab, which is the point: two of them are
where an agent leaves work for a person.

| tab                   | predicate                                          | default workflow                                      |
| --------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| **To do**             | not `in_progress`-category and not `done`-category | `To Do`, `Blocked`                                    |
| **In progress**       | `category = 'in_progress'`                         | `In Progress`, `Planning`, `Implemented`, `In Review` |
| **Recently finished** | `category = 'done'` **and** finished ≤ 7 days      | `Done`, `Cancelled`                                   |
| **Watching**          | unchanged membership; ORDERED (below)              | —                                                     |
| **To approve**        | **not drawn here** — the SLOT only                 | —                                                     |

**⚠️ To do is written as a COMPLEMENT, and that is a drawn decision rather than
an implementation detail.** Three `IN` predicates are total only if every
`work_item.status` in the database names a live `workflow_status` row of its
project — a property of the DATA, not of the query. A legacy key, a column
deleted around the reassign path, or the schema's own vestigial `"open"` default
would then appear in NO tab at all: invisible on the one surface that exists to
say what is on you. The complement is total by construction, and it is also
where the shipped list put such a row, so nothing a reader can see today
disappears. [MOTIR-4781](motir:cmtqhxicf000yhvph5zbmqllq) implements it and
asserts it.

---

## The tab strip — five slots, drawn as ONE composition

The shipped link-based Segmented (`PublicTabNav`'s markup), unchanged in
grammar: an `--el-tabnav-track` track at `--radius-btn` with a `p-0.5` inset;
each tab an `<a>` at `--height-control`, `--radius-control`,
`--spacing-control-x`, `text-[12.5px] font-medium`. The active tab takes
`--el-page-bg` + `--shadow-subtle` + `--el-text-strong` and its glyph
`--el-tabnav-active`; an inactive one `--el-text-secondary` with an
`--el-text-faint` glyph.

**RE-DRAWN by MOTIR-5216** — the order and the addresses below are the amended
ones; § _21_ carries the reasoning.

| tab                   | glyph (lucide) | href                                                  |
| --------------------- | -------------- | ----------------------------------------------------- |
| **To approve**        | `Inbox`        | `/workbench?tab=approvals`                            |
| **In progress**       | `CircleDot`    | `/workbench?tab=in-progress`                          |
| **To do**             | `Circle`       | **`/workbench?tab=todo`**                             |
| **Recently finished** | `CircleCheck`  | `/workbench?tab=finished`                             |
| **Watching**          | `Star`         | `/workbench?tab=watching`                             |
| _the bare path_       | —              | **`/workbench` — a RESOLVER: forwards, names no tab** |

**⚠️ THE LABEL IS AN ACTION AND THE SLUG IS A SET, and the mismatch is
deliberate.** The tab says **To approve** because that is what it asks of the
reader — the other four name a state a card is IN, and this one names something
the reader must DO, which is the whole reason it sits apart from them. Its URL
stays `?tab=approvals` because a slug names the SET, which is also why _Recently
finished_ is addressed as `?tab=finished`: an address is a noun a person pastes
and a label is what they read on the strip, and neither owes the other a
transliteration.

- **The selection is a URL, not component state** — `aria-current="page"` on the
  active one. A reload stays on the tab and the tab is linkable; that is also
  why the link form was chosen over the client `Segmented`. ~~**To do is the
  DEFAULT and is therefore spelled as the ABSENCE of the param**, so a link to
  the Workbench and a link to To do are the same link (the shipped
  `lib/workbench/tab.ts` rule, carried).~~ **REPLACED by MOTIR-5216:** there is
  no default tab. The one-canonical-URL-per-tab rule is kept by making it TOTAL
  — every tab carries a `?tab=`, and `/workbench` resolves (§ _21_).
- **Counts** ride each tab as the shipped board count badge
  (`--el-count-bg` / `--el-count-text`, `--radius-badge`,
  `h-[18px] min-w-[20px] text-[11px] font-semibold`).
- **Every count is suppressed when they are ALL zero** (Panel 5) — a row of
  five `0`s is five numbers a brand-new user has to read and discard. A zero
  beside a non-zero sibling is KEPT, because there it is information. The rule
  is the shipped one and it now suppresses five instead of two.
- **The To-approve count is drawn as `0`**, which is what this story ships: the
  tab's rows, the gate records behind them and the approve/confirm control are
  [MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc)'s and are drawn in that story's
  own design amendment. Drawing the whole strip once — rather than four tabs now
  and a fifth bolted on later — is what keeps it looking like one decision.

**Measured on this mock**, because a five-tab strip is the one thing the split
could plausibly break:

| band                          | content box | tab track needed | verdict                       |
| ----------------------------- | ----------- | ---------------- | ----------------------------- |
| 1200 viewport (rail 240)      | 894px       | **662px**        | fits, with 232px to spare     |
| all-empty (counts suppressed) | 894px       | **502px**        | fits                          |
| narrow `< md` (420 viewport)  | 386px       | **662px**        | **does not fit — it scrolls** |

The strip is `inline-flex` inside a flex column, so it stretches to the content
box and the tabs sit left. That is the SHIPPED behaviour, not a change: the
two-tab strip measured the same 894px with 249px of tabs in it. The split
narrows the empty track from 645px to 232px, which reads better rather than
worse.

### ⚠️ Narrow: the strip SCROLLS — it does not shrink and it does not wrap

At `< md` the content box is 386px and five tabs are 662px. The old two-tab
strip was 249px and fitted, so this is the one place the split changes the
narrow band's answer.

- **Shrinking** would truncate the labels, and the labels are the entire reason
  a reader knows which tab to switch to.
- **Wrapping** puts a second control row above a list whose rows are already two
  lines each — the tallest possible chrome on the shortest possible viewport.
- **Scrolling** keeps every tab reachable at full label, is the mobile
  convention, and the browser scrolls the active tab into view on load.

**MOTIR-5216 re-ordered the tabs and this verdict is UNCHANGED** — the same five
labels at the same type scale are still **662px** of track against a **386px**
content box, and an order cannot move either number. What does change: under the
cascade the landed-on tab is always one of the FIRST THREE, so the common case
needs little or no scroll to show it (§ _21_).

Implementation: `max-w-full overflow-x-auto` on the `<nav>` and `shrink-0` on
each tab. Both are ordinary Tailwind utilities; the mock declares them in its own
`<style>` block because its stylesheet is a frozen compile of the file as it was
before this revision used them, and the note on that block says so.

---

## Recently finished — the tab this surface has never had

`/home` excludes done work outright, and that was the right fix at the time:
[MOTIR-2758](motir:cmspdgjag006zi2ph3oj14n6l) was filed on a page whose own copy
said _"waiting on you"_ while it was 87% finished items. Hiding it entirely,
though, means the surface never tells you what you accomplished — and in a
product where agents do the work, this is the only place a person sees their own
week.

**Three things this tab draws that no other tab needs:**

1. **The window CAPTION**, immediately under the strip and above the list:
   _"Finished in the last 7 days. Older work stays on the item, and on the
   board."_ `text-xs` in `--el-text-secondary`. A bounded list that does not say
   what bounds it reads as a list that is missing things. The second sentence is
   there because the first raises the question it answers.
2. **A fifth column, `Finished`** — 96px, `text-xs` in `--el-text-secondary`,
   relative (`Yesterday`, `2 days ago`). The row already carries the value
   ([MOTIR-4780](motir:cmtqhxiaj000xhvphl9q2hijk) stores it and
   MOTIR-4781 puts it on the DTO), so rendering it costs no read. Column set:
   `Title (minmax(10rem,1fr)) · Your role (96) · Assignee (140) · Status (108) ·
Finished (96)` → **minimum 734px**, inside the 894px content box at 1200.
3. **`Cancelled` drawn beside `Done`.** Both are `done`-category and both land
   here, and they must not look alike: `Done` takes the `--el-tint-mint` Pill,
   `Cancelled` takes the neutral `--el-chip-bg` one. Cancelled is a `done`
   status that means ABANDONED, not accomplished — the same discrimination
   `applyStatusTransition`'s provenance stamp and `roadmapDoneStatusKeys`
   already make — so giving it the accomplishment tint would be a false claim in
   a colour.

**Ordering:** `completedAt DESC`. Not `updatedAt` — that is the whole reason
MOTIR-4780 exists, and a list ordered by last-touch would put a re-titled June
card above a card finished yesterday.

---

## Watching — an ORDER, not a filter

Membership is untouched: the same rows the tab returns today, and an item the
reader both owns and watches is still returned by both this tab and a work tab.
What is new is that every `in_progress`-category row sits ahead of every
`todo`-category one, so what is moving is above what is waiting.

**The separator is the COLUMN-HEADER BAND's grammar, with one label and a
count** — 30px against the header's 40px, `--el-surface-soft`,
`border-b --el-border`, an 11px uppercase `--el-text-secondary` label, and the
same count badge the tabs use.

- **Why a band and not a rule or a spacer.** The surface already has exactly one
  structural band, so reusing it is what makes a reader read this as STRUCTURE.
  A bare rule reads as a heavier row divider; a spacer says nothing about what
  changed.
- **Why it does not read as a second set of column labels**, which is the risk
  of sitting directly under the first: it carries ONE left-aligned label rather
  than four aligned to the columns, and it carries a COUNT — a column header
  never counts anything.
- **The labels are the tabs' own words** — `In progress`, `To do` — so a reader
  who has just switched from those tabs meets the same vocabulary.

**Groups, not a sort key — the group is the OUTER key and the kind order runs
INSIDE it.** ~~The rows within each group keep the existing
`(updatedAt DESC, id DESC)` order, which is what lets the page boundary stay
exact; MOTIR-4781 carries the group in the cursor for the same reason.~~
**AMENDED (MOTIR-4851).** The struck sentence was right about the SHAPE and is
superseded on the sort key and on the mechanism: within each group the rows now
order by the kind rank (§The ORDER below), and the page boundary is kept exact
by a total tiebreak rather than by a cursor, because the cursor is retired
(MOTIR-4852). The band structure is unchanged — Panel 11 draws it over an offset
page, including the two arrangements the keyset could never produce.

---

## The ORDER — `READY_KIND_RANK`, and the SAME constant rather than a second copy

**The three work tabs — To do, In progress, Watching — order by KIND:**
`subtask → bug → task → story → epic`. **Recently finished is untouched** and
keeps `completedAt DESC`, because _what did I just finish_ IS a time question.

**Why kind and not time.** `updatedAt DESC` answers _what did I touch last_,
which is a question nobody opens this page with. The question they do open it
with is _what do I pick up next_, and the product already knows the answer:
`/ready` orders by `READY_KIND_RANK`, most granular first, coarsening to
containers last, because the most granular work is the work you can actually
start. It matters more here than anywhere else precisely because agents fill
this surface — a reader looking at sixty rows is looking at a queue their agents
built, and the rows that can be started ought to be the rows they see.

**Drawn, not described: Panel 8's twenty-five rows are in that sequence** —
eleven subtasks, three bugs, five tasks, five stories, one epic — so the
`IssueTypeIcon` column reads as a sorted run. Panel 11 draws the same run
INSIDE each of Watching's two bands.

**The rank is read from `lib/workItems/readyFilter.ts`, not re-declared.** Two
lists that both claim to be "in ready order" and derive it separately will
disagree eventually, and quietly: nothing errors, one page just puts an epic
above a subtask. MOTIR-4852 imports the constant and spends a guard on the
agreement; this asset records that as a drawn property of the surface rather
than an implementation detail, because "the same order as Ready" is something a
reader can see and check.

**Nothing about the ROW changes** — the same four columns, the same cells, the
same 44px. Only the sequence.

### ⚠️ The rows in this asset CAUGHT UP with the shipped component in the same pass

Drawing a sorted-by-kind run made two drifts load-bearing that had been merely
untidy, so they are fixed here, in this file, with the evidence:

| what                                 | the asset had       | the shipped `WorkbenchList` / `IssueTypeIcon` renders                                        |
| ------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| the **task** glyph (5 rows)          | lucide `circle-dot` | lucide `square-check-big` (`ISSUE_TYPE_META.task.icon`)                                      |
| the **bug** glyph (4 rows)           | lucide `circle-dot` | lucide `bug` (`ISSUE_TYPE_META.bug.icon`)                                                    |
| the row **identifier** ink (19 rows) | `--el-text-muted`   | `--el-text-secondary` — muted is 4.17:1 on `--el-surface`, which is the row's own hover fill |
| the **Unassigned** ink (2 rows)      | `--el-text-muted`   | `--el-text-secondary`, for the same pair                                                     |

The glyph pair is the one that could not be left: with task and bug drawn as the
same circle, a run ordered `subtask → bug → task → …` is invisible as a run, and
Panel 8 exists to make it visible. `git grep -c 'lucide-circle-dot text-(--el-type-'`
returned **9, all of them in this file** — every other asset in the tree already
drew the shipped glyphs, so this was a local staleness rather than a convention.

---

## The pager — the shipped control, COMPOSED and not re-specified

**The control has an owner, and it is not this asset.**
`design/work-items/list.mock.html` **panel 5** + `design/work-items/design-notes.md`
§ _server-paged navigator_ draw the `Showing X–Y of N` range line, the prev
chevron, the numbered buttons with ellipsis truncation and the next chevron, and
`app/(authed)/items/_components/IssueListPager.tsx` implements exactly that.
**This asset does not re-specify the control's internals.** What it decides is
where the control SITS on the Workbench, what it SAYS there, and the four states
the Workbench produces that `/items` does not.

**What today's surface does, and why it is being replaced.** `/workbench` pages
with a keyset cursor and two links — **Next** and **Back to the top** — sitting
OUTSIDE the bordered box. That is a one-way walk: a reader cannot see how far the
tab goes, cannot jump, and cannot step back a page except by starting over. Every
other list in Motir already solved this, so the surface a person lands on after
signing in is the one place in the product where paging is worse than everywhere
else.

### The five states, and the decision in each

| panel  | state                        | what is drawn                                                                                                                                                               |
| ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **8**  | a paged tab, at rest         | The footer is the **last row INSIDE the bordered box** (`border-t --el-border` over `--el-surface-soft`), under a full 25-row page, so the reader sees the box close on it. |
| **9**  | a set that fits one page     | The **range line stays; the page nav is absent.** A lone `[1]` is a control that cannot do anything, but "9 of 9" still answers _is this all of it?_                        |
| **10** | an empty tab                 | **No pager at all**, and no bordered box — the drawn empty state IS the card. `Showing 0–0 of 0` would say what the empty state has just said, in a quieter voice.          |
| **11** | Watching over an offset page | The band boundary INSIDE a page, and each band's count reading the **GROUP** rather than the page. Plus **11b**: a page wholly inside one group draws that band ALONE.      |
| **12** | narrow (`< md`) and `zh`     | The footer **wraps** rather than shrinking; how far depends on the run length, and the ellipsis truncation bounds it to one extra line. The same footer, rendered in 中文.  |

**The pager's `N` is the tab strip's own count.** 63 in the range line and 63 on
the strip, because they are the same predicate — a reader is never handed two
numbers to reconcile. Panel 8 draws both in one frame for exactly that reason.

**The page rides the URL beside `?tab=`, and page 1 is the ABSENCE of the
param** — ~~the same rule that makes To do the absence of `?tab=`~~ (MOTIR-5216
retired that half: every tab now carries `?tab=`; the page-1 half stands), so a
link to a tab and a link to its first page are one link.

### The copy — `en` and `zh`, named here because the control ships neither

`IssueListPager.tsx` has no `next-intl` import at all: every string below is an
English literal today, and its number formatting is pinned to `en-US`. The
Workbench is the surface that ships in both languages, so this is where they are
named. `/items` and `/items/archived` inherit them unchanged.

| element                        | `en`                             | `zh`                                   |
| ------------------------------ | -------------------------------- | -------------------------------------- |
| range line                     | `Showing {from}–{to} of {total}` | `显示第 {from}–{to} 项，共 {total} 项` |
| previous chevron, `aria-label` | `Previous page`                  | `上一页`                               |
| next chevron, `aria-label`     | `Next page`                      | `下一页`                               |
| page button, `aria-label`      | `Page {n}`                       | `第 {n} 页`                            |
| the nav's `aria-label`         | `Pagination`                     | `分页`                                 |

- **The range line's two numbers stay `<strong>` on `--el-text`** in both
  languages: they are the answer, and the words around them are the frame.
- **The numbers are formatted in the ACTIVE locale**
  (`Intl.NumberFormat(locale)`), not `en-US`. A four-figure total is the only
  place it shows, and it shows there.
- **The chevrons carry no visible text in either language**, so the
  `aria-label` is the whole of their accessible name — which is why they are
  named here rather than left to the code card.

### The ACCESS PATH is unchanged, and is already drawn

`/workbench` is the signed-in landing surface and the rail's first project-tier
row; **Panel A draws both doors** (the rail entry and `AUTHED_LANDING_PATH`) and
neither moves. The pager is a control INSIDE a page the reader is already
standing on, not a new destination, so this amendment adds no entrance and
changes none. Stating it rather than leaving it unaddressed, because "draw the
entrance" is a standing requirement and its answer here is _already drawn, in
Panel A_.

---

## Empty states — one per tab, and only two carry an action

Panel 6 draws five, all of them the shipped `EmptyState` primitive's own markup
(`h-12` glyph in `--el-icon-muted`, `text-xl` serif title in `--el-text`,
`--el-text-subtitle` body).

| tab                   | glyph         | title                               | action                                 |
| --------------------- | ------------- | ----------------------------------- | -------------------------------------- |
| **To do**             | `Circle`      | Nothing to start                    | secondary `Button` → **`/ready`**      |
| **In progress**       | `CircleDot`   | Nothing in flight                   | secondary `Button` → **the To do tab** |
| **Recently finished** | `CircleCheck` | Nothing finished this week          | **none**                               |
| **Watching**          | `Star`        | You are not watching anything       | **none** (shipped copy, unchanged)     |
| **To approve**        | `Inbox`       | Nothing is waiting on your approval | **none**                               |

**Only a tab whose emptiness a reader can DO something about carries an action**,
which is why there are two and not five. To do sends you to Ready. In progress
sends you to the To do tab rather than mounting a second Ready button beside the
first — two buttons to the same place, one screen apart, is a duplicate. Nothing
finishes work on your behalf, nothing makes you watch an item, and nothing
conjures an approval, so those three offer no button rather than inventing one.

The tab strip stays above every empty state; it is their header, which is why
none carries a card header of its own.

**MOTIR-5216 changes NONE of the five** — and the In-progress action's target is
now spelled `/workbench?tab=todo`, because To do has an address of its own. See
§ _21_ for why no To-approve door was added.

---

## Copy (en)

| element               | copy                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| rail row              | **Workbench**                                                                          |
| page `h1`             | **Workbench**                                                                          |
| subtitle              | **"What you are doing in {project}, and what you have just done."**                    |
| window caption        | "Finished in the last 7 days. Older work stays on the item, and on the board."         |
| tab labels            | **To approve** · In progress · To do · Recently finished · Watching (MOTIR-5216 order) |
| Watching group labels | In progress · To do                                                                    |
| **pager**             | § _The pager_ → _The copy_ above has the five strings, with their `zh` values          |

**⚠️ THE SUBTITLE DOES NOT SURVIVE, and the card asked whether it should.** The
shipped line is _"Everything in {project} that is waiting on you."_ It is false
of this surface: Recently finished is not waiting on you, and neither is half of
Watching. It is also the exact sentence MOTIR-2758 was filed against — a page
whose own copy said "waiting on you" over finished work. The replacement is the
journey question the story is built on, in the product's own words, and it is
true of every tab.

`messages/en.json` / `zh.json`: the `home.*` namespace moves to `workbench.*`
with the route (MOTIR-4782), keeping the key names so parity holds; only
`subtitle`'s value changes, plus the three new tab labels, the caption, the two
group labels and the three new empty states.

---

## Where it lives, and how it is reached

The authed route **`app/(authed)/workbench/page.tsx`** (Server Component),
rendering inside the shipped shell (`AppLayout`: top nav, the 240px rail,
`<main id="main">` with `px-4 py-6 sm:px-6 lg:px-8`). It resolves the session and
the **ACTIVE PROJECT** — `getActiveProject()`, the same resolver `/items`,
`/ready` and `/boards` use.

**Two doors, both drawn in Panel A:**

1. **The rail.** A **Workbench** entry as the **FIRST** primary nav item, above
   Dashboard, in `SidebarNav`'s existing item grammar (`--height-control` row,
   `--radius-control`, the glyph slot, `--el-sidebar-item-bg-active` +
   `--el-icon-active` when current). It is built inside `if (hasProject)`, so it
   is absent with no active project exactly as every other primary
   entry is. The `<md` drawer renders the same `SidebarNav` and inherits it.
2. **The post-auth landing.** `AUTHED_LANDING_PATH`
   (`lib/navigation/landing.ts`, [MOTIR-3373](motir:cmt3fy07s009ri2n800i46wth))
   is the single owner of "where a reader lands", with a guard that keeps route
   literals retired — so the move is ONE constant plus a 308, not a sweep.
   `?next=` still wins and the `draftId → /onboarding` branch is untouched.

**Both doors still name `/workbench`, and after MOTIR-5216 both reach a
RESOLVER** rather than a fixed tab — Panel B draws where it forwards. Neither
door moves.

**The old address still lands.** `/home` **308**s to `/workbench` with its query
string intact, so a bookmark, a pasted link and every `?tab=` URL a reader has
saved all continue to work. A 308 rather than a 302 because the move is
permanent and the method must be preserved.

### ⚠️ The rail GLYPH stays lucide `House` — a decision, not an oversight

The mirror products put a house on the signed-in landing surface (GitHub's
dashboard) because the glyph means _where you land_, and the rename does not
change that. What changed is what the surface DOES, and the label is what says
so. Swapping a rail glyph people navigate by costs recognition and buys nothing
the word "Workbench" is not already carrying.

**The halo around the entry in Panel A is review decoration** — it is not part
of the design.

---

## ⚠️ Scope — the ACTIVE PROJECT (unchanged, carried from MOTIR-2761)

**The surface reads the active project, exactly like `/items`, `/ready` and
`/boards`.** MOTIR-2649 settled the scope from external precedent — Jira Cloud
"Your work", Linear Inbox, Plane Home — and applied it one level too shallowly:
in all three products that surface sits ABOVE the project selector, so its
cross-project scope is a property of its PLACEMENT. Motir imported the scope and
then put the surface FIRST in the PROJECT tier of the rail, under a switcher the
shell renders on every authed page. [MOTIR-2761](motir:cmspdsal400hyi2ph7f3ipusv)
fixed that; nothing here re-opens it.

Three consequences, all still drawn:

1. **No `Project` column**, in any panel.
2. **The subtitle names the PROJECT**, not the workspace.
3. **There is NO no-project state**, and the panel that drew one is removed —
   see the section below. With no project there is no rail row and no Workbench;
   the reader belongs at the workspace tier.

The cross-project question — _"what is on me across this whole workspace"_ — is
retained at the workspace tier as **MOTIR-2920**; it is a different surface, not
this one. `docs/decisions/home-scope.md` is the record.

---

## ⚠️ THE WORKBENCH HAS ONE EMPTY STATE — _no work_, not _no project_

**You are always in a project.** That is the target, and it is what makes this
surface simple: the Workbench is project-tier — the rail row is built inside
`if (hasProject)`, every read is scoped to the active project — so its only empty
state is **"you have no work"**, Panel 5, the all-empty page.

### The target: there is no "Create project" screen

> **A default project is created at registration**, exactly as
> `ensureDefaultWorkspace` already does for the workspace. A newly registered
> reader lands in **`/onboarding`** — the new-project path — inside that project.
> **`getActiveProject()` never returns null**, so no surface needs a no-project
> state and no surface offers a _Create project_ screen.

The product already does this one step later: `startNewAiProjectAction`
("Plan a new project with AI") mints a project, pins it active, and only THEN
routes to `/onboarding`. The target applies the same order at registration.

**So this asset draws no no-project panel.** The earlier revision drew one,
carried across from `design/home/`, and it conflated two states:

| state                          | tier      | whose                                     |
| ------------------------------ | --------- | ----------------------------------------- |
| no work items                  | project   | **the Workbench's** — Panel 5             |
| zero projects in the workspace | workspace | nobody's — the target does not produce it |

### What ships today, and why it is a defect

Traced, because it decides how big the fix is:

- **Nothing seeds a default project.** `ensureDefaultWorkspace` self-heals the
  WORKSPACE; there is no project equivalent in `lib/` or `app/`. A fresh account
  has a workspace and zero projects.
- **Sign-up lands on `AUTHED_LANDING_PATH`** — this surface — so a brand-new
  reader arrives at a project-tier route with no project.
- **`/home` and `/dashboard` then render `ProjectsEmptyState`**, a _Create
  project_ screen, inside project chrome. `/ready`, `/plans`, `/roadmap`,
  `/backlog` and `settings/project/*` answer the same question with an actionless
  `noProject` notice.
- **`/onboarding` cannot absorb it either**: its entrance dead-ends for a
  projectless reader (`app/(onboarding)/onboarding/page.tsx` renders an actionless
  `noProject` EmptyState) because it expects a project to already exist.

`docs/decisions/home-scope.md` §2.2 decided that door, and its reasoning holds
**under the name and the premise it reasoned about** — a reader who is LANDED on
a route should not be stranded, and a projectless state was taken as a given.
Creating the project at registration removes the premise. §2.3 rests on §2.2, so
the two move together.

**This asset does not fix that and does not draw around it** — the fix spans
registration, the landing, a family of routes and a decision record, so it is
filed as its own card. What the asset does is stop presenting the defect as the
design.

### What MOTIR-4782 builds

- **No no-project panel**, because the Workbench has no such state.
- **It must not render `ProjectsEmptyState`** — a checkable criterion: no
  project-tier route renders a _Create project_ screen.
- **It does not seed the default project or move the landing.** That is the filed
  card's, because it also settles `/dashboard`, the notice family and the record.
  Until it lands, MOTIR-4782 keeps the shipped branch rather than inventing one.

---

## ⚠️ What is NOT on this page

Carried from the 2026-08-11 revision (Yue), unchanged. An earlier revision drew
four surfaces; two were removed and stay removed:

- **Needs you** — a second mount of the notification stream. Removed as a
  **duplicate**: the bell drawer is already the notification surface, it is on
  every page, and it carries the unread badge. If notifications ever outgrow a
  drawer, that is a change to the drawer.
- **Quick links** — user-pinned shortcuts. Removed with MOTIR-2652, which is
  archived. It was the only part of the story that needed a table, bought for
  shortcuts to pages the nav already reaches.

**And the To-approve tab's ROWS.** This asset draws the slot, the label, the
count and the empty state; the rows, the gate records behind them and the
approve/confirm control belong to
[MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc).

---

## The asset is the app's own markup, not a redraw

Every element on this page already ships. Rather than re-draw them, the mock was
composed from the **real components' own emitted markup**, dumped through the
repo's vitest + RTL setup (`renderWithIntl(<Component/>)` →
`container.innerHTML`) and pasted in verbatim:

| Element                                   | Dumped from                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| the work-item row + its cells             | `app/(authed)/items/_components/IssueListTable.tsx` (via `issueColumns`) |
| the sidebar rail                          | `app/(authed)/_components/SidebarNav.tsx`                                |
| `EmptyState` · `Card` · `Button` · `Pill` | `@motir/design-system` (the `components/ui/*` shims)                     |
| the tab strip                             | `app/(public)/_components/PublicTabNav.tsx` (the link-based Segmented)   |

The stylesheet inlined in the mock is **Tailwind's real output for that file**,
compiled from `app/globals.css`'s own `@import 'tailwindcss'` +
`@motir/design-system/theme.css` — so the token layer is the shipped one
byte-for-byte, not a hand-copied block.

**Everything this revision adds COMPOSES that same markup.** The five-tab strip
is the shipped Segmented with three more tabs; the Watching group band is the
column-header band with one label and a count; the Finished cell is the row's own
`text-xs` secondary cell; every empty state is the `EmptyState` primitive. No new
primitive, and no new token.

**And so does MOTIR-4851's.** Panels 8–12's footer is `IssueListPager`'s own
emitted markup — its container, its `PG_BTN` class string, its two lucide
chevrons and its `aria` attributes, verbatim — so the asset cannot drift from
the control it composes. Eight of its utility classes, plus
`text-(--el-type-epic)` (the mock drew no epic row until Panel 8), are declared
in the mock's own `<style>` block for the same reason the two narrow-strip
utilities below them are: the stylesheet above is a frozen Tailwind compile of
this file as it stood BEFORE the revision, and it cannot contain a class the
file did not yet use. They are written exactly as Tailwind emits them.

---

## Layout — one column, and the column set is the real decision

With no widgets, "where do the widgets go" is not a question this asset has to
answer. What it does have to answer, and what MOTIR-4782 must not re-decide, is
**which columns the row carries**.

### Measurements (taken in Chromium against this mock, not asserted)

The shipped `/items` row is a nine-column grid whose minimum width is **1204px**.
Content available to a page in the shell is `viewport − 240 (rail) − 64
(lg:px-8)`:

| viewport | content available | shipped 9-col row (needs 1204) |
| -------- | ----------------- | ------------------------------ |
| 1200     | **896**           | ✗ clips                        |
| 1280     | **976**           | ✗ clips                        |
| 1440     | 1136              | ✗ clips                        |

So this surface cannot render the full `/items` column set at any common laptop
width. (Nor can `/items` — that is the known MOTIR-1307 clipping; the Workbench
must not inherit it.)

**The column set — the same cells, a Workbench-specific set:**

```
Title (minmax(10rem,1fr)) · Your role (96) · Assignee (140) · Status (108)
```

→ minimum **622px**; measured title track **440px** at the 1200 viewport, 520 at
1280, 680 at 1440. Rows stay the shipped 44px. **Recently finished adds
`Finished (96)`** → minimum 734px, which still fits at 1200.

**What was dropped, and why.** `Reporter` (on a list defined by _you are the
assignee or the reporter_, a Reporter column answers a question the list has
already answered — "Your role" carries it), `Est.`, `Points`, and the trailing
row-actions `⋯` (the whole-row link + the `?peek=` quick view are the two
affordances this surface needs; bulk actions belong on `/items`).

---

## The one cell that only exists here

### `Your role` — "Assigned" · "Reported" · "Both" (and "Watching" on the Watching tab)

Plain `text-xs` in `--el-text-secondary`; the **`Both`** value takes
`--el-text-strong` + `font-medium` as a non-colour cue (finding #35 — never
colour alone).

This cell exists because assigned and reported are **merged into one membership
predicate**. That merge is what creates the dedupe requirement, and this is the
only place a human can see it hold — a row reading `Both` appears **once**. It is
partially derivable from Assignee (a row assigned to someone else is one you
reported), but a column that is usually derivable and never wrong is cheaper to
read than a rule the reader has to apply per row.

On the **Watching** tab the same cell distinguishes watch-only (`Watching`) from
watch-and-own (`Both`), which is why an item can legitimately appear in both a
work tab and Watching. Watching is a different audience, not a partition.

---

## The agent state — a row-level state, never a section

An item with `executor: coding_agent` renders **like any other row**. There is no
agent section, no agent widget and no agent tab anywhere in this asset; the human
assignee still answers for the item, so it belongs in that human's list.

**How the row shows it:** the assignee's avatar carries a **glyph badge** — the
same avatar-with-badge composition the shipped `NotificationRow` uses, with
lucide **`Bot`**, the glyph the shipped `ExecutorIndicator` already uses for
`executor: coding_agent`. The badge is `aria-hidden`; an `sr-only` span carries
the meaning.

**`--el-executor-agent`** is the Tier-3 token it paints with, added beside the
`--el-notif-*` set by MOTIR-2653 and unchanged here.

---

## Token map

| Element                            | Colour                                                                                                                                                        | Shape                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| page `h1` / subtitle               | `--el-text` / `--el-text-muted`                                                                                                                               | —                                                                                              |
| tab track / active tab / inactive  | `--el-tabnav-track` · `--el-page-bg` + `--el-text-strong` · `--el-text-secondary`                                                                             | `--radius-btn` (track) · `--radius-control` (tab) · `--height-control` · `--spacing-control-x` |
| tab glyph active / inactive        | `--el-tabnav-active` / `--el-text-faint`                                                                                                                      | —                                                                                              |
| tab count badge                    | `--el-count-bg` / `--el-count-text`                                                                                                                           | `--radius-badge` · `--spacing-chip-x`                                                          |
| **window caption**                 | **`--el-text-secondary`**                                                                                                                                     | `text-xs`                                                                                      |
| list container                     | `--el-border`                                                                                                                                                 | `--radius-card`                                                                                |
| column header strip                | `--el-surface-soft` / `--el-text-secondary`                                                                                                                   | 40px                                                                                           |
| **Watching group band**            | **`--el-surface-soft` / `--el-text-secondary`**, count on `--el-count-bg` / `--el-count-text`                                                                 | **30px** · `--radius-badge` (count)                                                            |
| row · row hover                    | `--el-border` (rule) · `--el-surface` (hover)                                                                                                                 | 44px · `pl-4 pr-7` · `gap-x-4`                                                                 |
| type glyph                         | `--el-type-{epic,story,task,bug,subtask}`                                                                                                                     | `h-4 w-4`                                                                                      |
| identifier                         | `--el-text-muted`, `font-mono text-xs`                                                                                                                        | —                                                                                              |
| title                              | `--el-text`                                                                                                                                                   | truncate                                                                                       |
| Your role · `Both`                 | `--el-text-secondary` · `--el-text-strong` + `font-medium`                                                                                                    | `text-xs`                                                                                      |
| **`Finished` cell**                | **`--el-text-secondary`**                                                                                                                                     | `text-xs` · 96px                                                                               |
| avatar                             | `bg-(--el-text)` / `--el-text-inverted`                                                                                                                       | `rounded-full` 22px                                                                            |
| agent badge                        | `--el-executor-agent` / `--el-accent-text`, `ring-(--el-page-bg)`                                                                                             | `rounded-full` 14px                                                                            |
| status chip                        | `Pill` tones — `--el-tint-sky` (in-progress category), **`--el-tint-mint` (Done)**, **`--el-chip-bg` (To Do, Blocked, Cancelled)**, all on `--el-text-strong` | `--radius-badge`                                                                               |
| unassigned                         | `--el-text-muted`                                                                                                                                             | —                                                                                              |
| empty-state glyph / title / body   | `--el-icon-muted` · `--el-text` (serif) · `--el-text-subtitle`                                                                                                | `--radius-card` · `--spacing-card-padding`                                                     |
| rail Workbench entry (active)      | `--el-sidebar-item-bg-active` · `--el-text` · `--el-icon-active`                                                                                              | `--radius-control` · `--height-control`                                                        |
| **pager footer bar**               | **`--el-surface-soft`**, top rule `--el-border`                                                                                                               | `px-3.5 py-2.5` (layout, not a control's own box)                                              |
| **pager range line · its numbers** | **`--el-text-secondary`** · `--el-text` (`font-semibold`)                                                                                                     | `text-[13px]`                                                                                  |
| **page button (rest)**             | **`--el-page-bg`** / `--el-text`, border `--el-border`, hover `--el-surface`                                                                                  | `--radius-control` · `--height-control` · `--spacing-control-x` · `min-w-(--height-control)`   |
| **page button (current)**          | **`--el-accent`** / `--el-accent-text`, `border-transparent`                                                                                                  | same                                                                                           |
| **prev / next chevron**            | glyph `--el-text-muted`; **disabled**: `--el-text-faint` at `opacity-55`                                                                                      | same                                                                                           |
| **the ellipsis**                   | **`--el-text-faint`**, `aria-hidden`                                                                                                                          | `min-w-6` · `text-[13px]`                                                                      |

**No new token.** Every element above paints with a token the design system
already ships, the pager included — it is the shipped control's own token set,
composed rather than re-chosen.

**AA on the pager, checked against the CLAUDE.md contrast table.** The footer's
ground is `--el-surface-soft`, where `--el-text-muted` is **4.34:1 and fails** —
which is why the range line is `--el-text-secondary` (6.51:1) and not muted, and
why the shipped component's own comment says so. `--el-text-faint` appears in
exactly two places and clears AA on neither surface, so both are exempt by
kind rather than by measurement: the **ellipsis** is `aria-hidden` decoration,
and the **disabled chevron's** glyph is disabled text, which 1.4.3 does not
measure — the button carries `disabled` and `aria-disabled="true"`, which is
what makes that legitimate rather than merely convenient. The current page is
**not colour alone**: it is also the only filled, borderless button in the run,
and it carries `aria-current="page"`.

**AA:** `--el-text-faint` appears only on `aria-hidden` glyphs.
`--el-text-muted` appears only on the white page/card surface, never on
`--el-surface` / `--el-muted` (the `CLAUDE.md` contrast table) — which is why the
window caption and the `Finished` cell take `--el-text-secondary` and not
`--el-text-muted`: the caption sits on the page ground but the cell sits inside a
row whose hover state is `--el-surface`, and `--el-text-secondary` is 6.18–6.80:1
on all four surfaces in both themes.

---

## What this asset does NOT decide

- **The To-approve tab's rows, its gate records and its approve/confirm control**
  — [MOTIR-4778](motir:cmtqhxi7r000vhvphp60vjymc). Only the slot is drawn here.
- ~~**Ordering within each work tab.** MOTIR-4781 owns it and specifies
  `updatedAt DESC` with a total, stable tiebreak (and `completedAt DESC` for
  Recently finished); nothing here overrides that.~~ **DECIDED by MOTIR-4851** —
  § _The ORDER_ above. The three work tabs read `READY_KIND_RANK`; Recently
  finished keeps `completedAt DESC`, which was never the deferred half.
- ~~**The paging affordance** — the mock shows one page. MOTIR-4781's reads are
  cursor-paged and hand back an opaque `nextCursor`; MOTIR-4782 picks the control
  (the shipped `IssueListPager` is the obvious reuse) and keeps the cursor in the
  URL beside `?tab=`.~~ **DECIDED by MOTIR-4851** — § _The pager_ above, Panels
  8–12. The obvious reuse was the right one; what this asset adds is where it
  SITS, what it says, and the four states nobody had asked for.

  **Both lines are struck rather than deleted, and that is the convention this
  file already uses** (§Watching, §PR-title). A deferral that simply vanishes
  reads as though nobody ever raised the question; a struck one tells the next
  reader that it WAS raised, and where it was answered.

- **The page SIZE.** `HOME_PAGE_SIZE = 25` is drawn as a constant in every
  panel. Whether a reader may choose it — the `/items` list does not offer that
  either — is not a question this asset raises.
- **The finished window's LENGTH as a setting.** Seven days is drawn and is a
  constant; whether it should ever be configurable is not a question this asset
  raises.
- **The cross-project "my work" surface** — retained at the workspace tier as
  MOTIR-2920. It will have its own design area.

---

## GIVES / TAKES — every card this asset names

| card                                                     | GIVES                                                                                                                                                               | TAKES                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-4782** (the page)                                | The five-tab strip as one composition, every tab's empty state, the window caption, the Watching group band, the copy, the narrow scroll, the rail row and the 308. | Nothing. It draws no element this asset leaves unspecified, and it does not own the To-approve rows.                                 |
| **MOTIR-4783** (the sweep)                               | The area's new name and address, so `design/home/` is a hit its sweep must find nowhere.                                                                            | Nothing — but note that the two design-guard REGISTRIES key on the old paths and are re-keyed by THIS card's diff, not by the sweep. |
| **MOTIR-4781** (the reads)                               | The `Finished` column and the group order as things a reader SEES, so the DTO field and the cursor group are not speculative.                                       | Nothing. Its category predicate is unchanged by anything drawn here.                                                                 |
| **MOTIR-4780** (`completedAt`)                           | The window caption is the user-facing statement of what that column is for.                                                                                         | Nothing.                                                                                                                             |
| **MOTIR-4778** (the sibling story)                       | The To-approve SLOT — its position in the strip, its label, its glyph, its count treatment and its empty state.                                                     | **Its own design amendment no longer draws the strip.** The strip is composed once, here; that story draws the ROWS inside the slot. |
| **MOTIR-2649 / 2653 / 2654 / 2761 / 2758 / 2652 / 2920** | Nothing — they are `done` or archived and are not touched.                                                                                                          | Nothing.                                                                                                                             |
| **MOTIR-3373** (`AUTHED_LANDING_PATH`)                   | Nothing.                                                                                                                                                            | Nothing — the rename is one write to the constant it already owns, which is why the move is not a sweep.                             |

### The MOTIR-4851 revision's own sweep

**Scope of the sweep, stated because it is a judgement:** every `MOTIR-<n>` in
the NOTES, plus every one in the mock's own **annotation prose** (its
review-head, panel labels, `.note` blocks and captions). The mock's SAMPLE ROW
DATA is deliberately excluded — those keys are drawn content standing in for a
reader's list, not references to cards this asset allocates work to, and a
GIVES / TAKES line for each would be sixty rows of noise around the seven that
mean something. The sweep also ran over MOTIR-4850's whole SUBTREE rather than
only over the keys the asset happens to name.

| card                                                     | GIVES                                                                                                                                                                                                                                                                                                                                                                                              | TAKES                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-4852** (the reads)                               | The ORDER as a drawn fact — `subtask → bug → task → story → epic` on the three work tabs, `completedAt DESC` untouched on Recently finished — and the requirement that Watching's GROUP is the outer key across a page boundary, which is why it is ONE ordered read rather than two. Also the pager's denominator: `N` is the tab strip's own count, so the list and the total are one predicate. | **Nothing structural, and one PREMISE it should read:** its disposition table retires the cursor module, and Panel 11's band-boundary arrangement is the thing that table's replacement has to keep producing. Nothing here re-opens the category predicate, the window or `HOME_PAGE_SIZE`. |
| **MOTIR-4853** (the page)                                | All five panels and every string: the footer INSIDE the box, the single-page and empty states, the two Watching arrangements, the narrow wrap, and the `en` + `zh` values for all five pager strings, so the card transcribes rather than invents.                                                                                                                                                 | **Nothing.** It draws no element this asset leaves unspecified, and the access path it renders is the one Panel A already draws.                                                                                                                                                             |
| **MOTIR-4854** (the vitest gate)                         | Nothing it can assert against a mock. The kind-order run and the band counts are what its integration seams are seams BETWEEN.                                                                                                                                                                                                                                                                     | Nothing.                                                                                                                                                                                                                                                                                     |
| **MOTIR-4855** (the E2E + acceptance video)              | The states the walk checks against — the footer, the disabled prev on page 1, the single-page and empty arms, and the Chinese strings its `zh` step reads.                                                                                                                                                                                                                                         | Nothing.                                                                                                                                                                                                                                                                                     |
| **MOTIR-4850** (the story)                               | Its own acceptance criteria, drawn.                                                                                                                                                                                                                                                                                                                                                                | Nothing.                                                                                                                                                                                                                                                                                     |
| **MOTIR-4781 / 4782** (`done`)                           | Nothing. This revision REPLACES two behaviours they delivered — `updatedAt DESC` and the keyset links — going forward; it does not re-open either card.                                                                                                                                                                                                                                            | Nothing. Their work shipped and is correct as shipped.                                                                                                                                                                                                                                       |
| **MOTIR-4778 / 4794** (the sibling story)                | Nothing new. The To-approve SLOT is still drawn once, here, and its rows are still that story's.                                                                                                                                                                                                                                                                                                   | Nothing — but note that the tab **inherits this pager for free** the moment MOTIR-4794 renders rows into the shared list. That is a fact about composition, not a deliverable of either card.                                                                                                |
| **the `design/work-items/` asset**                       | Nothing. It OWNS the control; this asset composes it and cites it.                                                                                                                                                                                                                                                                                                                                 | **A dependency worth naming:** if panel 5's navigator is ever re-specified, these five panels are downstream of it and are not a second opinion about it.                                                                                                                                    |
| **MOTIR-1307 / 2651 / 3171 / 3173 / 4779 / 4780 / 4783** | Nothing — named in prose as history or as context, not allocated work by this revision.                                                                                                                                                                                                                                                                                                            | Nothing.                                                                                                                                                                                                                                                                                     |

---

## ⚠️ Planning flags — surfaced by this pass, owned by no card in MOTIR-4777

1. **Two design-guard registries key on `design/home/*` paths.**
   `tests/design-asset-addresses.test.ts` carries two exemption entries keyed
   on the old mock and the old notes — one an address the docs surface took to
   motir-marketing, one a component that moved with it — and
   `tests/design-token-layer.test.ts` names the old mock in a synthetic
   fixture. This card's diff re-keys them, because a rename that
   leaves them behind turns the design lane red on its own pull request. Naming
   it here because MOTIR-4783's sweep would otherwise be expected to own it, and
   by then it would already have failed.
2. **A projectless reader is landed INSIDE the project-tier shell** — the
   finding this pass made, filed as its own card and NOT fixed here. Nothing
   seeds a default project, so a fresh account lands on this surface with none;
   `app/(authed)/layout.tsx` renders the shell anyway and two project-tier routes
   render a create-project door inside it. It also amends
   `docs/decisions/home-scope.md` §2.2 (which decided that door) and §2.3 (which
   rests on §2.2). **This is bigger than MOTIR-4783's sweep**, which re-addresses
   `/home` → `/workbench`: an address swap there would leave the record asserting
   a state this asset says does not exist.

3. **`design/shell/` names this asset twice, by its old path.** Its
   `design-notes.md` rail-inventory table and `rail-bottom-section.mock.html`
   both cite `design/home/home.mock.html` as context for a DIFFERENT question
   (the rail's control budget). Neither is a broken reference to this surface —
   they are references to a rail — but both now name a file that does not exist.
   MOTIR-4783's sweep is the right owner; it is flagged so that sweep has the
   hits enumerated.
4. **The strip stretches to the content box and the tabs sit left**, leaving
   238px of empty track at 1200. That is shipped behaviour inherited from the
   `inline-flex`-in-a-flex-column composition, and it is not this story's to
   change — but with five tabs it is now visible enough to be a question
   somebody will ask. Whether the track should hug its tabs is a change to the
   shipped Segmented, not to this surface.
5. **Nothing checks that an `--el-*` named in a design note resolves in
   `theme.css`.** This asset names no new token, so it is not exposed — but the
   check does not exist, and it is a guard-lane test rather than a design card.

---

## Context refs

- `app/(authed)/items/_components/` — `IssueListTable`, `issueColumns`,
  `issueCellPrimitives` (the row and every cell reused here).
- `app/(authed)/_components/SidebarNav.tsx` — where the Workbench entry goes,
  inside `if (hasProject)`.
- `app/(public)/_components/PublicTabNav.tsx` — the link-based tab strip.
- `lib/navigation/landing.ts` — `AUTHED_LANDING_PATH`, the one landing constant.
- `components/ui/AppLayout.tsx` · `app/(authed)/layout.tsx` — the shell geometry
  the measurements above come from (240px rail; `px-4 py-6 sm:px-6 lg:px-8`).
- `packages/design-system/theme.css` — the Tier-3 block carrying
  `--el-executor-agent`.
- `design/shell/` — the rail and the navigation grammar the access path is
  grounded in.
- `docs/decisions/home-scope.md` — why the surface is active-project scoped and
  has a no-project panel.
- `design/ready/` · `design/reports/` — the three-file convention and PNG render
  settings this asset follows.

---

## 20 · The To-approve tab's ROW — MOTIR-5147

**AMENDED by MOTIR-5147** (Story [MOTIR-4879](motir:cmtrwx30n0052hxphd0yqbnwb))
with the one element this area drew a SLOT for and deliberately left empty. It is
the layout source of truth for **MOTIR-4794** (the tab), which carries it in
`blocked_by`.

| Surface                        | Asset                                       | Notes                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The `To approve` tab's ROW** | **`approvals-row.mock.html`** (HTML mockup) | The row and every state it can be in: in situ · its anatomy · the disclosure · a treatment per `ApprovalGateState` · see-but-not-decide · refused in place · no-subject · narrow. Exports to `approvals-row.png`. |

**Panels:** 1 the tab in situ · 2 the row's anatomy · **3 the disclosure** ·
4 a row per `ApprovalGateState` · 5 see but not decide · 6 refused in place ·
7 the two rows with no subject · 8 narrow (`< md`).

> **⚠️ AMENDED 2026-09-13 by MOTIR-5222** (Story
> [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u)) — **the row no longer DISCLOSES;
> it OPENS THE APPROVAL FULL SCREEN, over the tab.** The overlay is § 22
> (`approval-overlay.mock.html`). What this amendment changes, and what it leaves
> exactly as it was:
>
> - **SUPERSEDED: _The ROW is a DISCLOSURE_ below** — its third candidate, _Open
>   in place_, and Panel 3's drawing of it. The row's whole-row control and its
>   _Review_ button now write the overlay's address instead of expanding the row,
>   and the chevron is removed (§ 22 Panel 9).
> - **Why.** This section weighed three candidates and picked the best of them. It
>   did not weigh a fourth: keep the reader on the tab and give the thing being
>   judged the screen. The frame's own standard is that you decide after you look,
>   and a 32rem sandboxed design, inside a 34rem port, inside a 44px row, under a
>   pager, is the smallest screen in the product on which to meet it. The overlay
>   meets it with the viewport, and keeps what _Open in place_ was chosen for: the
>   list is still scannable between decisions, because it is still mounted
>   underneath and closing returns to it exactly.
> - **UNTOUCHED: the _Link to the item page_ rejection.** It still stands, for the
>   reason it gives. The overlay is not that candidate — the reader never leaves
>   `/workbench`, the address only gains two parameters, and Back returns to the
>   tab rather than from a card.
> - **UNTOUCHED: _THE POST-DECISION BEHAVIOUR — SETTLED_.** A decided row keeps its
>   position, swaps its Decide cell for a state pill, the strip count decrements
>   immediately, and the row leaves on the NEXT load. Deciding inside the overlay
>   produces exactly that underneath it (§ 22 Panel 8).
> - **UNTOUCHED: every row state and its treatment** (Panels 4–8), the column set,
>   narrow and the token map — with one consequence: Panel 7's two no-subject rows
>   now open the overlay too, which draws them (§ 22 Panel 4), instead of offering
>   nothing to open.
> - **FORWARD-ONLY.** [MOTIR-4794](motir:cmtqhxiy5001hhvph7yp96e54) and
>   [MOTIR-5147](motir:cmtwycrzk002ahxtxe5j0w2q7) are `done` and are not
>   re-opened, re-scoped or amended: the disclosure shipped correct against the
>   design that was current when it shipped. MOTIR-5225 deletes it in the same pull
>   request that lands the door, so the abandoned path leaves with the migration.

### What this COMPOSES, and who owns each piece

**This asset draws the ROW and nothing else on the screen.** Two shipped assets
own the rest, and neither is re-decided here:

| piece                                                                                                                         | owner                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| the five-tab strip, the `To approve` label, its `Inbox` glyph, its count treatment, the tab's EMPTY state, the numbered pager | **`workbench.mock.html`** (this file, §§ _The tab strip_ · _The pager_ · _Empty states_) |
| the universal approval FRAME, in all nine of its states                                                                       | **`design/work-items/approval-control.mock.html`** (MOTIR-4789)                          |

The mock reproduces both from their own markup rather than redrawing them — the
strip and pager from `workbench.mock.html`, the frame from
`ApprovalGateControl`'s own emitted HTML, one dump per state. Its glyphs are
generated from the installed `lucide-react@1.16.0`'s icon nodes. The header
comment in the mock carries the full provenance.

**The tab's EMPTY state is NOT re-drawn here.** _Nothing is waiting on your
approval_ is already specified in § _Empty states_ above, with no action,
because nothing a reader can press conjures an approval. A second drawing of it
would be a second answer.

### The component contract this designed TO

**`components/approvals/ApprovalGateControl.tsx`**, and it is **PRESENTATIONAL**:
it fetches nothing, renders what it is fed, and `onDecide` resolves to a refusal
it draws IN PLACE rather than throwing. The props the row supplies:

| prop                                            | what the row supplies                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `gate`                                          | the `ApprovalGateDTO` behind the row                                                                                                     |
| `canDecide`                                     | the AUTHORITY answer — assignee, reporter when there is no assignee, or admin (ADR §2's 2026-09-11 amendment), never the routing one     |
| `kindLabel` / `subjectMeta`                     | band 1: _Design result_, and _Published 4 days ago · 3 files · `9840d00ea1b2`_ — where `subject.noteExcerpt` lands                       |
| `port`                                          | band 2, the subject RENDERED. **Its contents are the KIND's, not this asset's** — the mock draws a token stand-in, never a specification |
| `verbs` / `consequence` / `confirmConsequences` | band 3                                                                                                                                   |
| `routedToLabel`                                 | state `B`'s _waiting on_ line (Panel 5)                                                                                                  |
| `onDecide`                                      | records the decision; a `GateRefusal` comes back and the frame draws it (Panel 6)                                                        |

### WHICH FIELD each element of the row reads

Every cell names a field of `ApprovalQueueRowDto` (MOTIR-4791), so the row cannot
promise data the read has no producer for:

| element                         | field                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| kind glyph + _Design result_    | `row.kind`                                                                                              |
| _3 files · `9840d00ea1b2`_      | `row.subject.assetCount` · `row.subject.commitSha`                                                      |
| `MOTIR-5147` + title            | `row.workItem.identifier` · `row.workItem.title`                                                        |
| _4 days_                        | `row.waitingSince` (the gate's `createdAt`), relative in the cell and ABSOLUTE in its `title` attribute |
| the disclosure / the state pill | `row.state`, plus the frame's `canDecide`                                                               |

**`row.subject.noteExcerpt` is deliberately NOT on the row.** A 44px row carries
one line, better spent on which design and how long it has waited than on the
first sentence of its notes. It is the frame's `subjectMeta` when the row opens —
the same DTO, read one interaction later.

### The ROW is a DISCLOSURE — the question this card existed to answer

> **⚠️ SUPERSEDED 2026-09-13 by MOTIR-5222** — the row opens the approval full
> screen (§ 22). Kept verbatim as the record of the decision it replaces; the
> reasoning for the change is the dated amendment at the head of § 20.

**The row opens, and the shipped frame renders inside the list.** One row open at
a time; opening a second closes the first.

Three candidates were live, and two are wrong for reasons already on the record:

- **Verbs on every row** — the frame's own first cut drew the BUTTON as the
  shared element and was rejected on review: _"Approve button without review
  doesn't stand — the user needs to see what he is approving."_ A 44px row cannot
  carry a rendered design, so verbs on it would be approving something you have
  not looked at.
- **Link to the item page** — defeats the tab, whose promise is that you stop
  needing to know which card to open.
- **Open in place** — keeps the port's floor, ceiling and Expand affordance
  unchanged, and keeps the list scannable between decisions.
  `approval-control.mock.html`'s Panel 0b already drew this door with a ghost row
  labelled _"the frame renders here"_; Panel 3 is that sentence, drawn.

### ⚠️ THE POST-DECISION BEHAVIOUR — SETTLED: a decided row SETTLES IN PLACE

[MOTIR-4879](motir:cmtrwx30n0052hxphd0yqbnwb) deferred this here by name. **The
rule, in one sentence: a decided row keeps its position, swaps its Decide cell
for a state pill, and leaves on the NEXT LOAD — it never vanishes under the
cursor.**

> **⚠️ AMENDED 2026-09-17 by MOTIR-5239** (Story
> [MOTIR-5238](motir:cmtxm4x2e00fwhztxbr4hkj9s)) — **this rule SURVIVES live-ness,
> and § 26 states the rule that makes it survive: _a nudge ADDS and UPDATES; it
> never REMOVES._** A list that re-read itself on a nudge would remove a row
> somebody else had just decided, because the tab reads `state = awaiting` — which
> is this rule being overturned by a mechanism rather than by a decision. Nothing
> below changes: what § 26 adds is the HELD row, for the case this section did not
> have to consider because nothing re-read itself. See § 26 ·
> `workbench--live.mock.html`, Panel 3.

**Why.** This is a SHARED queue: routing shows a gate to one person, but ADR §2
lets an ADMIN press any gate, so a row can be decided by somebody else while you
are reading it. (Before §2's 2026-09-11 amendment the reporter of an ASSIGNED
item could press it too; narrowing that arm removed one route into this state and
not the state itself, so the rule below is unchanged.) A surface that sometimes removes a row
silently and sometimes explains one teaches the reader that **disappearance is
ambiguous**, which is the most expensive thing a queue can teach. And the frame
already refuses to vanish one interaction over — when somebody else decides
between render and press it draws the refusal IN PLACE (Panel 6) — so a list that
removed rows would contradict the panel inside it.

**What settling looks like:** the subject and work-item cells go
`--el-text-muted`, the Decide cell carries the state pill, and no verb remains —
a decided gate is immutable (ADR §6a), so there is nothing left to press. **The
strip count decrements immediately**, because the count and the list are one read
(MOTIR-4791) and the count is about what is AWAITING; the settled row is a
receipt, not a member. A reload removes it, because the read returns only
`awaiting` gates.

### Every state a row can be in

**Four are `ApprovalGateState`'s** (`prisma/schema.prisma`), so they are a
checklist rather than a judgement — Panel 4 draws one row per value:

| state               | treatment                                                           |
| ------------------- | ------------------------------------------------------------------- |
| `awaiting`          | the live row: full ink, the disclosure                              |
| `approved`          | muted ink, `--el-tint-mint` pill reading **Approved**               |
| `changes_requested` | muted ink, `--el-tint-peach` pill reading **Changes requested**     |
| `superseded`        | muted ink, **colourless** `--el-chip-bg` pill reading **Withdrawn** |

`superseded` is colourless deliberately: it is written by the PRODUCT, never by a
person, and a tinted pill would let a reader take a withdrawn question for
somebody's answer. Every pill carries its own WORD, so no state is signalled by
colour alone (finding #35).

**Three more are states of the ROW rather than of the gate**, and the mock draws
each:

- **See but not decide** (Panel 5) — the Decide cell names who it is waiting on
  and carries no verb; the frame renders its state `B`, port live and verbs
  absent. **The row still OPENS**: what is withheld is the DECISION, never the
  look.
- **Refused in place** (Panel 6) — somebody else decided between render and
  press. The frame's own refusal, naming who, with an unattributed arm for a
  decider whose account has gone.
- **Unregistered kind** (Panel 7) — `lib/approvalGates/registry.ts` registers
  `design_result` alone and names three declared holes. The row takes the
  colourless `circle-dashed` glyph, says **Not built yet** in words, NAMES the
  kind, and offers no disclosure because there is nothing behind it to open.

**And a FOURTH row state this asset adds, because the read can produce it:** a
gate whose **subject no longer resolves** (Panel 7, row two). A handler's
`resolveSubject` is documented to return null, so `ApprovalQueueRowDto.subject`
is nullable. _This build cannot render this kind_ and _the row this gate points
at is gone_ look alike and are opposite — the first is a feature that has not
shipped, the second is a gate worth withdrawing — so collapsing them would report
a shipped kind as unbuilt. Its affordance is **Open card**, not _Review_.

### Narrow (`< md`)

The four-column grid does not survive 388px. The row becomes two stacked lines in
the same list container — _subject + waited_, then _work item_ — with the Decide
affordance full-width beneath them where a thumb reaches it; 44px → 76px. **The
column-header band is dropped rather than re-flowed**: it labels a grid that no
longer exists, and a header reading _Work item_ above something that is not a
column is worse than no header. The strip above already scrolls at this width
(§ _Narrow: the strip SCROLLS_), which is why a fifth tab costs this surface
nothing.

### Token map — the row's own elements

| Element                      | Colour                                                                     | Shape                                   |
| ---------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| kind glyph (`design_result`) | `--el-type-design` (the shipped design-type hue, `workItemTypeMeta.ts`)    | `h-4 w-4`                               |
| kind glyph (unregistered)    | `--el-text-faint`                                                          | `h-4 w-4`                               |
| kind label / subject meta    | `--el-text` / `--el-text-secondary`                                        | `text-sm` / `text-xs`                   |
| a SETTLED row's ink          | `--el-text-secondary` — see the AA note below                              | —                                       |
| work-item key / title        | `--el-text-secondary` (mono) / `--el-text`                                 | `font-mono text-xs` / `text-sm`         |
| waited                       | `--el-text-secondary`                                                      | `text-xs`                               |
| state pills                  | `--el-tint-mint` · `--el-tint-peach` · `--el-chip-bg` + `--el-chip-border` | `--radius-badge` · `--spacing-chip-x/y` |
| the disclosure               | `--el-text` on `--el-button-secondary-border`                              | `--radius-btn`                          |
| row / list container         | `--el-border`, hover `--el-surface`                                        | `--radius-card`, 44px rows              |

⚠️ **A SETTLED ROW'S INK IS `--el-text-secondary`, NOT `--el-text-muted` — AMENDED
2026-09-11 by MOTIR-4794, on the record.** The first cut of this table named
muted, and `tests/theme/inkContrastLint.test.ts` refused it on the build: muted
is **4.12–4.34:1 on `--el-surface`**, which is exactly this row's HOVER FILL, so
the ink would drop below AA in the one moment a pointer is on it. It clears AA
only on the white page/card. `WorkbenchList` records the identical pair for its
own identifier cell, which is the tell that this is a property of the SURFACE
rather than a mistake in this row. The guard caught it before a reader did, and
the asset is corrected rather than the guard exempted.

No raw hex and no raw shape utilities anywhere in the asset.

### What this asset does NOT decide

- **The tab's empty state** — § _Empty states_ above owns it.
- **The port's CONTENTS.** Band 2 renders the subject, and what a design result
  looks like inside it is MOTIR-4789's. The mock draws a token stand-in so the
  frame has something in band 2; it is not a specification.
- **A port for `decision_approval`, `pull_request_approval` or
  `pull_request_merge`** — each belongs to the story that registers that kind.
  This asset draws only the unregistered-kind row those will replace.
- **The item-page / board / list indicator** — [MOTIR-4908](motir:cmtt4ogn7000fhutx7zrhizuo).
- **The `zh` catalogue.** Every string here is a DRAFT for MOTIR-4794's catalog
  entry, not the catalog.

### GIVES / TAKES — every card this asset names

Scope, as § _The MOTIR-4851 revision's own sweep_ sets it: every `MOTIR-<n>` in
these notes plus the mock's annotation prose. The mock's SAMPLE ROW DATA is
excluded — those keys stand in for a reader's list.

| card                                        | GIVES                                                                                                                                                        | TAKES                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **MOTIR-4794** (the tab)                    | The row, its cells, the disclosure, a treatment per state, the settled post-decision rule, and the narrow reflow — so none of it is decided at the keyboard. | Nothing. It builds what is drawn here and owns the `en` + `zh` catalog, which this asset only drafts.      |
| **MOTIR-4791** (the read)                   | A drawn consumer for every field of `ApprovalQueueRowDto`, and the confirmation that `noteExcerpt` has a home (the frame) rather than a row cell.            | Nothing. Its predicate, its paging and its DTO are unchanged by anything drawn here.                       |
| **MOTIR-4879** (the story)                  | **The deferred post-decision decision, SETTLED** — the one thing it named as owed to this card.                                                              | Nothing.                                                                                                   |
| **MOTIR-4777 / MOTIR-4851** (the Workbench) | Nothing. Their slot, strip, empty state and pager are composed exactly as drawn.                                                                             | Nothing — and the boundary they stated four times is honoured: this asset draws the rows and not the slot. |
| **MOTIR-4789** (the frame)                  | Nothing it does not already own. Its Panel 0b's ghost row _"the frame renders here"_ is now a drawing.                                                       | Nothing. Band 2's contents stay its own.                                                                   |
| **MOTIR-4786 / MOTIR-4911** (the ADR)       | Nothing. Routing and authority are read from the record, not re-decided.                                                                                     | Nothing.                                                                                                   |
| **MOTIR-4907 / 4909 / 4910 / 4882**         | The not-built-yet ROW each of them replaces when it registers its kind — so a fourth kind is a renderer rather than a layout question.                       | Nothing.                                                                                                   |
| **MOTIR-4908 / MOTIR-4949 / MOTIR-2920**    | Nothing — named only as boundaries this asset does not cross.                                                                                                | Nothing.                                                                                                   |
| **MOTIR-5008**                              | Nothing — cited for its LESSON (a hand-typed sprite is a wrong glyph waiting for a reader who trusts its name), which is why every glyph here is generated.  | Nothing.                                                                                                   |

---

## 21 · AMENDED by MOTIR-5216 — the strip RE-ORDERED, and the landing CASCADES

**AMENDED 2026-09-13 by MOTIR-5216** (Story
[MOTIR-5213](motir:cmtxm4uzd00ebhztxrhk7nfo3)). Two things change about this
surface and nothing else: **which tab a reader lands on, and in what order the
tabs sit.** No tab's content, row, column, pager, empty state or count treatment
changes. The asset is revised in place — `workbench.mock.html` re-drawn and
`workbench.png` re-exported — because the strip is ONE composition and a second
drawing of it would be a second answer.

### The strip ORDER

**To approve · In progress · To do · Recently finished · Watching**, each tab's
glyph travelling with it (`Inbox` · `CircleDot` · `Circle` · `CircleCheck` ·
`Star`). § _The tab strip_'s table is re-drawn in that order. Every panel that
draws the strip draws it in this order — panels 1–5, 7, 8 and the new panel B in
`workbench.mock.html`, **and** the eight in situ strips in
`approvals-row.mock.html`, whose rows (§ 20) are untouched: the strip there is
composed from this asset, and leaving it in the old order would put two answers
to one composition in the same folder.

**The strip order and the cascade order are deliberately the SAME order** — the
first three tabs are the three rungs, left to right. So the strip reads as an
explanation of where the reader just landed, rather than as a menu to search.

### THE LANDING CASCADE — a RESOLUTION, not a default (Panel B)

> **`/workbench` with no `?tab=` resolves to: To approve** if its count is
> non-zero → **else In progress** if its count is non-zero → **else To do.**

Four properties, stated once so MOTIR-5217, MOTIR-5218 and MOTIR-5221 do not each
decide them:

1. **Three tabs only.** Recently finished and Watching are NEVER landed on.
2. **To do is TERMINAL** — landed on even when its own count is 0. The cascade
   always resolves; there is no fourth outcome and no blank page.
3. **An explicit `?tab=` ALWAYS wins.** `?tab=approvals` renders To approve at 0,
   with its empty state, because the reader asked. An unknown, misspelled or
   hand-edited value is not an explicit choice: it falls into the cascade rather
   than 404-ing (the shipped land-rather-than-404 rule, re-pointed).
4. **The only input is the five counts the strip already reads**
   (`HomeTabCountsDto`). The cascade asks no new question of the data.

**How the bare path forwards — a redirect, or rendering in place — is
MOTIR-5221's to implement.** The asset owes the RULE and draws the bare path as
an entrance whose address bar ends on the resolved `?tab=`; it does not pick the
mechanism.

### EVERY TAB IS ADDRESSABLE, and `/workbench` is not one of the addresses

| tab               | its one address                                        |
| ----------------- | ------------------------------------------------------ |
| To approve        | `/workbench?tab=approvals`                             |
| In progress       | `/workbench?tab=in-progress`                           |
| To do             | **`/workbench?tab=todo`** (new)                        |
| Recently finished | `/workbench?tab=finished`                              |
| Watching          | `/workbench?tab=watching`                              |
| _the bare path_   | `/workbench` — **resolves and forwards; names no tab** |

**This REPLACES the paramless-default convention; it does not bend it.** The
shipped rule is _one canonical URL per tab_, implemented by spelling the default
tab as the absence of `?tab=`. That implementation assumed the default was fixed.
Under a cascade the paramless address names a different tab for different
readers on different days — one spelling naming many views, which is the
ambiguity the rule exists to forbid, arriving from the other direction. So the
rule is kept by making it TOTAL: every tab carries its own `?tab=`, no tab has two
spellings, and the special case is gone. `?page=` is unaffected — page 1 is
still the absence of that param.

### Panel 5 is now the cascade's TERMINAL — the verdict

Panel 5 drew the all-empty page as a rare state a new reader found by looking.
After this change it is **exactly what a brand-new member is landed on,
immediately after sign-in, on the To do tab**: every count is 0, rungs 1 and 2
fall through, and rung 3 is terminal.

**Verdict: To do's shipped empty state STANDS as the landing.** It is the one
empty state of the five that carries a way forward (_Find something to start_ →
`/ready`), which is the best thing a first screen with nothing on it can offer.
The count suppression stands too: five `0`s on a first screen are still five
numbers to discard.

**The panel is REDRAWN, and that is a correction to the drawing, not a change to
the state.** It drew _"Nothing is waiting on you"_ under a `CircleCheck` glyph — a
pre-split empty that no tab renders, and the very phrase MOTIR-2758 was filed
against. It now draws what `EmptyTab` renders for To do on `origin/main`: the
`Circle` glyph, _Nothing to start_, the shipped body and the `/ready` action. In
the same pass the body lines of Panel 6's To do, In progress, Recently finished
and To approve empty states were brought into agreement with the shipped
`workbench.empty.*` catalog they had drifted from. Titles, glyphs and actions
were already correct; no state gains or loses anything.

### The five EMPTY STATES are UNCHANGED — and the To-approve door is DROPPED

An earlier cut of this work drew **a door from the To-approve empty state to To
do**, because landing on _"Nothing is waiting on your approval"_ with nowhere to
go is a dead end. **The cascade removes that dead end at the root, so the door is
not drawn.** A reader now reaches an empty To approve only by asking for it, and
§ _Empty states_' decision — three of the five carry no action, _"because nothing
a reader can press conjures an approval"_ — stands untouched. Verified on
`origin/main`: `EmptyTab` gives To do a `/ready` link and In progress a To-do
link, and the other three nothing. Named here so the next reader does not read
the absence as an oversight.

### Narrow (`< md`) — unchanged

§ _Narrow: the strip SCROLLS_ measured a **386px** content box against **662px**
of track. A re-order moves neither number, so the scroll verdict stands. The one
thing that changes: the landed-on tab is always among the first three, so the
browser rarely has to scroll it into view.

### COMPOSITION boundary — what this amendment does not redraw

- **Panel A owns the ACCESS PATH.** The rail row and `AUTHED_LANDING_PATH` still
  name `/workbench`; they now reach a resolver rather than a fixed tab. Composed,
  not redrawn.
- **§ 20 owns the To-approve ROWS** (`approvals-row.mock.html`). Its strip is
  re-ordered; its rows, disclosure and states are not touched, and neither is the
  disclosure-vs-overlay question, which is MOTIR-5214's own amendment.
- **`design/work-items/approval-control.mock.html` owns the FRAME.** Not this
  area's; not touched.
- **Every tab's CONTENT** — columns, the `< md` row collapse, the Watching bands,
  the Finished column and caption, the pager and its five states — composed
  unchanged.

### GIVES / TAKES — every card this amendment names

Scope as § _The MOTIR-4851 revision's own sweep_ sets it: every `MOTIR-<n>` this
section and the mock's new annotation prose name, plus MOTIR-5213's whole subtree.

| card                                  | GIVES                                                                                                                                                      | TAKES                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **MOTIR-5217** (the order)            | The ORDER and the per-tab glyph assignment — nothing else. It changes no address and no landing.                                                           | Nothing.                                                                                                    |
| **MOTIR-5218** (the addresses)        | The six-row address table: all five `?tab=` spellings including `todo`, and the statement that `/workbench` is no longer a tab address.                    | Nothing.                                                                                                    |
| **MOTIR-5221** (the resolver)         | The cascade's ORDER, its THREE-tab scope, its TERMINAL, the explicit-`?tab=`-wins rule and unknown-value-falls-in — the rule, stated once.                 | **The mechanism is its own** — redirect or render in place. The asset draws where the reader ends, not how. |
| **MOTIR-5219** (the vitest gate)      | The invariants a percentage cannot see: one address per tab, none for the bare path, and a cascade total over every count combination.                     | Nothing.                                                                                                    |
| **MOTIR-5220** (the E2E + video)      | The walk: land on To approve, then In progress, then To do; ask for an empty tab by address. Panel B's five frames are its five beats.                     | Nothing.                                                                                                    |
| **MOTIR-5213** (the story)            | Its acceptance criteria, drawn.                                                                                                                            | Nothing.                                                                                                    |
| **MOTIR-4879 / MOTIR-4794** (the tab) | Nothing new. The To-approve COUNT the cascade's first rung reads is theirs, as shipped.                                                                    | **Nothing from § 20's row decision** — the rows, the disclosure and every state are composed as drawn.      |
| **MOTIR-5214** (decide full screen)   | Nothing. What a row does when pressed is its own; this amendment is correct whether a row opens in place or full screen.                                   | Nothing.                                                                                                    |
| **MOTIR-4777 / MOTIR-4851** (`done`)  | Nothing. The strip, empty states and pager they drew are composed; the paramless-default convention they carried is REPLACED going forward, not re-opened. | Nothing.                                                                                                    |
| **MOTIR-2758**                        | Nothing — cited for the phrase Panel 5's old drawing repeated.                                                                                             | Nothing.                                                                                                    |
| **MOTIR-4908 / MOTIR-5238**           | Nothing — boundaries this amendment does not cross (the pending indicator; the live strip).                                                                | Nothing.                                                                                                    |

---

## 22 · The approval OVERLAY — MOTIR-5222

**AMENDED by MOTIR-5222** (Story [MOTIR-5214](motir:cmtxm4v3600edhztx2s78ff0u))
with the surface § 20's row now opens: **an approval decided full screen, over the
page you are on**. It is the layout source of truth for **MOTIR-5224** (the overlay
host) and **MOTIR-5225** (the row door), which carry it in `blocked_by`, and the
container **MOTIR-5382** draws its approve-to-merge port into.

**REVISED 2026-09-13 on review (PR #2864):** the cutaway panel is gone (a full-size
dialog hides the tab entirely, so drawing it behind the scrim faked a view nobody
gets); **the overlay IS the container**, so the frame's bands run edge to edge under
the exit row with no gutter, no centred column and no card chrome; and **"Design
result" appears once**, in band 1. Panels renumbered accordingly.

| Surface                  | Asset                                          | Notes                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The approval OVERLAY** | **`approval-overlay.mock.html`** (HTML mockup) | Anatomy · a subject taller than the screen, and a short screen · see but not decide · unregistered kind / subject gone · not available / loading · refused in place · narrow in `zh` · every `ApprovalGateState` · the row's new door. Exports to `approval-overlay.png`. |

**Panels:** 1 the anatomy · 2a a subject taller than the screen · 2b a short screen ·
3 see but not decide · 4a a kind this build cannot render · 4b a subject that no
longer resolves · 5a the address names nothing this reader may see · 5b loading ·
6 refused in place · 7 narrow (`< md`), in `zh` · 8a approved · 8b changes requested ·
8c superseded · 9 the ACCESS PATH — the row once its disclosure is gone.

### Why an overlay, and why THIS overlay

§ 20's dated amendment carries the argument: the frame asks to be decided after it
is looked at, and the viewport is the cheapest way to make the look real. What this
section adds is that **the pattern is not new** — the planning workspace
([MOTIR-4726](motir:cmtpk3r5o0097hvn8brknuwxq) / MOTIR-4729) and the run modal
([MOTIR-3893](motir:cmteb0te7001mhvn8qbialic7) / MOTIR-3895) already open something
full screen over the page you are on, addressed by the URL and closed by Back.
`components/planning/PlanningWorkspaceOverlay.tsx` wrote its reasoning down, and
this asset follows it rather than choosing again: **the open state IS the address
and is held nowhere else**, it is the shipped `Modal` rather than a hand-rolled
layer, and every close goes through one function.

**The page underneath is never left.** `Modal size="full"` portals its scrim and
panel over the Workbench; the To-approve tab — its filters, its page, its scroll and
its client islands — stays mounted behind the dialog and is **restored exactly on
close**, because nothing was unmounted. The asset does not draw that tab behind the
scrim: at full size, with no inset, none of it is visible, and a drawing that showed
it would be drawing a view nobody gets.

### What this COMPOSES, and who owns each piece

**This asset draws the CONTAINER and nothing inside the frame.** The mock is built
from emitted markup, not redrawn: every frame is `ApprovalGateControl`'s own HTML,
rendered through the repo's vitest + RTL setup inside the shipped `Modal` and dumped
from `document.body`, one dump per state; the exit row's Close control is
`PlanningWorkspaceHost`'s class for class; Panel 9's tab is `approvals-row.mock.html`'s
Panel 1 with the two row edits this section makes. The mock's header comment carries
the provenance and the fill-form edits (below).

| piece                                                                               | owner                                                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| the dialog — `Modal size="full"`, scrim, focus trap, `Esc`                          | `components/ui/Modal.tsx` over `@motir/design-system` — **composed**                               |
| the approval FRAME, its three bands, nine states, confirm band and refusal          | `design/work-items/approval-control.mock.html` (MOTIR-4789) · `ApprovalGateControl` — **composed** |
| band 2's CONTENTS                                                                   | the gate KIND's — a design result's port, and later MOTIR-5382's Development block                 |
| the settings door in band 3 (MOTIR-5176, panel `S`)                                 | the frame asset — it renders here wherever the frame renders it                                    |
| the exit row, the address, the fill form, the three frameless arms, loading, narrow | **this section**                                                                                   |
| the row's door                                                                      | **this section**, Panel 9 — built by MOTIR-5225                                                    |

### THE ADDRESS — settled here, once, because three cards read it

**Two parameters, NAMESPACED**, for the reason `lib/planning/launcher.ts`'s
`OVERLAY_PARAM_NAMES` block records in full: the overlay opens on ANY authed route,
so its query rides beside the host page's own, and the obvious names are taken —
`?peek=`, `?run=`, `?item=`, `?tab=`, `?mode=`, `?from=`, the planning overlay's
`plan*`. Measured at `origin/main` `3a5b8a7f9`: no file under `app/`, `components/`
or `lib/` reads `approval` or `approvalKind` from a query.

| parameter          | carries                                                                                                                                                                                                                                    | values                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **`approval`**     | **the presence switch AND the work item's identifier.** Its presence is what opens the overlay — one `has('approval')`, the way `?peek=<key>` and `?run=<id>` each own one word                                                            | `MOTIR-<n>`                    |
| **`approvalKind`** | **the gate kind.** Required. An absent value, or one that is not a member of `ApprovalGateKind`, opens the overlay on Panel 5a — never a guessed kind, because a work item can carry more than one gate and a guess can open the wrong one | a member of `ApprovalGateKind` |

**A gate is addressed by (work-item identifier, gate kind), not by a gate id —
because `approvalGatesService.getForWorkItem({ workItemId, kind })` is the only gate
read that ships.** `lib/services/approvalGatesService.ts` has `getForWorkItem`,
`getAwaitingForWorkItem`, `listAwaitingMe`, `countAwaitingMe` and `decide`, and the
repository underneath reads `findLatestByWorkItem(workItemId, kind)`; there is no
read by id. The pair also means an address survives a republish: a superseded gate
is replaced by a newer `awaiting` one on the same (item, kind), and the same link
opens the current question — the frame's own §6c pin keeps the decision honest about
which bytes it was.

- **Close strips exactly these two** and leaves every other parameter byte-identical,
  so _back to exactly where you were_ is true of a filtered, paged tab and not only
  of a bare route.
- **Written with `shallowPush`** — the page underneath is already in the browser
  (CLAUDE.md § _URL state the CLIENT reads_) — which leaves a history entry, which is
  what makes Back close it with no code watching.
- **Arriving COLD** (a pasted link): the host page renders first and the overlay opens
  over it, reading the query on the client and fetching its own gate over HTTP
  (MOTIR-5223). **Arriving SIGNED OUT**: the sign-in hop carries the whole address in
  `next=`, overlay query included.
- **The code constant is the single copy in code**, beside the host (MOTIR-5224) —
  this table is the single copy in prose. Renaming one is a change to this section first.

### THE EXIT — one row, four exits, ONE close

**`hideClose` suppresses the dialog's corner ✕.** The overlay carries its own exit
row, top-LEFT, exactly as the planning workspace does: two Closes in one dialog is a
question nobody should be asked, and the product already taught this one.

| exit             | what it is                                                   |
| ---------------- | ------------------------------------------------------------ |
| **Close**        | the control top-LEFT, with its `Esc` chip                    |
| **`Esc`**        | the DIALOG's handler (Radix)                                 |
| **the scrim**    | at full size the panel covers it; the path exists for parity |
| **browser Back** | a `popstate` whose query no longer carries `approval`        |

**All four land on ONE `requestClose()`**, which strips the two parameters with
`shallowPush` — so a later guard has one seam to intercept, as MOTIR-4731's
close-with-pending guard does on the planning overlay. **This overlay has nothing to
guard today**: a half-made decision is not state — the confirm band is one press from
nothing, and a refusal is already recorded server-side. **`Esc` while the confirm band
is open closes the overlay**, like any other `Esc`: the band is inline, not a dialog,
and there is no second key handler to arbitrate. **Focus returns to the element that
opened it** — the row, or its _Review_ button — recorded when the address changed,
because a door that writes a URL is not Radix's `Trigger`.

**The exit row names the WORK ITEM, not the kind**: _Close_ and its chip, then the
item's key (mono) and title, then **_Open work item_** — the one way out that LEAVES
the tab, a real link to `/items/<key>`, deliberately quiet, right-aligned. **In Panel
5a the row carries no work item at all**: the key in the address is the reader's own
text, and echoing it beside a refusal reads as a confirmation.

### "Design result" appears ONCE

**The kind's label lives in band 1 and nowhere else on screen.** An earlier revision
also put the kind's glyph and label in the exit row, so the reader met _Design result_
twice in 100px. The row now carries the work item; band 1 keeps _Design result ·
version … · state pill_ **byte-identical to the frame on the item page**, which is the
point of composing it. The dialog's accessible name keeps the kind —
`approvalOverlay.dialogTitle`, _{kind} for {key}_, as the sr-only title — because a
screen reader lands in the dialog before it reaches band 1.

**Checked against the real port, not the stand-in:** `DesignResultPanel`
(`app/(authed)/items/[key]/_components/DesignResultPanel.tsx` on `origin/main`) renders
no kind heading of its own — its parts are titled _Design note_, _Design mock —
{path}_ and _Screenshot_ (`designResult.note` / `.frameTitle` / `.screenshots`). The
label's other home on the item page is the SECTION CARD around the frame
(`LateSections` → `ContentSectionCard title={designResult.title}`), which is why the
item page shows it twice and **the overlay, which has no section card, shows it once**.
No third occurrence arises, so nothing in the port needs de-duplicating.

### THE FILL FORM — the overlay IS the container

**The frame is composed; what changes is its BOX, never its contents.** Stated per
element, because the frame's port mechanics are its design and not a detail:

| element                                             | in a row (§ 20)                                  | in the overlay                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| the frame's card chrome                             | `overflow-hidden rounded-(--radius-card) border` | **REMOVED** — `flex min-h-0 flex-1 flex-col overflow-hidden`: no radius, no border; the bands run edge to edge on the dialog's `--el-page-bg`  |
| a gutter / centred column around the frame          | —                                                | **NONE** — the frame sits directly under the exit row; the dialog body is `flex min-h-0 flex-1 flex-col` and nothing else                      |
| `PORT_FLOOR` (`min-h-[12.25rem]`)                   | kept                                             | **DROPPED** — exactly as the frame's own expanded form drops it: the viewport is the box, so a floor could only push band 3 off a short screen |
| `PORT_CEILING` (`max-h-[34rem]`)                    | kept                                             | **LIFTED** — the port is `flex-1`; the remaining viewport is its ceiling                                                                       |
| the in-frame **Expand** affordance                  | offered in state `A`                             | **NOT OFFERED** — the overlay IS the expanded form; an Expand inside it would open a 90vw dialog over a 100vw one                              |
| the port box                                        | `relative min-h max-h overflow-y-auto`           | `relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4` — the component's expanded arm verbatim (`Modal.Body`'s recipe)              |
| band 1, band 3, every state, verb, confirm, refusal | the frame's                                      | **the frame's, byte-identical**                                                                                                                |

**ONE vertical scroll owner, always band 2.** The dialog is a flex column: the exit
row, then the frame at `min-h-0 flex-1`, then inside it band 1, the port at
`min-h-0 flex-1`, and band 3 — so band 3 sits on the bottom edge of the screen
whatever the subject's height and whatever the screen's. **Why the floor goes too:**
in a row the frame's height comes from its content, so a floor stops a short subject
collapsing; in the overlay the height comes from the VIEWPORT, so a floor could only
push band 3 below the panel, where `overflow-hidden` clips it. The frame's own
`expanded` arm reached the same conclusion (_"expanded, the viewport is the ceiling"_);
the fill form is that arm without its fixed wrapper and without its card.

**Measured** in Chromium against the mock (each panel's own viewport box, 1× scale):

| viewport                | exit row | band 1 | port (client / scroll) | band 3 (top–bottom) | what scrolls                        |
| ----------------------- | -------- | ------ | ---------------------- | ------------------- | ----------------------------------- |
| 1136 × 720 (Panel 1)    | 51       | 50     | 562 / 568              | 663 – 720           | the port                            |
| 1136 × 720, tall (2a)   | 51       | 50     | 562 / 3168             | 663 – 720           | the port; band 3 does not move      |
| 1136 × 360, tall (2b)   | 51       | 50     | 202 / 3168             | 303 – 360           | the port; band 3 still on the edge  |
| 1136 × 620, state B (3) | 51       | 50     | 475 / 568              | 576 – 620           | the port                            |
| 388 × 760, `zh` (7)     | 49       | 102    | 525 / 568              | 676 – 760           | the port; band 1 and the verbs wrap |

Against the previous revision's 1136 × 720 the port gains **50px** (512 → 562): the
48px of body gutter and the frame's 2px of border are band 2's now.

### The three arms that mount NO frame — and loading

**The overlay is TOTAL over `ApprovalGateKind`.** Three answers have nothing to decide
after, and for each the frame is **not mounted**: band 3 sits below the port, and a
port with nothing in it would put live verbs under nothing. Each is the shipped
`EmptyState` primitive, centred in the body with `--spacing-card-padding` around it,
under the exit row.

| arm                                      | when                                                                                                                      | what it says, and its one action                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **4a · a kind this build cannot render** | `approvalKind` is in `UNREGISTERED_GATE_KINDS`                                                                            | `CircleDashed` · _Motir cannot show this kind yet_ · names the kind · _Not built yet_ · **Open work item** |
| **4b · the subject no longer resolves**  | a registered kind whose handler's `resolveSubject` answers null                                                           | `FileX2` · _The design this asked about is gone_ · **Open work item**                                      |
| **5a · nothing this reader may see**     | the read answers 404 — no such item, another workspace, not browsable, no gate of that kind, or an invalid `approvalKind` | `Lock` · _This approval is not available_ · **Close** (primary) — no work item in the exit row             |

**4a and 4b look alike and are opposite** — § 20's Panel 7 distinction, carried up a
level: the first is a feature that has not shipped, the second is a gate worth
withdrawing. **5a is ONE answer for "does not exist" and "not yours to see"**, because
the read returns one 404 for both (MOTIR-5223's no-existence-leak contract) and a
second message would say which. **The page behind it never 404s** — there is no route
to fail.

**5b · loading**: the read has not answered. The exit row shows Close alone, and the
body draws the frame's three bands as muted blocks at their real proportions, edge to
edge like the frame they stand in for (`--el-muted`, `animate-pulse`, `aria-busy` with
_Loading the approval_), so an answer that arrives does not reflow the screen.

### After a decision — § 20's rule, unchanged, reached from a different surface

**Deciding does not close the overlay.** The frame re-renders with the decided record
the write returned (Panels 8a–8c) — the reader sees what they did on the screen they
did it on. Underneath, **in the same reconcile and with no reload**: the row settles in
place with its state pill and no verb, and the strip count is one lower. Closing then
reveals exactly that. **What reaches each surface** (CLAUDE.md § _Page state after a
mutation_):

- **the frame in the overlay** — the decided gate from the write's own response (case 1);
- **the strip count** — server-rendered, so `router.refresh()` (case 2), riding the
  decide action's own revalidation as MOTIR-5118 measured is needed;
- **the row underneath** — `ApprovalsList` is a CLIENT island whose row holds its
  decided gate in its own state (case 3): a decision made OUTSIDE that island needs an
  explicit signal the island watches. See planning flag 2.

### Narrow (`< md`)

Panel 7, drawn in `zh`. The frame is already edge to edge at every width, so narrow
changes only the exit row: the `Esc` chip is hidden (there is no key to press on a
phone), the item TITLE leaves the row, which keeps _Close_ and the key, and **_Open work
item_ becomes its icon**, with the label kept as its accessible name. Band 2 still owns
the scroll, band 1 wraps its meta line under the kind, and band 3 wraps its sentence
above the verbs — the frame already does both.

### Token map — the overlay's own elements

| Element                | Colour                                                                  | Shape                                                   |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| scrim                  | `--el-overlay-scrim`                                                    | —                                                       |
| dialog panel           | `--el-page-bg`, no border — **the ground the frame's bands sit on**     | `rounded-none` — full size overrides `--radius-modal`   |
| exit row               | `--el-surface`, bottom `--el-border-soft`                               | `px-4 py-2`                                             |
| Close · Open work item | `--el-text-secondary`; hover `--el-text` on `--el-surface-soft`         | `--radius-control` · `--spacing-control-x/y`            |
| `Esc` chip             | `--el-text-secondary`, border `--el-border`                             | `--radius-kbd` · `--spacing-kbd-x/y`                    |
| exit-row key · title   | `--el-text-secondary` (mono; 6.24:1 on `--el-surface`) · `--el-text`    | `text-xs` · `text-sm`                                   |
| frame, fill form       | none of its own — no border, no radius, no fill; bands keep their rules | edge to edge                                            |
| frameless arms         | `EmptyState`: `--el-icon-muted` · `--el-text` · `--el-text-subtitle`    | `Card`, inset by `--spacing-card-padding`               |
| _Not built yet_        | `Pill tone="archived"`                                                  | `--radius-badge`                                        |
| skeleton blocks        | `--el-muted`                                                            | `--radius-control` · `--radius-badge` · `--radius-card` |

**Removed in this revision:** the body's `--el-surface-soft` ground and its
`px-3 py-3` / `md:px-6 md:py-6` gutter, the `max-w-[72rem]` column, the frame's
`--radius-card` + `--el-border`, and the exit row's kind glyph (`--el-type-design`) and
label. No raw hex and no raw shape utilities in the asset. The board's own chrome (the
viewport boxes and the numbered pins in Panel 1's margin) is review chrome with
`--el-text` / `--el-text-secondary` inks only.

### Copy — `en` and `zh`

Named here because no component ships them yet; MOTIR-5224 owns the catalog entry.
**Reused, not re-keyed:** `common.close`; `workbench.approvals.kind.*` (in the dialog's
accessible name and in arm 4a), `.notRenderable`, `.subjectGone`, `.notBuiltYet`; every
`approvalGate.*` string the frame already renders — including band 1's
`approvalGate.designResult.kindLabel`, the one visible _Design result_.

| key                                  | en                                                                                                                                          | zh                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `approvalOverlay.escKey`             | Esc                                                                                                                                         | Esc                                                                            |
| `approvalOverlay.dialogTitle`        | {kind} for {key} — **sr-only**, the dialog's accessible name; never rendered visibly                                                        | {key} 的{kind}                                                                 |
| `approvalOverlay.openWorkItem`       | Open work item                                                                                                                              | 打开工作项                                                                     |
| `approvalOverlay.loading`            | Loading the approval                                                                                                                        | 正在加载审批                                                                   |
| `approvalOverlay.notAvailable.title` | This approval is not available                                                                                                              | 此审批不可用                                                                   |
| `approvalOverlay.notAvailable.body`  | It may no longer exist, or you may not have access to it. The page behind this is unchanged.                                                | 它可能已不存在，或你没有访问权限。后面的页面没有变化。                         |
| `approvalOverlay.notRenderable.body` | This is a {kind} approval. It will open here once Motir can show that kind — nothing you did caused this.                                   | 这是一项{kind}审批。Motir 支持展示此类型后，它会在这里打开——这不是你造成的。   |
| `approvalOverlay.subjectGone.body`   | The design was removed after this approval was asked for, so there is nothing here to approve. Open the work item to see what it holds now. | 此设计在发起审批后被移除，这里已没有可批准的内容。打开工作项查看它现在的内容。 |

### The ACCESS PATH — the row's new door (Panel 9)

- **The chevron is removed.** It promised the row would grow, and it no longer does.
- **The whole row is the door**: a real `<a href="/items/<key>" aria-haspopup="dialog">`
  over the row, whose **plain primary click** writes the overlay address with
  `shallowPush` and whose **modified or middle click** opens the card in a new tab —
  exactly `usePeekRowClick`'s contract for `?peek=`, so the two cannot collide: the row
  writes `approval`, never `peek`.
- **The _Review_ button survives** as the labelled door a keyboard and a screen reader
  find, and opens the same address.
- **The work-item cell stays** the one link that visibly leaves, above the row on `z-10`.
- **Every row has the door**, including a settled, not-built or subject-gone row: they
  open Panels 8, 4a and 4b. The Decide cell keeps § 20's treatment per state.

### What this asset does NOT decide

- **The frame's states, verbs, confirm band or refusal** — MOTIR-4789's, composed.
- **Band 2's contents** — the kind's. The mock draws § 20's token stand-in.
- **The gate record, the decide door, routing or authority** — MOTIR-4778 / MOTIR-4786,
  as amended by MOTIR-5192 and MOTIR-5292. Read, not touched.
- **The item page's door** — [MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar), which
  composes this overlay and writes this address.
- **The pending-decision indicator** — [MOTIR-4908](motir:cmtt4ogn7000fhutx7zrhizuo).
- **The approve-to-merge port** — MOTIR-5382, which draws INTO this container.
- **The item page's own double label** (section card title + band 1) — outside this
  surface; recorded above, not changed.
- **The `zh` catalogue** — the strings above are drafts for MOTIR-5224's entry.

### GIVES / TAKES — every card this asset names

Swept over MOTIR-5214's whole subtree (5222–5227, 5382–5385) and every other key in
this section and the mock's prose, on the ELEMENT, STRUCTURE and PREMISE axes.

| card                                                                  | GIVES                                                                                                                                                                                                          | TAKES                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5214** (the story)                                            | The design half of its criteria: the address, the one close, band 2 at viewport height, totality over the kind enum, the one-answer not-available arm, narrow, `en` + `zh`.                                    | **PREMISE:** _"composes `ApprovalGateControl` unmodified"_ holds for every state, verb, band and decide path, and needs ONE presentational layout input to select the fill form — planning flag 1.                  |
| **MOTIR-5223** (the read)                                             | A drawn consumer for each distinct answer it produces: gate + subject, no subject (4b), unregistered kind (4a), 404 (5a).                                                                                      | Nothing. Its query names are its own and need not match `approval` / `approvalKind`.                                                                                                                                |
| **MOTIR-5224** (the host)                                             | The anatomy, the exit row (Close + key + title + Open work item), the two parameter names, `hideClose`, the one `requestClose()`, the chrome-less fill form, the frameless arms, loading, narrow and the copy. | **PREMISE:** the fill form is a layout input on the frame (planning flag 1). Nothing else.                                                                                                                          |
| **MOTIR-5225** (the row door)                                         | The row once its disclosure is gone (Panel 9), and the post-decision reconcile it must carry into its island.                                                                                                  | **ELEMENT:** the disclosure, the chevron and the in-list frame — already its scope to delete. **STRUCTURE:** § 20 Panel 7's no-subject rows now open the overlay rather than offering nothing. **PREMISE:** flag 2. |
| **MOTIR-5226** (the vitest gate)                                      | The seams to assert: ONE close, the frameless arms read from `UNREGISTERED_GATE_KINDS`, the fill form's scroll container, and _Design result_ rendered once.                                                   | Nothing.                                                                                                                                                                                                            |
| **MOTIR-5227** (the acceptance E2E)                                   | The walk, in `en` and `zh`, and where each assertion lands: the port, the decided record, the settled row, the count.                                                                                          | Nothing.                                                                                                                                                                                                            |
| **MOTIR-5382 / 5383 / 5384 / 5385** (approve-to-merge in the overlay) | The container — edge to edge, band 2 at viewport height — and the settings door staying in band 3.                                                                                                             | Nothing — MOTIR-5382 draws INTO this container rather than redrawing it.                                                                                                                                            |
| **MOTIR-5215** (the item page's door)                                 | The overlay it composes and the address it writes.                                                                                                                                                             | Nothing.                                                                                                                                                                                                            |
| **MOTIR-4794** (the Approvals tab) · `done`                           | Nothing.                                                                                                                                                                                                       | **ELEMENT:** the disclosure and the chevron. **Not amended**: a `done` card is immutable history, and it shipped correct against the design current at the time. The supersession is § 20's dated amendment.        |
| **MOTIR-5147** (the row's design) · `done`                            | Nothing.                                                                                                                                                                                                       | **STRUCTURE:** _Open in place_. Superseded forward by § 20's amendment; its post-decision rule and every row state are untouched.                                                                                   |
| **MOTIR-4789 / 4792 / 5032 / 5033** (the frame)                       | A fourth mount context, and the answer to MOTIR-5032's recorded want — _a reader in `B` who wants the whole viewport_ — without an Expand in state `B`.                                                        | **PREMISE:** in the fill form the frame drops its card chrome and does not offer Expand. Its bands, states and its own asset are unchanged.                                                                         |
| **MOTIR-4778 / 4786 / 5192 / 5292** (the gate, its authority)         | Nothing.                                                                                                                                                                                                       | Nothing — `canDecide` is still the read's answer.                                                                                                                                                                   |
| **MOTIR-4726 / 4729 / 4731 / 3893 / 3895** (the precedents)           | Nothing — cited for the pattern and its reasoning.                                                                                                                                                             | Nothing.                                                                                                                                                                                                            |
| **MOTIR-5176** (the settings door)                                    | Nothing.                                                                                                                                                                                                       | Nothing — its door renders in band 3 wherever the frame does.                                                                                                                                                       |
| **MOTIR-5118 / MOTIR-5160**                                           | Nothing — cited for the page-state contract a decision must meet.                                                                                                                                              | Nothing.                                                                                                                                                                                                            |
| **MOTIR-4908 / MOTIR-5299 / MOTIR-5300**                              | Nothing — boundaries this asset does not cross.                                                                                                                                                                | Nothing (flag 3 names the one open question).                                                                                                                                                                       |

### ⚠️ Planning flags — surfaced by this pass

1. **The fill form needs ONE presentational input on `ApprovalGateControl`.** The frame
   has no prop that gives it the viewport: its only viewport-sized form is its internal
   `expanded` state, which wraps the frame in its own fixed dialog and keeps its card.
   The overlay needs that port recipe **without** the wrapper, **without** Expand and
   **without the frame's own container chrome** (no `--radius-card`, no border — the
   overlay is the container) — a layout input such as `layout: 'inline' | 'fill'`,
   adding no state, verb, band or decide path, so
   `tests/approval-gate-one-language.test.ts` is unaffected. **MOTIR-5224** should name
   the input and both halves of what `fill` means in its criteria, and **MOTIR-5214**'s
   _"composed unmodified"_ should read as _no new state, verb, band or decide path_.
2. **A decision made in the overlay must reach the row's CLIENT island.** Today
   `ApprovalsList`'s row settles because its OWN `onDecide` sets its own gate state.
   Decided from the overlay, that island is not the caller, so `router.refresh()` alone
   cannot settle it (case 3 of the page-state contract). **MOTIR-5225** carries the
   signal — a tick the list watches, or a shared reconcile — as part of _settled in
   place, in one reconcile, with no reload_.
3. **Whether the Approvals room's rows open this overlay** is
   [MOTIR-5300](motir:cmtyy44gy01mshvtx6hmyi1r3)'s decision. This asset gives it a
   surface to compose; it does not decide it.

## 23 · The `pull_request_approval` row AT REST — MOTIR-5480

**AMENDS § 20** (`approvals-row.mock.html`, **Panel 9**) for Story
[MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2), card
[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo). It is the layout source of truth for
[MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v), which builds it.

**What changes, and for which kind.** Once `pull_request_approval` registers
(MOTIR-5481) and gates are raised (MOTIR-5482), a real, decidable gate would reach
Panel 7's _Not built yet_ row. Panel 9 draws its row instead. ~~**`decision_approval`
and `pull_request_merge` keep Panel 7's row**, unchanged, and Panel 7's note says
so.~~ **AMENDED by § 25 (MOTIR-5612):** `decision_approval` keeps Panel 7's row.
**`pull_request_merge` has no row at all** — a card holds ONE approve-to-merge gate,
so the per-pull-request row and its _Not built yet_ cell are removed rather than
re-worded. The struck sentence is kept visible because it is what the asset promised
until 2026-09-16, and a reader arriving from MOTIR-5485 will be looking for it.

| element           | treatment                                                                                                                              | field                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| kind glyph        | lucide `git-pull-request`, `h-4 w-4`, **`--el-accent-on-surface`** (a live kind's mark, never the unregistered `--el-text-faint`)      | `row.kind`                                             |
| kind label        | **Pull requests**, `text-sm font-medium text-(--el-text)`                                                                              | `row.kind`                                             |
| subject line      | each `owner/name · #n` in the set's canonical order, `text-xs text-(--el-text-secondary)`, truncating                                  | the `pull_request_approval` arm of the subject summary |
| the pill          | **none** — _Not built yet_ goes for this kind only                                                                                     | —                                                      |
| whole-row control | a link to **the work item's page** (`/items/{key}`), where the Development frame decides it; no chevron, because nothing opens in-list | `row.workItem.identifier`                              |
| decide cell       | **Open card** (the shipped secondary `sm` button), to the same page                                                                    | —                                                      |
| waited, work item | unchanged from § 20                                                                                                                    | unchanged                                              |

**The truncation rule for the subject line.** One or two pull requests are listed in
full, comma-separated. **Three or more list the first two, then _+n more_**, and the
cell's `title` attribute carries the whole list. Past that the line truncates with an
ellipsis like every other subject line. Panel 9 draws one, two and three pull requests.

**Why _Open card_ and not _Review_.** The full-screen door for this kind is
[MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4)'s. Until it lands, this row takes the
reader to the item page, where the gate is decided; when it lands, 5437 swaps the
decide cell for _Review_ exactly as design rows have it. **Narrow** follows Panel 8
unchanged.

**Copy — `en` + `zh`**, keyed for MOTIR-5485 under `workbench.approvals.pullRequest`:

| key         | en                                            | zh              |
| ----------- | --------------------------------------------- | --------------- |
| `kindLabel` | Pull requests                                 | 拉取请求        |
| `more`      | +{count} more                                 | 另有 {count} 个 |
| `openCard`  | the shipped _Open card_ string — not re-keyed | —               |

### GIVES / TAKES

`grep -o 'MOTIR-[0-9]*' approvals-row.mock.html | sort -u` goes from 19 keys at `HEAD`
to 21: MOTIR-5480 and MOTIR-5437 are new. The row's SAMPLE keys are `ACME-n`.

| card                                          | GIVES                                                                               | TAKES                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v) | The row: glyph, label, subject line and its truncation rule, the link, and the copy | Nothing. Its criteria (glyph, every pull request named, no pill, reaches the page) all hold |
| [MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4) | The row its _Review_ door replaces _Open card_ on                                   | Nothing                                                                                     |
| MOTIR-5481 / MOTIR-5482                       | Nothing — named as what puts a gate in this row                                     | Nothing                                                                                     |

## 24 · The approval overlay renders the APPROVE-TO-MERGE gate — MOTIR-5438

**AMENDS § 22** (`approval-overlay.mock.html`) for ONE gate kind, `pull_request_approval`, in the delta
**`approval-overlay--pull-request-gate.mock.html`** (Story [MOTIR-5437](motir:cmu118c1q0007hytx0tt38vq4),
card [MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)). It is the layout source of truth for
[MOTIR-5440](motir:cmu118ca1000dhytx0jofi4gl) (the host), which carries it in `blocked_by`, and for
[MOTIR-5439](motir:cmu118c7e000bhytxn9l5u1v0) (the read), which feeds what band 2 renders. Neither § 22's
mock nor any other asset is edited, and no image export ships (`docs/decisions/design-result.md`
AMENDMENT 4).

**Why it is owed.** § 22 built the overlay for every gate kind but a port only for `design_result`. On
`origin/main` the read answers `kind_not_built` for `pull_request_approval`
(`app/api/work-items/approval-gate/route.ts`, whose comment names this story), so the decision most cards
end in opened to _Not built yet_.

| Surface                                      | Asset                                                       | Panels |
| -------------------------------------------- | ----------------------------------------------------------- | ------ |
| **The overlay on the approve-to-merge gate** | **`approval-overlay--pull-request-gate.mock.html`** (delta) | 1–10   |

**Panels:** 1 awaiting, a two-repository run under ONE frame · 2 a short screen · 3 see but not decide ·
4 How to test missing · 5 a design card (state 7's block) · 6a approved · 6b changes requested ·
6c superseded · 7 one refused, in place · 8 narrow, in `zh` · 9 dark · 10 the To-approve row's door.

### Rendered first

Composed from what ships, not from memory. Rendered headless before drawing: § 22's Panel 1
(`approval-overlay.mock.html`, the shipped `ApprovalOverlay` inside `Modal size="full"`) and
`design/github/approve-and-merge.mock.html` Panel 12p (the Development block with its frame flush in the
section card). Read against the components: `ApprovalGateControl` takes `layout: 'inline' | 'fill' |
'flush' | 'section'` and `ApprovalOverlay` already passes `fill`; `DevelopmentGateFrame` passes `flush` on
the item page; `DevelopmentSectionBody` already renders state 7's order when it is handed a design result.
**Nothing in this section needs a new component input.**

### The answer in one line

**Band 2 is the item page's Development block**, composed unchanged: every linked pull-request row, then
the run's How to test (body, one sub-block per repository, earlier runs) — and on a design card, state 7's
design slot first. Band 1 and band 3 are MOTIR-4909's kind words and verbs, byte-identical to the item
page. One frame and one _Approve and merge_ over every pull request, in any repository.

### What is composed, and who owns it

| piece                                                                | owner — composed, not redrawn                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| the dialog, the exit row, the address, the fill form, narrow         | § 22 (MOTIR-5222)                                                                                                                 |
| band 1, band 3, the confirm step, every gate state, the refusal      | `design/github/design-notes.md` § 20 _The verbs and their states_ (MOTIR-5480) · `ApprovalGateControl`                            |
| band 2 — the rows and How to test                                    | `design/github/design-notes.md` § 20 (MOTIR-5327) · `github.mock.html` Panel 12b, 12i                                             |
| band 2 on a design card — the design slot                            | `design/work-items/design-notes.md` § _States 7–8_ (MOTIR-5494) · `design-result--what-to-review.mock.html` state 7 and section 8 |
| the row's glyph, label and subject line                              | § 23 (MOTIR-5480)                                                                                                                 |
| **which content band 2 holds for this kind, and the row's _Review_** | **this section**                                                                                                                  |

**Nothing in the Development block is redrawn.** The mock carries `approve-and-merge.mock.html`'s own
stylesheet and sprite sheet byte for byte, so its rows, pills, How to test, code blocks and `af-` frame
bands are that sheet's rules; the overlay container is re-declared under `ov-` names quoting § 22's class
strings, and state 7's slot under `ds-` names quoting its sheet.

### FILL, not FLUSH — the one thing that differs from the item page

The same block renders in two frame layouts, and the difference is the BOX only:

| element                                    | item page — `layout="flush"` (12p)            | overlay — `layout="fill"` (this section)                          |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------- |
| the container                              | the Development section card                  | the overlay itself — no card around the frame                     |
| the section card's title, gloss and door   | _Development_, its gloss, _Link pull request_ | **absent** — they are the page's, not the gate's                  |
| the port's floor · 34rem ceiling · Expand  | kept                                          | **dropped** — the viewport is the box                             |
| scroll                                     | the port, inside its ceiling                  | the port, at viewport height; band 3 on the bottom edge (Panel 2) |
| bands 1 and 3, every state, verb and alert | the frame's                                   | **the frame's, byte-identical**                                   |

**_Pull requests_ appears ONCE**, as band 1's kind label. The overlay has no section card, so there is no
_Development_ heading above it and nothing to de-duplicate; the dialog's accessible name keeps the kind
(`approvalOverlay.dialogTitle`, _Pull requests for ACME-12_).

### How to test is evidence, never a gate

It renders inside band 2, below the rows (or below the design slot on a design card). It has **no band,
no gate row, no verb and no approval of its own**, in every panel. Its copy controls work in every state,
including see-but-not-decide (Panel 3), because reading is not deciding. When no run wrote it, the
block's **record-missing** callout renders inside the port (Panel 4, 12i unchanged) and the verbs stay:
the gate is real, and a reviewer may approve without instructions.

### A design card — state 7, and it outranks the card

Panel 5. On a design card with an open linked pull request (AMENDMENT 4 Q8) band 2 is state 7's block:
**the design result once, then How to test, then every pull-request row** behind a soft rule. No design
band, no design gate, no design verbs.

**⚠️ This corrects MOTIR-5438's own criterion**, which placed the result _"below every pull-request row
and above How to test"_. State 7 merged at 2026-09-14T23:10Z (#2894), after the card was last edited
(19:11Z), on review: _"design result and how to test should be before the PRs"_. The shipped
`DevelopmentSectionBody` renders that order. The criterion is amended on the card, 2026-09-15.

### States — composed, one panel each

| state                          | panel | composed from                                                                   |
| ------------------------------ | ----- | ------------------------------------------------------------------------------- |
| awaiting (you)                 | 1, 2  | 12p                                                                             |
| awaiting, see but not decide   | 3     | 12w — no verbs, _Waiting on {name}._, pill _Awaiting_                           |
| How to test record missing     | 4     | 12i inside 12p                                                                  |
| approved — all merged          | 6a    | 12t                                                                             |
| changes_requested              | 6b    | the frame's record band (state E) with this kind's commit count; nothing merged |
| superseded — withdrawn by push | 6c    | 12v                                                                             |
| merging · queued to merge      | —     | 12r · 12s, unchanged — the same bands in the same fill form, not repeated       |
| one refused, in place          | 7     | 12u                                                                             |

**Deciding does not close the overlay** (§ 22): the frame re-renders with the decided record, and the row
underneath settles in place in the same reconcile.

**Band 3's copy is the SHIPPED copy.** `approvalGate.pullRequestApproval.consequence.named` reads
_Approving merges {prs} — each now, or through its repository's merge queue where one is required — then
moves {key} to Approved._ `approve-and-merge.mock.html` 12p still draws the earlier per-member wording
(_… and adds {queued} to its merge queue …_); the panels here draw what `messages/en.json` ships.

### Narrow (`< md`) and dark

Panel 8, in `zh`: § 22's narrow exit row unchanged (no `Esc` chip, no title, _Open work item_ as its icon
with the label as its accessible name); rows wrap their pills under the title; band 3 wraps its sentence
above the verbs. Panel 9: Panel 1 under `data-theme="dark"` — no token of its own.

### The ACCESS PATH — the row's door (Panel 10)

§ 23 said it: once this story lands the `pull_request_approval` row's decide cell swaps **_Open card_ for
_Review_**, exactly as design rows have it. **The whole row is the door** (§ 22 Panel 9, MOTIR-5225's
`aria-haspopup="dialog"` link): a plain primary click writes
`?approval=<key>&approvalKind=pull_request_approval` with `shallowPush` and this overlay opens over the
tab; a modified or middle click opens `/items/<key>` in a new tab. The glyph, _Pull requests_ label and
subject line with its _+n more_ rule are § 23's, unchanged.

### Fields the port reads

The port is `DevelopmentSectionBody`, so it reads exactly what the item page hands it — which is what the
read (MOTIR-5439) must return beside `gate` and `canDecide`.

| rendered element                      | field(s)                                                                                                  | source on the item page                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| every pull-request row                | `deliveries` — `WorkItemDeliveryDto[]`, each with its `LinkedPullRequestDto`                              | `workItemsService.getDeliveryView(item.id, targetRepos)` |
| a repository with no pull request yet | `repos` — the repository set amended by the delivery set (`AwaitingRepoRow`, 12l)                         | the same `getDeliveryView` call                          |
| How to test — every part              | `HowToTestDto` (`record` · `record_missing` · `tested_via_ancestor`)                                      | `howToTestService.getForWorkItem`                        |
| the design slot (Panel 5)             | the current `DesignEvidenceDTO`, or `null` on a card with none                                            | `designEvidenceService.getCurrentForWorkItem`            |
| band 1, band 3, every state           | `ApprovalGateDTO`, `canDecide`, `routedToLabel`; the member outcomes as `DevelopmentGateFrame` reads them | the overlay read (MOTIR-5223)                            |

### Copy — `en` + `zh`

**No new string.** Every visible string is shipped: `common.close`; `approvalOverlay.*`;
`approvalGate.state.*`, `approvalGate.waitingOn`, `approvalGate.verb.requestChanges`;
`approvalGate.pullRequestApproval.*`; `github.development.howToTest.*`; `designResult.*`;
`workbench.approvals.review` (_Review_ / _查看_) and `workbench.approvals.pullRequest.*`.

### Tokens

`--el-*` colour and element-semantic shape tokens only, no raw hex. The overlay's own elements keep
§ 22's token map. Board chrome inks are `--el-text` and `--el-text-secondary` only. Code blocks and the
design slot's frame and note row take `--el-card` inside the port, so `--el-link` keeps AA.

### What this asset does NOT decide

- **The overlay container, the address, the exit row** — § 22's.
- **The frame's states, verbs, confirm step, refusal copy or merge behaviour** — MOTIR-4909 / MOTIR-4882.
- **The Development block, How to test, the design slot** — MOTIR-5327 / MOTIR-5336 / MOTIR-5494.
- **The item page's door** — MOTIR-5215.

### GIVES / TAKES — every card this asset names

| card                                                                                                                                                               | GIVES                                                                                                                            | TAKES                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)** (this card)                                                                                                      | Panels 1–10 and this section                                                                                                     | **PREMISE:** its design-card criterion's order (_"below every pull-request row and above How to test"_) — state 7 outranks it. **Amended on the card, 2026-09-15.**                                                                                              |
| **[MOTIR-5439](motir:cmu118c7e000bhytxn9l5u1v0)** (the read)                                                                                                       | The Fields-read table: `deliveries`, `repos`, `HowToTestDto`, `DesignEvidenceDTO` or `null`                                      | **ELEMENT:** _"the item's linked pull requests, in the same shape the item page's Development section reads"_ names one of the two delivery fields; the block also reads `repos` to draw a repository with no pull request. **Amended on the card, 2026-09-15.** |
| **[MOTIR-5440](motir:cmu118ca1000dhytx0jofi4gl)** (the host)                                                                                                       | Every panel, the fill form around this port, no new frame input, and the row's door                                              | **ELEMENT:** the row's decide cell _Open card_ → _Review_ (§ 23's promise), which its criteria did not name. **Amended on the card, 2026-09-15.**                                                                                                                |
| **[MOTIR-5441](motir:cmu118cco000fhytx4onw4dk2)** (the vitest gate)                                                                                                | The seams to assert: one frame over both repositories, How to test with no verb, record-missing inside the port, state 7's order | Nothing.                                                                                                                                                                                                                                                         |
| **[MOTIR-5442](motir:cmu118cf8000hhytxpqsqhdqm)** (the acceptance E2E)                                                                                             | The walk's surfaces: the row's _Review_, both rows and How to test at full size, a copy control, band 3 on the bottom edge       | Nothing.                                                                                                                                                                                                                                                         |
| **[MOTIR-5222](motir:cmtxm4vqc00euhztx2esa99wa)** (§ 22) · `done`                                                                                                  | A second port for its container                                                                                                  | Nothing — the container is composed.                                                                                                                                                                                                                             |
| **[MOTIR-5223](motir:cmtxm4vsr00ewhztxdvzgyay8)** (the read's route) · `done`                                                                                      | A drawn consumer for a resolved `pull_request_approval` subject                                                                  | Nothing — its `kind_not_built` arm for this kind is what MOTIR-5439 replaces.                                                                                                                                                                                    |
| **[MOTIR-5224](motir:cmtxm4vvp00eyhztxhm8nwmrs)** (the host) · `done`                                                                                              | Nothing                                                                                                                          | Nothing — `layout="fill"` shipped; this port needs no other input.                                                                                                                                                                                               |
| **[MOTIR-5225](motir:cmtxm4vyn00f0hztxmer6bqau)** (the row door) · `done`                                                                                          | Its door, reached from a second kind                                                                                             | Nothing.                                                                                                                                                                                                                                                         |
| **[MOTIR-5327](motir:cmtzoqqmt00bzhvtxgxduxev2)** (the Development block) · `done`                                                                                 | A third mount context for the block                                                                                              | Nothing — composed.                                                                                                                                                                                                                                              |
| **[MOTIR-5494](motir:cmu1hrmoo001shutx9zav5r0h)** (state 7) · `done`                                                                                               | Nothing                                                                                                                          | Nothing — its section 8 already drew this overlay's band 2 on a design card; Panel 5 composes it.                                                                                                                                                                |
| **[MOTIR-4909](motir:cmtt4ogps000ghutxdx7laze2)** · **[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo)** · **[MOTIR-5484](motir:cmu1aj1bj00gkhyoi0iuds6xy)** · `done` | A fourth mount context for the kind's bands                                                                                      | Nothing — bands 1 and 3 composed; the shipped consequence copy is drawn where 12p's sheet predates it.                                                                                                                                                           |
| **[MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v)** (the row) · `done`                                                                                               | Nothing                                                                                                                          | **ELEMENT:** _Open card_ → _Review_ and the row's link → the overlay door. Not amended: a `done` card is history; § 23 recorded the swap as MOTIR-5437's.                                                                                                        |
| **[MOTIR-4882](motir:cmtrwx3580055hxph0vfamj1l)** · `done`                                                                                                         | Nothing                                                                                                                          | Nothing — its refusal union is cited in Panel 7's slot, not re-worded.                                                                                                                                                                                           |
| **[MOTIR-5215](motir:cmtxm4v6g00efhztx79g9zyar)** · `done`                                                                                                         | Nothing                                                                                                                          | Nothing — the item page's door writes the same address.                                                                                                                                                                                                          |

Fixture items use `ACME-n` keys and link to nothing.

## 25 · The To-approve ROW SET and the Development frame WITHOUT a merge gate — MOTIR-5612

**AMENDS § 20** (`approvals-row.mock.html`, Panel 9 as § 23 revised it) **and § 23 itself**, in the
delta **`approvals-row--one-gate.mock.html`** (Bug [MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37),
card [MOTIR-5612](motir:cmu3bguy400drhwtx2p8zl203)). It also amends the Development frame drawn in
`design/github/design-notes.md` § 20 (MOTIR-5327 · MOTIR-5484). It is the layout source of truth for
[MOTIR-5615](motir:cmu3bgv5u00dxhwtxlgojcou8), which builds it and carries this card in `blocked_by`.
**No existing mock is edited** and no image export ships (`docs/decisions/design-result.md`
AMENDMENT 4).

**Why it is owed.** A card in a `manual` project was raised TWO approve-to-merge gates — one per pull
request beside the one per card — so the To-approve tab listed the same pull request twice, and one of
those rows read _Not built yet_ about a kind that is in fact registered. The model is now ONE gate per
card, and approving it merges every pull request the card delivers
(`docs/decisions/approval-gates.md` § 8's SECOND AMENDMENT, **decisions 3 and 5**). § 23 of this file
SPECIFIED the row being removed, so the new state had to be drawn before it is built.

### Rendered against shipped reality, not redrawn

Every string, structure and class string in the delta was taken from the REAL components mounted with
the shipped fixtures at `origin/main` `45b107a5f`, not read off the source:

- `components/approvals/ApprovalRow.tsx` — both rows of Panel 2, including the `Pill tone="archived"`
  _Not built yet_ cell and the `Pull-request merge` subject line `mergeSubjectMeta` writes;
- `components/github/DevelopmentGateFrame.tsx` (via `DevelopmentSection.tsx`) — the frame header, the
  pull-request rows, the outcome chips, _Retry merge_ and the refusal alert of Panels 3–5.

The mock's second stylesheet re-declares those components' markup under prefixed names, each rule
quoting the class string it maps to; the first stylesheet is § 24's delta byte for byte.

### The panels

| panel | what it settles                                                                                                                                                                                                                                                                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1** | **To approve draws ONE row for one card, whatever it delivers.** The subject cell already names the whole set in the gate's canonical order, so the row states what approving it merges. The decide cell is § 23's _Review_ and the door is § 24's overlay — both unchanged.                                    |
| **2** | **The row that is GONE**, as a before/after pair over the same card: 2a draws today's three rows — the card's own plus one `pull_request_merge` row per pull request, each carrying the _Not built yet_ pill in its decide cell — and 2b draws the one row that remains.                                        |
| **3** | **The frame at rest.** The card's single gate holds the decision; each pull request's merge OUTCOME is drawn in its own row's trailing cell, read from `merge_authority` / `merge_outcome_ref` on the pull-request row rather than from a gate of its own.                                                      |
| **4** | **ONE member refused.** _Retry merge_ stays in the refused row's trailing cell and is addressed to **(the card's approved gate, THIS pull request)**. The gate stays `approved`, the card stays `approved`, and the sibling that merged keeps its outcome — a retry carries out a decision that already stands. |
| **5** | **A QUEUED pull request.** _Queued to merge_ is an outcome, not a pending decision: the card sits `approved` until the merge webhook lands it. No retry is offered while an outcome exists.                                                                                                                     |

**No second gate is drawn in any panel**, which is the one thing a reader should be able to check by
looking rather than by reading.

### What this asset does NOT decide

- **The copy.** Every string in the delta is the shipped one. Retiring the strings this change makes
  unreachable for the kind — `workbench.approvals.notBuiltYet`, `mergeSubjectMeta` — in `en` and `zh`
  is [MOTIR-5615](motir:cmu3bgv5u00dxhwtxlgojcou8)'s.
- **The overlay.** § 22 and § 24 draw it. Its `kind_not_built` arm for this kind retires with the row,
  and that arm is MOTIR-5615's and [MOTIR-5616](motir:cmu3bgv8100dzhwtx5nb0ovib)'s.
- **The registry and the enum.** The kind stays registered until MOTIR-5616, and the
  `approval_gate_kind` Postgres value is kept permanently, because superseded rows reference it.

### ⚠️ A line in a sibling asset that is TRUE ONLY LATER

`approval-overlay.mock.html:4815` labels a panel
`4a · kind = pull_request_merge (in UNREGISTERED_GATE_KINDS)`. **That is not true today** — the kind is
registered (`lib/approvalGates/registry.ts`), which is exactly why the To-approve row was decidable-looking
enough to reach a _Not built yet_ cell rather than an unregistered one. It becomes true when
[MOTIR-5616](motir:cmu3bgv8100dzhwtx5nb0ovib) moves the kind to `UNREGISTERED_GATE_KINDS`. It is named
here, and not edited, because § 22's mock is a record of what was drawn: a reader meeting that label
should know it describes the destination rather than the present.

### GIVES / TAKES — every card this amendment names

| card                                                                    | GIVES                                                                                                                   | TAKES                                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **[MOTIR-5615](motir:cmu3bgv5u00dxhwtxlgojcou8)** (the UI) · `blocked`  | Panels 1–5: the row set, the outcome cell, RETRY's address, and the copy it must retire in `en` + `zh`                  | Nothing to amend — it was authored against this delta and carries it in `blocked_by`                                                      |
| **[MOTIR-5616](motir:cmu3bgv8100dzhwtx5nb0ovib)** (the retirement)      | The `UNREGISTERED_GATE_KINDS` line above becomes true at this card, and the overlay's `kind_not_built` arm goes with it | Nothing — its scope is the registry tier, unchanged by this asset                                                                         |
| **[MOTIR-5485](motir:cmu1aj1d000gmhyoic2qrsb4v)** (§ 23's row) · `done` | Nothing                                                                                                                 | Nothing — a `done` card is history. § 23's struck sentence records that its sibling row is gone, so a reader arriving there is not misled |
| **[MOTIR-5480](motir:cmu1aj15k00gchyoidbhlbomo)** (§ 23) · `done`       | Nothing                                                                                                                 | **ELEMENT:** the Panel 7 promise for `pull_request_merge` is struck in place, above                                                       |
| **[MOTIR-5438](motir:cmu118c4s0009hytxgtmyfeg8)** (§ 24) · `done`       | Nothing                                                                                                                 | Nothing — the overlay and its port are unchanged; this delta composes them                                                                |
| **[MOTIR-5603](motir:cmu396zoh005ihwtxd5xpny37)** (the bug)             | The drawn state of its own fix                                                                                          | Nothing                                                                                                                                   |

Fixture items use `MOTIR-4931` and link to nothing.

---

## The CI badge (MOTIR-5471)

**Asset: `workbench--ci-badge.mock.html`** (panels 10–12). It amends § _Layout_. Story MOTIR-5469;
built by MOTIR-5475.

**The column set is untouched.** `minmax(10rem, 1fr) 96px 140px 108px` — Title · Your role · Assignee ·
Status — with the same `gap-x-4` and `pl-4 pr-7`: `344 fixed + 48 gaps + 44 padding + a 160px title
floor = 596px`, against the **622px** minimum § _Layout_ records, and a measured title track of **440px
at 1200**.

**The badge takes the title cell, as a GLYPH**, for the same reason and in the same form as on
`/items` — `design/work-items/design-notes.md` § _The CI badge (MOTIR-5471)_ carries the measurement and
is the authority. **The 1200 fit is therefore untouched: no fixed width is added, and 440px of title
track absorbs a ~20px glyph.** No new column, so nothing in § _Layout_'s budget moves.

**Per tab:**

- **_In progress_** — the tab the badge is for. A card whose run opened pull requests sits at
  `implemented` both while its checks run and after they fail, and this is where its owner sees which.
- **_Recently finished_** — **never shows it, structurally rather than by exception.** That tab lists
  cards in the `done` CATEGORY, and the badge's rule is that a done-category card carries none. The tab
  needs no special case and no extra column; the same rule that governs the board card governs it.
- **_Watching_** — follows the same rule as _In progress_: drawn when the card is not done.

At ~400px the row is far under its 622px minimum and already scrolls horizontally — the Workbench's
existing behaviour, which the badge neither causes nor changes.

---

## 26 · WHAT LIVE LOOKS LIKE — MOTIR-5239

**AMENDS § 20** (the To-approve row, and its POST-DECISION rule) **and § 22** (the
approval overlay) for Story
[MOTIR-5238](motir:cmtxm4x2e00fwhztxbr4hkj9s), card
[MOTIR-5239](motir:cmtxm4x5800fyhztxp88bxw52). It is the layout source of truth for
**MOTIR-5242** (the host and its lists) and **MOTIR-5243** (the open approval), which
carry it in `blocked_by`.

| Surface                 | Asset                                        | Notes                                                                                                                                                                   |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Workbench, LIVE** | **`workbench--live.mock.html`** (HTML delta) | A row arriving and a count moving · reconnecting · DECISION 1, the held row · DECISION 2, the notice in the overlay · the notice and the refusal side by side · narrow. |

**Panels:** 1 a row arrives and the count moves · 2 reconnecting · 3 DECISION 1, a row
that left the awaiting set · 4 DECISION 2, the notice in the open approval · 5 the
notice and the refusal side by side · 6 narrow (`< md`).

**It is a DELTA and holds only what live-ness changes.** The strip, the shell, the
five-tab composition, the pager, the empty states, the frame, the exit row, the
address and the fill form are all composed from the assets that own them
(`workbench.mock.html`, `approvals-row.mock.html`, `approval-overlay.mock.html`) and
are not re-decided here. Every row in it is `ApprovalsList` / `ApprovalRow`'s own
emitted markup; the four edits the asset makes are listed in its header comment.

### ⚠️ AMENDED 2026-09-17 by MOTIR-5239 — § 20's POST-DECISION rule SURVIVES live-ness, and here is the rule that makes it

§ 20 settled, with its reasons, that **a decided row keeps its position, swaps its
Decide cell for a state pill, and leaves on the NEXT LOAD — it never vanishes under
the cursor**, because _"a surface that sometimes removes a row silently and sometimes
explains one teaches the reader that disappearance is ambiguous, which is the most
expensive thing a queue can teach."_

**A list that re-reads itself on a nudge removes that row.** The tab reads
`state = awaiting`, so a row somebody else has just decided is simply absent from the
next read. That is § 20's rule being overturned BY A MECHANISM rather than by a
decision, and this amendment refuses it.

> **THE RULE — A NUDGE ADDS AND UPDATES. IT NEVER REMOVES.** A row that is in the
> reader's list stays in the reader's list until the NEXT LOAD — a navigation, a tab
> switch, a pager move, a reload. A row that has left the awaiting set is HELD in
> place, its subject and work-item ink go `--el-text-secondary`, its verb is replaced
> by the colourless **Decided elsewhere** pill, and it still opens. The strip count
> goes DOWN with it, because § 20's count is about what is AWAITING and a held row is
> a receipt, not a member.

**The two candidates this rejects, and why neither is the shape:**

- **_A row the reader has already SETTLED is held until they navigate._** It protects
  the rows THIS reader decided — which the product already handles, through
  `lib/approvals/decidedGates.ts` (§ 22 planning flag 2). The hazard is the row
  somebody ELSE decided, which this reader never touched, so the rule is correct
  about a case that was not in danger and silent about the one that was.
- **_A row the reader INTERACTED with is exempt._** The same defect, stated as an
  exemption: interaction is not what makes a disappearance ambiguous. A reader who has
  been reading a queue for a minute and looks back to find one fewer row cannot tell
  whether they misremembered, whether a filter moved, or whether something was
  decided — and they did not interact with any of it.

**What is NOT amended:** the settled TREATMENT itself (§ 20 owns it, and the held row
uses it), the state pills, the column set, the narrow reflow, the token map, and the
rule that a row this reader decided settles from the write's own response.

**Why the held row's pill says _Decided elsewhere_ rather than naming the state.** The
tab's read returns only `awaiting` gates and the stream carries no content, so when a
row leaves the set the surface knows THAT it left and not WHERE it went. **Drawing a
state it cannot read would be the surface guessing**, and `approved` / `changes
requested` / `withdrawn` are three different pieces of news. So the pill says the true
thing — it is no longer yours to decide — and the row still opens, where the frame
shows the real record: who decided, when, and on which bytes. Colourless for § 20's own
reason: a tinted pill would let a reader take somebody else's answer for their own.

### DECISION 2 — an open approval learns its subject MOVED

**The case, from the story:** a person is holding the full-screen approval open and
reading a design at full size — which is the entire reason that surface exists — and
the design is republished under them. Interrupting them costs their attention at the
moment they are giving it. Saying nothing means they finish, press Approve, and meet
the stale refusal instead. **Neither is right, and the third option is the answer.**

> **THE RULE — SAY NOTHING LOUDLY, AND MAKE IT IMPOSSIBLE TO MISS WHEN THEY LOOK UP.**
> A persistent, non-modal notice is drawn as **band 3's first child, immediately above
> the verbs**. It does not move, does not animate, does not steal focus and does not
> dismiss itself. It is INFORMATIVE: the verbs stay exactly as they were.

**Three constraints the drawing answers, each of them a thing a later change is likely
to break:**

1. **THE PORT IS NOT COVERED, TAKEN AWAY, OR REFLOWED.** The notice is inside band 3,
   which is anchored to the bottom edge of the screen, so band 3 grows downward-inward
   and the port's scroll container loses one line at its BOTTOM edge. **The port keeps
   its `scrollTop`, so the sentence the reader is on does not move.** Nothing is
   overlaid on the design, and nothing above the notice re-lays out. (A notice drawn
   at the TOP, near the port, would reflow the thing being read — which is the one
   move this surface may not make.)
2. **IT IS A NOTICE, NOT A GATE.** The stamp is what actually prevents a wrong
   approval (`docs/decisions/approval-gates.md` § 6a — the decision records the
   subject's immutable version, and a press against a superseded gate is REFUSED
   server-side). A notice can be missed, so drawing it as a blocking banner, or
   disabling the verbs behind it, would claim a guarantee it cannot make and would
   make this surface a precondition when it is not. The verbs stay live and the
   refusal stays the guarantee.
3. **IT IS TELLABLE FROM THE REFUSAL IT PRECEDES.** Panel 5 draws the two side by
   side. **The notice is about the SUBJECT and arrives BEFORE the press, so it offers
   a way forward; the refusal is about the PRESS and arrives AFTER it, so it reports
   that nothing was recorded.** Neither repeats the other's words — which is what
   stops a reader who saw the first from reading the second as the same message
   repeating, and wondering why their press did not land.

**Why the notice carries NO TINT, on a surface whose product language for _out of
date_ is yellow.** `--el-tint-yellow` is already spent inside this frame: band 1's
state pill reads **Awaiting you** in it. A second yellow in the same 720px, meaning
something else, is a reader's problem rather than a palette question — so the notice
is drawn on `--el-surface-soft` with an `--el-border` hairline, and carries its meaning
in a `TriangleAlert` glyph and in WORDS (finding #35's rule, applied in the direction
that is always safe: never rest a state on colour, and where colour is taken, do not
take it twice).

### The copy — `en` and `zh`

| key                                 | `en`                                                | `zh`                               |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `approvalOverlay.moved.title`       | This design was republished while you were reading. | 你正在阅读时，该设计已被重新发布。 |
| `approvalOverlay.moved.consequence` | Approving this version will be refused.             | 批准此版本将被拒绝。               |
| `approvalOverlay.moved.action`      | Reopen                                              | 重新打开                           |
| `workbench.live.new`                | New                                                 | 新增                               |
| `workbench.live.decidedElsewhere`   | Decided elsewhere                                   | 已由他人决定                       |
| `workbench.live.reconnecting`       | Reconnecting…                                       | 正在重新连接…                      |

**These are DRAFTS for the catalog**, exactly as § 20's were: MOTIR-5242 and
MOTIR-5243 own their `en` + `zh` entries. `moved.consequence` deliberately states the
CONSEQUENCE rather than the mechanism — a reader does not need to know what a stamp is
to know that this press will not land. **`Reopen` is the verb because the address
survives a republish** (§ 22 — a gate is addressed by `(work item, kind)`, so the same
link opens the current question); it is not _Reload_, which would suggest the page.

### The ARRIVAL and the COUNT

**A row arrives in its ORDERED POSITION and carries a `New` chip until the next load.**
On this tab the order is `createdAt asc` (§ 20), so an arrival lands at the BOTTOM and
nothing the reader was looking at moves. **The chip is a WORD in the shipped neutral
`Pill`, not a tint and not an animation** — a sudden silent insertion teaches a reader
to distrust what they have already read, and a flash or a slide moves a surface whose
whole promise is that it can be left alone.

**The COUNT moves and is NOT marked.** A number that changes is self-evident; a badge
that pulses is a second thing to look at on a page the reader is deliberately not
watching. **The strip and the list move in ONE page state** — § 21's rule, restated for
a live surface: a frame that moves one moves both, so a count of 4 above a list of 3 is
a state this surface never renders.

**On a list ordered `updatedAt desc` — the three work tabs — an arrival lands at the
TOP.** The rule is the same and so is the treatment; what differs is that rows below it
shift by one row's height. That is acceptable on those tabs and would not be on this
one, which is why the order each tab already has is what decides it rather than a
second rule.

### RECONNECTING — and what it is NOT

**It is not loading, and the difference is the whole of its treatment.** Loading means
_there is nothing on your screen yet_ (§ 22's Panel 5b: muted blocks at the real
proportions, `aria-busy`, so an answer that arrives does not reflow the screen).
Reconnecting means _everything on your screen is real and may be a few seconds old_.

So: **the rows keep their full ink, nothing pulses, nothing is greyed, and no skeleton
appears.** The only new element is a quiet chip beside the strip — the shipped chip
recipe (`--el-chip-bg` + `--el-chip-border` + `--el-text-secondary`), a `RefreshCw`
glyph and the word. **It offers no action**, because there is nothing for a reader to
do: `useRunEvents`' backoff already retries to a 15s ceiling, and the watermark resumes
with neither a replay nor a gap. It leaves when the stream reconnects.

**At `< md` it is drawn BELOW the strip rather than beside it** — the strip already
scrolls at that width (§ _Narrow: the strip SCROLLS_), and a chip inside a scrolling
track is a chip that can be scrolled out of sight.

### Token map — this amendment's own elements

| Element                      | Colour                                                      | Shape                                   |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| the `New` chip               | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| the `Decided elsewhere` pill | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| a HELD row's ink             | `--el-text-secondary` — § 20's AA note applies unchanged    | —                                       |
| the reconnecting chip        | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| its `RefreshCw` glyph        | `currentColor` (`--el-text-secondary`)                      | `h-3.5 w-3.5`                           |
| the moved notice             | `--el-surface-soft` · `--el-border` · `--el-text-strong`    | `--radius-card`                         |
| its `TriangleAlert` glyph    | `--el-text-strong`                                          | `h-4 w-4`                               |
| its `Reopen` action          | the shipped secondary `Button`                              | `--radius-btn` · `--height-btn-sm`      |

**A HELD row's ink is `--el-text-secondary`, not `--el-text-muted`**, for the reason
§ 20 records on the record: muted is 4.12–4.34:1 on `--el-surface`, which is this row's
HOVER fill, so it would drop below AA in the one moment a pointer is on it. No raw hex
and no raw shape utilities anywhere in the asset.

### GIVES / TAKES — every card this amendment names

Scope: every `MOTIR-<n>` in this section plus the mock's annotation prose, grepped over
the story's SUBTREE. Axes: ELEMENT (what is drawn), STRUCTURE (where it sits), PREMISE
(what it assumes).

| card                                                      | GIVES                                                                                                                                                                                                                                                                                                                                            | TAKES                                                                                                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-5242** (the host, the lists, the counts)          | **ELEMENT:** the `New` chip, the held row's ink and pill, the reconnecting chip. **STRUCTURE:** a nudge ADDS and UPDATES and never REMOVES; the arrival lands in its ordered position; the chip beside the strip at `≥ md` and below it at `< md`. **PREMISE:** the count decrements with a held row, and strip and list move in one page state. | Nothing. Its stream, its hook and its one-connection rule are the parent story's and are untouched here.                                                  |
| **MOTIR-5243** (the open approval)                        | **ELEMENT:** the notice, its glyph, its two sentences, its `Reopen` action, and its `en` + `zh` drafts. **STRUCTURE:** band 3's first child, above the verbs, with the port keeping its `scrollTop`. **PREMISE:** it is informative and the verbs stay live, because the stamp is the guarantee.                                                 | Nothing. It does not decide what the frame's bands contain, and this section does not re-open § 22's fill form.                                           |
| **MOTIR-5238** (the story)                                | **Both decisions it named as owed to this card, SETTLED**, as rules its code cards are closed against.                                                                                                                                                                                                                                           | Nothing.                                                                                                                                                  |
| **MOTIR-5240 / MOTIR-5241** (the read, the stream)        | **PREMISE, and it is the one that constrains them:** the surface needs to know WHICH TABS moved and nothing else — no row content — and a held row means the client must tolerate a row the read no longer returns.                                                                                                                              | Nothing. The watermark's shape and the stream's frame are theirs; this section reads them and draws against them.                                         |
| **MOTIR-5147 / MOTIR-4794** (§ 20's row)                  | Nothing they do not already own. The held row USES their settled treatment; the drawn rows are `ApprovalRow`'s own markup.                                                                                                                                                                                                                       | **Nothing is taken, and the boundary is stated:** § 20's post-decision rule is honoured, not re-opened — this amendment says HOW a live re-read obeys it. |
| **MOTIR-5222 / MOTIR-5224 / MOTIR-5225** (§ 22's overlay) | Nothing they do not already own. The notice is composed INTO the frame they specify, and the exit row, the address, the fill form and every state are theirs, unchanged.                                                                                                                                                                         | **One element of band 3's box:** band 3 may now carry a full-width first child. Its verbs, its consequence line and its refusal are untouched.            |
| **MOTIR-5302** (`ApprovalRow`)                            | A drawn consumer for two more row conditions — the arrived chip and the held pill — both inside the one row grammar rather than beside it.                                                                                                                                                                                                       | Nothing. Neither condition adds a column or a band.                                                                                                       |
| **MOTIR-4908**                                            | Nothing — named only as a boundary this asset does not cross. The pending-decision indicator is that story's, and nothing here draws or reads one.                                                                                                                                                                                               | Nothing.                                                                                                                                                  |

### ⚠️ Planning flags — surfaced by this pass

1. **The held row needs a SIGNAL the list can watch, and one already exists.**
   `lib/approvals/decidedGates.ts` carries a decision made in the overlay to
   `ApprovalsList`'s client island (§ 22 planning flag 2). A row held because SOMEBODY
   ELSE decided arrives by a different route — the live re-read finds it absent — so
   **MOTIR-5242** owns turning that absence into the held treatment rather than into a
   removal. Named here because the two paths produce the same row state and should not
   grow two implementations of it.
2. **A row held for a whole session is a list that only grows.** The rule is bounded by
   the NEXT LOAD, and every ordinary use of this surface reaches one quickly (a tab
   switch, a pager move, a reload). A reader who leaves the Workbench open for a day
   without navigating would accumulate held rows, and **no card in this story caps
   that**. It is not a defect of the rule — a cap is exactly the silent removal the
   rule refuses — but if it ever becomes real, the answer is a LOAD the reader asks
   for, never a quiet sweep.
3. **The three work tabs' arrival treatment is drawn but not exercised here.** This
   asset draws the arrival on the To-approve tab, whose `createdAt asc` order puts it
   at the bottom. `updatedAt desc` puts it at the top and shifts the rows below it; the
   rule and the chip are the same, and **MOTIR-5242** should assert the chip on at
   least one `updatedAt desc` tab so the treatment is not accidentally
   approvals-only.

## 27 · The To-approve ROW for a DECISION — MOTIR-5673

**Asset:** `design/workbench/approvals-row--decision.mock.html` — a NEW delta mock. It amends
`design/workbench/approvals-row.mock.html` (MOTIR-5147, § 23) as amended by
`design/workbench/approvals-row--one-gate.mock.html` (MOTIR-5612, § 25), and composes the row exactly
as `design/workbench/approval-overlay--pull-request-gate.mock.html` (MOTIR-5438) Panel 10 draws it,
whose token block, sprites and `rw-*` rules are spliced 1:1. None of them is edited. The port the row
opens is `design/github/approve-and-merge--decision.mock.html`, noted in `design/github/design-notes.md`
§ 27, with the full copy table for the kind. Drawn to `docs/decisions/approval-gates.md` § 8's FIFTH
AMENDMENT (MOTIR-5672).

### The row

- **Glyph:** the decision TYPE's own mark — lucide `scale` in `--el-type-decision`
  (`lib/issues/workItemTypeMeta.ts`), exactly as a design row takes the design type's pencil in
  `--el-type-design`. `aria-hidden`; the words carry the meaning. The only new CSS rule is that hue.
- **Kind:** _Decision_ / _决策_ — the short row label, as _Pull requests_ is for the approve-to-merge
  row.
- **Subject line:** the document's first `#` heading (a leading `ADR:` dropped) · its path, truncated as
  every subject line is; the cell's `title` carries the path and the blob. **When the heading is not
  available**, the title from the file name (`titleFromDecisionPath`: `page-body.md` → _Page body_) — never an
  empty cell, and the row never waits on GitHub to draw (Panel 7b).
- **Unresolvable decisions list too** (Panel 7c): _No decision document · {pr}_ / _无决策文档 · {pr}_,
  and _{count} decision documents · {pr}_ / _{count} 份决策文档 · {pr}_. They are real questions —
  their Request changes is live — so they list and they open the overlay.
- **_Not built yet_ is gone for this kind** (Panel 7d, before / after).
- **The ACCESS PATH** (Panel 8b): the whole row is the door, as every live row —
  `?approval={key}&approvalKind=decision_approval` by `shallowPush`, opening the overlay over the tab.

### Copy — new strings, `en` and `zh`

| key                                             | en                                | zh                        |
| ----------------------------------------------- | --------------------------------- | ------------------------- |
| `workbench.approvals.rowKind.decision_approval` | Decision                          | 决策                      |
| `workbench.approvals.decisionSubject.none`      | No decision document · {pr}       | 无决策文档 · {pr}         |
| `workbench.approvals.decisionSubject.several`   | {count} decision documents · {pr} | {count} 份决策文档 · {pr} |
| `workbench.approvals.decisionSubject.title`     | {path} at blob {blob}             | {path}，文件版本 {blob}   |

The resolvable subject is data (heading or file-name title, and the path) and needs no key.

### GIVES / TAKES

Scope: `grep -o 'MOTIR-[0-9]*' approvals-row--decision.mock.html | sort -u` — 29 keys. Eight are this
section's own (MOTIR-4907, 5147, 5438, 5612, 5673, 5676, 5679 and the base's 5480); the other 21 are the
base stylesheet and sprite provenance carried verbatim, which GIVE or TAKE nothing.

| key                             | GIVES / TAKES                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-5679                      | **GIVES** Panels 7a–7d and 8b, the glyph, the subject rule and the copy above. **TAKES** `DecisionApprovalSubjectSummaryDTO` (shipped by MOTIR-5676) and, for the heading, one resolver read per row it chooses to make; amended onto the card |
| MOTIR-5676                      | **nothing either way** — the summary DTO the row reads already ships                                                                                                                                                                           |
| MOTIR-5147 / 5612 / 5438 / 5480 | **nothing either way** — composed, not redrawn                                                                                                                                                                                                 |
| MOTIR-4907                      | the story; its verification recipe's step 4 walks Panel 7a                                                                                                                                                                                     |
| MOTIR-5673                      | this card                                                                                                                                                                                                                                      |

Fixture items use `ACME-n` keys, so they link to nothing.

## The To-approve and Approvals-room rows for a CHOICE (Story MOTIR-4914 · MOTIR-5888 — `approvals-row--choice.mock.html`, DATED 2026-09-21)

A delta of `approvals-row.mock.html`, drawn the way `approvals-row--decision.mock.html` is for the decision kind, from `ApprovalRow`'s emitted markup as `design/approvals/approvals-room.mock.html` carries it. **The rules, the copy table (`workbench.approvals.choice*`, en + zh) and the GIVES/TAKES are in `design/work-items/design-notes.md` § _THE CHOICE PORT_**, beside the port the row opens; this section is the pointer from this area.

- **7a — waiting:** the `choice` type's glyph (lucide `signpost` in `--el-type-choice`), the kind **Choice**, and _{n} options · {question}_. The whole row and its **Review** button open the approval overlay.
- **7b — the Approvals room:** a decided choice's subject line is the STAMP from `chosenOption` — _Chose {label} · {what it was best for}_ — and its state cell is **Chosen** (mint), not _Approved_. One sent back reads _{n} options · none chosen_ with the shipped **Changes requested** pill.
- **7c — dark.** The hue token is declared in the `[data-appearance-scope]` block so it re-resolves in a dark scope.

Built by MOTIR-5897.

## 28 · TO APPROVE SAYS WHAT IS WAITING IN PLAIN WORDS — the row as a sentence, the title as a door, no pager, and an overlay that keeps you in place — MOTIR-5997

> **Landed by MOTIR-6214 from MOTIR-5997's approved design result** (evidence `cmucp2cd00019hwoi9dvnqzpe`,
> published 2026-09-22), verbatim. The result was approved and never committed here, so § 29 and
> `design/ai-planning/design-notes.md` Part XXII cited this section before it existed in this file. Its two
> mocks are not mirrored in this tree: they are read from the design result (`get_design MOTIR-5997`), which is
> the source of truth (`docs/decisions/design-result.md` AMENDMENT 5 Q1).

**Assets (two NEW delta mocks, DATED 2026-09-22):**

| Surface                         | Asset                                                         | Amends                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The To-approve ROW and LIST     | **`design/workbench/approvals-row--plain-words.mock.html`**   | § 20 (`approvals-row.mock.html`) as amended by § 23, § 25 (`approvals-row--one-gate.mock.html`), § 26 (`workbench--live.mock.html`), § 27 (`approvals-row--decision.mock.html`), the choice row and MOTIR-5953's `approvals-row--decision-confirm.mock.html` |
| The approval overlay's EXIT ROW | **`design/workbench/approval-overlay--quick-view.mock.html`** | § 22 _THE EXIT_ (`approval-overlay.mock.html`)                                                                                                                                                                                                               |

Story [MOTIR-5996](motir:cmubvoqk400nuhwoij6vnpfcx), card MOTIR-5997. It is the layout source of truth for
**MOTIR-5998** (the unpaged read), **MOTIR-5999** (the sentence), **MOTIR-6000** (the overlay) and
**MOTIR-6001** (the row's title door), which carry it in `blocked_by`. **No existing mock is edited.**

**Panels.** Row delta: 1 before / after · 2 one awaiting row per registered kind (en) · 3 the same in zh ·
4 the two doors in one row · 5 every row state per kind · 6 unrenderable / subject gone / several documents ·
7 the Approvals room · 8 narrow en + zh · 9 dark · 10 thirty rows, no pager · 11 the ceiling line.
Overlay delta: 1 the exit row before / after · 2 its two doors pointed at · 3 the quick view stacked above
the overlay, loaded · 4 loading · 5 not found · 6 narrow in zh · 7 the frameless arm's _Open work item_.

### Rendered against shipped reality, not redrawn

Rendered at `origin/main` `7a39bd03a` (MOTIR-5871's merge, so the decision-confirmation row is in the base)
through the repo's own vitest + RTL setup:

- `components/approvals/ApprovalRow.tsx` — the BEFORE rows of the row delta's Panel 1, and the markup every
  AFTER row is edited from (the row container, the stretched door, the cells, the class strings);
- `components/ui/Pill.tsx` / `components/ui/Button.tsx` — every pill and the _Review_ button, as they emit;
- `IssueQuickViewPanel` inside `components/ui/Modal` `size="xl"`, exactly as `components/planning/WorkItemQuickView.tsx`
  mounts it — the quick view in all three of its states, dumped from `document.body`;
- § 22 Panel 1's frame bands and exit row, and Panel 4b's empty state, lifted verbatim from `approval-overlay.mock.html`.

The stylesheet is Tailwind v4.3.0 compiled over exactly the classes on each board, with
`packages/design-system/theme.css` and `packages/brand/brand.css`. Nothing is hand-written but the review chrome.

### DECISION 1 — the row LEADS with what is asked, in one sentence around the work item's title

Today the row leads with the plumbing: a kind label (_Design result_, _Pull requests_, _Decision_), then a meta line
(`motir-core · #412`), then — in a second column — the work item. The reader has to translate. After this change
the first cell is **glyph · SENTENCE · key**:

| kind                    | en                                     | zh                          |
| ----------------------- | -------------------------------------- | --------------------------- |
| `design_result`         | Design for **{title}**                 | **{title}**的设计           |
| `acceptance_result`     | Acceptance video for story **{title}** | 故事 **{title}** 的验收视频 |
| `pull_request_approval` | **{title}** is finished                | **{title}**已完成           |
| `decision_approval`     | Decision document for **{title}**      | **{title}**的决策文档       |
| `decision_choice`       | Options for **{title}**                | **{title}**的选项           |
| `decision_confirmation` | **{title}** is decided                 | **{title}**已作出决定       |
| any other kind          | Approval for **{title}**               | **{title}**的审批           |

- **Why these words.** Each is a NOUN PHRASE about the work item, or a statement of its state — never an
  instruction — because the same row renders in the Approvals room's DECIDED section and in its full view, where
  it is somebody else's approval: _"Confirm …"_ would be false once confirmed, and _"… needs your confirmation"_
  is false for every reader but one. **`decision_confirmation` is title-FIRST** (_{title} is decided_,
  parallel to _{title} is finished_) because decision cards are often titled _Decision: …_, and a prefix would
  read _Decision … Decision: …_. **A choice reads _Options for {title}_** because a choice card's title is usually
  its question (_Which export format?_), which an _Options for_ frame carries and an imperative does not.
  **An unregistered kind** gets the neutral _Approval for_ — the build has no word for a kind it does not know.
- **The glyph stays** (the kind's shipped mark and hue, `KindGlyph`). The KIND LABEL goes: the sentence says it.
- **The key follows the sentence**, `font-mono text-xs text-(--el-text-secondary)`, `shrink-0`. It is not a door.
- **Ink.** Frame words `--el-text-secondary`; the title `--el-text` `font-medium`, so the eye lands on WHAT, then
  reads the kind around it. A settled / unrenderable row takes § 20's settled ink (`--el-text-secondary`) on both.
- **Truncation happens INSIDE the title.** The frame words are `shrink-0` and never cut, so _… is finished_ is
  always read; the title is `min-w-0 truncate`. Built as ONE ICU message per kind with a `<title>` tag
  (`t.rich`), so the ORDER is the catalogue's — zh puts the title first in six of seven — and the code never
  concatenates. Each frame segment renders as its own `shrink-0` span.
- **No visible host vocabulary** — no _pull request_, _PR_, _merge request_ or `#<n>` in any row's visible text,
  in either locale (the vocabulary check below).

### DECISION 2 — the DETAILS move into the freed track, and the tracks are re-weighted

The work item left its own column (it is the sentence's subject now), so the second track holds the **DETAILS**
— what the kind already printed after its label. Column header _Work item_ → **Details** / **详情** on the tab and
in both of the Approvals room's section bands.

**The column COUNT is unchanged; the TRACKS are re-weighted**, because the sentence is now the row's main content
and needs the width. At the tab's typical 896px content, 268px of details left _Acceptance video for story_ a
six-character title.

| template                            | before                                     | after                                          |
| ----------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `APPROVALS_GRID_TEMPLATE`           | `minmax(10rem,1fr) 268px 88px 132px`       | **`minmax(12rem,1fr) 220px 88px 132px`**       |
| `APPROVALS_FULL_VIEW_GRID_TEMPLATE` | `minmax(10rem,1fr) 228px 88px 144px 132px` | **`minmax(12rem,1fr) 200px 88px 144px 132px`** |

Per kind, what the details say — the shipped strings except where marked:

| kind / case                                      | details (visible)                                                                                                                                        | `title` attribute (hover)                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `design_result`                                  | _3 files · 9840d00e_ (shipped)                                                                                                                           | —                                                                                                       |
| `acceptance_result`                              | _6 chapters · 1a2b3c4d_ (shipped)                                                                                                                        | —                                                                                                       |
| `pull_request_approval`                          | **_In motir-core, motir-ai_** — the repositories' NAMES (the part after `owner/`), two in full, three or more the first two then _+n more_ (§ 23's rule) | **every member, `owner/name · #n`**, comma-separated — the numbers leave the visible text and live HERE |
| `decision_approval`, one document                | _{heading} · {path}_ (shipped)                                                                                                                           | _{path} at blob {blob}_ (shipped)                                                                       |
| `decision_approval`, none / several / unreadable | **_No decision document_ · _{count} decision documents_ · _Decision document not read yet_** — the `{pr}` is DROPPED                                     | **`owner/name · #n`**                                                                                   |
| `decision_choice`                                | _{n} options · {question}_ (shipped)                                                                                                                     | the question (shipped)                                                                                  |
| `decision_confirmation`                          | _{changes} · supersedes {n} · {decision}_ (shipped)                                                                                                      | the decision (shipped)                                                                                  |
| a DECIDED record (the room)                      | shipped: _on 9840d00e_, the choice's stamp, the confirmation's outcome                                                                                   | shipped                                                                                                 |
| unregistered kind                                | _Motir cannot show this kind yet_ (shipped)                                                                                                              | —                                                                                                       |
| subject gone                                     | _The design this asked about is gone_ (shipped)                                                                                                          | —                                                                                                       |

### DECISION 3 — the work item's TITLE is its own door: the QUICK VIEW

- **The title is a second `<a href="/items/{key}">`** on `z-10`, above the row's stretched door (`z-0`), exactly
  where the work-item cell's link sits today. **Plain primary click → the work item's QUICK VIEW** (`?peek={key}`,
  `usePeekRowClick`'s contract — as a title behaves in `/items`, `/ready` and the board); **modified, middle or
  secondary click → `/items/{key}` in a new tab** (the native `href`).
- **Everywhere else on the row still opens the approval** full screen (§ 22), and _Review_ is still the labelled
  door. The key and the details are NOT doors.
- **Treatment: `hover:underline` and `focus-visible:underline`**, no fill, **no ring of its own** — the row
  already draws `focus-within:ring-2`, and a ring inside a ring is two rings for one focus; the underline says
  which door has it. This is the underline the work-item cell carries today, moved, not a new treatment.
- **Tab order:** the row → the title → _Review_. The row keeps its accessible name (_Review {key} {title}_); the
  title link's name is its text.
- **The Approvals room mounts no quick-view controller today** (`app/(authed)/approvals/page.tsx`) — the title
  door there needs one (MOTIR-6001). The tab's Workbench page has one.

### DECISION 4 — every row state keeps its shipped treatment; only the words it leads with change

Awaiting (_Review_) · see-but-not-decide (_Awaiting_) · settled after a decision in the overlay (§ 20: the
kind's own pill — _Approved_, _Chosen_, _Confirmed_) · settled, sent back (_Changes requested_, _Overturned_) ·
held (§ 26: _Decided elsewhere_, colourless) · arrived (§ 26: _New_, at the end of the sentence cell) · decided
record (the room: decided time, person cell, pill). Row delta Panel 5 draws each, per kind.

**The Decide cell's state pill NEVER WRAPS** (`whitespace-nowrap` on the `Pill`), added on review 2026-09-22.
_Changes requested_ (the longest pill, ≈118px) fits the 132px track on one line. The shipped row lets the
pill shrink inside its `min-w-0` flex cell, so it breaks onto two lines and doubles the row's height. That is
visible today in the shipped tab and in the room. MOTIR-5999 builds it, because it touches that cell.

**⚠️ ONE STATE IS CORRECTED ON THE RECORD — a subject that is gone.** The shipped row sets
`renderable = false` for a null subject, so a gone subject's Decide cell reads **_Not built yet_** — reporting a
SHIPPED kind as unbuilt, the exact collapse § 20 ruled out (_"look alike and are opposite"_). The target (Panel 6):
the row keeps its KIND's sentence (the kind is known; only its subject is not), its details say _The design this
asked about is gone_, and its Decide cell reads **Gone**, colourless (`Pill tone="archived"`). _Not built yet_ stays
for an unregistered kind only. Both still open the overlay (§ 22 Panels 4a / 4b). Built by MOTIR-5999, which
touches exactly this cell.

### DECISION 5 — the To-approve list has NO PAGER, and says so in words if its ceiling is ever reached

- **No `IssueListPager`** under the tab's list. The list ends at its last row (Panel 10: thirty rows). The column
  header is already `sticky top-0`.
- **The ceiling line** (Panel 11): the read keeps a defensive ceiling far above any real queue (its value is
  MOTIR-5998's). When it is reached, ONE line sits inside the list's container under the last row:
  `role="note"`, `border-t border-(--el-border) bg-(--el-surface-soft) px-4 py-2.5 text-xs text-(--el-text-secondary)`,
  the link `font-medium text-(--el-link) hover:underline` to `/approvals`. A note, never an alert — nothing is wrong.
  The strip's count stays the TRUE total, so under the ceiling the count and the rows differ, and the line is what
  says why. **Below the ceiling the count and the rows agree**, as the story requires.
- The Approvals room keeps its own pager (story boundary).

### DECISION 6 — the overlay's EXIT ROW: the title opens the quick view ABOVE it, and _Open work item_ opens a new tab

- **Key + title become ONE link** (`<a href="/items/{key}" aria-haspopup="dialog">`), same position and ink as
  today; `hover:underline` / `focus-visible:underline`, no fill (a fill would make it read as a third exit
  control). **Plain click → the quick view STACKED ABOVE the overlay**; modified click → new tab.
- **The quick view is the NESTED, state-driven `WorkItemQuickView`** (the peek `PlanReviewCanvas` stacks over the
  planning overlay, MOTIR-4185), not the page's `?peek=` controller: only a React-nested dialog layers above a
  Radix modal, and the overlay opens on pages with no controller.
- **⚠️ ITS SCRIM MUST BE RAISED to `z-50`.** The design-system `Modal` draws its scrim at `z-40` and its panel at
  `z-50` (`packages/design-system/src/components/ui/Modal.tsx`), so a SECOND Modal's scrim paints beneath the open
  approval's `z-50` panel and the approval stays at full ink behind the peek. The stacked peek passes
  `overlayClassName="z-50"` (a prop `Modal` already takes; `WorkItemQuickView` needs to forward it). Later in
  the DOM at the same `z`, the scrim covers the approval and sits under the peek's panel — drawn in Panels 3–5.
- **Closing the quick view** (×, `Esc`, its scrim) returns to the approval exactly as it was — not closed, not
  re-read, not scrolled — with focus back on the title link. `Esc` closes only the TOP dialog; a second `Esc`
  closes the approval, as § 22 has it.
- **_Open work item_ opens a NEW TAB** — `target="_blank" rel="noopener noreferrer"` — keeping its label and its
  `ArrowUpRight` (the glyph already reads "this leaves"). **Accessible name: _Open work item in a new tab_** / 在新标签页中打开工作项.
- **The frameless arms' _Open work item_** (§ 22 Panels 4a / 4b — today a `Button` calling `router.push`, which
  navigates the whole tab away) becomes the same new-tab LINK, styled as the shipped secondary `sm` button, with
  the `ArrowUpRight` glyph and the same accessible name — so every _Open work item_ in the overlay behaves one way.
- **Narrow** (§ 22 Panel 7 hides the title below `md`): the door is the LINK, so at that width the KEY — its
  visible content — is what a thumb presses. _Open work item_ is glyph-only there, as shipped.
- **Unchanged:** band 1's kind label, and the dialog's accessible name (`approvalOverlay.dialogTitle`, _{kind} for
  {key}_) — the story's boundary keeps them the frame's.

### Copy — new and changed strings, `en` and `zh`

| key                                                        | en                                                                              | zh                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `workbench.approvals.sentence.design_result`               | `Design for <title>{title}</title>`                                             | `<title>{title}</title>的设计`                                        |
| `workbench.approvals.sentence.acceptance_result`           | `Acceptance video for story <title>{title}</title>`                             | `故事 <title>{title}</title> 的验收视频`                              |
| `workbench.approvals.sentence.pull_request_approval`       | `<title>{title}</title> is finished`                                            | `<title>{title}</title>已完成`                                        |
| `workbench.approvals.sentence.decision_approval`           | `Decision document for <title>{title}</title>`                                  | `<title>{title}</title>的决策文档`                                    |
| `workbench.approvals.sentence.decision_choice`             | `Options for <title>{title}</title>`                                            | `<title>{title}</title>的选项`                                        |
| `workbench.approvals.sentence.decision_confirmation`       | `<title>{title}</title> is decided`                                             | `<title>{title}</title>已作出决定`                                    |
| `workbench.approvals.sentence.other`                       | `Approval for <title>{title}</title>`                                           | `<title>{title}</title>的审批`                                        |
| `workbench.approvals.columns.details`                      | Details                                                                         | 详情                                                                  |
| `approvalRecords.columns.details`                          | Details                                                                         | 详情                                                                  |
| `workbench.approvals.pullRequest.repos`                    | In {repos}                                                                      | 位于 {repos}                                                          |
| `workbench.approvals.pullRequest.more` (shipped)           | +{count} more                                                                   | 另有 {count} 个                                                       |
| `workbench.approvals.decisionSubject.none` (changed)       | No decision document                                                            | 无决策文档                                                            |
| `workbench.approvals.decisionSubject.several` (changed)    | {count} decision documents                                                      | {count} 份决策文档                                                    |
| `workbench.approvals.decisionSubject.unreadable` (changed) | Decision document not read yet                                                  | 尚未读取决策文档                                                      |
| `workbench.approvals.subjectGonePill`                      | Gone                                                                            | 已移除                                                                |
| `workbench.approvals.ceiling`                              | `Showing the first {shown} of {total}. <link>Approvals</link> lists every one.` | `仅显示前 {shown} 项，共 {total} 项。<link>审批</link>中列出了全部。` |
| `approvalOverlay.openWorkItemNewTab`                       | Open work item in a new tab                                                     | 在新标签页中打开工作项                                                |

- The repositories list joins with `, ` in en and `、` in zh; _+n more_ joins with `, ` / `，`.
- **The hover `title` strings are DATA** (`owner/name · #n`) and need no key.
- **Retiring from the row** (MOTIR-5999 decides each by grep): `workbench.approvals.pullRequest.kindLabel`,
  `workbench.approvals.rowKind.decision_approval`, and the row's use of `workbench.approvals.kind.*`.
  **`workbench.approvals.kind.*` itself STAYS** — the overlay's `dialogTitle` reads it (_{kind} for {key}_).
- The user doc `docs/approval-gates.md` names the rows by their old labels; its update is MOTIR-5999's.

### Token map — the elements this delta adds

| element                      | colour                                                                            | shape / type                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| sentence frame words         | `--el-text-secondary` (6.24:1 on the `--el-surface` hover fill)                   | `text-sm`, `shrink-0`                                                                  |
| sentence title (the door)    | `--el-text`; settled `--el-text-secondary`                                        | `text-sm font-medium`, `min-w-0 truncate`, `hover:underline` `focus-visible:underline` |
| key after the sentence       | `--el-text-secondary` (mono)                                                      | `font-mono text-xs`                                                                    |
| details cell                 | `--el-text-secondary`                                                             | `text-xs`, `truncate`                                                                  |
| _Gone_ pill                  | the shipped `Pill tone="archived"`                                                | —                                                                                      |
| every Decide-cell state pill | the shipped `Pill` recipes, unchanged                                             | **`whitespace-nowrap`** — one line in the 132px track                                  |
| ceiling line                 | `--el-text-secondary` on `--el-surface-soft`, top `--el-border`; link `--el-link` | `text-xs`, `px-4 py-2.5`                                                               |
| exit-row title link          | unchanged inks; underline on hover / focus                                        | —                                                                                      |
| stacked quick view's scrim   | `--el-overlay-scrim`                                                              | **`z-50`** (via `overlayClassName`)                                                    |

No raw hex and no raw shape utility in either delta.

### The vocabulary check — command and count

Visible text = each mock with its `<style>` blocks, HTML comments and tags stripped; searched case-insensitively
for `\b(pull requests?|PRs?|merge requests?|MRs?|issues?|cards?|tickets?)\b`:

| asset                                    | hits | disposition                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `approvals-row--plain-words.mock.html`   | 1    | Panel 1's **BEFORE** row — the shipped _Pull requests_ label, drawn as the text being RETIRED. Every AFTER row, every sentence and every annotation: **0**                                                                                                                           |
| `approval-overlay--quick-view.mock.html` | 8    | all inside the COMPOSED shipped quick view (Panels 3 and 6): its Development empty state, _No linked pull request_ · _+ Link pull request_ · _PR_ ×2, twice. The quick view's contents are outside this story's boundary. The exit row, the new-tab name and every annotation: **0** |

### What this asset does NOT decide

- **The ceiling's VALUE** — MOTIR-5998's.
- **The overlay's bands, ports, verbs and record bands**, band 1's kind label and the dialog's accessible name.
- **The quick view's contents and its edit rail** — composed as shipped. **Its own _Open full page_ keeps
  its shipped behaviour — the work item's page, in THIS tab — and that is DECIDED, not deferred:** the label
  says it leaves, and leaving loses nothing, because the overlay's open state IS its address (§ 22 _THE
  ADDRESS_, written with `shallowPush`): one Back returns to the tab with the same approval open. _Open work
  item_ in the exit row is different because it sits beside the decision and reads as a glance, which is
  why it, and not the peek's page link, opens a new tab.
- **The Approvals room's structure** — its sections, person column and pager.

### GIVES / TAKES — every card this asset names

Scope: every `MOTIR-<n>` in this section and in both deltas' annotation prose. Fixture rows use `ACME-n` keys and
link to nothing.

| card                                                     | GIVES                                                                                                                                                                                                                        | TAKES                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MOTIR-5998** (the unpaged read)                        | DECISION 5: no pager on the tab, the ceiling line, its copy and tokens                                                                                                                                                       | Nothing — the ceiling's value stays its own                                                                                                                                    |
| **MOTIR-5999** (the sentence)                            | DECISIONS 1, 2, 4: the sentence per kind, the details column and its per-kind strings, the re-weighted templates, the header rename in both lists, the _Gone_ correction, the copy table, the retirements, the user doc      | **ELEMENT:** the grid templates change (`APPROVALS_GRID_TEMPLATE` / `APPROVALS_FULL_VIEW_GRID_TEMPLATE`) — its card said "the row's column set"; this settles it               |
| **MOTIR-6001** (the row's title door)                    | DECISION 3: the title link, its click contract, treatment and tab order; the room's missing controller                                                                                                                       | Nothing                                                                                                                                                                        |
| **MOTIR-6000** (the overlay)                             | DECISION 6: the exit row's title door, the stacked nested quick view, **the `z-50` scrim** (a `WorkItemQuickView` prop to forward), the new-tab _Open work item_ in the exit row AND the frameless arms, the accessible name | **ELEMENT:** the scrim layering is a build obligation its card did not name                                                                                                    |
| **MOTIR-6002 / MOTIR-6003** (the story's gates)          | The strings and states to assert: every sentence in en + zh, the details' host-free text, _Gone_, the ceiling, the new-tab name                                                                                              | Nothing                                                                                                                                                                        |
| **MOTIR-5961** (the decision-confirmation row) · `done`  | Nothing                                                                                                                                                                                                                      | **ELEMENT:** its kind label _Confirm decision_ is superseded on the row by the sentence _{title} is decided_; its subject line survives as the details. `done` — not re-opened |
| **MOTIR-5953 / 5147 / 5480 / 5612 / 5673 / 5888 / 5222** | Nothing                                                                                                                                                                                                                      | Nothing — composed; their mocks are records and are not edited                                                                                                                 |
| **MOTIR-5302** (the one row)                             | Nothing                                                                                                                                                                                                                      | Nothing — the room inherits by rendering the same row, which is the point of the extraction                                                                                    |
| **MOTIR-4185** (the nested peek)                         | Nothing                                                                                                                                                                                                                      | Nothing — its pattern is reused                                                                                                                                                |

## 29 · The To-approve ROW for a PLAN — MOTIR-6033

> **Landed by MOTIR-6214 from MOTIR-6033's approved design result** (evidence `cmueg6bue00kghwoikl5e6bxp`),
> verbatim but for one reference: the result says Part XX, and the Part landed as **Part XXII** (MOTIR-6190;
> that Part's head note records why). Its mock is not mirrored in this tree (`get_design MOTIR-6033`).

**Asset:** `design/workbench/approvals-row--plan.mock.html`, a new delta mock. It amends
`approvals-row.mock.html` (§ 20) as the shipped `ApprovalRow` renders it after § 28's sentence.
Neither file is edited. **The rules, the states, the copy table (`approvalGate.planApproval.*`, en
and zh) and the GIVES/TAKES are in `design/ai-planning/design-notes.md` Part XXII**, beside the
decision surface the row opens. This section is only the pointer from this area.

- **Panel 1:** the four leading-line forms. A plan is ABOUT its target (_Plan for {title}_ + key),
  else its title (_Plan — {title}_), else its project (_Plan for {project}_), with lucide
  `sparkles` in `--el-accent-on-surface`.
- **Panel 2:** awaiting · **Being rewritten** (sky; the §11.5c hold, **not** § 26's _held_ row) ·
  see but not decide · settled _Approved_ / **_Declined_** (peach).
- **Panel 3:** Approvals-room records: declined with and without a reason, withdrawn
  `plan_stale` / `plan_discarded`.
- **Panel 4:** the access path. **This kind never opens the approval overlay**
  (`approval-gates.md` §11.5b): the row returns the person to the planning surface
  (`planSession`, `planVia=approvals`), or to `/plans/<id>` when the plan has no conversation.
- **Panels 5–6:** narrow, zh, dark.

Built by MOTIR-6037.

## 30 · TO FIX — the tab for work that is stuck until something is repaired — MOTIR-6599

**Asset:** `design/workbench/workbench--to-fix.mock.html`, a new delta mock (Story
[MOTIR-6588](motir:cmujrd23n012di0txbtqxfr63), card
[MOTIR-6599](motir:cmujrd30l0130i0txysh4flmo)). No existing mock is edited.

**It AMENDS:**

- **§ 21** — the strip gains a sixth tab, second, and the landing cascade gains a rung.
- **§ _Layout_** (the row anatomy, `workbench.mock.html`) — on this tab only, the row gains a second
  line, the FIX LINE. Line 1 is unchanged.
- **§ 26** (`workbench--live.mock.html`) — the held-row rule, scoped until now to the To-approve queue,
  now also covers To fix.
- **§ _The CI badge_** (`workbench--ci-badge.mock.html`) — **not changed**. This section says how the
  badge and the new reason line differ, because they sit on the same row.

**Panels:** 1 the strip and the cascade · 2 the populated tab, one row per reason, plus the
acceptance-video variant · 3 a repaired row HELD · 4 the empty tab · 5 page 2 with the pager · 6 zh.

### What the tab is

**To fix lists the reader's work items that are stuck until something is repaired**, one row per
work item. Membership is the same assigned-OR-reported rule every personal tab uses (MOTIR-4781). A
card is on To fix exactly when its stored `fixReason` is non-null (MOTIR-6600). **To fix is carved OUT
of In progress:** a card is on exactly one of the two, and the In progress count drops by what moved.

The tab names something the READER must do, like To approve and unlike the four state tabs. That
is why it sits beside To approve, and why it follows To approve's live rule (below) rather than the
work tabs'.

### Panel 1 — the STRIP and the CASCADE (amends § 21)

**Strip order:** **To approve · To fix · In progress · To do · Recently finished · Watching.** Glyphs
travel with their tabs; To fix takes lucide **`Wrench`**.

**The count is the shipped count chip** (`--el-count-bg` / `--el-count-text`), the same chip every tab
wears. The card asked for _"the attention count To approve uses"_: on `origin/main` To approve has no
count style of its own (`WorkbenchTabs.tsx` renders one chip for all tabs), so there is no second
treatment to borrow, and inventing one for two tabs would create one. The suppress-all-while-all-zero
rule is unchanged and now counts six.

**Width.** Rendered at 1200, the six-tab track measures about **812px**, inside the 894px content box.
At `< md` the strip already scrolls (§ _Narrow_), so that verdict stands.

**THE LANDING CASCADE — four rungs:**

> **`/workbench` with no known `?tab=` resolves to: To approve** if its count is non-zero → **else To
> fix** if its count is non-zero → **else In progress** if its count is non-zero → **else To do**
> (TERMINAL, landed on even when empty).

§ 21's four properties hold with one word changed: the cascade reads **four** tabs, and Recently
finished and Watching are still never landed on. An explicit `?tab=` still wins. Its input is still
the strip's counts, now including `toFix`. The strip order and the cascade order are still the
same: the first four tabs are the four rungs.

**Why To fix is second and not first.** An unmade decision holds up someone else's card. A stuck card
is the reader's own. It still sits ahead of In progress, because a stuck card does not move until
somebody acts on it, while an in-progress one is already moving.

| tab         | its one address                                             |
| ----------- | ----------------------------------------------------------- |
| To approve  | `/workbench?tab=approvals`                                  |
| **To fix**  | **`/workbench?tab=to-fix`** (new — slug and label the same) |
| In progress | `/workbench?tab=in-progress` (now minus every to-fix card)  |
| others      | unchanged                                                   |

### Panel 2 — the ROW: line 1 unchanged, and a FIX LINE

**Line 1 is `WorkbenchList`'s row, byte for byte:** kind glyph, key, title, the CI badge glyph, Your
role, Assignee, Status, in `minmax(10rem,1fr) 96px 140px 108px`. **Line 2, the FIX LINE,** spans every
column. It is indented to the title's left edge (16px glyph + 8px gap = 24px past the cell), `text-xs`,
and sits 10px above the row's bottom border. The row is no longer 44px on this tab: it is 44px plus
the fix line. Other tabs are untouched.

**Left: WHY — one reason.** A glyph and a sentence.

| `fixReason`         | glyph (ink)                          | en                                                               |
| ------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| `queue_failed`      | `CircleX` (`--el-danger-on-surface`) | Failed in the merge queue · **`<check>`**                        |
| `conflicted`        | `CircleX` (`--el-danger-on-surface`) | Conflicts with **`<base>`**                                      |
| `ci_failed`         | `CircleX` (`--el-danger-on-surface`) | CI failed · **`<check>`**                                        |
| `changes_requested` | `Undo2` (`--el-icon-muted`)          | Changes requested by **`<name>`** — “`<first line of the note>`” |

These are the glyph and ink pairings `RepairFixPart` already uses for the same conditions: the
failing lines take `CircleX` in danger-on-surface, and the sent-back line takes `Undo2`, muted,
because _a refusal is not a failure_. The check name and the base branch are set in `font-mono`, bold.
The note is truncated at about 34ch with an ellipsis, and the full note is one click away on the card.

**When a card delivers more than one pull request,** a secondary-ink clause follows the reason:
**`· 2 of 3 pull requests affected`**. It is drawn only when `total > 1`.

**Right: WHAT REPAIRS IT.** A command chip followed by the copy icon-button, right-aligned so the
commands form a column you can scan.

- **The command comes from `fixDetail.repair`, never from the reason.** `fix` ⇒ `motir fix <KEY>`;
  `run` ⇒ `motir run <KEY>`. A reviewer's Request changes on the approve-to-merge gate is `run`: the
  next run's prompt carries the note. A story's acceptance video sent back with _Re-run_ is also stored
  as `changes_requested`, with `gate: 'acceptance_result'`, and is `fix`, because `motir fix` claims
  it. Panel 2's variant row draws that case.
- **The chip** is the shipped inline-code recipe: `--el-code-bg` / `--el-code-text`, `--radius-control`,
  `--spacing-tooltip-x/y`, `font-mono`.
- **The copy button** is `ReadyList`'s icon-button (`--height-control` square, `--radius-control`,
  `--spacing-icon-btn`, `Copy` 16px). **On this tab it is always visible, not revealed on hover.** The
  command is the answer the row exists to give, and on a touch screen a hover-only button cannot be
  reached at all. It sits above the row's stretched link (`z-10`), so pressing it copies the command
  and does not open the card. On success it shows the `ready` toast pattern: _Copied_ / _Paste {command}
  into your terminal._

**The reason line is NOT the CI badge, and the two must not be read as one signal.** The badge is a
GLYPH about the checks at the card's current head, drawn on every tab by the unchanged rule: failing
and running draw, passing and done draw nothing. The reason line is a SENTENCE naming why the card is
stuck and what to type. They agree only on `ci_failed`, where both appear: the badge says the checks
are red, and the line names the failing check and the repair. A conflicted, queue-failed or sent-back
card usually has GREEN checks, so it carries no badge and is still on this tab. That is the point of
this tab, and why the line never rests on colour.

**Order.** Reason priority first (`queue_failed` → `conflicted` → `ci_failed` → `changes_requested`),
then the work tabs' shipped `READY_KIND_RANK` within a reason, then `id`. The page boundary must be
exact, so the read orders and the client never re-sorts (§ _The ORDER_).

### Panel 3 — a repaired row is HELD (extends § 26)

**§ 26's rule, unchanged in wording: A NUDGE ADDS AND UPDATES. IT NEVER REMOVES.** Until now it applied
only to To approve, and `WorkbenchList` deliberately does not hold rows on the work tabs, because a
card moving To do → In progress is the list being correct. **To fix joins To approve,** for § 20's
reason: the reader is working DOWN this list, and a row vanishing under the cursor is the most
expensive thing a queue can teach.

- The strip count drops at once (3 while four rows are on screen). The count is about what is to fix,
  and a held row is a receipt, not a member.
- The held row keeps its position. Its title and reason go `--el-text-secondary`, its glyph is dropped,
  and **its command and copy button are replaced by the colourless chip _Cleared_** (§ 26's recipe:
  `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary`). It still opens.
- The next load omits it: a tab switch, a pager move, a reload.

**Why _Cleared_, not _Repaired_ or _Fixed_.** The nudge carries no content, so the surface knows that
the card LEFT the set, not why. A green push, a resolved conflict, a new commit after changes were
requested, a card reaching done, and an archive all clear it. _Repaired_ would claim a fix in the case
where the card was simply archived. This is § 26's _Decided elsewhere_ reasoning: say the true thing,
and let the card show the record.

**An ARRIVAL** takes § 26's `New` chip on line 1, unchanged. Here it lands at its ordered position.

### Panel 4 — the EMPTY state

The shipped `EmptyState`: `Wrench` at 48px in `--el-icon-muted`, the serif title, and the
`--el-text-subtitle` body. **No action**, by § _Empty states_' own rule: nothing a reader can press
makes a repair appear. A reader sees this state only by asking for `?tab=to-fix`, because the cascade
skips an empty To fix.

### Panel 5 — more than one page

The shipped `IssueListPager`, the last row inside the list box, with its range line and numbered
buttons, as on every tab (§ _The pager_). Nothing is re-specified.

### Panel 6 — zh

The strip, the four reasons, the affected clause, the empty state, the held chip and the toast, all
drawn in Chinese. Commands, check names and branch names are never translated.

### `fixDetail` — what each row reads (the contract with MOTIR-6600)

`fixReason`: `queue_failed | conflicted | ci_failed | changes_requested`. When several conditions
hold, the first in that order is stored. `fixDetail` (JSON):

| field          | used by                     | meaning                                                                                                              |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `repair`       | every row                   | `'fix'` ⇒ `motir fix <KEY>`; `'run'` ⇒ `motir run <KEY>`. **The only source of the command.**                        |
| `check`        | `queue_failed`, `ci_failed` | `ci_failed`: the first failing check's name (sorted). `queue_failed`: the queue's failing check name, else `null`    |
| `queueReason`  | `queue_failed`              | GitHub's raw reason (`CI_FAILURE`, `CI_TIMEOUT`, `MERGE_CONFLICT`, …). Humanised when `check` is `null` (keys below) |
| `base`         | `conflicted`                | the base branch. `null` ⇒ _Conflicts with its base branch_                                                           |
| `reviewerName` | `changes_requested`         | who decided (`decidedByLabel`). `null` ⇒ _Changes requested_                                                         |
| `notePreview`  | `changes_requested`         | first non-empty line of the note, ≤ 140 chars. `null` ⇒ the sentence ends after the name                             |
| `gate`         | `changes_requested`         | `'pull_request_approval'` or `'acceptance_result'`, for reading only; the command still comes from `repair`          |
| `affected`     | every row                   | the number of failing open pull requests                                                                             |
| `total`        | every row                   | the number of open pull requests. The affected clause is drawn only when `total > 1`                                 |

**Fallback order for `queue_failed`:** `check` → the humanised `queueReason` → the bare sentence.

### Copy — every new string, `en` and `zh` (namespace `workbench.*`)

| key                                                | `en`                                                                                                                                           | `zh`                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `workbench.tabs.toFix`                             | To fix                                                                                                                                         | 待修复                                                                                   |
| `workbench.empty.toFix.title`                      | Nothing to fix                                                                                                                                 | 没有需要修复的工作                                                                       |
| `workbench.empty.toFix.body`                       | When a merge queue, a conflict, a failing check or a reviewer stops one of your work items, it shows up here with the command that repairs it. | 当合并队列、冲突、未通过的检查或审阅者卡住你的某个工作项时，它会带着修复命令显示在这里。 |
| `workbench.toFix.reason.queueFailed`               | Failed in the merge queue · {detail}                                                                                                           | 在合并队列中失败 · {detail}                                                              |
| `workbench.toFix.reason.queueFailedBare`           | Failed in the merge queue                                                                                                                      | 在合并队列中失败                                                                         |
| `workbench.toFix.queueReason.CI_FAILURE`           | checks failed                                                                                                                                  | 检查未通过                                                                               |
| `workbench.toFix.queueReason.CI_TIMEOUT`           | checks timed out                                                                                                                               | 检查超时                                                                                 |
| `workbench.toFix.queueReason.MERGE_CONFLICT`       | merge conflict                                                                                                                                 | 合并冲突                                                                                 |
| `workbench.toFix.queueReason.INVALID_MERGE_COMMIT` | no merge commit could be built                                                                                                                 | 无法构建合并提交                                                                         |
| `workbench.toFix.reason.conflicted`                | Conflicts with {base}                                                                                                                          | 与 {base} 冲突                                                                           |
| `workbench.toFix.reason.conflictedNoBase`          | Conflicts with its base branch                                                                                                                 | 与其目标分支冲突                                                                         |
| `workbench.toFix.reason.ciFailed`                  | CI failed · {check}                                                                                                                            | CI 未通过 · {check}                                                                      |
| `workbench.toFix.reason.ciFailedBare`              | CI failed                                                                                                                                      | CI 未通过                                                                                |
| `workbench.toFix.reason.changesRequested`          | Changes requested by {name} — “{note}”                                                                                                         | {name} 要求修改 ——“{note}”                                                               |
| `workbench.toFix.reason.changesRequestedNoNote`    | Changes requested by {name}                                                                                                                    | {name} 要求修改                                                                          |
| `workbench.toFix.reason.changesRequestedAnon`      | Changes requested                                                                                                                              | 已要求修改                                                                               |
| `workbench.toFix.affected`                         | {affected} of {total} pull requests affected                                                                                                   | {total} 个拉取请求中有 {affected} 个受影响                                               |
| `workbench.toFix.copyAria`                         | Copy the repair command for {key}                                                                                                              | 复制 {key} 的修复命令                                                                    |
| `workbench.toFix.copyTooltip`                      | Copy <cmd>{command}</cmd>                                                                                                                      | 复制 <cmd>{command}</cmd>                                                                |
| `workbench.toFix.toast.title`                      | Copied                                                                                                                                         | 已复制                                                                                   |
| `workbench.toFix.toast.body`                       | Paste {command} into your terminal.                                                                                                            | 请将 {command} 粘贴到终端。                                                              |
| `workbench.live.cleared`                           | Cleared                                                                                                                                        | 已解除                                                                                   |

Unmatched `queueReason` values fall to `queueFailedBare`. These are drafts for the catalog: MOTIR-6605
owns the `en` + `zh` entries, with MOTIR-6604 owning `tabs.toFix` if it lands first.

### Token map — this section's own elements

| Element                 | Colour                                                          | Shape                                                                 |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| the `Wrench` tab glyph  | `--el-tabnav-active` / `--el-text-faint` (the shipped pair)     | `h-3.5 w-3.5`                                                         |
| the To fix count        | `--el-count-bg` · `--el-count-text` (shipped)                   | `--radius-badge` · `--spacing-chip-x`                                 |
| failing-reason glyph    | `--el-danger-on-surface`                                        | 14px                                                                  |
| changes-requested glyph | `--el-icon-muted` (decorative, `aria-hidden`)                   | 14px                                                                  |
| reason text             | `--el-text`; check / base / name bold                           | `text-xs`                                                             |
| affected clause         | `--el-text-secondary`                                           | `text-xs`                                                             |
| command chip            | `--el-code-bg` · `--el-code-text`                               | `--radius-control` · `--spacing-tooltip-x/y`                          |
| copy button             | `--el-text-secondary`, hover `--el-text` on `--el-surface-soft` | `--height-control` square · `--radius-control` · `--spacing-icon-btn` |
| held row ink            | `--el-text-secondary` (AA on the `--el-surface` hover fill)     | —                                                                     |
| the `Cleared` chip      | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary`     | `--radius-badge` · `--spacing-chip-x/y`                               |
| empty-state glyph       | `--el-icon-muted`                                               | 48px                                                                  |

No `--el-text-muted` or `--el-text-faint` carries text anywhere on the row, because its hover fill is
`--el-surface`. There are no raw hues and no raw shape utilities.

### Which card builds which panel

| card                                       | builds                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-6600** (`fixReason` + `fixDetail`) | the data every row reads — the table above                                                                                                                                                    |
| **MOTIR-6604** (the read)                  | `to-fix` in `WORKBENCH_TABS` (second) and its `?tab=` spelling · `HOME_SLICE_TO_FIX` and In progress minus it · the `toFix` count · the cascade's new rung · the ORDER above                  |
| **MOTIR-6605** (the UI)                    | panels 1–6: the strip entry and glyph, the fix line, the copy button and toast, the held `Cleared` row (To fix joins § 26's hold), the empty state, the pager mount, every `en` + `zh` string |
| **MOTIR-6602 / MOTIR-6603**                | nothing drawn. They keep the stored reason true, which is what makes a live re-read hold the right row                                                                                        |
| **MOTIR-6606 / MOTIR-6607**                | the assertions: four rows with their reasons and commands, none on In progress, the landing, the held row after a green push, zh                                                              |

### GIVES / TAKES

| card                          | GIVES                                                                                                                          | TAKES                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **MOTIR-6604**                | STRUCTURE: the strip position, the address, the four-rung cascade, the order. PREMISE: To fix and In progress partition.       | Nothing.                                                                                         |
| **MOTIR-6605**                | ELEMENT: the fix line, the chip, the copy button, `Cleared`, the empty state. STRUCTURE: line 2 spans every column; hold rule. | Nothing.                                                                                         |
| **MOTIR-6600**                | PREMISE: the command is `fixDetail.repair`; the `check → queueReason → bare` fallback; the `total > 1` rule.                   | Nothing. Field names are its own.                                                                |
| **MOTIR-5216 / § 21**         | Nothing new.                                                                                                                   | **The strip order and the cascade** — amended, not re-opened: one tab and one rung inserted.     |
| **MOTIR-5239 / § 26**         | Nothing new.                                                                                                                   | **The hold's scope** — widened from To approve to To approve and To fix; the rule's words stand. |
| **MOTIR-5471** (the CI badge) | Nothing.                                                                                                                       | Nothing — the badge is composed unchanged beside the new line.                                   |
| **MOTIR-5460** (`motir fix`)  | Nothing.                                                                                                                       | Nothing. The tab shows the command; what `motir fix` claims is its own.                          |

### What this does NOT decide

- **How a to-fix card LOOKS elsewhere.** The To fix tag on `/items`, board and quick-view rows, and the
  banner on the item page, are [MOTIR-6589](motir:cmujrd26p012ei0tx3j8fmlhn)'s design (MOTIR-6608).
  Its tag reads the same `fixReason`; nothing here draws it.
- **A card whose run DIED.** That is not a reason here. It joins as a fifth reason with
  `motir continue <KEY>` in [MOTIR-6590](motir:cmujrd295012fi0tx2myssohp). The fix line has room for it,
  because its command comes from `repair`.
- **Neutral and setting-blocked queue outcomes.** They wait on a person's approval and stay on To
  approve.
- **What `motir fix` claims**, a workspace-wide list, and notifications.
- **The Development section's own fix part** (`RepairFixPart`) on the item page. This tab borrows its
  glyphs and inks and does not change it.

## 31 · TO FIX · RUN DIED — the fifth reason, sorted first — MOTIR-6878

> **State 3 RETIRED by MOTIR-7590 (§ 34).** A leg of a dead parent run no longer has a To fix row of its
> own: it is a member of its run's ONE entry.

**Asset:** `design/workbench/workbench--to-fix--run-died.mock.html`, a new delta mock (card
MOTIR-6878). No existing mock is edited.

**It AMENDS § 30** (`design/workbench/workbench--to-fix.mock.html`, MOTIR-6599's approved To fix tab):
the tab gains a fifth `fixReason`, **`run_died`**, and the empty state's body names five causes. Line 1
of the row, the strip, the cascade, the pager, the held-row rule and the four shipped reasons are
unchanged. The sheet's stylesheet is § 30's three style blocks verbatim plus one delta block.

**It POINTS AT, and redraws neither:**

- the **run-died marker** — MOTIR-6529, `design/runs/run-section--run-died.mock.html`,
  `design/runs/design-notes.md` § _Run died_ (D1–D8). The row's words come from it, and the row opens
  the card, where the marker is.
- the **Continue hosted control** — MOTIR-6789, `design/runs/development--continue-hosted.mock.html`
  panels C1–C7, § _Continue hosted_. The row places the shipped control (`ContinueHostedDoor` =
  `HostedModelPicker` + a primary `Button` with `Cloud`) as it renders today; its `cc-` rules are copied
  verbatim from that sheet. Starting and every refusal are C4–C5's own states; this section only says
  where they sit in a row.

**States drawn:** 1 pushed, own run · 2 pushed, several repositories (and the worst-case truncation) ·
3 a child of a parent run · 4 nothing pushed · 5 the viewer may not edit · 6 Continue hosted starting,
refused before it starts, refused because somebody else took it · 7 continued → HELD, the count
dropping · 8 died again during a continue · the empty tab (en + zh) · the six ways a run dies · zh.

### Where it sorts — FIRST

**`FIX_REASON_PRIORITY` becomes `run_died` → `queue_failed` → `conflicted` → `ci_failed` →
`changes_requested`.** The To fix list therefore sorts a dead-run card ABOVE all four pull-request
reasons, the stored reason is `run_died` whenever it holds alongside any of them, and the filter editor
(which maps over the same tuple) lists _Run died_ first.

**Why first:** nothing else on the card can be repaired until somebody owns its branch again. A
dead run leaves the card In Progress, assigned to someone who is no longer working on it, with its work
on a branch no agent holds. `motir fix` and `motir run` both need that branch owned; a red check or a
conflict on it is fixed BY the continue, which merges the latest `main` and finishes the work in one
pull request. Repairing the pull-request reason first would put a second agent on a branch the dead run
may still have unpushed intent for. So the dead run is the first thing to repair, and the one a reader
should meet first.

### The row's facts — `getContinueView`, exactly

The row reads the view the marker and the claim read (`lib/services/workItemContinueService.ts`), so the
row never offers a repair the claim would refuse:

| row element                    | field                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| _last heard from &lt;when&gt;_ | `deadRun.lastHeardAt` — relative (`relativeLabel`), the instant (`formatRunInstant`) in `title`                                   |
| _&lt;who&gt;_                  | `deadRun.dispatcher.name`; the `…NoName` sentence when it is null (a deleted account)                                             |
| _branch &lt;branch&gt;_        | `branch` (= `branches[0]`, the primary repository's)                                                                              |
| _+ N more repositories_        | `branches.length − 1`, drawn only when `branches.length > 1`; the clause's `title` lists each `repository · branch`               |
| _nothing was pushed_           | `branches` empty (`refusal === 'no_branch'`)                                                                                      |
| the card to continue           | the row's own key, or `parentKey` when `refusal === 'continue_the_parent'`                                                        |
| whether the control shows      | the door rule (`_view.tsx`'s `hostedDoor`: edit permission, not archived, not done) and `refusal ∈ {null, 'continue_the_parent'}` |

**When the reason holds (the premise given to MOTIR-6880):** the view is `died` and its `refusal` is
`null`, `continue_the_parent` or `no_branch`. `use_fix` (the card is Implemented or later: a pull request
is open and its checks decide) and `not_in_progress` are NOT `run_died` — the first falls to the four
pull-request reasons, the second has nothing to repair. `alive`, `none` and `continuing` clear it.

### The glyph — lucide `TriangleAlert`, in `--el-icon-muted`

The reason glyph for `run_died` is **`TriangleAlert`** (lucide-react, already shipped in
`ContinuePart.tsx`), **14px, `--el-icon-muted`, `aria-hidden`**.

- It is **the marker's own glyph**: the marker's _Run died_ pill and its reason line both wear
  `TriangleAlert`, and the reason line's ink is `--el-icon-muted`. The row opens the card on exactly
  that marker, so the two read as one signal.
- It is **not `CircleX`**, which § 30 gives to the three failing pull-request reasons. Nothing about the
  work failed: the run stopped and the work is kept (the run area's _unknown is not failed_ tone). A red
  cross would say the opposite.
- It is **not `Undo2`**: nobody refused anything.
- `--el-icon-muted`, not `--el-warning`, because the row never rests on colour (§ 30): the sentence
  starts with the words _Run died_, and priority, not ink, puts the row first.

### Which repair leads — Continue hosted, and the command keeps the right edge

The fix line carries both repairs, in this order: **the Continue hosted control first, the copyable
command `motir continue <KEY>` second, at the right edge.**

- **Continue hosted leads.** It is first in reading order and the row's only filled control — C1's
  decision (_the story exists for the person with no terminal_) carried onto the row.
- **The command keeps the right edge.** Every other To fix row ends in its command chip and copy
  button; keeping `motir continue` there keeps that column scannable down the whole list.
- **The command is the fix line's own command part** — § 30's chip (`--el-code-bg` / `--el-code-text`)
  and always-visible copy icon-button, with the same `copyAria`, `copyTooltip` and _Copied_ toast. It is
  the row-sized form of `RepairFixPart`'s command part; the full `CopyableCodeBlock`, with its language
  bar, is the marker's.
- **Width.** Measured against the 894px content box: the reason (~500px at 12px) plus the picker
  (15rem), the button (~140px) and the command (~200px) do not fit one line, so the repairs WRAP onto a
  third line, right-aligned — the fix line's shipped `flex-wrap`, no new rule. Both sit in one
  `relative z-10` group above the row's stretched link, so pressing either does not open the card. Below
  ~620px the door wraps once more inside itself (its own `flex-wrap`: the button drops under the
  picker), as C1's ~400px panel shows.

### The eight states

| state                          | line 2 reads                                                                                                                          | repairs                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1 pushed, own run              | _Run died · last heard from 12 min ago · Mara S. · branch `subtask/ACME-14-throttle`_                                                 | Continue hosted · `motir continue ACME-14`                                           |
| 2 several repositories         | the primary branch, then _+ 2 more repositories_ (secondary, never truncates); the branch cuts at 32ch, then the sentence as one span | the same two — a continue resumes every repository's branch                          |
| 3 child of a parent run        | the parent's session branch, then _Part of **ACME-12**’s run — both repairs continue the whole run_                                   | **Continue ACME-12 hosted** (`hosted.buttonParent`) · `motir continue ACME-12`       |
| 4 nothing pushed               | _… · nothing was pushed_                                                                                                              | neither; the marker's own **start-over** line in the command's place                 |
| 5 viewer may not edit          | the reason, unchanged                                                                                                                 | neither; _You can’t edit this work item, so someone who can has to continue it._     |
| 6 starting / refused           | unchanged                                                                                                                             | C4a in place of the door; C5c's notice under the repairs; C5a's notice on a HELD row |
| 7 continued → held             | the reason in `--el-text-secondary`, no glyph                                                                                         | `Cleared` (§ 26 / § 30); the count drops at once                                     |
| 8 died again during a continue | the same sentence, naming the **continuing** run's dispatcher and its last-heard time                                                 | the same two; the row arrives with § 26's `New` chip, first                          |

- **State 4 reuses MOTIR-6529's copy, not new copy:** `github.development.continue.startOver` —
  _Start over instead: set **ACME-16** to To Do and run it again._ — in the marker's `Note` ink
  (`text-xs`, `--el-text-secondary`). A command the claim would refuse (`no_branch`) is a trap.
- **State 5 offers no command either.** `claimContinue` runs `assertCanEdit` first, so
  `motir continue` would be refused for a reader who may only browse; Continue hosted is not mounted for
  a non-editor (C6). The row keeps its reason and says who can act. It still opens the card.
- **State 6 — where C4–C5 sit.** Starting replaces the door in place (picker disabled, the button's
  `loading` with _Starting…_); the command stays. A notice takes a full-width slot under the repairs, on
  the fix line's 40px indent, above the row's bottom border. A pre-flight refusal (C5c — out of credits,
  unavailable, not writable, model not offered) leaves the row as it was: nothing was locked. A refusal
  that means the state MOVED (C5a — _taken_, _run alive_) means the reason has cleared: the row is HELD
  (state 7) and the notice stays with it, because it answers the press.
- **State 7 — § 26, unchanged in wording: a nudge adds and updates; it never removes.** A continue claim
  opens the `continue` run, the view becomes `continuing`, the reason clears. The row keeps its place,
  goes `--el-text-secondary`, drops its glyph and both repairs, and wears **Cleared**; the strip count
  drops at once (4 → 3 while four rows show). The next load omits it. _Cleared_, not _Continued_: the
  nudge does not say why the card left the set.
- **State 8 does not read differently in form.** When a continue run itself dies, the view is `died`
  again and its `deadRun` IS the continue run: _last heard from_ is its time and _&lt;who&gt;_ is its
  dispatcher (**Lee K.**, not Mara S. whose run died first). No _died again_ wording: what the reader
  must do is the same, and the history is the marker's (_Run by Lee K. with `motir continue`_).

### The six ways a run dies — what the row shows

The row names **none** of them. Each is folded into _Run died · last heard from &lt;when&gt;_, because all
six share one repair; the ending is the marker's reason line (D3), one click away.

| `RunDiedReason` | the marker says (D3)                                    | the row                                                     |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `lapsed`        | The run stopped reporting — last heard from …           | folded — _last heard from_ IS the fact (its last heartbeat) |
| `interrupted`   | The run was stopped from its terminal …                 | folded into _last heard from_ (its end)                     |
| `failed`        | The agent exited with an error …                        | folded into _last heard from_ (its end)                     |
| `cancelled`     | The run was cancelled …                                 | folded into _last heard from_ (its end)                     |
| `stalled`       | The hosted agent stalled — no output for 15 minutes — … | folded into _last heard from_ (its end)                     |
| `backstop`      | The hosted run reached its 12-hour limit …              | folded into _last heard from_ (its end)                     |

The tag and the banner fold them the same way (`design/work-items/design-notes.md` § _The TO FIX tag and
banner: RUN DIED_).

### The empty state — five causes

Unchanged but for the body, which now names five causes, the dead run first (the priority order):
_When a run that died, a merge queue, a conflict, a failing check or a reviewer stops one of your work
items, it shows up here with what repairs it._ _With what repairs it_, not _with the command that
repairs it_: a dead run with nothing pushed carries a start-over line, not a command.

### Strings — every new key, `en` and `zh`

New keys sit under the shipped namespaces. `<when></when>` is the shipped rich-text time tag the continue
part already uses (a `<time>` with `relativeLabel`); `<d>` is the row's mono-bold part, as § 30's
`<d>{base}</d>`.

| key                                                 | `en`                                                                                                                                                | `zh`                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `workbench.toFix.reason.runDied`                    | Run died · last heard from <when></when> · {name} · branch <d>{branch}</d>                                                                          | 运行已中断 · 最后一次联系在<when></when> · {name} · 分支 <d>{branch}</d>                             |
| `workbench.toFix.reason.runDiedNoName`              | Run died · last heard from <when></when> · branch <d>{branch}</d>                                                                                   | 运行已中断 · 最后一次联系在<when></when> · 分支 <d>{branch}</d>                                      |
| `workbench.toFix.reason.runDiedNothingPushed`       | Run died · last heard from <when></when> · {name} · nothing was pushed                                                                              | 运行已中断 · 最后一次联系在<when></when> · {name} · 未推送任何内容                                   |
| `workbench.toFix.reason.runDiedNothingPushedNoName` | Run died · last heard from <when></when> · nothing was pushed                                                                                       | 运行已中断 · 最后一次联系在<when></when> · 未推送任何内容                                            |
| `workbench.toFix.reason.runDiedBare`                | Run died                                                                                                                                            | 运行已中断                                                                                           |
| `workbench.toFix.reason.runDiedMoreRepositories`    | + {count, plural, one {# more repository} other {# more repositories}}                                                                              | 另有 {count} 个代码仓库                                                                              |
| `workbench.toFix.reason.runDiedParent`              | Part of <b>{parent}</b>’s run — both repairs continue the whole run                                                                                 | 属于 <b>{parent}</b> 的运行——两种方式都会继续整个运行                                                |
| `workbench.toFix.reason.runDiedCannotEdit`          | You can’t edit this work item, so someone who can has to continue it.                                                                               | 你无法编辑此工作项，因此需要由有编辑权限的人来继续。                                                 |
| `workbench.empty.toFix.body` (**changed**)          | When a run that died, a merge queue, a conflict, a failing check or a reviewer stops one of your work items, it shows up here with what repairs it. | 当中断的运行、合并队列、冲突、未通过的检查或审阅者卡住你的某个工作项时，它会带着修复方法显示在这里。 |
| `toFix.tagName.run_died`                            | To fix · run died                                                                                                                                   | 待修复 · 运行已中断                                                                                  |
| `toFix.banner.runDied`                              | This needs a fix: its run died, last heard from <when></when>, and its work is kept on its branch.                                                  | 需要修复：它的运行已中断，最后一次联系在<when></when>，其工作保留在分支上。                          |
| `toFix.banner.runDiedNothingPushed`                 | This needs a fix: its run died, last heard from <when></when>, before it pushed anything.                                                           | 需要修复：它的运行已中断，最后一次联系在<when></when>，且未推送任何内容。                            |
| `toFix.banner.runDiedParent`                        | This needs a fix: the run of <b>{parent}</b> it was part of died, last heard from <when></when>.                                                    | 需要修复：它所属的 <b>{parent}</b> 运行已中断，最后一次联系在<when></when>。                         |
| `toFix.banner.toContinue`                           | See how to continue it                                                                                                                              | 查看如何继续                                                                                         |
| `toFix.banner.toStartOver`                          | See how to start over                                                                                                                               | 查看如何重新开始                                                                                     |
| `toFix.banner.openingDevelopment`                   | Opening Development…                                                                                                                                | 正在打开“开发”…                                                                                      |

**The filter value adds no key.** `FIX_REASON_VALUE_KEYS` (`advancedFilterLabels.ts`) gains
`run_died: 'runDiedBare'`, so the _To fix_ value editor and its summary chip read
`workbench.toFix.reason.runDiedBare` — the same reuse the four shipped values make.

**Reused by name, unchanged:** `github.development.continue.startOver` (state 4) ·
`github.development.continue.hosted.button` / `.buttonParent` · `github.development.continue.hosted.refused.*`
and `.refused.outOfCredits.body` · `runs.hosted.door.starting` · `runs.hosted.picker.*` ·
`runs.hosted.refused.outOfCredits.title` · `workbench.toFix.copyAria` / `.copyTooltip` / `.toast.*` ·
`workbench.live.cleared` / `.new` · `workbench.empty.toFix.title`. Commands, branch names, keys and model
ids are never translated.

### Token map — this section's own elements

| element                            | colour                                                                                                                                | shape                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| run-died glyph (`TriangleAlert`)   | `--el-icon-muted` (decorative, `aria-hidden`)                                                                                         | 14px                                                          |
| reason text                        | `--el-text`; the branch mono and bold                                                                                                 | `text-xs`                                                     |
| the clauses (repositories, parent) | `--el-text-secondary`; the parent key `--el-text`                                                                                     | `text-xs`                                                     |
| start-over / cannot-edit line      | `--el-text-secondary`, the key `--el-text`                                                                                            | `text-xs`                                                     |
| model picker                       | `--el-border` on `--el-page-bg`; the default's secondary `--el-text-identifier`; disabled `--el-surface-soft` / `--el-text-secondary` | `--height-control` · `--radius-input` · `--spacing-control-x` |
| Continue hosted                    | `--el-accent` / `--el-accent-text`; disabled at 50%                                                                                   | `--height-btn-sm` · `--radius-btn` · `--spacing-btn-x-sm`     |
| command chip · copy button         | § 30's, unchanged                                                                                                                     | § 30's                                                        |
| refusal notice                     | `--el-warning-surface`, `--el-text-strong` ink, `--el-warning` glyph                                                                  | `--radius-control` · `--spacing-control-x/y`                  |
| In Progress pill                   | `--el-tint-sky`, `--el-text-strong`                                                                                                   | `--radius-badge` · `--spacing-chip-x/y`                       |

No `--el-text-muted` or `--el-text-faint` carries text on the row (its hover fill is `--el-surface`). No
raw hue, no raw shape utility.

### GIVES / TAKES

| card                                            | GIVES                                                                                                                                                                                                                                                                            | TAKES                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-6882** (the Workbench row, code)        | ELEMENT: the row's repairs — the Continue hosted control and `motir continue <KEY \| PARENT>` on the fix line — every variant (states 1–6, 8), the start-over and cannot-edit lines, and the HELD state (7). STRUCTURE: the door first, the command at the right edge, the wrap. | Nothing.                                                                                                                    |
| **MOTIR-6880** (the stored reason)              | PREMISE: `run_died` first in `FIX_REASON_PRIORITY`; when it holds (`died` with `refusal ∈ {null, continue_the_parent, no_branch}`). ELEMENT: the words — every string in the table above, in both catalogues.                                                                    | Nothing.                                                                                                                    |
| **MOTIR-6879** (Continue hosted, placeable)     | Nothing new: the row places the shipped control and needs it mountable outside the item page's provider, which is that card's job.                                                                                                                                               | Nothing.                                                                                                                    |
| **the four shipped reasons** (§ 30, MOTIR-6599) | Nothing.                                                                                                                                                                                                                                                                         | Nothing — their glyphs, sentences, commands and order among themselves are unchanged; `run_died` is inserted ahead of them. |
| **MOTIR-6529** (the run-died marker)            | Nothing.                                                                                                                                                                                                                                                                         | Nothing — pointed at, not redrawn; its `startOver` line is reused by name.                                                  |
| **MOTIR-6789** (Continue hosted)                | Nothing.                                                                                                                                                                                                                                                                         | Nothing — its control and its C4–C5 states are placed, not redrawn.                                                         |

### What this does NOT decide

- **The review-agent variant** of a dead run (MOTIR-6817) — nothing is drawn for it.
- **The run-died marker and the Continue hosted control themselves** — redrawn nowhere here.
- **Whether the row's facts are stored in `fixDetail` or read per row** — MOTIR-6880's and MOTIR-6882's
  call; the row needs exactly the fields in the facts table above.
- **The tag, banner and filter** — `design/work-items/design-notes.md` § _The TO FIX tag and banner: RUN
  DIED_ (the same card).

### Flag for the planner — the marker offers a non-editor the command

§ _Run died_ (D1) and C6 keep `motir continue <KEY>` on the marker for a viewer who cannot edit the
project, while `claimContinue` refuses that viewer (`assertCanEdit`). This row does not repeat that
(state 5 offers no command); the marker itself is shipped and is out of this card's scope.

## 32 · TO FIX · SENT BACK BY THE REVIEW AGENT — the agent's reason on the tag, the banner and the row, and `motir fix` for a person's Request changes — MOTIR-6817

> **Revised 2026-09-29 after Request changes.** The product owner sent this design back with:
> _"To fix after review should be able to run in the hosted agent too."_ Recorded as
> `docs/decisions/approval-gates.md` **§12.4b** and `hosted-agent-run.md` **§8.6**. The To fix row and
> the banner — for the review agent's refusal AND a person's Changes requested — now offer **Fix on the
> hosted agent** beside the copyable `motir fix <KEY>`, reusing the Continue hosted door (§ 31) unchanged,
> with its running and refused states (Panels 2 and 4).

**The asset:** [`workbench--to-fix--review-agent.mock.html`](./workbench--to-fix--review-agent.mock.html),
a new delta mock, Panels **1–5**. **It edits no existing mock.** It amends **§ 30**
([`workbench--to-fix.mock.html`](./workbench--to-fix.mock.html), MOTIR-6599 — the To fix tab, its row
and its fix line) and the **To fix tag and banner** of MOTIR-6608 (published as `to-fix--tag-and-banner.mock.html` in `design/work-items/`, published only and not
committed; its committed delta is
`design/work-items/to-fix--tag-and-banner--run-died.mock.html`, `design/work-items/design-notes.md`
§ _The TO FIX tag and banner: RUN DIED_). Card **MOTIR-6817**, Story **MOTIR-1626** (9.8, the review
agent). Behaviour: `docs/decisions/approval-gates.md` **§12.4** (the agent's `changes_requested` is To
fix `changes_requested`, repaired by `motir fix`) and **§12.7** (a person's Request changes on the
approve-and-merge gate is ALSO repaired by `motir fix`). Rendered against motir-core `origin/main` @
`351724043`. The Development frame's own states are `design/github/design-notes.md` **§ 30**.

**The review agent is manual-only** (Yue, 2026-09-29: _Review agent_ and _Merge automatically_ cannot
both be on), so every sent-back card here sits in a project that asks before merging.

### Access path

Unchanged: the Workbench's **To fix** tab (§ 30, Panel 1 here), the tag on the board card, list and
tree row and quick-view header, and the banner at the top of the item page. **A sent-back card is
never on To approve** — an `agent_review` gate is excluded from the awaiting-routed read and notifies
nobody (§12.1). No new tab, filter value, reason or entry point.

### The panels

| panel | what                                                                                                                    | composes (shipped)                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | the strip, To fix tab — the access path                                                                                 | `WorkbenchTabs`' strip, unchanged                                                          |
| 2     | two To fix rows: **sent back by the review agent**, and a **person's Request changes** now `motir fix`                  | `WorkbenchList`'s row + `WorkbenchFixLine` (glyph · sentence · command chip · copy button) |
| 3     | the **tag**, label and glyph forms, with the agent's reason in its accessible name                                      | `ToFixTag` (`Pill` on `--el-danger`, `Wrench`)                                             |
| 4     | the item-page **banner**: the agent's (first findings line + `motir fix`) and the person's (lead and command corrected) | `ToFixBanner` + `CopyableCodeBlock language="shell"`                                       |
| 5     | zh                                                                                                                      | the same                                                                                   |

### Decisions

| decision                                   | chosen                                                                                                                                                                                                                                                                                                                                         | why                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a new reason?                              | **No.** The agent's refusal IS `changes_requested` (§12.4); only the decider differs                                                                                                                                                                                                                                                           | the priority order, the filter's values and the tag's shape stay as § 30 and § 31 set them. What changes is the WORDS where a decider is named                                                                                                                                                                                                             |
| the row's glyph                            | `Undo2` in `--el-icon-muted`, as for any refusal                                                                                                                                                                                                                                                                                               | a refusal is not a failure (`RepairFixPart`'s pairing). The Bot glyph stays in the frame, where the agent's findings are                                                                                                                                                                                                                                   |
| the row's sentence                         | _Sent back by **the review agent** — “{first findings line}”_, the note truncated as § 30 truncates a person's note                                                                                                                                                                                                                            | it answers _who sent it back_ the way the person's row does, and the first line is the findings' own summary. The note is `fixDetail.notePreview`, filled for the agent from the findings' first line with Markdown stripped                                                                                                                               |
| the tag                                    | the SAME tag; its name **_To fix · sent back by the review agent_**                                                                                                                                                                                                                                                                            | § 30's rule: every reason draws one tag, and the reason is in the accessible name and `title` only. A surface that cannot tell the decider keeps _To fix · changes requested_, which is still true                                                                                                                                                         |
| the banner                                 | _This needs a fix: the review agent sent it back — “{first findings line}”_, then _Repair it with this command:_ and `motir fix <KEY>`                                                                                                                                                                                                         | the banner's shape is unchanged; the findings in full are in the Development frame's review band one link below (_See its pull requests_), so the banner does not repeat them                                                                                                                                                                              |
| **a person's Request changes — CORRECTED** | the row's command and the banner's command become **`motir fix <KEY>`**; the banner's lead becomes `toFix.banner.leadFix`                                                                                                                                                                                                                      | **§12.7**: `motir run` cannot claim an in-progress card (`claimOutcome.ts` takes only the to-do category), so § 30 and the shipped banner printed a command that is refused. The verb still comes from `fixDetail.repair`, never from the reason — MOTIR-6822 changes what `repair` holds                                                                  |
| **Fix on the hosted agent** (§12.4b)       | on the row, § 31's repairs slot: the door LEADS (`HostedModelPicker` + primary `Button`, `Cloud`, label _Fix on the hosted agent_) and the command keeps the right edge. On the banner, the Continue hosted part's order: _Fix it on the hosted agent — no terminal needed:_ + the door, then _Or repair it from your terminal:_ + the command | § 31 already placed a hosted door beside a command on this row (_Continue hosted_ + `motir continue`); the repair uses the same slot, grammar and model picker. The pressing person picks the model (`hosted-agent-run.md` §7). Offered to whoever may start a hosted run on the card; anyone else keeps the command alone, and the banner keeps `leadFix` |
| never automatic                            | **nothing starts on the refusal itself**                                                                                                                                                                                                                                                                                                       | §12.4: nothing re-runs by itself. A card sits in To fix with both repairs offered until a person presses one                                                                                                                                                                                                                                               |
| a repair running                           | the row: the door and the command give way to _Being fixed on the hosted agent by **{name}** · {run link}_ (§ 31's sentence-in-the-command's-place grammar). The banner: its lead, door and command give way to _A hosted repair is running — started by **{name}** {when} · {run link}_                                                       | the open repair run IS the one-repair-at-a-time lock (§8.6), so neither repair can be offered while it runs. The card stays To fix until a push moves the head                                                                                                                                                                                             |
| a press refused                            | the door's own warning notice in the row's notice slot (§ 31 state 6), and under the door on the banner: _Not started — a repair is already running, started by **{name}** {when}._ The could-not-start answers are the door's own, reused                                                                                                     | `ContinueHostedAnswer`'s rule: a door's answers are drawn under that door. The full set is drawn once, in `design/github/approve-and-merge--agent-review.mock.html` Panel 3d                                                                                                                                                                               |

### Primitives composed (no new primitive)

`WorkbenchTabs`' strip; `WorkbenchList`'s row; `WorkbenchFixLine` (the `Undo2` glyph, the sentence, the
`tf-cmd` chip and the always-visible copy icon-button); `ToFixTag` in both forms; `ToFixBanner` (the
`--el-danger-surface` frame, the tag's disc, the sentence, the lead, the link to `#development`);
`CopyableCodeBlock`; and § 31's row repairs slot, notice slot and **Continue hosted door**
(`ContinueHostedButtonRow` / `ContinueHostedAnswer`), whose `tf-repairs` / `tf-startover` /
`tf-notice-slot` / `cc-` / `btn` rules are carried verbatim from
`workbench--to-fix--run-died.mock.html`. The mock's one new rule block, `rv-`, restates `ToFixTag`, `ToFixBanner` and
`CopyableCodeBlock`'s class strings (plus `rv-run`, the hosted run's link), which § 30's compiled Tailwind block does not carry — no new
element. Colour: `--el-danger` + `--el-danger-text` (the tag, the ONE legal use of that ink),
`--el-danger-surface` + `--el-danger-surface-text` (the banner), `--el-code-bg` / `--el-code-text`,
`--el-icon-muted`, `--el-text` / `--el-text-secondary`. `--el-text-muted` and `--el-text-faint` are not
used by anything this delta adds.

### Copy — `en` + `zh`

New strings only; zh uses the Workbench's **待修复** and the switch card's **审查代理**.

| key                                      | en                                                                                     | zh                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `toFix.tagName.sent_back_by_agent`       | To fix · sent back by the review agent                                                 | 待修复 · 已被审查代理退回                                                 |
| `toFix.banner.sentBackByAgent`           | This needs a fix: the review agent sent it back — “{note}”                             | 需要修复：审查代理已将它退回——“{note}”                                    |
| `workbench.toFix.reason.sentBackByAgent` | Sent back by <b>the review agent</b> — “{note}”                                        | 已被<b>审查代理</b>退回——“{note}”                                         |
| `workbench.toFix.hostedButton`           | Fix on the hosted agent                                                                | 用托管代理修复                                                            |
| `workbench.toFix.fixingHosted`           | Being fixed on the hosted agent by <b>{name}</b> · <run>{run}</run>                    | <b>{name}</b> 正在用托管代理修复 · <run>{run}</run>                       |
| `toFix.banner.hostedLead`                | Fix it on the hosted agent — no terminal needed:                                       | 在这里用托管代理修复——无需终端：                                          |
| `toFix.banner.orTerminal`                | Or repair it from your terminal:                                                       | 或者在终端中修复：                                                        |
| `toFix.banner.fixingHosted`              | A hosted repair is running — started by <b>{name}</b> <when></when> · <run>{run}</run> | 托管修复正在运行——由 <b>{name}</b> 于<when></when>开始 · <run>{run}</run> |

The refused press's words are `github.development.fix.hosted.refused.taken` / `.takenByYou` and the
could-not-start answers are `runs.hosted.*`, all listed in `design/github/design-notes.md` § 30 — one
string set for the door wherever it sits. The row's and banner's door button reads
`workbench.toFix.hostedButton`, identical to `github.development.fix.hosted.button` (MOTIR-6825 may
share one key). **Reused, unchanged:** `runs.hosted.door.starting`, `runs.hosted.picker.*`,
`toFix.banner.leadFix` (_Repair it with this command:_ / _用以下命令修复：_),
`toFix.banner.toDevelopment`, `workbench.toFix.copyAria` / `copyTooltip` / `toast.*`, and every
`changesRequested*` sentence. **Retired once MOTIR-6822 lands:** `toFix.banner.leadRun` (_Re-run the work
item. The new run's prompt carries the reviewer's note:_) — no `repair` value will select it, since an
acceptance Re-run keeps `fix` and the approve-and-merge refusal moves from `run` to `fix`.

### What this design does NOT decide

- **The frame's states** (reviewing, passed, sent back, could not run, the override) —
  `design/github/design-notes.md` § 30.
- **How the tag learns the decider.** `ToFixTag` takes the stored `fixReason` alone today; naming the
  agent needs the decider from `fixDetail` (or a flag derived from it) on each surface that renders the
  tag. MOTIR-6825 decides the plumbing; where it is absent, the person's name for the reason stands.
- **`fixDetail`'s shape for the agent** (the decider, the note preview) and **`fixReason.ts`'s
  derivation** — MOTIR-6822 / MOTIR-6825, per §12.4.
- **A filter value for "sent back by the review agent"** — none; _To fix is changes requested_ includes
  both deciders.
- **The hosted repair RUN** — its claim, mode, credential and billing are `hosted-agent-run.md` §8.6.
  The door only starts it, and **nothing starts on the refusal itself** (§12.4). A hosted repair for the
  OTHER To-fix reasons (CI failed, queue failed, conflicted, run died) is not drawn: §12.4b covers a card a
  review sent back only, so those rows keep § 30 / § 31 unchanged.

### GIVES / TAKES

| key        | GIVES / TAKES                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MOTIR-6822 | **GIVES** `fixDetail.repair = 'fix'` for both deciders' `changes_requested`, which is what turns § 30's `motir run` into `motir fix` here |
| MOTIR-6825 | **GIVES** the three strings above and the agent's sentence on the row, the banner and the tag name. **TAKES** the decider on `fixDetail`  |
| MOTIR-6599 | **TAKES** § 30's changes-requested row: its command is now `motir fix`. Done, not re-opened; its mock stays as a record                   |
| MOTIR-6608 | **TAKES** the banner's changes-requested lead (`leadRun` → `leadFix`). Done, not re-opened                                                |
| MOTIR-6817 | this card                                                                                                                                 |

Fixture items use `ACME-n` keys, so they link to nothing.

## 33 · WAITING ON YOU — the manual-work gate's row and overlay port, with Guide me through and Mark done, and the tab renamed from To approve — MOTIR-7473

**Design system — read first.** `package.json` depends on `@motir/design-system` (`workspace:*`) AND
`app/globals.css` imports `@motir/design-system/theme.css` → **on Motir Design (branch a)**, at the
workspace version, on the project's own axes (`app/layout.tsx` applies the persisted `data-style` /
`data-palette`; the mocks render the base axes, as every mock in this area does). Every part used is the
package's or a shipped motir-core component: `Pill`, `Button` (incl. `loading` + `Spinner`), `Card`,
`EmptyState`, `@motir/brand`'s `BrandMark` (`mark`), `ApprovalRow`, `ApprovalGateControl`'s bands,
`WorkbenchTabs`, `ContentSectionCard`, `TodoRowReadOnly` + `GuideTodoCanvas`'s static box, `RunTonePill`,
`WorkItemNode`, the `RunsIndex` row. **No part is missing; nothing is proposed to the package.**

**Assets (four NEW delta mocks, DATED 2026-10-03; no existing mock is edited):**

| Surface                                   | Asset                                                          | Amends                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| The Waiting on you ROW (+ Approvals room) | **`design/workbench/approvals-row--manual-work.mock.html`**    | § 20 `approvals-row.mock.html`, as amended by § 26 (live) and § 28 (the row as a sentence)                            |
| The approval overlay's PORT               | **`design/workbench/approval-overlay--manual-work.mock.html`** | § 22 `approval-overlay.mock.html`, with § 28's exit row                                                               |
| The STRIP, renamed                        | **`design/workbench/workbench--waiting-on-you.mock.html`**     | `workbench.mock.html` as amended by § 21 (MOTIR-5216, the order and the cascade) and § 30 (To fix)                    |
| The RUN's wording                         | **`design/runs/run-section--waiting-on-you.mock.html`**        | `design/runs/run-section.mock.html` and the run modal / runs index — `design/runs/design-notes.md` § _Waiting on you_ |

Story [MOTIR-7460](motir:cmurr45v6007ahwoij3o3p3fg), card MOTIR-7473, built on
`docs/decisions/manual-work-gate.md` (MOTIR-7472: the kind, its verbs §4, its listing §7 and run wording
§8) and MOTIR-7458's rename. It is the layout source of truth for **MOTIR-7476** (the rename),
**MOTIR-7477** (the run wording) and **MOTIR-7478** (the row and the port), which carry it in
`blocked_by`. **All copy for the four surfaces is in this section**, including the run page's (the runs
area's notes carry its rules and point here).

Rendered against `origin/main` `99299c22`: every class string is copied from the shipped component it
names; each mock's stylesheet is Tailwind v4.3.0 compiled over exactly the classes its elements carry,
with `packages/design-system/theme.css` and `packages/brand/brand.css`. Only review chrome is
hand-written. Fixture keys are `ACME-n`.

### 33.1 The tab: **To approve → Waiting on you / 等你处理** (strip mock, Panels 1–4)

- **Only the label moves.** Slug `?tab=approvals`, the `Inbox` glyph, first place in the strip, the count
  chip, the active recipe, the all-zero suppression rule and the landing cascade (§ 21 rung 1) are
  unchanged. The count now includes awaiting `manual_work` gates, because they are awaiting gates routed
  to the reader (`listAwaitingMe`) — so a person a run handed work to LANDS on this tab.
- **Width.** en grows ≈ 26px; zh one character (待审批 → 等你处理). The `< md` strip already scrolls.
- **The empty state follows the name** (Panel 2c): the old body said _sign-off_, which is no longer the
  whole set.
- **Every other string that names the tab** moves with it (MOTIR-7476). The two zh strings that use 待审批
  as a plain phrase (_awaiting approval_), not as the tab's name — `acceptance.off.adminBody` and
  `approvalGate.statusHeld.planState.planned` — are NOT renamed.

| key                                               | en                                                                                                                                      | zh                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `workbench.tabs.toApprove` (key may be renamed)   | Waiting on you                                                                                                                          | 等你处理                                                                                   |
| `workbench.empty.approvals.title`                 | Nothing is waiting on you                                                                                                               | 没有等你处理的事项                                                                         |
| `workbench.empty.approvals.body`                  | Approvals that need your decision, and work a run handed to you to do, show up here.                                                    | 需要你决定的审批，以及运行交给你完成的工作，都会显示在这里。                               |
| `approvalGate.planApproval.surface.reopened`      | Reopened from Waiting on you · started by {name} · last active {when}                                                                   | 从“等你处理”重新打开 · 发起人 {name} · 最近活动 {when}                                     |
| `approvalGate.planApproval.surface.reopenedYours` | Reopened from Waiting on you · started by you · last active {when}                                                                      | 从“等你处理”重新打开 · 由你发起 · 最近活动 {when}                                          |
| `approvalGate.planApproval.surface.held`          | Motir AI is writing a new version of this plan. Approve and Decline come back when it finishes — it stays in Waiting on you meanwhile.  | Motir AI 正在编写此计划的新版本。完成后即可批准或拒绝——在此期间它会一直留在“等你处理”中。  |
| `approvalGate.planApproval.surface.heldBy`        | {harness} is writing a new version of this plan. Approve and Decline come back when it finishes — it stays in Waiting on you meanwhile. | {harness} 正在编写此计划的新版本。完成后即可批准或拒绝——在此期间它会一直留在“等你处理”中。 |
| `approvalGate.planApproval.surface.declined`      | You declined this plan. Nothing in your backlog changed, and it has left Waiting on you.                                                | 你拒绝了此计划。待办列表没有任何改动，它也已离开“等你处理”。                               |
| `approvalGate.planApproval.declineConfirm.leaves` | Take it out of Waiting on you.                                                                                                          | 将它移出“等你处理”。                                                                       |
| `approvalGate.planApproval.handoff.writing`       | … and the plan will be waiting for you in `<link>`Waiting on you`</link>`.                                                              | ……计划完成后会在`<link>`等你处理`</link>`中等你。                                          |
| `approvalGate.planApproval.handoff.rewriting`     | … it stays in `<link>`Waiting on you`</link>`, and you can decide once I'm done.                                                        | ……它会一直留在`<link>`等你处理`</link>`中，等我完成后你就可以决定。                        |

The two `handoff.*` rows change only the link's text; the rest of each sentence is the shipped string.
`docs/approval-gates.md`'s _To approve_ mentions are MOTIR-7476's to sweep.

### 33.2 The ROW (row mock, Panels 1–6)

**The sentence**, title-FIRST (as § 28's _{title} is finished_), one ICU message per form with the
shipped `<title>` tag, so the order is the catalogue's:

| form — when                                                                  | en                                             | zh                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| awaiting, routed to the reader (the tab)                                     | `<title>{name}</title> is waiting on you`      | `<title>{name}</title>等你处理`   |
| awaiting, for a reader it is NOT routed to (the room)                        | `<title>{name}</title> is waiting on a person` | `<title>{name}</title>等人处理`   |
| decided — settled in place, and the room's record                            | `<title>{name}</title> was marked done`        | `<title>{name}</title>已标记完成` |
| held (§ 26 — left the awaiting set; the surface does not know where it went) | `Manual work on <title>{name}</title>`         | `<title>{name}</title>的人工工作` |

**Why this kind's sentence changes with state when no other kind's does.** § 28 made every kind a NOUN
PHRASE so it stays true after the decision. ADR §7 fixes this kind's words as a STATE (_is waiting on
you_), so it is said only while true: the settled form says what happened, and the held form falls back
to a neutral noun phrase, because a held row does not know whether it was marked done elsewhere or
withdrawn.

| cell              | content                                                                                                                                                                                  | tokens / shape                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glyph             | lucide `hand` — `workItemTypeMeta`'s mark for `type: manual`                                                                                                                             | `--el-type-manual`, `h-4 w-4`, `aria-hidden`                                                                                                                                                                                             |
| sentence          | as above; the title is § 28's quick-view door                                                                                                                                            | frame words `--el-text-secondary`; title `--el-text` `font-medium` (settled / held: `--el-text-secondary`)                                                                                                                               |
| key               | shipped                                                                                                                                                                                  | `font-mono text-xs --el-text-secondary`                                                                                                                                                                                                  |
| details           | to-do progress _{done}/{total} steps_ · zh _{done}/{total} 步_ (rows from the card; _No to-do list_ · _无待办清单_ when none) · then, while pending, **Guide me through** / **带我完成** | progress `text-xs --el-text-secondary`; the `·` `aria-hidden`; the door: `text-xs font-medium --el-link`, `hover:` / `focus-visible:underline`, the `BrandMark` mark at 12px (`.brand-glyph`, `--el-accent-on-surface`), `relative z-10` |
| Waited            | the shipped relative age, from the RAISE (`waitingSince`)                                                                                                                                | shipped                                                                                                                                                                                                                                  |
| Decide — pending  | **Mark done** / **标记完成** — `Button variant="secondary" size="sm"`, `relative z-10`, in the place `Review` holds for every other kind                                                 | shipped Button recipe (`--radius-btn`, `--height-btn-sm`)                                                                                                                                                                                |
| Decide — deciding | `Button loading`: Spinner + **Marking…** / **正在标记…**, disabled, `aria-busy`                                                                                                          | shipped                                                                                                                                                                                                                                  |
| Decide — decided  | `Pill severity="success"` **Marked done** / **已标记完成**, `whitespace-nowrap`                                                                                                          | `--el-tint-mint` + `--el-text-strong`                                                                                                                                                                                                    |
| Decide — held     | the shipped colourless **Decided elsewhere** / **已由他人决定**                                                                                                                          | `Pill tone="neutral"`                                                                                                                                                                                                                    |
| Decide — see only | the shipped **Awaiting** / **等待处理**                                                                                                                                                  | `Pill tone="awaiting"`                                                                                                                                                                                                                   |

- **The grid is unchanged** (`APPROVALS_GRID_TEMPLATE`). Two buttons do not fit the 132px Decide track,
  and they do not need to: **Guide me through is a DOOR, not a verb** (ADR §4) — it navigates — so it is
  a LINK in the details track, and the one VERB takes the Decide cell. It is a real
  `<a href="/items/{key}?plan=guide&planFrom=guide&planItem={key}">`: plain click opens the guide overlay
  over the Workbench (`useOpenGuide`), modified click the item page in a new tab.
- **Mark done DECIDES FROM THE ROW** (ADR §5) — new for the row grammar, where every other kind only
  opens. No confirm: the press is the decision, the consequence is a status move the person asked for,
  and the overlay states it for anyone who opens first. The row settles from the write's own response
  through `lib/approvals/decidedGates.ts` (the § 22 signal), stays in place, and leaves on the next load
  (§ 20 / § 26).
- **States drawn:** pending with a list (2a), pending with no list (2b), deciding (2c), decided (2d),
  left the set while looking — withdrawn or decided elsewhere (2e). A withdrawn gate is never its own
  row: the tab reads awaiting gates only, so withdrawal arrives as the held row.
- **The Approvals room** (Panel 4) renders the same row: waiting for somebody else (_is waiting on a
  person_, the _Asked of_ cell, the Awaiting pill, no door), and decided (_was marked done_, _Decided by_,
  the decided time, _Marked done_). A withdrawn `manual_work` gate is not listed (ADR §7).
- **Accessible name of the row door:** `workbench.approvals.reviewRow` with the plain sentence —
  _Review ACME-31 — Create the production Stripe account is waiting on you_.

### 33.3 The OVERLAY PORT (overlay mock, Panels 1–7)

The kind opens in the shipped overlay (§ 22): exit row, then `ApprovalGateControl`'s three bands.

| band              | content (en / zh)                                                                                                                                                                                                                                                                                                                                                                     | tokens                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · kind line     | `hand` glyph · **Manual work** / **人工工作** · meta _Handed to you by a run · {done} of {total} steps done_ / _由一次运行交给你 · 已完成 {done}/{total} 步_ (no list: _… · no to-do list_ / _… · 无待办清单_) · state pill                                                                                                                                                           | kind `text-sm font-semibold --el-text`; meta `text-xs --el-text-secondary`; shipped pills                                                                                                                             |
| 2 · port, lead    | _This is work a person does, so the run stopped here and handed it to you. Do the steps, then mark it done. Guide me through walks you through them one at a time._ / _这是需要人来完成的工作，所以运行在这里停下，把它交给了你。完成这些步骤，然后标记完成。“带我完成”会一步一步带你做。_                                                                                            | `text-[13.5px] --el-text`, `max-w-[48rem]`                                                                                                                                                                            |
| 2 · port, list    | the to-do list in its READ FACE: `ContentSectionCard` header (_To-do list — the steps of this work_ · _待办清单 — 本项工作的步骤_, progress _{d} of {t} done_ right) and `TodoRowReadOnly`'s two-track rows with the box DRAWN by state (`GuideTodoCanvas`'s static idiom); instructions still expand                                                                                 | ticked box `--el-accent` fill + `--el-accent-text` check; open box `--el-border-strong` on `--el-input-readonly-bg`; done text `--el-text-secondary line-through`; _Done by {name}_ `text-[11px] --el-text-secondary` |
| 2 · port, no list | lead: _… It has no to-do list: its description says what to do, and Guide me through can propose the steps._ / _……它没有待办清单：描述里写明了要做什么，“带我完成”也可以为你提出步骤。_ · box: **No to-do list** / _Open the work item to read its description, or let Guide me through propose the steps._ / **无待办清单** / _打开工作项阅读它的描述，或让“带我完成”为你提出步骤。_ | box `--el-surface-soft`, `--el-border`, `--radius-card`; title `--el-text`, body `--el-text-secondary`                                                                                                                |
| 3 · verbs         | consequence _Marking done moves {key} to Done._ / _标记完成后 {key} 将移至“已完成”。_ · **Guide me through** / **带我完成** (`Button` secondary `sm`, as a link, `BrandMark` mark 14px) · **Mark done** / **标记完成** (`Button` primary `sm`). **No Request changes.**                                                                                                               | shipped band recipe                                                                                                                                                                                                   |

- **The box is not a control in the port.** Ticking belongs to the item page and the guide; a third
  tick surface inside a decision frame would split the list's writers.
- **With an open linked pull request** the consequence reads _Marking done records it here. {key} moves
  to Done when its pull request merges._ / _标记完成会在此记录。{key} 会在其拉取请求合并后移至“已完成”。_
  (ADR §4, `merge_writes_done`).
- **Mark done pressing** (Panel 3): Mark done `loading` (_Marking…_ / _正在标记…_); Guide me through
  `aria-disabled` and dimmed for the length of the write; Close stays live.
- **Decided** (Panel 4): pill **Marked done**; lead _This work was marked done. The work items waiting on
  it can start._ / _这项工作已标记完成。等待它的工作项可以开始了。_; band 3 becomes the shipped record
  band (who · when). The overlay does not close.
- **Withdrawn** (Panel 5): the shipped withdrawn frame (colourless **Withdrawn**, _Nobody decided it._,
  _No decision · no one to attribute_), with the cause line per ADR §6:

| cause                                     | en                                                                                       | zh                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `no_longer_manual` (new)                  | The work item is no longer manual work, so this question was withdrawn.                  | 该工作项已不再是人工工作，因此该问题已撤回。             |
| `pulled_back` — `causeByKind.manual_work` | The work item was cancelled or archived, so this question was withdrawn.                 | 该工作项已被取消或归档，因此该问题已撤回。               |
| `closed_without_decision` (new)           | The work item was closed without anyone marking it done, so this question was withdrawn. | 该工作项在无人标记完成的情况下被关闭，因此该问题已撤回。 |

The `pulled_back` line is kind-specific because the shipped one (_pulled back out of review_) is false
for a card that never entered review.

- **Read-only, not routed** (Panel 6): the frame's state B — pill **Awaiting**, band 3 _Waiting on
  {name}._ (shipped), **no controls at all**. Not Guide me through either: the guide ticks rows as the
  person walking, and the walk is the routed person's. The item page keeps its own door for anyone who
  may edit (A2.7).
- **Dialog name:** `approvalOverlay.dialogTitle` with kind **Manual work** — _Manual work for ACME-31_ /
  _ACME-31 的人工工作_.

### 33.4 The run's wording

Drawn in `design/runs/run-section--waiting-on-you.mock.html`; its rules are in `design/runs/design-notes.md`
§ _Waiting on you_. Copy:

| key (proposed)                      | en                               | zh                              |
| ----------------------------------- | -------------------------------- | ------------------------------- |
| `runs.skipReason.waitingOnYou`      | Skipped — waiting on you.        | 已跳过 — 等你处理。             |
| `runs.skipReason.waitingOn`         | Skipped — waiting on {name}.     | 已跳过 — 等 {name} 处理。       |
| `runs.skipReason.markedDone`        | Skipped — marked done by {name}. | 已跳过 — 已由 {name} 标记完成。 |
| `runs.skipReason.needsHuman` (text) | Skipped — manual work.           | 已跳过 — 人工工作。             |
| `runs.summaryWaitingYou`            | {n} waiting on you               | 等你处理 {n} 项                 |
| `runs.summaryWaitingOthers`         | {n} waiting on others            | 等他人处理 {n} 项               |

### 33.5 Copy — the new and changed strings for the row and the port

| key (proposed)                                                                                                       | en                                                    | zh                                          |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| `workbench.approvals.sentence.manual_work`                                                                           | `<title>{name}</title> is waiting on you`             | `<title>{name}</title>等你处理`             |
| `workbench.approvals.sentence.manual_work_other`                                                                     | `<title>{name}</title> is waiting on a person`        | `<title>{name}</title>等人处理`             |
| `workbench.approvals.sentence.manual_work_done`                                                                      | `<title>{name}</title> was marked done`               | `<title>{name}</title>已标记完成`           |
| `workbench.approvals.sentence.manual_work_held`                                                                      | `Manual work on <title>{name}</title>`                | `<title>{name}</title>的人工工作`           |
| `workbench.approvals.manualSteps`                                                                                    | {done}/{total} steps                                  | {done}/{total} 步                           |
| `workbench.approvals.manualNoList`                                                                                   | No to-do list                                         | 无待办清单                                  |
| `workbench.approvals.markDone`                                                                                       | Mark done                                             | 标记完成                                    |
| `workbench.approvals.marking`                                                                                        | Marking…                                              | 正在标记…                                   |
| `workbench.approvals.kind.manual_work`                                                                               | Manual work                                           | 人工工作                                    |
| `approvalGate.manualWork.state.markedDone`                                                                           | Marked done                                           | 已标记完成                                  |
| `approvalGate.manualWork.meta`                                                                                       | Handed to you by a run · {done} of {total} steps done | 由一次运行交给你 · 已完成 {done}/{total} 步 |
| `approvalGate.manualWork.metaNoList`                                                                                 | Handed to you by a run · no to-do list                | 由一次运行交给你 · 无待办清单               |
| `approvalGate.manualWork.lead` / `leadNoList` / `leadDone`                                                           | § 33.3                                                | § 33.3                                      |
| `approvalGate.manualWork.noList.title` / `.body`                                                                     | § 33.3                                                | § 33.3                                      |
| `approvalGate.manualWork.consequence` / `consequenceMerges`                                                          | § 33.3                                                | § 33.3                                      |
| `approvalGate.withdrawn.cause.no_longer_manual` · `.closed_without_decision` · `causeByKind.manual_work.pulled_back` | § 33.3                                                | § 33.3                                      |
| (shipped) `runs.guide.door`                                                                                          | Guide me through                                      | 带我完成                                    |

No raw hex and no raw shape utility in any of the four deltas.

### What this asset does NOT decide

- **The guide itself** — what Guide me through opens is MOTIR-7462's design.
- **Whether a parent run resumes** after Mark done (MOTIR-6858).
- **The Approvals room's structure**, the overlay's frame, and every other kind's row — composed, unchanged.

### GIVES / TAKES

| card                                              | GIVES                                                                                                                                                                         | TAKES                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-7476** (rename)                           | § 33.1: the label, the empty state, the eight dependent strings, the zh strings NOT to rename                                                                                 | Nothing                                                                                                                                                       |
| **MOTIR-7477** (run wording)                      | § 33.4 and the runs area's § _Waiting on you_: four leg labels, two summary segments                                                                                          | **PREMISE:** the run DTOs must carry, per `needs_human` leg, its gate's state and routed person, and `legSummary` a count of waiting legs by routed-to-reader |
| **MOTIR-7478** (row + port)                       | § 33.2, § 33.3, § 33.5: the four sentence forms, the details cell with the Guide me through link, Mark done in the Decide cell and its states, the port, the withdrawn causes | **ELEMENT:** `SENTENCE_KEY` gains a kind whose sentence depends on state and routing — the only kind so; `StatePill` gains _Marked done_ for this kind        |
| **MOTIR-7474** (handler)                          | Nothing                                                                                                                                                                       | Nothing — the verbs drawn are the ADR's                                                                                                                       |
| **MOTIR-5147 / 5216 / 5222 / 5239 / 5997 / 7462** | Nothing                                                                                                                                                                       | Nothing — composed; their mocks are records and are not edited                                                                                                |

## 34 · TO FIX · ONE ENTRY PER RUN — cards stuck for one reason that one repair clears are one entry, and the tab counts entries — MOTIR-7590

> **Revised 2026-10-05 after Request changes.** The reviewer sent the design back with: _"We need to remove the
> text copy "hosted" on the button, because we don't call it "run hosted" anymore, which is just run, we should just
> say "continue"."_ The door's button now reads **Continue** (zh **继续**), and its parent form **Continue {key}**
> (zh **继续 {key}**). The model picker beside it still names the model; the run control already reads **Run**.
> Rows added to § 34.6, with the two sentences that name the button. The lead and the _Being continued … in a
> hosted container_ lines describe where the work runs, not the button, and stay.

**The asset:** [`workbench--to-fix--per-run.mock.html`](./workbench--to-fix--per-run.mock.html), a new delta
mock, Panels **1–8**, the zh panel and the grouping-key table. **It edits no existing mock.** It amends **§ 30**
([`workbench--to-fix.mock.html`](./workbench--to-fix.mock.html), MOTIR-6599, the To fix tab, its row and its
count) and **§ 31** ([`workbench--to-fix--run-died.mock.html`](./workbench--to-fix--run-died.mock.html),
MOTIR-6878), and it **RETIRES § 31's state 3** (_a child of a parent run_: one row per leg, each offering the
parent's repairs). The tag and the banner are `design/work-items/design-notes.md` § _The TO FIX tag and banner:
ONE ENTRY PER RUN_. Card **MOTIR-7590**, the design gate of **MOTIR-7589**. Rendered against motir-core
`origin/main` @ `1dd62a3`.

### 34.1 What was wrong

The tab lists, counts and pages **cards**. One stuck run therefore drew as many rows as it had stuck cards, and
every one of them offered the same repair:

- **A dead story run** puts the story and every in-progress leg on the tab. The legs carry `run_died` with
  `continueKey` = the story (`continue_the_parent`), so a run with five legs in flight drew six rows, six
  `motir continue ACME-12` commands and six hosted Continue doors, and the badge read 6 for one repair.
- **A red pull request shared by several run targets** (a sprint run, or a story run that never recorded How to
  test) puts each card on the tab with the same `ci_failed` / `conflicted` / `queue_failed` reason, each with its
  own `motir fix` for one repair.

**A premise MOTIR-7589 carried is corrected here:** the pull-request reasons do NOT fan out to the legs of a story
run whose run target holds a How to test record. For those legs `evaluateRepair` answers `repair_on_run_target`
(`lib/services/repairPredicate.ts`, through `resolveRunTargetFor` in `lib/services/runTarget.ts`), so
`deriveFixReason` writes nothing for them and only the story is listed. The pull-request fan-out exists only where
several cards are each their own run target on one pull-request set. The `run_died` fan-out is real for every
story run.

### 34.2 The decision: an ENTRY is a group of stuck cards, read over the per-card column

**Stored: one new field, `fixDetail.groupKey`, written by `recomputeWorkItemFixReason` with the reason it belongs
to.** Nothing else is stored, and no second table is written.

| reason                                                                | `groupKey`                                     | the HEAD (line 1)                                                         | member order                         |
| --------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `run_died`                                                            | `run:<dead DispatchRun.id>`                    | the run's scope card: `continueKey` (for `no_branch`, `parentKey ?? key`) | the run's `DispatchRunCard.position` |
| `queue_failed` · `conflicted` · `ci_failed`                           | `prs:<hash of the open member PR ids, sorted>` | the member that is an ANCESTOR of the others, else the lowest key         | by key                               |
| `changes_requested` on `pull_request_approval` or by the review agent | `prs:<…>`, the same key                        | as above                                                                  | by key                               |
| `changes_requested` on `acceptance_result`                            | `card:<id>`                                    | the card                                                                  | none                                 |
| anything else, and every row stored before the key existed            | `card:<id>`                                    | the card                                                                  | none                                 |

- `sameFixReason` compares `groupKey` like every other `FIX_DETAIL_FIELDS` member, so a card whose group changes
  (a fix run re-delivered its set) is rewritten.
- **Why not a run-keyed table** (one stored row per stuck run): the pull-request reasons are facts about a
  PULL-REQUEST SET, not a run. A run may be closed while its pull request goes red, a fix run re-delivers the set,
  and a hand-linked pull request has no run at all. And the per-card column has to stay anyway: the tag, the
  banner, the `/items` filter and the In progress / To fix partition all read it. A second stored truth would need
  its own writers, its own backfill and a reconciler, and it could drift from the column the rest of the app reads.
- **The slice predicate does not change.** `HOME_SLICE_TO_FIX` (`{ in: ['in_progress'], fixReason: 'set' }`) still
  decides which CARDS are on the tab, so the In progress / To fix partition holds card for card.
- **The list** pages `DISTINCT COALESCE(fixDetail->>'groupKey', 'card:' || id)` over the reader's slice, in the
  existing order (reason priority, then the work tabs' `READY_KIND_RANK`), then reads each page's members by
  `groupKey`. **The count** (`tabCounts.toFix`) is `COUNT(DISTINCT …)` over the same expression. The code card adds
  an expression index on it.
- **The `/items` filter, the tag and the banner stay per card** (work-items § _ONE ENTRY PER RUN_).

### 34.3 The entry (Panels 1, 2, 4)

- **Line 1 is the HEAD**, in `WorkbenchList`'s row, unchanged. It is the head even when the reader holds only a
  member, and even when the head itself is not stuck (a no-branch scope card that never claimed).
- **Line 2 is the § 30 / § 31 fix line, unchanged**, plus ONE clause after the reason, in the affected clause's
  recipe (`shrink-0 text-(--el-text-secondary)`): _· 5 more work items in this run_ for `run:` groups, _· 2 more work
  items on the same pull request_ for `prs:` groups. `runDiedParent` (_Part of ACME-12's run…_) is no longer drawn
  on the Workbench: no leg has a row of its own any more.
- **The member list** (`tf-members`, a `<ul>` named _Work items stuck with ACME-12_): one 32px line per member other
  than the head, on line 1's four columns and indented to the title (`0 28px 0 40px`): the kind glyph, the key
  (mono, 12px, `--el-text-secondary`), the title (12.5px, `--el-text`, truncated), the reader's role on THAT
  member, its assignee, its status pill. Each line is its own link to its card, raised over the entry's stretched
  link the way the repairs are (`relative z-10`). A member line carries **no reason and no repair**.
- **The fold.** Three member lines show; the rest fold behind _Show 2 more work items_, the shipped show-more
  button (`ObsolescenceField`: 12px, `font-medium`, `--el-link`, hover underline, `aria-expanded`,
  `aria-controls` the list). Expanded, it reads _Show fewer_. Local state: no fetch, no URL change.
- **One member** (the common case) draws no clause, no list and no fold: it is the § 30 row pixel for pixel
  (Panel 4).

### 34.4 Whose entry it is (Panel 5)

- An entry is on the reader's tab when they are the assignee or reporter of **ANY** member, which is the slice the
  tab already reads. The role cell on line 1 is the reader's role on the HEAD, or **—** in `--el-text-secondary`.
- Members the reader holds sort FIRST, then the order in § 34.2, so the fold never hides why the entry is here.
- The repairs show when the reader may edit the **head** (the door rule, unchanged). When they may not, § 31's
  sentence (`runDiedCannotEdit`) takes the repairs' place.

### 34.5 States (Panels 3, 6, 7, 8)

- **A pull-request group** (Panel 3): one entry, one `motir fix <HEAD>`, which repairs the set every member shares.
- **Held** (Panel 6): continuing or fixing the head clears every member at once, so the WHOLE entry is held the way
  § 30 holds a row: reason ink `--el-text-secondary`, the repairs replaced by the _Cleared_ chip
  (`workbench.live.cleared`), member titles dimmed, until the refetch drops it. The badge falls by ONE.
- **A member that leaves on its own** (moved to Done, archived) is held IN PLACE: its status cell shows the
  _Cleared_ chip and the clause counts the members still stuck. An entry left with only its head is a § 30 row.
- **Died again during a continue** (Panel 7): the continue is a new run, so the second death is a NEW entry keyed
  by that run, naming who ran it. The old entry, if this session drew it, stays held until the refetch.
- **The pager** (Panel 8): `IssueListPager` pages ENTRIES. An entry is never split across pages, and _Showing 26–27
  of 27_ agrees with the badge.

### 34.6 Copy

| key (proposed)                                                                             | en                                                                                                                                              | zh                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `workbench.toFix.entry.carriesRun`                                                         | {count, plural, one {# more work item in this run} other {# more work items in this run}}                                                       | 此运行中另有 {count} 个工作项                                                                                |
| `workbench.toFix.entry.carriesPullRequests`                                                | {count, plural, one {# more work item on the same pull request} other {# more work items on the same pull request}}                             | 相同拉取请求上另有 {count} 个工作项                                                                          |
| `workbench.toFix.entry.membersLabel`                                                       | Work items stuck with {key}                                                                                                                     | 与 {key} 一起受阻的工作项                                                                                    |
| `workbench.toFix.entry.showMore`                                                           | Show {count, plural, one {# more work item} other {# more work items}}                                                                          | 再显示 {count} 个工作项                                                                                      |
| `workbench.toFix.entry.showFewer`                                                          | Show fewer                                                                                                                                      | 收起                                                                                                         |
| `github.development.continue.hosted.button` (CHANGED)                                      | Continue (was _Continue hosted_)                                                                                                                | 继续（原为“托管继续”）                                                                                       |
| `github.development.continue.hosted.buttonParent` (CHANGED)                                | Continue {key} (was _Continue {key} hosted_)                                                                                                    | 继续 {key}（原为“托管继续 {key}”）                                                                           |
| `github.development.continue.hosted.refused.outOfCredits.body` (CHANGED, names the button) | Nothing was booted and nothing was charged. Continue works again once the organization has credits — or carry it on from your terminal.         | 没有启动任何机器，也没有产生任何费用。组织有积分后即可再次继续——或者在终端中继续。                           |
| `github.development.continue.hosted.runDied` (CHANGED, names the button)                   | This run died — last heard from <b><when></when></b>. Its work is kept on its branch; continue it here or from a terminal in Development below. | 此运行已中断——最后一次联系在<b><when></when></b>。其工作保留在分支上；请在下方“开发”中继续，或在终端中继续。 |
| (shipped) `workbench.live.cleared`                                                         | Cleared                                                                                                                                         | 已解除                                                                                                       |
| (retired from the Workbench) `workbench.toFix.reason.runDiedParent`                        | not drawn by the Workbench any more                                                                                                             | 同左                                                                                                         |

Colour only through `--el-*`; shape only through element-semantic tokens. The delta block (`tf-members`,
`tf-member*`, `tf-more*`) names no raw hue and no raw shape utility. Every text ink is `--el-text` or
`--el-text-secondary` (the show-more button `--el-link`); none is muted or faint.

### What this asset does NOT decide

- **The repairs themselves**: `motir continue`, `motir fix` and the hosted Continue door are § 30 / § 31's (only its button's words change, § 34.6) and the
  runs area's, unchanged.
- **The `/items` To fix filter**: per card, unchanged.
- **Whether a story run should record How to test earlier** so its legs never fan out on a pull-request reason.

### GIVES / TAKES

| card                       | GIVES                                                                                                                                                                                                                                                         | TAKES                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **MOTIR-7589** (the build) | PREMISE: `fixDetail.groupKey` and its rules (§ 34.2), the grouped read, the DISTINCT count, the expression index. ELEMENT: the entry, its clause, the member list and its fold, the held states, every string in § 34.6 and work-items § _ONE ENTRY PER RUN_. | **PREMISE CORRECTED:** pull-request reasons do not fan out to the legs of a story run with a How to test record (§ 34.1). |
| **MOTIR-6599** (§ 30)      | Nothing                                                                                                                                                                                                                                                       | The tab's count and pager now count entries, not cards.                                                                   |
| **MOTIR-6878** (§ 31)      | Nothing                                                                                                                                                                                                                                                       | State 3 (one row per leg) is RETIRED; `runDiedParent` leaves the Workbench.                                               |

## 35 · TO RESUME — a run that stopped at a gate waits here, not dead, until the gate is decided — MOTIR-7702

**The asset:** [`workbench--to-resume.mock.html`](./workbench--to-resume.mock.html), a new delta mock, Panels
**0–9** and the zh panel. **It edits no existing mock.** It amends **§ 21** (the strip order and the landing
cascade, `workbench.mock.html`, MOTIR-5216, as § 30 amended it) and it **composes** § 34's per-run entry
([`workbench--to-fix--per-run.mock.html`](./workbench--to-fix--per-run.mock.html), MOTIR-7590) rather than
redrawing it. The run section's half — the _Stopped at a gate_ marker in the slot where _Run died_ stood — is
`design/runs/design-notes.md` § _Stopped at a gate_ and
[`design/runs/run-section--gated.mock.html`](../runs/run-section--gated.mock.html); its summary is § 35.8 below,
so this one note carries both halves. Card **MOTIR-7702** (Story **MOTIR-7701**), the design gate of
**MOTIR-7712** (this tab) and **MOTIR-7713** (the run section). Rendered against motir-core `origin/main` @
`3e0c981`.

### 35.1 What was wrong

A parent run whose remaining work waits on an approval gate is not broken: its work is committed on its branch
and the next step belongs to a person. Today nothing records which gates held it, so its cards sit on **In
progress** (which reads as alive and busy) or, once the run is read as dead, on **To fix** as _Run died_ (which
reads as broken). Neither says the one true thing — _this run is waiting for an approval, and here is what
happens when it is given._

### 35.2 Where the behaviour comes from — cite per element

| element                                                                                 | specified by                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| a run that stops at a gate closes `gated` and names its HELD GATES (the gate list)      | **MOTIR-7703** — `DispatchRunHeldGate`, derived server-side at the close                                             |
| the five gate kinds a run can be held by                                                | **MOTIR-7703** — `design_result` · `decision_approval` · `decision_choice` · `decision_confirmation` · `manual_work` |
| which cards are on the tab; _waiting on a gate_ vs _ready to resume_; one entry per run | **MOTIR-7707** — `WorkItem.resumeState` + `resumeRunId`, `HOME_SLICE_TO_RESUME`, `listToResume`, `tabCounts`         |
| a sent-back gate stays _waiting_, never _ready_                                         | **MOTIR-7707** §2                                                                                                    |
| what _Ready to resume_ runs — `motir continue <KEY>` and the Continue door              | **MOTIR-7708** — `evaluate()` → `resumable`; refusals `gate_awaiting` / `gate_sent_back`                             |
| _Resuming_ and _Could not resume_, and every skip reason                                | **MOTIR-7710** — the `GateResume` record (`started` / `skipped` + `skipReason`)                                      |
| the Continue door (picker + button)                                                     | **MOTIR-6789** (`design/runs/development--continue-hosted.mock.html`), labelled _Continue_ by § 34                   |
| the approval overlay the gate link opens                                                | **MOTIR-5222** (§ 22) — not redrawn                                                                                  |

### 35.3 The strip and the landing cascade (Panel 0)

- **To resume is THIRD**: Waiting on you · To fix · **To resume** · In progress · To do · Recently finished ·
  Watching. `WORKBENCH_TABS` gains `to-resume` after `to-fix` (MOTIR-7707); the address is `?tab=to-resume`.
- **The cascade gains the same rung, in the same place**: Waiting on you → To fix → **To resume** → In progress
  → To do (terminal). `resolveWorkbenchLanding` adds `if (counts.toResume > 0) return 'to-resume'` between the
  To fix and In progress rungs.
- **Why there.** It needs the reader LESS than the two rungs above it: the decision itself is already on Waiting
  on you (where the reader acts), and a To fix entry does not move without a repair, while a gated run moves the
  moment its gate is approved. It needs the reader MORE than In progress, whose work moves without them: a
  non-hosted run that is ready waits for `motir continue`, and a hosted one that could not resume waits for a
  person. One order for the strip and the cascade, so the strip still explains where the reader landed.
- **The count is ENTRIES (runs)**, like To fix since § 34: `COUNT(DISTINCT resumeRunId)` over the reader's slice.
- **The glyph** is lucide `circle-pause` (a run that paused). The badge is the shipped count chip.

### 35.4 The entry (Panels 1, 2)

One entry per gated run (`resumeRunId`), § 34's anatomy:

- **Line 1** — the HEAD: the gated run's scope card, in `WorkbenchList`'s row, unchanged.
- **Line 2** — `WorkbenchFixLine`'s line with a calm reason: the state's glyph (`--el-icon-muted`, aria-hidden),
  the sentence (`--el-text`), an optional state pill, then the aside in `--el-text-secondary`: **who ran it and
  where** (hosted agent · terminal · runbook · agent instance, read from the run's `origin` / `command`), the
  branch (mono), and § 34's _N more work items in this run_.
- **The gate list** (`tr-gates`, NEW) — one line per held gate: the kind chip (the SHIPPED
  `workbench.approvals.kind.*` label), the subject's key (mono, `--el-text-secondary`) and title (`--el-text`,
  truncated at 28ch), the decider, the gate's state pill, and the door:
  - **The decider** is the gate's assignee, else its reporter (`docs/approval-gates.md`). _Dana P. decides_.
  - **The viewer decides** → _You decide_, the pill _Awaiting you_, and the door is a primary **Review** button
    (their action, not a link); a manual-work gate they own offers the shipped **Guide me through** (§ 33).
  - **Anyone else decides** → **Open**, a `--el-link` link.
  - Both push `?approval=<key>&approvalKind=<kind>` with `shallowPush` and open the shipped approval overlay
    (§ 22, MOTIR-5222) over this tab.
  - The list never folds: a gate is why the entry is here.
- **The next-step line** (`tr-next`, 12px, `--el-text-secondary`) — what happens next, per state.
- **The member list and its fold** — § 34's, verbatim (labelled _Work items waiting with {key}_).

### 35.5 The five states (Panels 1, 3, 4, 5, 6, 7)

| state                              | read from                                                                         | line 2                                                                           | state pill                                                                 | repairs                                                    | next-step line                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Waiting on a gate** (Panel 1, 2) | `resumeState = waiting_on_gate`, every held gate awaiting (MOTIR-7707)            | glyph `circle-pause` · _Stopped at a gate · waiting on N approval(s)_            | none on line 2; each gate _Awaiting_ / _Awaiting you_ (`--el-tint-yellow`) | **none** — the claim refuses `gate_awaiting` (MOTIR-7708)  | hosted: _carries on by itself_ (MOTIR-7710) · otherwise: _continue from your terminal — the command appears here_            |
| **Ready to resume** (Panel 3, 7)   | `resumeState = ready_to_resume`, a non-hosted run (MOTIR-7707)                    | glyph `circle-check` · _Ready to resume · {who} approved {kind} on {key} {when}_ | the approved gate _Approved_ (`--el-tint-mint`)                            | § 34's two: the Continue door + `motir continue <KEY>`     | _An agent picks the run up on its own branch, builds what the approval released, and stops again at any gate still waiting._ |
| **Resuming** (Panel 4)             | the newest `GateResume` is `started` (MOTIR-7710)                                 | glyph `circle-ellipsis` · _Resuming on the hosted agent · started {when}_        | _Resuming_ (`--el-tint-sky`)                                               | replaced by _See the run_ (`--el-link`); the entry is HELD | none                                                                                                                         |
| **Could not resume** (Panel 5)     | the newest `GateResume` is `skipped` + `skipReason` (MOTIR-7710)                  | glyph `circle-slash` · _Could not resume by itself · {reason}_                   | _Didn't resume_ (neutral chip)                                             | § 34's two                                                 | _Nothing was booted and nothing was charged._ + the reason's own repair (§ 35.6)                                             |
| **Gate sent back** (Panel 6)       | a held gate `changes_requested` / `declined` / `overturned`; column stays waiting | glyph `undo-2` · the decision quoted, the way To fix quotes a Request changes    | the gate's pill names the outcome (neutral chip)                           | **none** — the claim refuses `gate_sent_back` (MOTIR-7708) | per outcome (§ 35.6). Nothing resumes.                                                                                       |

- **Held (Resuming)** is § 26 / § 34's hold: `tf-held` (reason ink `--el-text-secondary`, member titles dimmed)
  until the refetch drops the entry — the continue claim nulls the column (MOTIR-7707) and the cards return to
  In progress. The badge falls by ONE. No toast and no notification (MOTIR-7710 sends none).
- **Several gates, some decided** (Panel 7): one approved gate is enough for _ready_; line 2 reads _Ready to
  resume · 1 of 3 approvals given_; the list shows every gate with its own pill, decided first; the next-step
  line says continuing now stops again at the rest (MOTIR-7708 §4). A HOSTED run in that mix resumed itself on
  the first approval (Resuming).
- **A hosted run is never drawn _Ready to resume_ for long**: its auto-resume moves it to Resuming or Could not
  resume. `already_resumed` is Resuming; `not_a_candidate` writes no record and the run is Ready to resume.
- **The tone is calm everywhere**: no danger or warning token, no `triangle-alert`. These runs are waiting.
- **Empty** (Panel 8): the shipped `EmptyState`, glyph `circle-pause`, no action.
- **Narrow** (Panel 9): `WorkbenchList`'s `< md` stacked row (workbench.mock.html Panel 7); the strip scrolls;
  line 2, the gate lines and the repairs wrap; the aside may wrap (`.tr-narrow .tf-aside { flex-shrink: 1 }`).

### 35.6 Copy (en + zh)

| key (proposed)                                                             | en                                                                                                                                                                                 | zh                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `workbench.tabs.toResume`                                                  | To resume                                                                                                                                                                          | 待继续                                                                                                               |
| `workbench.empty.toResume.title`                                           | Nothing to resume                                                                                                                                                                  | 没有待继续的运行                                                                                                     |
| `workbench.empty.toResume.body`                                            | When a run stops at an approval it needs, it waits here until the approval is given — then it carries on by itself on the hosted agent, or with motir continue from your terminal. | 当运行停在它所需的审批处时，会在这里等待，直到审批通过——随后在托管代理上自动继续，或在终端中用 motir continue 继续。 |
| `workbench.toResume.waiting`                                               | Stopped at a gate · waiting on {count, plural, one {# approval} other {# approvals}}                                                                                               | 停在审批处 · 等待 {count} 项审批                                                                                     |
| `workbench.toResume.ready`                                                 | Ready to resume · {name} approved the {kind} on {key} <when></when>                                                                                                                | 可以继续 · {name} 已于<when></when>批准 {key} 的{kind}                                                               |
| `workbench.toResume.readyByYou`                                            | Ready to resume · you approved the {kind} on {key} <when></when>                                                                                                                   | 可以继续 · 你已于<when></when>批准 {key} 的{kind}                                                                    |
| `workbench.toResume.readySome`                                             | Ready to resume · {approved} of {total} approvals given                                                                                                                            | 可以继续 · {total} 项审批中已通过 {approved} 项                                                                      |
| `workbench.toResume.resuming`                                              | Resuming on the hosted agent · started <when></when>                                                                                                                               | 正在托管代理上继续 · <when></when>开始                                                                               |
| `workbench.toResume.couldNot`                                              | Could not resume by itself · {reason}                                                                                                                                              | 未能自动继续 · {reason}                                                                                              |
| `workbench.toResume.ranBy.hosted`                                          | {name} ran it on the hosted agent                                                                                                                                                  | {name} 在托管代理上运行                                                                                              |
| `workbench.toResume.ranBy.terminal`                                        | {name} ran it from a terminal                                                                                                                                                      | {name} 在终端中运行                                                                                                  |
| `workbench.toResume.ranBy.runbook`                                         | {name} ran it with the runbook                                                                                                                                                     | {name} 通过运行手册运行                                                                                              |
| `workbench.toResume.ranBy.instance`                                        | {name} ran it in {agent}                                                                                                                                                           | {name} 在 {agent} 中运行                                                                                             |
| (`{name}` for the viewer)                                                  | you                                                                                                                                                                                | 你                                                                                                                   |
| `workbench.toResume.branch`                                                | branch <d>{branch}</d>                                                                                                                                                             | 分支 <d>{branch}</d>                                                                                                 |
| `workbench.toResume.entry.membersLabel`                                    | Work items waiting with {key}                                                                                                                                                      | 与 {key} 一起等待的工作项                                                                                            |
| `workbench.toResume.gatesLabel`                                            | Gates holding {key}'s run                                                                                                                                                          | 使 {key} 的运行停下的审批                                                                                            |
| `workbench.toResume.decider`                                               | <b>{name}</b> decides                                                                                                                                                              | 由 <b>{name}</b> 决定                                                                                                |
| `workbench.toResume.deciderYou`                                            | <b>You</b> decide                                                                                                                                                                  | 由<b>你</b>决定                                                                                                      |
| `workbench.toResume.decidedBy`                                             | approved by <b>{name}</b> <when></when>                                                                                                                                            | <b>{name}</b> 已于<when></when>批准                                                                                  |
| `workbench.toResume.gate.awaiting`                                         | Awaiting                                                                                                                                                                           | 等待中                                                                                                               |
| `workbench.toResume.gate.awaitingYou`                                      | Awaiting you                                                                                                                                                                       | 等你处理                                                                                                             |
| `workbench.toResume.gate.approved` · `chosen` · `confirmed` · `markedDone` | Approved · Chosen · Confirmed · Marked done                                                                                                                                        | 已批准 · 已选择 · 已确认 · 已标记完成                                                                                |
| `workbench.toResume.gate.changesRequested` · `declined` · `overturned`     | Changes requested · Declined · Overturned                                                                                                                                          | 已要求修改 · 已拒绝 · 已推翻                                                                                         |
| `workbench.toResume.open`                                                  | Open                                                                                                                                                                               | 打开                                                                                                                 |
| `workbench.toResume.review`                                                | Review                                                                                                                                                                             | 查看并决定                                                                                                           |
| (shipped, § 33) manual work's door                                         | Guide me through                                                                                                                                                                   | 带我完成                                                                                                             |
| `workbench.toResume.state.resuming`                                        | Resuming                                                                                                                                                                           | 继续中                                                                                                               |
| `workbench.toResume.state.couldNot`                                        | Didn't resume                                                                                                                                                                      | 未继续                                                                                                               |
| `workbench.toResume.seeRun`                                                | See the run                                                                                                                                                                        | 查看运行                                                                                                             |
| `workbench.toResume.next.waitingHosted`                                    | Once it is approved, this run carries on by itself on the hosted agent.                                                                                                            | 审批通过后，此运行会在托管代理上自动继续。                                                                           |
| `workbench.toResume.next.waitingHostedMany`                                | When any one is approved, this run carries on by itself on the hosted agent and stops again at the rest.                                                                           | 任一审批通过后，此运行会在托管代理上自动继续，并在其余审批处再次停下。                                               |
| `workbench.toResume.next.waitingLocal`                                     | Once you approve it, continue the run from your terminal — the command appears here.                                                                                               | 审批通过后，在终端中继续——命令会显示在这里。                                                                         |
| `workbench.toResume.next.ready`                                            | An agent picks the run up on its own branch, builds what the approval released, and stops again at any gate still waiting.                                                         | 智能体会在原分支上接手此运行，构建该审批放行的工作，并在仍需等待的审批处再次停下。                                   |
| `workbench.toResume.next.readySome`                                        | Continuing now builds what the approved gate released, and stops again at the {count} still waiting.                                                                               | 现在继续会构建已通过审批放行的工作，并在仍在等待的 {count} 项审批处再次停下。                                        |
| `workbench.toResume.next.couldNot`                                         | Nothing was booted and nothing was charged. {repair}                                                                                                                               | 没有启动任何机器，也没有产生任何费用。{repair}                                                                       |
| `workbench.toResume.copyAria`                                              | Copy the resume command for {key}                                                                                                                                                  | 复制 {key} 的继续命令                                                                                                |
| (shipped, § 34) the door's button                                          | Continue                                                                                                                                                                           | 继续                                                                                                                 |

**Every skip reason MOTIR-7710 records** — `workbench.toResume.skip.<reason>` (line 2's `{reason}`) and
`workbench.toResume.repair.<reason>` (the next-step line's `{repair}`):

| `skipReason`              | reason — en                                                         | reason — zh                              | repair — en                                                                      | repair — zh                                            |
| ------------------------- | ------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `out_of_credits`          | the organization is out of credits                                  | 组织的积分已用完                         | Add credits in billing, then press Continue — or continue from your terminal.    | 在账单中充值后按“继续”——或在终端中继续。               |
| `ci_credits_exhausted`    | the organization's CI credits are used up                           | 组织的 CI 积分已用完                     | Add CI credits in billing, then press Continue — or continue from your terminal. | 在账单中充值 CI 积分后按“继续”——或在终端中继续。       |
| `credits_unavailable`     | Motir couldn't check the organization's credits                     | Motir 无法查询组织的积分                 | Press Continue to try again.                                                     | 按“继续”重试。                                         |
| `model_not_offered`       | the model it ran with, {model}, is no longer offered                | 它使用的模型 {model} 已不再提供          | Pick another model and press Continue.                                           | 选择其他模型后按“继续”。                               |
| `models_unavailable`      | Motir couldn't load the list of models                              | Motir 无法加载模型列表                   | Press Continue to try again.                                                     | 按“继续”重试。                                         |
| `no_project_access`       | <b>{name}</b>, who started it, no longer has access to this project | 启动它的 <b>{name}</b> 已无权访问此项目  | Continue it yourself — it runs as you, on your organization's credits.           | 由你来继续——它将以你的身份运行，使用你所在组织的积分。 |
| `dispatcher_gone`         | <b>{name}</b>, who started it, is no longer in this workspace       | 启动它的 <b>{name}</b> 已不在此工作区    | Continue it yourself — it runs as you, on your organization's credits.           | 由你来继续——它将以你的身份运行，使用你所在组织的积分。 |
| `repository_not_writable` | Motir can no longer push to {repo}                                  | Motir 已无法推送到 {repo}                | Reconnect the repository in the project's settings, then press Continue.         | 在项目设置中重新连接代码仓库后按“继续”。               |
| `card_not_ready`          | {key} is not ready to run — it is blocked or no longer in progress  | {key} 尚不能运行——它被阻塞或已不在进行中 | Clear what blocks {key} or move it back to In Progress, then press Continue.     | 解除 {key} 的阻塞或将其移回进行中后按“继续”。          |

**Gate sent back** — `workbench.toResume.back.<outcome>` (line 2) and `workbench.toResume.next.<outcome>`:

| outcome             | line 2 — en                                                      | line 2 — zh                                      | next — en                                                                                                                  | next — zh                                                                                    |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `changes_requested` | {kind} sent back · changes requested by <b>{name}</b> — “{note}” | {kind}被退回 · <b>{name}</b> 要求修改 ——“{note}” | Nothing resumes. {key} is reworked first; its next version asks again, and this run keeps waiting.                         | 不会继续。{key} 需先修改；新版本会再次请求审批，此运行继续等待。                             |
| `declined`          | Decision declined by <b>{name}</b> — “{note}”                    | 决策被 <b>{name}</b> 拒绝 ——“{note}”             | Nothing resumes. The work this would have released needs a new plan — re-plan {key}, or set {head} to To Do to start over. | 不会继续。该审批原本放行的工作需要重新规划——重新规划 {key}，或将 {head} 设为待办以重新开始。 |
| `overturned`        | Approval overturned by <b>{name}</b> — “{note}”                  | 批准被 <b>{name}</b> 推翻 ——“{note}”             | Nothing resumes. The approval no longer stands, so the run waits for a new decision on {key}.                              | 不会继续。该批准已不再有效，此运行将等待对 {key} 的新决定。                                  |

`{kind}` takes the shipped `workbench.approvals.kind.*` label (Design result · Decision approval · Choice · Confirm
decision · Manual work / 设计成果 · 决策审批 · 选择 · 确认决策 · 人工工作), lower-cased in running en text.
`<when>` is `relativeLabel` on a `<time datetime>`, as § 31.

### 35.7 Tokens

Colour only through `--el-*`; shape only through element-semantic tokens. The delta block (`tr-*`) names no raw
hue and no raw shape utility:

| element                        | colour                                                                                                                                                                    | shape                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| reason glyph (`tr-glyph`)      | `--el-icon-muted` (aria-hidden)                                                                                                                                           | 14px                                   |
| state pill (`tr-state--*`)     | waiting `--el-tint-yellow` · ready `--el-tint-mint` · resuming `--el-tint-sky`, ink `--el-text-strong`; quiet `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary` | `--radius-badge`, `--spacing-chip-x/y` |
| kind chip (`tr-kind`)          | `--el-chip-bg` / `--el-chip-border` / `--el-text-secondary`                                                                                                               | `--radius-badge`, `--spacing-chip-x/y` |
| gate key · decider             | `--el-text-secondary` (name in `--el-text`)                                                                                                                               | —                                      |
| gate title                     | `--el-text`                                                                                                                                                               | —                                      |
| Open / See the run (`tr-link`) | `--el-link`                                                                                                                                                               | —                                      |
| Review / Guide me through      | the shipped primary `Button` (`btn-primary`)                                                                                                                              | `--radius-btn`, `--height-btn-sm`      |
| next-step line (`tr-next`)     | `--el-text-secondary`, emphasis `--el-text`                                                                                                                               | —                                      |
| empty glyph                    | `--el-icon-muted`                                                                                                                                                         | —                                      |

Every text ink is `--el-text`, `--el-text-strong` or `--el-text-secondary` (links `--el-link`); none is muted or
faint, so the rows clear AA on the page and on the `:hover` `--el-surface` fill alike.

### 35.8 The run section's half — `design/runs/` § _Stopped at a gate_ (summary)

[`run-section--gated.mock.html`](../runs/run-section--gated.mock.html), Panels **G1–G6** + zh, amends
`run-section--run-died.mock.html` Panel R1 (MOTIR-6529). Built by **MOTIR-7713**.

- **The marker, in the Run died line's slot**: the RUN pill reads **Stopped at a gate** (`--el-tint-yellow`,
  `circle-pause`) — never _Run died_ — and the line says _This run stopped at a gate — waiting on {gate}._ with
  what happens on approval (hosted: carries on by itself; otherwise `motir continue <KEY>`). The held gates follow,
  one row each, with _Open_ (MOTIR-7703).
- **Ready to resume** shows the copyable `motir continue <KEY>`; **Resuming** links to the new run (_See the new
  run_); **Could not resume** names the reason in § 35.6's words and points to To resume; **Sent back** says
  nothing resumes (MOTIR-7707 / 7708 / 7710).
- **Its run-history row** carries the _Stopped at a gate_ pill; the resumed continue's row says _resumed after an
  approval_.
- **A CHILD card** of the gated parent run says the same about the parent's run and points UP to it
  (`corner-left-up`), with _part of {parent}_ on its history row.
- A genuinely died run keeps MOTIR-6529's copy, unchanged.

### What this asset does NOT decide

- **The approval overlay** the gate link opens (§ 22, MOTIR-5222), and **the Continue door** (MOTIR-6789) — placed,
  not redrawn.
- **To fix's per-run entry** (§ 34) — composed, unchanged. A died run stays on To fix as _Run died_.
- **Whether a resume notifies anyone** — MOTIR-7710 sends nothing.

### GIVES / TAKES

| card                         | GIVES                                                                                                                                                          | TAKES                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **MOTIR-7712** (the tab)     | ELEMENT: the strip slot and count, the entry in five states, the gate list and its doors, the mixed case, the empty state, the narrow reflow, § 35.6's strings | the column and its reads from MOTIR-7707; the resume record from MOTIR-7710                   |
| **MOTIR-7713** (run section) | ELEMENT: the marker, its history row, the Resuming line, the child variant (§ 35.8 / runs § _Stopped at a gate_)                                               | the held gates (MOTIR-7703); the resumed-after-approval mark on the continue run (MOTIR-7708) |
| **MOTIR-7707** (the column)  | PREMISE: the tab id `to-resume` sits after `to-fix` in `WORKBENCH_TABS`; the cascade rung (§ 35.3); the count is entries                                       | nothing new                                                                                   |
| **MOTIR-7710** (auto-resume) | PREMISE: each `skipReason` has words and a repair (§ 35.6); `already_resumed` reads as Resuming; `not_a_candidate` is Ready to resume                          | nothing new                                                                                   |
| **§ 21 / MOTIR-5216**        | Nothing                                                                                                                                                        | The strip gains a seventh tab, and the cascade a rung between To fix and In progress.         |

## 36 · GROUPED BY RUNNABLE CONTAINER — To do, In progress and Recently finished draw work under its story, task or bug — MOTIR-8013

**The asset:** [`workbench--grouped.mock.html`](./workbench--grouped.mock.html), a new delta mock, Panels **0–10**.
**It edits no existing mock.** Card **MOTIR-8013** (Story **MOTIR-8012**), the design gate of **MOTIR-8016**
(the page). Rendered against motir-core `origin/main` @ `8fd441b`.

It amends § _Layout_, § _The ORDER_, § _The pager_, § _Narrow_ and § _26_ for **these three tabs only**. Watching,
Waiting on you, To fix, Planning and To resume are untouched; To fix and To resume keep grouping by RUN (§ 34,
§ 35), which is a different key.

It **composes** shipped pieces and redraws none of them:

| piece                                       | from                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| the row, every cell, the CI glyph           | `WorkbenchList` (§ _Layout_, § _The CI badge_)                                        |
| the chevron, the reserved 16px slot, indent | `/ready`'s `ReadyContainerRow` (`design/ready/design-notes.md` § _Rows_, `ml-[22px]`) |
| the count                                   | the strip's count chip (`--el-count-bg` / `--el-count-text`, `--radius-badge`)        |
| the pager                                   | `IssueListPager`, unchanged, as To fix pages entries since § 34                       |
| the empty states                            | § _Empty states_, unchanged                                                           |
| the runnable-container rule                 | `isRunnableContainer` in `lib/workItems/readyFilter.ts`; NOT re-declared              |

### 36.1 What heads a group

A work item on the tab whose **parent is a runnable container** (a `story`, `task` or `bug` none of whose children
has children) is drawn under that parent's **group row**. Everything else is a **standalone row**: a task under an
epic, an item filed into a folder with no parent, a childless bug, and a child of a container that is NOT runnable.
Grouping is **one level**: a subtask groups under its own direct parent when that parent is runnable, never under a
grandparent (Panel 3, `ACME-81`).

A group row is drawn only when **at least one member is on the tab**. A container on the tab with no members on the
tab is a plain standalone row.

### 36.2 The member head and the context head (Panels 1–2)

- **Member head** — the container is itself on this tab (the reader holds it and it is in this category). It IS the
  group row, with every cell of an ordinary row, and it is **never drawn a second time** as a separate row.
- **Context head** — the container is in another category, or belongs to someone else. It still heads the group so
  the members have a name. It is drawn as context: its title in `--el-text-secondary`, the Your-role cell replaced by
  the marker **Not on this tab**, the Assignee cell empty, no CI glyph, no Finished value. It **keeps its Status
  pill**, which tells the reader where the container is. It opens the peek like any row.

### 36.3 The group row

`[chevron] [kind icon] KEY  Title  [count]  …cells`. The chevron is `/ready`'s: a 16px button, a 12px
`ChevronRight` turned 90° when open, `aria-expanded`, named **Expand {key}** / **Collapse {key}**. Every row on the
tab reserves the 16px slot, so all titles start on one edge. Members are indented one tree level, **22px**. The
group is a `rowgroup` named **Work items under {key}**.

**The count** is the number of the group's members **on this tab**, excluding the head. It is not a readiness ratio
and no total of children is shown — "3 of 7" reads as progress, and the total is one click away in the peek. A count
of **0 is not drawn** (the strip's own zero rule).

### 36.4 The order

- **To do and In progress** — members by `compareReadyPosition` (kind in `READY_KIND_RANK` order, then priority
  highest first, then key ascending); groups by `groupRank` over their best member, a standalone row ranking as a
  group of one. **This amends § _The ORDER_**, which was `(kind, id DESC)`: groups ranked one way and members another
  would contradict each other.
- **Recently finished** — members by `completedAt DESC`; groups by their newest member's `completedAt`, the head key
  as the tie-break (Panel 4).

### 36.5 Expand state

Collapsed by default, **except a tab holding exactly one group, which renders it open** (Panel 5) — `/ready`'s
rule. The state is client-local, keyed by the container id, and **not in the URL**. It survives a live update and
resets on the next LOAD (a pager move, a tab switch, a reload).

### 36.6 The pager (Panel 6)

`HOME_PAGE_SIZE` = 25 **top-level rows** a page — a group row or a standalone row. A group is **never split**
across pages, and every item on the tab appears exactly once across pages. The range line therefore counts rows
while the strip counts work items; the difference is intended and gets no caption. `IssueListPager` and its copy
are unchanged.

### 36.7 Live (Panel 7) — § 26 unchanged

A nudge adds and updates, it never removes. A member that leaves is **held in place, unmarked** on these three tabs
(as today). The count is the server's and moves at once. An arrival into a collapsed group raises the count and puts
the shipped **New** pill on the group row; an arrival that makes a new group lands where a reload would put it. When
the last member leaves, the group is held whole until the next load, with no count drawn.

### 36.8 Narrow (Panel 8), dark (Panel 9), zh (Panel 10)

Narrow is § _Narrow_'s two-line row; the chevron leads line 1 and the 22px indent is kept on both lines. Dark is the
same tokens on `data-theme="dark"`. Status labels are the project's workflow names and are not translated here.

### 36.9 Copy — `workbench.group.*`

| key                        | en                                                                              | zh                            |
| -------------------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| `workbench.group.expand`   | Expand {key}                                                                    | 展开 {key}                    |
| `workbench.group.collapse` | Collapse {key}                                                                  | 收起 {key}                    |
| `workbench.group.count`    | {count, plural, one {# work item on this tab} other {# work items on this tab}} | 此标签页中有 {count} 个工作项 |
| `workbench.group.context`  | Not on this tab                                                                 | 不在此标签页                  |
| `workbench.group.members`  | Work items under {key}                                                          | {key} 下的工作项              |

The count chip shows the bare number; `workbench.group.count` is its accessible name and title.

### 36.10 Token map

| element                        | colour                                                       | shape                                  |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------- |
| row / group row                | `--el-text`; key `--el-text-secondary`; hover `--el-surface` | height 44px as `WorkbenchList`         |
| context head title, held title | `--el-text-secondary`                                        | —                                      |
| context marker                 | `--el-text-secondary`, italic                                | —                                      |
| chevron                        | `--el-text-secondary`; hover `--el-muted` / `--el-text`      | `--radius-control`                     |
| count chip                     | `--el-count-bg` / `--el-count-text`                          | `--radius-badge`, `--spacing-chip-x`   |
| kind icon                      | `--el-type-{story,task,bug,subtask}`                         | —                                      |
| status pill                    | tint fill, `--el-text-strong`                                | `--radius-badge`, `--spacing-chip-x/y` |
| New pill                       | `--el-chip-bg` / `--el-chip-border`, `--el-text-secondary`   | `--radius-badge`                       |
| row divider in a group         | `--el-border-soft`; between groups `--el-border`             | —                                      |

Every text ink is `--el-text`, `--el-text-strong` or `--el-text-secondary`; none is muted or faint, so the rows clear
AA on the page and on the `:hover` `--el-surface` fill alike.

### What this asset does NOT decide

- **A run control on a group row** — the Workbench offers none; `/ready`'s refinement is MOTIR-7837.
- **Grouping on Watching, Waiting on you, To fix, Planning or To resume** — unchanged.
- **The strip counts, the landing cascade, the membership predicate and the finished window** — unchanged.

### GIVES / TAKES

| card                           | GIVES                                                                                                                                                                                                                                                | TAKES                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **MOTIR-8016** (the page)      | ELEMENT: the group row, chevron, count, context head and marker, indent, expand state, the pager over rows, the live behaviour, narrow, every string in § 36.9. Fits its estimate: it composes shipped pieces.                                       | the group shape from MOTIR-8015                                                           |
| **MOTIR-8015** (the service)   | PREMISE: a page item is a group `{ head, headOnTab, members[], memberCountOnTab }` or a standalone row; the context head carries its status label (the `HOME_WORK_ITEM_SELECT` row); the pager `total` counts top-level rows; § 36.4's orders. Fits. | the light projection and reads by id from MOTIR-8014                                      |
| **MOTIR-8014** (the reads)     | PREMISE: context heads are read by id (`findHomeRowsByIds`) as full rows, so they can show their status. Fits.                                                                                                                                       | nothing new                                                                               |
| **MOTIR-8018** (E2E)           | ELEMENT: the panels to assert — S (3) and T (1), member vs context head, the epic-parented task standalone, Recently finished newest group first, the pager keeping groups whole, zh.                                                                | nothing new                                                                               |
| **§ _The ORDER_ / MOTIR-4851** | Nothing                                                                                                                                                                                                                                              | To do and In progress members now order by `compareReadyPosition`, not `(kind, id DESC)`. |

## 37 · A PLAN BEING REWRITTEN IS UNDER PLANNING — it leaves Waiting on you while its revision holds it, and comes back when the rewrite ends — MOTIR-7988

**Amends § 33.1's copy table** (`approvalGate.planApproval.surface.held`, `.surface.heldBy`,
`.handoff.rewriting`) and `docs/decisions/approval-gates.md` § 11.5c. **No panel changes, so there is no
delta mock:** the held surface (overlay mock Panel 4 of the plan-approval design) draws the same bar,
the same two disabled verbs and the same reason line; only the reason's last clause moves, and the
Planning tab's row is the one it already draws for a plan being written.

- **The rule.** A `planned` plan whose revision lease is held is being planned again — nothing waits on
  its requester while the planner rewrites it. So its row leaves **Waiting on you** (list, count chip and
  watermark alike) and is listed under **Planning**, with the plan's progress, until the rewrite ends or
  the lease runs out. Its gate stays `awaiting`; Approve and Decline are refused while held. This is a
  LISTING rule over the lease, not a status.
- **The copy says where the plan is now**, because "it stays in Waiting on you meanwhile" became false.

| key                                           | en                                                                                                                                                                   | zh                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `approvalGate.planApproval.surface.held`      | Motir AI is writing a new version of this plan. Approve and Decline come back when it finishes — until then it is under Planning, and it returns to Waiting on you.  | Motir AI 正在编写此计划的新版本。完成后即可批准或拒绝——在此之前它在“规划”中，完成后回到“等你处理”。  |
| `approvalGate.planApproval.surface.heldBy`    | {harness} is writing a new version of this plan. Approve and Decline come back when it finishes — until then it is under Planning, and it returns to Waiting on you. | {harness} 正在编写此计划的新版本。完成后即可批准或拒绝——在此之前它在“规划”中，完成后回到“等你处理”。 |
| `approvalGate.planApproval.handoff.rewriting` | … it is under Planning while I work, and it comes back to `<link>`Waiting on you`</link>` for you to decide once I'm done.                                           | ……我编写期间它在“规划”中，等我完成后它会回到`<link>`等你处理`</link>`，由你决定。                    |

- **`approvalGate.planApproval.row.rewriting` (_Being rewritten_) is kept, and is no longer reached from
  the queue.** The queue does not list a held plan, so no row there carries `held`; `ApprovalRow` keeps
  the pill for any row whose DTO still does, rather than this change removing a state from the row.

## 37 · THE PLANNING SESSION THAT NEEDS YOU — a row in Waiting on you, an entry in To resume, and Planning's leave frame — MOTIR-7907 (Story MOTIR-7905)

Mock: `workbench--planning-session-needs-you.mock.html` (a DELTA — it edits no existing mock; it composes §§ 21, 26, 29, 35, 36 and renders the real `@motir/design-system` parts). Decision: MOTIR-7906 (a failed hosted attempt keeps its session and waits in To resume; a planner's question or a conversation left waiting is a gate in Waiting on you). Two sibling designs: `design/ai-chat/design-notes.md` (the overlay and the refusal) and `design/ai-planning/design-notes.md` (the Plans page). Behaviour is specified by MOTIR-7913 (the gate), MOTIR-7914 / MOTIR-7939 (the To resume read), MOTIR-7916 (Resume).

### 37.1 The Waiting on you row (panels 1–4, 13–15)

- **One gate kind, two causes, one anatomy.** Line 1 is § 29's plan leading line, composed from `approvalGate.planApproval.row.*` and never re-worded (_Plan for {title}_ + key · _Plan — {title}_ · _Plan for {project}_), the `Planning session` kind chip and _since {when}_. Line 2 is the cause's lead: **the planner asked** — `Motir AI asked:` + the question, one truncated line (two at md for a long one, the full text on open); **waiting on your reply** — `Motir AI is waiting for your reply.` + the planner's last turn in a line, no question mark.
- **No decide buttons.** The decision IS the next turn, so the row has no Approve / Decline (the handler offers no verb: `no_verbs_on_planning_session`).
- **The approval overlay (MOTIR-5222) is SKIPPED for this kind.** It exists to carry a decision; a session row has nothing to decide, and a second overlay in front of the planning overlay would be one step more between a person and their answer. The row's door IS the planning overlay.
- **The door:** MOTIR-7884's one plan-overlay door, `planVia=approvals` (the existing entrance), so the reopened line reads _Reopened from Waiting on you_; **Back returns to Waiting on you**. A plain click is `shallowPush`; a modified click keeps the full URL.
- **It never shares a plan with a `plan_approval` row.** A planning-session gate exists only while the SESSION waits on its person; a plan that is `planned` already has its own question on `plan_approval` (§ 29), and the planning-session gate "never replaces or doubles a plan's own question" (`approval-gates.md` § _Deliberately NOT decided here_). Panel 4 draws the two beside each other for DIFFERENT plans.
- **Count:** the tab count includes the row (`tabCounts().approvals`); an awaiting-person session that no longer waits leaves the list and the count (the liveness set in `approvalGateRepository`).

### 37.2 The To resume entry (panels 5–11, 13–15)

It composes the per-run entry's frame (§ 35: line 1 + line 2, held row, state pill) and does not borrow its columns — a session is not a run, so there is no `motir continue` and no gate list. Line 1: plan lead + state pill + _failed {when}_. Line 2: **where the walk stopped** in the compact progress line's step words (_Laying {title}_ · _Writing {title}_ · _Laying the project's top level_ · _Drafting a new item_) · **why** in words (the stable code translated; never the raw code) · _N of M written_. Actions: **Resume** (primary) and **Open** (the overlay through MOTIR-7884, `planVia=resume` — a new entrance value, so the reopened line reads _Reopened from To resume_).

- **States:** waiting to resume · **resuming** (the held row of § 26 as § 35 adopted it: Resume disabled, a note, the row clears when the attempt starts) · **failed again** (the new reason replaces the old; a quiet _Second attempt_ note; **earlier reasons are not listed** — one failure is the thing to act on) · **could not start a resume** (words for out of credits, neither the starter nor a project manager, session ended meanwhile; the last has no Resume).
- **Order and count:** sessions first (newest failure first), gated runs after, under ONE `total`; the strip's To resume count counts both (`homeService.listToResume` / `tabCounts`).
- **Tone:** calm, as § 35 — the `Waiting to resume` pill is the gate's Awaiting tint (`--el-tint-yellow`), no danger ink; the failure is a fact in the second line, not an alarm.
- **Empty state unchanged** (panel 11).

### 37.2a Who may resume — CHANGED after review (Mo, 2026-10-10: _"A manager should be able to resume any plan in the project, not only the user who started the plan"_)

Resume is offered to **the session's starter OR a project manager** (the holder of `ai:configure`; every member holds `ai:decide_plan`, so that key would let everyone in). Consequences drawn in panels 9 and 16 and in the overlay mock (3b, 3c) and Plans mock (2b):

- **To resume stays the READER'S OWN list**, with its count and watermark: a manager's tab does not fill with every member's failures, so the badge still means _mine_. **A manager reaches another member's failed session from the Plans page** (the _Waiting to resume_ tab and its rows, which already show the starter's name), and the overlay offers **Resume** there, with _started by {name} · you can resume it as a project manager_.
- **A plain member who did not start it** opens the overlay read-only: the failure block says _Only {name} or a project manager can resume this_; no Resume, no _Plan something new_, no composer.
- The refusal sentence for a caller who may not resume reads _Only the person who started this session or a project manager can resume it_ (`NOT_SESSION_OWNER`, wording only).
- The manager's resume spends the **manager's** credits context and takes no hold: the card hold stays with the starter. Whether a manager should instead see every member's failures in a tab of their own is left open on purpose, for the reviewer.

### 37.3 The Planning tab's leave frame (panel 12)

A plan whose session failed leaves Planning (MOTIR-7914). Its held row's chip reads _Moved to To resume_ with the line _Its attempt failed, and the plan so far is kept. Resume it from To resume._ and a link to the tab. This is the ONLY change to Planning (a delta on MOTIR-7823's leave frame).

### 37.4 Absent, on purpose

An MCP-authored plan and a `guide` session appear in neither tab. A person-ended session reads Closed / Declined exactly as MOTIR-7633 / MOTIR-7634 drew it.

### 37.5 Token map

Text `--el-text` / `--el-text-secondary` (never `--el-text-muted` or `--el-text-faint` on a surface row); borders `--el-border`; glyph `--el-icon-muted`; accent mark `--el-accent-on-surface`; the state pill `--el-tint-yellow` + `--el-text-strong`; shapes `--radius-badge`, `--radius-card`, `--spacing-chip-*`. No hex, no raw hue.

### 37.6 Strings (en / zh — the code cards add them as keys)

`workbench.planningSession.kind` Planning session / 规划会话 · `.asked` Motir AI asked / Motir AI 提了一个问题 · `.waitReply` Motir AI is waiting for your reply / Motir AI 在等你回复 · `.since` since {when} / 自 {when} · `.open` Open / 打开 · `.resume` Resume / 继续 · `.resuming` Resuming… / 正在继续… · `.failedAt` failed {when} / {when}失败 · `.written` {n} of {m} written / 已写 {n}/{m} · `.second` Second attempt / 第二次尝试 · `.stoppedAt` Stopped at / 停在 · `.because` because / 原因： · `.waitingToResume` Waiting to resume / 待继续 · `.refusal.credits|notOwner|ended` the three sentences in panel 9 · `.reason.<code>` the reason words in panel 6 · `.left.title|line|link` Moved to To resume … · `approvalGate.planningSession.row.*` for the gate's row and lead lines. No zh string calls the first tab _待审批_ (it is _等你处理_).

### 37.7 GIVES / TAKES

GIVES: MOTIR-7917 (the whole Workbench surface above; sized 70 min — now also owns the leave frame and nine states, still fits as the entry composes shipped frames, re-check at claim); MOTIR-7913 and MOTIR-7914 (the row fields read: cause, question text, last-turn line; failure record, form, waiting plan) ; MOTIR-7916 (the three refusal sentences' conditions). TAKES: nothing from MOTIR-7702 or MOTIR-7823 beyond the leave frame's wording (a delta); MOTIR-5222's overlay is not reached by this kind. Touches without changing: MOTIR-7884 (door), MOTIR-6033 (§ 29 naming), MOTIR-7476 (tab name).

## 38 · TO RESUME, SITUATION 2 — a failure beside a waiting plan, and a conversation that ended `failed` before — MOTIR-7935 (Story MOTIR-7905)

Mock: `workbench--to-resume--situation-2.mock.html` (a DELTA; edits no existing mock, MOTIR-7907's included). It composes § 35's tab and § 37's entry frame. Decision: MOTIR-7906, consequences 6–8.

- **Form (B) — a failed revision of a waiting plan (panels 1, 2).** The entry names the WAITING plan (§ 29 forms) and its state in words (_Waiting for your approval_, or _Out of date_ for `stale`), then the failure as **your last change to this plan could not be made** (the failed-revision wording), _failed {when}_, and the next step on its own line: _The plan is still waiting. Reply to carry on._ — or, for a stale plan, _The work it changes has finished. Plan it again to carry on._ **Open only: no Resume, and no _N of M written_** (the waiting plan is complete). A newer failed run is form (A+) below, so there is no separate "newer run" wording to settle.
- **Form (B) with a newer failed walk (panel 3).** ONE entry per session, **led by the failed walk** (stop, why, _N of M written_, **Resume**), with a second line naming the plan that is still waiting. Why one entry and not two: the session is what waits on the person and what Resume continues; two entries for one session would double-count it and offer two doors into one overlay. **The tab count counts sessions, not plans** (`countFailedOpenForOwner` + `countEndedWithWaitingPlanForOwner`).
- **Form (C) — ended `failed` before this story (panel 4).** The waiting plan's name and state, _The conversation ended {when}_, **Open** (no Resume) and one gloss line: _Your next message carries the plan into a new conversation._ **Tone: calm** — a neutral _Conversation ended_ chip, never Closed's warning peach, because the plan is waiting, not lost. It opens onto the carry design's state 2.
- **The mixed list (panel 5).** (A) a failed walk, (B), (C) and a gated run: open failed sessions first (newest failure first), then ended-with-waiting-plan sessions (newest end first), then gated runs; one total (`listToResume`).
- **An entry leaves (panel 6),** held per § 26 / § 35: after the next turn in (B) _Revised in the same conversation_; after the carry in (C); after the plan is decided from the overlay; after _Plan it again_ on a stale (B). Each held row dims its lead and says why it is going.
- **Absent:** an `idle`- or `restarted`-ended session never takes form (C) (`restarted` is the carry story's situation 1, in Waiting on you); a decided plan, an MCP-authored plan and a `guide` session take no form.
- **Strings (en / zh):** `workbench.planningSession.form.b.badChange|stateWaiting|stateStale|nextReply|nextAgain`, `.form.c.ended|gloss|chip`, `.form.walk.alsoWaiting`, `.left.turn|carry|decided|again` — as drawn in panels 1–9. The stale and carry strings are the carry design's and are cited, not re-worded.
- **GIVES / TAKES:** GIVES MOTIR-7940 (the (B) and (C) entries and strings; 45 min still fits — it composes § 37's frame), MOTIR-7939 (fields: form, waiting plan, failure, ended-when). TAKES nothing from MOTIR-7907: forms (A) and (A+) reuse its panel 5 unchanged.

## 39 · THE TAB RESUMED — everything that moved while it was hidden lands at once — MOTIR-8726 (Story MOTIR-8542)

**EXTENDS § 26 and amends none of it.** § 26 ([MOTIR-5239](motir:cmtxm4x5800fyhztxp88bxw52)) draws ONE live change at a time: the `New` chip on an arrival, the held row with _Decided elsewhere_, a count that moves unmarked, _Reconnecting…_, and the moved notice in an open approval. Story MOTIR-8542 closes a hidden tab's stream after a grace period and, on show, reopens it with the cursor it held and catches up in ONE read. This section draws that read landing: **several changes at once**.

| Surface              | Asset                                                 | Notes                                                                                                                                                           |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The tab, RESUMED** | **`workbench--live--resumed.mock.html`** (HTML delta) | 1 In progress at resume · 2 Waiting on you at resume · 3 the open approval shown after hidden · 4 the generating plan on resume · 5 narrow (`< md`) of Panel 2. |

**It is a DELTA.** It edits no existing mock (`workbench--live.mock.html` included). The rows are `ApprovalRow`'s emitted markup as § 26's asset dumps it and `WorkbenchList`'s row as § 36's asset draws it; the strip is the shipped eight-tab `WorkbenchTabs`; Panel 3 is § 26 Panel 4 verbatim; Panel 4 is `design/ai-planning/plan-review--live-drawing.mock.html` Sheet 1 boards A and B verbatim. **Access path:** nothing new is reached and no entry affordance is drawn — the surfaces are the existing Workbench, approval overlay and plan overlay.

### 39.1 The six rules

1. **A CATCH-UP IS THE SAME GRAMMAR, APPLIED IN ONE PAGE STATE.** No "while you were away" banner, no summary toast, no animation. Every arrival carries the shipped `New` chip, every row that left its set is HELD (a To-approve row with _Decided elsewhere_; a work row with its status updated in place, because a nudge adds and updates and never removes), and the strip counts and the list move together in ONE state. Panel 1 draws the burst the card names: **six arrivals, two rows that left, and a count that jumps by four** (In progress 5 → 9; Recently finished 4 → 6 with it).
2. **SHOW IS NOT A FAULT.** A stream closed because the tab was hidden was closed on purpose. On show there is **no _Reconnecting…_ chip** while the catch-up read is in flight, **no skeleton and no dimming**: the rows the reader last saw keep full ink. The chip appears only if the reopen then FAILS, which is the drop case — § 26 Panel 2, unchanged. Every panel here draws the chip ABSENT, at `≥ md` beside the strip and at `< md` below it.
3. **SCROLL ANCHORING ON A BURST.** On the `updatedAt desc` tabs (In progress, To do, Recently finished) arrivals land at the TOP and shift the rows below. For a burst, **the row the reader was looking at keeps its on-screen position**: the new rows accumulate above the fold and the reader's place does not move; the first row in view is never replaced silently. Panel 1's dashed line is board chrome marking that anchor. On Waiting on you (`createdAt asc`) arrivals are appended at the BOTTOM of its one list and nothing moves (Panel 2). **That tab has no pager** (§ 28 DECISION 5): no page to land on, no page to jump to and no _Showing … of …_ footer to move; only a list at the service's 500-row ceiling shows § 28's ceiling line, and a burst changes only the two numbers in it.
4. **THE `New` CHIPS ARE UNBOUNDED BY DESIGN, BOUNDED BY THE NEXT LOAD.** 189 arrivals show 189 chips: no cap, no "+N more" collapse, because a cap is the silent removal § 26 refuses (its planning flag 2). On the work tabs the shipped pager's window decides how many rows exist on screen, and the strip shows the tab's real count above it.
5. **AN OPEN APPROVAL ON RESUME.** If the reader was inside the full-screen approval when the tab went hidden and the subject was republished meanwhile, the moved notice (§ 26 Decision 2) is **already** band 3's first child when the tab is shown, and the port keeps its `scrollTop`. There is **no notice for "tab resumed"**, and several republishes while hidden still draw ONE notice — _Reopen_ opens the current version either way.
6. **A GENERATING PLAN ON RESUME.** The plan pane takes the catch-up as the lay batch it already draws (live-drawing Sheet 2: the drawn cards glide, the new cards enter together, staggered, then their arrows fade in). **No _resumed_ marker, no count of what was missed, no one-by-one replay.** Arrivals on a level the reader is not viewing are counted in the breadcrumb row, exactly as live-drawing Sheet 7 draws.

**States not drawn, on purpose:** resume has no loading state (rule 2); the empty states are unchanged; a failed reopen is § 26 Panel 2.

**One number in the card, corrected by the arithmetic.** The card's Panel 2 line reads "count down". Three arrivals and two held rows move Waiting on you from 4 to **5**, and that is what is drawn: the count is whatever the awaiting set now holds (§ 26), and a count that goes DOWN is § 26 Panel 3's single held row, unchanged.

### 39.2 Token map — no new token

| Element                      | Colour                                                      | Shape                                   |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------- |
| the `New` chip (both lists)  | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| the `Decided elsewhere` pill | `--el-chip-bg` · `--el-chip-border` · `--el-text-secondary` | `--radius-badge` · `--spacing-chip-x/y` |
| a HELD To-approve row's ink  | `--el-text-secondary` (§ 26)                                | —                                       |
| a held work row's status     | the shipped status pill for its new status (`Done`)         | `--radius-badge`                        |
| the strip counts             | `--el-count-bg` · `--el-count-text`, unmarked               | `--radius-badge` · `--spacing-chip-x`   |
| the moved notice (Panel 3)   | `--el-surface-soft` · `--el-border` · `--el-text-strong`    | `--radius-card`                         |
| _Reconnecting…_              | **not drawn** — absent on show (rule 2)                     | —                                       |

Every token is § 26's or the composed asset's. No raw hex and no raw shape utility in anything this section adds; the dashed anchor line is board chrome (`--el-accent`), never an app element.

### 39.3 The copy — `en` and `zh`

**No new strings.** Everything on screen reuses keys that ship:

| key                                 | `en`                                                | `zh`                               |
| ----------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `workbench.live.new`                | New                                                 | 新增                               |
| `workbench.live.decidedElsewhere`   | Decided elsewhere                                   | 已由他人决定                       |
| `approvalOverlay.moved.title`       | This design was republished while you were reading. | 你正在阅读时，该设计已被重新发布。 |
| `approvalOverlay.moved.consequence` | Approving this version will be refused.             | 批准此版本将被拒绝。               |
| `approvalOverlay.moved.action`      | Reopen                                              | 重新打开                           |

`workbench.live.reconnecting` (_Reconnecting…_ / _正在重新连接…_) is deliberately NOT shown on resume (rule 2); it stays the drop case's string.

### 39.4 GIVES / TAKES — every card this section names

| card                                             | GIVES                                                                                                                                                                                                                                                                                         | TAKES                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **MOTIR-8731** (the host-held stream client)     | **PREMISE:** a resume after the hidden grace period is not a drop — `reconnecting` stays false while the catch-up read is in flight, and only a FAILED reopen enters the drop path. **STRUCTURE:** scroll anchoring on the `updatedAt desc` lists (rule 3). Panels 1–5 are what it builds to. | Nothing. Its close, reopen and backoff mechanism is its own.                                          |
| **MOTIR-8732** (the plan poll over the stream)   | **PREMISE:** a burst of plan proposals is applied as one read, under the live-drawing batch treatment, with no resumed marker (rule 6).                                                                                                                                                       | Nothing.                                                                                              |
| **MOTIR-8734** (the E2E)                         | **ELEMENT:** what to assert on resume — the `New` chips, the held rows, the counts in one state, and the ABSENCE of the reconnecting chip.                                                                                                                                                    | Nothing.                                                                                              |
| **MOTIR-8542** (the story)                       | The resume half of "paused in a background tab, resuming without a page refresh", drawn.                                                                                                                                                                                                      | Nothing.                                                                                              |
| **MOTIR-5239** (§ 26)                            | Nothing new — every treatment here is its own.                                                                                                                                                                                                                                                | **Nothing is taken**: this section extends § 26 and does not amend a rule, a token or a string of it. |
| **MOTIR-5238 / MOTIR-5242** (the live Workbench) | Nothing they do not own: the held-row and arrival appliers are theirs and are reused as they ship.                                                                                                                                                                                            | Nothing.                                                                                              |

No card's criteria are contradicted by this section, so no card is amended in this pass.

## 40 · TO FIX · FIXING — a repaired card keeps its row while CI runs on the push, and a card leaves To resume once CI restarts — MOTIR-10306 (Story MOTIR-10305)

**Design system (step 1).** Read `package.json` (`"@motir/design-system": "workspace:*"`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`): both hold, so this project is **on Motir Design**. Axes from `app/layout.tsx`: `warm-editorial` · `motir` · `motir`. The installed package exports `@motir/design-system/mock`, so the mock is rendered with `renderMock` over the REAL shipped parts — `WorkbenchTabStrip`, `WorkbenchList` (its To fix row, its held row, its To resume entry, its In progress row), `WorkbenchFixLine`, `WorkbenchResumeLine`, `ToFixTag`, `ToFixBanner`, `BoardCardView`, `StatusValue`, `CiStateBadge`, `IssueTypeIcon` and `Pill` — with the `en` and `zh` catalogues and the proposed keys below merged in. Only the Fixing state itself is new markup, composed from `Pill` (`severity="info"`) and `lucide-react`'s `Hammer`. No part is missing from the package; the Fixing tag is a **product-local state of the product-local `ToFixTag`**, not a proposed addition to the design system.

**EXTENDS § 30 (the To fix row), § 31 (run died), § 32 (the hosted repair line), § 35 (To resume) and the work-items To fix tag and banner (`design/work-items/design-notes.md` § _The TO FIX tag and banner_), and amends none of them.** It edits no existing mock.

| Surface                      | Asset                                                  | Panels                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **To fix · Fixing**, en + zh | **`workbench--to-fix--fixing.mock.html`** (HTML delta) | 1 failure as shipped · 2 Fixing · 3 Fixing then red · 4 Fixing then green, held · 5 hosted repair and Fixing · 6 not Fixing (died run, stale head) · 7–8 the compact tag, shipped and Fixing · 9–10 the page banner, shipped and Fixing |
| **To resume exit**, en + zh  | the same asset                                         | 11 To resume before · 12 To resume after a new CI run · 13 the card under In progress                                                                                                                                                   |

Panels 1–13 are drawn in English, then again in Chinese (the board's second half, captions marked _(zh)_). **Access path:** nothing new is reached. The surfaces are the shipped Workbench To fix and To resume tabs (the strip is drawn on every Workbench panel), the `/items` List and Tree row, the board card, the quick view, and the item page.

### 40.1 What Fixing is, as the reader sees it

A card on To fix for a **pull-request reason** (CI failed, failed in the merge queue, conflicted, out of date, changes requested) whose pull requests now have CI **running on a head pushed after the reason arose**, and **nothing red**, is being repaired. Until now that card vanished from To fix the moment CI started and came back if CI failed again. Now:

1. **The card stays on To fix and keeps its place.** The tab count does not move and the row does not jump (Panel 2: 3 before, 3 during).
2. **The row wears the Fixing tag** in the place where line 2's reason glyph sits, and the reason sentence goes on, **quieted** to `--el-text-secondary` but readable: the reader still sees what was wrong. Line 1 is unchanged; its CI glyph is now the shipped _Checks running_ glyph, because that is what the stored CI state says.
3. **The command is withdrawn while CI runs.** `motir fix` refuses a card whose CI is running (`ci_running`), so offering the command would hand the reader a refusal. Its slot holds one secondary sentence: _Checks are running on the new push_. Nothing is copied, nothing is pressed.
4. **Red CI turns the tag off** (Panel 3): the row reads its failure reason again, with the new failing check, its glyph and its command, exactly as shipped.
5. **Green CI removes the card from To fix** (Panel 4): the count has already dropped (3 → 2), and a row the reader is looking at is **held** as § 26 / § 30 Panel 3 hold it — glyph dropped, reason secondary, the colourless _Cleared_ chip in the command's place — until the next load. The hold rule is unchanged.
6. **A hosted repair's line wins** (Panel 5): a row whose open repair runs on the hosted agent keeps § 32's _Being fixed on the hosted agent by …_ line and its run link, and the tag is **not drawn** on that row. One line says who is fixing it; a second signal for the same fact would be noise.
7. **Not Fixing, drawn for contrast** (Panel 6): a **died run** is never Fixing (its run-died line and its continue repair are § 31 unchanged), and **CI running on a head older than the failure** (a re-run of the commit that failed) is not a push, so the row reads its failure as shipped, CI glyph _Checks running_ and all.

Several pull requests: any red, conflicted, out-of-date or queue-held member keeps the failure row; the row is Fixing only when no member is red and at least one runs at a new head. A standing changes-requested refusal is Fixing only after a push moves the head (Panel 2's ACME-418, at In Review). These are the derivation's rules; the drawing is the same row either way.

### 40.2 The Fixing tag — ONE tag, the To fix tag in another state

It is **the To fix tag in its Fixing state**, not a second tag beside it: it takes the To fix tag's slot, size and two forms on every surface, so a card shows one tag at a time.

| Form      | Where                                                                                                            | Markup                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **label** | Workbench To fix row line 2 · board card pill row · quick-view header after the status pill · page banner line 1 | `Pill severity="info"` with `Hammer` (12px) + the word _Fixing_ / _修复中_; `shrink-0 whitespace-nowrap`; an `sr-only` tail finishing the accessible name |
| **glyph** | `/items` List and Tree STATUS cell, beside the status pill                                                       | the 18px disc the To fix glyph uses, `bg-(--el-tint-sky) text-(--el-text-strong)`, `Hammer` 12px, `role="img"` named by the full name                     |

**Why this glyph and this colour.** The To fix tag is the ONE solid danger fill on these surfaces (the work-items notes' rule), and that fill means _stuck until repaired_. A card being repaired is no longer stuck, so the Fixing state drops the danger fill for the **sky tint** (`Pill severity="info"`, the in-progress tone) with `--el-text-strong` ink, which clears AA on the tint in every palette (finding #35's recipe). `Hammer` reads as repair under way, and it is distinct in SHAPE from the To fix tab's `Wrench`, from the reasons' `CircleX` / `Undo2` / `TriangleAlert` and from the CI badge's `CircleEllipsis`. State is never colour alone: the word is drawn on every label form, and the glyph form carries the full name as its accessible name and `title`, the bargain the shipped glyph forms make.

### 40.3 The page banner while Fixing (Panels 9–10)

The banner keeps its slot (`ArchivedBanner` › this › `PendingPlanNotice`) and its shape, and changes three things:

- **Its surface goes calm**: `--el-surface-soft` with `--el-border-soft`, not `--el-danger-surface`. The card is no longer stuck.
- **Line 1 is the Fixing tag and one sentence**: _A fix was pushed and its checks are running. This clears when they pass._
- **Line 2 names the reason it was on To fix**, in the row's own reason sentence, secondary: _Before this push: CI failed · Vitest (shard 2/4)_.
- **No command.** As on the row, `motir fix` would refuse; the banner keeps only its _See its pull requests_ link down to the Development block, where the running checks are.

A hosted repair's _A hosted repair is running_ line (§ 32 Panel 4) and a dead run's banner (§ 31) are unchanged and win, exactly as on the row.

### 40.4 The To resume exit (Panels 11–13)

A card whose latest run stopped at a gate waits on To resume. Once **a new CI run starts on its pull request after the run stopped**, it is no longer waiting: someone is moving it. It **leaves To resume**, the To resume count drops (2 → 1), and the card is **listed under In progress** (1 → 2), because In progress is everything in progress that is neither To fix nor To resume. There is **no new element**: no chip, no notice, no hold. To resume holds only a _Resuming_ entry (§ 35.5), and this exit is not a press the reader made. A plain status move, or a pull request that was already open when the run stopped, does not move the card.

### 40.5 Token map — no new token

| Element                                               | Colour                                                        | Shape                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Fixing tag, label form                                | `Pill severity="info"`: `--el-tint-sky` · `--el-text-strong`  | `--radius-badge` · `--spacing-chip-x/y`                   |
| Fixing tag, glyph form                                | `--el-tint-sky` · `--el-text-strong`                          | 18px disc, `rounded-full` (a disc, like the To fix glyph) |
| the quieted reason (row, banner line 2)               | `--el-text-secondary`                                         | —                                                         |
| _Checks are running on the new push_                  | `--el-text-secondary`                                         | —                                                         |
| Fixing banner surface                                 | `--el-surface-soft` · `--el-border-soft` · `--el-text-strong` | `--radius-card` · `--spacing-card-padding-12`             |
| held row, hosted line, run-died line, To resume entry | as shipped (§ 26, § 32, § 31, § 35)                           | as shipped                                                |

`--el-text-secondary` is the ink for every secondary line here because it clears AA on the page, on `--el-surface` (the row's hover fill) and on `--el-surface-soft` (the banner). No `--el-text-muted`, no `--el-text-faint`, no `--el-danger-text` off a danger fill, no raw hex and no raw shape utility in anything this section adds.

### 40.6 The copy — `en` and `zh`

**Five new keys.** Everything else on these panels ships.

| key                                    | `en`                                                                     | `zh`                                               |
| -------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| `toFix.fixing.label`                   | Fixing                                                                   | 修复中                                             |
| `toFix.fixing.name`                    | Fixing · checks are running on a new push                                | 修复中 · 新推送的检查正在运行                      |
| `workbench.toFix.fixing.checksRunning` | Checks are running on the new push                                       | 新推送的检查正在运行                               |
| `toFix.banner.fixing`                  | A fix was pushed and its checks are running. This clears when they pass. | 修复已推送，检查正在运行。检查通过后此提示将消失。 |
| `toFix.banner.fixingWas`               | Before this push: `<reason></reason>`                                    | 此次推送前：`<reason></reason>`                    |

`toFix.fixing.name` is the tag's accessible name and `title`; the label form's `sr-only` tail is its words after _Fixing_. The nine other locales take the same keys through the i18n loop when the tag is built. _修复中_ is three characters and fits every slot the English word fits, at the label and glyph sizes, with no truncation (the zh half of the board).

### 40.7 GIVES / TAKES

| card                                   | GIVES                                                                                                                                                                                                                                               | TAKES   |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| the code card that draws the tag       | **ELEMENT:** the Fixing state of `ToFixTag` (both forms), of `WorkbenchFixLine` (tag, quieted reason, the running sentence in the command's slot) and of `ToFixBanner` (§ 40.3); the five keys; the precedence of the hosted line and the dead run. | Nothing |
| the card that stores the Fixing signal | **PREMISE:** the surfaces read one stored fact beside the stored reason, and the card stays on To fix while it holds.                                                                                                                               | Nothing |
| the card that adds the To resume exit  | **PREMISE:** clearing the stored resume answer is the whole of the exit; no tab, chip or string changes (Panels 11–13).                                                                                                                             | Nothing |
| the story E2E                          | **ELEMENT:** what to assert: the tag's words in en and zh, the unchanged count, the tag gone on red, the held row on green, the To resume count and the In progress listing.                                                                        | Nothing |

No tab and no workflow status is added, and no shipped card's criteria are contradicted.

## 41 · TO APPROVE — the review line on an approval row, and a review to run (`approvals-row--review-path.mock.html`, 2026-11-04)

**AMENDS** `design/workbench/approvals-row.mock.html` **without editing it**. The delta mock `design/workbench/approvals-row--review-path.mock.html` holds only the changed panels, English then Chinese:

- **A1** — the review line as the approve-and-merge row's second grid row (_Reviewed by agent_, _Review skipped by_, _Review dismissed by_, _Not reviewed by an agent_ with the command, and _Approved on GitHub by_ beside any of them), and the Reviewed badge after the key.
- **A2** — a review to run (source _Your own agent_): a `Bot` glyph on the yellow disc, _Review {title} with your agent_, the command in the details track and the _Review to run_ tag in the Decide track, above an ordinary approval row for contrast.
- **A3** — the decided approval-record line in the Approvals room.
- **A4** — the same rows at 390px.

The element spec, tokens and copy keys are in **`design/github/design-notes.md` § 32.4, § 32.5 and § 32.9**; this section only indexes the surface.

## 42 · FINDINGS AND CHECKLIST IN PLACE — the review opens over the Workbench, and the stored checklist rows are drawn (`approvals-row--findings-in-place.mock.html`, 2026-11-05, MOTIR-10459)

**Design system (step 1).** Read `package.json` (`"@motir/design-system": "workspace:*"`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`): both hold, so this project is **on Motir Design**, version 0.19.0 (`packages/design-system/package.json`). Axes from `app/layout.tsx`: `warm-editorial` · `motir` · `motir`. The package exports `@motir/design-system/mock`, so the mock is rendered with `renderMock` (`boardWidth: 'full'`). The shipped parts in it are the REAL components rendered with the real `en` and `zh` catalogues — `ApprovalRow` (with `ReviewLine` and `ReviewedBadge` inside it), `ReviewLine` at the frame size, `AgentVerdictActivityRow` and `MarkdownView` — beside the package's `Pill`, `Button`, `Spinner` and `SectionLabel`. The open dialog is the package `Modal`'s content markup at size `xl`, drawn static because a portal does not render on a board. `ApprovalsList`'s table shell and the approval overlay's exit row are copied class for class. The prose styles `MarkdownView` wears (`components/ui/markdown-editor.css`, `.motir-prose` and its tables) are inlined so the findings render as they ship.

**AMENDS § 41 and `design/github/design-notes.md` § 32.3, § 32.4 and § 32.9 without editing any mock.** The base is `design/workbench/approvals-row--review-path.mock.html` (A1, the review line and its _Findings and checklist_ link) and, for the Activity entry, `design/work-items/decision-waiting--review-path.mock.html` M12. The delta mock **`design/workbench/approvals-row--findings-in-place.mock.html`** holds only what changes, English (F0–F12) then Chinese (the same panels, marked _(zh)_):

| Panel   | State                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **F0**  | The door: the shipped row and review line on Waiting on you (the To approve tab), with _Findings and checklist_ focused        |
| **F1**  | Open over the list: a pass whose record carries checklist rows (met, not met, can’t tell, each with its evidence) and findings |
| **F2**  | The hosted review: its checklist is a table inside its findings, and it has no stored rows                                     |
| **F3**  | Findings with no checklist; checklist rows with no findings                                                                    |
| **F4**  | A pass with no record, only a gate: its note is the findings, and there are no rows                                            |
| **F5**  | The earlier review, opened from _Last reviewed at an earlier commit_, marked as not the current commits                        |
| **F6**  | Long findings: the whole text scrolls inside the view, and the head and footer stay put                                        |
| **F7**  | Loading; could not load, with _Try again_                                                                                      |
| **F8**  | From the Reviewed badge’s card on a row: the card’s link opens the same view                                                   |
| **F9**  | From the review line inside the approval overlay: the view opens over the overlay, which stays open                            |
| **F10** | The card page’s Activity: the agent-verdict entry draws the stored checklist rows                                              |
| **F11** | A 390px list with the view open                                                                                                |
| **F12** | Keyboard: focus on open, the tab order, and close                                                                              |

**Access path.** No new door. The view is opened by the three links that already ship with the words _Findings and checklist_ or _Last reviewed at an earlier commit_: the review line on an approve-and-merge row (§ 41 A1), the Reviewed badge's hover/focus card on that row (§ 32.3), and the review line in the approve-and-merge gate frame inside the approval overlay opened from the Workbench (§ 32.4, G1). **Out of scope:** the board and `/items` badges keep going to the card page, the item page's own Development frame keeps its anchor link, and the card-page landing those links use is MOTIR-10458's.

### 42.1 THE VIEW — `ReviewFindingsDialog` (product-local)

The package **`Modal`, size `xl`** (`max-w-[58rem]`, `w-[90vw]`, `max-h-[90vh]`). It is the shape the Workbench already uses for reading a card without leaving the list (the quick view is the same Modal size), and Radix's dialog gives the focus trap, Escape, the scrim press and focus return. It is not a new route and not the approval overlay: the review is evidence, so nothing in it decides.

- **Head** (the Modal's title block, then one meta block):
  - the title _Findings and checklist_ (the Modal title, serif) and the subtitle _{title} · {key}_ (`--el-text-subtitle`);
  - the verdict: `Pill severity="success"` with the shipped `ReviewedGlyph` and _Passed_, or `Pill severity="warning"` with _Asked for changes_ (an earlier review can be a send-back; a current one on Waiting on you is always a pass);
  - for an earlier review, a `Pill tone="neutral"` with `History` and _Earlier commits_;
  - who reviewed: _Motir's hosted agent_, or _{name}'s own agent · {harness} · {model}_, then `·` and the relative time (`<time>` with the absolute time as its title, as the badge card does);
  - _At these commits_ and one `owner/repo#n @ sha7` per pull request in mono, `--el-text-identifier`.

  All meta is `text-xs` `--el-text-secondary`.

- **Body** — `Modal.Body`, the one scroll region. It is `role="region"`, labelled _The review_, and focusable (`tabIndex=0`), so the keyboard scrolls it. Sections are spaced `gap-5`, in this order:
  1. the **earlier-review note** (42.4), when the review is an earlier one;
  2. the **checklist** (42.2), only when the record stores rows. It comes first because it is bounded and scannable;
  3. the **findings**: a `SectionLabel` _Findings_ (`role="heading"`, `aria-level=3`) and the whole findings through the shipped `MarkdownView`, never an excerpt. A hosted review's table renders as the prose table (F2). With no findings text the section says _The review wrote no findings._ (F3 right).
- **Footer** — `Modal.Footer`: _Open the card_ (`--el-link`, `ArrowUpRight`) at the start goes to the card page, and _Close_ (`Button variant="secondary" size="sm"`) at the end. The Modal's corner × ships as it is.
- **Long findings** (F6): the body scrolls and the head and footer do not. Nothing is truncated or clamped.
- **Loading** (F7 left): the head shows only the title and subtitle. The body shows a `Spinner size="sm"` and _Loading the review…_ in a `role="status"`, with `aria-busy` on the body.
- **Could not load** (F7 right): one `role="alert"` line on `--el-danger-surface`, with `--el-text-strong` ink and a `TriangleAlert` glyph in `--el-danger-on-surface`. Its text is **_The review could not be loaded._** _Nothing changed. Try again._ Under it sits a `Button variant="secondary" size="sm"` _Try again_, which re-reads in place. This is the shipped pattern of the Dismiss dialog's error (§ 32.6). The package's `ErrorState` is not used, because its description ink is `--el-text-muted` on a card.
- **What it reads.** It reads the answering pass that the link's `recordRef` names, or `lastReviewedRef` for the earlier link:
  - a **record**: verdict, harness, model, submitter, time, `subjectVersion`, `findingsMd` and `checklist`;
  - a **gate** (F4, no record): the verdict comes from the gate state; the reviewer comes from `decidedUnderAuthority` and the run; the time is `decidedAt`; the commits are the gate's `subjectVersion`; the findings are the gate's `noteMd`. There is no checklist section.

  The read is fetched when the view opens, never with the list. How it is served is MOTIR-10460's.

- **Narrow** (F11): the same Modal at `w-[90vw]`. The head meta wraps, and the checklist row stacks (42.2).

### 42.2 THE CHECKLIST ROW — `ReviewChecklist` / `ReviewChecklistRow` (product-local)

The stored `checklist` rows of a verdict record (`ReviewChecklistRowDto`: `key`, `criterion`, `status` ∈ `met` · `not_met` · `cannot_tell`, `evidence`), drawn in the order stored. The same part is used in the view and in the Activity entry (42.5).

- **Heading line**: a `SectionLabel` _Checklist_ (`role="heading"`, `aria-level=3`), then a `text-xs` `--el-text-secondary` count, for example _4 criteria · 2 met · 1 not met · 1 can’t tell_. A zero count is left out (_1 criterion · 1 not met_).
- **The list**: `<ul>`, one `<li>` per row, `data-checklist-status`. Rows are divided by `--el-border-soft` hairlines, with `py-(--spacing-control-y-8)` row padding.
- **The row**: a grid `6.75rem | minmax(0,1fr)`.
  - **Status pill** (the first column). The words carry the status, and the fill and glyph shape differ too, so it is never colour alone:
    - **met**: `Pill severity="success"` · `Check` · _Met_
    - **not met**: `Pill severity="warning"` · `X` · _Not met_. Warning, not danger, as the gate's _changes requested_ pill is.
    - **can’t tell**: `Pill tone="neutral"` · `CircleHelp` · _Can’t tell_
  - **Criterion**: `text-sm` (`text-[13px]` when compact) `--el-text`.
  - **Key**: when the rows span more than one card, the row's `key` comes before the criterion in mono `text-xs` `--el-text-identifier`. A single-card checklist omits it.
  - **Evidence**: on the next line, `text-xs` `leading-relaxed` `--el-text-secondary`, `overflow-wrap:anywhere`. Code spans render as inline chips (`--el-code-bg` / `--el-code-text`, `--radius-control`). Evidence is not passed through the block prose renderer, which would force `text-sm` `--el-text`. A row with no evidence (allowed on not met and can’t tell) says _No evidence given._
- **Below `sm`** the grid becomes one column, with the pill above the criterion (F11).

### 42.3 OPEN AND CLOSE

- **Opening.** Each of the three links keeps its real `href` to the card page and gains `aria-haspopup="dialog"`.
  - A plain primary click opens the view in place. This is `usePeekRowClick`'s contract, the same one the row's own door and the overlay's title door use.
  - A modified, middle or secondary click keeps its native meaning: the card opens in a new tab.
  - The view is **not written to the address**. It is a reading aid over a list the reader is working through: Back keeps meaning _leave this page_, and the card page is the shareable address. _Open the card_ is in the footer for that.
- **Place kept.** Nothing navigates and nothing re-renders the list. Its scroll, its rows, any row held after a decision (§ 22) and any open overlay stay as they were.
- **From the badge card** (F8). The card's link opens the view, and the card closes as focus leaves it.
- **From the overlay** (F9). The view stacks over the approval overlay. Escape, Close, × and the scrim press close **only the view**. A second Escape closes the overlay, as it ships.
- **Closing.** Escape, _Close_, the corner ×, or a press on the scrim. Focus returns to the link that opened it.

### 42.4 THE EARLIER REVIEW

When the view is opened from _Last reviewed at an earlier commit_ (F5), it is marked three times, so it cannot be read as the current review:

- the neutral _Earlier commits_ pill in the head;
- the earlier commits themselves under _At these commits_;
- a `role="note"` at the top of the body: `--el-tint-yellow` with `--el-text-strong` ink, `History` glyph, `--radius-control`, `--spacing-control-x/y`. Its text is **_An earlier review._** _It reviewed commits that are no longer the ones waiting for your approval. The work changed after it._

The note is a tint with strong ink, the AA recipe for coloured chips, not a warning: nothing is wrong, it is just not current.

### 42.5 THE ACTIVITY ENTRY — the checklist rows on the card page (amends § 32.9 / M12)

The shipped `AgentVerdictActivityRow` keeps its grid, disc, sentence, time and _{name} was notified._ line. It changes in one way: **when the record stores checklist rows, its toggle reads _Findings and checklist_** (`approvalGate.reviewPath.line.findings`). Opening it shows the findings, as shipped, and then a compact `ReviewChecklist` under them.

- A record with rows and no findings text still gets the toggle, and opens to the rows alone (F10, second entry).
- A record with no rows, such as the hosted review, is unchanged: _Findings_ only (F10, third entry).
- The `#agent-verdict-<id>` landing still opens it.
- A late or second verdict still draws no toggle (§ 32.9).

### 42.6 COPY — new keys, `en` and `zh`

Under `approvalGate.reviewPath.view`. The other nine locales take the same keys when MOTIR-10460 builds them. Reused, not new: `approvalGate.reviewPath.line.findings` (the entry's toggle).

| key                     | `en`                                                                                                                              | `zh`                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `view.title`            | Findings and checklist                                                                                                            | 发现和检查清单                                                                          |
| `view.subtitle`         | {title} · {key}                                                                                                                   | {title} · {key}                                                                         |
| `view.verdictPassed`    | Passed                                                                                                                            | 已通过                                                                                  |
| `view.verdictSentBack`  | Asked for changes                                                                                                                 | 要求修改                                                                                |
| `view.byHosted`         | Motir's hosted agent                                                                                                              | Motir 托管智能体                                                                        |
| `view.byOwn`            | {name}'s own agent                                                                                                                | {name} 自己的智能体                                                                     |
| `view.byOwnHarness`     | {name}'s own agent · {harness} · {model}                                                                                          | {name} 自己的智能体 · {harness} · {model}                                               |
| `view.commits`          | At these commits                                                                                                                  | 审查的提交                                                                              |
| `view.earlierTag`       | Earlier commits                                                                                                                   | 较早的提交                                                                              |
| `view.earlierNote`      | `<b>An earlier review.</b>` It reviewed commits that are no longer the ones waiting for your approval. The work changed after it. | `<b>这是较早的一次审查。</b>`它审查的提交已不是现在等待你审批的提交。此后工作有了变更。 |
| `view.bodyLabel`        | The review                                                                                                                        | 审查内容                                                                                |
| `view.checklistHeading` | Checklist                                                                                                                         | 检查清单                                                                                |
| `view.checklistTotal`   | {total, plural, one {# criterion} other {# criteria}}                                                                             | {total, plural, other {# 条标准}}                                                       |
| `view.countMet`         | {n} met                                                                                                                           | {n} 条满足                                                                              |
| `view.countNotMet`      | {n} not met                                                                                                                       | {n} 条未满足                                                                            |
| `view.countCannotTell`  | {n} can’t tell                                                                                                                    | {n} 条无法判断                                                                          |
| `view.statusMet`        | Met                                                                                                                               | 满足                                                                                    |
| `view.statusNotMet`     | Not met                                                                                                                           | 未满足                                                                                  |
| `view.statusCannotTell` | Can’t tell                                                                                                                        | 无法判断                                                                                |
| `view.noEvidence`       | No evidence given.                                                                                                                | 未给出依据。                                                                            |
| `view.findingsHeading`  | Findings                                                                                                                          | 发现                                                                                    |
| `view.noFindings`       | The review wrote no findings.                                                                                                     | 此审查没有写下发现。                                                                    |
| `view.loading`          | Loading the review…                                                                                                               | 正在加载审查…                                                                           |
| `view.errorTitle`       | The review could not be loaded.                                                                                                   | 无法加载审查。                                                                          |
| `view.errorBody`        | Nothing changed. Try again.                                                                                                       | 没有任何更改。请重试。                                                                  |
| `view.retry`            | Try again                                                                                                                         | 重试                                                                                    |
| `view.openCard`         | Open the card                                                                                                                     | 打开卡片                                                                                |
| `view.close`            | Close                                                                                                                             | 关闭                                                                                    |

`zh` follows the shipped catalogue's term 智能体 for _agent_. The design-notes § 32.10 table still says 代理; the catalogue is what ships.

### 42.7 FOCUS ORDER

1. **On open**, focus moves to the body region (_The review_), so the arrow keys, Page Up/Down and Space scroll it at once.
2. **Tab**: body region → each link inside the findings (`MarkdownView` links and card chips) → _Open the card_ → _Close_ → the corner ×, then back to the body region.
3. Focus is trapped while the view is open.
4. Loading and error take the same order. The error's _Try again_ comes right after the body region.
5. **On close**, focus returns to the opening link. A link whose row has gone in the meantime (a live update removed it) hands focus to the list's next row door, as § 26's held-row rule does.

### 42.8 Token map — no new token

| Element                     | Colour                                                                                           | Shape                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| view panel                  | `--el-page-bg` · `--el-border` · `--el-overlay-scrim`                                            | `--radius-modal` · `--shadow-modal` · `--spacing-card-padding` · `--spacing-md` |
| head meta, counts, evidence | `--el-text-secondary` · `--el-text-identifier` (commits, keys) · `--el-text-subtitle` (subtitle) | —                                                                               |
| verdict / status pills      | `Pill severity="success"` · `severity="warning"` · `tone="neutral"`                              | `--radius-badge` · `--spacing-chip-x/y`                                         |
| checklist rows              | `--el-text` · `--el-border-soft` · `--el-code-bg` / `--el-code-text`                             | `py-(--spacing-control-y-8)` · `--radius-control`                               |
| earlier note                | `--el-tint-yellow` · `--el-text-strong`                                                          | `--radius-control` · `--spacing-control-x/y`                                    |
| error line                  | `--el-danger-surface` · `--el-text-strong` · `--el-danger-on-surface` (glyph)                    | `--radius-control` · `--spacing-control-x/y`                                    |
| links                       | `--el-link` · `--focus-ring-color`                                                               | —                                                                               |

No `--el-text-muted` or `--el-text-faint` carries text, no `--el-danger-text` sits off a danger fill, and nothing this section adds uses a raw hex value or a raw shape utility. The board captions are `--el-text-secondary`.

### 42.9 What this asset does NOT decide

- **The read.** How the view fetches a record or a gate by its reference, and the record's access rule, are MOTIR-10460's. The view draws what that read returns.
- **The card-page links** (MOTIR-10458), the To fix row and banner, and the board and `/items` badges, which keep going to the card page.

## 43 · TO FIX · FINDINGS AND CHECKLIST — an agent send-back opens its review in place from the To fix row and the item page's To fix banner (`workbench--to-fix--findings-in-place.mock.html`, 2026-11-13, MOTIR-11236)

**Design system (step 1).** Read `package.json` (`"@motir/design-system": "workspace:*"`) and `app/globals.css` (`@import '@motir/design-system/theme.css'`): both hold, so this project is **on Motir Design**, version 0.19.0 (`packages/design-system/package.json`). Axes from `app/layout.tsx`: `warm-editorial` · `motir` · `motir`. The package exports `@motir/design-system/mock`, so the mock is rendered with `renderMock` (`boardWidth: 'full'`). Every part in it is the REAL shipped component rendered with the real `en` and `zh` catalogues, at motir-core `main` @ `c53f434e`: `WorkbenchList` on the To fix tab (its rows, `WorkbenchFixLine`, `FixingTag`, the `Cleared` pill, `CommandChip`), `ToFixBanner` (with `CopyableCodeBlock` and the hosted-repair line), `ContentSectionCard` and `MarkdownView` for the item page's Description, and the shipped `ReviewFindingsDialog` (§ 42) for the open view. The fix line and the banner are the shipped files with the one link this section adds; nothing else in them changes. The open view is rendered live and drawn in place over the page it opened on, because a portal does not render on a board (§ 42 draws it the same way). The `MarkdownView` prose styles (`components/ui/markdown-editor.css`, `.motir-prose` and its tables) are inlined so the findings render as they ship. **No part is missing from the package, and no new component is proposed:** the link is a `next/link` `Link` in an existing class string (below).

**AMENDS, and edits no mock and no card:**

- **§ 32** (MOTIR-6817), its To fix row and its banner for the agent send-back — `workbench--to-fix--review-agent.mock.html` Panels 2 and 4, and the banner's base in `design/work-items/` (§ _The TO FIX tag and banner_, MOTIR-6608, published as `to-fix--tag-and-banner.mock.html`; the To fix row's own base is § 30, MOTIR-6599, `workbench--to-fix.mock.html`).
- **§ 42** (MOTIR-10459), the in-place view — `approvals-row--findings-in-place.mock.html`, whose access path put _the To fix row and banner_ out of scope and kept the item page's links going to the card (§ 42, _Access path_, and § 42.9).

The delta mock **`design/workbench/workbench--to-fix--findings-in-place.mock.html`** holds only what changes, English then Chinese (marked _(zh)_):

| Panel  | State                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1** | The door: the To fix rows for an agent send-back with a note and one with no note, the link after the sentence and the command on the right (light)                          |
| **W2** | The same rows, dark                                                                                                                                                          |
| **W3** | A 640px list: the sentence truncates, the link stays whole and sits above the row's stretched link                                                                           |
| **W4** | The view open in place over the To fix tab, for the review that sent ACME-12 back                                                                                            |
| **W5** | Closed: the list unmoved, focus on the link that opened it                                                                                                                   |
| **W6** | Fixing, a hosted repair running, and a HELD (_Cleared_) row: the link stays on all three                                                                                     |
| **W7** | No link: a person's Request changes, an acceptance Re-run, CI failed, the merge queue, a conflict, out of date, a dead run, and an agent send-back stored without its review |
| **I1** | The item page: the To fix banner for an agent send-back, the link beside the link down to the Development frame                                                              |
| **I2** | The banner, dark; and the banner with no note                                                                                                                                |
| **I3** | The view open in place over the item page                                                                                                                                    |
| **I4** | Closed: the page where it was, focus on the banner's link                                                                                                                    |
| **I5** | The banner Fixing, and the banner while a hosted repair runs: the link stays                                                                                                 |
| **I6** | No link on the banner: a person's Request changes, an acceptance Re-run, CI failed, and a stored detail with no review                                                       |

zh repeats every panel that shows the link (W1, W3–W6, I1–I5).

**Access path.** Unchanged: the Workbench's **To fix** tab (§ 30) and the To fix banner at the top of the item page's main column (`ArchivedBanner` › the banner › `PendingPlanNotice` › Description). The new door is the link itself, drawn in W1 and I1.

### 43.1 THE LINK — what it is and where it sits

- **Copy.** The existing key `approvalGate.reviewPath.line.findings`: _Findings and checklist_ / _发现和检查清单_. **No new string.**
- **When it shows.** Only when the card's To fix reason is `changes_requested` **and** `fixDetail.gate` is `agent_review` **and** the row knows the review that sent it back (its `ReviewFindingsRefDto`, the same `{ kind, id }` the review line's link carries). Every other case draws no link (43.4).
- **On the Workbench row** (W1). In line 2, the fix line, right after the reason sentence and **outside** its `min-w-0 truncate` span, before the entry clause (_· N more work items …_) and the affected clause (_· 1 of 2_). It is the review line's findings link, class for class: `relative z-10 text-(--el-link) underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none`, plus `shrink-0 whitespace-nowrap` so it never wraps or truncates. It sits after the sentence in the line's own `gap-1.5`, with no separator, as it sits after the reviewed sentence on the review line. Size `text-xs`, the line's own.
- **On the banner** (I1). The banner's last line becomes a link row, `flex flex-wrap items-center gap-x-4 gap-y-1`: _Findings and checklist_ first, then the shipped link down to the Development frame (_See its pull requests ↓_), which stays exactly as it ships. On a carried card the row holds the link and the shipped link to the head (_Open ACME-n →_).
  - **Its form is the banner's own link form, not `--el-link`:** `inline-flex w-fit items-center gap-1 font-sans text-[13px] font-medium text-(--el-text-strong) underline decoration-(--el-border-strong) underline-offset-2 hover:decoration-(--el-text-strong)` and the banner's focus ring. **Why:** `--el-link` on `--el-danger-surface` measures **4.01–4.40:1 in seven light palettes** (amethyst 4.01, spectrum 4.02, sienna 4.06, evergreen 4.12, candy 4.16, citrine 4.35, amber 4.40; resolved with `tests/theme/paletteCascade`), under AA. The banner's own two links already take `--el-text-strong` for that reason, and the new link sits beside one of them. On the Workbench row the review line's form is AA (≥ 4.54:1 on `--el-surface`, the row's hover fill, in every palette).
  - It carries no trailing glyph: it opens a dialog in place, which `aria-haspopup="dialog"` says, where the arrows beside it say _jump down_ and _go to another card_.
- **The address.** The link's `href` is the review's address on the card, `findingsHrefOf(cardHref, ref)`: `/items/KEY#agent-verdict-<id>` for a record, `/items/KEY#development` for a gate. That is what a modified click opens.

### 43.2 OPEN AND CLOSE — § 42.3's contract, on two more surfaces

- **Opening.** A plain primary click opens the shipped view (`ReviewFindingsDialog`, § 42.1, unchanged) in place, for the review that sent the card back. A modified (⌘/Ctrl/Shift/Alt), middle or secondary click follows the link's `href`, in a new tab: the same contract as the review line's findings link (`useInPlaceFindings`). The link carries `aria-haspopup="dialog"` while the in-place view is switched on.
- **Not the card.** On the row, the link is `relative z-10`, above the row's stretched link (`absolute inset-0 z-0`), so pressing it opens the view and never the card (W3). The repairs keep the same layer they ship on.
- **Over the Workbench** (W4). Nothing navigates: the To fix list keeps its scroll, its rows and any held row (§ 26).
- **Over the item page** (I3). The view opens over the item page, which does not scroll or navigate. **This switches the in-place view on over the item page** for this link (§ 42 mounted it on the Workbench only). The item page's other findings links — the Development frame's review band and its gate frame — keep going to the card as § 42 left them: this section adds a place the view opens from, it does not move the others.
- **Closing.** Escape, _Close_, the corner × or the scrim close the view. Focus returns to the link that opened it (W5, I4), and the page is where it was. On the Workbench, if the row left the list meanwhile, focus goes to the next row's door (§ 42.7).

### 43.3 THE STATES THE LINK KEEPS — decided

| state                                               | link  | why                                                                                                                                                                                                                     |
| --------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fixing** (row and banner, § 40; W6, I5)           | stays | the push being checked is the answer to these findings, so they are what a reader compares it with. The sentence still names the send-back (_Before this push: …_ on the banner), and the link belongs to that sentence |
| **Hosted repair running** (§ 32; W6, I5)            | stays | reading is not repairing: the view decides nothing, and the open repair run that is the lock (§8.6) is not touched. The person watching the hosted run is the one most likely to want the findings it is working from   |
| **HELD, _Cleared_** (§ 30 Panel 3; W6)              | stays | a held row is a receipt that keeps its sentence, and the link is part of the sentence. Taking it away under the reader's pointer is the layout shift § 26 holds rows to avoid, and the review it opens still exists     |
| **A carried card's banner** (§ _ONE ENTRY PER RUN_) | stays | its sentence names its own send-back; the link sits beside the link to the head. A carried card on the Workbench is a member line under its head, which draws no fix line, so no link there                             |

### 43.4 NO LINK — drawn so no one invents one (W7, I6)

- **A person's Request changes** on the approve-to-merge gate (`gate: pull_request_approval`): there is no agent review to open, and the note on the row is the whole reason.
- **An acceptance Re-run** (`gate: acceptance_result`).
- **Every other reason**: `ci_failed`, `queue_failed`, `conflicted`, `out_of_date`, `run_died`.
- **An agent send-back stored before the row carried its review.** The sentence alone, exactly as it ships today. Nothing is guessed: no link to the Development frame stands in for it (the banner's own link already goes there).

### 43.5 DECISIONS — what this changes in § 32 and § 42, and why

| amends                                          | was                                                                                                                  | now                                                                                                             | why                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **§ 32**, the To fix row for an agent send-back | the findings' first line, with the findings in full one link away in the Development frame                           | the first line, then _Findings and checklist_, which opens the findings and the checklist in place              | the send-back is the moment the person most needs the findings, and the To fix row is where they are told about it. A first line cut to the row's width is a summary; the checklist is not on the row at all |
| **§ 32**, the banner for an agent send-back     | _the findings in full are in the Development frame's review band one link below, so the banner does not repeat them_ | the banner still does not repeat them: it opens them in place, beside the link below                            | the Development frame is a long scroll away on a card with pull requests, and it shows the findings without the checklist rows                                                                               |
| **§ 42**, access path and § 42.9                | the To fix row and banner were out of scope; the item page's links kept going to the card                            | the To fix row and the To fix banner open the view in place; the item page's other findings links are unchanged | § 42 drew the view for the reader approving a pass. A send-back is the same record read for the opposite reason, and the view already draws _Asked for changes_ (§ 42.1)                                     |
| **§ 42**, where the view is switched on         | the Workbench page only                                                                                              | the Workbench page and, for this link, the item page                                                            | the banner is on the item page; a link that left the page there would contradict the row that opens it in place                                                                                              |

Neither MOTIR-6817 nor MOTIR-10459 is edited: this section is their amendment on the record, and their mocks stay as records of their moment.

### 43.6 Token map — no new token

| Element               | Colour                                                                       | Shape                               |
| --------------------- | ---------------------------------------------------------------------------- | ----------------------------------- |
| row link              | `--el-link` · `--focus-ring-color`                                           | — (inline text)                     |
| banner link           | `--el-text-strong` · `--el-border-strong` (underline) · `--focus-ring-color` | `--radius-control` (its focus ring) |
| the banner's link row | inherits the banner (`--el-danger-surface`, or `--el-surface-soft` Fixing)   | layout gap only                     |
| the open view         | § 42.8, unchanged                                                            | § 42.8, unchanged                   |

No `--el-text-muted` or `--el-text-faint` carries text, no `--el-danger-text` sits off a danger fill, and nothing this section adds uses a raw hex value or a raw shape utility. The board captions are `--el-text-secondary`. W5 and I4 draw the focus ring at rest (`ring-2 ring-(--focus-ring-color)`, `--radius-control`), a board-only stand-in for `:focus-visible`.

### 43.7 Focus order

- **Row:** the row's door (its stretched link) → the title link → **Findings and checklist** → the repairs (the hosted door, the command's copy button). The link comes after the sentence it belongs to and before the repair.
- **Banner:** the hosted door and the command's Copy (as shipped) → **Findings and checklist** → the link down to the Development frame.
- **In the view:** § 42.7, unchanged.

### 43.8 What this asset does NOT decide

- **Where the review's reference comes from.** The shipped `FixDetailDto` carries `gate` and `notePreview` and no review reference. Whether the reference rides on the fix detail or is read another way is MOTIR-11234's; the board draws it on the detail only to show _link present when the row knows its review_ and _no link when it does not_.
- **The view's content** (§ 42), the To approve row's review line, the Reviewed badge and the gate frame's links, and the board and `/items` To fix badges, which keep going to the card page.
- **Any code.** MOTIR-11234 builds the link on both surfaces, the reference it needs, and switching the in-place view on over the item page.

### GIVES / TAKES

| key         | GIVES / TAKES                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| MOTIR-11234 | **TAKES** this design: the row and banner link, the review reference it needs, and the in-place view over the item page |
| MOTIR-6817  | **AMENDED** (§ 32's row and banner for the agent send-back). Done, not re-opened; its mock stays as a record            |
| MOTIR-10459 | **AMENDED** (§ 42's access path and § 42.9). Done, not re-opened; its mock stays as a record                            |
| MOTIR-11236 | this card                                                                                                               |

Fixture items use `ACME-n` keys, so they link to nothing.
