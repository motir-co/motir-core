# Pages — design notes

**Story MOTIR-5752 · design subtask MOTIR-7271.** The project's **Pages** section: a primary rail row,
the `/pages` index with **New page**, and the page at its own address, `/pages/<id>`, in every state
the story ships — fresh, being written, saved / saving / offline, refused as too large, read-only,
loading and not found.

| Surface                     | Asset                               | States | Gates                                                 |
| --------------------------- | ----------------------------------- | ------ | ----------------------------------------------------- |
| The rail row and index      | `pages.mock.html`                   | 1–5    | MOTIR-7300 (section, rail row, ⌘K, index, New page)   |
| The page at its address     | `page.mock.html`                    | 6–12   | MOTIR-7275 (editor, toolbar, indicator), MOTIR-7280   |
| A page’s history            | `page--history.mock.html`           | 1–14   | MOTIR-5754 (History control, panel, compare, restore) |
| The Linked work items strip | `page--linked-work-items.mock.html` | 1–12   | MOTIR-9200 (the strip), MOTIR-9202 (E2E + clip)       |
| Search from the page tree   | `pages--tree--search.mock.html`     | 1–10   | the page-search build (box, hit list, states)         |

## ⚠️ This is a REDRAW, and it follows a refusal

The first version of this card put **New page** in the `/items` toolbar and page rows in the work-item
tree. **Yue refused it on 2026-10-02**: _"wrong design, pages should not be in /items, it should have
its own page"_, then clarified: _"page will have its own nav item in the sidebar, but pages and items
share the same folder system — that's the same 'tree' about. but we don't need to show them in the
same tree yet"_.

So, binding on everything below and on the cards it gates:

- **Nothing is added to `/items`.** No toolbar button, no page rows, no filter. The work-item tree is
  untouched by this story.
- **Pages have their own section**: a primary rail row and their own index.
- **Pages and work items share the project's folder system** (a page can be filed in a folder,
  `page.folder_id`), but showing them in one tree is the next story, **MOTIR-5753**. Here a page is
  reached from the flat `/pages` index or by its address.

The area is new (`design/pages/` did not exist), so these are full mocks, not delta mocks.

## Conventions both assets follow

- **Colour** is `--el-*` only; **shape** is the element shape tokens (`--radius-*`, `--spacing-*`,
  `--height-*`, `--shadow-*`). The token block is copied from `packages/design-system/theme.css` and
  the Tier-3 layer is declared on every `[data-theme]` scope, so a nested dark board really is dark.
- **Ink.** Every secondary line is `--el-text-secondary` (AA on every surface in both themes).
  `--el-text-muted` appears only as placeholder ink directly on the white page (the title placeholder
  and the body placeholder). `--el-text-faint` is not used.
- **Every state is drawn in light and dark.** zh boards: panel 1 (dark), 2 (dark), 3 (light, viewer),
  6, 7, 8, 9 and 12 (dark).
- **Page content is the writer's and is never translated** — a zh board shows English page titles
  beside zh chrome, and the index carries one page titled in Chinese.
- **The rail** is `components/ui/Sidebar`'s expanded row grammar in `SidebarNav.tsx`'s real order.
  Panel 1 draws all fifteen rows; every other board draws the first five and an elided line.

---

## The ACCESS PATH (state 1)

### Position — directly after Work Items

The primary section becomes: Workbench · Work Items · **Pages** · Ready · Runs · My agents · Boards ·
Roadmap · Plans · Backlog · Dashboard · Triage · Reports · Approval records · Codebase.

- **Work Items are the work; Pages are what is written about it.** They are the only two surfaces that
  will share the project's folder system (MOTIR-5753 puts them in one tree), so they sit together.
- **It sits above the run surfaces, not among them.** Ready → Runs → My agents is a sequence ("Ready is
  where you dispatch, Runs is where you watch", then your own agents). Putting Pages anywhere inside it
  would break a run of rows that reads as one flow.
- **It is a primary row** because every top-level project view is one — the convention
  `SidebarNav.tsx` records in a comment on each row, and the one `design/runs/design-notes.md` §
  "The ACCESS PATH" applied to Runs.
- `tests/components/SidebarNav-primary-order.test.tsx` asserts the order; MOTIR-7300 updates it.

### Glyph — `NotebookText`

- **Unused anywhere in the app** (`git grep NotebookText` finds nothing).
- **Not `FileText`**, the obvious first choice: it is already the **`content` work-item type** glyph
  (`lib/issues/workItemTypeMeta.ts`) and the plan-page destination tag
  (`components/planning/PlanDestinationTag.tsx`). Once pages and work items share one tree, a page row
  drawn with the content-type glyph would read as a content-type work item.
- **Not a peer's glyph**: House (Workbench), CircleDot (Work Items), CirclePlay (Ready), Waypoints
  (Runs), SquareTerminal (My agents), Columns3 (Boards), Map (Roadmap), Sparkles (Plans), LayoutList
  (Backlog), LayoutDashboard (Dashboard), Inbox (Triage), BarChart3 (Reports), Stamp (Approval
  records), Code (Codebase), History (Resume onboarding), Settings. **Not `BookOpen`** — the Help
  menu's Docs. **Not `NotebookPen`** — the AI planning settings use it.
- The row comment MOTIR-7300 writes should say all of this, the way every peer's comment does.

### The nav-access row

`lib/settings/projectNavAccess.ts` gains:

```ts
{
  href: '/pages',
  requires: 'page:view',
  evidence:
    'MOTIR-7277: every `pagesService` read asserts `page:view`; the page and the index answer ' +
    '`notFound()` to a reader without it (`docs/decisions/pages.md`).',
},
```

Without the row, `canOfferNavDestination` answers **false** and the rail silently drops the entry.
A reader **without `page:view`** gets **no Pages row**; the rows below close up and nothing marks the
gap (no disabled row — panel 1, third rail). The ⌘K "Go to" list reads the same map, so it offers
**Pages** under the same rule and the same label key.

### Active state

`isActive(pathname, '/pages')` is a prefix test, so the row is active on `/pages` **and** on every
`/pages/<id>` — drawn in panel 1 (second rail) and on every board of `page.mock.html`.

| Element        | Primitive                | Colour / shape                                                                                                               |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Row, resting   | `Sidebar` row (expanded) | ink `--el-text-secondary`, glyph `--el-icon-muted` 18px · `h-(--height-control)` · `--radius-control`                        |
| Row, active    | `Sidebar` row, `active`  | bg `--el-sidebar-item-bg-active`, border `--el-sidebar-border`, `--shadow-subtle`, ink `--el-text`, glyph `--el-icon-active` |
| Review outline | board annotation only    | `--el-highlight` dashed outline — **not shipped**                                                                            |

| Key               | en    | zh   |
| ----------------- | ----- | ---- |
| `shell.nav.pages` | Pages | 页面 |

(The rail's keys live under `shell.nav.*` — `shell.nav.runs`, `shell.nav.myAgents`. The permission
catalog already carries the domain label `page` → "Pages" / "页面".)

---

## The index — `/pages` (states 2–5)

### Composition

- **Header** — every authed page's `<h1 class="font-serif text-2xl font-semibold">` (`--el-text`) and
  subtitle `<p class="text-sm">` (`--el-text-secondary`); **New page** at the header's trailing end,
  `Button` `variant="primary"` (`--el-accent` fill, `--el-accent-text` ink, `--radius-btn`,
  `--height-btn-md`, `--spacing-btn-x`) with a `Plus` glyph.
- **List** — a `<ul aria-label>` inside a Card frame (`--el-card`, `--el-border`, `--radius-card`), soft
  rules between rows (`--el-border-soft`). Each row is **one link** to `/pages/<id>`, padded
  `10px var(--spacing-card-padding)`:
  - `NotebookText` 18px, `--el-icon-muted`, decorative;
  - the **title**, 14px medium `--el-text`, one line, truncated with an ellipsis (the page's own heading
    carries the full title);
  - **untitled**: the copy _Untitled_, italic, `--el-text-secondary` — a blank page is still a findable
    row;
  - the **meta line**, 12.5px `--el-text-secondary`: _Edited {time} by {name}_, or _by you_ when the
    last editor is the reader. `{time}` is the app's relative-time formatter (`Intl.RelativeTimeFormat`
    in the active locale).
  - **hover**: the row takes `--el-surface-soft`; both inks clear AA on it (drawn on row 3).
- **Order**: newest edit first (`updated_at DESC`). **Flat** — no tree, no folders, no sub-pages
  (MOTIR-5753).
- **Data**: `PageSummaryDto` carries `updatedAt` but not who edited. MOTIR-7300 adds the last editor's
  display name (`page.updated_by_id` → `User.name`) to the summary.
- **Paging** is not drawn. If MOTIR-7300 pages the read, it uses the shipped "Show more" below the list
  at `PAGE_LEVEL_PAGE_SIZE` (50).

### New page

Pressing **New page** sends `POST /api/pages` (an empty page at the project root) and moves the browser
to `/pages/<id>`, where the title has focus (state 6). **No dialog and no title prompt** — the page
itself asks for its title first. While the POST is in flight the button is disabled and shows the
spinner with _Creating page…_ (panel 2, below the list). A failure is a `Toast` and the button returns.

### State 3 — empty

The design system's `EmptyState` (a Card: `NotebookText` 48px in `--el-icon-muted`, serif title in
`--el-text`, description in `--el-text-subtitle`). Member: the action is **New page** (primary) and the
header keeps its own New page too. Viewer: **no action anywhere**; the description says who writes
pages, so the empty room does not read as broken.

### State 4 — viewer, populated

Identical list and row links; the header has no button. Nothing is drawn disabled — a disabled button
is a promise the product then refuses. A viewer opens each page read-only (state 10).

### State 5 — loading

`PageSkeleton` **with a real header** (the heading, subtitle and — for a member — New page are known
before the read: static strings and a permission the gate has already resolved). The body is five
row-shaped `Block`s (`--el-muted`, `--radius-control`): an 18px glyph block, a title bar, a meta bar,
inside the same Card frame, so the list settles with no vertical shift. Mounted as an in-page
`<Suspense>` **after** the gate — never a `loading.tsx` (both page routes call `notFound()`;
`design/shell/design-notes.md` § The navigation-pending grammar). Announced once via the existing
`shell.pageLoading`; the blocks are `aria-hidden`.

### Copy — the index

| Key                          | en                                                                                                   | zh                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `pages.index.title`          | Pages                                                                                                | 页面                                                                     |
| `pages.index.subtitle`       | Specs, runbooks and notes for this project — most recently edited first.                             | 此项目的规格说明、运行手册和笔记——最近编辑的排在最前。                   |
| `pages.index.newPage`        | New page                                                                                             | 新建页面                                                                 |
| `pages.index.creating`       | Creating page…                                                                                       | 正在创建页面…                                                            |
| `pages.index.createFailed`   | Couldn’t create the page. Try again.                                                                 | 无法创建页面，请重试。                                                   |
| `pages.index.listLabel`      | Pages in this project                                                                                | 此项目中的页面                                                           |
| `pages.untitled`             | Untitled                                                                                             | 无标题                                                                   |
| `pages.index.edited`         | Edited {time} by {name}                                                                              | {name}于{time}编辑                                                       |
| `pages.index.editedByYou`    | Edited {time} by you                                                                                 | 你于{time}编辑                                                           |
| `pages.index.empty.title`    | No pages yet                                                                                         | 还没有页面                                                               |
| `pages.index.empty.member`   | Write down a spec, a runbook or the notes from a meeting — it stays here, beside the project’s work. | 写下规格说明、运行手册或会议记录——它们会留在这里，与项目的工作放在一起。 |
| `pages.index.empty.viewer`   | When someone in this project writes a page, it appears here.                                         | 当项目成员写下页面后，它会显示在这里。                                   |
| `shell.pageLoading` (exists) | Loading page                                                                                         | 页面加载中                                                               |

`pages.untitled` is shared by the index row, the title placeholder and the browser tab of an untitled
page.

---

## The page — `/pages/<id>` (states 6–12)

### Layout

A reading column (`max-width: 760px`) inside `<main>`:

1. **"← Pages"** — the way back (below);
2. **the title** — a field for a writer, a plain `<h1>` for a viewer, at the same size and place;
3. **the toolbar** — sticky, with the **save indicator** at its trailing end (writer only);
4. **the body** — the Tiptap document, styled by the shipped `.motir-prose` rules.

### The way back — "← Pages" above the title

Drawn, not left to the rail. The rail's Pages row is active on the whole subtree, but the rail is
behind the drawer on a phone, and a reader who finishes a page has their eye at the top of it, not at
the rail. A quiet link — `ArrowLeft` 14px + _Pages_, 13px, `--el-text-secondary` — is enough. It is the
placeholder for the page's breadcrumb, which MOTIR-5753 adds with the tree and which replaces it.

### The title

