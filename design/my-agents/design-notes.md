# `design/my-agents/` — My agents

**Story MOTIR-6860 · design MOTIR-6868.** Gates **MOTIR-6874** (the page, its dialog, its row actions
and its rail row). One surface: `my-agents.mock.html`.

One of **my agents** is one developer's long-lived agent machine on one project: booted from a sandbox
image, with the project's repositories cloned into a persistent home, signed in to its agent with the
developer's own account, charged per running minute and hibernated when idle.

**Everything this area can say is decided by `docs/decisions/agent-instances.md` (MOTIR-6866)** — the
states and their transitions (§4), the charge and the credit pre-flight (§5), the three caps (§6), the
permission (§8) and the offered profiles (§9). This asset draws those and invents none of them; the
section references below are to that record.

---

## Revision 3 — no organization limit (AMENDMENT 2)

`docs/decisions/agent-instances.md` AMENDMENT 2 removed the per-organization running cap, gave agents
their own pool, and charges a machine while it runs. On this page that means three things:

- **The _Organization limit_ refusal is gone** (panel 5). Credits decide how many agents an organization
  runs; _Your limit_ (10 agents per person) still bounds the storage every agent keeps.
- **_Motir is busy_ is the agent pool's own safety valve** — no longer CI's ceiling.
- **A hibernated row says why when Motir stopped it** — out of credits, idle, or 12 hours running
  (panel 4).

---

## The name — **My agents** (revision 2)

The first revision called this page **Instances**. Changes were requested on it (2026-09-29): _"We
don't call it instances, 'instances' is not a clear name. Is there a better name? What about 'my
agents'?"_ This revision adopts **My agents**:

- **It says whose and what.** The page lists only the reader's own machines (§8 — no key opens someone
  else's), and each is an agent they run. "Instance" is infrastructure vocabulary a developer does not
  use for their own agent.
- **It collides with nothing.** No page, rail row or route in the app is called "agents" today.
- **One word, one meaning per row.** A row is an **agent** (it has a name, a machine, a state). The
  Claude Code / Codex / … choice inside it is its **coding agent** — the dialog's field, the list's
  column and the "not offered" refusal all say _coding agent_, so "agent" never means two things on
  one row.

| Surface                | Revision 1                     | Revision 2                                  |
| ---------------------- | ------------------------------ | ------------------------------------------- |
| Rail row, page title   | Instances                      | **My agents**                               |
| Address                | `/instances`                   | **`/my-agents`**                            |
| Actions                | New / Create / Delete instance | **New agent / Create agent / Delete agent** |
| Empty state            | No instances yet               | **No agents yet**                           |
| Profile field / column | Agent                          | **Coding agent**                            |
| Permission label       | Use your own agent instances   | **Use your own agents**                     |

The permission's description becomes _"Create, wake, hibernate and delete your own agents on this
project — machines charged per running minute. It never opens anyone else's."_

**What does not change** — none of it is read by a user: the permission KEY `instance:use`, the
`AgentInstance` model and its tables, the service, the job ids and the `/api/projects/{key}/instances`
routes keep their names. The decision record (`agent-instances.md`) keeps its vocabulary as the
engineering name for the same thing.

---

## ⚠️ What this area does NOT draw

- **The right-half panel, the terminal and the agent sign-in** — opening an agent beside the list is
  the terminal story's (MOTIR-6861), whose design composes
  this page's list rather than redrawing it. **This page leaves the right half empty**, and a row click
  is inert until that story wires it.
- **The chat view** (MOTIR-6863), **Run in my agent** (MOTIR-6864) and **moving an agent to a
  newer image** (MOTIR-6862).
- **Any run section change.** Nothing on `/runs` moves.

---

## The surfaces — panel by panel

| Panel | What it settles                                                                    |
| ----- | ---------------------------------------------------------------------------------- |
| 0     | the rail row that reaches the page — position, label, glyph, registration          |
| 1     | the empty state                                                                    |
| 2     | the create dialog: name, the fixed project, the six-profile picker, the price line |
| 3     | the list, its columns, its pagination and the row menu                             |
| 4     | every lifecycle state, one row each                                                |
| 5     | every refusal, in words                                                            |
| 6     | the delete confirmation                                                            |
| 7     | the wait and the failure to load                                                   |
| 8     | the narrow width                                                                   |

### Panel 0 — THE ACCESS PATH: a primary rail entry, directly after Runs

