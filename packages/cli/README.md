# `@motir/cli` — the `motir` command-line tool

Terminal dispatch of the Motir work loop. The CLI is a client of **Motir's
public REST API** (`/api/v1`): every command is an ordinary HTTPS request
carrying a personal access token (PAT) as its bearer. There is no private
channel — the CLI uses the same documented endpoints, the same credential and
the same permissions any third-party integration gets, and if it needs a capability
that capability lands on `/api/v1` first, where everyone can reach it.

That is the point rather than an implementation detail: nothing this tool does
is unavailable to a script you write yourself. The reference is at
[`/docs/api`](https://app.motir.co/docs/api) and the machine-readable spec at
[`/api/openapi/v1.json`](https://app.motir.co/api/openapi/v1.json) — the same
document this package's types are generated from.

> It was an MCP client until Story 11.5 (`docs/decisions/cli-v1-client.md`).
> Motir still SERVES the Model Context Protocol at `/api/mcp`, for agents; the
> CLI is simply no longer one of its clients, and no longer ships an
> agent-protocol SDK to everyone who installs it.

> **Status (Subtask 7.9.1):** this is the scaffold + auth + link layer. Read
> commands (`ready` / `status` / `open` — 7.9.2), single dispatch (`next` /
> `run` / `done` — 7.9.3), and the loop (`auto` / `batch` — 7.9.4+) land on the
> same `commander` program as their subtasks ship.

## Toolchain (the 7.9.1 evaluate-and-record decision)

- **CLI framework: [`commander`](https://github.com/tj/commander.js).** Chosen
  over `yargs` for its smaller surface, first-class subcommand tree (`motir auth
login`, `motir link add`), native async actions (`parseAsync`), and built-in
  `--help`/`--version`. yargs’ middleware/coercion power isn’t needed here.
- **Bundler: [`tsup`](https://tsup.egoist.dev) (esbuild under the hood).** A
  zero-config TS→ESM bundler that emits a single `dist/index.js` with the
  `#!/usr/bin/env node` shebang baked in (the `bin` entry). We use tsup rather
  than raw esbuild only to skip hand-writing the build script; the engine is the
  same esbuild the rest of the toolchain already trusts.
- **Runtime:** Node ≥ 22, ESM (`"type": "module"`).

## Install

```sh
npm install -g @motir/cli
motir --help
```

`pnpm add -g @motir/cli` and `yarn global add @motir/cli` install the same
package. Runtime: **Node ≥ 22**, ESM.

**For contributors** — to run the CLI from this checkout instead of the
published package:

```sh
pnpm --filter @motir/cli build      # produces dist/index.js (the `motir` binary)
# then run it directly, or `pnpm --filter @motir/cli exec motir …`
node packages/cli/dist/index.js --help
```

## Authenticate

```sh
motir login
```

`motir login` is a **device grant**: it prints a short code and a URL, opens
Motir in your browser, and waits for you to approve it there. Codes last 15
minutes and nothing is written to disk until you approve. It is **headless by
construction** — the code and URL are printed whether or not a browser opens, so
an SSH session or a container uses the same command; `--no-browser` skips the
launch attempt outright.

The approval mints a CLI-scoped PAT: permissions `project:browse`, `lesson:view`,
`lesson:reinforce`, `work_item:edit`, `comment:add`, `plan:view_any`, `run:view_any`,
`page:view`, `page:edit`, `ai:plan` (fixed — the grant can neither widen nor narrow them), 90-day
expiry, labelled `CLI · <hostname>`. It lands in `~/.config/motir/config.json`,
`chmod 600`, keyed by server URL.

There are three credential tiers, and `motir login` is the middle one:

| Tier                       | How                                | For                             |
| -------------------------- | ---------------------------------- | ------------------------------- |
| `MOTIR_TOKEN`              | export it — no login step, no file | CI, containers, read-only boxes |
| `motir login`              | browser approval                   | a person at a terminal          |
| `motir auth login --token` | paste a PAT you already hold       | scripts, older servers          |

`MOTIR_TOKEN` is honoured by **every** command (paired with `MOTIR_SERVER` when
there is no `.motir.json` to walk up to) and outranks a stored credential.

**Disconnecting** is two different things: `motir logout` forgets the local copy
on this machine, while **revoking the token in Settings → Account → Tokens**
is the server-side kill switch. Full guide: [`docs/cli.md` §
Authenticate](../../docs/cli.md#authenticate).

## Setup commands

```sh
motir login        [--server <url>] [--no-browser]    # connect this terminal
motir logout       [--server <url>]                   # forget the local credential

motir auth login   [--server <url>] [--token <pat>]   # validate + store a PAT
motir auth status  [--server <url>]                   # server, token prefix, owning user
motir auth refresh [--server <url>] [--no-browser]    # give a `motir login` token current perms
motir auth logout  [--server <url>]                   # forget the stored token

motir link [--server <url>] [--workspace <slug>] [--project <key>] [--repo <name>]
motir link add <repo> <path>                          # add a checkout-path override
motir link remove <repo>                              # remove an override

motir doctor [--agent <cmd>] [--json]                 # BYOK preflight (read-only)
```

## Reading the plan — `ready` / `status` / `sprints` / `sprint` / `show` (7.9.13 · 7.9.14 · 7.9.16)

The read surface. Every one of these is a pure read: it claims nothing, writes
nothing, and is safe to run in a loop.

```sh
motir ready   [--kinds <list>] [--assignee <id|me|unassigned>] [--json]
motir status  [--json]                                # ready / in-flight + active sprint
motir sprints [--state <planned|active|complete>] [--json]
motir sprint  [ref] [--kinds <list>] [--json]         # defaults to the ACTIVE sprint
motir show    <key> [--activity|--comments] [--json]  # one item, in full
motir open    <key> [--print]                         # …in the browser
```

**`motir show --activity` / `--comments`** add the DISCUSSION the aggregate does
not carry: `--activity` interleaves comment threads with the change trail,
`--comments` prints the threads alone. Both are opt-in — the stream is a second
tool call, so a plain `show` stays one round-trip no matter how loud a card got —
and comment bodies print **in full**, never excerpted. ONE page is printed and
never drained: when more remains the footer says how much and points at `motir
open <key>`; with `--json` the activity page rides along **unaltered** under an
`activity` key. Passing both flags is refused rather than silently resolved.

`motir sprint`'s **`ref` resolves in order**: omitted → the active sprint; then a
sprint **id**; then an **exact name**; then a **name prefix** — each
case-insensitive, first rule yielding exactly one sprint wins. An ambiguous
prefix is an error that names the candidates rather than picking the first;
`motir sprints` (which flags the active sprint with `*`) is how you find the name
to type.

**Dependency edges render in two shapes**, chosen by the shape of the set:

- **Columns** on `ready` and `sprint` — `BLOCKS` on `ready` (a ready item has no
  open blockers by definition, so the other direction would be a dead column),
  `BLOCKED BY` **+** `BLOCKS` on `sprint`, which holds mixed-status work. A cell
  prints at most **three** keys and collapses the rest to `+n` so it can never
  wrap and break the table; `✓` marks a blocker already `done`/`cancelled` (it no
  longer gates); an item with no edges renders **blank**, never `0`. **`--json`
  always carries the full untruncated `dependencies` block** — the truncation is
  display-only.
- **A `WAVE` build order** on `show`'s children, because one parent's children
  are a closed DAG. Wave 1 is the independently-buildable set; later waves are
  gated by earlier ones; `BLOCKED BY` names the edges. `↗` marks a blocker
  outside the parent (named, but it forms no wave — nothing in the table can
  clear it). Children in a dependency **cycle** get `—` for a wave and a
  `⚠ dependency CYCLE` line: a planning bug to fix in the tree, not a CLI
  failure, so `show` still exits **0** (`wave: null` in `--json`).

The reason the two differ, in one sentence: a ready set or a sprint spans many
parents so its edges are disconnected fragments, whereas a story's children are
one closed dependency graph. Full prose, with worked examples of both, lives in
[`docs/cli.md`](../../docs/cli.md#dependencies-in-the-terminal--two-renderings).

## Dispatch — `motir next` / `motir run` / `motir done` (7.9.3)

```sh
motir next [--kinds <list>] [--print | --agent <cmd>] [--reset]
motir run <key> [--print | --agent <cmd>] [--force]
motir done <key> [--via <status>]
motir done --session <branch>
```

`next` picks the next ready item; `run` takes an explicit key. Both then follow
the same pipeline:

```
select → transition_status(in_progress) → dispatch_prompt → deliver
```

**The prompt is generated SERVER-SIDE** (`dispatch_prompt`, MOTIR-1802) and
printed byte-identical. The CLI never assembles prompt text, so every harness —
Claude Code, Codex, opencode, or a human reading it — receives the same
instruction and the grammar versions with the product.

**Two delivery modes.** `--print` (the default, and what you get whenever no
agent is configured) writes the prompt to **stdout** and everything else to
**stderr**, so `motir next --print | pbcopy` copies the prompt alone while you
still see the target repo and resolved path on screen. `--agent "<cmd>"` — or
`MOTIR_AGENT`, or `agentCommand` in the user config, in that precedence — runs
your agent on it, handing the prompt over **both** stdin **and**
`$MOTIR_PROMPT_FILE` (a 0600 temp file), streaming its output through live.

**Repo routing.** The dispatch payload names the item's repo (`targetRepo`);
the CLI maps that name to a checkout via the `.motir.json` override map or the
`<root>/<repoName>` convention, and runs the agent there — so dispatching a
`motir-ai` item while standing in `motir-core` just works. If the checkout is
**missing**, the agent runs at the workspace root so the prompt's GIT WORKFLOW
can create it, and the CLI verifies afterwards (reporting a suspect dispatch
with a `motir link add` hint if it did not appear). An item is **never** run in
some other existing checkout — an unpinned item falls back to the root.

**After the agent exits.** Exit 0 lands the item at **In Review**: a per-item-PR
item via `transition_status`, a session-lineage item via `mark_integrated` on
its inherited branch. A non-zero exit leaves the item **In Progress** (work was
started — nothing is reverted), propagates the agent's exit code, and records
the item in the session exclude list so the next `motir next` moves past it;
`--reset` clears that list.

> The exclude list is CLI **state**, not a credential, so it lives in the state
> home — `MOTIR_STATE_HOME` → `MOTIR_CONFIG_HOME` → `XDG_STATE_HOME` →
> `~/.local/state/motir` — and never beside the PAT, which the sandbox image
> mounts read-only (MOTIR-1836). It is a convenience, not a correctness
> mechanism: a failed item is already held out of the ready set by its
> `in_progress` status, so if the store cannot be written the CLI warns once and
> the run continues rather than aborting.

**Closing out.** After you merge, `motir done <key>`. Since MOTIR-1625 the
default workflow carries a direct `in_progress → done` edge, so this is one legal
hop whether or not the item ever reached In Review. `motir done --via in_review
<key>` still walks it through review explicitly — useful on a custom workflow
that has no direct edge, or when you want the review hop on the record. An
illegal flip surfaces the server's own allowed-targets error verbatim. A merged
**session** PR closes out in bulk with `motir done --session <branch>`.

## The repair — `motir fix` (MOTIR-5465)

```sh
motir fix <key> [--agent <cmd>] [--report-log]
```

**When to use it.** A work item's pull requests are failing, or its merge did not
land for a reason the CODE could answer, and the run that opened them has ended.
That is a card at **Implemented** whose checks went red later or whose branch
conflicts, or a card back at **In Review** after the merge queue threw it out for a
failed or timed-out check (it waits there for a fresh approval, and `motir fix` is
the answer when the failure is real). A merge blocked by a repository SETTING, or a
pull request somebody took out of the queue by hand, is refused: no code change
fixes either. The item page's Development block offers this command, ready to copy.

**What it does:**

1. **Claims the repair** (`POST /api/v1/work-items/{key}/repair`). Only one
   repair runs on a card at a time. The claim is an open `fix` run, and it never
   changes the card's status or assignee. A refusal is printed in words and
   exits non-zero:
   - somebody is already fixing it, and they are named;
   - the card is not waiting on a repair (neither Implemented, nor In Review after
     a merge-queue ejection);
   - its merge did not land for a reason no code change fixes — a setting, or a
     hand removal from the queue — and the refusal names what would help instead;
   - the pull requests belong to the parent's run, and the key to fix instead is
     named;
   - the card has no pull requests;
   - its checks are still running;
   - nothing is failing.
2. **Checks out each red pull request's own branch**, as a worktree beside that
   repository's checkout (`<repo>-fix-<key>-<number>`). The worktree is on the
   branch, not a detached HEAD, so a push updates the same pull request. A
   repository with no local checkout is refused. A resumed repair reuses its
   worktree.
3. **Runs the same fix loop `motir run` ends with**, using the same prompt and
   the same limit of five attempts. When the failing set spans several
   repositories, the prompt lists every checkout.

   **A pull request the merge queue ejected counts as failing**, even when its
   own checks are green (the queue failed on its merge commit, not on the branch
   alone). The prompt says why it left the queue and names the queue's failing
   check. A conflict is told to merge the base and resolve it. If the agent
   pushes nothing, because there was nothing to change, the repair stops after
   that ONE attempt and tells you to press **Queue again** on the card.

4. **Closes the run** on every exit path:
   - green → completed, exit 0;
   - the sixth red → halted, exit 1, naming each failing check, its repository
     and the attempt count (the queue's check, for an ejected pull request);
   - an ejected pull request the agent pushed nothing to → failed, exit 1,
     pointing at _Queue again_;
   - Ctrl-C → interrupted, exit 130.

   The page shows a repair as in progress for as long as its run is open.

It opens no pull request and links nothing. The build moves the card to
**In Review** when the checks pass, exactly as it does after `motir run`.

## The loop — `motir auto` (7.9.4)

```sh
motir auto --agent "<cmd>" [--kinds <list>] [--max <n>] [--keep-going] [--reset] \
           [--include-planning]
```

Drain the ready set unattended. Each iteration asks the server for **exactly one**
item and runs it through the same single-dispatch pipeline as `motir next`, then
loops; the run ends when the server has nothing ready left. It never fetches the
ready list up front — the set CHANGES while the run executes, because integrating
one item unlocks its dependents, so the loop **cascades through the dependency
graph** rather than draining a snapshot. An agent is required (`--agent`,
`MOTIR_AGENT`, or the configured `agentCommand`); `--print` has nobody to paste
for and is refused with guidance.

**One session branch, one pull request.** The run opens `motir/auto-<run-id>` on
`origin` in each repo it dispatches into — lazily, on that repo's first item, and
without touching your working tree or creating a local branch. Every item's work
is integrated onto it and recorded with `mark_integrated`, which moves the item to
**In Review** (never Done — `main` does not have the work yet) and is also what
makes its dependents ready mid-run. At the end the CLI surfaces **one pull request
per repo**: the run's single human review gate. **`main` is never auto-advanced**,
by the CLI or by the prompt.

After you merge that pull request, close the whole run out with
`motir done --session motir/auto-<run-id>`. A rejected pull request leaves the
items honestly In Review — the summary names every one of them with its branch.

**What it skips, and why.** An unexpanded epic/story in the ready set is a
_planning_ item, not a dispatchable one — there is no agent prompt for "do the
planning" — so the loop skips it untouched and lists it under _needs planning_.
A `type: manual` / `executor: human` item is skipped the same way, under _needs a
human_.

### `--include-planning` — fire the expansion instead of skipping it (7.9.8)

With the flag, an unexpanded epic/story is not skipped: the CLI submits an AI
expansion for it (the `expand_item` tool), records it, and asks for the next
ready item **immediately**.

**It triggers; it never waits.** The tool returns `{ jobId, planId }` the moment
the job is accepted, and the loop moves straight on. There is no backoff and no
poll — see the next paragraph for why waiting would be waiting on a person.

**A triggered expansion produces PROPOSALS, not work.** The job writes a plan of
proposals; **approving that plan in Motir is the only thing that turns a proposal
into a work item**, so firing it adds nothing to your tree and the epic/story
stays childless. That is exactly why the item goes on the run's exclude list —
otherwise the very next `next_ready` would hand it straight back. If you happen
to approve a plan while the run is still going, its new subtasks surface on a
later iteration like any other unlock, because the loop never pre-fetches; that
is a bonus, not something it waits for.

**End of loop.** When `next_ready` comes back empty the run ends, pending
expansions or not. The summary names each one with its plan id and a link to
review it, under _planning triggered — awaiting your approval_.

**When an expansion fails** (no credits, a refused target, a typed error) it is
**non-halting**, unlike a failed agent: nothing in the run depended on it, so the
item is named under _planning failed — still unexpanded_ and the loop continues
to the next ready item. Neither a triggered nor a failed expansion changes the
exit code, which stays a function of dispatch outcomes alone.

Expansions run on the **AI credits of the token owner**, which is why this is
opt-in rather than the default. Motir also ships a server-side equivalent — the
auto-plan cadence cron fires the same expansion for a project that opted in when
its ready set drains; this flag is the terminal-side version for a project that
has not.

**When an agent fails** the run halts by default and the item is left In Progress
with nothing reverted; `--keep-going` finishes the rest instead. Either way the
end-of-run push and pull request still happen, so a late failure never abandons
the work that already integrated. `--max <n>` caps the dispatches. Ctrl-C stops
between items (or terminates the agent mid-run), then still lands the pull
request and prints the summary.

## The snapshot — `motir batch` (7.9.10)

```sh
motir batch --agent "<cmd>" [--kinds <list>] [--max <n>] [--keep-going] [--reset]
```

The snapshot complement of `motir auto`. Where `auto` follows the ready set as it
changes, `batch` **freezes it once** — it reads the whole ready set up front,
**prints the exact list it will implement**, and then runs those items one at a
time. An item that becomes ready during the run is **not** picked up; the summary
counts and names it, so you can re-run `batch` or reach for `auto`. Printing the
plan before the first agent starts is the point: you can Ctrl-C out of a run you
did not want while nothing has been touched.

**One pull request per item, and no session branch anywhere.** A strictly
main-ready snapshot is mutually independent by construction — an item is in it
only when every dependency is done **on main**, so no snapshot item can depend on
another (it would not have been ready). Each item therefore rides the `motir next`
per-item flow unchanged: its own branch off `origin/main` in its own repo, its own
pull request targeting `main`, and **In Review** once the agent's pull request is
open. Close each one out with `motir done <key>` after you merge it. Two snapshot
items in the same repo simply open two independent pull requests; `mark_integrated`
is never called and no session branch is created.

**Strict main-readiness.** An item that is ready **only** because a dependency is
integrated-awaiting-review (the 7.8.11 rule) is excluded and named: that
dependency's code is not on `main`, so a pull request of its own against `main`
could not even build. That lineage is `auto`'s territory. Unexpanded epics/stories
(_needs planning_) and `type: manual` / `executor: human` items (_needs a human_)
are excluded by the same rule `auto` uses. There is no `--include-planning` here —
an expansion's output could never join a frozen snapshot, so that flag stays
`auto`-only.

**Shared loop mechanics.** An agent is required; a failed agent halts the run by
default (the item stays In Progress, nothing reverted) and `--keep-going` finishes
the rest of the snapshot; `--kinds` and `--max` narrow it; Ctrl-C stops between
items and prints the summary so far, with any pull requests the agents already
opened standing. Snapshot items the run never reached are named so you know what a
re-run will pick up.

### `auto` vs `batch`

|                       | `motir auto`                                           | `motir batch`                                            |
| --------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Work list             | **Live** — one `next_ready` per iteration              | **Frozen** — the ready set snapshotted once, up front    |
| Becomes ready mid-run | Picked up (the loop cascades the dependency graph)     | **Not** picked up — counted and named in the summary     |
| Git lineage           | ONE session branch per repo, `motir/auto-<run-id>`     | **None** — each item branches off `origin/main`          |
| Pull requests         | ONE per repo, opened by the CLI at the end             | **One per item**, opened by the agent                    |
| Item close-out        | `motir done --session <branch>` (bulk)                 | `motir done <key>` (per item)                            |
| Integrated-dep items  | Dispatched — that lineage is the whole point           | **Excluded** — their code is not on `main`               |
| Unexpanded containers | Skipped, or expanded with `--include-planning`         | Skipped — no `--include-planning`                        |
| Reach for it when     | You want a long unattended run to go as deep as it can | You want a bounded, reviewable batch of independent work |

Both leave `main` untouched: it moves only through a pull request a human merges.

## Planning — `motir plan` (7.9.9)

```sh
motir plan                       # resume the PROJECT-WIDE planning conversation
motir plan MOTIR-42 [MOTIR-9]    # resume the conversation ANCHORED at those items
motir plan "<what to change>"    # append one turn and submit it
motir plan MOTIR-42 "<text>" --detach
```

Where `next` / `auto` / `batch` implement the plan, `plan` **changes** it — and it
does that the way Motir actually models planning: as a **conversation**, not a
one-shot description.

**One thread, two surfaces.** A planning conversation is a persisted, resumable
thread — one per project per anchor set — and this command is a CLIENT of it, never
the owner of a parallel one. It addresses the thread by SCOPE (the project, plus any
anchor keys), which is the thread's identity, so **a turn typed in the terminal
appears in the web planning workspace and vice versa**. `motir plan` opens it,
prints every turn already on it, and then reads more.

**Appending is not submitting.** Turns ACCUMULATE. `/submit` sends them as ONE
change, framed so later turns REFINE earlier ones — "add auth to the billing epic"
then "keep them under 3 points" go out together. `/exit` leaves; **quitting can
never lose a turn**, because each one is server-side the moment you press Enter.
Ctrl-D reads as `/exit`, never as a submit.

**What comes back is PROPOSALS.** After a submit the command waits for the planner
(bounded — 10 minutes, and `--detach` skips the wait entirely), then prints the
proposed tree: indented under each proposal's proposed parent, with an op marker
(`+` add / `~` modify / `-` remove), kind/type and leaf sizing. Nothing there
exists in your tree: **approving the plan in Motir is the only thing that creates a
work item**, so the output says so and never reports "created N items". Then it
offers the loop's real next step — add another turn to refine, or open the review
URL to approve.

**Leading `KEY` arguments anchor; the rest is text.** `motir plan MOTIR-42 size
these` opens the thread anchored at MOTIR-42 and appends "size these". A different
key set is a different thread. The CLI never picks the job kind — motir-ai
classifies expand / augment / re-plan from the thread's own scope.

**A fresh project is refused, with a pointer.** The submit path reaches
`augment` / contextual, never generation: generating a first plan is the onboarding
discovery interview's job, a guided web flow. So a project with no work items is
detected **before any turn is appended** and the command exits with the
`/onboarding` URL, having appended and submitted nothing.

**Unattended.** The quoted-text form is the scriptable one; add `--detach` to get
the job/plan ids and the review URL without waiting. A non-TTY invocation with no
text is an **error naming that shorthand** — never a prompt that hangs.

## Help + topics

`motir`, `motir help` and `motir --help` all print the same curated overview on
**stdout** and exit **0** — the front door a newcomer reads top to bottom:

```
Usage: motir [options] [command]

SETUP COMMANDS:      auth · link · doctor
READ COMMANDS:       ready · status · sprints · sprint · show · open
WORK LOOP COMMANDS:  next · run · auto · batch · plan · done
HELP TOPICS:         help · environment · files
FLAGS:               -v, --version · -h, --help
EXAMPLES:            …
LEARN MORE:          …
```

Commands are grouped with commander's native `.helpGroup()` (see `src/help.ts`);
group ORDER is the registration order in `src/program.ts`. **A command
registered without an explicit group falls into `ADDITIONAL COMMANDS`**, so a
later subtask adds a command — and, with one `.helpGroup(...)` line, files it
under `SETUP` / `READ` / `WORK LOOP COMMANDS` — without ever rewriting the help
surface. (7.9.3 was the first to exercise that: `next` / `run` / `done` joined
the reserved work-loop group with one line each; `auto` / `batch` / `plan` then
did the same, and `sprints` / `sprint` / `show` joined `READ COMMANDS` the same
way.)

Two **topics** answer what a command list cannot:

```sh
motir help environment   # the 6 env vars Motir reads, and what each overrides
motir help files         # ~/.config/motir/config.json + .motir.json
```

Per-command help is unchanged (`motir help <command>`, `motir <command> --help`,
nested: `motir help auth login`, `motir link add --help`). An unknown topic
fails like every other CLI error — one line plus a hint on **stderr**, exit
**1**, no stack trace — so `motir help | head` stays clean for piping.

## `motir doctor` — the BYOK preflight

Motir is **BYOK**: you bring your own coding agent and your own model key. So
before `motir next` / `motir auto`, `motir doctor` answers "is my setup
correct?" in one read-only pass instead of letting a missing agent or an
unsigned-in key surface halfway through a dispatch:

| Check                   | PASS means                                               | FAIL means                                                                       |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Auth**                | the stored PAT connects, lists tools, and identifies you | no token, or it is invalid/expired → `motir auth login`                          |
| **Project link**        | `.motir.json` resolved (walking up from the cwd)         | no link here or above → `motir link`                                             |
| **Workspace + project** | the linked project is reachable _for this token_         | wrong key, or your user is not a member                                          |
| **Repo checkouts**      | every override path resolves                             | — (a not-yet-cloned **convention** path is fine, and only WARNs for an override) |
| **Coding agent**        | the binary is on PATH and answers `--version`            | it is not on PATH → the profile's install source                                 |
| **Agent credential**    | the agent's credential exists, or its key env var is set | neither → where to sign in                                                       |

It exits **non-zero** when any hard check fails, so `motir doctor && motir auto`
is a usable gate. `--json` emits the same report machine-readably. WARN rows
never fail the run — "no agent configured" is a warning, because `motir next
--print` hands you the prompt for an agent Motir never launches.

**Which agent gets checked**, in priority order: `--agent <cmd>` → the
`MOTIR_AGENT` env var → `agentCommand` in the user config. The value is a full
command line (`claude --dangerously-skip-permissions`); the first token is the
binary Motir looks for.

**It never reads your secret.** The credential check asks only whether a path
EXISTS or an env var is SET — the engine has no way to obtain a file's contents
or an env var's value, so nothing sensitive can be printed or logged. Nor does
`doctor` write anything: its only server calls are the handshake, `whoami`, and
a one-row search that proves the project is reachable.

**Known agent profiles** (the sandbox matrix, 7.9.7b). A profile is matched by
**every** binary its installer links, so the name you actually type resolves it —
Cursor's executable is `agent`, with `cursor-agent` as the legacy alias. Where a
credential can be checked honestly, `doctor` checks it: `claude` (`~/.claude`),
`codex` (`~/.codex`), `opencode` (`~/.local/share/opencode/auth.json` — the XDG
**data** dir; `~/.config/opencode` holds configuration, not the credential),
`kimi` (`~/.kimi-code`), `cursor` (`CURSOR_API_KEY`), `aider`
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). `antigravity` and `goose` keep their
secret in the OS **keyring**, with no portable file to look for, so they report a
WARN ("verify this one yourself") rather than a false FAIL — and no profile
tests a path that merely proves the agent is _installed_. Any other agent works
too (`--agent "<cmd> <flag>"`): its binary is still checked, its credential is
yours to confirm.

### Config files

- **`~/.config/motir/config.json`** (XDG-respecting; override with
  `MOTIR_CONFIG_HOME`) — the credential store, `chmod 600`. The PAT lives here
  and **only** here. Keyed by server URL so one machine can hold tokens for
  several servers.
- **`.motir.json`** at the workspace root — the project link: `{ serverUrl,
workspace, project, repos? }`. Contains **no secret**, so it is safe to
  commit. Repo checkouts resolve by **convention** (`<root>/<repoName>`); the
  optional `repos` map carries overrides only. Commands resolve `.motir.json`
  by walking **upward** from the cwd, so any command works from inside any
  checkout under the root. An **empty folder is first-class** — bind and go; the
  first scaffold work items create the checkouts.

## Tests

Two lanes, because they need different things (7.9.5):

```sh
pnpm --filter @motir/cli test           # the package suite — no Postgres, no Next app
pnpm --filter @motir/cli test:coverage  # the same, with the per-file ≥90% gate
pnpm vitest run tests/cli/              # the story suite — the BUILT binary, real DB
```

**The package suite** (`packages/cli/test/**`) covers each module in isolation.
Where a module talks to a server it is pointed at a REAL HTTP server the test
starts in-process (`test/helpers/testServer.ts`) with canned `/api/v1`
responses — the framing, status handling and URL building are the real ones,
only the data is scripted. `test/auto.test.ts` drives the whole `motir auto` loop against a
scripted server, agent and git, because its load-bearing properties — that it
re-queries every iteration, that an integrated item unlocks its dependents
mid-run, that `main` is never advanced, and that the pull request opens even when
the run ended badly — are not visible in any single function.

**The story suite** (`tests/cli/cli-story.test.ts`, in the root Vitest lane where
Postgres is) spawns the BUILT binary as a child process against the real
`/api/v1` routes, with a scripted fake agent and a recorded fake `gh`. It is what
proves the assembled tool works: repo routing into real checkouts, the
session-branch cascade, one pull request per touched repo, a `main` nobody
advanced, and the help surface of the binary a user actually runs.

**The gate.** `vitest.config.ts` holds per-FILE ≥90% branch/function/line
thresholds for the client core, the command modules and the pure decision layers.
Three files are ungated on purpose — `index.ts`, `program.ts` and `prompts.ts` —
each for a reason written down beside its threshold entry, and `motir batch`'s
two modules are a KNOWN GAP named in the same file (MOTIR-1829). CI runs the package
suite + gate as its own job (`CLI package`), the same shape `@motir/design-system`
uses; the story suite rides the sharded Vitest job.

## Releasing

What each version changed, for the person who installs it, is
[`CHANGELOG.md`](./CHANGELOG.md). Below is how one gets published.

Releases publish to the **public npm registry** via CI — the
`.github/workflows/release-cli.yml` workflow, triggered by a package-scoped git
tag. There is no manual `npm publish` in the normal path.

1. **Bump the version** in `packages/cli/package.json` (semver: the public
   surface is the `motir` command set — its subcommands, flags and output
   contracts — so removing or renaming one is a **major** bump).
2. **Open + merge** the PR with the bump.
3. **Tag and push** — the tag version MUST equal the `package.json` version (the
   workflow guards this and fails fast otherwise):

   ```bash
   git tag cli-v<x.y.z>          # e.g. cli-v0.1.0
   git push origin cli-v<x.y.z>
   ```

4. The workflow builds, runs the package suite + coverage gate, verifies the
   tarball (`dist/**` only), and publishes `@motir/cli@<x.y.z>` with public
   access and npm provenance. Re-running an already-published version is a no-op
   (idempotent), not a failure.

**One tag, two lanes.** `cli-v*` also fires
[`release-sandbox.yml`](../../.github/workflows/release-sandbox.yml), which
publishes the [sandbox images](./sandbox/README.md). That is deliberate: the
`motir` binary on npm and the one baked into the images are the same version by
construction, and both lanes guard the tag against this `package.json`.

**Dry run:** trigger the workflow from the Actions tab via **Run workflow**
(`workflow_dispatch`) with **dry run** checked — it builds, tests and packs the
tarball as a downloadable artifact without publishing.

**Auth:** the publish step uses **OIDC Trusted Publishing** — no `NPM_TOKEN`
secret. GitHub mints a short-lived id-token (`id-token: write`) that npm
exchanges for a one-time publish credential, gated by a Trusted Publisher
configured on npmjs.com for this package (org `motir-co` / repo `motir-core` /
this workflow filename). Provenance is still requested explicitly with
`--provenance`, which needs `id-token: write` plus the `repository` field in
`package.json`.

> **Why the lane moved off `NPM_TOKEN` (MOTIR-1890).** It originally published
> with that long-lived secret (MOTIR-662). The `cli-v0.1.0` tag was its first
> CI use, and it failed:
>
> ```
> npm error code E404
> npm error 404 Not Found - PUT https://registry.npmjs.org/@motir%2fcli
> ```
>
> **A 404 on `PUT` for a scoped package that exists is npm's masked auth
> failure**, not a missing package — npm answers 404 instead of 401/403 so an
> unauthorized caller cannot probe which private scoped packages exist. Read it
> as "the credential is wrong", never as "the package is gone". Note that the
> `dry_run` path cannot catch this: it packs but skips the publish, so it
> rehearses everything except auth. OIDC removes the credential that could
> expire in the first place.