- **Writer**: an unboxed `<input>` at the page heading's exact size (`font-serif text-2xl
font-semibold`, a 32px line box, `--el-text`), `maxLength={255}` (`PAGE_TITLE_MAX_LENGTH`, so
  `PAGE_TITLE_TOO_LONG` 422 cannot be reached from the UI), placeholder _Untitled_ in
  `--el-text-muted` on the page. Renames go through `PATCH /api/pages/<id>`, debounced like the body,
  and report through the same save indicator.
- **On arrival from New page**, focus is in the title. **Enter** moves focus to the body.
- **Viewer**: a plain `<h1>`, same class, so nothing moves between the two.

### The toolbar — composes `MarkdownEditor.tsx`'s

`components/ui/MarkdownEditor.tsx`'s `Toolbar`, size `full`, **button for button, in its order**:
`role="toolbar"`, `flex flex-wrap items-center gap-0.5 px-1.5 py-1`; each button
`rounded-(--radius-control) p-1.5` with a 16px lucide glyph, `aria-label` = `title` = its label.

| Group (in the shipped file)                                                        | Buttons                                                                                              | Glyph                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Inline marks                                                                       | Bold · Italic · Strikethrough                                                                        | `Bold`, `Italic`, `Strikethrough`   |
| Blocks (`fullExtras`)                                                              | Heading (H2) · Quote · Code block                                                                    | `Heading2`, `Quote`, `Code2`        |
| Lists (`fullExtras`)                                                               | Bulleted list · Numbered list · Task list                                                            | `List`, `ListOrdered`, `ListChecks` |
| Link                                                                               | Link                                                                                                 | `Link`                              |
| **Page adds** (after a hairline)                                                   | **Insert image** · **Insert table**                                                                  | `Image`, `Table`                    |
| **Page adds — table group** (only while the caret is in a table, after a hairline) | **+ Row · + Column · − Row · − Column · Delete table** — text buttons, each with a full `aria-label` | none                                |

What changes from the description editor, and why:

- **Attach file → Insert image.** A page has no attachment list; its images are uploads filed under the
  page (`attachment.page_id`, MOTIR-7279) and inserted as block image nodes. Paste and drop do the same.
- **Tables** are in the page schema and not in the description editor's, so the insert button and the
  table group are new. The table group uses **text** buttons because lucide has no unambiguous glyphs for
  row/column deletion; the labels are short and the `aria-label`s say the whole action.
- **Placement**: on a page the toolbar is a **sticky strip on the canvas** (`--el-page-bg`, top and bottom
  rules in `--el-border`), not the head of a boxed `--el-surface` field — the page _is_ the document.
- **Button ink** is `--el-icon-muted` (the icon role token; same value as the shipped `--el-text-muted`
  on these icon-only buttons). Hover: `--el-surface` fill, `--el-text` glyph.
- The **code block's Language field** is the shipped `markdownEditorCodeBlock.ts` node view and
  `markdown-editor.css` bar: it shows only while the caret is in that block (`data-focused`), label
  `markdownEditor.codeLanguage`, field `--el-page-bg` / `--el-input-border` / `--radius-control` /
  `--height-control`.
- **The page title is not in the toolbar's reach** — it is a separate field, outside the editor.

### The body — every node the schema carries (state 7)

`packages/pages/src/document/extensions.ts`: StarterKit (paragraph, headings 1–3, bold, italic, strike,
inline code, bullet and ordered lists, blockquote, code block with a `language`, horizontal rule, hard
break; no underline, no ProseMirror history), Image (block, no base64), Link (no open on click,
autolink), TaskList / TaskItem (nested), Table / TableRow / TableHeader / TableCell. All are drawn.
Body headings use H2/H3 (the title is the page's H1).

Styled by the shipped `.motir-prose` rules (`components/ui/markdown-editor.css`), with **two
deviations**, both for contrast on a reading surface:

- **Links take `--el-link`**, not `--el-highlight`. The description editor's brand pink is about 2.6:1 on
  the white page — under AA — and a page is mostly read.
- **Blockquotes take `--el-text-secondary`**, not `--el-text-muted`, so a quote stays AA wherever it lands.

The caret-in-a-cell mark is a 2px inset `--el-highlight` ring on the current cell. An image is a block
at full column width, `--radius-control`.

### State 6 — a fresh page

Focus in the empty title (placeholder _Untitled_), the body placeholder, the toolbar, and the indicator
already reading **Saved** — the page exists and is empty. Rail: Pages active.

### State 8 — the save indicator

**Where:** the trailing end of the toolbar (`margin-left: auto`). The toolbar is sticky, so the
indicator is in view wherever the writer is in a long page, at the place their eyes already are. It is a
polite live region (`role="status"`). Chip shape: `--radius-badge`, `--spacing-chip-x/y`, 12.5px, a
14px glyph. **Not rendered for a viewer.**

The behaviour is MOTIR-7275's autosave loop: local-origin Yjs updates are buffered and sent as one merged
update after **1 s of quiet**, capped at **5 s** of continuous typing, **one request in flight**.

| Value (`SaveStatus`) | Drawn as                                                                                                                                                | Means                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `saved`              | `Check` + _Saved_, `--el-text-secondary`, no fill                                                                                                       | Nothing is waiting. The resting state, so the quietest.                                                                                                                                                    |
| `saving`             | `LoaderCircle` + _Saving…_, `--el-text-secondary`, no fill                                                                                              | A batch is in flight (or buffered and about to go).                                                                                                                                                        |
| `offline`            | `CloudOff` + _Offline — edits kept_, `--el-warning-surface` fill, `--el-warning-text` ink; tooltip (`Tooltip`, `--el-tooltip-bg/-text`) with the detail | The last save failed for lack of network. Edits stay buffered in the tab and are resent with backoff (2 s → 4 s → 8 s … capped at 30 s) and on the browser's `online` event; the next success reads Saved. |
| `too_large`          | `TriangleAlert` + _Not saved_, `--el-danger-on-surface`, 500                                                                                            | State 9.                                                                                                                                                                                                   |

`offline` is the only value with a fill because it is the only one that asks something of the writer:
the buffer lives in the tab, so the tooltip says to keep the tab open until it reads Saved.

### State 9 — refused as too large

`POST /api/pages/<id>/updates` answers **413** `{ code: 'PAGE_BODY_TOO_LARGE', error, limit, size }` when
the merged body would pass **2 MiB** (`PAGE_BODY_MAX_BYTES`) or one request passes **1 MiB**
(`PAGE_SAVE_MAX_BYTES`); nothing is written either way (`lib/pages/routeErrors.ts`,
`packages/pages/src/errors.ts`). The editor reports `too_large` and **stops sending** (MOTIR-7275) —
it does not resume on its own.

- **The indicator** reads **Not saved** (danger ink).
- **A callout** opens under the toolbar, `role="alert"`: `--el-danger-surface` fill, a 1px `--el-danger`
  border, `TriangleAlert` in `--el-danger-on-surface`, copy in `--el-danger-surface-text`,
  `--radius-card`. It says **what happened** (the edits since the last save are not saved, and nothing
  more will be from this tab) and **what to do**: copy out what to keep and reload to the last saved
  version; to make room, move long sections into a new page or remove large tables and pasted text.
- **The content stays in the editor** (still selectable) so it can be copied.
- **Two secondary buttons** (`Button variant="secondary" size="sm"`): **Reload saved version** (a full
  reload; the body has already said the unsaved edits go) and **New page in a new tab** (creates a page
  and opens it in a new tab, so a section can be pasted across without losing this tab's text). Neither
  is primary: neither is the right next step for every writer.
- The limit is shown as **2 MB** — the unit a writer reads; the constant is 2 MiB.

### State 10 — read-only

The read returns `canEdit: false`; `PageEditor` mounts with `editable: false`: **no toolbar, no save
indicator, no autosave subscription**. The title is a plain `<h1>` at the field's size and place. The
body is the same document, not editable; the code block shows no Language field, because a read-only
document never holds a caret (the block draws only its own frame: `--el-surface`, `--el-border`,
`--radius-input`). No "view only" label is added — the absent toolbar is the signal, and the index has
already said who writes.

### State 11 — loading

**No `loading.tsx`** above `/pages` or `/pages/<id>`: both decide existence (CLAUDE.md § _A
`loading.tsx` may NOT sit above a route that decides existence_). The page resolves the project and the
reader's access, then renders an in-page `<Suspense>` whose fallback is `PageSkeleton`:

- **"← Pages"** is static, so it paints above the boundary;
- the **generic header** pair of bars — the title is not known until the read returns. The page has no
  subtitle, so the settle moves up by the subtitle bar, the upward settle the grammar accepts;
- **paragraph bars** for the body;
- **no toolbar block** — whether there is a toolbar depends on `canEdit`, which the same read answers,
  and a frame must not promise a toolbar a viewer will not get.

Announced once via `shell.pageLoading`; the bars are `aria-hidden`.

### State 12 — not found, deliberately indistinguishable

An unknown id, a page in another project, and a non-member all get the routes' **same bytes**,
`404 { code: 'PAGE_NOT_FOUND', error: 'Page not found.' }` — `pageErrorResponse` maps a browse denial,
`ProjectNotFoundError` and `PageNotFoundError` to one body. The page does the same: it calls
`notFound()` in every case, and the shared **`app/(authed)/not-found.tsx`** boundary renders —
`EmptyState` with `FileQuestion`, `errors.notFound.title` / `.description`, and _Go to work items_. That
is the screen **every** unknown authed address gets, so it does not even confirm the address was a page.
**No page-specific copy is added** — a page-specific message would be the leak. A reader without
`page:view` gets the same screen (and has no Pages row). The rail's Pages row is still active (the path
is under `/pages`).

### Copy — the page

| Key                                        | en                                                                                                                                                                                                                                                                                                                            | zh                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pages.page.back`                          | Pages                                                                                                                                                                                                                                                                                                                         | 页面                                                                                                                                                                                                                       |
| `pages.page.backLabel`                     | Back to Pages                                                                                                                                                                                                                                                                                                                 | 返回页面                                                                                                                                                                                                                   |
| `pages.page.titleLabel`                    | Page title                                                                                                                                                                                                                                                                                                                    | 页面标题                                                                                                                                                                                                                   |
| `pages.untitled` (title placeholder)       | Untitled                                                                                                                                                                                                                                                                                                                      | 无标题                                                                                                                                                                                                                     |
| `pages.editor.bodyPlaceholder`             | Start writing. Use the toolbar for headings, lists, tables, code and images.                                                                                                                                                                                                                                                  | 开始写作。使用工具栏添加标题、列表、表格、代码和图片。                                                                                                                                                                     |
| `pages.editor.toolbar.label`               | Formatting                                                                                                                                                                                                                                                                                                                    | 格式                                                                                                                                                                                                                       |
| `pages.editor.toolbar.bold`                | Bold                                                                                                                                                                                                                                                                                                                          | 粗体                                                                                                                                                                                                                       |
| `pages.editor.toolbar.italic`              | Italic                                                                                                                                                                                                                                                                                                                        | 斜体                                                                                                                                                                                                                       |
| `pages.editor.toolbar.strike`              | Strikethrough                                                                                                                                                                                                                                                                                                                 | 删除线                                                                                                                                                                                                                     |
| `pages.editor.toolbar.heading`             | Heading                                                                                                                                                                                                                                                                                                                       | 标题                                                                                                                                                                                                                       |
| `pages.editor.toolbar.quote`               | Quote                                                                                                                                                                                                                                                                                                                         | 引用                                                                                                                                                                                                                       |
| `pages.editor.toolbar.codeBlock`           | Code block                                                                                                                                                                                                                                                                                                                    | 代码块                                                                                                                                                                                                                     |
| `pages.editor.toolbar.bulletList`          | Bulleted list                                                                                                                                                                                                                                                                                                                 | 项目符号列表                                                                                                                                                                                                               |
| `pages.editor.toolbar.orderedList`         | Numbered list                                                                                                                                                                                                                                                                                                                 | 编号列表                                                                                                                                                                                                                   |
| `pages.editor.toolbar.taskList`            | Task list                                                                                                                                                                                                                                                                                                                     | 任务列表                                                                                                                                                                                                                   |
| `pages.editor.toolbar.link`                | Link                                                                                                                                                                                                                                                                                                                          | 链接                                                                                                                                                                                                                       |
| `pages.editor.toolbar.linkPrompt`          | Link URL                                                                                                                                                                                                                                                                                                                      | 链接地址                                                                                                                                                                                                                   |
| `pages.editor.toolbar.image`               | Insert image                                                                                                                                                                                                                                                                                                                  | 插入图片                                                                                                                                                                                                                   |
| `pages.editor.toolbar.table`               | Insert table                                                                                                                                                                                                                                                                                                                  | 插入表格                                                                                                                                                                                                                   |
| `pages.editor.table.addRow`                | + Row (`aria-label`: Add row below)                                                                                                                                                                                                                                                                                           | + 行（`aria-label`：在下方添加行）                                                                                                                                                                                         |
| `pages.editor.table.addColumn`             | + Column (`aria-label`: Add column to the right)                                                                                                                                                                                                                                                                              | + 列（`aria-label`：在右侧添加列）                                                                                                                                                                                         |
| `pages.editor.table.deleteRow`             | − Row (`aria-label`: Delete row)                                                                                                                                                                                                                                                                                              | − 行（`aria-label`：删除行）                                                                                                                                                                                               |
| `pages.editor.table.deleteColumn`          | − Column (`aria-label`: Delete column)                                                                                                                                                                                                                                                                                        | − 列（`aria-label`：删除列）                                                                                                                                                                                               |
| `pages.editor.table.deleteTable`           | Delete table                                                                                                                                                                                                                                                                                                                  | 删除表格                                                                                                                                                                                                                   |
| `markdownEditor.codeLanguage` (exists)     | Language                                                                                                                                                                                                                                                                                                                      | 语言                                                                                                                                                                                                                       |
| `pages.editor.status.saved`                | Saved                                                                                                                                                                                                                                                                                                                         | 已保存                                                                                                                                                                                                                     |
| `pages.editor.status.saving`               | Saving…                                                                                                                                                                                                                                                                                                                       | 正在保存…                                                                                                                                                                                                                  |
| `pages.editor.status.offline`              | Offline — edits kept                                                                                                                                                                                                                                                                                                          | 离线——编辑已保留                                                                                                                                                                                                           |
| `pages.editor.status.offlineDetail`        | Your last save didn’t reach Motir. Your edits are kept in this tab and are sent as soon as you’re back online — keep the tab open until it says Saved.                                                                                                                                                                        | 上次保存未能送达 Motir。你的编辑保留在此标签页中，网络恢复后会立即发送——在显示“已保存”之前请保持此标签页打开。                                                                                                             |
| `pages.editor.status.tooLarge`             | Not saved                                                                                                                                                                                                                                                                                                                     | 未保存                                                                                                                                                                                                                     |
| `pages.editor.tooLarge.title`              | This page is too large to save                                                                                                                                                                                                                                                                                                | 页面过大，无法保存                                                                                                                                                                                                         |
| `pages.editor.tooLarge.body`               | Your edits since the last save would take the page past its 2 MB limit, so they were not saved — and nothing more will be saved from this tab. Copy out anything you want to keep, then reload to go back to the last saved version. To make room, move long sections into a new page or remove large tables and pasted text. | 自上次保存以来的编辑会使页面超过 2 MB 的上限，因此未被保存——此标签页之后的编辑也不会再保存。请先复制需要保留的内容，然后重新加载以回到上次保存的版本。如需腾出空间，可将较长的部分移到新页面，或删除大型表格和粘贴的文本。 |
| `pages.editor.tooLarge.reload`             | Reload saved version                                                                                                                                                                                                                                                                                                          | 重新加载已保存版本                                                                                                                                                                                                         |
| `pages.editor.tooLarge.newPageNewTab`      | New page in a new tab                                                                                                                                                                                                                                                                                                         | 在新标签页中新建页面                                                                                                                                                                                                       |
| `pages.editor.imageUploadFailed`           | Couldn’t upload the image. Try again.                                                                                                                                                                                                                                                                                         | 无法上传图片，请重试。                                                                                                                                                                                                     |
| `shell.pageLoading` (exists)               | Loading page                                                                                                                                                                                                                                                                                                                  | 页面加载中                                                                                                                                                                                                                 |
| `errors.notFound.title` (exists)           | We couldn’t find that page                                                                                                                                                                                                                                                                                                    | 找不到该页面                                                                                                                                                                                                               |
| `errors.notFound.description` (exists)     | The address may be mistyped, or whatever it pointed at may have been deleted — or moved somewhere you can’t reach.                                                                                                                                                                                                            | 地址可能有误，或者它指向的内容已被删除——也可能被移到了你无权访问的位置。                                                                                                                                                   |
| `errors.notFound.workItemsAction` (exists) | Go to work items                                                                                                                                                                                                                                                                                                              | 前往工作项                                                                                                                                                                                                                 |

