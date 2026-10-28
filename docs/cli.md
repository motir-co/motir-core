# The `motir` CLI

Terminal dispatch of the Motir work loop: read your project's ready set, hand
one item's prompt to your own coding agent, and close the work out after you
merge it.

The CLI is a client of **Motir's public REST API** (`/api/v1`). Every command is
an ordinary HTTPS request with a personal access token as its bearer — the same
documented endpoints, the same credential and the same permissions any third-party
integration gets. It reads readiness from the server rather than computing it,
so the CLI can never disagree with the web app about what "ready" means.

Nothing this tool does is privileged. The reference is at
[`/docs/api`](https://app.motir.co/docs/api), and the spec the CLI's own types
are generated from is at
[`/api/openapi/v1.json`](https://app.motir.co/api/openapi/v1.json) — if you would
rather script something yourself, everything below is available to you directly.

Motir is **BYOK**: you bring your own coding agent and your own model key. Motir
launches the agent, hands it a server-generated prompt, and reports its exit
code. It never reads the agent's credential and never inspects its output.

**Contents** — [Install](#install) · [Authenticate](#authenticate) ·
[Link](#link-a-workspace-root) · [Preflight](#preflight) ·
[Your first run](#your-first-run) · [The three ready lanes](#the-three-ready-lanes) ·
[Command reference](#command-reference) ·
[The run shapes](#the-run-shapes) ·
[Planning](#planning-from-the-terminal) ·
[Dispatch runs](#dispatch-runs--the-record-of-what-a-run-did) ·
[Session branches](#session-branches-what-motir-auto-actually-does) ·
[Failure policy](#failure-policy) · [Agent wiring](#agent-wiring) ·
[The sandbox](#the-sandbox) · [Files and environment](#files-and-environment) ·
[When your server is older](#when-your-server-is-older) ·
[Troubleshooting](#troubleshooting)

---

## Install

```sh
npm install -g @motir/cli
motir --help
```

`pnpm add -g @motir/cli` and `yarn global add @motir/cli` install the same
package. Runtime: **Node ≥ 22**, ESM. Every example below writes `motir`.

**For contributors** — to run the CLI from a `motir-core` checkout instead of
the published package:

```sh
pnpm --filter @motir/cli build      # produces packages/cli/dist/index.js
node packages/cli/dist/index.js --help
```

---

## Authenticate

```sh
motir login
```

That is the whole thing. `motir login` prints a short code, opens Motir in your
browser, and waits for you to approve it there:

```
  Your code:  K4TP-9RXM
  Open:       https://app.motir.co/device
```

Sign in, enter the code, approve — and the terminal reports who it connected as
and which workspace it bound to. **Codes last 15 minutes**, and nothing is
written to disk until you approve, so a denied, expired, or `Ctrl-C`'d login
leaves no credential behind.

**No browser on that machine?** The code and the URL are printed either way, so
an SSH session or a container uses the _same_ command — open the URL on any
device and enter the code there. `--no-browser` skips the launch attempt
outright:

```sh
motir login --no-browser
motir login --server https://motir.internal.example   # a self-hosted server
```

The credential lands in `~/.config/motir/config.json`, `chmod 600` inside a
`0700` directory, **keyed by server URL** — so one machine can hold credentials
for several Motir servers. If that directory is read-only (the sandbox image
mounts it that way on purpose), use the `MOTIR_TOKEN` tier below instead: it is
never written to disk at all.

### What the approval mints

The token `motir login` creates is **not** a general-purpose PAT. It is fixed at
the boundary, and the approval screen shows it rather than letting you edit it:

| Property        | Value                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Permissions** | `project:browse`, `lesson:view`, `lesson:reinforce`, `work_item:edit`, `comment:add`, `plan:view_any`, `run:view_any`, `page:view`, `page:edit`, `ai:plan` — and nothing else |
| **Expiry**      | 90 days                                                                                                                                                                       |
| **Label**       | `CLI · <hostname>`, so you can tell which machine it is                                                                                                                       |
| **Workspace**   | the one you choose on the approval screen                                                                                                                                     |

Those permissions are exactly what the CLI's requests need: `project:browse` for
the selection, detail and prompt endpoints, `work_item:edit` for the status flips
and for marking an item integrated / closing a session (which `motir auto` and
`motir done --session` use), `comment:add` for posting a comment, and `ai:plan`
for a planning submit. A dispatched agent's MCP calls add the rest: `lesson:view`
and `lesson:reinforce` for the mistakes corpus, `plan:view_any` and
`run:view_any` for reading plans and its own runs, and `page:view` and
`page:edit` for reading a page and replacing its body (`get_page`,
`create_page`, `update_page`; every replaced body stays a restorable version).
It calls nothing gated by `sprint:manage`, `page:delete`,
`work_item:archive` or `work_item:delete` — so a credential living unattended on a
remote box cannot delete a subtree, and cannot archive one either (it never asks
to).

**A missing permission is an HTTP 403, and the CLI names it.** Every `/api/v1`
endpoint declares the permission it requires, and the CLI knows that declaration
locally — so a refusal reads as _the token is not granted `project:browse`_
rather than as "forbidden", without the CLI having to parse the server's
sentence:

```
$ motir ready
Error: This token is not granted the 'project:browse' permission required for getProjectReadyLeaves.
Hint: Grant the 'project:browse' permission on a token: Settings → Account → Tokens.
```

The remedy is a new token, not a retry: a grant is fixed when a token is minted
and cannot be widened afterwards. `motir doctor` reports what the token you are
holding actually carries.

The grant cannot **widen** that set, and cannot **narrow** it either — a
hand-narrowed grant would fail somewhere in the middle of an unattended
`motir auto` run, which is the worst place to discover a missing permission. If
you want a different grant, mint one by hand in **Settings → Account → Tokens →
Create** (which keeps its full permission choice and its 30/90/365/never expiry)
and supply it with the `--token` tier below. Reasoning:
[`docs/decisions/cli-login.md`](./decisions/cli-login.md) and
[`docs/decisions/token-permissions.md`](./decisions/token-permissions.md);
per-permission detail:
[`docs/mcp.md` § Token permissions](./mcp.md#token-permissions).

### The three credential tiers

`motir login` is the middle one. All three end in the same place — a PAT the CLI
sends as its bearer credential — and differ only in who supplies it:

| Tier                           | How                                          | For                                                 |
| ------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| **`MOTIR_TOKEN`**              | export the variable — no login step, no file | CI, containers, any box with a read-only config dir |
| **`motir login`**              | browser approval (above)                     | a person at a terminal                              |
| **`motir auth login --token`** | paste a PAT you already hold                 | scripts, and servers predating the device grant     |

**`MOTIR_TOKEN` is honoured by every command**, not only at login, and is never
written anywhere. Pair it with `MOTIR_SERVER` when there is no `.motir.json` to
walk up to:

```sh
export MOTIR_TOKEN=motir_pat_…
export MOTIR_SERVER=https://app.motir.co   # optional — this is also the default
motir ready                                # no login step at all
```

It **outranks** a stored credential, so a stale one exported in a shell profile
wins silently; `motir auth status` names the source it used for exactly that
reason. Precedence: `--token <pat>` > `MOTIR_TOKEN` > `config.json`.

The paste path is unchanged, and is what a script wants when it already holds a
token:

```sh
motir auth login --server https://app.motir.co          # prompts for the token
motir auth login --server https://app.motir.co --token motir_pat_…
```

`auth login` validates before storing: it resolves the token against
`GET /api/v1/me`, so an invalid or revoked one is rejected there rather than
halfway through a dispatch — and a good one answers with the user and workspace
the success line prints back to you. Mint the PAT it wants in the web
app — **Settings → Account → Tokens → Create** — and copy it immediately;
Motir stores only a hash, so the plaintext is shown exactly once
([`docs/mcp.md` § Creating a token](./mcp.md#creating-a-token)).

```sh
motir auth status     # server, token prefix, owning user, active workspace
```

### Disconnecting

Two different actions, and only one of them is a kill switch:

- **`motir logout` forgets the local copy.** It removes the credential from
  **this machine** only; the token itself keeps working anywhere else it is held.
- **Revoking the token in Settings → Account → Tokens is the disconnect.**
  That kills the credential server-side, everywhere, immediately. A terminal
  connected by `motir login` appears in that list as `CLI · <hostname>`, which is
  what makes "disconnect that machine" a single obvious row.

```sh
motir logout                    # this machine, the resolved server
motir logout --server <url>     # a specific server
```

`motir auth logout` is the same action under the older name.

---

## Link a workspace root

`motir link` binds a **workspace-root directory** — the folder your repo
checkouts live under — to a server, workspace, and project. It writes
`.motir.json` there.

```sh
cd ~/projects/acme          # the folder holding your checkouts
motir link --project ACME
```

`.motir.json` holds **no secret** (`{ serverUrl, workspace, project, repos? }`),
so it is safe to commit. Every command resolves it by walking **upward** from
the current directory, so any command works from inside any checkout under the
root.

**Repo checkouts resolve by convention** — `<root>/<repoName>`, matching the
repo name Motir pins on each work item. The optional `repos` map carries
overrides only:

```sh
motir link add motir-ai ../elsewhere/motir-ai   # repo lives off-convention
motir link remove motir-ai                      # drop the override
motir link                                      # bare re-run: show it, and clone what is missing
```

If this very directory _is_ the single repo's checkout, say so:

```sh
motir link --project ACME --repo acme-app       # writes { "acme-app": "." }
```

### Linking BRINGS THE CODE DOWN

`motir link` finishes with the project's repositories on disk. It reads the
project's repository set from the server and **clones the ones that are
missing**, each into the path the resolution above computes for it — the
override when there is one, `<root>/<repoName>` otherwise.

```
Linked /home/yue/work → acme/ACME on https://app.motir.co
Wrote /home/yue/work/.motir.json
Cloning 2 of 4 repositories…
Checkouts:
  acme-web: cloned → /home/yue/work/acme-web
  acme-api: cloned → /home/yue/work/acme-api
  acme-shared: already present — /home/yue/work/acme-shared
  mobile: skipped (proposed) — no repository behind this row yet
```

**One line per repository of the set**, and four outcomes:

| Outcome             | What it means                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloned`            | it was missing; it is there now. An archived repository is cloned too, and says so — read-only is not unreadable.                                                   |
| `already present`   | the path exists and was **not touched** — see the invariant below.                                                                                                  |
| `skipped (<state>)` | the row names no repository yet (`proposed`, `creating`, `skipped`, `failed`), or names one whose provider Motir cannot derive a clone URL for. Nothing went wrong. |
| `failed`            | a clone was attempted and git refused. The line carries git's own message.                                                                                          |

**A failure does not abort the rest.** Every remaining repository is still
attempted, and the command **exits non-zero when at least one clone failed** —
and only then. An existing path and a skipped row are not failures.

**⚠️ It never writes into a path that already exists.** Not to update it, not
to repair it, not to re-point a checkout whose `origin` is somewhere else: the
path is reported and left alone, whatever is in it. `motir link` clones what is
missing and does nothing else — it does not fetch, pull, rebase or prune. That
is what makes it safe to run twice; a second run re-clones nothing.

**The bare re-run is how you pick up a repository added later.** `motir link`
with no flags shows the binding and materializes anything missing, so a
repository somebody added to the project after you linked arrives without a
re-bind.

To bind **only** — the behaviour before this shipped — pass `--no-clone`:

```sh
motir link --project ACME --no-clone            # write .motir.json, touch nothing else
```

**Whose credential clones?** Yours. The command shells out to `git clone` and
lets your credential helper, SSH agent or `gh` do what they already do for
every other repository on the machine — Motir never hands git a token. If a
clone is refused, the likeliest cause is a repository Motir created in its own
org that your GitHub account has not yet accepted the collaborator invitation
for; the message says so, and keeps git's own words beneath it.

An **empty folder is first class**: bind it and the code arrives. A repository
that does not exist _anywhere_ yet is the one thing binding cannot fetch —
that is what a scaffold work item creates.

The reasoning behind each of these is recorded in
[`docs/decisions/link-materializes-the-checkouts.md`](./decisions/link-materializes-the-checkouts.md).

---

## Preflight

```sh
motir doctor
```

One read-only pass that answers "is my setup correct?" before a dispatch stops
halfway through:

| Check                   | PASS means                                                    | FAIL means                                                             |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Auth**                | the resolved credential connects, lists tools, identifies you | no token, or invalid / expired → `motir login`                         |
| **Project link**        | `.motir.json` resolved (walking up from the cwd)              | no link here or above → `motir link`                                   |
| **Workspace + project** | the linked project is reachable _for this token_              | wrong key, or your user is not a member                                |
| **Repo checkouts**      | every override path resolves                                  | — a not-yet-cloned **convention** path is fine; an override only WARNs |
| **Coding agent**        | the binary is on PATH and answers `--version`                 | not on PATH → the profile's install source                             |
| **Agent credential**    | the agent's credential exists, or its key env var is set      | neither → where to sign in                                             |

It exits **non-zero** when a hard check fails, so `motir doctor && motir auto`
is a usable gate. WARN rows never fail it — "no agent configured" is a warning,
because `motir next --print` hands you the prompt for an agent Motir never
launches. `--json` emits the same report machine-readably; `--agent <cmd>`
checks a specific agent instead of the configured one.

**It never reads your secret.** The credential check asks only whether a path
exists or an env var is set. `doctor` writes nothing: its only server calls are
the handshake, `whoami`, and a one-row search proving the project is reachable.

---

## Your first run

Start by getting your bearings — where the project stands, what the current
sprint holds, and what the item you are about to pick up actually says:

```sh
motir status                   # ready / in-flight counts + the active sprint
motir sprint                   # the active sprint's items, and what blocks what
motir ready                    # what can be picked up right now, grouped by story
```

`motir ready` prints the ready **leaves** grouped under the story, task or bug
they belong to: a header line — `KEY  kind  title  (n of m ready)` — over its
leaves, indented. A leaf with no such container stands alone. Bugs are not in
this list; `motir ready --bug` shows them, and `motir ready --parent` lists the
containers themselves (see [The three ready lanes](#the-three-ready-lanes)).

`motir sprint` and `motir ready` show dependency edges in their own columns, so
you can see which item unblocks the most before choosing one — see
[Dependencies in the terminal](#dependencies-in-the-terminal--two-renderings).

Then **read the item before you dispatch it.** `motir show` gives you the whole
card — fields, readiness, its dependency edges, and, for a story, its children in
build order:

```sh
motir show MOTIR-42            # the item you're about to hand an agent
```

That is worth the ten seconds: it is where you notice that the card assumes
something that does not exist yet, or that three of its siblings are buildable in
parallel. Now claim it:

```sh
motir next --print             # claim the next LEAF, print its prompt
```

`motir next` takes the next **leaf** — never a bug. Two siblings take the other
lanes:

```sh
motir next --parent --agent "…"    # run the next whole story as a parent run
motir next --bug --print           # take the next bug instead
```

`--print` writes the **prompt to stdout** and everything else (the repo, the
resolved path, the workflow mode) **to stderr** — so `motir next --print | pbcopy`
copies the prompt alone while you still see the context on screen. Paste it into
whatever agent you like; when the agent's pull request is merged, close the item
out:

```sh
motir done --via in_review MOTIR-42
```

(The `--via` hop is needed on this path because the CLI never saw an agent
finish — see [Closing out](#closing-out).)

To have Motir launch the agent for you, and then to drain the whole ready set:

```sh
motir next  --agent "claude --dangerously-skip-permissions"
motir auto  --agent "claude --dangerously-skip-permissions" --max 5
```

`motir auto` is the unattended loop. Read
[Session branches](#session-branches-what-motir-auto-actually-does) before your
first one — it explains what lands where, and why nothing reaches `main` without
you.

---

## The status lifecycle — who moves the card, and when

A card walks five hops from picked-up to closed, and **three different actors
move it**. Two of them are not you and one of them is not even a process you can
see, which is the single most surprising thing about the loop the first time you
watch it.

| hop                                   | who does it                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `todo → in_progress`                  | **the run's CLAIM** — assignment and status in one locked server call                        |
| `in_progress → implemented`           | **the agent, or the CLI** — once the work is committed, PUSHED, and its pull request is open |
| `implemented → in_review`             | **the webhook, when CI goes green.** Nobody at a terminal                                    |
| `in_review → done`                    | **a human**, by merging                                                                      |
| a session-branch pull request merging | **the merge** — it closes EVERY card that branch carries                                     |

**Implemented means the code is on the remote.** It is not "the agent stopped
typing": the CLI records it only after checking that the work actually reached
origin, so a card at Implemented is one whose branch you can go and look at. If
an agent exits 0 having pushed nothing, the card stays **In Progress** and the run
says so — which is what an interrupted run really is.

**A run that dies keeps its work** (`docs/decisions/run-death-keeps-work.md`). Every
local run tells Motir it is alive once a minute; five minutes of silence and the card's
page says its run **died**, with the branch its work is on. The card keeps its status.
Anyone who may edit the project carries it on with **`motir continue <key>`**, which
checks that branch out — reusing the worktree when it is on this machine — and finishes
the card in one pull request. On a **parent** whose `motir run <parent>` died,
`motir continue <parent>` resumes the whole scope on the dead run's session branch —
merging `origin/main` into it first, reusing its draft pull request, running again the
children the dead run was still working, and never re-running a child that already landed. Starting over instead is a deliberate act: set the card
to **To Do** and `motir run` it. Pressing Ctrl-C closes the run as _interrupted_, and
the card stays where it was.

**The third hop happens after your terminal has exited.** The promotion runs
server-side, when Motir receives the check results for the pushed commit — often
a minute or two after `motir next` has returned and your shell prompt is back.
There is nothing to wait for locally, and nothing has gone wrong: In Review means
"a human should look at this", so only a green build is entitled to say it.

**A red build leaves the card at Implemented**, and the CI comment on the card
names the check that failed. You never move it by hand, and moving it by hand is
the one thing that defeats the gate.

**A card reaches In Review only when EVERY pull request delivering it is green.**
A card delivered by two branches — one green, one red — stays at Implemented; the
last one to go green is what promotes it, however much later that is. One green
and one still running is the same answer: running is not a pass.

### The run watches its own build, and fixes it

Every lane WATCHES CI once its pull requests are open, and dispatches a fixing
agent on each red — you do not have to push the fix yourself.

| lane          | watches                      | when                                     |
| ------------- | ---------------------------- | ---------------------------------------- |
| `motir run`   | the pull requests it opened  | as soon as they are open                 |
| `motir batch` | the same, once per card      | **after each card**, before the next     |
| `motir auto`  | every pull request it opened | **only when no card is left to pick up** |

`motir auto` does not gate between cards: its pull requests are for the whole
run, so they are not finished until the run is. `motir batch`'s are for ONE card,
so it will not start the next one on top of a red build.

**Five fixing attempts, then it gives up.** The counter moves on a RED verdict
only — a build that is still running costs nothing, however long it takes — and
the sixth red ends the loop. Every fixing iteration pushes and re-triggers CI, so
a genuine flake gets five fresh rolls; red six times running is not a flake, and
there is no separate flake handling to configure.

At a give-up the cards stay at **Implemented**, the run names the failing check
and its repository, and the command exits **non-zero** — so a script can tell
"built and green" from "built and still red".

**`--keep-going` decides only what happens after the sixth red.** The five fixes
are always attempted:

|                | after five failed fixes                           |
| -------------- | ------------------------------------------------- |
| default        | **halt the drain** — do not pick up the next card |
| `--keep-going` | **move to the next card**                         |

**The fixing agent is told to read the failure first, and permitted to change
nothing.** An environmental failure — a connection reset, a runner death, a
cold-compile timeout — is not something to patch around, and an iteration that
correctly changes nothing still spends one of the five. That is what makes the
cap do the flake work instead of the agent doing it badly.

**One merge closes the whole run.** A `motir auto` run puts every card on one
session branch and opens one pull request; merging it closes **every** card that
branch carries, not just one. `motir done --session <branch>` still exists and
still works — it is now the manual fallback for a run whose pull request was
never opened, rather than the step you have to remember.

---

## What a run does when it finds trouble

An agent working a card meets two different kinds of trouble, and they are not
the same problem: **this card is wrong**, and **something else is broken**. The
prompt gives it a branch for each, and this is what the run does with them.

### Three outcomes, and what each leaves behind

| the agent reports      | the card ends at                 | who acts next                                        |
| ---------------------- | -------------------------------- | ---------------------------------------------------- |
| **finished**           | **Implemented**                  | CI, then you — the ordinary lifecycle above          |
| **this card is wrong** | **Planning**                     | **you**, on the plan it submitted                    |
| **found a defect**     | unchanged — it finishes its card | you, on the **bug** it filed, whenever you get to it |

**A re-plan is a correct outcome, not a failure.** The agent reverts its
worktree, comments the evidence on the card, moves it to **Planning** and submits
a plan for you to read. `motir run` and `motir next` report it and exit **0**;
`motir batch` records it as a skip and carries on with the rest of its snapshot;
`motir auto` **stops**, because the cards it would take next are the ones that
plan may be about to change.

Planning sits in the in-progress category, so the card is out of the pickable set
until you act — nothing re-dispatches it behind your back.

**The plan it submits already knows what is wrong.** The agent composes the WHAT
as six named fields — what the corrected card should make possible, what it
expected versus what it found, what it is not asking for, what already binds the
shape, how the planner will know the corrected card is right, and what it
concluded that nobody confirmed — and submits them with the same finding it
commented on the card. The planner reads those as input to its first phase,
which still settles the targets and writes the requirement it plans against, so
it starts knowing the problem rather than asking about it. One thing to expect: the finding also lands as a turn on the card's
planning thread, which is the conversation the planning panel shows for that
card — so a refused card's thread has the agent's turn on it before you open it.

**Filing a bug does not end anything.** The agent reproduces the defect first,
files a `bug` parented under the in-flight card's own parent, links it back to
the card it was found on, and then carries on with the work it was given. The bug
blocks nothing and claims no scope; it is a record, not a claim on your sprint.

### The three flags

Every one is opt-in. With none of them, an agent may file bugs and submit
re-plans, and nothing is approved automatically.

| flag                    | commands                          | what it does                                                                          |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| `--disable-log-bug`     | `run` · `next` · `batch` · `auto` | The agent is not offered bug filing at all; it comments the finding instead.          |
| `--disable-replan`      | `run` · `next` · `batch` · `auto` | The agent is not offered re-planning; a wrong card is commented and left In Progress. |
| `--auto-approve-replan` | **`auto` only**                   | Approve the submitted re-plan and keep looping, instead of stopping for you.          |

The two `--disable-*` flags are not local behaviour — they change **what the
agent is told**, by narrowing the prompt the server assembles. That is the only
way to change what a sandboxed agent does, and it is why every run prints the
policy it used: a run whose agent filed nothing should be distinguishable from
one that was not allowed to.

```sh
motir auto --agent "…" --disable-replan          # findings welcome, plan untouched
motir batch --agent "…" --disable-log-bug        # a demo: touch nothing but the cards
motir auto --agent "…" --auto-approve-replan     # ⚠️ read the next section first
```

`--no-log-bug` and `--no-replan` are accepted and behave identically to their
`--disable-*` forms — a compatibility affordance, since `--no-*` is this CLI's
usual spelling for a negated boolean. They are deliberately absent from
`motir help`; the `--disable-*` spellings are the documented ones, because
`--no-log-bug` reads ambiguously between _"don't log a bug this time"_ and _"the
capability is off"_, and only the second is meant.

### ⚠️ `--auto-approve-replan` lets a run change your plan while you are not watching

That is the whole feature, and it is worth reading as a sentence rather than
inferring from a flag name. With it set, `motir auto` takes a plan its own agent
submitted, **approves it without anybody looking**, and continues — so proposals
become real work items, re-scoped cards change, and removed cards are archived,
in a tree you own, at three in the morning.

It is bounded, and the bounds are worth knowing:

- **Only the plan the refused card itself produced.** The run approves through a
  card-addressed endpoint; the server derives the plan from the planning
  conversation anchored at that card. It cannot reach a plan submitted from the
  web panel, an onboarding generation, or the auto-plan cadence — each of those
  keeps the human decision it was written under.
- **A card is never dispatched twice by one run**, so a card that refuses itself
  repeatedly cannot loop. Each submission spends AI credits; one per card is the
  cap.
- **`--max` still binds**, even when an approved plan enlarges the ready set.
- **A refusal stops the run**, with the server's own message, rather than
  continuing against a tree nobody approved.
- **The summary names every plan it approved and the card each was approved
  for**, so the first thing you read afterwards is what the run decided.

Without the flag, `auto` stops at the first re-plan and waits for you. That is
the default, and it stays the default.

**It is `auto`-only, on purpose.** `motir run` and `motir next` dispatch one item
and exit — there is no continuation for an approval to feed. `motir batch`
freezes its ready set before the first agent starts and never re-reads it, so
cards a newly-approved plan created would be approved and then never dispatched;
approving a change to your plan and declining to act on it is worse than not
offering the flag. All three **register** it so they can refuse it with that
reason, rather than failing with `unknown option`.

---

## The three ready lanes

A work item is **ready** when every `blocked_by` dependency is done and every
ancestor is ready too. Motir splits that one ready set three ways — the way work
is actually run — and every surface reads the same split: the web app's `/ready`
page, the MCP `list_ready` / `next_ready` tools (their `lane` argument) and the
CLI.

- **Leaves** — the ready leaves that are not bug work. The lane `motir next` and
  `motir ready` read. Each row names its **runnable container**: a story, task or
  bug whose every child is a leaf — exactly the shape `motir run <KEY>` runs as a
  parent run — or none.
- **Containers** — those runnable containers (bugs excluded) holding at least one
  ready leaf: what `motir next --parent` runs and `motir ready --parent` lists.
  **An epic is never one**, and neither is a container one of whose children has
  children of its own: its leaves stand alone instead.
- **Bugs** — **bug work**: a ready bug, or a ready subtask of a bug. What
  `motir next --bug` takes and `motir ready --bug` lists. A childless bug stands
  alone; a bug's ready subtasks group under it.

**The order.** Rows come grouped by container. A group ranks by its **best**
member's `(kind, priority, key)` — the dispatch rank the flat set always used — and
members keep that rank inside their group. So the first leaf is still the one the
flat set would have picked first, unless that one was a bug.

**The endpoints**, one per lane:

- `GET /api/v1/projects/{key}/ready/leaves` — the leaves, each with its `container`.
- `GET /api/v1/projects/{key}/ready/containers` — the runnable containers, each
  with `readyLeafCount` and `childCount`.
- `GET /api/v1/projects/{key}/ready/bugs` — the bug work.

**Which command reads which lane:**

| Command                     | Reads                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `motir next`                | the leaves lane — never a bug                                             |
| `motir next --parent`       | the containers lane, then runs the pick exactly as `motir run <KEY>`      |
| `motir next --bug`          | the bugs lane — a bug with ready subtasks runs whole, as a parent run     |
| `motir ready`               | the leaves lane, grouped · `--parent` the containers · `--bug` the bugs   |
| `motir auto`                | the leaves lane until it is drained, **then** the bugs lane               |
| `motir batch`               | leaves and bugs together, leaves first — one snapshot                     |
| `motir run <story>` (scope) | leaves and bugs together under the story, so its edged bug is claimed too |

## Command reference

Every command and flag the binary registers. `motir`, `motir help`, and
`motir --help` all print the same curated overview on stdout and exit 0.

### Setup

| Command                        | Flags                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| `motir login`                  | `--server <url>` · `--no-browser`                                                            |
| `motir logout`                 | `--server <url>`                                                                             |
| `motir auth login`             | `--server <url>` · `--token <pat>`                                                           |
| `motir auth status`            | `--server <url>`                                                                             |
| `motir auth logout`            | `--server <url>`                                                                             |
| `motir link`                   | `--server <url>` · `--workspace <slug>` · `--project <key>` · `--repo <name>` · `--no-clone` |
| `motir link add <repo> <path>` | —                                                                                            |
| `motir link remove <repo>`     | —                                                                                            |
| `motir doctor`                 | `--agent <cmd>` · `--json`                                                                   |

```sh
motir login                                    # the usual way in
motir login --no-browser                       # …over SSH: just print the code
motir auth login --server https://app.motir.co --token motir_pat_…
motir auth status --server https://app.motir.co
motir link --project ACME --repo acme-app
motir link --project ACME --no-clone           # bind only; clone nothing
motir link add motir-ai ../elsewhere/motir-ai
motir doctor --agent "codex exec --sandbox workspace-write" --json
```

### Read

| Command              | Flags                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- |
| `motir ready`        | `--kinds <list>` · `--assignee <id\|me\|unassigned>` · `--parent` · `--bug` · `--json` |
| `motir status`       | `--json`                                                                               |
| `motir sprints`      | `--state <planned\|active\|complete>` · `--json`                                       |
| `motir sprint [ref]` | `--kinds <list>` · `--json`                                                            |
| `motir show <key>`   | `--activity` · `--comments` · `--json`                                                 |
| `motir open <key>`   | `--print`                                                                              |

```sh
motir ready --kinds subtask --assignee me
motir ready --parent               # the runnable containers: what `motir next --parent` runs
motir ready --bug                  # the ready bugs
motir ready --json | jq '.[].key'
motir status                       # ready / in-flight counts + the active sprint
motir sprints --state active       # just the one that's running
motir sprint                       # the active sprint's work items
motir sprint "Journey D"           # …a specific one, by name prefix
motir show MOTIR-1775              # one item: fields, edges, children in build order
motir show MOTIR-1775 --activity   # …plus the discussion: comments AND history
motir show MOTIR-1775 --comments   # …just what people said
motir open MOTIR-42 --print        # print the URL, don't launch a browser
```

`--kinds` takes any of `epic,story,task,bug,subtask`; an unknown kind is a hard
error naming the valid set. It narrows the lane you are reading — bugs are their
own lane now, so ask for them with `--bug` rather than `--kinds bug`. `--parent`
and `--bug` are mutually exclusive, and `--parent` refuses `--kinds` (a container
has no leaf kind). An empty lane prints `No ready work items in the <lane> lane.`
and exits 0. These reads ride the same service the web app's
**`/ready`** page uses, so the two can never disagree — `/ready` is the human
mirror of `motir ready`, and its in-app help popover is the on-surface
explanation of what "ready" means.

`motir sprints` marks the active sprint with a `*` in the first column:

```
1 sprint:
   STATE   NAME                                      ITEMS  POINTS  WINDOW
─  ──────  ────────────────────────────────────────  ─────  ──────  ─────────────────────
*  active  Journey D · The Motir CLI — terminal di…     41      45  2026-07-28T00:00:00…
```

#### `motir sprint [ref]` — how the ref resolves

The one behaviour you cannot guess. `ref` is matched in this order, and the
first rule that yields **exactly one** sprint wins:

1. **Omitted** → the **active** sprint. If no sprint is active, that is an error
   telling you to run `motir sprints`.
2. **A sprint id** (the opaque `cmq…` string `--json` and the API emit).
3. **An exact name**, case-insensitively.
4. **A name prefix**, case-insensitively.

A prefix matching **more than one** sprint is an error that names the
candidates, so you can retype with enough of the name to disambiguate — it never
silently picks the first:

```console
$ motir sprint "Sprint 1"
Error: "Sprint 1" matches 11 sprints.
Hint: Name one of: Sprint 1 · Project bootstrap, Sprint 10 · Swimlanes + WIP limits, …
```

No match at all fails the same way (one line + hint on **stderr**, exit **1**).
Note that step 3 precedes step 4 deliberately: a sprint literally named
`Sprint 1` would resolve to itself even though it is also a prefix of
`Sprint 10`.

#### `motir show --activity` / `--comments` — the discussion

`show` reads the card; these two flags read what was **said about** it. Same
command, because the discussion is part of the item, not a separate object —
the shape `gh issue view <n> --comments` uses.

| Flag         | What it prints                                              |
| ------------ | ----------------------------------------------------------- |
| `--activity` | The merged stream: comment threads **and** the change trail |
| `--comments` | The comment threads only                                    |

```console
$ motir show MOTIR-1999 --activity
… the usual show block …

ACTIVITY
2 of 9 comments · 1 of 4 changes

[comment] Zhu Yue · 3 days ago (2026-07-30T12:00:00.000Z)
          The rationale for archiving it.
  ↳ reply Odie · 1 hour ago (2026-08-02T11:00:00.000Z) (edited)
          Agreed — the mirror does the same.
[change]  Mo · 1 hour ago (2026-08-02T11:00:00.000Z) — changed status: To Do → In Progress

MORE — 7 comments and 3 changes not on this page. `motir show` prints ONE page
and never drains the stream; read the rest in Motir: `motir open MOTIR-1999`.
```

Four things worth knowing:

- **Neither flag = the read you already had.** The stream is a **second** tool
  call, made only when you ask for it, so a card with two hundred comments never
  slows down a plain `motir show` (or the dispatch path that leans on it).
- **Comment bodies are printed IN FULL**, never excerpted. A rationale you can
  only half-read is worse than one you know you have to page for.
- **One page, and it says what it left behind.** There is no `--cursor`: this is
  a look, not a walk. When more remains, the footer names how much and points at
  `motir open <key>` for the whole stream in Motir. A **short page that still has
  a cursor is normal** for the merged view (the trail is scanned in bounded
  windows), and the footer says that too rather than implying the page is
  everything.
- **`--json`** emits the activity page **unaltered** under an `activity` key
  beside the usual aggregate — cursor and totals included. Without a flag the key
  is absent, so the payload is exactly what it was before.

The two flags are alternatives: passing both is refused by name rather than
silently resolved to one of them. Both need only the `read` scope, which is what
`motir login` mints.

### Dependencies in the terminal — two renderings

Dependency edges show up in **two different shapes**, and they are not
inconsistent with each other — they answer different questions because the sets
they describe have different shapes.

> A **ready set or a sprint spans many parents**, so its edges are disconnected
> fragments with no graph to draw → a **column**. A **story's children are one
> dependency graph** → a **build order**. A `blocked_by` edge joins two work
> items at the **same level** (epic·epic, story·story, leaf·leaf), and the two
> may sit under **different parents** — so an edge into the story from outside
> it is a blocker the build order does not own, and the drain reports it rather
> than working it.

#### 1. Edge COLUMNS — on `motir ready` and `motir sprint`

`motir sprint` carries both directions, because a sprint holds mixed-status work
and "why can't this finish?" is the load-bearing question:

```
KEY         KIND     STATUS       PRIORITY  BLOCKED BY                             BLOCKS                  TITLE
──────────  ───────  ───────────  ────────  ─────────────────────────────────────  ──────────────────────  ─────────────────────
MOTIR-669   subtask  todo         high      MOTIR-662✓, MOTIR-664✓, MOTIR-668✓ +2  MOTIR-1869, MOTIR-1872  8.7.9 Publish the `@…
MOTIR-809   story    in_progress  medium    MOTIR-808✓                             MOTIR-1789              Motir CLI — terminal…
✓ = already done
```

`motir ready` carries **only `BLOCKS`**, in every lane it prints — a container's
header line leaves the column blank, since the edges are its leaves'. That is not an omission: an item is in
the ready set precisely because every blocker is already done, so a `BLOCKED BY`
column would be dead in every row. What a picker actually wants is downstream
impact — _"do this one first, it unblocks three."_

```
KEY         KIND     PRIORITY  ASSIGNEE    BLOCKS                              TITLE
──────────  ───────  ────────  ──────────  ──────────────────────────────────  ─────────────────────
MOTIR-1777  subtask  highest   unassigned  MOTIR-1779, MOTIR-1781              Spike — verify the t…
MOTIR-1043  subtask  high      unassigned                                      8.8 The public /toke…
```

Reading the cells:

- **Blank means no edges** — never `0`, which would read as a count the row does
  not have (`MOTIR-1043` above).
- **`✓` marks a blocker that is already `done` or `cancelled`.** It no longer
  gates, so it must not read as if it does. Live edges are listed **first**;
  settled ones follow, suffixed.
- **`+n` is truncation, not a count of anything.** A cell prints at most
  **three** keys and collapses the rest, because a wrapped cell would wreck the
  column alignment of every row below it.
- **`--json` always carries the full, untruncated edge block.** The abbreviation
  is a display concern only; the machine view never lies. Here is the same row
  both ways — the table collapses its fourth edge, the JSON keeps all four:

  ```
  MOTIR-1122  subtask  high  unassigned  MOTIR-1123, MOTIR-1124, MOTIR-1161 +1  8.5.1 Decide produc…
  ```

  ```console
  $ motir ready --json | jq '.[] | select(.key == "MOTIR-1122") | .dependencies'
  {
    "blockedBy": [],
    "blocks": [
      { "key": "MOTIR-1123", "title": "8.5.2 Provision transactional-email provider…", "status": "todo" },
      { "key": "MOTIR-1124", "title": "8.5.4 Production deploy + attach motir.co domain…", "status": "todo" },
      { "key": "MOTIR-1161", "title": "8.5.5 Provision error-monitoring (Sentry)…", "status": "todo" },
      { "key": "MOTIR-1165", "title": "8.5.9 App-level rate limiting on auth…", "status": "blocked" }
    ]
  }
  ```

  Note the field is **`key`** (the `MOTIR-<n>` identifier), on both the row and
  every edge entry.

- Against an **older Motir server** that does not project edges at all, the
  columns are simply absent — the reads degrade to their previous shape rather
  than failing. (The CLI is versioned and published independently of the
  server.)

#### 2. The `WAVE` build order — on `motir show <key>`

A parent's children are a closed DAG, so `motir show` sorts them into **waves**
and puts the wave number in a column. **Wave 1 is the story's independently
buildable set** — everything no un-done sibling gates, i.e. what you can start
in parallel right now. Wave 2 is what only wave 1 gates, and so on:

```console
$ motir show MOTIR-1775
```

```
CHILDREN (10) — build order
WAVE  KEY         KIND     STATUS   BLOCKED BY                             TITLE
────  ──────────  ───────  ───────  ─────────────────────────────────────  ─────────────────────
1     MOTIR-1776  subtask  todo                                            Decision — repo owne…
1     MOTIR-1777  subtask  todo                                            Spike — verify the t…
1     MOTIR-1780  subtask  todo                                            (motir-core) Project…
2     MOTIR-1778  subtask  blocked  MOTIR-1776                             (motir-core) Design …
2     MOTIR-1779  subtask  blocked  MOTIR-1777                             Apply the GitHub gra…
2     MOTIR-1783  subtask  blocked  MOTIR-1780                             (motir-core) Name th…
3     MOTIR-1781  subtask  blocked  MOTIR-1777, MOTIR-1779, MOTIR-1780     (motir-core) The rep…
4     MOTIR-1782  subtask  blocked  MOTIR-1778, MOTIR-1781                 (motir-core) The app…
5     MOTIR-1784  subtask  blocked  MOTIR-1780, MOTIR-1781, MOTIR-1782 +1  (motir-core) Vitest …
5     MOTIR-1785  subtask  blocked  MOTIR-1782                             (motir-core) Playwri…
```

The wave number **is** the graph: three items can start immediately, and
`MOTIR-1784` waits on four things (three shown, `+1` truncated). `BLOCKED BY`
names the actual edges rather than just asserting an order, so "why is this
wave 5?" is answerable from the row.

Two marks appear here that the columns above don't need, and the legend prints
**only** when a row actually shows one:

- **`✓` — already done.** Same meaning as in the columns.
- **`↗` — a blocker outside this parent.** Plan rules forbid these, but the data
  can hold them, so they are named rather than hidden. They deliberately do
  **not** form a wave: nothing in this table can clear them, so counting them
  would distort every wave below.

`show --json` re-orders `children` into the same build order and stamps each with
its `wave`, so a script gets the ordering without re-deriving the graph.

##### The cycle marker

If children block each other in a loop they have **no position in any build
order**. `motir show` reports that rather than inventing one: the cycle members
come last with `—` in the `WAVE` column, followed by

```
⚠ dependency CYCLE — MOTIR-101, MOTIR-102 block each other and have no build order. Fix the blocked_by edges.
```

This is **a planning bug in the tree, not a CLI error** — `show` still exits
**0**. The fix is to correct the `blocked_by` edges (in the web app, or with the
`POST`/`DELETE …/work-items/{key}/links` endpoints); `motir show` is only
reporting what the plan says. In `--json`, a cycle member's `wave` is `null`.

### Work loop

| Command                | Flags                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motir next`           | `--kinds <list>` · `--parent` · `--bug` · `--print` · `--print-prompt` · `--agent <cmd>` · `--reset` · `--disable-log-bug` · `--disable-replan`                                              |
| `motir run <scope>`    | `--print`¹ · `--print-prompt` · `--agent <cmd>` · `--force`¹ · `--allow-soft-block`² · `--max <n>` · `--keep-going` · `--include-planning` · `--disable-log-bug` · `--disable-replan`        |
| `motir auto`           | `--agent <cmd>` · `--kinds <list>` · `--max <n>` · `--keep-going` · `--reset` · `--include-planning` · `--print-prompt` · `--disable-log-bug` · `--disable-replan` · `--auto-approve-replan` |
| `motir batch`          | `--agent <cmd>` · `--kinds <list>` · `--max <n>` · `--keep-going` · `--reset` · `--print-prompt` · `--disable-log-bug` · `--disable-replan`                                                  |
| `motir fix <key>`      | `--agent <cmd>` · `--report-log`                                                                                                                                                             |
| `motir continue <key>` | `--agent <cmd>` · `--report-log`                                                                                                                                                             |
| `motir plan [args...]` | `--detach`                                                                                                                                                                                   |
| `motir done [key]`     | `--session <branch>` · `--via <status>`                                                                                                                                                      |

```sh
motir next --kinds subtask --print
motir next --agent "claude --dangerously-skip-permissions" --reset
motir next --parent --agent "…"             # the next runnable STORY/TASK/BUG, run as `motir run <KEY>`
motir next --bug --print                    # the next BUG's prompt
motir run MOTIR-42 --print                  # ONE item
motir run MOTIR-42 --force                  # dispatch it even though it isn't ready
motir run MOTIR-42 --allow-soft-block       # dispatch it though its EPIC/STORY is blocked
motir run MOTIR-40 --agent "…"              # a whole STORY: claim its leaves, work them all
motir run sprint --agent "…" --max 5        # the ACTIVE sprint, first five cards
motir auto --agent "claude --dangerously-skip-permissions" --max 5 --keep-going
motir auto --agent "…" --include-planning   # also fire expansions for unexpanded containers
motir auto --agent "…" --print-prompt 2> prompts.log   # keep the transcript, leave stdout alone
motir batch --agent "codex exec --sandbox workspace-write --ask-for-approval never"
motir plan                                  # resume the project-wide conversation
motir plan MOTIR-42 "size these" --detach   # anchored, one turn, don't wait
motir done MOTIR-42                         # after you merge its pull request
motir done --via in_review MOTIR-42         # …when the CLI never saw the agent finish
motir done --session motir/auto-20260729-011830
```

¹ **Leaf-only.** `--print` and `--force` mean something about ONE card and
nothing about a set: a scope has no single prompt to paste, and a scope that
cannot be finished needs a re-plan rather than a forced run. Passed with a
container they fail with that sentence. `--kinds` is refused on a scope for a
sharper reason — the claim is all-or-nothing over the whole membership, so a
filtered run would HOLD cards it never worked.

² **HARD vs SOFT blocks.** A work item with its **own** open `blocked_by`
dependency is **HARD**-blocked. One whose own dependencies are all done, but
whose epic or story has an open blocker, is **SOFT**-blocked — held only by an
ancestor's block. `--allow-soft-block` runs past a SOFT block and never past a
HARD one:

- On a **leaf**, a SOFT-blocked item is dispatched with one line naming the
  ancestor it overrode; a HARD-blocked one is still refused.
- On a **story**, the story's own verdict is read first: if the story itself
  has an open blocker the run is refused before anything is claimed. Otherwise
  the scope is built from the ready read with `allowSoftBlock=true`, so the
  children held only by the story's ancestor chain are in it. A child with its
  own open blocker outside the scope stays out and is reported, never built.

**`motir next --parent` and `--bug`.** `motir next` takes the next **leaf** and
never a bug. `--parent` takes the next runnable container and runs it exactly as
`motir run <KEY>` would — the same code, so the claim, the refusals and the
parent branch are identical. `--bug` takes the next bug: a childless bug is
dispatched as a leaf, and a bug whose ready subtasks form a group runs that bug as
a parent run. Three combinations are refused before anything is claimed:
`--parent` with `--print` (a parent run has no single prompt — `motir run
<container> --print`'s own message), `--parent` with `--kinds` (a container has no
leaf kind) and `--parent` with `--bug`. The session exclude list serves every
lane: it is keyed by the work item's key.

`--force` overrides both kinds (leaf only), so `--allow-soft-block --force` is
refused as redundant. `motir next`, `motir auto` and `motir batch` do not take
the flag — a pick from the ready set never reaches past a block.

`--print` is **registered but refused** on `auto` and `batch` too: an unattended
run has nobody to paste a prompt, so the flag fails with guidance rather than
commander's bare "unknown option". `--auto-approve-replan` is refused the same
way on `run`, `next` and `batch` — see **What a run does when it finds trouble**
below, which is where the three findings flags are explained.

#### ⚠️ `--print-prompt` is NOT `--print` — one prints INSTEAD, the other ALONGSIDE

The two are one word apart and mean opposite kinds of thing, so read this once
rather than guessing from the name:

|                  | `--print`                                                                                    | `--print-prompt`                                          |
| ---------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `run` · `next`   | print the prompt **instead of** launching an agent — the default when no agent is configured | print the prompt **and** launch the agent                 |
| `auto` · `batch` | **refused**, with the guidance above                                                         | **supported**, and most useful precisely here             |
| stream           | **stdout** — the prompt IS the output, meant to be piped                                     | **stderr** — narration about a run that is also happening |
| leaf-only?       | yes — a scope has no single prompt to paste                                                  | no — a scoped run prints one block per dispatched leaf    |

`--print-prompt` echoes each assembled prompt **verbatim to stderr at the moment
it is dispatched**, on all four dispatch commands. It exists because the prompt is
the entire contract with a sandboxed agent and is otherwise the one part of a run
nobody can see: it is assembled server-side, written to the temp file
`$MOTIR_PROMPT_FILE` points at, and **deleted when the dispatch ends** — so by the
time you want to know why an agent did something strange, it is gone.

Four things it guarantees, each of which is the reason for one of its choices:

- **stderr, not stdout.** stdout during a run may carry the run's own structured
  output, and a ~200-line prompt dumped into it would corrupt anything piping or
  parsing it. The two flags therefore **compose**:
  `motir run KEY --print --print-prompt` puts the prompt once on each stream
  rather than twice on one.
- **`2> prompts.log` is the shape people want** —
  `motir auto --agent "…" --print-prompt 2> prompts.log` keeps the whole run's
  transcript and leaves stdout intact.
- **What was SENT, never a re-assembly.** The CLI echoes the string it hands the
  agent, byte for byte. A transcript regenerated for display is one that can
  disagree with the run it claims to describe.
- **Printed BEFORE the agent starts**, so the prompt is on the stream even when
  the agent then fails, times out or is killed — the run you most want the
  transcript for is the one that went wrong.

Each block opens with a header naming the work item, and the **session branch**
as well when the dispatch is in `session_lineage` mode (`auto`, and a scoped
`run`), because there the prompt's git instructions are only interpretable
against the branch they name:

```
──── PROMPT SENT · MOTIR-42 · motir/auto-20260820-011830 ────
```

In `auto`, `batch` and a scoped `run` that is one block per dispatched item, in
dispatch order.

### Help and topics

```sh
motir help                     # the curated overview (also: motir, motir --help)
motir help auth login          # per-command help, nested
motir link add --help          # the same, the other way round
motir help environment         # the 6 env vars Motir reads, and what each overrides
motir help files               # ~/.config/motir/config.json + .motir.json
motir --version                # -v also works
```

The two topics are also plain commands (`motir environment`, `motir files`). An
unknown topic fails like every other CLI error — one line plus a hint on
**stderr**, exit **1**, no stack trace — so `motir help | head` stays clean for
piping.

---

## The run shapes

Selection differs; the pipeline does not. Every dispatch runs:

```
select → claim (assign + in_progress, one locked call) → dispatch_prompt → deliver
```

**The prompt is generated SERVER-SIDE** (`dispatch_prompt`) and printed
byte-identical. The CLI never assembles prompt text, so every harness — Claude
Code, Codex, opencode, or a human reading it — receives the same instruction,
and the prompt grammar versions with the product rather than with your CLI
build.

**Repo routing.** The dispatch payload names the item's repository **SET** —
ordered, the primary first — and the CLI maps **each** name to a checkout via
`.motir.json` or the `<root>/<repoName>` convention. It runs the agent in the
**primary's** checkout, so dispatching a `motir-ai` item while standing in
`motir-core` just works. Three outcomes, and only three, **per repository**: the
checkout exists (that is where its work happens), the checkout is **missing**
(for the primary, the agent runs at the workspace root so the prompt's GIT
WORKFLOW can create it, then verifies afterwards; for any other repository, the
run WARNS and proceeds), or the item pins no repo at all (run at the root). An
item is **never** run in some other existing checkout — dispatching into the
wrong repo is worse than admitting the gap.

**Every repository is resolved and reported BEFORE the agent starts.** For a
card carrying more than one, the summary lists each repository, the path it
resolved to, and how it resolved — so the two mistakes this shape actually
produces (a repository you have never cloned, and one that lives somewhere other
than where the convention says) are visible in one glance rather than as an
agent failing in a directory that does not exist.

|                       | `motir next` / `motir run <leaf>`                                                     | `motir run <story>` / `motir run sprint`                                                            | `motir auto`                                                                                                                       | `motir batch`                                        |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Work list             | one item — `motir next` a leaf; `motir next --bug` a bug                              | **the scope, claimed up front** — every card under it, in one transaction                           | **live** — one `next_ready` per iteration                                                                                          | **frozen** — the ready set snapshotted up front      |
| Becomes ready mid-run | n/a                                                                                   | n/a — the run already owns the whole set and never re-asks                                          | picked up (the loop cascades the dependency graph)                                                                                 | **not** picked up — counted and named                |
| Order                 | n/a                                                                                   | the scope's own `blocked_by` graph, computed once                                                   | the server's ready rank, re-asked every iteration                                                                                  | the rank, frozen at the snapshot                     |
| Git lineage           | none — the item's own branch off `main`, the SAME name in every repository it carries | ONE session branch per repo, exactly as `auto` does                                                 | ONE session branch per repo, `motir/auto-<run-id>` — opened in every repository a dispatched card carries, or in none of them      | **none** — each item branches off `origin/main`      |
| Pull requests         | **one per repository the item carries**, opened by the agent                          | **ONE per repo for the whole scope**, opened by the CLI as a DRAFT at that repo's first landed card | ONE per repo, opened by the CLI as a DRAFT at that repo's first landed card — including every repository a dispatched card carries | **one per item per repository**, opened by the agent |
| Close-out             | `motir done <key>`                                                                    | `motir done --session <branch>` (bulk)                                                              | `motir done --session <branch>` (bulk)                                                                                             | `motir done <key>` (per item)                        |
| Agent required        | no (`--print` is the default)                                                         | **yes** — a set has no single prompt to paste                                                       | **yes**                                                                                                                            | **yes**                                              |

`motir next --parent` is a `motir run <story>` in every column: it picks the next
runnable container from the containers lane and hands its key to the same run. So
is `motir next --bug` on a bug with ready subtasks; on a childless bug it is the
leaf column.

**What each shape reads from the ready lanes.** `motir auto` takes the leaves lane
until it is empty and only then the bugs lane, so an unattended run finishes the
planned work before it turns to defects. `motir batch` snapshots the leaves and
the bugs together, leaves first. A scoped run reads the leaves and the bugs under
its scope together, so a story's edged bug is claimed and run with it.

### `motir run <scope>` — a whole story, or the active sprint

`motir run` takes a **scope**: a work-item key, or the reserved word `sprint`.
What it does is decided by the target's **shape**, not by its kind.

| you type                 | it does                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `motir run MOTIR-42`     | a **leaf** — one card, exactly as it always did                              |
| `motir run MOTIR-40`     | a **container with children** — claim the scope, work its leaves             |
| `motir run sprint`       | the project's **active** sprint                                              |
| an epic                  | **refused.** An epic groups stories; run one of its stories                  |
| a story with no children | **refused** — it is a planning item. `--include-planning` expands it instead |

It is the shape and not the kind because a `task` and a `bug` can each have
children, and a `story` can have none. "One commit per child" is a true
description of a container exactly when no child is itself a container.

#### ⚠️ Every card in the scope reads In Progress for the whole run

This is the one thing about a scoped run you have to know before you use it,
because the board will look wrong otherwise.

A scoped run **claims the whole scope before it starts** — the container and
every card under it, in one transaction, all of them or none. So the board shows
the run's **footprint**, not its cursor: eight cards In Progress while one agent
is working. "In Progress" stops meaning _somebody is on this right now_ and
starts meaning _this run owns it_.

That was weighed and accepted, and the reason is what a scoped run promises. It
says it will take a story and finish it, and that is only keepable if it owns the
story when it starts. Claiming card by card instead leaves a window in which a
second run takes card five while the first is on card two — and the two then
integrate onto different branches, so the story arrives as half a pull request
in two places. That is worse than either run refusing.

The corollary is the good news: a **second** run against a story the first one
holds is refused by name, telling you who has it. Your own re-run of an
interrupted scope is not refused — it resumes.

#### The shape rule is a STORY rule, and a sprint has none

A story is expected to be **one layer**: its children are the work. A story whose
child is itself a container is refused, naming that child and how many levels
down the work actually sits, and the run submits a re-plan of the story (unless
you passed `--disable-replan`, which suppresses the submission and not the
diagnosis).

A **sprint** has no such rule, and that is not an oversight. A real sprint holds
stories, their subtasks and loose cards together at mixed depths, and that is
legitimate. Sprint membership is a **direct** field — a card is in a sprint or it
is not, never by inheritance — and a sprint that validates has already had its
membership closed, so there is nothing for a shape check to catch.

#### One pull request per REPOSITORY, not one per run

The headline is "one pull request, one CI run", and it is exactly true for a
scope whose cards all ship in one repository. A story **may** span repositories,
and then it produces one pull request per repository it touched — one branch
each, opened by the CLI as a DRAFT at that repository's first implemented card,
and the summary names every one of them. Nothing here claims a single pull
request for a multi-repository scope, and you should not either when you go to
merge: the container closes when the LAST of them merges.

#### When NOT to use it

- **The story contains human work.** A `manual` / `executor: human` card is
  claimed with the rest, skipped by name, and left where it was — so the story
  correctly stays open. If the story is mostly human work, a scoped run mostly
  claims cards nobody will touch.
- **The story has not been decomposed.** There is nothing under it to run; the
  refusal says so, and `motir plan <key>` (or `--include-planning`) is the
  answer.
- **You want the run to FOLLOW the ready set.** A scoped run is deliberately
  snapshot-shaped: it holds a fixed list and orders it from the dependency graph,
  so work that becomes ready elsewhere during the run is not picked up. That is
  `motir auto`'s job.

### A card that ships in more than one repository

A work item can name a repository **set** rather than one repository — a change
whose halves are written against each other, in `motir-core` and `motir-meta`,
say. Running one is not a different command; it is the same command with more of
everything except the agent:

- **ONE agent process**, launched in the primary's checkout. The other
  repositories are places it works, not places it is launched in. (N agents would
  each get the whole card and have to guess which half was theirs.)
- **ONE worktree per repository**, and **ONE branch name shared by all of them**
  — so `gh pr list --head <branch>` finds the whole set, in every repository, and
  the pull requests read as halves of one change rather than unrelated pushes.
- **ONE pull request per repository**, each with the item's `MOTIR-<n>` in its
  **title**. The key is the load-bearing part: the completion gate counts merges
  against the item's _linked_ pull requests, so a title without it is invisible
  to the gate and the card is held forever by work that has already shipped.
- **The item completes only when EVERY repository's pull request has merged.**
  One merge leaves it held at In Review — correctly. The run says so and does not
  offer you `motir done <key>`, which could not succeed against the gate.

**A partial delivery is a resting state, not an error.** The run exits 0 and
tells you what is outstanding; re-running the card is a **RESUME**. The run names
it as one before the agent starts — which repositories have already delivered,
which remain — and the agent is told not to re-open a pull request in one that
has merged. Each repository line also carries its own state:

| state           | what it means, and where to look next                                      |
| --------------- | -------------------------------------------------------------------------- |
| `delivered`     | a pull request merged onto that repository's own default branch            |
| `awaiting`      | no merged pull request yet — look at the host                              |
| `unknown`       | a merge is recorded but not which branch it reached                        |
| `unestablished` | the repository does not exist yet — establish it on the project first      |
| `excluded`      | the project is deliberately code-less there; it does **not** hold the card |

`unestablished` and `excluded` are deliberately not shades of `awaiting`: what
differs is your next action, not the nuance.

**Older servers.** A Motir that predates the repository set sends no set at all,
and the CLI then behaves exactly as it always did — one repository, one pull
request. See [When your server is older](#when-your-server-is-older).

**All three record what BUILT each item** — the agent Motir launched, and the
model that agent reported. `auto` and `run` record it while marking the item
integrated; `batch` has no session branch to mark, so it reports provenance on
its own. None of them writes a branch it did not create: a recorded session
branch is what tells Motir a dependency is satisfied, so stamping one to carry
provenance would release dependents with nothing merged.

**`motir batch` freezes the list and prints it before the first agent starts** —
so you can Ctrl-C out of a run you did not want while nothing has been touched.
A strictly main-ready snapshot is mutually independent by construction (an item
is in it only when every dependency is done **on main**), which is why it needs
no session branch: each item rides the per-item flow unchanged. An item that is
ready **only** because a dependency is integrated-awaiting-review is excluded
and named — that dependency's code is not on `main`, so a pull request of its
own could not even build. That lineage is `auto`'s territory.

**`motir batch` tells you where its cards actually ENDED UP.** After the drain
and before it exits, it reads each dispatched card back and prints its CURRENT
status — not the outcome the run observed, which answers a different question.
Three groups:

- **In Review** — CI went green while the run was still going. Review and merge.
- **Implemented** — the pull request is open and CI has not spoken yet. **This is
  the normal, healthy row, and it is what most of them will say.** Nothing is
  wrong with it and there is nothing to do: the card moves to In Review on its
  own when its checks pass.
- anything else — named with the status actually read, because that is the only
  group that needs a person.

A card the run could not read back is shown as **unread with its reason**, never
dropped and never assumed to be Implemented. It is a READ, not a wait: nothing
polls CI and nothing retries, so what you get is an honest snapshot at exit.

**A run CLAIMS what it takes, and the claim is a LOCK.** Every dispatch path —
`run`, `next`, `batch`, `auto` — takes its card with ONE call
(`POST /api/v1/work-items/{key}/claim`), which inside a single transaction locks
the row, re-checks that it is still in the **to-do category**, assigns it to the
token owner and moves it to In Progress. That is the signal a teammate reads on
the board: someone has this. It is expressed on the CATEGORY and never on a
status key, so a project that defines its own statuses gets the rule for free
and a card at `Planning` leaves circulation without anything special-casing it.

**Two runs at one card: exactly one starts.** This used to be an advisory — an
unconditional assignment with a read-to-write gap two simultaneous runs fell
straight into, which the CLI documented as an accepted race. It is not one any
more. The loser is told which of three things happened, because the three call
for different next moves:

| the run is told | what it means                                         | what it does                                      |
| --------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `claimed`       | it is yours                                           | dispatches                                        |
| `mine`          | already yours, In Progress — your own interrupted run | dispatches, saying so                             |
| `taken`         | somebody else holds it, **and they are named**        | does not dispatch                                 |
| `not_claimable` | outside the to-do category                            | does not dispatch, and says which status it is at |

**Which statuses a run REFUSES.** Anything outside the to-do category:
`implemented`, `in_review`, `planning`, `done`, `cancelled`, and any status your
project's workflow adds that is not in that category. **`todo` and `blocked` are
both inside it**, which is why `motir run --force` on a card whose dependencies
are unmet still works — `--force` bypasses the _readiness_ gate, and readiness is
a different question from claimability.

⚠️ **`motir run <key>` refuses these too, and that is a deliberate change.** It
used to warn about `in_review` and `planning` and dispatch anyway, on the
reasoning that a person who names a key has a reason — and it said _nothing at
all_ about a `done` card, which it silently reopened, because `done → in_progress`
is a legal workflow edge. That is a good argument about who owns a card and a bad
one about whether finished work should be restarted. So the split is: the server
owns which STATES a run may claim from, and the CLI keeps the one warning the
server deliberately does not enforce — **a to-do card assigned to somebody else
is still claimable, and `motir run <key>` warns you that you are taking it.**

**A refusal is not a failure.** In `run` and `next` it ends the command cleanly,
exit 0. In `batch` and `auto` it is recorded as a SKIP with its own reason —
_claimed by somebody else, or no longer claimable_ — beside _needs planning_ and
_needs a human_; no agent ran, nothing was reverted, and the run's exit code is
unaffected by it.

**What both loops skip.** An unexpanded epic/story is a _planning_ item, not a
dispatchable one — there is no agent prompt for "do the planning" — so it is
skipped untouched under _needs planning_. A `type: manual` / `executor: human`
item is skipped the same way under _needs a human_. Neither is transitioned;
they are left exactly as the loop found them.

**`motir auto --include-planning`** turns the first of those into an action: the
CLI submits an AI expansion (`expand_item`), records it, and asks for the next
ready item **immediately**. It triggers; it never waits — the job's output is a
plan of **proposals**, and approving that plan in Motir is the only thing that
turns a proposal into a work item, so there is nothing here to wait _for_. The
item goes on the run's exclude list because it stays childless and would
otherwise be handed straight back. A failed expansion is **non-halting** (unlike
a failed agent): nothing in the run depended on it. Expansions spend the **AI
credits of the token owner**, which is why the flag is opt-in. There is no
`--include-planning` on `batch` — an expansion's output could never join a
frozen snapshot.

---

## Planning from the terminal

`motir plan` is the planning front door, not a dispatch command: it changes the
**plan** rather than implementing an item, which is why it takes no agent.

```sh
motir plan                                # resume the project-wide conversation
motir plan MOTIR-42                       # resume it anchored at MOTIR-42
motir plan "split the billing epic"       # one turn, submitted, proposals printed
motir plan MOTIR-42 "size these" --detach # anchored, submitted, ids returned
```

Leading `MOTIR-<n>` arguments **anchor** the conversation at those items; the
rest of the arguments are a turn.

**It is a conversation, and it is the same conversation the web app shows.** The
thread is persisted and resumable, addressed by its scope (the project, or the
project plus the anchor keys) — so a turn typed in the terminal appears in the
web planning panel and vice versa. One conversation, two surfaces.

Interactively, turns **accumulate** and nothing reaches the planner until you
submit:

```
/submit   send every turn on this thread as ONE change
/exit     leave; the thread and its turns stay saved
/help     this list
```

Two things follow, and they are the contracts to hold onto:

- **Appending is not submitting.** A turn is server-side the moment you press
  Enter, so `/exit`, Ctrl-D, or a crash can never lose one. Only `/submit`
  spends the token owner's AI credits.
- **A submit PROPOSES; it does not write your tree.** What comes back is a plan
  of **proposals** — approving it in Motir is what turns a proposal into a work
  item. Nothing the CLI prints means "created N items".

By default `motir plan` waits for the planner and prints the proposal tree;
`--detach` returns the job id, plan id, and a review URL instead. Non-interactive
invocations must pass the turn as text — `motir plan` with no text and no TTY is
refused up front, because a prompt nobody can answer is the one failure mode
with no diagnosis.

**It does not onboard a fresh project.** A project with no work items is refused
with a pointer at the web onboarding interview: generating a _first_ plan is a
guided discovery flow, and `motir plan` joins the conversation once there is a
tree to evolve. (`motir auto --include-planning` is the other planning trigger —
it fires an expansion for an unexpanded container mid-run, and produces
proposals the same way.)

Streams split the same way the rest of the CLI splits them: **stdout carries the
result** (the proposal tree, or the detached ids), **stderr carries the
conversation** — so `motir plan "…" > plan.txt` keeps the proposals and leaves
the chatter on your terminal.

---

## Dispatch runs — the record of what a run did

**Every dispatch command opens a RUN.** `motir next`, `motir run <KEY>`,
`motir run <scope>`, `motir batch` and `motir auto` alike: the run is a persisted
record of what that invocation DID — which cards it owned, in what order, what
happened to each, and why it stopped. It is what turns _"Motir dispatched some
work"_ into something you can open and watch.

`docs/decisions/dispatch-run-record.md` is the decision behind it.

### A run is a SET, not a card

The most consequential thing about the record is that it holds a **set**. A run
that claims a whole story owns eleven cards, in an order, some of which it will
deliberately not take — and that is knowledge which exists at exactly one moment,
in one process. Three shapes:

| command                            | the set                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motir next` · `motir run <KEY>`   | **one card** — the degenerate case of the same object.                                                                                                                  |
| `motir run <story>` · `run sprint` | **the claimed scope** — every member the claim locked, including the ones not startable yet, in the dependency order the run then works them in.                        |
| `motir batch`                      | **the frozen snapshot** — what it took, in dispatch order, PLUS every card it skipped and the reason for each.                                                          |
| `motir auto`                       | **empty, then one leg per card.** The loop holds no plan by design — it asks for one item per iteration — so its run grows as it goes rather than starting with a list. |

**The skips are the useful half.** A card `motir batch` left out because it needs
a human, or because its dependency is only on a session branch, exists nowhere
else at all: nothing happens to a card that was never dispatched, so if the skip
does not ride the run's opening it is simply gone.

### Where to watch it

| surface       | what it shows                                                                                |
| ------------- | -------------------------------------------------------------------------------------------- |
| `/runs/<id>`  | the run: its set, each card's live state, the skips with their reasons, the stop reason.     |
| the work item | a run section on the card — live, saying which of N it is in this run — and its run history. |
| `/ready`      | a strip on the row a run is working, linking through to the run.                             |

A card's run history answers _"every run that carried a leg for this card"_, not
_"every run that named it"_ — so the sprint run that swept a card up is findable
from the card, which is where you will be looking.

### What leaves your machine

> Motir records what your run DID — the command, the cards it worked, what
> happened to each, and why it stopped. That is all it sends by default.
>
> Your agent's output stays on your machine. Log lines, file contents, diffs and
> prompts are only sent if you pass `--report-log` (or set `reportLogBodies` in
> your config), and they are deleted after 30 days.

A BYOK run executes on **your** machine, against **your** checkout, under **your**
key. Its log can carry file paths, source excerpts, error output and whatever your
environment happens to hold, so the default is that none of it is sent — the
lifecycle goes, the content does not.

**`--report-log` is a flag on `motir next`, `motir run`, `motir batch` and
`motir auto`**, and there is deliberately **no server-side setting** for it: the
machine that holds the content is the machine that decides whether it leaves. A
workspace admin cannot turn it on for somebody else's laptop.

### If reporting fails, the run does not

**Reporting is best-effort and can never break a run.** If Motir is unreachable,
answers 500, or your token has expired, the CLI prints **one** line saying run
reporting is unavailable and carries on: the agent still runs, cards still move,
pull requests still open, and the exit code is unchanged. You get one line per
session, not one per event.

The run surface shows such a run as **reporting-offline**. That is a run whose
RECORD is incomplete — not a run that failed.

### How long it is kept

The run and its lifecycle events are kept indefinitely: they are the product's
memory of what it did. **Opt-in log bodies are deleted after 30 days**, which is
the only part of the record that carries content from your machine.

`motir help runs` says all of this in the terminal.

---

## Session branches: what `motir auto` actually does

A run does **not** open a pull request per item. On the first item routed into a
given repo, the CLI creates ONE session branch there — `motir/auto-<run-id>`,
where the run id is a timestamp like `20260729-011830` — and every item's work
is integrated onto it. The CLI surfaces **one pull request per repo**: the run's
single human review gate.

**It opens as a DRAFT, at that repository's first implemented card, and the
close-out marks it ready for review.** Opening early is what puts CI on the work
as it lands rather than only at the end; the draft is what stops it asking anyone
to review a run that is still going — the title counts the cards it carries, and
the one written at card zero would be permanently wrong. Two consequences worth
knowing before you go looking for a missing pull request:

- **A run that stops early leaves a draft.** Halted, interrupted, or stopped on a
  re-plan: the work is pushed and reviewable-when-you-say-so, and the summary says
  the pull request is still a draft.
- **A container run whose children have not all landed leaves a draft too**, and
  the summary names the children it is waiting for. Re-run the container and the
  same close-out marks it ready.

**A card that carries more than one repository gets that branch in EVERY one of
them, or in none.** The name is the same in each — the run has one id — and the
close-out opens a session pull request in each repository the run branched in. It
is all-or-nothing per card on purpose: a lineage in some of a card's
repositories and not others is the one outcome that cannot be closed out, because
the close-out opens a pull request per _touched_ repository and a repository
holding the work but not the branch is invisible to it. So if any repository of
the card cannot carry the branch — its checkout does not exist — the **card**
gets no lineage at all and ships as its own pull requests everywhere, and the run
says which repository caused the fallback.

The branch is created **remotely**
(`git push origin refs/remotes/origin/main:refs/heads/<branch>`). The CLI never
checks out and never creates a local branch, so `motir auto` in a repo with a
dirty working tree is safe. Creation is idempotent: a re-run finds the branch
present and reuses it rather than rewinding the commits already on it.

**Statuses run ahead of `main`, deliberately.** An integrated item is recorded
with `mark_integrated` and moves to **Implemented** — never Done, and not yet In
Review either. Implemented is the honest status: the work exists on the session
branch, `main` does not have it, CI has not spoken for it, and a human has not
looked at it. When the branch's checks go green the webhook moves the whole
branch's cards on to In Review (see
[The status lifecycle](#the-status-lifecycle--who-moves-the-card-and-when)). That same recording is what makes the item's
dependents ready _mid-run_, which is how the loop cascades through the
dependency graph instead of stopping at whatever happened to be ready at second
zero. So between the run ending and your merge, the tenant shows a set of Implemented
items (In Review once the build is green) whose code is not on `main`. That is
the design, not drift.

**Nothing reaches Done without you.** The session branch carries no `MOTIR-<n>`
key in its name or its pull-request title — on purpose. Motir's status webhook
parses a PR's branch and title for a key, and a session PR carries _many_ items;
a key in either would link the whole run to one card and move only that one. The
keys ride in the PR **body**, which is not parsed. The real close-out is
explicit:

```sh
motir done --session motir/auto-20260729-011830
```

which walks every item recorded on that branch to Done in one call
(`complete_session`) and prints the per-item outcome.

### Why there is no auto-merge to `main`

Because the shipped close-out is a human's. `motir auto` runs entirely in
`workflowMode: 'session_lineage'`
([`packages/cli/src/commands/dispatch.ts`](../packages/cli/src/commands/dispatch.ts),
the `deliver()` branch that calls `mark_integrated` instead of transitioning
directly, and the merge close-out below it). In that mode the item's _best_
outcome — agent exited 0, work integrated, branch pushed — is **Implemented**,
and In Review only once CI agrees. There is no code path anywhere in the CLI that merges
a pull request, advances `main`, or moves an item to Done on its own: the only
`done` write in the tool is the one you type. The prompt agrees with the CLI —
the session-lineage GIT WORKFLOW tells the agent to integrate into the session
branch and explicitly **not** to open a pull request of its own.

So the boundary is a property of the design rather than a setting: an unattended
loop can produce as much work as you let it, and every line of it still waits in
one reviewable pull request per repo. This document is the record of that
decision; there is no separate ADR for it.

### Unwinding a rejected run

If you don't want what a run produced, **don't run `motir done --session`** —
that is the only thing that would move those items to Done.

- The items stay **Implemented** (or In Review, if the build went green) and the
  summary names every one with its branch, so nothing is lost track of.
- To redo one, `motir run <key>` re-dispatches it: the CLI moves it back to In
  Progress (a legal edge from both Implemented and In Review) and fetches a fresh
  prompt.
- To abandon the run, close the pull request and delete the branch on origin.
  Moving the items _backwards_ in the workflow is a web-app (or direct API)
  action — the CLI's only status writes are the dispatch
  flips and `motir done`, and it will not silently walk an item through a status
  you did not name.

---

## Failure policy

**A non-zero agent exit is an ordinary outcome, not a crash.** The item is left
**In Progress** — work was started and is half-done, so reverting it to To Do
would hide that — and **nothing is reverted** in the repo.

- The item is added to a persisted **session exclude list**
  (`~/.local/state/motir/session-excludes.json`, scoped per server + project), so
  the next `motir next` moves past it instead of re-picking the same failure.
  `--reset` clears the list; a later success (or `motir done`) drops that entry.
  It is a convenience, not a correctness mechanism — a failed item is already
  held out of the ready set by its `in_progress` status — so if that file cannot
  be written, Motir says so once and carries on rather than failing the run.
- `motir next` / `motir run` propagate the agent's own exit code, so a script
  wrapping them can tell a failed run from a successful one.
- `motir auto` and `motir batch` **halt** on the first failure by default;
  `--keep-going` finishes the rest.
- Either way the **end-of-run close-out still happens**: the branch is pushed
  and the pull request opened, so a late failure never abandons the work that
  already integrated.
- **Ctrl-C** stops between items (a second Ctrl-C exits immediately), then still
  lands the pull request and prints the summary.

**Exit codes.** `0` success · `1` any dispatch failed, or a user-facing error
(printed as one `Error:` line plus a `Hint:` on stderr) · `130` interrupted.
An unexpected internal error prints a stack — that distinction is deliberate: a
missing link is a CLI error, a programming bug is not.

**A bootstrap dispatch that produced no checkout is a failure**, not a success
with a warning: the prompt's whole job was to create that checkout, and every
later item routed at the repo would repeat the same bootstrap. The CLI names the
expected path and suggests `motir link add <repo> <path>` in case the repo
simply lives off-convention.

### Closing out

After you merge:

```sh
motir done MOTIR-42                    # per-item pull request (next / run / batch)
motir done --session <branch>          # a merged session pull request (auto)
```

Since MOTIR-1625 the default workflow carries a **direct `in_progress → done`
edge** — review is optional, not mandatory. So `motir done` is a single legal hop
both for an item the CLI watched finish (already Implemented, or In Review once
CI passed) and for one
dispatched with `--print`, where Motir never observed an agent finish and the
item is still In Progress.

`--via` walks the item through a named status first:

```sh
motir done --via in_review MOTIR-42
```

Reach for it on a custom workflow with no direct edge, or when you want the
review hop recorded. It is opt-in and never inferred: the CLI does not walk an
item through a status you did not ask for. An illegal flip surfaces the server's
own allowed-targets error verbatim, plus that hint.

---

## Agent wiring

Which agent runs, in priority order: **`--agent <cmd>` → `MOTIR_AGENT` →
`agentCommand` in `~/.config/motir/config.json`**. The value is a full command
line; the first token is the binary Motir looks for on PATH.

**The prompt is delivered two ways at once**, because agent CLIs disagree about
how they take input:

- on **stdin**, for agents that read a piped prompt; and
- as **`$MOTIR_PROMPT_FILE`** — a path to a `0600` temp file — for agents that
  want `--prompt-file <path>`, or that re-exec themselves and lose stdin.

Supplying both means a new agent usually needs no Motir change at all. The child
inherits stdout/stderr, so its output **streams through live** — a coding-agent
run is minutes long, and a silent terminal is indistinguishable from a hang.

**One channel runs the other way: `$MOTIR_AGENT_REPORT`.** It names a path in the
same per-dispatch temp directory, and the prompt asks the agent to write
`{"model": "<the model it is running as>"}` there. That answer becomes the item's
`implementationModel`, because nothing outside the agent process can observe which
model answered — while the `implementationHarness` beside it is derived from the
agent command Motir launched, and needs no cooperation at all. An agent that
writes nothing leaves the model **null**: a guessed model is a wrong answer that
looks like a right one, and the record cannot be re-interrogated after the run.
The directory is created for one dispatch and removed when it ends, so a report
can only ever describe the run it came from.

### Headless recipes

An unattended run needs the agent to stop asking for approval. These flags
**drift between releases** — run `<agent> --help` against the version you
actually have, and treat a mismatch as this table being stale.

```sh
motir auto --agent "claude --dangerously-skip-permissions"
motir auto --agent "codex exec --sandbox workspace-write --ask-for-approval never"
motir auto --agent "opencode run --auto"
motir auto --agent "kimi -p"
motir auto --agent "agy -p --dangerously-skip-permissions"        # Antigravity
motir auto --agent "agent -p --force"                             # Cursor
motir auto --agent "aider --yes-always"
GOOSE_MODE=auto motir auto --agent "goose run --no-session"
```

Set it once instead of per invocation:

```sh
export MOTIR_AGENT="claude --dangerously-skip-permissions"
motir doctor && motir auto --max 5
```

Any other agent works too — pass its own unattended flag and Motir launches it
unchanged. `motir doctor` still checks the binary; for an agent it does not have
a profile for, confirming the credential is yours.

### The copy-paste flow

No agent configured is a first-class mode, not a degraded one:

```sh
motir next --print                  # prompt on stdout, context on stderr
motir next --print | pbcopy         # copy the prompt alone
motir next --print > /tmp/task.md   # …or hand it to anything else
```

Paste it into your editor's agent, let it do the work and open the pull request,
then `motir done --via in_review <key>` once you merge.

---

## The sandbox

> The published setup guide — **<https://app.motir.co/docs/sandbox>** — walks the
> same path without a checkout: pick a profile, start the container, sign in, link,
> check.

An unattended agent running with permissions bypassed is worth confining. Motir
publishes a container image for exactly that — `motir auto` in a normal console
stays **fully supported**; the container is the _recommended_ path, not a
requirement.

Pull and go — no checkout, no build:

```sh
docker run --rm -it \
  -v "$PWD:/workspace" \
  -e MOTIR_TOKEN -e MOTIR_SERVER \
  -v "$HOME/.claude:/home/node/.claude:ro" \
  ghcr.io/motir-co/motir-sandbox:claude \
  motir auto --agent "claude --dangerously-skip-permissions"
```

The host contract is a **writable** `/workspace` (your `.motir.json` tree — the
only host path the agent can change) and a **read-only** mount of your agent's
own credential. Run it from your **workspace root**, not from inside a single
checkout — `motir auto` dispatches across every repo in the workspace.

**The Motir credential has three routes in, and the mount is no longer the only
one.** `MOTIR_TOKEN` / `MOTIR_SERVER` are read by every command, so a fresh
machine or a CI runner that never ran a host login gets in with two environment
variables and no host state at all. With no mount, `~/.config/motir` inside the
container is writable — so `motir login`, headless by construction, runs in
there too. Mounting a host credential still works and is still read-only:

```sh
  -v "$HOME/.config/motir:/home/node/.config/motir:ro"   # optional
```

An env credential outranks a mounted one and is never written to disk.

The images are **public** — no `docker login`, no token, no GitHub account. That
is asserted on every release by a job that holds no credential at all, so "pull
and go" stays a fact rather than an intention; you can run the same check
yourself with `node packages/cli/sandbox/smoke/assert-public.mjs --ref
ghcr.io/motir-co/motir-sandbox:claude`.

There is one tag per agent profile (`claude`, `codex`, `opencode`, `kimi`,
`antigravity`, `cursor`, `aider`, `goose`) plus an agent-less `base`, built for
linux/amd64 + linux/arm64 — all tags of the one `motir-sandbox` package.
`:<profile>` moves with each release; `:<profile>-<version>` is immutable. **Pin
the digest for anything you need to reproduce** — the digest table is filled in
from each `cli-v*` release run, and the registry is always the authority:

```sh
docker buildx imagetools inspect ghcr.io/motir-co/motir-sandbox:claude
```

**Building it yourself** stays supported, and is the path to take when you are
customising a profile, adding an agent, or running an unreleased commit — as it
is today, before the first `cli-v*` tag publishes the images. The build context
is the motir-core repo root:

```sh
docker build -f packages/cli/sandbox/Dockerfile --build-arg AGENT=claude \
  -t motir-sandbox:claude .
```

A locally built image runs exactly like a pulled one — same mounts, same
entrypoint, only the image reference changes. Compose and dev-container forms
ship alongside it.

**What it confines, and what it does not.** The filesystem blast radius is
confined to the mounts above (no docker socket, no other host bind) and the
container runs as the unprivileged `node` user, so files land owned by you.
**Network egress is open by design** — every coding agent needs its provider
API, and every dispatched item needs git remotes plus the Motir server; reach
for docker's own `--network` controls if your threat model needs more.

Full detail — the profile matrix, per-agent credential mounts, the CodeGraph
wiring, and the CI/publish lanes —
[`packages/cli/sandbox/README.md`](../packages/cli/sandbox/README.md).

---

## Files and environment

Motir keeps exactly **two** files, and only one holds a secret:

| Path                           | What                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `~/.config/motir/config.json`  | **Secret — never commit.** The credential store, `chmod 600` inside a `0700` dir, keyed by server URL. Also `agentCommand`. |
| `.motir.json` (workspace root) | **No secret — safe to commit.** The link: server, workspace, project, plus the optional `repos` override map.               |

A third file, `~/.local/state/motir/session-excludes.json`, holds the
failed-dispatch exclude list (ids and keys of your own project — no secret). It
is **state, not a credential**, so it lives in the state home rather than beside
the PAT: the sandbox image mounts the config dir read-only, which would leave the
CLI no writable state directory at all. Setting `MOTIR_CONFIG_HOME` still moves
it too, so one relocation continues to move the whole CLI state.

Eleven environment variables, none required — each overrides a default
(`motir help environment` prints this from the shipped code). The last four are
what a hosted run's container is configured with:

| Variable                | Overrides                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOTIR_TOKEN`           | The PAT, honoured by **every** command. Set it and there is no login step and no file. Outranks a stored credential.                                                                         |
| `MOTIR_SERVER`          | Which server to talk to. Chain: `--server` > this > `.motir.json` > the single stored server > `https://app.motir.co`.                                                                       |
| `MOTIR_AGENT`           | The agent command. Precedence: `--agent` > `MOTIR_AGENT` > `agentCommand` in config.                                                                                                         |
| `MOTIR_CONFIG_HOME`     | Where `motir/config.json` lives. Highest-precedence config home; also the second-choice state home.                                                                                          |
| `XDG_CONFIG_HOME`       | The config home when `MOTIR_CONFIG_HOME` is unset (else `~/.config`).                                                                                                                        |
| `MOTIR_STATE_HOME`      | Where `motir/session-excludes.json` lives. Chain: this > `MOTIR_CONFIG_HOME` > `XDG_STATE_HOME` > `~/.local/state`.                                                                          |
| `XDG_DATA_HOME`         | Motir stores nothing here — `doctor` reads it only to find where _your agent_ keeps its credential.                                                                                          |
| `MOTIR_DISPATCH_RUN_ID` | A run Motir already opened: `motir run` ADOPTS it, needs no `.motir.json` and never prompts. `--run-id` outranks it.                                                                         |
| `MOTIR_RUN_TOKEN`       | A hosted run's own credential. Chain: `--token` > `MOTIR_TOKEN` > this > config. Never written to `config.json`; the run keeps it in its own owner-only state for the git credential helper. |
| `MOTIR_API_URL`         | The server a hosted run reports to. Chain: `--server` > `MOTIR_SERVER` > this > `.motir.json`.                                                                                               |
| `MOTIR_WORKSPACE`       | Where a hosted run clones its repositories, as `<root>/<name>`. Default `/workspace`.                                                                                                        |
| `MOTIR_MODEL`           | The model a hosted run's OpenCode runs on (`anthropic/<id>`). A hosted run launches OpenCode itself; `MOTIR_AGENT` is not read there, only `--agent`.                                        |
| `MOTIR_GATEWAY_URL`     | The gateway a hosted run's OpenCode reaches its model through (the egress contract's provider configuration).                                                                                |
| `MOTIR_RUN_KEY`         | The run's gateway key — the one credential OpenCode's environment holds.                                                                                                                     |

`motir doctor` probes your agent's own key variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CURSOR_API_KEY`) for **presence** and never reads a value.

---

## When your server is older

The CLI is published to npm on its own schedule, and self-hosted Motir upgrades
on yours. So a newer CLI meeting an older server is a NORMAL state, not a broken
install — and one message exists to say so out loud rather than leaving you with
a field that is mysteriously missing.

```
Error: This CLI needs Motir API >= 1.6.0; https://motir.example.com serves 1.4.0.
Hint: Upgrade your Motir server, or install a CLI built for it.
```

**What the numbers are.** Both are the **API contract's** version, not an app
release number and not the CLI's own `--version`. It is `MAJOR.MINOR.PATCH`,
where MAJOR is the path version (the `1` in `/api/v1`), MINOR increments when the
API gains something, and PATCH on a documentation-only correction. A deployment's
release number would tell you nothing you could act on; this one tells you
exactly what the server can and cannot do. The server publishes it as
`info.version` in [`/api/openapi/v1.json`](https://app.motir.co/api/openapi/v1.json),
and you can read it yourself:

```sh
curl -s https://motir.example.com/api/openapi/v1.json | jq -r .info.version
```

**The two remedies**, and there are only two:

1. **Upgrade the server** to a Motir serving at least the version named. This is
   the right move when you control the deployment — the CLI is asking for
   something the API genuinely does not have yet.
2. **Install a CLI built for that server.** `npm install -g @motir/cli@<older>`
   when you do not control it, or do not want to move it today. Each published
   CLI records the API version it was generated against, so an older one asks for
   less.

**The ready lanes need `1.54.0`.** This CLI reads the ready set through the
three lane operations (`…/ready/leaves`, `…/ready/containers`, `…/ready/bugs`),
which a server older than contract `1.54.0` does not serve. Against one, every
ready read — `motir next`, `motir ready`, `motir auto`, `motir batch`, a scoped run
— reports the version skew above rather than a missing endpoint; the remedy is one
of the two.

**A MAJOR mismatch is the other direction** and says so — _"This CLI speaks Motir
API v1, but … serves v2"_ — with the opposite remedy: upgrade the CLI.

**When you will and will not see it.** Nothing on a normal response carries the
contract version, so the CLI does not ask on every command; it probes the spec
only after a failure that skew could explain, at most once per run. Two
consequences worth knowing:

- **A server at or AHEAD of the CLI's version is never reported as skew.** The
  API only ever adds within a major version, so a newer server is compatible by
  construction — and reporting a real bug as an upgrade prompt would send you
  off to fix the wrong thing.
- **A field the server does not send yet is a QUIET fallback, not an error.**
  Motir before contract `1.12.0` sends no repository SET on the dispatch payload,
  so the CLI resolves one repository, prints one `Repo:` line, and expects one
  pull request — exactly what it always did. Nothing warns, because nothing is
  wrong: that server has no multi-repository cards to run.
- **If the probe cannot reach the spec, you get the original error, not a
  guess.** A failed probe is not evidence. If a command fails in a way you think
  is skew and no upgrade message appears, `curl` the spec yourself with the
  command above.

---

## Troubleshooting

**`motir login` printed a code but no browser opened.** That is a supported
outcome, not a failure — the launch is additive and the printed code and URL are
sufficient on their own. Open the URL on any device, sign in, and enter the code;
the terminal is still waiting. Pass `--no-browser` to skip the attempt entirely
on a box you know is headless.

**`Error: The code expired before it was approved.`** — codes last 15 minutes.
Nothing was written, so there is nothing to clean up: run `motir login` again for
a fresh one.

**`Error: Approval was denied. No credential was written.`** — someone (possibly
you, on the wrong request) pressed Deny at `/device`. Nothing was created, so
there is nothing to revoke. If that request was not yours, it means someone had
your code — start a fresh `motir login` and approve only a code you are looking
at in your own terminal.

**`Error: Could not write the credential to <path>.`** — the config directory is
read-only. The sandbox image mounts it that way deliberately, since a container
consumes a credential rather than minting one. Either make the directory
writable, point `MOTIR_CONFIG_HOME` at one that is, or skip the file entirely
with `MOTIR_TOKEN` — the environment tier is never written to disk.

**`Error: <server> refused to start a login (HTTP 404).`** — that server predates
`motir login`. Use the paste path instead: `motir auth login --token <pat>`.

**`Error: Token invalid or expired.`** — the token was revoked, expired, or
never stored for this server. Every 401 maps to this one error with the same
hint; the CLI does not guess which of the four it was, because the server
deliberately does not say (a uniform 401 is what stops an attacker learning
which tokens exist). Reconnect with `motir login`, or store a
fresh PAT with `motir auth login`. `motir auth status` tells you which token the
CLI is holding for a server — and which source it came from — without exposing
it.

**`Error: No Motir project link found in this directory or any parent.`** — you
are outside the linked tree. Run `motir link` at your workspace root, or `cd`
into it. Remember the lookup walks **upward** only: a sibling directory of the
root is not covered.

**`MOTIR-42 is not ready. Waiting on: …`** — readiness is dependency-only, so
the message names the open blockers (and an ancestor that is itself blocked). If
you know a blocker is about to merge, override it deliberately:
`motir run MOTIR-42 --force`. When the only thing holding it is an ancestor's
block (a SOFT block), the hint names the narrower override instead:
`motir run MOTIR-42 --allow-soft-block`. This is a refusal rather than a silent
decision on purpose.

**`Suspect dispatch: the agent exited 0 but "<repo>" still has no checkout at
<path>.`** — a bootstrap dispatch did not produce its checkout. Usually the repo
lives off-convention: `motir link add <repo> <path>` and re-run. If the agent
genuinely failed to scaffold, `motir run <key>` re-dispatches it. On a card that
ships in more than one repository this check runs for **every** one of them, so
the name in the message is the repository that had nowhere to work — not
necessarily the one the agent was launched in.

**`⚠ no checkout here yet` in the repositories block, on a card with two or more
repositories.** — a WARNING, not a refusal, and the dispatch proceeds. The CLI
cannot know whether that repository's half is already merged or whether your
checkout simply lives somewhere the `<root>/<name>` convention does not predict,
so it tells you and lets you decide. `motir link add <repo> <path>` fixes the
off-convention case; cloning it fixes the other. If neither applies because that
half is genuinely done, the run's own delivery states will say `delivered`.

**`No session branch possible in <path>` during `motir auto`.** — one repository
of a card the loop is about to dispatch cannot carry the run's session branch, so
the **card** gets no lineage and ships as its own pull requests in all of its
repositories. It is a deliberate all-or-nothing: a lineage in some of a card's
repositories and not others could never be closed out. Create or link the named
checkout and re-run if you want the card on the session branch.

**`motir next` says "No ready work items in the leaf lane" but the board disagrees.** The item may be a bug (`motir next --bug`) or a whole story (`motir next --parent`) — each lane is asked separately. Check for
the skip line above it: previously-failed items are held out via the exclude
list. `motir next --reset` clears it and retries them. Also confirm `--kinds`
isn't narrowing the set, and that the token's user can actually see the project
(`motir doctor`).

**`` `motir auto` needs an agent to run. ``** — an unattended loop cannot run in
`--print` mode. Pass `--agent "<cmd>"`, set `MOTIR_AGENT`, or configure
`agentCommand`; `motir doctor` verifies it before the run.

**`` `motir plan` needs a terminal to converse in. ``** — a non-interactive
invocation with no turn text would sit on a prompt nobody can answer. Pass the
turn as an argument: `motir plan "<what to change>"`, plus `--detach` to skip
the wait.

**`<PROJECT> has no work items yet — there is no plan here to change.`** — the
project has never been planned. `motir plan` evolves an existing tree; the first
plan comes from the web onboarding interview the hint links to.

**A `transition_status` failure naming allowed targets.** The workflow refused
the move. For a merged item still sitting In Progress, that is the missing In
Review hop: `motir done --via in_review <key>`.

**The agent binary can't be launched (ENOENT).** That is a setup problem, not a
failed piece of work, so it stops the run rather than being recorded as a failed
item. `motir doctor` diagnoses it and names the profile's install source.

---

## See also

- **[`/docs/cli`](https://app.motir.co/docs/cli) — the published CLI guide.**
  The first hour, for someone with no checkout: install, `motir login`,
  `motir link`, `motir doctor`, the ready set, and one item dispatched, plus the
  command table derived from the CLI's own record. **This file is the
  reference** — everything past that first successful run (every flag, the three
  run shapes, session branches, the failure policy, agent wiring,
  troubleshooting) lives here and is not repeated there.
- [**`/docs/api`**](https://app.motir.co/docs/api) — the reference for the API
  this CLI uses, and the machine-readable spec at
  [`/api/openapi/v1.json`](https://app.motir.co/api/openapi/v1.json). Everything
  the CLI does is in there.
- [`docs/mcp.md`](./mcp.md) — Motir's OTHER client surface: the Model Context
  Protocol, for agents. The CLI does not use it, but the two share one credential
  and one scope vocabulary, and that page is where minting a PAT and the per-scope
  detail are written down.
- [`packages/cli/README.md`](../packages/cli/README.md) — the package's own
  reference: toolchain decisions, module layout, and the two test lanes.
- [`packages/cli/sandbox/README.md`](../packages/cli/sandbox/README.md) — the
  sandbox image in full: profile matrix, credential mounts, CodeGraph, CI.
- **`/ready`** in the web app — the human mirror of `motir ready`, with an
  in-app help popover explaining what makes an item ready.