Rendered against the shipped rail before drawing (`/runs` on this run's worktree): **Workbench · Work
Items · Ready · Runs · Boards · Roadmap · Plans · Backlog · Dashboard · Requested features · Reports ·
Approval records · Codebase**. The rule is `app/(authed)/_components/SidebarNav.tsx`'s own, stated in
`design/runs/design-notes.md` § _THE ACCESS PATH_: **every top-level project view is a primary entry**.

- **Position: directly after Runs.** Runs is where an agent works on a card; My agents is where your own
  agents live. The two are neighbours in the reader's head, and the terminal story will make them
  neighbours in behaviour (a card can be sent to one of your agents).
- **Label: `My agents`** (`nav.myAgents`). **Glyph: `SquareTerminal`** — a terminal in a frame, which
  is what one of these agents is to its owner; unused anywhere in the app. Not `Bot` (the run area's agent mark),
  not `Server` (infrastructure, not _your agent_).
- **⚠️ Registered as well as rendered.** `lib/settings/projectNavAccess.ts` gets a `/my-agents` row
  whose requirement is **`instance:use`** (§8). `canOfferNavDestination` answers false for an href it
  does not carry and for a key the reader lacks, so a `viewer` sees the rail **without** the row.
- **A reader without the key who types `/my-agents`** gets the page's `notFound()` — the way every room
  refuses a reader it does not admit. No refusal copy is drawn for it, because none is shown.

### Panel 1 — NO AGENTS YET

The shipped Runs empty-state card: muted glyph (`SquareTerminal`, `--el-text-secondary`), serif title
**"No agents yet"**, one paragraph, and the one action.

> Each is your own coding agent — Claude Code, Codex and others — on its own machine in Motir's cloud,
> with this project's code and signed in with your own account. Motir charges only its machine time, and it
> sleeps when you stop using it.

**It must not read as an error.** The **New agent** button is also in the page header, top right,
beside the title — the header's action slot, where `/runs` puts its Mine / Project control.

Page header copy: title **My agents**, subline **"Your own agents, on your own sign-in, in Motir's
cloud — {project name}"**.

### Panel 2 — THE CREATE DIALOG

A `Modal` with three fields and a price line; footer **Cancel** / **Create agent**.

| Field        | Control                         | Copy                                                                        |
| ------------ | ------------------------------- | --------------------------------------------------------------------------- |
| Name         | `Input`                         | hint: _"Only you see it. Letters, numbers and dashes."_                     |
| Project      | `Input`, read-only (fixed)      | hint: _"Its connected repositories are cloned into the agent's home."_ (§1) |
| Coding agent | radio list, one row per profile | each row: the coding agent's name + one line on the sign-in it will ask for |

**The coding-agent list is exactly the six `offered` profiles of §9, in this order:**

| Profile     | Row line                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------- |
| Claude Code | _Asks you to sign in with your Claude account, or an Anthropic API key, in its own terminal._ |
| Codex       | _Asks you to sign in with your ChatGPT account, or an OpenAI API key._                        |
| OpenCode    | _Uses your own model provider key. For Claude models, your Anthropic API key._                |
| Kimi Code   | _Asks you to sign in with your Kimi account._                                                 |
| Aider       | _Uses your own model provider key. For Claude models, your Anthropic API key._                |
| Goose       | _Uses your own model provider key. For Claude models, your Anthropic API key._                |

- **Antigravity and Cursor are NOT listed at all** (§9: forbidden / terms silent). A disabled row would
  invite the question the decision already answered; the list is the offered set, nothing more.
- The three open-source CLIs say a Claude model means the user's **own Anthropic API key** — §9's note
  that Anthropic does not permit a third-party application to offer Claude.ai subscription login.
- Under the picker: _"The coding agent's model usage is billed to you by its vendor, not by Motir. Motir never
  sees your sign-in."_ (§9's four conditions, in one sentence a user can read.)
- **The price line** (`--el-tint-sky`, info glyph): **"1 credit per minute** while it runs. It
  hibernates after 30 minutes without use and costs nothing while hibernated." (§2, §5).
- **Create's pending state** is the button's own (`Button` loading); a refusal lands **in the dialog,
  above its footer**, as a panel-5 refusal box, and the dialog stays open with the input kept.

### Panel 3 — THE LIST

The shipped `TableShell` grammar (the Runs index's): a rounded bordered wrapper, secondary ink in the
head, body ink in the cells. **Only the viewer's own live agents** (§4, §8 — no key opens someone
else's), newest first, **paginated with a total** (_"3 agents · Page 1 of 1"_). A developer may hold
several agents on one project.

| Column                  | Content                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Name                    | the agent's name, bold; under it, the state's line of words (panel 4) when it has one   |
| Coding agent            | the profile's display name                                                              |
| Project                 | the project name                                                                        |
| State                   | the state pill (panel 4)                                                                |
| Machine time this month | the sum of the running intervals overlapping the current calendar month (UTC), `1h 12m` |
| Credits                 | the credits of those intervals                                                          |
| (actions)               | the row menu (`…`), `aria-label` _"Actions for {name}"_                                 |

**Machine time this month**: an open interval counts up to now; a hibernated agent's figure stops
rising, which is what the story's verification step 4 checks.

**The row menu** — a `DropdownMenu` offering exactly the moves §4 allows from the row's state:

| Item          | Enabled from                      | Glyph                                           |
| ------------- | --------------------------------- | ----------------------------------------------- |
| **Wake**      | `hibernated`, `failed`            | `Power`                                         |
| **Hibernate** | `running`                         | `Moon`                                          |
| **Delete…**   | `running`, `hibernated`, `failed` | `Trash2`, danger ink (`--el-danger-on-surface`) |

A move the state does not allow is **disabled, not hidden**, so the menu keeps one shape. In
`starting`, `hibernating`, `waking` and `deleting` every item is disabled.

### Panel 4 — EVERY STATE

All seven states of §4, each a row. **The tones reuse `design/runs/design-notes.md`'s tone vocabulary**
(tinted background, `--el-text-strong` label, the hue in a 7px dot) — no new hue:

| State         | Pill label  | Background       | Dot                       | Line under the name                                                        |
| ------------- | ----------- | ---------------- | ------------------------- | -------------------------------------------------------------------------- |
| `starting`    | Starting    | `--el-tint-sky`  | `--el-status-in-progress` | _Booting — cloning {n} repositories into the home_                         |
| `running`     | Running     | `--el-tint-mint` | `--el-status-done`        | —                                                                          |
| `hibernating` | Hibernating | `--el-muted`     | `--el-status-todo`        | _Stopping the machine — your home stays_                                   |
| `hibernated`  | Hibernated  | `--el-muted`     | `--el-status-cancelled`   | —                                                                          |
| `waking`      | Waking      | `--el-tint-sky`  | `--el-status-in-progress` | _Starting a fresh machine on your home_                                    |
| `failed`      | Failed      | `--el-tint-rose` | `--el-danger`             | the failure reason in words, then the way out, in `--el-danger-on-surface` |
| `deleting`    | Deleting    | `--el-muted`     | `--el-status-todo`        | _Destroying the machine and its home_                                      |

- **Progress is never a spinner-only row**: every state in motion carries its line of words.
- **A hibernation the person did not ask for says why** (revision 3). Motir stops a running agent for
  three reasons of its own; the `hibernated` row then carries the most recent interval's end reason as
  its secondary line (`--el-text-secondary`). A hibernate the person pressed carries no line.

  | End reason | Line under the name                                                         |
  | ---------- | --------------------------------------------------------------------------- |
  | `credits`  | _Stopped: your organization ran out of credits. Add credits, then wake it._ |
  | `idle`     | _Hibernated after 30 minutes without use_                                   |
  | `backstop` | _Stopped after 12 hours running. Wake it to carry on._                      |

  _Ran out of credits_ can happen mid-session now: AMENDMENT 2 charges a running machine every
  30-minute pass and hibernates it when the organization's balance reaches zero.

- **Failed** carries the record's `failureReason` and _"Wake to try again, or delete it."_ — the two
  moves §4 allows from `failed`.
- **Every wake is a cold boot** (§1, §2): the waking line says _a fresh machine on your home_, because
  anything installed outside the home is reset.
- The page keeps a row in motion fresh until it settles — a polling refetch while any row is in
  `starting`, `hibernating`, `waking` or `deleting` — per the page-state-after-mutation contract; a
  reader never reloads by hand.

### Panel 5 — EVERY REFUSAL

A refusal box: `--el-tint-rose`, alert glyph, `--el-text-strong` ink, `role="alert"`. On **create** it
sits in the dialog above the footer; on **Wake** it sits above the list. Create and wake are refused
**before any machine boots** (§5, §6), and each names the rule:

| Refusal                  | Copy                                                                                                                                                | Decided by                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Not enough credits       | _Your organization's credits can't start a machine right now. **Add credits** to create or wake an agent._ (links to the organization's usage page) | §5                                          |
| Your limit               | _You already have 10 agents. Delete one to create another._                                                                                         | §6                                          |
| Motir is busy            | _Motir is running as many machines as it can right now. Try again in a few minutes._ — **warning ground** (`--el-tint-peach`): a wait, not a fault  | AMENDMENT 2 (the agent pool's safety valve) |
| Coding agent not offered | _{Agent} isn't offered: its terms don't yet allow a platform to host it. Choose another coding agent._                                              | §9                                          |
| Name taken               | _You already have an agent called {name} on this project._                                                                                          | §4 (live-name uniqueness)                   |

The count is the cap's configured value, rendered from the refusal, never hard-coded in copy. **There is no
organization limit** (revision 3, AMENDMENT 2): credits decide how many agents an organization runs.
**No permission is not a message**: no rail row, no create control, and the route refuses (panel 0).

### Panel 6 — DELETE

An `AlertDialog`: title **"Delete {name}?"**.

> This destroys the agent's machine **and its home**. You lose:
>
> - its coding agent's sign-in — you would sign in again on a new agent;
> - every file in the home, including the cloned repositories;
> - any work you have not committed and pushed.
>
> This can't be undone. Machine time already used is still charged.

Footer: **Keep it** (the default, focused) and **Delete agent** (danger `Button`: `--el-danger` fill,
`--el-danger-text` ink, `Trash2`). §1 and §4: the machine and the volume go, the interval closes and is
charged.

### Panel 7 — THE WAIT, and THE FAILURE TO LOAD

The Runs index's two faces: skeleton rows in an **in-page `<Suspense>` after the page's own gate —
never a `loading.tsx`** (`design/shell/design-notes.md` § _the navigation-pending grammar_); and a
failure box, _"We couldn't load your agents. Refresh to try again — nothing about them has
changed."_, which never borrows the empty state's words.

### Panel 8 — THE NARROW WIDTH

Below the table's width each agent is a card: **name + menu**, **coding agent · project + state pill**,
**machine time this month + credits**, then the state's line of words. The header stacks; **New
agent** stays the first control.

---

## Primitives and tokens

| Primitive                           | Used for                                         |
| ----------------------------------- | ------------------------------------------------ |
| the shipped `Sidebar` row           | the rail entry                                   |
| the Runs page header                | title, subline, the action slot                  |
| `Button` (primary / ghost / danger) | New agent, Create agent, Cancel, Keep it, Delete |
| `TableShell` / `Th` / `Td`          | the list                                         |
| `Pill` with the runs tone set       | every state chip                                 |
| `DropdownMenu`                      | the row menu                                     |
| `Modal` · `AlertDialog`             | the create dialog · the delete confirmation      |
| `Input` · `FormField`               | name, the fixed project                          |
| `RadioGroup`                        | the coding-agent picker                          |
| the Runs empty-state card           | panel 1                                          |

| Element                                                     | Shape tokens                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| dialog panel                                                | `--radius-modal` · `--shadow-modal` · `--spacing-card-padding` |
| inputs                                                      | `--radius-input` · `--height-input` · `--spacing-input-x/y`    |
| table cells, radio rows, menu rows, refusal and price boxes | `--spacing-control-x/y` · `--radius-control` / `--radius-card` |
| state pills                                                 | `--radius-badge` · `--spacing-chip-x/y`                        |
| menu                                                        | `--radius-card` · `--shadow-elevated`                          |
| buttons                                                     | `--radius-btn` · `--height-btn-sm` · `--spacing-btn-x-sm`      |

**Ink**: body `--el-text`; every secondary line `--el-text-secondary` (AA on every surface in both
themes); danger text on a surface `--el-danger-on-surface`, never `--el-danger-text` off a danger fill.
`--el-text-muted` and `--el-text-faint` are used nowhere. The selected radio row is `--el-tint-lavender`
with `--el-text` ink; the price line `--el-tint-sky` with `--el-text-strong`.

---

## GIVES / TAKES

- **GIVES MOTIR-6874** (the page): the rail row and its registration, the page header, the empty state,
  the create dialog and its six-profile picker, the list columns and pagination, the row menu and its
  per-state enablement, the seven state rows and their lines, the six refusals and where each lands, the
  delete confirmation, the wait and failure faces, the narrow cards, and every string above (with `zh`
  twins in `messages/`).
- **TAKES from MOTIR-6866** (the decision): §4's states and transitions, §5's credit pre-flight and
  per-interval charge, §6's caps, §8's `instance:use`, §9's offered set and its sign-in notes.
- **TAKES from MOTIR-6872** (the service): the typed refusals the panel-5 copy renders, and the list
  read with each agent's machine time and credits this month.

---

## The agent panel — an agent opened beside the list (delta, MOTIR-6937)

**Story MOTIR-6861 · design MOTIR-6937.** Gates **MOTIR-6941** (the panel). Mock:
**`design/my-agents/my-agents--panel.mock.html`**, a DELTA.

**What it amends.** This section amends § _What this area does NOT draw_ (its first bullet: _"This
page leaves the right half empty, and a row click is inert until that story wires it"_) and § _Panel
3 — THE LIST_ above, drawn in `design/my-agents/my-agents.mock.html` — **MOTIR-6868's published
result (revision 3, commit `f953bda2b`), the list this panel composes**. That mock is not edited; it
stays the record of the list page. The delta draws only what opening an agent adds.

**Where every state comes from.** The seven lifecycle values are `docs/decisions/agent-instances.md`
§4. Every terminal state, refusal, reconnect rule and sign-in state is **`docs/decisions/agent-terminal.md`
(MOTIR-6936)**: Q3 (the ticket and its refusals `not_owner` / `not_running` / `no_terminal_server`,
the relay close codes 4401 / 4403 / 4409 / 4410 / 4502), Q4 (the control frames, including the
`session_limit` and `taken_over` errors), Q5 (the same shell on reconnect, the 256 KiB replay, four
sessions), Q6 (opening a hibernated agent wakes it with no second click), Q7 (the three sign-in states,
and none before the terminal connects) and Q8 (the image-too-old state). This design adds no state the
decision does not produce; the copy is this card's.

**Composed, not redrawn.** The mock's four `<style>` blocks are `my-agents.mock.html`'s own, verbatim
(themselves `design/runs/runs-index.mock.html`'s). The table rows, the narrow cards (base panel 8),
the state pills (`RunTonePill` through `AGENT_STATE_TONE`), the refusal box (base panel 5) and the
delete confirmation (base panel 6) are that asset's markup, copied, and were checked against the
shipped `app/(authed)/my-agents/_components/` (`MyAgentsRoom.tsx`, `AgentRowMenu.tsx`,
`agentRefusal.tsx`, `DeleteAgentDialog.tsx`). One correction to the base notes, from what ships: the
list is **not paginated** (`MY_AGENTS_LIST_LIMIT` reads all of a person's agents), so the delta draws
no pager.

| Panel | What it settles                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------- |
| 1     | the access path: the row as the door, the two-column mode, the address, closing and the list after |
| 2     | the header: name, state pill, coding agent · project, Hibernate, Delete and its confirmation       |
| 3     | sign-in status: three states, the command per coding agent, the turn without a reload              |
| 4     | the seven lifecycle values as the panel shows them                                                 |
| 5     | the terminal tab: connecting, live, reconnecting, lost, exited; size, scroll and resize            |
| 6     | the refusals, in words                                                                             |
| 7     | the narrow width                                                                                   |

### Panel 1 — THE ACCESS PATH

- **The door is the row.** The whole list row (`tr` in the table; the card in the narrow form) is the
  click target, and **Enter** on a focused row opens it. The row menu (`…`) keeps its own click and
  never opens the panel. The base asset already marks each row `is-link`; this story wires it.
- **The address** becomes `/my-agents?agent=<id>` by a `replace` (no new history entry), so a reload,
  a bookmark or a shared tab reopens the same agent, and Back leaves the page rather than walking back
  through every agent opened.
- **Two columns.** The page header (title, subline, **New agent**) stays across the top. Under it, a
  **340px list column** and the **panel**, which takes the rest. The list column is below the table's
  width, so its rows take the page's own **narrow card form** (base panel 8, unchanged). A
  **container query on the list column**, not the viewport breakpoint the page uses today, is what
  switches it. The list stays usable: its menus work, and clicking another card switches the panel and
  the address to that agent.
- **The selected row** carries `aria-current="true"`, the `--el-tint-lavender` ground and an
  `--el-accent` border, with `--el-text` / `--el-text-secondary` ink on it (the create dialog's
  selected radio row, the area's "this one" mark).
- **Closing.** The header's **×**, or **Esc** from inside the panel (but not while the terminal has
  focus, since Esc belongs to the shell there), drops `?agent=` and returns the list to its table.
  Focus returns to the row that was open. **Closing ends nothing.** The shell keeps running and
  re-attaches if the agent is reopened in the same tab. The agent hibernates on the ordinary idle rule
  once the terminal stops counting as activity (Q6).

### Panel 2 — THE HEADER

| Element          | Content                                                                              | Tokens                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| name             | the agent's name                                                                     | serif 1.125rem, `--el-text`                                                                                  |
| state pill       | the list's pill for the same state                                                   | `RunTonePill` + `AGENT_STATE_TONE` (base panel 4)                                                            |
| meta line        | _{coding agent} · {project}_                                                         | 0.8125rem, `--el-text-secondary`                                                                             |
| **Hibernate**    | shown **only when `running`** (`Moon`)                                               | `Button` secondary, `--height-btn-sm`, `--radius-btn`                                                        |
| **Delete…**      | always shown; disabled in `starting`, `hibernating`, `waking`, `deleting` (`Trash2`) | `Button` secondary, `--el-danger-on-surface` ink; disabled: `--el-surface` ground, `--el-text-secondary` ink |
| close            | **×**, `aria-label` _"Close {name}"_                                                 | icon button, `--el-text-secondary`                                                                           |
| sign-in status   | panel 3                                                                              |                                                                                                              |
| the sign-in line | panel 3                                                                              |                                                                                                              |

- Machine time and credits stay on the list, where they are compared across agents.
- **Delete…** opens the page's own `DeleteAgentDialog` (base panel 6), unchanged. On success the panel
  closes (panel 4, _deleting_).
- The header sits on `--el-card` with `--spacing-card-padding`, and a `--el-border-soft` rule under it.

### Panel 3 — SIGN-IN STATUS

One line under the meta line. It only shows what the terminal server pushed (`signin` frame, Q7).
**Before the terminal connects (starting, waking, connecting) there is no line at all**, so there is no
guess.

| State                    | Glyph (aria-hidden)                 | Copy                                                                                                                                              |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| signed in                | `CircleCheck`, `--el-success`       | _Signed in to {coding agent}_                                                                                                                     |
| not signed in (claude)   | `CircleAlert`, `--el-warning`       | _Not signed in — run `claude`, then `/login`, in the terminal to sign in_                                                                         |
| not signed in (codex)    | `CircleAlert`, `--el-warning`       | _Not signed in — run `codex login --device-auth` in the terminal to sign in_                                                                      |
| not signed in (opencode) | `CircleAlert`, `--el-warning`       | _Not signed in — run `opencode auth login` in the terminal to sign in_                                                                            |
| can't be checked (kimi)  | `CircleHelp`, `--el-text-secondary` | _Sign-in status can't be checked for Kimi Code_ + _To sign in, run `kimi` in the terminal and follow its sign-in._                                |
| can't be checked (aider) | `CircleHelp`, `--el-text-secondary` | _Sign-in status can't be checked for Aider_ + _Aider uses your model provider's key: add `ANTHROPIC_API_KEY=…` (or your provider's) to `~/.env`._ |
| can't be checked (goose) | `CircleHelp`, `--el-text-secondary` | _Sign-in status can't be checked for Goose_ + _To add your model provider's key, run `goose configure` in the terminal._                          |

- **Never a tick for _can't be checked_.** The neutral question glyph is the whole point of the third
  state.
- Commands render as inline code: `--el-code-bg` / `--el-code-text`, `--radius-badge`, mono 0.75rem.
- **The sentence about the sign-in (§9), once, under the status in every state:** _"Your sign-in
  belongs to {coding agent} and stays in this agent's home. Motir never sees it."_ It uses a `Lock`
  glyph and 0.75rem `--el-text-secondary`. It stays even when there is no status line yet.
- **The turn without a reload.** The vendor's own flow runs in the terminal (Q9: Motir pre-fills
  nothing, and the URL opens in the reader's own browser). The server re-checks every 5 seconds while
  attached and pushes `signin` on the change. The line then swaps to _Signed in_ and lands once on
  `--el-tint-mint` with `--el-text-strong` ink, then settles to the plain line after a moment. The
  swap is announced politely (`aria-live="polite"` on the status line).

### Panel 4 — EVERY LIFECYCLE VALUE

The pill is always the list's. The terminal area says what is happening in words, reusing the list's
own `myAgents.progress.*` strings so the row and the panel never disagree. While the agent is in
motion the panel re-reads it (the list's 2-second poll).

| State         | Header                 | Terminal area                                                                                                                                |
| ------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`    | Delete disabled        | _Booting — cloning the project's repositories into the home_ · _The terminal opens here as soon as the agent is up._                         |
| `running`     | Hibernate · Delete     | the terminal (panel 5)                                                                                                                       |
| `hibernating` | Delete disabled        | _Stopping the machine — your home stays_ · _The terminal closes with it. Your files and your sign-in are kept._                              |
| `hibernated`  | Delete                 | _{name} is hibernated_ · the list's `stop.*` line when Motir stopped it, then _Your files and your sign-in are kept._ · **Wake**             |
| `waking`      | Delete disabled        | _Starting a fresh machine on your home_ · _The terminal connects by itself when it's up — nothing to click._                                 |
| `failed`      | Delete                 | the `failureReason` in `--el-danger-on-surface` · _Wake to try again, or delete it._ · **Wake**                                              |
| `deleting`    | Delete disabled; faded | _Destroying the machine and its home_. The panel then **closes**, `?agent=` drops, and the list keeps the row in _Deleting_ until it is gone |

- **Opening a `hibernated` agent wakes it** (Q6): the panel calls the existing Wake route, shows
  `waking`, and on `running` asks for the ticket and connects, with **no second click**. Every wake is a
  cold boot, so the shell is fresh, in `~/workspace`, and the home and sign-in are kept. The
  `hibernated` resting face appears only when the agent stops **while the panel is open**.
- **Wake** in the panel is the primary `Button` (`--el-accent` fill, `--el-accent-text`, `Power`).

### Panel 5 — THE TERMINAL TAB

- **The tab strip** is the shipped `WorkbenchTabs` track: `--el-tabnav-track` inside an `--el-border`
  rule, `--radius-btn`, and one active tab, **Terminal** (`SquareTerminal` glyph in
  `--el-tabnav-active`, label `--el-text-strong` on `--el-page-bg`, `--shadow-subtle`). It holds one tab
  today, so the chat story (MOTIR-6863) adds **Chat** beside it, and nothing marks the empty place.
- **The connection word** sits at the strip's right end: 0.75rem `--el-text-secondary` with a 7px dot.

| State        | Word            | Dot                       | Strip above the terminal                                                                                                                  | Terminal                               |
| ------------ | --------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| connecting   | _Connecting…_   | `--el-status-in-progress` | —                                                                                                                                         | _Connecting to {name}'s terminal…_     |
| live         | _Live_          | `--el-status-done`        | —                                                                                                                                         | the shell, prompt in `~/workspace`     |
| reconnecting | _Reconnecting…_ | `--el-status-in-progress` | `--el-tint-sky`: _Connection dropped — reconnecting to the same shell. Your build keeps running._                                         | the last screen, dimmed; typing paused |
| lost         | _Disconnected_  | `--el-danger`             | `--el-tint-rose`, `role="alert"`: _Couldn't reconnect. Your shell is still running on the agent — reconnect to pick it up._ **Reconnect** | the last screen, dimmed                |
| exited       | _Ended_         | `--el-status-cancelled`   | `--el-muted`: _The shell exited. Your files are all still in the home._ **Start a new shell**                                             | the final lines (`exit` / `logout`)    |

- **Reconnecting is the same shell** (Q5). The tab keeps its session in `sessionStorage`. A drop or a
  reload re-attaches, and the agent replays up to 256 KiB so the screen redraws before live output.
- **The reconnect window** is the panel's retry budget, **about a minute** of backing off. The exact
  number is MOTIR-6941's to set. After it, the state is _lost_. **Reconnect** mints a new ticket. If
  the agent hibernated in the meantime, Reconnect wakes it (panel 4) and opens a fresh shell.
- **Size.** The terminal fills the panel below the tab strip, down to the bottom of the viewport, so
  the page never scrolls to reach the terminal's last line. It is monospace 12px on `--el-code-bg`
  with `--el-code-text`, so it follows the theme.
- **Scroll.** It scrolls inside itself, with its own scrollback. It stays pinned to the latest line
  unless the reader scrolls up. New output then does not yank them down, and **Jump to latest**
  appears bottom-right.
- **Resize.** A window or panel size change refits the terminal to whole cells, sends `resize`
  (Q4), and shows _cols × rows_ for a moment (a `--radius-badge` tag on `--el-card`).

### Panel 6 — THE REFUSALS

| Case                                                            | Face                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wake refused: credits                                           | header _Hibernated_. In the terminal area: base panel 5's credits box and copy, unchanged, then **Wake**                                                                                                                                                                                                                                                                      |
| Wake refused: Motir is busy (the pool's valve)                  | same place, the peach _wait_ box and copy, unchanged, then **Wake**                                                                                                                                                                                                                                                                                                           |
| Not your agent, or not found (`not_owner` 403, 404, close 4403) | a panel titled **This agent isn't available**: _It may have been deleted, or it isn't one of yours. Only the person who created an agent can open it._ **← Back to My agents**. No name, coding agent, state or terminal. The list stays the reader's own, with nothing selected                                                                                              |
| The image has no terminal (`no_terminal_server`, close 4410)    | header unchanged (the agent is running and usable). Terminal area: **This agent can't open a terminal yet** · _It was made from an older image, from before the terminal existed. Moving an agent to the newer image — keeping its home and sign-in — is on its way. Until then, a new agent has the terminal._ No date and no button: MOTIR-6862's update does not exist yet |
| Another tab took the shell (`taken_over`)                       | `--el-muted` strip: _This shell is open in another tab now. One shell answers one tab at a time._ **Use it here**                                                                                                                                                                                                                                                             |
| Four sessions attached (`session_limit`)                        | _{name} already has 4 terminals open in other tabs. Close one there, then try again._ **Try again**                                                                                                                                                                                                                                                                           |
| The machine did not answer (4502)                               | after the reconnect loop, the _lost_ face with _The agent's machine isn't answering. Your files are safe in its home._ **Reconnect**                                                                                                                                                                                                                                          |
| Stale ticket (4401)                                             | **no words**: mint a new ticket and retry once, silently; a second failure is _lost_                                                                                                                                                                                                                                                                                          |
| Not running (`not_running` 409, close 4409)                     | **no words**: the panel's cue to wake the agent (panel 4)                                                                                                                                                                                                                                                                                                                     |

- The not-yours face is one answer for 403 and 404 **on purpose**, so it never confirms that another
  person's agent exists.

### Panel 7 — THE NARROW WIDTH

- **Below 1024px of content** there is no room for two columns, so the open agent takes the whole
  view. The address is the same.
- **← My agents** (the shipped crumb, `--el-link`) sits above the name. It and the header's **×** both
  return to the list, whose cards are base panel 8.
- The actions wrap under the name, and the sign-in line wraps.
- The terminal refits to the width (about 44 columns on a 390px phone) and behaves the same.

### Tokens and primitives this delta adds

| Element            | Tokens                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| panel              | `--el-card`, `--el-border`, `--radius-card`, `--spacing-card-padding`                                   |
| selected list card | `--el-tint-lavender`, `--el-accent` border                                                              |
| terminal           | `--el-code-bg`, `--el-code-text`, `--font-mono`; scroll thumb `--el-border-strong`, `--radius-badge`    |
| strips             | `--el-tint-sky` (reconnecting) · `--el-tint-rose` (lost) · `--el-muted` (ended), `--el-text-strong` ink |
| buttons            | the base asset's `Button` shape (`--height-btn-sm`, `--radius-btn`, `--spacing-btn-x-sm`)               |

**Ink:** body `--el-text`, secondary lines `--el-text-secondary`. `--el-text-muted` and
`--el-text-faint` are used nowhere, including the disabled Delete, which is secondary ink on
`--el-surface`.

### Vocabulary

On-screen copy says **agent** and **coding agent** and never "instance" (revision 2). The routes and
the decision record keep their engineering names.

### GIVES / TAKES

- **GIVES MOTIR-6941** (the panel): the row-as-door and `?agent=` address, the two-column mode and its
  container switch, the selected mark, close and focus return, the header and its per-state actions,
  the three sign-in states with every coding agent's command and the §9 sentence, the seven lifecycle
  faces, the tab strip, the five terminal states with scroll and resize, every refusal's words, the
  narrow full view, and every string above (with `zh` twins in `messages/`).
- **TAKES from MOTIR-6936** (the decision): every state above. **TAKES from MOTIR-6868** (this area's
  list): the rows, cards, pills, refusal box and delete confirmation, unchanged.
- **Leaves to others:** the Chat tab (MOTIR-6863), _Run in my agent_ (MOTIR-6864), and the image update
  and its _Update available_ marker (MOTIR-6862).

---

## The Chat tab — a conversation with the agent beside its terminal (delta, MOTIR-7011)

**Story MOTIR-6863 · design MOTIR-7011.** Gates **MOTIR-7017** (the Chat tab). Mock:
**`design/my-agents/my-agents--chat.mock.html`**, a DELTA.

**What it amends.** This section amends § _The agent panel_ above, and in it § _Panel 5 — THE
TERMINAL TAB_, whose first bullet reads _"It holds one tab today, so the chat story (MOTIR-6863) adds
**Chat** beside it, and nothing marks the empty place"_. It draws on
**`design/my-agents/my-agents--panel.mock.html`** (MOTIR-6937, approved), which is not edited and stays
the record of the panel. The delta draws only what the Chat tab adds: the tab in the track, the
transcript, the tool-call rows, the turn ends, the prompt box, the session list, and every state in
which an agent cannot chat.

**Where every state comes from.** **`docs/decisions/agent-chat.md` (MOTIR-7010)** is the workflow spec,
and this design adds no state it does not produce: Q1 (the supported set; aider unsupported), Q2 (the
Claude Code subscription refusal and its per-turn backstop), Q3 (per-turn headless process in
`~/workspace`, auto-approve flags), Q4 (the frames and the error codes `subscription_signin`,
`not_signed_in`, `turn_running`, `taken_over`, `too_large`), Q5 (the seven event kinds, the four tool
kinds, the 64 KiB clip), Q6 (turn end, Stop, one turn per agent, a dropped socket does not stop a turn),
Q7 (the session list, 50 newest, resume, `unavailable`) and Q8 (close code 4411, `CHAT_PROFILES`). The
copy is this card's.

**Composed, not redrawn.** The mock's first five `<style>` blocks are `my-agents--panel.mock.html`'s own,
verbatim, and the list cards, header, sign-in line, tab track, connection word, strips and faces are
its markup, copied. A sixth block adds only the chat's own elements, from the same tokens. Most panels
show the panel from its tab track down; the header above it is unchanged.

| Panel | What it settles                                                                                  | ADR                 |
| ----- | ------------------------------------------------------------------------------------------------ | ------------------- |
| 1     | the tab in the track (active, inactive, disabled), the tab in the address, a new chat            | Q1, Q3, Q4, Q8      |
| 2     | the transcript: prompt, collapsed tool rows, a reply streaming, then complete                    | Q1, Q5, Q6          |
| 3     | tool rows, each kind collapsed and expanded; a diff, a path-only edit, clipped output, a failure | Q5                  |
| 4     | turn ends (completed, stopped, failed), the Q2 backstop, the `error` and `other` rows            | Q2, Q5, Q6          |
| 5     | the prompt box: idle, typing, sending, running (Stop), disabled; `turn_running`, `too_large`     | Q4, Q6              |
| 6     | the session list: open, empty, at 50; resumed with history, history unavailable; `taken_over`    | Q4, Q6, Q7          |
| 7     | aider's disabled tab, Claude Code on a subscription, not signed in, no chat server (4411)        | Q1, Q2, Q6, Q8, Q11 |
| 8     | waking, connecting, reconnecting, lost                                                           | Q4, Q6              |
| 9     | the narrow width                                                                                 | —                   |

### Panel 1 — THE TAB IN THE TRACK

- **Chat is the second tab** in the approved track, after Terminal, with a `MessageSquare` glyph. The
  active tab is the approved one (`--el-page-bg` ground, `--el-text-strong` label, the glyph in
  `--el-tabnav-active`, `--shadow-subtle`). The **inactive** tab is the same box on the track
  (`--el-tabnav-track`) with `--el-text-secondary` label and glyph; on hover `--el-surface-soft` and
  `--el-text`. The box is the shipped tab's: `--height-control`, `--radius-control`,
  `--spacing-control-x`.
- **Disabled** (aider only, Q1) is drawn from `CHAT_PROFILES` (Q8) without connecting:
  `aria-disabled="true"`, a `Ban` glyph in place of the chat glyph, `--el-text-secondary` ink (never
  faint: the tab is still read), no hover. The reason is a tooltip on hover **and** keyboard focus,
  tied by `aria-describedby`: `--el-tooltip-bg` / `--el-tooltip-text`, `--radius-control`,
  `--spacing-tooltip-x/y`, `--shadow-elevated`.
- **Which tab opens.** An agent opens on Terminal, as it ships. The open tab is kept in the address as
  `&tab=chat`, written with `shallowPush` (the chat renders itself; the server answers nothing), so a
  reload returns to the chat. The connection word at the strip's right end describes the open tab.
- **A new chat** (Q4 `open` with no session) is an empty transcript with one centred face that says
  what the chat is: it works in the terminal's `~/workspace` (Q3), each turn runs the coding agent
  headless (Q3), and it acts without asking first (Q3's auto-approve flags; the ADR builds no approval
  prompt).

### Panel 2 — THE TRANSCRIPT

| Element         | Content                                                                      | Tokens                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| chat bar        | the session title (ellipsised), a _Resumed_ chip, **Sessions**, **New chat** | 0.8125rem `--el-text`; `--el-border-soft` rule; buttons the base `Button` secondary (`--height-btn-sm`, `--radius-btn`) |
| `user`          | the prompt, right-aligned, max 85%                                           | `--el-surface` ground, `--el-text`, `--radius-card`, `--spacing-input-y/x`                                              |
| `text`          | prose on the card, no bubble; deltas of one `id` join                        | 0.875rem `--el-text`; inline code `--el-code-bg` / `--el-code-text`, `--radius-badge`                                   |
| streaming caret | ends the paragraph while deltas arrive                                       | `--el-accent` block, `aria-hidden`                                                                                      |
| working line    | _{agent} is working…_ under the transcript while a turn runs                 | 0.75rem `--el-text-secondary`, `LoaderCircle`                                                                           |
| transcript      | fills the tab between the bar and the prompt box                             | `--el-card`, `--spacing-card-padding`                                                                                   |

- Claude Code and goose stream word by word; Codex, OpenCode and kimi send whole messages (Q1), so on
  those the caret is never seen. Token counts, cost and thinking are never drawn (Q5, Q10).
- The transcript fills to the bottom of the viewport, scrolls inside itself, stays pinned to the latest
  event, and shows the approved **Jump to latest** when the reader has scrolled up.

### Panel 3 — THE TOOL-CALL ROWS

| Kind (Q5) | Glyph            | Row                               | Right end                                                    | Expanded body                                                                                       |
| --------- | ---------------- | --------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `read`    | `FileText`       | **Read** + path                   | lines read                                                   | the content read                                                                                    |
| `edit`    | `FilePen`        | **Edit** + path                   | _+added −removed_                                            | the unified `diff`; path only: _{agent} reported which file it changed, but not the change itself._ |
| `command` | `SquareTerminal` | **Ran** + command                 | _exit {code}_                                                | the output; clipped: the note above it                                                              |
| `other`   | `Wrench`         | the tool's `name` + its `title`   | —                                                            | its output, or _No output._                                                                         |
| running   | as its kind      | as its kind                       | `LoaderCircle` _Running…_                                    | —                                                                                                   |
| failed    | as its kind      | as its kind, `--el-danger` border | `CircleX` _Failed · exit {code}_ in `--el-danger-on-surface` | the output                                                                                          |

- **Row:** `--el-card`, `--el-border`, `--radius-control`, `--spacing-control-x/y`, min
  `--height-control`; the act in `--el-text`, the path or command mono 0.75rem `--el-text-secondary`
  (ellipsised), glyphs and chevron `--el-text-secondary`; hover `--el-surface-soft`. The head is a
  disclosure button (`aria-expanded`); collapsed by default, and a failure is not opened for the reader.
- **Body:** `--el-code-bg` / `--el-code-text`, mono 12px, `--spacing-tooltip-y/x` (the inline code
  block's padding), `--el-border-soft` rule. Diff lines: added `--el-diff-added`, removed
  `--el-diff-removed`, both `--el-text-strong`; hunk headers `--el-text-secondary`.
- **Clipped** (`truncated`, over 64 KiB): a note row _above_ the body, where the cut start would be —
  `AlertTriangle`, 0.75rem `--el-text-secondary` on `--el-card`.

### Panel 4 — HOW A TURN ENDS

- **One marker per turn**, written by the runner (Q5, Q6): a `--el-border-soft` rule with the reason in
  its middle, 0.75rem `--el-text-secondary`, `role="separator"`.
  - `completed`: _Turn complete_, `CircleCheck` in `--el-success`.
  - `stopped`: _Stopped_, `Square` in `--el-text-secondary`, and under it _You stopped this turn. The
    reply above is as far as it got._ The streamed text stays (Q6).
  - `failed`: _Turn failed_ in `--el-danger-on-surface`, `CircleX` in `--el-danger`, and its `code` in
    words under it (0.75rem `--el-text-secondary`). The Q2 backstop is this marker with
    `subscription_signin`.
- **`error`** (Q5 — does not end the turn): an inline notice, `--el-warning-surface` ground,
  `--el-warning-text` ink, `AlertTriangle` in `--el-warning`, `--radius-control`,
  `--spacing-control-x/y`.
- **`other`**: one 0.75rem `--el-text-secondary` line naming the event, nothing else (Q10).

### Panel 5 — THE PROMPT BOX

| State    | Box                                                                           | Button                                                 |
| -------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| idle     | empty, placeholder in `--el-text-secondary`                                   | **Send**, off (`--el-surface`, secondary ink)          |
| typing   | multi-line, grows to ~8 lines then scrolls; `--el-accent` border + focus ring | **Send**, primary (`--el-accent` / `--el-accent-text`) |
| sending  | emptied; the prompt is already in the transcript                              | _Sending…_, off, `LoaderCircle`                        |
| running  | editable (the next prompt can be written; sent once the turn ends)            | **Stop** (`Square`), secondary — Q6's SIGINT           |
| disabled | not connected: `--el-input-disabled-bg` / `-border` / `-text`, text kept      | **Send**, off                                          |

- **Box:** `--el-input-border`, `--radius-input`, `--spacing-input-y/x`, min `--height-input`,
  0.875rem `--el-text`. The composer sits on `--el-card` under a `--el-border-soft` rule; the hint is
  0.75rem `--el-text-secondary`. Enter sends; Shift+Enter is a new line. A prompt is text only (Q4).
- **Refusals** are a strip directly above the box (`--spacing-control-y` × `--spacing-card-padding`,
  `--el-text-strong` ink), and neither empties the box: `turn_running` on `--el-tint-peach`
  (`AlertTriangle`, `role="status"`); `too_large` on `--el-tint-rose` (`CircleAlert`, `role="alert"`).

### Panel 6 — THE SESSION LIST

- **Sessions** opens a popover under the chat bar: `--el-card`, `--el-border`, `--radius-card`,
  `--shadow-elevated`. **New chat** heads it. Rows (`--spacing-control-x/y`, `--radius-control`, hover
  `--el-surface-soft`): the title in 0.8125rem `--el-text`, one line, ellipsised (the CLI's title or the
  first prompt cut to 120 characters, Q7), and the last activity in the app's relative time, 0.75rem
  `--el-text-secondary`. Newest first by last activity (Q7). The open session has `aria-current` and
  `--el-option-active-bg`. Terminal sessions are listed too and not told apart (Q7). At narrow width it
  is a sheet the panel's width.
- **Empty** and **at the bound of 50** (Q7) each get one 0.75–0.8125rem `--el-text-secondary` line (the
  bound's in a foot under a `--el-border-soft` rule).
- **Resumed** (Q4 `open` + `session`, then `history`): the bar shows the title and a _Resumed_ chip
  (`--el-tint-lavender`, `--el-text-strong`, `--radius-badge`, `--spacing-chip-x/y`); earlier turns are
  drawn exactly as live ones. `history.truncated` heads the transcript with a note; `unavailable` (Q7)
  opens with **no earlier turns drawn** and one note. Notes: `History` glyph, 0.75rem
  `--el-text-secondary` on `--el-surface-soft`, `--radius-control`, `--spacing-control-x/y`.
- **`taken_over`** (Q6): the transcript dims (opacity 0.6), the connection word is _Ended_, a
  `--el-muted` strip says the turn keeps running in the other tab, with **Use it here**; the box is
  disabled.

### Panel 7 — WHEN THE AGENT CAN'T CHAT

| Case                                         | Tab                                    | Chat body                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| aider (Q1)                                   | disabled, tooltip                      | not reachable; the panel stays on Terminal, untouched                                                                                                       |
| Claude Code on a Claude subscription (Q2, b) | enabled (the server's `hello` decides) | one face: `Lock`, the title, the Q2 sentence in full, **Open Terminal**. No prompt box. Terminal beside it, live                                            |
| not signed in (Q4, Q6)                       | enabled                                | the transcript unchanged, a `--el-tint-peach` strip (`role="alert"`) above the box pointing at the terminal, **Open Terminal**; the prompt stays in the box |
| no chat server — close 4411 (Q8)             | enabled; word _Unavailable_            | one face: `Package`, the title, the body — the panel design's image-too-old register; no date, no button                                                    |

- Faces: centred on `--el-card`, `--spacing-card-padding`, glyph 22px `--el-text-secondary`, title
  0.875rem `--el-text`, body 0.8125rem `--el-text-secondary` (max 30rem).
- The subscription case changes **nothing** on the Terminal tab or the header's sign-in line: the
  terminal on a subscription is the carve-out (Q2). Motir offers no way to set a key here (Q2, Q11).
- `not_signed_in` is let through as _unknown_ for kimi, aider and goose (Q6), so those never see it.
  The chat never starts a sign-in; **Open Terminal** switches tabs (Q11).

### Panel 8 — THE CONNECTION

The chat is its own socket (Q4), with its own connection word and dot, the approved set. The faces and
strips are the terminal tab's (§ Panel 5 above), reworded for a chat:

| State        | Word            | Body                                                                                            | Box                 |
| ------------ | --------------- | ----------------------------------------------------------------------------------------------- | ------------------- |
| waking       | _Waiting_       | the panel's waking face, with the chat's hint                                                   | disabled            |
| connecting   | _Connecting…_   | _Connecting to {name}'s chat…_                                                                  | disabled            |
| reconnecting | _Reconnecting…_ | `--el-tint-sky` strip; the transcript dimmed                                                    | disabled, text kept |
| lost         | _Disconnected_  | `--el-tint-rose` strip, `role="alert"`, **Reconnect**; 4502 uses the panel's `lostMachine` line | disabled, text kept |

On reconnect the tab re-opens the same session: `history`, then the running turn's kept events (256
KiB), then live ones (Q6). 4401 and `not_running` have no words, as on the terminal.

### Panel 9 — THE NARROW WIDTH

As the panel design's Panel 7: the agent takes the whole view. The chat bar's **Sessions** and **New
chat** become icon buttons (`--spacing-icon-btn`, `--radius-control`) with the same accessible labels;
tool rows keep one line with the path or command ellipsised; the prompt box stays pinned at the bottom.

### Strings — `myAgents.panel.*`, every new one

Reused unchanged: `panel.conn.*`, `panel.reconnect`, `panel.useHere`, `panel.strip.lostMachine`,
`panel.jumpLatest`, `progress.waking`. Times use the app's relative-time formatter.

| Key                                       | en                                                                                                                                                                                                                                                            | zh                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs.chat`                               | Chat                                                                                                                                                                                                                                                          | 对话                                                                                                                                                                        |
| `chat.unsupported`                        | Chat isn’t available for Aider: it has no machine-readable output for a chat to follow. Use the terminal.                                                                                                                                                     | Aider 无法使用对话：它没有可供对话跟随的机器可读输出。请使用终端。                                                                                                          |
| `chat.newChat`                            | New chat                                                                                                                                                                                                                                                      | 新对话                                                                                                                                                                      |
| `chat.sessions`                           | Sessions                                                                                                                                                                                                                                                      | 会话                                                                                                                                                                        |
| `chat.resumed`                            | Resumed                                                                                                                                                                                                                                                       | 已恢复                                                                                                                                                                      |
| `chat.empty.title`                        | Start a chat with {agent}                                                                                                                                                                                                                                     | 开始与 {agent} 对话                                                                                                                                                         |
| `chat.empty.body`                         | It works in <cmd>~/workspace</cmd> on {name}, with the same files and sign-in as the terminal. Each turn runs {agent} headless, and it edits files and runs commands without asking first.                                                                    | 它在 {name} 的 <cmd>~/workspace</cmd> 中工作，文件和登录与终端相同。每一轮都以无界面方式运行 {agent}，它会直接编辑文件、运行命令，不会先询问。                              |
| `chat.transcript`                         | Chat transcript (the region's label)                                                                                                                                                                                                                          | 对话记录                                                                                                                                                                    |
| `chat.working`                            | {agent} is working…                                                                                                                                                                                                                                           | {agent} 正在处理…                                                                                                                                                           |
| `chat.prompt.label`                       | Prompt                                                                                                                                                                                                                                                        | 提示                                                                                                                                                                        |
| `chat.prompt.placeholder`                 | Ask {agent} to do something…                                                                                                                                                                                                                                  | 让 {agent} 做点什么…                                                                                                                                                        |
| `chat.prompt.hint`                        | Enter to send · Shift+Enter for a new line                                                                                                                                                                                                                    | Enter 发送 · Shift+Enter 换行                                                                                                                                               |
| `chat.prompt.offHint`                     | You can type again once the chat reconnects.                                                                                                                                                                                                                  | 对话重新连接后即可继续输入。                                                                                                                                                |
| `chat.send`                               | Send                                                                                                                                                                                                                                                          | 发送                                                                                                                                                                        |
| `chat.sending`                            | Sending…                                                                                                                                                                                                                                                      | 发送中…                                                                                                                                                                     |
| `chat.stop`                               | Stop                                                                                                                                                                                                                                                          | 停止                                                                                                                                                                        |
| `chat.tool.read`                          | Read                                                                                                                                                                                                                                                          | 读取                                                                                                                                                                        |
| `chat.tool.edit`                          | Edit                                                                                                                                                                                                                                                          | 编辑                                                                                                                                                                        |
| `chat.tool.command`                       | Ran                                                                                                                                                                                                                                                           | 运行                                                                                                                                                                        |
| `chat.tool.lines`                         | {count} lines                                                                                                                                                                                                                                                 | {count} 行                                                                                                                                                                  |
| `chat.tool.exit`                          | exit {code}                                                                                                                                                                                                                                                   | 退出码 {code}                                                                                                                                                               |
| `chat.tool.running`                       | Running…                                                                                                                                                                                                                                                      | 运行中…                                                                                                                                                                     |
| `chat.tool.failed`                        | Failed                                                                                                                                                                                                                                                        | 失败                                                                                                                                                                        |
| `chat.tool.truncated`                     | Output clipped — showing the last 64 KB.                                                                                                                                                                                                                      | 输出已截断——仅显示最后 64 KB。                                                                                                                                              |
| `chat.tool.noDiff`                        | {agent} reported which file it changed, but not the change itself.                                                                                                                                                                                            | {agent} 报告了它修改的文件，但没有报告具体改动。                                                                                                                            |
| `chat.tool.noOutput`                      | No output.                                                                                                                                                                                                                                                    | 无输出。                                                                                                                                                                    |
| `chat.tool.show` / `chat.tool.hide`       | Show details / Hide details (the disclosure's label)                                                                                                                                                                                                          | 显示详情 / 隐藏详情                                                                                                                                                         |
| `chat.error`                              | {agent} reported a problem and kept going: {message}                                                                                                                                                                                                          | {agent} 报告了一个问题，并继续执行：{message}                                                                                                                               |
| `chat.other`                              | Unshown event: {name}                                                                                                                                                                                                                                         | 未显示的事件：{name}                                                                                                                                                        |
| `chat.turn.completed`                     | Turn complete                                                                                                                                                                                                                                                 | 本轮完成                                                                                                                                                                    |
| `chat.turn.stopped`                       | Stopped                                                                                                                                                                                                                                                       | 已停止                                                                                                                                                                      |
| `chat.turn.stoppedWhy`                    | You stopped this turn. The reply above is as far as it got.                                                                                                                                                                                                   | 你停止了这一轮。上面的回复就是它停下时的进度。                                                                                                                              |
| `chat.turn.failed`                        | Turn failed                                                                                                                                                                                                                                                   | 本轮失败                                                                                                                                                                    |
| `chat.turn.failedWhy.subscription_signin` | Claude Code is signed in with a Claude subscription, which the chat can’t use.                                                                                                                                                                                | Claude Code 使用 Claude 订阅登录，对话无法使用该登录。                                                                                                                      |
| `chat.turn.failedWhy.generic`             | {agent} stopped unexpectedly ({code}).                                                                                                                                                                                                                        | {agent} 意外停止（{code}）。                                                                                                                                                |
| `chat.notice.turnRunning`                 | A turn is already running on {name}, in another chat session. Wait for it to end or stop it there — one turn runs on an agent at a time.                                                                                                                      | {name} 上已有一轮正在另一个对话会话中运行。请等它结束，或在那里停止它——一个智能体同一时间只运行一轮。                                                                       |
| `chat.notice.tooLarge`                    | This prompt is over 64 KB. Shorten it, or save the text to a file in the workspace and point {agent} at it.                                                                                                                                                   | 这条提示超过了 64 KB。请缩短它，或把文本保存到工作区的文件中，再让 {agent} 去读取。                                                                                         |
| `chat.notice.takenOver`                   | This chat is open in another tab now. A running turn keeps going there.                                                                                                                                                                                       | 这个对话现在在另一个标签页中打开。正在运行的一轮会在那里继续。                                                                                                              |
| `chat.notice.notSignedIn`                 | {agent} isn’t signed in. Sign in in the Terminal tab — the chat uses the same sign-in.                                                                                                                                                                        | {agent} 尚未登录。请在“终端”标签页中登录——对话使用相同的登录。                                                                                                              |
| `chat.openTerminal`                       | Open Terminal                                                                                                                                                                                                                                                 | 打开终端                                                                                                                                                                    |
| `chat.subscription.title`                 | Chat isn’t available on a Claude subscription                                                                                                                                                                                                                 | Claude 订阅无法使用对话                                                                                                                                                     |
| `chat.subscription.body`                  | The chat is not available for Claude Code signed in with a Claude subscription, because Anthropic’s terms do not allow a third-party interface to drive it on one. Sign in with an Anthropic API key or a cloud provider to chat, or keep using the terminal. | 使用 Claude 订阅登录的 Claude Code 无法使用对话，因为 Anthropic 的条款不允许第三方界面在订阅登录上驱动它。请使用 Anthropic API 密钥或云服务商登录后再对话，或继续使用终端。 |
| `chat.noServer.title`                     | This agent can’t chat yet                                                                                                                                                                                                                                     | 这个智能体暂时无法对话                                                                                                                                                      |
| `chat.noServer.body`                      | It was made from an older image, from before the chat existed. Moving an agent to the newer image — keeping its home and sign-in — is on its way. Until then, its terminal works, and a new agent has the chat.                                               | 它是用较旧的镜像创建的，那时还没有对话功能。把智能体迁移到新镜像（保留主目录和登录）的功能即将推出。在那之前，它的终端仍可使用，新建的智能体都带有对话。                    |
| `chat.face.connecting`                    | Connecting to {name}’s chat…                                                                                                                                                                                                                                  | 正在连接 {name} 的对话…                                                                                                                                                     |
| `chat.face.wakingHint`                    | The chat connects by itself when it’s up — nothing to click.                                                                                                                                                                                                  | 机器启动后对话会自动连接——无需点击。                                                                                                                                        |
| `chat.strip.reconnecting`                 | Connection dropped — reconnecting. A running turn keeps going on the agent.                                                                                                                                                                                   | 连接中断——正在重新连接。正在运行的一轮会在智能体上继续。                                                                                                                    |
| `chat.strip.lost`                         | Couldn’t reconnect. A running turn keeps going on the agent — reconnect to pick it up.                                                                                                                                                                        | 无法重新连接。正在运行的一轮会在智能体上继续——重新连接即可继续查看。                                                                                                        |
| `chat.sessions.title`                     | Sessions on {name}                                                                                                                                                                                                                                            | {name} 上的会话                                                                                                                                                             |
| `chat.sessions.empty`                     | No sessions yet. A chat you start here — or a session you started with {agent} in the terminal — shows up here.                                                                                                                                               | 还没有会话。你在这里开始的对话，或你在终端中用 {agent} 开始的会话，都会显示在这里。                                                                                         |
| `chat.sessions.bound`                     | Showing the 50 most recent. Older sessions aren’t listed; {agent} still keeps them.                                                                                                                                                                           | 仅显示最近的 50 个会话。更早的会话未列出，{agent} 仍然保留着它们。                                                                                                          |
| `chat.history.truncated`                  | Earlier turns aren’t shown — only the latest 256 KB of this session is loaded.                                                                                                                                                                                | 更早的轮次未显示——只加载了这个会话最近的 256 KB。                                                                                                                           |
| `chat.history.unavailable`                | This session’s earlier turns can’t be shown here. {agent} still has them, so it carries on where you left off.                                                                                                                                                | 这个会话之前的轮次无法在这里显示。{agent} 仍然保留着它们，会从你上次停下的地方继续。                                                                                        |

### Tokens this delta adds

None. Every colour is an existing `--el-*` token (`--el-diff-added` / `--el-diff-removed`,
`--el-tooltip-bg` / `--el-tooltip-text`, `--el-warning-surface` / `--el-warning-text`,
`--el-input-disabled-*` and `--el-option-active-bg` are new to this area only). **Ink:** `--el-text`,
`--el-text-strong`, `--el-text-secondary`, `--el-code-text`, `--el-accent-text` on the accent fill and
`--el-danger-on-surface`. `--el-text-muted`, `--el-text-faint` and `--el-danger-text` are used nowhere,
including the disabled tab, the placeholder and every `:hover` state.

### GIVES / TAKES

- **GIVES MOTIR-7017** (the Chat tab): the tab and its three states, `&tab=chat`, the chat bar, the
  seven event kinds as drawn, the four tool kinds collapsed and expanded, the three turn-end markers,
  the prompt box's five states and two refusals, the session list and resume, the four can't-chat
  states, the four connection states, the narrow form, and every string above in en and zh.
- **TAKES from MOTIR-7010** (the decision): every state above. **TAKES from MOTIR-6937** (the panel
  design): the header, the list, the tab track, the connection word, the strips and the faces,
  unchanged.
- **Leaves to others:** the relay's chat channel and 4411 (MOTIR-7013), the `/v1/chat` server
  (MOTIR-7012), the adapters (MOTIR-7014 and the other adapter cards), _Run in my agent_ (MOTIR-6864),
  and the image update that clears 4411 (MOTIR-6862).

---

## The agent's live run — the panel while a work item runs in the agent (delta, MOTIR-7022)

**Story MOTIR-6864 · design MOTIR-7022.** Gates **MOTIR-7029**. Mock:
**`design/my-agents/my-agents--run.mock.html`**, a DELTA.

**What it amends.** § _The agent panel — an agent opened beside the list (delta, MOTIR-6937)_ above,
drawn in **`design/my-agents/my-agents--panel.mock.html`** — MOTIR-6937's published result (evidence
`cmun5qu1f005qhwoiq14livtw`, commit `5bf46803`), whose _GIVES / TAKES_ leaves _"Run in my agent
(MOTIR-6864)"_ to this card. That mock is not edited. The delta copies its five `<style>` blocks
verbatim and adds one; every lifecycle, sign-in and terminal state stays that section's.

**The behaviour** is `docs/decisions/agent-instance-run.md` §1 (the run session: at most one, listed
to every connection on attach, watch-only, never reaped), §5 (the run read by agent) and §6
(Hibernate and Delete refused during a run; every end). The work item side — the control, the
picker, the refusals, the run section and modal — and the full allocation and flagged gaps are
**`design/runs/design-notes.md` § _Run in my agent_**, drawn in `design/runs/run-section--agent.mock.html`.

| Panel | What it settles                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------- |
| 1     | the run line in the header; the run's session offered beside the developer's shell; watching it |
| 2     | Hibernate and Delete off during the run, and the refusal if pressed from elsewhere              |
| 3     | the run just ended — the header after, and the watched session's end                            |
| 4     | the narrow width                                                                                |

### Panel 1 — THE LIVE RUN

- **The run line**, one line under the meta line (`--el-tint-sky`, `--radius-control`,
  `--spacing-control-x/y`, `--el-text-strong` ink, `aria-live="polite"`): the running pill reading
  **Running a work item** · the work item's key (mono, linked) and title · **Open run** at the right
  (`/runs?run=<id>`). Read from the run record by agent and refreshed with the panel's poll — nothing
  comes through the terminal.
- **The session switch** at the head of the Terminal tab (a `sessBar` row under the tab strip,
  `--el-border-soft` rule): the shipped `Segmented` — track `--el-tabnav-track` in an `--el-border`
  rule, `--radius-btn`, segments `--height-control`, active on `--el-page-bg` with `--el-text-strong`
  and `--shadow-subtle`, inactive `--el-text-secondary`. **Your shell** (`SquareTerminal`) | **Run
  {key}** (a 7px `--el-status-in-progress` dot and an `Eye` glyph). At the right, _The run's session is
  watch-only_ (0.75rem `--el-text-secondary`). The tab strip stays the strip of VIEWS (Terminal, and
  Chat with MOTIR-6863); both sessions are terminals, so the choice sits inside the Terminal view.
- **Opening the panel lands on Your shell.** The switch appears as soon as the terminal is live
  (the server lists the run session on attach) and needs no second connection.
- **Watching:** the run's screen and replay, **no caret**, input dropped by the server, resize applied.
  A sky strip (`termStrip`, unchanged): _Watching the run of {key} — read-only, so typing goes nowhere.
  To stop it, use Cancel run on **the work item**._ Cancel is not offered in the panel: the Run section
  is the one place that cancels.

### Panel 2 — HIBERNATE AND DELETE DURING A RUN

- Both show their disabled face (`.btnGhost.isOff`: `--el-surface`, `--el-text-secondary`,
  `aria-disabled`) with one line under the run line: _Hibernate and Delete are off while a run is
  working in this agent — cancel the run first._ (0.75rem `--el-text-secondary`).
- Pressed from somewhere that did not know (the list's row menu, a stale tab), the server's
  `agent_instance_run_active` is shown in the page's refusal box (the rose box, unchanged): _{name} is
  running **{key}**. Cancel that run on the work item first, then hibernate it._ / _… then delete it._

### Panel 3 — THE RUN JUST ENDED

- The run line turns `--el-muted` and reads the LAST run: the end pill (tone table), **Last run**, the
  key and title, and on a failure the recorded reason in mono instead of the title, then **Open run**.
  It stays until the agent's next run replaces it. Hibernate and Delete come back.
- The run's session exits with the run, so its segment leaves the switch — and with one session left
  the switch goes, as before this story.
- If it was being watched: its last screen stays, dimmed (`.term.isPaused`), under the ended strip
  (`termStrip isEnded`): _The run's session has ended — the run succeeded, and its pull request is on
  the work item._ / _— the run failed. Its work so far is on the run's branch._ · **Back to your shell**.

### Panel 4 — THE NARROW WIDTH

The base panel 7 full view: the run line wraps (**Open run** on its own line), the disabled actions
and their reason wrap under the name, the switch fills the width (the `Segmented` `fill` variant) and
drops its hint — the sky strip says it.

### Strings — `myAgents.panel.run.*` (MOTIR-7029; `zh` twins with the build)

| Key                                                                         | String                                                                                                                                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live` · `last` · `open`                                                    | Running a work item · Last run · Open run                                                                                                                                          |
| `offWhy`                                                                    | Hibernate and Delete are off while a run is working in this agent — cancel the run first.                                                                                          |
| `refusedHibernate` · `refusedDelete`                                        | {name} is running <link>{key}</link>. Cancel that run on the work item first, then hibernate it. · … then delete it.                                                               |
| `sessions.label` · `sessions.shell` · `sessions.run` · `sessions.watchOnly` | Terminal sessions · Your shell · Run {key} · The run's session is watch-only                                                                                                       |
| `strip.watching`                                                            | Watching the run of {key} — read-only, so typing goes nowhere. To stop it, use Cancel run on <link>the work item</link>.                                                           |
| `strip.endedSucceeded` · `strip.endedFailed`                                | The run's session has ended — the run succeeded, and its pull request is on the work item. · The run's session has ended — the run failed. Its work so far is on the run's branch. |
| `backToShell`                                                               | Back to your shell                                                                                                                                                                 |

End pills reuse `runs.runStatus.*`; the recorded reason is the record's string, verbatim.

### GIVES / TAKES

- **GIVES MOTIR-7029:** the run line (live and last), the session switch and the watch-only face, the
  watch strip, the disabled Hibernate / Delete with their reason and the refusal box, the ended
  session face, the narrow view, and the strings above.
- **TAKES from MOTIR-7025:** the run session listed on attach, tagged with its run id (the panel matches
  it to the run line's run). **From MOTIR-7027:** the Hibernate / Delete refusal carrying the run's id and
  key. **From MOTIR-7023 / MOTIR-7026:** the agent's running run (and, for _Last run_, its latest run —
  flagged in the runs notes: no sibling builds that read yet).

**Revision 2 (MOTIR-7022, after review).** On the work item the door is now **Send to my agent**,
beside **Run** (Motir works it with the model you pick), and a busy agent's picker row names the work
item it is working on — `design/runs/design-notes.md` § _Revision 2_. This panel's delta
(`my-agents--run.mock.html`) is unchanged: its run line already says _Running a work item_ and names
the key, and it says "hosted" nowhere.

## Updating an agent to a newer image (delta, MOTIR-6951)

**Design system — read before drawing.** `package.json` depends on `@motir/design-system`
(`workspace:*`) and `app/globals.css` line 13 imports `@motir/design-system/theme.css`, so the
project is **on Motir Design** (branch (a)). This delta reuses the area's own markup and tokens, at
the axes the panel mock was drawn at. No part was missing from the package.

**What it amends.** `my-agents--update.mock.html` is a delta on `my-agents--panel.mock.html`
(MOTIR-6937, approved version `cmun5qu1f005qhwoiq14livtw`), which is itself a delta on
`my-agents.mock.html` (MOTIR-6868). Neither is edited.

- **Composed, not redrawn:**
  - the panel mock's five style blocks and icon symbols, verbatim;
  - the list table and narrow cards;
  - the agent panel: its header, tab row, terminal, the refusal box (rose for a stop, peach for a
    wait), the `.reason` line, and the dialog shape of the Delete confirmation;
  - the narrow-width layout (MOTIR-6937 panel 7);
  - the image-too-old face (panel 6).
- **Its own:** one small style block, with the version line, the update marker, and the header
  wrap that lets three actions fit the half-width panel. Plus two icons (`i-arrow-up-circle`,
  `i-refresh`). Only `--el-*` and shape tokens are used, and no colour is invented.

**Every state is decided in `docs/decisions/agent-image-update.md` (MOTIR-6948).** The update
operation that produces each state is [MOTIR-6952](motir:cmun6el6a00g4hwoibmcyr4uv).

| #   | state                                                                                                       | where         | decision                    | mock panel |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------- | --------------------------- | ---------- |
| 1   | Up to date: version only, no marker, no Update                                                              | row, header   | Q1                          | 1A, 1C     |
| 2   | Update available → version: marker, Update enabled                                                          | row, header   | Q1                          | 1A, 1B     |
| 3   | Could not check for updates: a grey chip, never "up to date"                                                | row, header   | Q1                          | 1A, 1D     |
| 4   | Confirm: both versions, what is kept, restart vs next wake                                                  | dialog        | Q2, Q5                      | 3          |
| 5   | Updating: busy tone, terminal Reconnecting…, all actions disabled                                           | row, header   | Q6                          | 2, 4       |
| 6   | Updated, hibernated: "version on next wake"                                                                 | row, header   | Q5                          | 2, 5       |
| 7   | Refused: run active (names and links the run), already newest, transitional state, could not check (a wait) | panel         | Q8                          | 6          |
| 8   | Failed and rolled back: previous version, the reason in words, Update still offered                         | row, header   | Q4                          | 2, 7       |
| 9   | Image too old: the call to action becomes Update to version                                                 | terminal area | Q3 (`agent-terminal.md` Q8) | 8          |
| 10  | Narrow width: the marker under the meta line, Update first among the wrapped actions                        | panel, cards  | —                           | 9          |

**The access path.**

- **On the row:** the version sits in the **Coding agent** cell (mono, `--el-text-secondary`), with
  the marker beside it. The whole row is still the door to the panel (MOTIR-6937 panel 1).
- **In the panel header:** **Update** is the FIRST action, before Hibernate and Delete. It shows
  only while an update is available, and it opens the confirmation.
- **The marker** is `--el-tint-sky` with `--el-text-strong` text (AA on the tint). The
  next-wake marker is `--el-tint-lavender`. The could-not-check chip is `--el-surface-soft` with
  `--el-text-secondary`.
- **Updating** uses the busy tone Waking already uses (`t-running`).

**Copy — en and zh.** `{name}` is the agent's name, `{from}` and `{to}` the two versions, `{key}`
the run's work item.

| key (proposed `myAgents.update.*`) | en                                                                                                                                       | zh                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `available`                        | Update available → {to}                                                                                                                  | 可更新 → {to}                                                                        |
| `unknown`                          | Could not check for updates                                                                                                              | 无法检查更新                                                                         |
| `nextWake`                         | {to} on next wake                                                                                                                        | 下次唤醒时更新到 {to}                                                                |
| `state.updating`                   | Updating                                                                                                                                 | 更新中                                                                               |
| `action`                           | Update                                                                                                                                   | 更新                                                                                 |
| `actionTo`                         | Update to {to}                                                                                                                           | 更新到 {to}                                                                          |
| `confirm.title`                    | Update {name} to {to}?                                                                                                                   | 将 {name} 更新到 {to}？                                                              |
| `confirm.introRunning`             | {from} → {to}. The agent restarts on the new version, which takes about a minute. It keeps:                                              | {from} → {to}。智能体将以新版本重启，大约需要一分钟。以下内容会保留：                |
| `confirm.introHibernated`          | {from} → {to}. It stays asleep and takes the new version the next time it wakes. It keeps:                                               | {from} → {to}。它会保持休眠，下次唤醒时使用新版本。以下内容会保留：                  |
| `confirm.keep1`                    | its home and every file in it, including the cloned repositories;                                                                        | 主目录及其中的所有文件，包括克隆的仓库；                                             |
| `confirm.keep2`                    | its coding agent’s sign-in;                                                                                                              | 编码智能体的登录状态；                                                               |
| `confirm.keep3`                    | its chat sessions.                                                                                                                       | 聊天会话。                                                                           |
| `confirm.rollback`                 | If the new version doesn’t start, the agent goes back to {from} and tells you why.                                                       | 如果新版本无法启动，智能体会回到 {from} 并告诉你原因。                               |
| `confirm.rollbackWake`             | If the new version doesn’t start at that wake, the agent goes back to {from} and tells you why.                                          | 如果新版本在那次唤醒时无法启动，智能体会回到 {from} 并告诉你原因。                   |
| `confirm.notNow`                   | Not now                                                                                                                                  | 暂不                                                                                 |
| `confirm.running`                  | Update and restart                                                                                                                       | 更新并重启                                                                           |
| `confirm.hibernated`               | Update on next wake                                                                                                                      | 下次唤醒时更新                                                                       |
| `updating.title`                   | Updating to {to}                                                                                                                         | 正在更新到 {to}                                                                      |
| `updating.body`                    | The agent is restarting on the new version. Your home and sign-in stay where they are.                                                   | 智能体正在以新版本重启。你的主目录和登录状态保持不变。                               |
| `hibernated.body`                  | This agent is asleep. It moves to {to} when it wakes.                                                                                    | 该智能体正在休眠，唤醒时会更新到 {to}。                                              |
| `refused.runActive`                | {name} is running <link>{key}</link>. Cancel that run on the work item first, then update it.                                            | {name} 正在运行 <link>{key}</link>。请先在工作项上取消该运行，然后再更新它。         |
| `refused.upToDate`                 | This agent already runs the newest version ({to}).                                                                                       | 该智能体已经是最新版本（{to}）。                                                     |
| `refused.state`                    | This agent is {state}, so it can’t be updated right now.                                                                                 | 该智能体当前{state}，暂时无法更新。                                                  |
| `refused.unknown`                  | Motir couldn’t check for a newer version just now. Try again in a few minutes.                                                           | Motir 暂时无法检查新版本。请几分钟后重试。                                           |
| `rolledBack`                       | The update to {to} didn’t work: {reason}. Your agent is back on {from}.                                                                  | 更新到 {to} 未成功：{reason}。你的智能体已回到 {from}。                              |
| `imageTooOld.body`                 | It was made from an older image, from before the terminal existed. Update it to {to} to get the terminal. Its home and sign-in are kept. | 它基于终端出现之前的旧镜像创建。更新到 {to} 即可使用终端，主目录和登录状态都会保留。 |

**Wording notes.**

- The run-active refusal reuses the panel's existing run-refusal sentence shape
  (`myAgents.panel.run.refusedHibernate`, MOTIR-7022), so Hibernate, Delete and Update say it the
  same way.
- The could-not-check refusal follows MOTIR-6916's register for a wait ("Try again in a few
  minutes").
- `{reason}` is the server's words (`updateFailureReason`), shown as sent.
- If the rollback itself fails, the agent is `Failed` with that reason and Wake: MOTIR-6937 panel
  4's failed face, unchanged.

**Does NOT draw:**

- the page outside the agent row and the panel header;
- the terminal's own states, which stay MOTIR-6937 panel 5's;
- any surface for choosing a version other than the newest (decision Q1: none is offered).

## Watching an agent boot — the boot read-out (delta, MOTIR-7395)

**Story MOTIR-7393 · design MOTIR-7395.** Gates **MOTIR-7400** (the panel, the list row and the
strings). Mock: **`design/my-agents/my-agents--boot.mock.html`**, a DELTA, eleven labelled panels.

**What it amends.** Neither amended mock is edited; both stay records.

- **`design/my-agents/my-agents.mock.html` (MOTIR-6868)** — **Panel 2 THE CREATE DIALOG**, whose
  pending state lasted the whole boot (the button's loading face while the server waited), and
  **Panel 4 EVERY STATE**, where `starting` and `waking` were one fixed line
  (`myAgents.progress.starting` / `progress.waking`). In this file: § _Panel 2 — THE CREATE DIALOG_
  and § _Panel 4 — EVERY STATE_ above.
- **`design/my-agents/my-agents--panel.mock.html` (MOTIR-6937)** — **Panel 2 THE HEADER** (Delete…
  drawn disabled in `starting` / `waking`), **Panel 3 SIGN-IN** (no sign-in line before the terminal
  connects — unchanged, restated here because the read-out sits where a reader might look for it), and
  **Panel 4 EVERY LIFECYCLE VALUE**, where `starting` showed _Booting — cloning the project's
  repositories into the home_ under the connection word _Waiting_. In this file: § _The agent panel_ →
  _Panel 2 — THE HEADER_, _Panel 3 — SIGN-IN STATUS_, _Panel 4 — EVERY LIFECYCLE VALUE_.

**Every state is decided in `docs/decisions/agent-instances.md` AMENDMENT 6 (MOTIR-7394)**: the five
steps `provision` · `machine_start` · `clone` (one row per repository, `owner/name`, in the project's
order) · `terminal_check` · `ready`; the five states `waiting` · `in_progress` · `done` · `failed` ·
`skipped`; a wake writes its clone rows `skipped`; a deletion mid-boot writes the step in progress
`failed` with detail `deleted`; the stream's terminal `done` frame is `running` | `failed` |
`deleted`. AMENDMENT 4 (Delete from a boot) and AMENDMENT 5 (the exit code, the 10-minute deadline)
supply the rest. The copy is this card's.

**Composed, not redrawn.** The mock's first five `<style>` blocks and its icon symbols are
`my-agents--panel.mock.html`'s own, verbatim (as `my-agents--update.mock.html` carries them). The
cards, table, agent panel, dialog, refusal box and `.reason` line are that asset's markup; the
Terminal + Chat tab track is `my-agents--chat.mock.html`'s (`.tabOff`, copied), as the panel ships
today. One block of its own adds the read-out (`.boot`, `.bStep`, `.bootSum`), and the create
dialog's picker and price line drawn from base panel 2's notes (`.radioRow`, `.priceLine`). Only
`--el-*` and shape tokens; no colour is invented.

| Panel | What it settles                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | the access path: New agent → dialog → Create → dialog gone, row `starting`, panel open, `?agent=<id>`; the refused create, unchanged |
| 2     | the read-out in progress — each state's glyph and ink; the live clock                                                                |
| 3     | mid-clone: the first repository done, the second in progress (then the terminal check)                                               |
| 4     | failed on a repository: the reason under it, the rows after it waiting, the way out                                                  |
| 5     | failed on machine started (exit code); failed on the deadline                                                                        |
| 6     | failed on provisioning: the provider's words on the first row                                                                        |
| 7     | a wake: both clone rows skipped; a deployment with no terminal (terminal check skipped)                                              |
| 8     | deleted mid-boot: the last word, the panel fading, the list row in Deleting                                                          |
| 9     | running: the one-line summary above the tabs; Show steps / Hide steps                                                                |
| 10    | the list row while booting: the current step instead of the fixed line (table and narrow card)                                       |
| 11    | the narrow width: the read-out under the header; a long repository name wraps, never truncates                                       |

### Panel 1 — THE ACCESS PATH

- **Unchanged up to the press.** The header's **New agent** opens the create dialog (base panel 2),
  with its fields, its picker and its price line untouched.
- **Create's pending face** is still the `Button`'s own `loading`. It now lasts only until the create
  answers `201` at `starting` (AMENDMENT 6 §5), about a second, rather than the length of the boot.
- **On the answer:** the dialog **closes**, the list gains the new row in _Starting_ (newest first,
  selected), and the panel opens on it. The address becomes `/my-agents?agent=<id>` by the same
  `replace` a row click makes (MOTIR-6937 panel 1), and focus moves to the panel's name heading.
- **A refused create is unchanged:** the dialog stays open with the input kept, and the refusal box
  (base panel 5) sits above the footer. Nothing boots, so there is no read-out.
- **A provisioning failure is NOT a refusal.** The agent exists, so the dialog closes and the panel
  opens on panel 6's read-out.
- **A wake** (the panel's **Wake**, the row menu's **Wake**, or opening a hibernated agent —
  MOTIR-6937 Q6) opens the same read-out, headed _Waking_ (panel 7).

### The read-out — where it sits and what it is

- **Placement.** A `<section aria-label="Boot steps">` between the panel header and the tab row, on the
  card's own ground (`--el-card`), `--spacing-card-padding`, with an `--el-border-soft` rule under it.
  The tab track (Terminal, Chat) and the connection word stay below it, as shipped.
- **The head.** The left side reads **Booting** (create) or **Waking** (wake): 0.8125rem, 600,
  `--el-text`. On the right is the whole attempt's clock, ticking (`0:44`): mono 0.75rem,
  `--el-text-secondary`. Once the attempt has failed, the head reads **Failed after {time}** and the
  clock is gone.
- **The rows.** An `<ol>`, one `<li>` per step: glyph · label · time, with an optional detail line
  under the label. Each row is a grid (16px · 1fr · auto) with `--spacing-control-y/x` padding and
  `--radius-control`, and a 1px border that is transparent except on a failed row, so a failure
  shifts nothing.
- **The terminal area under it** keeps its shipped face. While booting it shows _The terminal opens
  here as soon as the agent is up._ (`panel.face.startingHint`, reused for a wake too). Once failed it
  shows _The terminal stays closed until the agent is running._ The old progress title (_Booting —
  cloning…_) leaves the terminal area: the read-out is the panel's only progress.
- **Screen readers.** Every row carries its state in words (`.visually-hidden` _— Done_, etc.). A
  polite live region announces **a change of state only** (_Cloning moooon/motir-ai: in progress_),
  never the clock's ticks. The clocks are `aria-hidden`.
- **The data** is the boot read (`GET …/instances/[id]/boot`), then the stream
  (`…/boot/stream?since=<seq>`). A reload resumes from the read, with no gap (AMENDMENT 6 §6–7).
- **An agent with no recorded attempt** (one booted before AMENDMENT 6) shows MOTIR-6937 panel 4's
  face for its state, unchanged.

### Every state of a row — glyph, ink, time

| State           | Glyph (lucide, `aria-hidden`) | Glyph colour          | Row ground                          | Label ink                                          | Time column                                                                          |
| --------------- | ----------------------------- | --------------------- | ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **waiting**     | `Circle` (hollow)             | `--el-text-secondary` | card                                | `--el-text-secondary`, 400                         | empty. Quiet                                                                         |
| **in progress** | `LoaderCircle`                | `--el-text-strong`    | **`--el-tint-sky`**                 | `--el-text-strong`, 600                            | a **ticking clock** `m:ss` (`0:41`), mono, `--el-text-strong`                        |
| **done**        | `CircleCheck`                 | `--el-success`        | card                                | `--el-text-secondary`, 400                         | its duration (`3s`, `38s`, `1m 04s`), mono, `--el-text-secondary`. Quiet             |
| **failed**      | `CircleX`                     | `--el-danger`         | card + **1px `--el-danger` border** | `--el-text`, 600; reason `--el-text`, 400, 0.75rem | how long it ran before failing, mono, `--el-text`                                    |
| **skipped**     | `CircleMinus`                 | `--el-text-secondary` | card                                | `--el-text-secondary`, **struck through**          | the reason in words (_Skipped — a wake keeps the home_), sans, `--el-text-secondary` |

- **Live without animating colour.** The in-progress row is the only tinted row. What reads as live is
  its **clock**, which ticks every second from the step's `startedAt`, plus the loader's **rotation**,
  a `transform` that stops under `prefers-reduced-motion`. No colour, tint or opacity ever animates.
- **Failed carries the hue in the border and the glyph only.** The label and the reason stay on
  `--el-text` on the card ground, which is AA in all 20 palette × theme combinations. That is the
  composition CLAUDE.md names (`DeviceApproval`). No danger TEXT token is used on the row, and
  `--el-danger-text` is used nowhere.
- **Ink audit.** `--el-text-muted` and `--el-text-faint` are used **nowhere** in this delta.
  `--el-text-secondary` is the quiet ink on the card, and `--el-text-strong` is the ink on the sky
  tint. The only `:hover` rules are the copied Chat tab's (`--el-text` on `--el-surface-soft`) and the
  _Show steps_ link's underline (`--el-link`, no ground change).
- **The repository name** is mono 0.75rem with `overflow-wrap: anywhere`. It wraps and is **never
  truncated** (panel 11).
- **Durations.** A finished step shows `{s}s` under a minute and `{m}m {ss}s` from a minute on. The
  in-progress clock shows `m:ss`. The summary uses the finished form.

### Panels 4–6 — FAILED, and the way out

- **The read-out ends on the failed row.** The rows after it stay _waiting_ (§1).
- **The reason** is the step's `detail`, which is also the agent's `failureReason`. The list row
  therefore keeps its shipped failed line (`failureReason` + `failedWayOut`, `--el-danger-on-surface`),
  unchanged.
- **The reasons Motir writes itself** get keys (below):
  - _Could not read {repository} — the app has no access_;
  - _The machine exited during boot (exit code {code})_ (AMENDMENT 5);
  - _The boot didn't finish within {minutes} minutes_ (AMENDMENT 5's deadline, on the step in
    progress).
- **The provider's own words** (panel 6, on `provision`) are shown **as sent**, never rewritten.
- **The way out** is a row under the steps (`.bootFoot`): the shipped sentence _Wake to try again, or
  delete it._ (`failedWayOut`, `--el-text`), then **Wake** (`Button` primary, `Power`, `--el-accent`
  / `--el-accent-text`) and **Delete…** (`Button` secondary, `Trash2`, `--el-danger-on-surface` ink,
  opening the page's `DeleteAgentDialog`). They wrap under the sentence at the narrow width.

### Panel 7 — A WAKE

- **Same rows**, headed _Waking_. Both `clone` rows are **skipped**: struck through, `CircleMinus`,
  with _Skipped — a wake keeps the home_ in the time column. The repositories stay listed, so the
  reader sees what the home already holds.
- Where the deployment has no terminal, _Terminal checked_ is skipped too, with _Skipped — no terminal
  on this deployment_.
- The header pill is _Waking_ (`t-running`), and the connection word is _Waiting_ with the busy dot,
  as shipped.

### Panel 8 — DELETED MID-BOOT

- **Delete… is ENABLED while `starting` / `waking`.** This corrects MOTIR-6937 panel 2's drawing to
  AMENDMENT 4. The shipped header already reads `allowedAgentMoves`, so the code needs no change.
- **On the confirm,** the step in progress becomes _failed · deleted_, and the stream sends
  `done · deleted`. That last frame is drawn: the head becomes **Deleted — this panel closes**, and the
  step reads _Deleted while booting_.
- **A deletion is the reader's own act, not a fault**, so this row takes **no danger hue**. It is
  drawn like a skipped row: struck through, `CircleMinus`, `--el-text-secondary`, with the time it ran.
- **Then the panel fades and closes** exactly as MOTIR-6937 panel 4's _deleting_ does. The address
  drops `?agent=`, and the row keeps _Deleting_ and its shipped line until it is gone.

### Panel 9 — RUNNING

- **On `done · running`** the read-out collapses to ONE line (`.bootSum`, `--spacing-control-y` /
  `--spacing-card-padding`, `--el-border-soft` rule) above the tab row. The line holds:
  - a `CircleCheck` in `--el-success`;
  - **Booted in {time}** (a wake: **Woke in {time}**) in `--el-text-secondary`;
  - on the right, **Show steps** (`--el-link`, `ChevronDown`), which reopens the finished rows in
    place and becomes **Hide steps** (`aria-expanded`).
- The terminal connects as it does today and shows its prompt, and **Hibernate** appears.
- The line belongs to the CURRENT attempt. It stays while the agent runs, and the next wake's
  read-out replaces it.

### Panel 10 — THE LIST ROW WHILE BOOTING

- **The fixed line goes.** The line under the name (`.progressNote`, 0.75rem, `--el-text-secondary`)
  is the **current step** in its in-progress form, with an ellipsis: _Provisioning the machine…_,
  _Starting the machine…_, _Cloning {repository}…_, _Checking the terminal…_, _Getting ready…_.
- **It has no clock.** The list compares agents; the panel watches one.
- **The same lines serve `waking`.** Before the first read answers, the row falls back to the shipped
  `progress.starting` / `progress.waking`.
- **The narrow card** carries the same line.

### Panel 11 — THE NARROW WIDTH

- **Order.** MOTIR-6937 panel 7's full view: crumb, header (its actions wrapped under the name), then
  the **read-out**, then the tab row and the terminal.
- **Wrapping.** Rows wrap. A long `owner/name` breaks anywhere, never ellipsises, and the time stays
  on the row's first line. A reason wraps under its label.

### Tokens

| Element                     | Primitive                    | Colour                                                                        | Shape                                                                    |
| --------------------------- | ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| read-out section            | `<section>` in the panel     | card ground, `--el-border-soft` rule                                          | `--spacing-card-padding`                                                 |
| head / clock                | text                         | `--el-text` / `--el-text-secondary`                                           | —                                                                        |
| step row                    | `<li>` grid                  | per the state table                                                           | `--spacing-control-y/x`, `--radius-control`                              |
| in-progress row             | tinted `<li>`                | `--el-tint-sky`, `--el-text-strong`                                           | as above                                                                 |
| failed row                  | bordered `<li>`              | `--el-danger` border + glyph; `--el-text` words                               | as above                                                                 |
| way out                     | `Button` primary + secondary | `--el-accent` / `--el-accent-text`; `--el-danger-on-surface`                  | `--height-btn-sm`, `--radius-btn`, `--spacing-btn-x-sm`                  |
| summary line                | row                          | `--el-success` glyph, `--el-text-secondary`, `--el-link` toggle               | `--spacing-control-y` / `--spacing-card-padding`                         |
| list row line               | `.progressNote`              | `--el-text-secondary`                                                         | —                                                                        |
| tab track (Terminal + Chat) | the shipped track            | `--el-tabnav-track`, `--el-text-strong` on `--el-page-bg`; off tab secondary  | `--radius-btn`                                                           |
| dialog (unchanged)          | `Modal`, `RadioGroup`        | `--el-tint-lavender` + `--el-accent` selected row, `--el-tint-sky` price line | `--radius-modal`, `--radius-input`, `--height-input`, `--radius-control` |

### Copy — en and zh

Every new string, proposed under `myAgents.boot.*`. `{repository}` is `owner/name`, `{time}` a
duration, `{code}` an exit code.

| key                         | en                                                    | zh                                       |
| --------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| `boot.label`                | Boot steps                                            | 启动步骤                                 |
| `boot.title.create`         | Booting                                               | 正在启动                                 |
| `boot.title.wake`           | Waking                                                | 正在唤醒                                 |
| `boot.title.failed`         | Failed after {time}                                   | {time} 后失败                            |
| `boot.title.deleted`        | Deleted — this panel closes                           | 已删除 — 此面板即将关闭                  |
| `boot.step.provision`       | Machine provisioned                                   | 分配机器                                 |
| `boot.step.machineStart`    | Machine started                                       | 启动机器                                 |
| `boot.step.clone`           | Cloning {repository}                                  | 克隆 {repository}                        |
| `boot.step.terminalCheck`   | Terminal checked                                      | 检查终端                                 |
| `boot.step.ready`           | Ready                                                 | 就绪                                     |
| `boot.state.waiting`        | Waiting                                               | 等待中                                   |
| `boot.state.inProgress`     | In progress                                           | 进行中                                   |
| `boot.state.done`           | Done                                                  | 完成                                     |
| `boot.state.failed`         | Failed                                                | 失败                                     |
| `boot.state.skipped`        | Skipped                                               | 已跳过                                   |
| `boot.announce`             | {step}: {state}                                       | {step}：{state}                          |
| `boot.skipped.clone`        | Skipped — a wake keeps the home                       | 已跳过 — 唤醒会保留主目录                |
| `boot.skipped.terminal`     | Skipped — no terminal on this deployment              | 已跳过 — 此部署没有终端                  |
| `boot.detail.cloneNoAccess` | Could not read {repository} — the app has no access   | 无法读取 {repository} — 应用没有访问权限 |
| `boot.detail.exited`        | The machine exited during boot (exit code {code})     | 机器在启动过程中退出（退出码 {code}）    |
| `boot.detail.deadline`      | The boot didn’t finish within {minutes} minutes       | 启动未能在 {minutes} 分钟内完成          |
| `boot.detail.deleted`       | Deleted while booting                                 | 在启动过程中被删除                       |
| `boot.summary.create`       | Booted in {time}                                      | 启动用时 {time}                          |
| `boot.summary.wake`         | Woke in {time}                                        | 唤醒用时 {time}                          |
| `boot.showSteps`            | Show steps                                            | 显示步骤                                 |
| `boot.hideSteps`            | Hide steps                                            | 隐藏步骤                                 |
| `boot.duration.seconds`     | {s}s                                                  | {s} 秒                                   |
| `boot.duration.minutes`     | {m}m {s}s                                             | {m} 分 {s} 秒                            |
| `boot.row.provision`        | Provisioning the machine…                             | 正在分配机器…                            |
| `boot.row.machineStart`     | Starting the machine…                                 | 正在启动机器…                            |
| `boot.row.clone`            | Cloning {repository}…                                 | 正在克隆 {repository}…                   |
| `boot.row.terminalCheck`    | Checking the terminal…                                | 正在检查终端…                            |
| `boot.row.ready`            | Getting ready…                                        | 即将就绪…                                |
| `boot.terminalClosed`       | The terminal stays closed until the agent is running. | 智能体运行后终端才会打开。               |

**Reused unchanged:** `failedWayOut`, `panel.wake`, `panel.delete`, `panel.face.startingHint`,
`panel.conn.waiting` / `panel.conn.closed`, `progress.starting` / `progress.waking` (only as the row's
fallback before the first read), `progress.deleting`, `state.*`, and every `create.*` /
`refusal.*` string.

**Wording notes.**

- **The step labels are the card's**, so in English they read as past participles even on a waiting
  row. The zh labels are neutral verb–object phrases (分配机器 · 启动机器 · 克隆 …), which read
  correctly in every state.
- **The provider's words** (`provision` failed) and any `detail` Motir does not key are shown
  verbatim.
- **The deadline's minutes** come from `INSTANCE_BOOT_DEADLINE_MS`, never hard-coded.

### GIVES / TAKES

- **GIVES MOTIR-7400:**
  - the create flow closing on the answer;
  - the read-out (placement, the five row states and their glyphs, inks and times, the head and
    clock, screen-reader words and the live region);
  - the failed read-outs and their way out, the wake, and the deletion's last word;
  - the running summary with Show / Hide steps;
  - the booting list row and the narrow width;
  - every string above, en and zh.
- **TAKES from MOTIR-7394:** the steps, states, attempt, read and stream. **TAKES from MOTIR-6868 /
  MOTIR-6937:** the dialog, rows, cards, pills, header, tab track, terminal faces and refusal box,
  unchanged.
- **Does NOT draw:** the terminal and chat tabs themselves, the `updating` state (MOTIR-6951), or the
  hibernate states.

---

## Waiting for room — an agent that cannot start yet (delta)

Mock: **`design/my-agents/my-agents--waiting-for-room.mock.html`**, a DELTA, seven labelled panels.

**Design system.** Read first: the root `package.json` (no `@motir/design-system` dependency) and
`app/globals.css` (no `@motir/design-system/theme.css` import). Verdict: this project is **on its
own system** — the `components/ui/*` primitives and the `--el-*` / shape tokens of `app/globals.css`
— exactly as every other surface in this area. Nothing is proposed for any other package.

**What it amends.** Neither amended mock is edited; both stay records.

- **`design/my-agents/my-agents--boot.mock.html`** — § _Watching an agent boot — the boot read-out_
  above: **Panel 1 THE ACCESS PATH** (the row after Create, the Wake that opens a read-out),
  **Panel 2** (the read-out in progress), **Panel 7 A WAKE** and **Panel 10 THE LIST ROW WHILE
  BOOTING**. This delta adds one step in front of that read-out's five, and a status label and row
  line for it. Every other row state, the head, the clock, the failed read-outs, the running summary
  and the deletion's last word are that section's, unchanged.
- **`design/my-agents/my-agents--panel.mock.html`** — § _The agent panel_ → the row menu and the
  header's actions: the same three moves, with their enablement while waiting stated here.

**The behaviour it draws.** When there is no machine free for agents right now, a new agent is not
refused and does not fail: it **waits**, and is created as soon as room appears. A hibernated agent
being woken keeps its files in one place, so it waits for room **there**, and nowhere else. Waiting
is never failing, is never turned into a failure by time alone, and is never answered by offering
another place or kind of machine to run on.

**Composed, not redrawn.** The mock's style blocks and icon symbols are
`my-agents--boot.mock.html`'s own, verbatim. One block of its own adds the waiting step
(`.isWaitRoom`, `.bReason`, `.bCase`, `.bSince`), the open row menu (`.menuBox`, `.menuItem`) and the
disabled-with-tooltip pattern `my-agents--chat.mock.html` draws for a disabled tab (`.tabTip`). Two
lucide symbols are added: `Hourglass` and `Ban`. Only `--el-*` and shape tokens; no colour is
invented.

| Panel | What it settles                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------ |
| 1     | the access path: the agent row with its **Waiting** label after Create; Wake leading into a wait |
| 2     | create, waiting · wake, waiting — the two reasons side by side                                   |
| 3     | waiting for a long time — the since-time line                                                    |
| 4     | room appeared — the step turns done and the boot carries on (create and wake)                    |
| 5     | actions while waiting — the row menu, the disabled Terminal tab, the disabled agent in a picker  |
| 6     | waiting is not failed — a waiting read-out beside a genuine failure, which is unchanged          |
| 7     | the narrow width — the reason wraps under the label                                              |

### The elements, by name

- **THE WAITING STEP ROW.** The FIRST row of the boot read-out, above _Machine provisioned_, labelled
  **Waiting for room**. It takes the in-progress row's ground and ink — `--el-tint-sky`,
  `--el-text-strong`, 600 — so it reads as under way. Its glyph is lucide `Hourglass` in
  `--el-text-strong`, and it does **not** rotate: nothing is being worked on yet. Its time column is
  the step's ticking clock (`m:ss`, mono), as any in-progress row's. The rows after it are
  _waiting_; on a wake the clone rows are _skipped_, as in any wake.
- **THE REASON LINE.** Directly under the label, inside the row: one or two plain sentences, 0.8125rem,
  400, `--el-text-strong` on the sky tint. One text for a new agent and one for a woken agent (copy
  below). It never names a provider, a machine type, an account, a region or a limit code.
- **THE DETAIL LINE.** Under the reason: a few words saying which case applies, 0.75rem, 500, same ink.
- **THE SINCE LINE.** From ten minutes of waiting on, one more line under the detail line: an `Info`
  glyph and _Waiting for {minutes} minutes — Motir keeps trying by itself._ Same ink, same ground.
  Nothing turns red, nothing blinks, and no retry button is drawn, because nothing needs pressing.
- **THE STATUS LABEL.** The agent's pill reads **Waiting** in the neutral tone — the muted ground
  with the to-do dot (`t-queued`: `--el-muted`, `--el-status-todo`), the tone _Hibernating_ and
  _Deleting_ already take. It is neither the sky of _Starting_ / _Waking_ nor the mint of _Running_
  nor the rose of _Failed_. The panel header's pill and the list row's pill both read it.
- **THE ROW LINE.** Under the agent's name in the list: _Waiting for room…_ (new) or _Waiting for
  room to wake…_ (woken), `.progressNote`, `--el-text-secondary`, no clock (the list compares
  agents; the panel watches one).

### The states

| State                        | Drawn | What it shows                                                                                                                                                               |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| create, waiting              | 2 A   | the waiting row with the new-agent reason and detail; pill **Waiting**; meta line is the coding agent and project only — no machine details yet                             |
| wake, waiting                | 2 B   | the waiting row with the woken-agent reason (its files live in one place, they are safe); pill **Waiting**; clone rows skipped                                              |
| waiting for a long time      | 3     | the same row plus the since line; the clock keeps ticking; no error colour, no retry                                                                                        |
| room appeared                | 4     | the row becomes a **done** row labelled **Room found** with how long it waited; reason and detail go; the next step goes in progress; pill returns to _Starting_ / _Waking_ |
| actions while waiting        | 5     | Wake and Hibernate disabled (not hidden); Delete… enabled, with the line under it; Terminal tab and running work disabled, reason as tooltip                                |
| failed                       | 6     | a genuine failure keeps the boot read-out's failed look unchanged; a full pool never produces it                                                                            |
| loading / empty of the panel | —     | **unchanged** from the boot read-out — not redrawn                                                                                                                          |
| narrow width                 | 7     | the reason and detail wrap under the label; the time stays on the row's first line                                                                                          |
| dark theme                   | —     | the same semantic tokens; the mock flips with `data-theme` on its root like every mock in this area                                                                         |

**Head and clocks.** The read-out's head reads **Booting** (create) or **Waking** (wake), unchanged.
Its clock counts the whole attempt, the wait included, and the running summary's _Booted in {time}_
is over that same span. The boot deadline starts when the machine is being created, not while the
agent waits for room.

**Screen readers.** The row carries its state in words (`.visually-hidden` _— Waiting for room_), and
the polite live region announces _Waiting for room: in progress_ once, then _Waiting for room: done_
when room is found — never the clock's ticks.

### Actions while waiting

- **Row menu** (the shipped `AgentRowMenu`): **Wake** and **Hibernate** disabled, **Delete…**
  enabled. Under Delete…, one line in `--el-text-secondary`: _Deleting it stops the wait. Nothing was
  created yet._ (new) / _Deleting it stops the wait and deletes its files._ (woken — its files exist).
- **Panel header:** **Delete…** enabled, opening the shipped delete dialog. A wait is cancelled by
  deleting; there is no separate Cancel.
- **Terminal tab:** disabled (`Ban` glyph, `--el-text-secondary`, `aria-disabled`), its reason as
  its tooltip on hover and keyboard focus (`--el-tooltip-bg` / `--el-tooltip-text`,
  `--radius-control`, `--spacing-tooltip-x/y`), and in words for a screen reader.
- **Running work in this agent** (the work item's agent picker, which lives in the runs area): the
  waiting agent is shown disabled, with its reason as the tooltip.

### Waiting is never failed, and no alternative is offered

- The waiting row never takes `--el-danger` in any form, never reads _Failed_, and never shows the
  way-out row (_Wake to try again, or delete it._). A full pool never produces the failed state.
- No other place or kind of machine is offered, and no button to try elsewhere. The agent waits and
  starts on its own once there is room.

### Tokens

| Element          | Primitive                  | Colour                                                                                                         | Shape                                                                                               |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| waiting step row | `<li>` grid (the step row) | `--el-tint-sky` ground, `--el-text-strong` label and glyph                                                     | `--spacing-control-y/x`, `--radius-control`                                                         |
| reason line      | text in the row            | `--el-text-strong`, 400                                                                                        | —                                                                                                   |
| detail line      | text in the row            | `--el-text-strong`, 500                                                                                        | —                                                                                                   |
| since line       | text + `Info` glyph        | `--el-text-strong`, 400                                                                                        | —                                                                                                   |
| room-found row   | the done step row          | `--el-success` glyph, `--el-text-secondary`                                                                    | as above                                                                                            |
| status label     | `runPill` (`RunTonePill`)  | `--el-muted` ground, `--el-status-todo` dot, `--el-text-strong`                                                | `--radius-badge`, `--spacing-chip-x/y`                                                              |
| row line         | `.progressNote`            | `--el-text-secondary`                                                                                          | —                                                                                                   |
| row menu         | `Popover` + menu items     | `--el-card`, `--el-border`; items `--el-text`, disabled `--el-text-secondary`, Delete `--el-danger-on-surface` | `--radius-card`, `--height-control`, `--spacing-control-x`, `--radius-control`, `--shadow-elevated` |
| disabled tab     | the shipped tab track      | `--el-text-secondary`, `Ban` glyph                                                                             | `--radius-btn`                                                                                      |
| tooltip          | the shipped tooltip        | `--el-tooltip-bg` / `--el-tooltip-text`                                                                        | `--radius-control`, `--spacing-tooltip-x/y`, `--shadow-elevated`                                    |

**Ink audit.** `--el-text-muted` and `--el-text-faint` are used nowhere in this delta, and no danger
TEXT token is used. The only danger ink is the row menu's Delete… (`--el-danger-on-surface`) and the
unchanged failed read-out of panel 6 B.

### Copy — proposed, en

`{minutes}` is a whole number of minutes; `{time}` the read-out's finished-duration form.

| element                                | en                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| waiting step label                     | Waiting for room                                                                                        |
| waiting step label, once room is found | Room found                                                                                              |
| reason — a new agent                   | All machines for agents are in use right now. Yours will be created as soon as there is room.           |
| reason — a woken agent                 | This agent’s files live in one place, so it waits for room there. Your files and your sign-in are safe. |
| detail — a new agent                   | A new agent — it starts wherever room frees up first.                                                   |
| detail — a woken agent                 | Waking — it can only start where its files are.                                                         |
| since line                             | Waiting for {minutes} minutes — Motir keeps trying by itself.                                           |
| status label                           | Waiting                                                                                                 |
| row line — a new agent                 | Waiting for room…                                                                                       |
| row line — a woken agent               | Waiting for room to wake…                                                                               |
| row menu note — a new agent            | Deleting it stops the wait. Nothing was created yet.                                                    |
| row menu note — a woken agent          | Deleting it stops the wait and deletes its files.                                                       |
| Terminal tab tooltip                   | The terminal opens once the agent is running. It’s waiting for room.                                    |
| running work tooltip                   | This agent can run work once it’s running. It’s waiting for room.                                       |
| live region                            | Waiting for room: in progress · Waiting for room: done                                                  |

**Wording notes.** The reader sees "no room right now", never an error: no _failed_, _error_,
_quota_, _limit_ or _capacity_, and no provider, machine-type or account names. The reason is chosen
by the kind of refusal behind it (no room anywhere for a new agent; no room where its files are for a
woken one) and never carries an identifier. Translations into the other locales are the build's.

### GIVES / TAKES

- **GIVES** the build: the waiting step row, the reason line, the detail line, the since line, the
  status label and the row line, the room-found row, the actions while waiting, and every string
  above.
- **TAKES** from § _Watching an agent boot_: the read-out, its rows, head, clock, failed look,
  running summary and narrow-width order. **TAKES** from § _The agent panel_: the header, the row
  menu, the tab track and the terminal faces, unchanged.
- **Does NOT draw:** a new screen or route, the platform fleet view, the admin pool views, or any
  provider-specific information.