The `pages.editor.*` strings are the values of MOTIR-7275's `PageEditorMessages` prop: the package
renders no string of its own, and the app supplies en and zh. (The description editor's toolbar labels
are hard-coded English today; the page editor's are not.)

---

## Open questions handed to the cards

- **Leaving with unsent edits.** The offline buffer lives in the tab. MOTIR-7275 carries no leave-page
  guard; the tooltip asks the writer to keep the tab open. A `beforeunload` prompt while the status is
  `saving`, `offline` or `too_large` is the obvious complement and is MOTIR-7280's to decide.
- **Recovering from `too_large` without a reload.** The loop stops for good; trimming the page does not
  restart it. That is MOTIR-7275's stated behaviour and the copy is written to it.

## Not drawn here

- **The page tree, sub-pages, filing into folders, moving and reordering, the breadcrumb** — MOTIR-5753
  (_Pages in the project tree_). The "← Pages" link is the breadcrumb's placeholder.
- **History, versions and restore** — MOTIR-5754.
- **Archive, delete and restore** — MOTIR-5755.
- **Mentions of work items, and the backlinks on a work item** — MOTIR-5747.
- **Co-editing, cursors and presence** — MOTIR-5750. **Page comments** — MOTIR-5749.
- **The mobile drawer** — the rail row is the same row in the drawer variant; nothing else changes.

---

## The page tree

**Story MOTIR-5753 · design subtask MOTIR-7367.** The `/pages` index becomes a TREE of the project's
folders and pages, and the page at `/pages/<id>` gains a sidebar tree and a breadcrumb. This section
**amends** two parts of the approved design above, by delta mock; the approved mocks are not edited:

| Amends                                                     | By                             | Panels |
| ---------------------------------------------------------- | ------------------------------ | ------ |
| § The index — `/pages` (states 2–5), `pages.mock.html`     | `pages--tree.mock.html`        | 1–12   |
| § The way back — "← Pages", `page.mock.html` (states 6–12) | `page--tree-sidebar.mock.html` | 1–5    |

### Design system — what was read, and the verdict

- **Read:** `package.json` (depends on `@motir/design-system`, `workspace:*`), `app/globals.css` (imports
  `@motir/design-system/theme.css`), `packages/design-system/package.json` (version **0.8.0**, exports
  `./mock`), `app/layout.tsx` (the axes are the signed-in reader's own appearance —
  `data-style` / `data-palette` / `data-type` from `appearancePreferenceService` — so there is no single
  project axis to pin), `packages/design-system/theme.css`.
- **Verdict: ON MOTIR DESIGN (branch a)** — both checks hold.
- **How the mocks are built:** composed from the shipped parts' actual markup with the theme's tokens
  inlined, the same way the approved base (`pages.mock.html`, `page.mock.html`) is built, so the two
  deltas read as one design with it. `renderMock` from `@motir/design-system/mock` exists at 0.8.0 but no
  asset in `design/` uses it, and a delta drawn by a different method from its base could not be
  compared panel to panel. The token block is the base's (base palette, default style), plus five tokens
  copied from `theme.css` that the tree needs: `--el-tint-rose`, `--el-overlay-scrim`, `--radius-modal`,
  `--shadow-modal`, `--spacing-tooltip-x/y`.
- **Parts the package lacks:** none is proposed for the package. Everything drawn is the package's
  (`Button`, `Popover`, `Modal`, `EmptyState`, `PageSkeleton`, `Sidebar` row treatment) or the
  product's own (`TreeTable`, and `/items`' folder components, which MOTIR-7374 moves into a
  new shared `folders` directory under `components`). `PageTree`, `PageRowMenu`, `PagePlacementPicker`, `PageTreeDnd` and
  `PageBreadcrumb` are **product-local components** — they know pages and folders, which the package
  does not.

### What is fixed, and what it rests on

- **Nothing is drawn in `/items`, and `/items` does not change.** Pages and work items share the
  project's folders, but each surface shows its own kind (ADR `docs/decisions/pages.md` AMENDMENT 1,
  quoting Yue, 2026-10-02).
- **`/pages` shows every project folder**, including one that so far holds only work items: a folder is
  where a page is filed beside the work it describes. This settles the tree-view question AMENDMENT 1
  handed to MOTIR-5753 ("how a folder that holds only pages, or only work items, shows on the other
  surface").
- **A level is folders first, then pages**, each in position order (ADR §4 as amended); 50 per read,
  at most 100, one keyset cursor across both bands (ADR §4; MOTIR-7370 `listTreeLevel`).

### Access path (drawn)

1. The shipped **Pages** rail row (base § The ACCESS PATH) opens `/pages`, now the tree —
   `pages--tree.mock.html` panel 1.
2. A **page row's title is a link** to `/pages/<id>` — the same panel; it lands on
   `page--tree-sidebar.mock.html` panel 1.
3. On the page, the **breadcrumb's folder segment** links to `/pages?folder=<folderId>`, which opens
   the tree with that folder's path expanded and the folder focused — sidebar mock panel 4. The
   **Pages** segment and the sidebar's head link to `/pages`.

### `/pages` — the tree (`pages--tree.mock.html`)

**Composition.**

| Element                   | Primitive / source                                                                | Colour / shape                                                                                                                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header                    | the base header (`font-serif text-2xl`), subtitle changed                         | `--el-text`, subtitle `--el-text-secondary`                                                                                                                                                                                                                                              |
| New folder · New page     | `Button` secondary · `Button` primary, `FolderPlus` · `Plus` 16px                 | `--el-button-border` / `--el-accent` + `--el-accent-text`, `--radius-btn`, `--height-btn-md`, `--spacing-btn-x`                                                                                                                                                                          |
| Tree frame                | Card frame around `role="tree"`                                                   | `--el-card`, `--el-border`, `--radius-card`; rules between rows `--el-border-soft`                                                                                                                                                                                                       |
| Row                       | `TreeTable` row: 40px (`ROW_PX`), 22px per level (`INDENT_PX`), 16px chevron slot | ink `--el-text`; hover `--el-surface`; focus `--focus-ring-color` inset ring                                                                                                                                                                                                             |
| Chevron                   | `ChevronRight` 12px, rotated 90° when open                                        | `--el-icon-muted`, decorative                                                                                                                                                                                                                                                            |
| Folder row                | `/items`' folder row: `Folder` 16px + name, semibold                              | glyph `--el-text-secondary`, name `--el-text`. **Always expandable.** Its whole row toggles it.                                                                                                                                                                                          |
| Page row                  | `NotebookText` 16px (the rail's Pages glyph) + the title as a link                | glyph `--el-icon-muted`, title `--el-text`; untitled: _Untitled_ italic `--el-text-secondary`                                                                                                                                                                                            |
| Row menu trigger          | `FolderRowMenu`'s trigger: `Ellipsis` in a `--height-control` square              | `--el-text-secondary`, `--radius-control`, `--spacing-icon-btn`; open: `--el-border-soft` fill, `--el-text`                                                                                                                                                                              |
| Row menu                  | `FolderRowMenu` (`Popover`, width 220, `role="menu"`)                             | items `--height-control`, `--spacing-control-x`, `--radius-control`, 13px `--el-text`; glyph `--el-text-secondary`; danger `--el-danger-on-surface` + `--el-danger` glyph; disabled `--el-text-faint` on a `disabled` item                                                               |
| Inline name field         | `FolderNameField`, shipped                                                        | `--el-input-border`, `--radius-input`, focus ring                                                                                                                                                                                                                                        |
| Synthetic rows            | `/items`' empty / loading / load-more rows                                        | 13px `--el-text-secondary`; sentence `--el-text`; `Loader2` / `AlertCircle` (`--el-danger`) 14px; links `--el-link`                                                                                                                                                                      |
| Load more                 | text button, `ChevronDown` 14px                                                   | `--el-link`, count `--el-text-secondary`                                                                                                                                                                                                                                                 |
| Skeleton                  | `PageSkeleton` `Block`s inside the tree frame                                     | `--el-muted`, `--radius-control`, `aria-hidden`                                                                                                                                                                                                                                          |
| Empty project             | `EmptyState` (base state 3) + a second action                                     | as the base                                                                                                                                                                                                                                                                              |
| Move to… picker           | `FolderPickerPanel` in `FolderPickerPopover`, width 320                           | title 12px semibold `--el-text-secondary`; refusal box `--el-danger` border + glyph on `--el-tint-rose`, copy `--el-text-strong`; option `--spacing-control-x/y`, `--radius-control`, active `--el-surface`; disabled `--el-text-faint` on `aria-disabled`, reason `--el-text-secondary` |
| Drag handle               | `GripVertical` 16px in the row's left gutter                                      | `--el-icon-muted`, `aria-hidden`, out of the tab order                                                                                                                                                                                                                                   |
| Lifted row (drag overlay) | the row on a card                                                                 | `--el-card`, `--el-border-strong`, `--radius-control`, `--shadow-elevated`                                                                                                                                                                                                               |
| Origin slot               | dashed placeholder                                                                | `--el-border-strong` dashed on `--el-surface-soft`                                                                                                                                                                                                                                       |
| Drop before / after       | 2px line with an 8px ring dot, at the target level's indent                       | `--el-accent`                                                                                                                                                                                                                                                                            |
| Drop inside               | the target row tinted and ringed                                                  | `--el-tint-lavender` fill, 2px inset `--el-accent` ring                                                                                                                                                                                                                                  |
| Refused target            | dashed outline, `not-allowed` cursor, `Tooltip`                                   | `--el-danger` 2px dashed; tooltip `--el-tooltip-bg/-text`, `--spacing-tooltip-x/y`                                                                                                                                                                                                       |
| Root drop zone            | dashed box at the tree's foot, only while dragging                                | `--el-border-strong` dashed, `--el-text-secondary`, `--radius-control`                                                                                                                                                                                                                   |
| Refused-drop message      | `Toast`                                                                           | `--el-card`, `--el-border`, `--radius-card`, `--shadow-elevated`; glyph `--el-danger`, copy `--el-text`                                                                                                                                                                                  |
| Folder delete             | `FolderDeleteDialog` (`Modal`, `alertdialog`), count line changed                 | as shipped: `--el-tint-mint` box, `--el-text-strong`, `ArrowUp` `--el-success`; `Button` danger (`--el-danger` + `--el-danger-text`)                                                                                                                                                     |

**Rows and order (panel 1).** Folders first, then pages, each in position order. A folder row's whole
row expands it (as in `/items`); a page row's title opens the page, and its chevron expands its
sub-pages. A page with no sub-pages has no chevron; **a folder always has one**, because its emptiness is
only known after the read and is then said in words. The tree is `role="tree"` / `treeitem` with
`aria-level`, `aria-expanded` and arrow-key movement (MOTIR-7373). Page rows carry no "Edited…" line:
the tree is in position order, not recency, and the editor is on the page.

**New (panels 1, 2, 4).** **New page** (header, and the empty state) creates at the root; **New page here**
(folder menu, and a folder's _No pages here_ row) creates in that folder; **New sub-page** (page menu)
creates under that page. All three POST with a `parent` and move the browser to the new page with focus
in the title — no dialog, as the base decided. While the POST runs a pending row (_Creating page…_)
sits where the page will appear. A failure is the shipped `pages.index.createFailed` toast. **New
folder** (header, and the empty state) is the shipped root folder create with its inline name field.

**Row menus (panel 2).**

- **Page row:** New sub-page · Move to… | Move up · Move down. Move up / down reorder among **sibling
  pages** only (folders always lead a level, so a page never passes one). On the first sibling **Move
  up is absent**; on the last, **Move down is absent** — MOTIR-7374's acceptance criterion.
- **Folder row:** the shipped `/items` folder menu, composed unchanged, with **New page here** put
  first: New page here · New folder inside · Rename · Move to… | Move up · Move down | Delete…. The
  shipped folder Move up / Move down keep their shipped behaviour (drawn **disabled** on the first / last
  folder). See _Open questions_.

**States.** Folders but no pages (panel 3) · empty project (4) · loading — first level and an expanding
level (5) · error — first level and a level's expand, with retry on the row (6) · at scale — 50 rows then
Load more, with a count of rows _shown_ because a keyset cursor knows no total (7) · read-only viewer — no
New, no menu, no handle, nothing drawn disabled (8). The first-level frame is an in-page `<Suspense>`
after the gate, never a `loading.tsx`, because `/pages` calls `notFound()` (CLAUDE.md).

**Move to… (panels 9–10).** Composed from the shipped `FolderPickerPanel`: anchored to the row's menu
button, titled with `folders.pickerTitle`, a refusal slot at the top, a `listbox` of options, picking
commits, picking the current location writes nothing. Two differences, both because pages are many:
the options are a **lazily expanded tree** (each option's chevron reads that level through the tree
route), and there is **no search field** (this story has no page search). **Project root** is the first
option. **The moving page is disabled** with its reason and has no chevron, so its sub-pages are never
offered — the cycle is refused before anything is sent. A refusal the picker could not have known
renders in the refusal slot and the tree is unchanged:

| Refusal (route → code)                  | Key                               | Source                                        |
| --------------------------------------- | --------------------------------- | --------------------------------------------- |
| 422 `PAGE_CYCLE`                        | `pages.tree.refusal.cycle`        | ADR §4 · MOTIR-7368 (package) · MOTIR-7372    |
| 422 `PAGE_DEPTH_EXCEEDED` (`limit: 10`) | `pages.tree.refusal.depth`        | ADR §4 `PAGE_DEPTH_LIMIT` · MOTIR-7368 · 7372 |
| 422 `CROSS_PROJECT_PAGE_PARENT`         | `pages.tree.refusal.crossProject` | ADR §4 · MOTIR-7368 · MOTIR-7372              |
| 404 (folder or page parent gone)        | `pages.tree.refusal.gone`         | MOTIR-7372                                    |

**Drag (panel 11).** Only page rows are draggable, only for an editor; folder rows are drop targets and
never draggable (folders move with Move to…, as in `/items`). On a page row the top quarter means
**before**, the bottom quarter **after**, the middle half **inside**; a folder row is **inside** only.
Hovering a collapsed row for 600ms expands it. While a drag is live, a root drop zone appears at the
tree's foot (drop there → the project root, after the root's pages). A page over itself or anything inside
it is **refused before the drop** (dashed danger outline, `not-allowed`, a tooltip). Depth and
cross-project refusals only the server knows: the row **snaps back**, keeps focus, and a toast says the
move's own sentence. There is **no keyboard drag** — Move up / Move down / Move to… are the keyboard
path, so the handle is `aria-hidden` and not focusable.

**Folder delete (panel 12).** The shipped dialog, unchanged except that its count names pages too and its
last sentence says no page is deleted; deleting moves the folder's pages up with its work items and
folders (ADR §4).

### The page — sidebar and breadcrumb (`page--tree-sidebar.mock.html`)

| Element               | Primitive / source                                         | Colour / shape                                                                                                                |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Sidebar column        | `<aside>` between the rail and `<main>`, 248px             | `--el-surface-soft`, right rule `--el-border`                                                                                 |
| Sidebar head          | "Pages" link + hide button (`PanelLeftClose`, icon button) | 13px semibold `--el-text`; button `--el-text-secondary`, `--height-btn-sm` square, `--radius-control`                         |
| Sidebar rows          | `PageTree` at compact density: 32px rows, 14px per level   | `--el-text`, folder glyph `--el-text-secondary`, page glyph `--el-icon-muted`, `--radius-control`                             |
| Selected page         | `Sidebar`'s active-row treatment                           | `--el-sidebar-item-bg-active`, `--el-sidebar-border`, `--shadow-subtle`, 500 weight, glyph `--el-icon-active`                 |
| Breadcrumb            | `<nav>` of links, `ChevronRight` 14px separators           | links 13px `--el-text-secondary`; current `--el-text` 500, `aria-current="page"`; separators `--el-icon-muted`, `aria-hidden` |
| Folder segment        | `Folder` 14px + name (+ sr-only "Folder:")                 | as a link                                                                                                                     |
| "…" (hidden segments) | button + `Popover` menu (`FolderRowMenu` grammar)          | `--el-text-secondary`, `--radius-control`; open `--el-border-soft`; items as the row menu                                     |
| Show page tree        | icon button (`PanelLeftOpen`) leading the breadcrumb row   | as the hide button                                                                                                            |
| Narrow overlay        | the same `<aside>` as a drawer                             | `--el-overlay-scrim`, `--shadow-modal`                                                                                        |

- **Selected and expanded (panel 1).** `PageTree` with `selectedPageId` and an `expandedPath` built from
  the trail, so the path is open on first paint and only levels opened later load lazily. **The sidebar is
  navigation only**: no New, no row menu, no drag — arranging the tree happens in `/pages`, and a second
  set of actions on a 248px column would be the same actions in a worse place.
- **Breadcrumb (panels 1–2).** Root-first: **Pages** › folders › ancestor pages › this page, from
  `getPageTrail` (ADR §4: folders read from the topmost page's folder chain; pages from
  `ancestor_page_ids`). It always starts with **Pages**, so a root page keeps its way back, and it
  replaces "← Pages" and its two keys. **Middle truncation:** over five segments, keep Pages, the first
  segment, the parent and the page; fold the rest into "…", which opens the hidden segments root-first.
  Each segment truncates at 180px (the page at 220px) with its full text in `title`.
- **Collapsed (panel 3).** At **1280px and wider** the sidebar shows unless the reader hid it (a
  per-viewer `localStorage` convenience; empty storage means shown). **Below 1280px** it starts hidden and
  **Show page tree** opens it as an overlay drawer, closed by Esc, the scrim or choosing a page.
- **Breadcrumb → tree (panel 4).** A folder segment → `/pages?folder=<folderId>`: the tree opens with that
  folder's path expanded and the folder focused. A page segment → that page.
- **Sidebar states (panel 5).** The tree's own loading / failed / Load more rows at compact density. A
  page that 404s renders no sidebar and no breadcrumb (base state 12 unchanged); read-only is unchanged
  (base state 10) and the sidebar is the same for everyone.

### Copy — the page tree

New keys live under `pages.tree.*`. Shipped keys are reused where the words are the same, so the folder
commands read identically in `/items` and `/pages`.

| Key                               | en                                                                                                | zh                                                                | Built by   |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------- |
| `pages.tree.subtitle`             | Specs, runbooks and notes for this project, kept in folders and pages.                            | 此项目的规格说明、运行手册和笔记，按文件夹和页面整理。            | MOTIR-7373 |
| `pages.tree.label`                | Folders and pages in this project                                                                 | 此项目中的文件夹和页面                                            | MOTIR-7373 |
| `pages.tree.newPageHere`          | New page here                                                                                     | 在此新建页面                                                      | MOTIR-7373 |
| `pages.tree.newSubPage`           | New sub-page                                                                                      | 新建子页面                                                        | MOTIR-7373 |
| `pages.tree.pageActionsAria`      | Page actions for {title}                                                                          | “{title}”的页面操作                                               | MOTIR-7373 |
| `pages.tree.expandAria`           | Expand {title}                                                                                    | 展开“{title}”                                                     | MOTIR-7373 |
| `pages.tree.collapseAria`         | Collapse {title}                                                                                  | 收起“{title}”                                                     | MOTIR-7373 |
| `pages.tree.noPagesHere`          | No pages here                                                                                     | 这里还没有页面                                                    | MOTIR-7373 |
| `pages.tree.loadingLevel`         | Loading pages…                                                                                    | 正在加载页面…                                                     | MOTIR-7373 |
| `pages.tree.rootFailed`           | Couldn’t load the pages.                                                                          | 无法加载页面。                                                    | MOTIR-7373 |
| `pages.tree.levelFailed`          | Couldn’t load what’s inside.                                                                      | 无法加载其中的内容。                                              | MOTIR-7373 |
| `pages.tree.loadMore`             | Load more                                                                                         | 加载更多                                                          | MOTIR-7373 |
| `pages.tree.shown`                | {count} shown                                                                                     | 已显示 {count} 项                                                 | MOTIR-7373 |
| `pages.tree.picker.listLabel`     | Folders and pages                                                                                 | 文件夹和页面                                                      | MOTIR-7374 |
| `pages.tree.picker.loading`       | Loading folders and pages…                                                                        | 正在加载文件夹和页面…                                             | MOTIR-7374 |
| `pages.tree.picker.isThisPage`    | It’s this page — a page can’t move into itself or its sub-pages.                                  | 就是此页面——页面不能移动到其自身或其子页面中。                    | MOTIR-7374 |
| `pages.tree.refusal.cycle`        | A page can’t move into one of its own sub-pages. It stayed where it was.                          | 页面不能移动到其自身的子页面中。它保持在原位。                    | MOTIR-7374 |
| `pages.tree.refusal.depth`        | Pages nest at most {limit} levels deep, and this move would go past that. It stayed where it was. | 页面最多只能嵌套 {limit} 层，此次移动会超出该限制。它保持在原位。 | MOTIR-7374 |
| `pages.tree.refusal.crossProject` | That folder or page belongs to another project. The page stayed where it was.                     | 该文件夹或页面属于另一个项目。页面保持在原位。                    | MOTIR-7374 |
| `pages.tree.refusal.gone`         | That folder or page no longer exists. The page stayed where it was.                               | 该文件夹或页面已不存在。页面保持在原位。                          | MOTIR-7374 |
| `pages.tree.drop.root`            | Drop here to move it to the project root                                                          | 拖放到此处，将其移动到项目根目录                                  | MOTIR-7376 |
| `pages.tree.drop.refusedSelf`     | Can’t drop a page into its own sub-page.                                                          | 不能将页面拖放到其自身的子页面中。                                | MOTIR-7376 |
| `pages.tree.sidebar.label`        | Page tree                                                                                         | 页面树                                                            | MOTIR-7375 |
| `pages.tree.sidebar.hide`         | Hide page tree                                                                                    | 隐藏页面树                                                        | MOTIR-7375 |
| `pages.tree.sidebar.show`         | Show page tree                                                                                    | 显示页面树                                                        | MOTIR-7375 |
| `pages.tree.breadcrumb.label`     | Where this page is                                                                                | 此页面所在位置                                                    | MOTIR-7375 |
| `pages.tree.breadcrumb.more`      | Show {count} more levels                                                                          | 显示另外 {count} 层                                               | MOTIR-7375 |
| `pages.tree.breadcrumb.folder`    | Folder:                                                                                           | 文件夹：                                                          | MOTIR-7375 |

`{limit}` is `PAGE_DEPTH_LIMIT` (10), passed from the 422's `limit`. `pages.tree.expandAria` /
`collapseAria` are the page row chevron's labels (a folder row keeps `folders.expandAria` /
`collapseAria`).

**Reused, unchanged:** `pages.index.title` (header, breadcrumb root, sidebar head), `pages.index.newPage`,
`pages.index.creating`, `pages.index.createFailed`, `pages.index.empty.*`, `pages.untitled`,
`shell.pageLoading`, `common.retry` (_Try again_ / 重试), `common.cancel`, `common.close`, and from
`folders.*`: `newFolder`, `newFolderInside`, `rename`, `moveTo`, `moveUp`, `moveDown`, `delete`,
`pickerTitle`, `projectRoot`, `currentLocation`, `actionsAria`, `nameLabel`, `expandAria`, `collapseAria`,
`deleteTitle`, `deleteLead`, `deleteConfirm`.

**Changed (MOTIR-7371):** `folders.deleteMoves` gains a `pages` count and its last sentence becomes
_No work items or pages are deleted._ / _不会删除任何工作项或页面。_ — drawn with the counts filled in as
"**2 folders, 4 work items and 3 pages** will move to **Project root**." / "**2 个文件夹、4 个工作项和 3
个页面**将移动到**项目根目录**。".

**Retired:** `pages.index.subtitle` and `pages.index.listLabel` (MOTIR-7373, replaced by
`pages.tree.subtitle` / `pages.tree.label`); `pages.page.back` and `pages.page.backLabel` (MOTIR-7375,
replaced by the breadcrumb).

### Allocation — which card builds which element

No element is built twice; where two cards touch one component, the split is stated.

| Element (mock · panel)                                                                                                                      | Built by                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `PageTree`: rows, glyphs, indent, chevrons, `role="tree"`, keyboard, lazy expand, Load more (tree 1, 7)                                     | **MOTIR-7373**                             |
| Header subtitle and **New page**; empty state with New page (tree 1, 4)                                                                     | **MOTIR-7373**                             |
| The row Ellipsis trigger with its **New** entry only — New sub-page (page), New page here (folder) (tree 2)                                 | **MOTIR-7373**                             |
| _No pages here_ row with New page here; the pending _Creating page…_ row (tree 2, 3)                                                        | **MOTIR-7373**                             |
| Loading, error (with retry on the row), at-scale and read-only states (tree 5–8)                                                            | **MOTIR-7373**                             |
| Page menu's **Move to… · Move up · Move down** appended to the page row menu (tree 2)                                                       | **MOTIR-7374**                             |
| Folder row menu: the shared `FolderRowMenu` with the shipped folder commands after New page here (tree 2)                                   | **MOTIR-7374**                             |
| **New folder** in the header and the empty state; inline name field (tree 1, 2, 4)                                                          | **MOTIR-7374**                             |
| **Move to…** picker (`PagePlacementPicker`), disabled self, refusal slot and the four sentences (tree 9, 10)                                | **MOTIR-7374**                             |
| `usePageMove`: the placement call, `beforeId`/`afterId`, refreshing both levels, error → sentence mapping                                   | **MOTIR-7374**                             |
| Moving the five folder components to a shared `folders` directory under `components` (no visual change)                                     | **MOTIR-7374**                             |
| Folder delete counting pages, and the delete moving pages up (tree 12)                                                                      | **MOTIR-7371**                             |
| Drag handle, lifted row, origin slot, before/after line, inside tint, refused target + tooltip, root drop zone, snap-back + toast (tree 11) | **MOTIR-7376**                             |
| Sidebar column, its head, selected row, pre-expanded path (sidebar 1, 5)                                                                    | **MOTIR-7375**                             |
| Breadcrumb incl. middle truncation and "…" menu; removing "← Pages" (sidebar 1, 2)                                                          | **MOTIR-7375**                             |
| Collapse / show, the 1280px rule, the narrow overlay (sidebar 3)                                                                            | **MOTIR-7375**                             |
| `/pages?folder=<id>` opening the tree with that folder expanded and focused (sidebar 4)                                                     | **MOTIR-7375**                             |
| The level read, create-with-parent, move, the trail (no element; every panel reads them)                                                    | MOTIR-7370 (service) · MOTIR-7372 (routes) |

### Where each behaviour comes from

| Behaviour drawn                                                     | Source                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pages in `/pages`, not `/items`; shared folders                     | ADR AMENDMENT 1 (Yue, 2026-10-02)                                                           |
| Folders first, then pages, each by position                         | ADR §4 _Order within a level_ (as amended) · MOTIR-7370 `listTreeLevel`                     |
| 50 per read (max 100), keyset across both bands, lazy per level     | ADR §4 _Paging per level_ · MOTIR-7370                                                      |
| A page's parent is a page, a folder or the root — never a work item | ADR §4 · MOTIR-7370 (`PAGE_PARENT_NOT_ALLOWED`)                                             |
| The three refusals, their codes and statuses                        | ADR §4 · MOTIR-7368 (package `movePage`) · MOTIR-7372 (route mapping)                       |
| Depth limit of 10 levels of pages; folders do not count             | ADR §4 · `PAGE_DEPTH_LIMIT`                                                                 |
| Self and descendants disabled in Move to…                           | MOTIR-7374 acceptance                                                                       |
| Move up / down absent on the first / last sibling page              | MOTIR-7374 acceptance                                                                       |
| Folder delete moves its pages up; the dialog counts pages           | ADR §4 · MOTIR-7371                                                                         |
| No New, no menu, no drag without `page:edit`                        | ADR §5 · MOTIR-7373 / 7374 / 7376 acceptance                                                |
| Drop bands, refused-drop snap-back, no folder drag                  | MOTIR-7376 (bands and timing fixed here)                                                    |
| Breadcrumb folders + ancestor pages, root-first                     | ADR §4 (`ancestor_page_ids`, folder chain at render) · MOTIR-7370 `getPageTrail`            |
| Sidebar pre-expanded to the page, breadcrumb replaces "← Pages"     | MOTIR-7375 · base § The way back                                                            |
| No `loading.tsx`; in-page `<Suspense>` after the gate               | CLAUDE.md § A `loading.tsx` may NOT sit above a route that decides existence · base state 5 |
| Archive / delete of a page — not drawn                              | MOTIR-5755                                                                                  |

### Open questions handed to the cards

- **Folder Move up / Move down are drawn disabled, page Move up / Move down absent.** The folder menu is
  composed unchanged from `/items`, where the edge entries are disabled; MOTIR-7374's acceptance asks
  for page entries to be absent. Both are drawn as their sources say. If the two should agree, the
  smaller change is to make the page entries disabled too — MOTIR-7374's call, not the design's.
- **`/pages?folder=<id>`** is a new query parameter on `/pages`; MOTIR-7375 reads it (it already gives
  `PageTree` an `expandedPath`). A folder id that is not in the project is ignored, not a 404.
- **Hidden-sidebar preference** is per device (`localStorage`). A synced preference is not asked for.

### Not drawn here

- **`/items`** — unchanged by this story.
- **Archive, delete and restore of a page** — MOTIR-5755.
- **A combined tree of folders, pages and work items** — deferred by ADR AMENDMENT 1.
- **Page search** — the Move to… picker has none in this story.

## History (MOTIR-5754 · MOTIR-7381)

**Story MOTIR-5754 · design subtask MOTIR-7381.** Any reader of a page (`page:view`) opens its
**history**: the list of saved versions, each opened on its own beside the current page; an editor
(`page:edit`) restores one. This section **amends** § _The page — `/pages/<id>` (states 6–12)_ above,
drawn in `design/pages/page.mock.html`, by a new delta mock; the approved mock is not edited. It composes
with MOTIR-7367's approved design for the same route (§ _The page tree_, `page--tree-sidebar.mock.html`):
the sidebar tree and the breadcrumb are that design's, drawn here only as context and not redrawn.

| Amends                                                     | By                        | Panels |
| ---------------------------------------------------------- | ------------------------- | ------ |
| § The page — `/pages/<id>` (states 6–12), `page.mock.html` | `page--history.mock.html` | 1–14   |

**References.** Confluence Cloud's page history (a list of versions with author and date; a version opened
on its own; _Restore this version_ makes a copy that becomes current and keeps every earlier one) for the
model. Notion's page-history side panel for the layout: history opens **beside** the page, not on a
separate screen.

**What it rests on** (`docs/decisions/pages.md` §6): a version is a snapshot with a number, an author,
`saved_at` and an optional `restored_from_version_id`; saves by one author within 10 minutes fold into one
version; a page keeps **100** versions (writing the 101st deletes the oldest); **restore creates a new
version** and rewinds nothing. Reading versions needs `page:view`; restoring needs `page:edit`.

### Conventions

The base design's (§ _Conventions both assets follow_): `--el-*` colour only, the element shape tokens,
the Tier-3 layer declared on every `[data-theme]` scope, every state in light and dark, zh on the dark board
of panels 1–6 and 8–14, and **page content never translated**. Every secondary line is
`--el-text-secondary`; `--el-text-muted` and `--el-text-faint` are not used anywhere in the asset.

### The access path — History in the title row (state 1)

- **Where:** the trailing end of the page's **title row**. The breadcrumb (MOTIR-7367) stays above the
  title; the title keeps the row's leading edge and its `font-serif text-2xl` 32px line box; **History**
  is top-aligned to that line box, so the row's height does not change.
- **What:** `Button variant="secondary" size="sm"` with the lucide **`History`** glyph and a visible label
  _History_. A visible label rather than an icon button, because the glyph alone reads as "recent" or
  "undo" and this is the only door to a feature a viewer has never seen.
- **Why the title row, not the toolbar:** the toolbar is a writer's (it is not rendered for a viewer, base
  state 10). History is every reader's, so it sits where a viewer and a writer both have something: the
  title row. A viewer gets the same control in the same place (state 14).
- **Open:** `aria-expanded="true"`, `aria-controls="page-history"`, and the pressed look —
  `--el-surface` fill, `--el-border-strong` border — while the panel is open. Pressing it again closes
  the panel.
- **The rail and the tree:** unchanged. The rail's Pages row stays active; the tree's selected row stays
  this page.

### The panel — where it opens, how it closes (states 2–6)

- **Wide, ≥ 1440px:** a right-hand column **beside** the page — rail · page tree (248px) · page · history
  (**340px**). It pushes the reading column instead of covering it, so the page stays readable while the
  list is open. `<aside id="page-history" aria-labelledby>`, `--el-page-bg`, a left rule in
  `--el-border`.
- **1280–1439px:** the same column; the **page tree sidebar hides while History is open** and returns
  when it closes. This does **not** write the reader's stored hide/show preference (MOTIR-7367's
  `localStorage` convenience) — it is a layout yield, not a choice.
- **Below 1280px** (where MOTIR-7367 already starts the tree hidden): History opens as an **overlay sheet
  from the right**, 340px, over `--el-overlay-scrim`, with `--shadow-modal` — the mirror of the tree's
  narrow drawer (panel 4, third board). Focus moves into the sheet and is returned to the History control
  on close.
- **Closes by:** the close button (`X` icon button, _Close history_), **Esc** (when no confirm is open; a
  first Esc inside compare closes compare, the next closes the panel), pressing **History** again, the
  scrim (narrow only), and **navigating away** — to another page through the tree or the breadcrumb, or
  anywhere else. The panel does not persist across pages: a page opens with history closed.
- **Head:** the `History` glyph 16px in `--el-text-secondary` + _History_, 14px semibold `--el-text`; the
  close button at its end. A 1px `--el-border` rule under it.

### A version row

One `<button aria-pressed>` per version in an `<ol aria-label="Versions of this page">`, newest first, 8px
list padding, 2px gaps. Padding `--spacing-control-y` / `--spacing-control-x`, `--radius-control`:

1. **Avatar** — 24px circle (`rounded-full`, genuinely circular), the author's initials, 10px bold
   `--el-text-strong` on one of `--el-avatar-lavender` / `-sky` / `-mint` (picked by the user id, the same
   person always the same tint). `aria-hidden`; the name beside it carries the meaning.
2. **Version** — `v{number}`, 13.5px semibold `--el-text`, tabular numerals; its accessible name is
   _Version {number}_.
3. **Current** — on the newest row only: a `Pill`-shaped chip, `--el-tint-lavender` fill,
   `--el-text-strong` ink, `--radius-badge`, `--spacing-chip-x/y`, 11.5px. The row also carries
   `aria-current="true"`. It is never compared and never restored; pressing it closes compare and returns
   to the page.
4. **Time** — at the trailing end of the first line, 12.5px `--el-text-secondary`, a `<time datetime>`
   of `saved_at` with the full timestamp in `title`. **Under 24 hours: relative** (`Intl.RelativeTimeFormat`
   in the active locale: _12 minutes ago_ / _12 分钟前_, _just now_ / _刚刚_ under a minute). **24 hours
   and older: absolute** (`Intl.DateTimeFormat`, medium date + short time: _28 Sep 2026, 11:05_ /
   _2026年9月28日 11:05_). The same formatter the index's _Edited {time}_ uses; no message key.
5. **Author** — the display name on the second line, 13px `--el-text-secondary`; _You_ / _你_ when the
   author is the reader.
6. **Restore line** (restore rows only) — `RotateCcw` 12px + _Restored from v{n}_, 12.5px
   `--el-text-secondary`. When v{n} has been pruned by the 100-version cap, _(no longer kept)_ follows in
   italic — the line still says what happened; it just cannot link to it (panel 5, v71; panel 12, v5).

| Row state | Treatment                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------- |
| resting   | transparent                                                                                    |
| hover     | `--el-surface-soft` (every ink on it is `--el-text` / `--el-text-secondary`, AA)               |
| selected  | `--el-surface` + 1px `--el-border`, `aria-pressed="true"` — the version shown in compare       |
| new       | `--el-tint-mint` for the moment after a restore (state 10), then resting; reduced motion: none |
| focus     | the app's `--focus-ring-color` ring                                                            |

### Loading, one version, Load more, failed (states 2, 3, 5, 6)

- **2 · Loading.** The panel's head paints at once; the list is **six skeleton rows** — a 24px circle and
  two bars (70% / 45%), `--el-muted`, `--radius-control` — `aria-hidden`, with one polite
  _Loading history_ in a `role="status"`. The History control is already pressed.
- **3 · One version.** A page that has only been created: one row, **v1**, **Current**, and a line under
  the list (12.5px `--el-text-secondary`): _This is the only version so far. Each editing session adds
  one._ No Restore exists anywhere — there is nothing to restore to.
- **5 · At the page size.** The service pages versions **50 at a time** (`PAGE_LEVEL_PAGE_SIZE`, the same
  keyset-cursor read as the tree). When there are more, the list ends in **Load more** — `Button
variant="secondary" size="sm"`, full width — which appends the next 50 in place and keeps the
  selection; while it reads, the button shows the spinner. The foot also says _A page keeps its latest
  100 versions._, so a reader looking for something older knows why it is not there. With the 100 cap,
  Load more appears at most once.
- **6 · Load failed.** In place of the list: one inline row, `role="alert"` — `TriangleAlert` 16px in
  `--el-danger-on-surface`, _Couldn't load the history._ in `--el-text`, and **Try again** (secondary, sm).
  The page is untouched. A failed **Load more** puts the same row at the list foot and keeps the rows
  already shown.

### A version shown — before and after (state 7)

Pressing a row that is not Current opens **compare**:

- **The main column splits in two**, under the breadcrumb and title row: the **current page** on the
  left (where it already was — the reader's eye does not have to move to find it) and the **selected
  version** on the right, next to the panel. `role="region"`, _Comparing v{n} with the current page_.
  Each is a card frame (`--el-border`, `--radius-card`); the version's sits on **`--el-surface-soft`** so it
  never reads as the page.
- **Both are read-only**, rendered by the same `.motir-prose` rules as the page (base § _The body_), from
  the version's stored `body_state`. **No character diff** — two documents side by side, as the card asks.
  While compare is open the writer's editor is not mounted; closing compare returns to the editor with
  the caret where it was.
- **The page tree sidebar hides** while compare is open (MOTIR-7367's _Show page tree_ button leads the
  breadcrumb, panel 3 of that mock) and returns when compare closes; the stored preference is not
  written.
- **Current column head:** _Current page_ (13.5px semibold `--el-text`) · _v7_ (`--el-text-secondary`) ·
  for a writer, the **save indicator** (base state 8's chip, unchanged) at its end, because a save can
  still be in flight (state 13).
- **Version column head:** _v{n}_ · avatar + author · time · **Restore this version** (`Button
variant="secondary" size="sm"`, `RotateCcw`) — **editors only, never on the Current row** · a close
  icon button (_Close v{n}_).
- **Closes by:** the close button, **Esc**, pressing the selected row again, or pressing the Current row.
- **Viewer:** the same compare with **no Restore** and no save indicator. Nothing is drawn disabled.

### Restore (states 8–13)

- **8 · Confirm.** `Modal` size sm, `role="alertdialog"`, initial focus on **Cancel**. Title _Restore
  v3?_ (`font-serif text-xl`, `--el-text`); body _The page will show v3's content as a new version.
  Nothing is deleted._ (`--el-text-subtitle`); footer **Cancel** (secondary) and **Restore v3**
  (primary, `RotateCcw`). Esc / Cancel / × close it and nothing changes.
- **9 · Restoring.** The confirm stays open: **Restore v3** shows the spinner and _Restoring…_
  (`aria-busy`), Cancel and × are disabled — a restore cannot be abandoned half way. Behind it the panel is
  **`inert` + `aria-busy`**, with a 2px `--el-accent` indeterminate bar under its head: no row can be
  pressed while the request is in flight. Nothing is dimmed (dimming would lower the inks' contrast).
- **10 · Restored.** The modal and compare close. The page shows **v3's content**, now the body of the new
  version, in the editor (the save indicator reads _Saved_; a client holding newer state merges, ADR §6).
  The panel stays open with the **new row on top** — v8, the restorer, _just now_, **Current**,
  _Restored from v3_, briefly `--el-tint-mint` — and v7 loses its Current chip; **every earlier version is
  still listed**. A success `Toast` (border `--el-success`, `CircleCheck` in `--el-success`, title in
  `--el-text`): _Restored v3 as v8._ The tree sidebar returns.
- **11 · Refused, too large — `413 PAGE_BODY_TOO_LARGE`.** Restoring would take the page past its 2 MB
  limit (`PAGE_BODY_MAX_BYTES`, shown as **2 MB**, as in base state 9). The confirm closes and a **danger
  callout** opens under the version column's head, `role="alert"`: `--el-danger-surface` fill, 1px
  `--el-danger` border, `TriangleAlert` in `--el-danger-on-surface`, text in `--el-danger-surface-text`,
  `--radius-card`. It says what happened and that **nothing was changed**. Restore for that version is
  then disabled and described by the callout (it would fail the same way). No new row; v7 is still Current.
- **12 · Refused, the version is gone — `404 PAGE_VERSION_NOT_FOUND`.** The version was pruned between
  listing and restoring. The confirm and compare close (there is nothing left to show); the page is
  untouched; the panel **re-reads its list** and shows the same danger callout above it: the version is no
  longer kept, a page keeps its latest 100, nothing was changed, the list was refreshed. In the refreshed
  list the pruned rows are gone (pruning takes the oldest first, so in practice this happens only at the
  100-version cap, when other saves push the oldest out while the confirm is open) and any row restored
  from one now reads _(no longer kept)_.
- **13 · Unsaved edits — Restore held.** While the writer's save indicator is anything but **Saved**
  (`saving`, `offline`, `too_large` — `packages/pages/src/editor/SaveIndicator.tsx`'s `SaveStatus`),
  **Restore this version** is disabled and a line under the version's head (12.5px
  `--el-text-secondary`, `TriangleAlert` 14px, `aria-describedby` of the button) says why and when it
  returns: _Restore is held until your edits are saved. It becomes available as soon as the page says
  Saved._ It enables itself the moment the status is `saved`. A restore over a pending save would race
  it — the pending batch would land on top of the restored content. `too_large` never returns to `saved`
  without a reload, so Restore stays held there; base state 9's callout already tells the writer to
  reload.

### State 14 — viewer

`page:view` without `page:edit`: the title is the plain `<h1>`, there is no toolbar and no save indicator,
and **History** is the same control in the same place. The list is identical (the viewer's own versions,
if any, would read _You_). A version opened shows the same compare **with no Restore** (state 7, second
board). Nothing is drawn disabled for a viewer — a disabled control is a promise the product then refuses.

### Colour and shape — per element

| Element                 | Primitive / source                     | Colour                                                                                                          | Shape                                                                    |
| ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| History control         | `Button` secondary sm + `History` 16px | `--el-text`, border `--el-button-border`; open: `--el-surface` fill, `--el-border-strong`                       | `--radius-btn`, `--height-btn-sm`, `--spacing-btn-x-sm`                  |
| Panel                   | `<aside>`                              | `--el-page-bg`, left rule `--el-border`                                                                         | 340px                                                                    |
| Panel head              | heading + icon button                  | title `--el-text`, glyph `--el-text-secondary`; close `--el-text-secondary`, hover `--el-surface` / `--el-text` | close `--height-btn-sm` square, `--radius-control`, `--spacing-icon-btn` |
| Narrow sheet            | the same `<aside>` over the scrim      | `--el-overlay-scrim`                                                                                            | `--shadow-modal`                                                         |
| Version row             | `<button aria-pressed>`                | `--el-text` / `--el-text-secondary`; hover `--el-surface-soft`; selected `--el-surface` + `--el-border`         | `--radius-control`, `--spacing-control-x/y`                              |
| Avatar                  | initials circle                        | `--el-avatar-lavender/-sky/-mint`, ink `--el-text-strong`                                                       | 24px, `rounded-full`                                                     |
| Current chip            | `Pill` shape                           | `--el-tint-lavender`, ink `--el-text-strong`                                                                    | `--radius-badge`, `--spacing-chip-x/y`                                   |
| Restore line            | `RotateCcw` 12px + text                | `--el-text-secondary`                                                                                           | —                                                                        |
| New row (after restore) | the row                                | `--el-tint-mint`                                                                                                | as the row                                                               |
| Skeleton                | `PageSkeleton`'s `Block`               | `--el-muted`                                                                                                    | `--radius-control`; avatar block `rounded-full`                          |
| Load failed             | inline `ErrorState` grammar            | glyph `--el-danger-on-surface`, text `--el-text`; Try again secondary                                           | `--radius-btn`, `--height-btn-sm`                                        |
| Load more               | `Button` secondary sm, full width      | `--el-text`, `--el-button-border`                                                                               | `--radius-btn`, `--height-btn-sm`                                        |
| Busy bar                | 2px bar under the head                 | `--el-accent`                                                                                                   | —                                                                        |
| Compare columns         | card frames                            | current `--el-page-bg`; version `--el-surface-soft`; both `--el-border`                                         | `--radius-card`                                                          |
| Restore this version    | `Button` secondary sm + `RotateCcw`    | `--el-text`, `--el-button-border`; disabled at 50% opacity (the primitive's)                                    | `--radius-btn`, `--height-btn-sm`                                        |
| Hold line               | text + `TriangleAlert` 14px            | `--el-text-secondary` on `--el-surface-soft`                                                                    | —                                                                        |
| Confirm                 | `Modal` sm, `alertdialog`              | `--el-page-bg`, `--el-border`; title `--el-text`, body `--el-text-subtitle`; scrim `--el-overlay-scrim`         | `--radius-modal`, `--shadow-modal`, `--spacing-card-padding`             |
| Restore vN (confirm)    | `Button` primary                       | `--el-accent` / `--el-accent-text`                                                                              | `--radius-btn`, `--height-btn-md`                                        |
| Refusal callout         | base state 9's callout                 | `--el-danger-surface`, border `--el-danger`, glyph `--el-danger-on-surface`, text `--el-danger-surface-text`    | `--radius-card`                                                          |
| Toast                   | `Toast` success                        | `--el-page-bg`, border `--el-success`, glyph `--el-success`, title `--el-text`                                  | `--radius-card`, `--shadow-elevated`                                     |

`--el-danger-text` is not used (no danger fill exists on this surface). The board annotations
(`.ph-panelNote`, `.ph-boardTag`) are `--el-text-secondary` on `--el-surface`.

### Copy — history

New keys live under `pages.history.*`. ICU arguments as in the shipped catalogue (`{number}`, `{from}`).

| Key                              | en                                                                                                                        | zh                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pages.history.open`             | History                                                                                                                   | 历史记录                                                                      |
| `pages.history.title`            | History                                                                                                                   | 历史记录                                                                      |
| `pages.history.close`            | Close history                                                                                                             | 关闭历史记录                                                                  |
| `pages.history.listLabel`        | Versions of this page                                                                                                     | 此页面的版本                                                                  |
| `pages.history.version`          | v{number}                                                                                                                 | v{number}                                                                     |
| `pages.history.versionLabel`     | Version {number}                                                                                                          | 第 {number} 版                                                                |
| `pages.history.current`          | Current                                                                                                                   | 当前                                                                          |
| `pages.history.you`              | You                                                                                                                       | 你                                                                            |
| `pages.history.restoredFrom`     | Restored from v{number}                                                                                                   | 从 v{number} 恢复                                                             |
| `pages.history.noLongerKept`     | (no longer kept)                                                                                                          | （已不再保留）                                                                |
| `pages.history.loading`          | Loading history                                                                                                           | 正在加载历史记录                                                              |
| `pages.history.loadFailed`       | Couldn’t load the history.                                                                                                | 无法加载历史记录。                                                            |
| `pages.history.retry`            | Try again                                                                                                                 | 重试                                                                          |
| `pages.history.loadMore`         | Load more                                                                                                                 | 加载更多                                                                      |
| `pages.history.keepsLatest`      | A page keeps its latest 100 versions.                                                                                     | 页面保留最近的 100 个版本。                                                   |
| `pages.history.onlyVersion`      | This is the only version so far. Each editing session adds one.                                                           | 这是目前唯一的版本。每次编辑会话都会新增一个版本。                            |
| `pages.history.compare.label`    | Comparing v{number} with the current page                                                                                 | 正在将 v{number} 与当前页面对比                                               |
| `pages.history.compare.current`  | Current page                                                                                                              | 当前页面                                                                      |
| `pages.history.compare.close`    | Close v{number}                                                                                                           | 关闭 v{number}                                                                |
| `pages.history.restore`          | Restore this version                                                                                                      | 恢复此版本                                                                    |
| `pages.history.confirm.title`    | Restore v{number}?                                                                                                        | 恢复 v{number}？                                                              |
| `pages.history.confirm.body`     | The page will show v{number}’s content as a new version. Nothing is deleted.                                              | 页面将以新版本的形式显示 v{number} 的内容。不会删除任何内容。                 |
| `pages.history.confirm.action`   | Restore v{number}                                                                                                         | 恢复 v{number}                                                                |
| `pages.history.restoring`        | Restoring…                                                                                                                | 正在恢复…                                                                     |
| `pages.history.restored`         | Restored v{from} as v{number}.                                                                                            | 已将 v{from} 恢复为 v{number}。                                               |
| `pages.history.refusal.tooLarge` | v{number} can’t be restored: the page would pass its 2 MB limit. Nothing was changed.                                     | 无法恢复 v{number}：页面将超过 2 MB 的上限。未做任何更改。                    |
| `pages.history.refusal.gone`     | v{number} is no longer kept — a page keeps its latest 100 versions. Nothing was changed, and the list has been refreshed. | v{number} 已不再保留——页面只保留最近的 100 个版本。未做任何更改，列表已刷新。 |
| `pages.history.unsavedHold`      | Restore is held until your edits are saved. It becomes available as soon as the page says Saved.                          | 在你的编辑保存之前无法恢复。页面显示“已保存”后即可恢复。                      |
| `common.cancel` (exists)         | Cancel                                                                                                                    | 取消                                                                          |
| `common.close` (exists)          | Close                                                                                                                     | 关闭                                                                          |
| `pages.editor.status.*` (exists) | Saved · Saving… · Offline — edits kept · Not saved                                                                        | 已保存 · 正在保存… · 离线——编辑已保留 · 未保存                                |

- **Times carry no key**: relative under 24 hours through `Intl.RelativeTimeFormat`, absolute after
  through `Intl.DateTimeFormat`, both in the active locale (§ _A version row_, item 4).
- `pages.history.unsavedHold` names **Saved** because that is the word the writer's indicator shows
  (`pages.editor.status.saved`); the zh string quotes 已保存 for the same reason. If the indicator's word
  changes, this string changes with it.
- `pages.history.retry` carries the same words as `common.retry`; a builder may reuse `common.retry`
  instead of adding the key — the words are what is specified.
- `{number}` in `pages.history.refusal.*` is the version the reader tried to restore; the 2 MB and 100 are
  written into the copy, as base state 9 writes 2 MB (`PAGE_BODY_MAX_BYTES`, `PAGE_VERSION_CAP`).

### Open questions handed to the cards

- **Esc order.** Drawn as: confirm → compare → panel, one layer per press. If the shell already binds Esc
  for something on this route, that binding wins and this order follows it.
- **The new-row tint** fades after a moment; the duration is the builder's (the toast's own lifetime is a
  fair default), and under `prefers-reduced-motion` the tint simply is not applied.
- **Restoring an agent's version.** An agent's markdown write is a save by the token's user (ADR §6), so
  its row shows that user; nothing marks it as an agent's. If agent authorship should be visible here,
  that is a model change, not a design one.

### Not drawn here

- **A character or block diff** between versions — out of scope by the card; compare is side by side.
- **Naming or pinning a version**, and **deleting a single version** — neither exists in the model.
- **History of an archived page** — MOTIR-5755 (archive and restore of a page).
- **The page tree sidebar and breadcrumb** — MOTIR-7367's, unchanged; drawn only as context.
- **Co-editing while comparing** — MOTIR-5750.

## Embed a work item (MOTIR-7566 · MOTIR-9179)

Delta mock: [`page--work-item-embed.mock.html`](./page--work-item-embed.mock.html), thirteen panels, light and
dark on each state, zh on panel 13. It amends the page body drawn in `page.mock.html` and composes with the
comparison column of `page--history.mock.html`; neither is edited. Colour is `--el-*` only and shape is the
element shape tokens; the mock declares the Tier-3 block on every `[data-theme]` scope.

A work item embedded in a page is a **block**, the mention's block twin. It stores the item's id and its key
at insertion and nothing else (MOTIR-9180): the five facts below are read live, per reader, so a card never
shows a fact the reader may not see and never goes stale.

### The card

| Element          | Spec                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frame            | Block in the prose column, `--radius-card`, `--spacing-card-padding-12` × `-16`, `--el-card` fill, 1px `--el-border`, no shadow, 12px block rhythm like an image or table.                              |
| Meta line        | Type glyph (omitted when the type is null, no placeholder), key in mono `--el-text-identifier`, status `Pill`, assignee avatar and name at the trailing end.                                            |
| Type glyph       | `--el-type-<kind>` hue, `role="img"`, name `pages.embed.typeLabel`.                                                                                                                                     |
| Status           | The workflow status label, tone by category: `todo` lavender, `in_progress` sky, `done` mint, no category neutral. No status draws `pages.embed.noStatus` as a dashed chip so the slot keeps its width. |
| Assignee         | Avatar (`--el-avatar-*`) and the person's name. None draws a dashed ring and `pages.embed.unassigned`.                                                                                                  |
| Title            | `--el-text-strong`, 15px/600, two-line clamp with the full title in `title`. It is the only part that truncates.                                                                                        |
| Narrow (< 640px) | The assignee wraps to its own line under the title; nothing else truncates.                                                                                                                             |

### States

- **Edit, resting**: not a link (a link that follows a click in an editable document fights the caret).
  `contenteditable="false"`, `role="group"`, name `pages.embed.cardLabel`.
- **Edit, hover / selected**: a control cluster at the trailing top edge, Open and the ⋯ menu, both
  `--height-control-32` icon buttons. Selected adds the shipped focus ring (`--focus-ring-color`) and pins the
  cluster visible. The ⋯ menu holds _Show as inline mention_, a rule, then _Remove card_ in
  `--el-danger-on-surface` (never `--el-danger-text`). Backspace and Delete also remove it.
- **Read**: the whole card is ONE `<a>` whose name is its own content (key, title, type gloss, status word,
  assignee). No interactive descendant, so a link never nests in a link. Hover: `--el-surface-soft` fill and an
  underlined title.
- **Unavailable**: a deleted item, an item the reader may not browse and an id with no entry draw the same
  card, dashed border, warning glyph (`--el-warning-text`) and `pages.embed.unavailable`, with
  `pages.embed.unavailableTitle` as its tooltip. No key, title, type, status or assignee, and not a link in
  read. This is the rule `WorkItemChipView` already records. An item of another project the reader can browse
  renders live.
- **Archived but readable**: all five facts in an `--el-surface-soft` frame with a neutral _Archived_ pill; it
  still links.
- **Just inserted**: drawn from the picked row and identical to resting.
- **Placement**: anywhere a block can sit (list item, table cell). Not in a code block.
- **Viewer** (read-only page): the read card, no toolbar, cluster, menu or convert affordance.
- **History comparison**: the read card, live facts under the reader's access, never the facts as saved.

### Toolbar and picker

- The toolbar gains a text button, _Embed work item_ (`pages.editor.toolbar.embedWorkItem`), in the shipped
  `TEXT_BUTTON` grammar, straight after the shipped Work item control, which is unchanged. It opens the
  picker in **card** mode, is disabled inside a code block with `pages.editor.toolbar.embedWorkItemInCode` as
  its title, and shows the focus ring on keyboard focus.
- The picker gains an **insert-as band** at its foot: _Insert as_ with a two-segment control (Inline mention |
  Card) and `pages.embed.insertHint`. `@` opens it in mention mode (unchanged), the toolbar opens it in card
  mode. A segment switches by mousedown, and Tab switches while the picker is open, so focus never leaves the
  editor. Enter on a row inserts in the chosen form. Rows and the picker's error, empty and loading states are
  the shipped ones.

### Chip ↔ card

- **Chip → card**: the package wrapper adds one icon button (`pages.embed.toCard`) beside the live chip on
  hover and selection, never inside it; Mod-Enter does the same. One transaction splits the chip's paragraph
  around the card, selects it, and one undo returns the chip.
- **Card → chip**: the card's ⋯ menu (_Show as inline mention_), one transaction, one undo.

### Copy (new keys; page content is never translated)

| Key                                        | en                                               | zh                             |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------ |
| `pages.embed.unavailable`                  | Work item unavailable                            | 工作项不可用                   |
| `pages.embed.unavailableTitle`             | This work item was deleted, or you can’t view it | 该工作项已被删除，或你无权查看 |
| `pages.embed.noStatus`                     | No status                                        | 无状态                         |
| `pages.embed.unassigned`                   | Unassigned                                       | 未分配                         |
| `pages.embed.archived`                     | Archived                                         | 已归档                         |
| `pages.embed.typeLabel`                    | Type: {type}                                     | 类型：{type}                   |
| `pages.embed.cardLabel`                    | Work item {key}                                  | 工作项 {key}                   |
| `pages.embed.open`                         | Open work item                                   | 打开工作项                     |
| `pages.embed.menu`                         | Card options                                     | 卡片选项                       |
| `pages.embed.toMention`                    | Show as inline mention                           | 显示为行内提及                 |
| `pages.embed.toCard`                       | Show as card                                     | 显示为卡片                     |
| `pages.embed.remove`                       | Remove card                                      | 移除卡片                       |
| `pages.embed.insertAs`                     | Insert as                                        | 插入为                         |
| `pages.embed.insertMention`                | Inline mention                                   | 行内提及                       |
| `pages.embed.insertCard`                   | Card                                             | 卡片                           |
| `pages.embed.insertHint`                   | Tab to switch · Enter to insert                  | 按 Tab 切换 · 按 Enter 插入    |
| `pages.editor.toolbar.embedWorkItem`       | Embed work item                                  | 嵌入工作项                     |
| `pages.editor.toolbar.embedWorkItemTip`    | Embed a work item as a card                      | 将工作项嵌入为卡片             |
| `pages.editor.toolbar.embedWorkItemInCode` | A card can’t go in a code block                  | 代码块中不能放置卡片           |

### Open questions handed to the cards

- The chip has no design asset of record, so panel 9 draws its hover and selected states; the builder keeps
  the shipped chip unchanged and adds only the wrapper control.
- Whether the mention-search result carries `type` and `assignee` is MOTIR-9181's (done); the picker rows
  draw them as context.

### Not drawn here

- Editing the work item from the card, a size or width variant, or a card for anything but a work item.
- The picker's error, empty and loading states (shipped).

## The page's Linked work items strip (MOTIR-7567 · hand links)

**Story MOTIR-7567 · design subtask MOTIR-9196.** A DELTA of `page.mock.html` states 6–12 (the page at its
own address, drawn by `PageView.tsx`): the **Linked work items** strip between the title row and the
editor — the work items linked to this page **by hand**, as the product's live work-item chips, with **Link
work item**, **Unlink** on each row, **Show more** when the read served a cursor, and — when there is
nothing to show and nobody to show it to — no strip at all. `page--linked-work-items.mock.html`, panels
1–12, each in light and dark.

The other end of the same link — the work item's **Pages** section — is the Pages-section design's
(MOTIR-9195, `design/work-items/design-notes.md`); this asset neither draws it nor allocates anything
inside it. The chip's spec of record would be `page--work-item-mention.mock.html`, which
`workItemMention.tsx` and `WorkItemPicker.tsx` cite and which does not resolve on `main`; the chip is
therefore drawn from those two components and `WorkItemRefChip.tsx` themselves, and **if that mock lands it
governs and this asset is corrected against it**.

### Panel table

| Panel | Frame                                        |
| ----- | -------------------------------------------- |
| 1     | Populated, a reader who may link             |
| 2     | Populated, a Viewer                          |
| 3     | Empty, a reader who may link                 |
| 4     | Hidden                                       |
| 5     | Loading, the linkable reader                 |
| 6     | First read failed                            |
| 7     | The row: live, archived, unavailable         |
| 8     | At the page size: Show more, pending, failed |
| 9     | The picker in six boards                     |
| 10    | Linking in flight, and the three refusals    |
| 11    | Unlink busy, unlinked, failed                |
| 12    | ~390px, the picker at 390px, compare mode    |

### Decisions

- **D1 — the strip is a bare band**, no card frame and no border, between the title row and the editor's
  `mt-3` slot. It touches neither the title row's controls nor the page menu.
- **D2 — one rule chooses among panels 1–4:** paint iff the page is live AND (the read served rows OR this
  reader may link). A loading frame is drawn only for a reader the capability says may link, and an
  archived page mounts no strip and issues no read (the story hides a page's hand links on both sides until
  it is restored).
- **D3 — the capability is its own value.** `PageView`'s `canEdit` is the page's own edit right and gates
  the title, the page menu and version restore, so it cannot answer for these controls. The route resolves
  `work_item:edit` from `ProjectPageContext.permissions()` before the first paint, so the frame can be
  drawn on it. Which key the write asserts is the write path's; this asset only renders it.
- **D4 — no control while loading.** A control must not appear over a list that has not answered, and a
  reader who may not link gets no frame at all (a promise the product would then withdraw).
- **D5 — an unanswered read never renders as _no links_** and never draws the control (panel 6).
- **D6 — three renderings of four data states** (panel 7). Live, archived (the shipped `is-archived` chip,
  still navigable — a hand link can predate the archive, so it is never drawn as unavailable), and
  Unavailable for both `accessible: false` and `summary: null`: chip-shaped, non-interactive, no key, no
  title, no status, keeping its Unlink. The strip cannot use the chip's bare-key fallback: that exists for
  a body token, where the author typed the key, and this row's only data is an id.
- **D7 — the strip never re-sorts.** Newest hand link first, the read's order, so a row that just arrived
  settles where it already is.
- **D8 — paging.** Fifty per read, capped at 100 (`levelPageSize`, behind
  `lib/pages/workItemPagesCursor.ts`). Show more appends in place and keeps scroll position and focus; no
  count line, since a keyset read knows no total; no hand-made row is ever truncated off the list. A failed
  page retries exactly the cursor that failed, never the first page.
- **D9 — the picker is its own popover over the project-scoped search** (`?q=&projectId=`, an eight-row
  window, the minimum-length floor and a 250 ms settle). **No candidate carries an already-linked mark:**
  the strip's rows are keyset-paged and a first page's knowledge would be a half-truth, so the write's
  refusal answers.
- **D10 — a window, not a total.** Exactly eight rows back shows one quiet line, _More work items match —
  keep typing to narrow._ — the search has no cursor, so the picker says it is a window.
- **D11 — a search failure is never the no-results line**, and offers one active option, Try again, so
  Enter retries without leaving the keyboard.
- **D12 — one press, no confirm, no toast.** Removing a hand link changes nothing but this list and is one
  click to remake; the row's arrival and its removal are the feedback, announced once through the polite
  live region.
- **D13 — already-linked is informational.** The pair was linked after this strip's read, from the work
  item's side or another tab: no second row appears and the existing one stays single.
- **D14 — compare mode.** Links belong to the page, not to a version: the strip spans the full content
  width **above** the two compare columns and is never duplicated inside either.

### Per-element colour and shape

| Element          | Primitive                                              | Colour and shape                                                                                                         |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Strip            | a bare band on the page canvas                         | spacing only                                                                                                             |
| Label            | 12.5px semibold                                        | `--el-text-secondary`                                                                                                    |
| Chip             | the shipped `.wi-chip`, `max-w-full`, title truncating | its own classes; `is-archived` and `is-noaccess` reused; 6px gaps                                                        |
| Unlink           | icon button OUTSIDE the chip's anchor                  | `--el-text-secondary`, hover `--el-danger-on-surface`; `--height-control` square, `--radius-control`                     |
| Link work item   | `Button` secondary sm + `Plus`                         | `--el-button-border`, `--el-text`; `--radius-btn`, `--height-btn-sm`                                                     |
| Skeleton bars    | two chip-shaped blocks, `aria-hidden`                  | `--el-muted`, `--radius-badge`                                                                                           |
| Inline alert row | `TriangleAlert` + sentence + action                    | glyph `--el-danger-on-surface`, text `--el-text`, action `--el-link`                                                     |
| Already linked   | informational line                                     | `--el-tint-sky` with `--el-text-strong`                                                                                  |
| Picker panel     | the `@` popover surface                                | `--el-page-bg`, `--el-border`, `--radius-card`, `--shadow-elevated`, max 22rem, capped to the viewport minus the gutters |
| Picker row       | type icon · mono key · title                           | `--el-text`; active `--el-surface`, `--radius-control`                                                                   |

**Ink.** Every secondary line is `--el-text-secondary`; `--el-text-faint` is not used; `--el-text-muted` is
the picker field's placeholder only. The shipped archived chip's own ink is `--el-text-faint`, which clears
AA on no surface (2.37–2.61:1); this asset draws the archived and unavailable chips in `--el-text-secondary`
and the build card should carry that correction, since the chip is its to restyle.

### Copy

Indicative key names under the build card's group; the words are this asset's and a value that differs is
drift to correct.

| Key                | en                                               | zh                                   |
| ------------------ | ------------------------------------------------ | ------------------------------------ |
| `title`            | Linked work items                                | 关联的工作项                         |
| `listAria`         | Work items linked by hand                        | 手动关联的工作项                     |
| `link`             | Link work item                                   | 关联工作项                           |
| `unlinkAria`       | Unlink {key}                                     | 取消关联 {key}                       |
| `empty`            | No work items linked by hand yet.                | 还没有手动关联的工作项。             |
| `loading`          | Loading linked work items…                       | 正在加载关联的工作项…                |
| `readFailed`       | Couldn’t load linked work items.                 | 无法加载关联的工作项。               |
| `showMore`         | Show more                                        | 显示更多                             |
| `loadMoreFailed`   | Couldn’t load the rest of the linked work items. | 无法加载其余的关联工作项。           |
| `unavailable`      | Unavailable                                      | 不可用                               |
| `unavailableTitle` | This work item isn’t available to you.           | 此工作项对你不可用。                 |
| `pickerLabel`      | Work items in this project                       | 此项目中的工作项                     |
| `typeToSearch`     | Type at least {min} characters to search.        | 至少输入 {min} 个字符开始搜索。      |
| `searching`        | Searching…                                       | 正在搜索…                            |
| `noResults`        | No work items match.                             | 没有匹配的工作项。                   |
| `moreMatch`        | More work items match — keep typing to narrow.   | 还有更多匹配项——继续输入可缩小范围。 |
| `searchFailed`     | Couldn’t search work items.                      | 无法搜索工作项。                     |
| `alreadyLinked`    | That work item is already linked to this page.   | 该工作项已与此页面关联。             |
| `writeFailed`      | Couldn’t link that work item. Try again.         | 无法关联该工作项，请重试。           |
| `refused`          | You can’t change this page’s links.              | 你无法更改此页面的关联。             |
| `gone`             | That work item no longer exists.                 | 该工作项已不存在。                   |
| `unlinkFailed`     | Couldn’t unlink that work item. Try again.       | 无法取消关联该工作项，请重试。       |

- **Reused, by key only:** Try again is `common.retry`; the word for a hand-made link, where the strip
  needs it, is `issueViews.pagesSourceManual`'s. Their values are read from the catalogue, never retyped.
- `{min}` is the picker's minimum query length, interpolated so it cannot drift from the search it
  describes. `{key}` is the identifier, never the title — a title can be long and can change between the
  read and the answer. The strip raises no toast, so no toast strings exist.

### Obligations handed to the cards

**To the strip's build card (MOTIR-9200):**

- mount the strip between the title row and the editor slot in `PageView`, and only for a live page;
- take the link capability as its own prop, resolved in `page.tsx` from `ProjectPageContext.permissions()`
  — **not** `PageView`'s `canEdit` — so the frame can paint before the read settles;
- draw rows in the shipped `wi-chip` classes and their `is-archived` / `is-noaccess` variants, with
  **Unlink** outside the chip's anchor and the same Unavailable drawing for both `accessible: false` and
  `summary: null`;
- build the picker as a popover with its own field over
  `GET /api/work-items/mention-search?q=&projectId=<this page's project>`, with the two-character floor and
  the 250 ms settle, and **do not mount `packages/pages/src/editor/WorkItemPicker.tsx`** — it is the `@`
  suggestion's listbox, takes its query as a prop and receives its keys from Tiptap, so it cannot live
  outside the editor;
- export or move the route's eight-row window beside the client fetcher so the full-window line can be
  drawn;
- page at fifty with **Show more** and the read's cursor, and write the `en` + `zh` entries above into the
  catalogue.

**From the page-side read (MOTIR-9198)** — per row the work item's id, its `linkedAt` and either the live
summary or the unavailable arm; once, `nextCursor` and `canLink`; and the archived-page answer (no rows, no
capability). **From the hand-link write path (MOTIR-9197)** — the two operations the controls call
(`POST /api/work-items/[id]/pages`, `DELETE /api/work-items/[id]/pages/[pageId]`) and the refusals this
asset words; it names the sentences, never the error codes. **To E2E and the clip (MOTIR-9202)** — panels
1, 2, 7, 10 and 11 are the page-side acceptance path, and the accessible names it resolves controls by come
from the copy table.

### Allocation sweep

**GIVES** the build and E2E cards the panels and copy above. **TAKES** from none. It composes with three
sibling cards: the Pages-section design (MOTIR-9195), the page-side read (MOTIR-9198) and the write path
(MOTIR-9197).

### What this does not decide

The work item's Pages section and its picker; the read's order beyond "newest hand link first"; the write
path's error names; embedded cards; and the page tree and breadcrumb (MOTIR-7367's, unchanged).

## Search from the page tree

One **Search box** above the `/pages` tree finds a
page by a word in its title or text, or by what it is about. While a query is active a result list
replaces the tree; clearing the box brings the tree back. This section **amends** § `/pages` — the tree
(`pages--tree.mock.html`) by delta mock; that mock is not edited:

| Amends                                                | By                              | Panels |
| ----------------------------------------------------- | ------------------------------- | ------ |
| § `/pages` — the tree, `pages--tree.mock.html` (1–12) | `pages--tree--search.mock.html` | 1–10   |

### Design system — what was read, and the verdict

- **Read:** `package.json` (depends on `@motir/design-system`), `app/globals.css` (imports
  `@motir/design-system/theme.css`), `packages/design-system/theme.css`, and the shipped surface:
  `app/(authed)/pages/page.tsx` (the header with Archived pages, New folder and New page, then the body
  in an in-page `<Suspense>`), `app/(authed)/pages/_components/PagesIndex.tsx`,
  `components/pages/tree/PageTree.tsx` (the failed-read row with Try again, Load more),
  `app/(authed)/items/[key]/_components/PagePlace.tsx` (the place breadcrumb) and `lib/dto/pages.ts`.
- **Verdict: ON MOTIR DESIGN (branch a)**, as § The page tree recorded. The mock is built the way its
  base is: the base's token block copied in, plus `--color-tint-yellow` / `--el-tint-yellow` and three
  density steps (`--spacing-control-x-12`, `--spacing-control-y-8`, `--spacing-card-padding-12`) copied
  from `theme.css`. The header is drawn as `/pages` ships it today, with Archived pages, which the tree
  mock predates.
- **Parts:** the input, `Button` and the alert row are the package's or the tree's own; the Hit row and
  the result list are **product-local components** (they know pages); the Hit place is the shipped
  `Place`. Nothing is proposed for the package.

### Access path (drawn, panel 1)

The shipped **Pages** rail row → `/pages` → the **Search box**, the first thing in the page body: under
the header, above the tree. A reader without `page:view` never reaches it: `/pages` answers its existing
404 (`notFound()` before the tree renders), and the search route refuses with no page data. So there is
**no in-page no-access state**, and none is drawn.

### Elements

| Element            | What it is                                                                                                                                                 | Colour / shape                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search box         | A search input, max 520px, with a leading `Search` glyph and the placeholder; `role="search"`, name `pages.search.label`                                   | `--el-input-border`, `--el-page-bg`, `--radius-input`, `--height-input`, `--spacing-input-x`; focus `--focus-ring-color` ring; glyph `--el-icon-muted` |
| Clear control      | `X` icon button at the trailing end, shown once the box holds any character (spaces included)                                                              | `--el-text-secondary`, `--height-btn-sm` square, `--radius-control`, `--spacing-icon-btn`                                                              |
| Pending indicator  | A spinner in the box before Clear, `role="status"`, announced once as `pages.search.pending`                                                               | `--el-text-secondary`                                                                                                                                  |
| Empty hint         | A helper line under the box while it holds focus and its query is empty or only spaces; info glyph                                                         | 12.5px `--el-text-secondary`; glyph `--el-icon-muted`                                                                                                  |
| Too-long hint      | The same helper line, naming the 200-character limit                                                                                                       | as the Empty hint: informational, never the danger tone                                                                                                |
| Hit row            | One link to `/pages/{id}`: the page glyph, then the Hit title, the Hit place and the Hit snippet; min 40px, the tree's row rhythm                          | `--spacing-control-y-8` × `--spacing-control-x-12`; hover `--el-surface`; focus inset `--focus-ring-color` ring; rules `--el-border-soft`              |
| Hit title          | The page title as written (never translated)                                                                                                               | 14px/500 `--el-text`, one line, ellipsis                                                                                                               |
| Hit place          | The shipped `Place`: the root crumb, each folder with its folder glyph, the parent page; the root crumb alone at the root; folds past five segments to "…" | 12px `--el-text-secondary`, separators `--el-icon-muted`                                                                                               |
| Hit snippet        | The service's plain text, two lines at most; absent when the snippet is `''`                                                                               | 13px `--el-text-secondary`; emphasis `--el-tint-yellow` fill + `--el-text-strong` + weight 600, `--radius-kbd`                                         |
| Result list        | A list in the tree's card frame, name `pages.search.results`                                                                                               | `--el-card`, `--el-border`, `--radius-card`                                                                                                            |
| Load more control  | The list's last band, a link-styled button with `ChevronDown`, as the tree's Load more; in flight it reads `pages.search.loading` with the spinner         | `--el-link`; band text `--el-text-secondary`                                                                                                           |
| Degraded note      | One line above the hits, info glyph, `role="note"`                                                                                                         | `--el-tint-sky` fill, `--el-text-strong` ink, `--radius-control`; never an error colour, icon, toast or modal                                          |
| No-results message | In the list's place: the sentence naming the query, and a secondary small `Button` with `X`, its clear control                                             | `--el-card` frame; text `--el-text`                                                                                                                    |
| Error state        | The tree's failed-read row: `AlertCircle`, one sentence, a secondary small Try again, its Retry control                                                    | glyph `--el-danger`, text `--el-text`, in the tree's card frame                                                                                        |

### Behaviour drawn

- **Idle (1):** the empty box above the unchanged tree. There is **no mode toggle**: the member never
  chooses full-text or meaning search.
- **Focused, empty or whitespace query (2):** the Empty hint shows; nothing is requested, no Pending
  indicator, and the tree stays. A blank query never lists every page.
- **Loading (3):** the first search shows the Pending indicator and three row-shaped blocks where the
  list will be. A later search keeps the previous hits visible and clickable until the new answer
  replaces them; an older answer never overwrites a newer one.
- **Results (4):** the three snippet cases. **Word match:** each query word found in the snippet is
  emphasised in the browser (the service's `ts_headline` carries no markers), by weight and tint, never
  colour alone. **Meaning only:** the body's opening words, nothing emphasised. **Empty body:** title
  and place only. `rank` is never shown; the list keeps the service's order.
- **Load more (5):** in flight it reads Loading… while the hits above stay put; a failed next page
  shows the Error state's sentence and Retry in that band, retrying the same page. The last page has no
  band, and no count is shown: the search knows no total.
- **Too long (6):** a query over 200 characters after trimming (`PAGE_SEARCH_QUERY_MAX_LENGTH`) shows
  the Too-long hint; the tree or the previous list stays. It is a hint, not an error screen.
- **No results (7):** the message names the query as typed; Clear search empties the box and brings the
  tree back. Distinct from Loading and from Error.
- **Degraded (8):** `full-text-only` and `not-indexed` each show the Degraded note above the hits; a
  `not-indexed` answer with no hits shows the No-results message under the note. The copy is the app's,
  keyed by `mode`; the service's English `message` is not shown.
- **Error (9):** any failure other than a named refusal. Retry repeats the same query; the header and the
  box stay usable, and editing the query searches again.
- **Keyboard (10):** the Search box → each hit, top to bottom → Load more, each with its focus ring.
  Down from the box moves to the first hit; Up and Down move between hits; Up from the first hit returns
  to the box; Enter opens the focused hit; Escape in the box, or Clear, empties it and brings the tree
  back; Escape on a hit returns focus to the box.

### Copy (new keys; page titles and snippets are never translated)

| Key                            | en                                                                       | zh                                           |
| ------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------- |
| `pages.search.label`           | Search pages                                                             | 搜索页面                                     |
| `pages.search.placeholder`     | Search pages by a word or by meaning                                     | 按关键词或含义搜索页面                       |
| `pages.search.clear`           | Clear search                                                             | 清除搜索                                     |
| `pages.search.pending`         | Searching…                                                               | 正在搜索…                                    |
| `pages.search.emptyHint`       | Type a word or a phrase to search titles and page text.                  | 输入关键词或短语，搜索标题和页面正文。       |
| `pages.search.tooLong`         | Searches are limited to {limit} characters — shorten it to search.       | 搜索最多 {limit} 个字符，请缩短后再搜索。    |
| `pages.search.mode.fullText`   | Showing word matches only — meaning search didn’t run this time.         | 仅显示关键词匹配——本次未进行语义搜索。       |
| `pages.search.mode.notIndexed` | Showing word matches only — pages aren’t indexed for meaning search yet. | 仅显示关键词匹配——页面尚未建立语义搜索索引。 |
| `pages.search.noResults`       | No pages match “{query}”.                                                | 没有页面匹配“{query}”。                      |
| `pages.search.failed`          | Couldn’t search the pages.                                               | 无法搜索页面。                               |
| `pages.search.results`         | Search results                                                           | 搜索结果                                     |
| `pages.search.loading`         | Loading…                                                                 | 正在加载…                                    |

Reused: `common.retry` (Try again / 重试), `pages.tree.loadMore` (Load more / 加载更多),
`pages.tree.breadcrumb.*` through `Place`.

### Not drawn here

- An in-page no-access state, or a mode toggle.
- App-wide or command-palette search; filters, sort, saved searches or a similarity threshold;
  searching archived pages.
- The tree rows, the header and the rail, which are the approved mocks' and the shipped page's.
