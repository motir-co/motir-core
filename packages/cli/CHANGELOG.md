# Changelog — `@motir/cli`

## 0.16.0

### Minor Changes

- 4140d2b: A run in your own agent now records the decisions the agent made where its card left the how open (MOTIR-10000). The agent writes them into its self-report as `decisions` (what the plan said, what it chose, why, and optionally the alternatives); the CLI keeps the well-formed ones, at most 20, and posts them on the run's discrepancy record beside any build-through points, or alone. The sandbox README and the staleness hint now name `ghcr.io/motir-co/motir-sandbox`, the image's home since the org move (MOTIR-9346), and the generated API client carries the pages operations over REST `/api/v1` (MOTIR-9486).

## 0.15.1

### Patch Changes

- 4bc5737: `repository.url` (and `@motir/cli`'s `bugs.url`) now name `motir-co/motir-core`, the repository's home since the org move. npm refuses a provenance-signed publish whose `repository.url` names a different repository than the one in the provenance, so every CI publish since the move failed with E422 (MOTIR-9320). No code changes.

## 0.15.0

### Minor Changes

- 646dd3b: `motir fix` in your own agent now continues the card's last session (MOTIR-9052). When the card's last run was in the same agent and recorded a session, the repair resumes that conversation instead of starting a fresh agent, prints one line saying so, and falls back to a fresh agent once if the resume fails. A repair in your own agent now answers a red CI or a failed acceptance re-run as well as a review.

### Patch Changes

- 646dd3b: `motir auto`, `motir batch` and `motir fix` now repair a red pull request in the conversation that built the card (MOTIR-9059). Each card's own session is handed to its CI watch, so in a multi-card run card N's fix lands in card N's conversation; a card that recorded no session keeps today's fresh-agent fix.

## 0.14.0

### Minor Changes

- 9552e64: A run in your own agent now shows the agent's progress while it works (MOTIR-8980). `motir run` launches each agent in the structured streaming mode it has, and no longer in the print-only mode that wrote nothing until the turn ended: `claude -p --output-format stream-json --verbose`, `codex exec --json`, `opencode run --format json`, `kimi --output-format stream-json -p`, and `goose run -q --output-format stream-json` (without `--no-session`). The stream is read with the same adapters as the Chat tab and written, to your terminal and to the run's Agent output, as readable lines: the reply text, one line per tool call (`Edit lib/x.ts`, `Bash: pnpm test`) and a line for each failure, never the raw events. Log lines reach Motir within about two seconds of the agent writing them instead of waiting for a 4 KiB batch and the next heartbeat. The run also records the agent's session id (`sessionId` on the `agent_started` and `agent_exited` events), and each profile carries the form that resumes that session. `aider` has no stream and is unchanged. Set `MOTIR_AGENT_OUTPUT=text` to force the old plain-text launch if a CLI version refuses the flags.

## 0.13.1

### Patch Changes

- 68ca56c: The sandbox images now ship `procps`, so `ps` is on the PATH and Codex's background app-server can start in a hosted agent (MOTIR-8868). Before this, every `codex` after a successful `codex login --device-auth` exited with `failed to invoke ps for pid-managed app server`. The fix merged in #3644 without a changeset, so it was never released; this patch release publishes it. Agents created from an earlier image keep that image, so create a new Codex agent to get it.

## 0.13.0

### Minor Changes

- 5415737: A run now reports what its agent writes into `$MOTIR_AGENT_REPORT` besides the model (MOTIR-8698, MOTIR-8722, MOTIR-8810). An agent that stops on an unbuildable card and writes its reason there as `unbuildable` gets the run-found report made for it (`POST /api/v1/dispatch-runs/{id}/unbuildable`); an agent with no Motir tools gets its build-through points (`discrepancy`) recorded on the card and its STOP (`stop`) commented and, when re-planning is on, the card moved to Planning. Every dispatch-prompt read now sends `agentReport=1`, which is how the server knows it may name that file as the route; 0.12.0 and older send nothing and are told to use the `report_unbuildable_target` tool instead, so their reports are no longer lost.

## 0.12.0

### Minor Changes

- 1b12cc3: Every leg a run reports now records the agent's self-reported model. `motir run`, `next`, `batch`, `run <scope>`, `continue` and `auto` send it as a top-level `model` on `agent_exited`, and `motir fix` and `motir review` now send it too (they sent none before). `fix` also sends its exit code top-level, so a repair leg records it like every other path, and it now reports each fixing attempt of its CI loop as an `agent_started` / `agent_exited` pair — before, a repair of a red build ran its agent without reporting it at all. The model is null when the agent reported none, never a guess.

## 0.11.2

### Patch Changes

- 19c6af4: A run now sends its first heartbeat the moment the CLI opens or adopts it, then every 60 seconds as before (MOTIR-7328). A run killed in its first minute used to have sent no heartbeat at all, so Motir read it as a run from a CLI too old to heartbeat and kept it alive for 12 hours: `motir continue` refused it as `run_alive` and the card showed no _run died_ marker. Now such a run is dead five minutes after it was last heard from, like any other.

## 0.11.1

### Patch Changes

- 9e2afea: `motir fix`'s acceptance Re-run closing turn now checks the checkout before publishing (MOTIR-7254). Where the repository's acceptance lane carries the `upload-acceptance-video` action — motir-core, and projects generated from the starter — CI's green pull-request run publishes the receipt, so the agent makes no MCP publish and reports that the lane published. Anywhere else it re-records and publishes over MCP exactly as before.

## 0.11.0

### Minor Changes

- e0050e1: The agent chat now works with Claude Code (MOTIR-7014), on an Anthropic API key or a cloud-provider sign-in only. Before a turn, the chat asks the installed `claude` for `claude auth status --json` and runs only when Claude Code authenticates with an API key the user configured or with a cloud provider (Bedrock, Vertex, Foundry); on a Claude subscription sign-in it answers `subscription_signin` and starts nothing, and a turn whose stream reveals no API key is killed at once and ends failed with the same code. A turn runs the unmodified `claude -p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions` with the prompt on stdin, streams its reply word by word, draws reads, edits (with their diff) and commands (with their output) as tool rows, and stops on SIGINT. The session list and a resumed session's earlier turns are read from Claude Code's own store for `$HOME/workspace`. Motir sets no API key, helper or `--bare` flag, and the terminal is unchanged.
- e0050e1: The chat beside the terminal now works on a Codex agent (MOTIR-7015). A prompt runs the agent's own `codex exec --json`, unwrapped, in `$HOME/workspace`, with the prompt on stdin and the sandbox set to `workspace-write` (a `-c` override, the only flag beyond the headless and resume forms); Motir adds no environment variable and no sign-in flag, so it chats on a ChatGPT sign-in and on an API key alike. Each event becomes a transcript event: the agent's message as text, a command with its output and exit code, a file change as an edit row per path, MCP calls and web searches as tool rows, errors as inline notices, and anything unrecognised as a quiet `other` row — reasoning and token usage are dropped. Stop ends the turn as stopped. The session list is read from Codex's own rollouts under `$CODEX_HOME/sessions`, only those begun in `$HOME/workspace`, newest first, at most 50, each titled by its first prompt; resuming one runs `codex exec resume <id>` and draws its earlier turns from the same rollout. Nothing is logged.
- e0050e1: The Chat tab now works on a goose agent (MOTIR-7035). A prompt runs the image's own `goose run -q --output-format stream-json -i -`, unwrapped, with the prompt on stdin and `GOOSE_MODE=auto` (goose's own auto-approve) as the only environment addition; a resumed chat adds `--resume --session-id <id>`. goose's streamed chunks become text deltas, a `shell` call becomes a command row with its output, a `text_editor` change becomes an edit row with its diff, a failed tool becomes a failed result, and `complete` ends the turn — its token counts are dropped. Stop's "Headless run interrupted" line is consumed, so the stopped marker is shown once. The session list comes from `goose session list --format json`, only sessions in `$HOME/workspace`, newest first, at most 50; a resumed session draws no earlier turns, because goose's store has no documented export. No line of a turn is logged.
- e0050e1: The agent chat now works on a kimi agent (MOTIR-7034). A prompt runs the unmodified `kimi -p <prompt> --output-format stream-json` in `$HOME/workspace` (plus `--session <id>` to continue a session), with no flag or environment variable added, and each streamed message becomes a transcript event: the reply (whole, not word by word), each tool call as a read, an edit with its diff, a shell command with its output or another tool, and each tool's result, failed ones marked. Stop ends the turn as stopped with the partial reply kept. The session list is read from kimi's own `session_index.jsonl`, limited to `$HOME/workspace`, newest first, at most 50; a resumed session's earlier turns are not redrawn, because kimi's session log format is not documented. Nothing from the stream is logged.
- e0050e1: The chat beside the terminal now works on an agent whose profile is `opencode` (MOTIR-7016). A prompt runs the unmodified `opencode run --format json --auto`, with the prompt on its argv and nothing added to its environment, and each JSON event becomes a transcript event: the reply's text, a tool call by its kind (a `read`, an `edit` with its diff, a `bash` command with its output and exit code, anything else by its name) and the tool's result, a failed tool drawn failed. The turn completes on OpenCode's `step_finish` with reason `stop`; Stop is the runner's SIGINT. The session list is OpenCode's own `opencode session list --format json`, scoped to the workspace, newest first and at most 50, and a listed session resumes through `--session <id>`, its earlier turns read from `opencode export <id>`. Reasoning, tokens and cost are dropped, an unrecognised event is shown as a quiet row and never logged, and nothing is copied off the agent's volume.
- e0050e1: `motir agent-terminal serve` now also answers `/v1/chat`, the chat beside the terminal on a Motir agent's machine (MOTIR-7012). The upgrade is refused exactly as `/v1/terminal`'s is unless it carries a relay token signed with the machine's own key. Over the chat socket the panel reads a `hello` (the profile, whether it can chat, and the terminal's sign-in state), lists the agent's chat sessions, opens a new one or resumes one with its earlier turns, sends a prompt and receives the turn as transcript events, and stops it. A turn runs the agent's own CLI once, headless, unwrapped, in `$HOME/workspace`, with the server's environment minus `MOTIR_TERMINAL_KEY`. Only one turn runs per agent; Stop is SIGINT, then SIGKILL after 5 seconds; a dropped connection does not stop a turn, and reconnecting replays it from a 256 KiB ring. A signed-out agent is refused before anything starts. The CLI-specific half is an adapter contract, and no adapter ships yet, so every profile answers that chat is unsupported until its adapter lands. It logs lifecycle lines with turn numbers, codes and durations only — never a prompt, a reply or a tool output.

## 0.10.0

### Minor Changes

- 011554e: `motir run <KEY> --run-id <id>` has an agent mode (MOTIR-7024): started inside one of your own Motir agents with `MOTIR_AGENT_RUN=1`, it adopts the run Motir opened and launches the coding agent the agent was created with, on your own sign-in. It uses the unattended command each profile now carries (`claude -p --dangerously-skip-permissions`, `codex exec --sandbox danger-full-access -`, `opencode run --auto`, `kimi -p`, `aider --yes-always --message`, `goose run --no-session -t` with `GOOSE_MODE=auto`). A profile with no unattended mode (`antigravity`, `cursor`) is refused as `agent_profile_cannot_run` before any card is claimed. The run's token is read from its state directory's `run.json` and never from `MOTIR_TOKEN`, and neither token is passed to the coding agent. The git helper, the `gh` shim, `GIT_CONFIG_GLOBAL` and `gh`'s own state live in that run-private directory, and the checkouts live under `~/.motir/runs/<id>`. Both are removed when the run succeeds, fails or is interrupted, and `~/.gitconfig`, `~/.config/gh` and your own checkouts are never written.
- 011554e: `motir agent-terminal` can start, stop and report a card's run inside a Motir agent (MOTIR-7025, `docs/decisions/agent-instance-run.md` §1, §2, §4). `motir agent-terminal run <KEY> --run-id <id>` reads the run's credentials as JSON on stdin, writes them to a `0600` `run.json` in the run's `0700` state directory `/tmp/motir-run-<id>/`, and asks the terminal server — over a local control socket at `/tmp/motir-agent-terminal/control.sock`, never the relay port — to open a session running `motir run <KEY> --run-id <id>` in agent mode; it prints `{"session":"<uuid>"}` and returns at once while the run keeps going. The token is never an argument, an environment variable, or sent over the socket. At most one run session exists per agent; a second is refused `run_active`. The run session is never reaped by the four-shell limit and does not count toward it, is listed to every terminal connection (`{"t":"sessions"}`, and `ready` carries `kind: "run"` and its `runId`) so a person can attach and watch it with its replay, and is watch-only: typed input is dropped. When it exits, its state and workspace directories are removed. `motir agent-terminal stop --run-id <id>` sends SIGTERM to the session's process group and SIGKILL after 10 seconds (`stopped`, or `not_found` for a run it does not know), `motir agent-terminal status --run-id <id>` reports `running` or `exited` with its code, and `motir agent-terminal signin` prints `{"profile","state"}` from the same sign-in check the panel sees. `motir agent-terminal run --help` exiting 0 is how Motir tells an image that carries the launcher from one that does not.

## 0.9.0

### Minor Changes

- 4b55c18: `motir agent-terminal serve [--port 7681]` is the terminal server a Motir agent's machine runs (MOTIR-6938). It hands Motir's relay a login shell (`bash -l` in `$HOME/workspace`) over a WebSocket at `/v1/terminal`, only for an upgrade carrying a relay token signed with the machine's own key, and refuses anything else before a shell exists. A dropped connection keeps the shell: reconnecting with its session id re-attaches it and replays the last 256 KiB of output, with at most 4 shells per agent. It reports whether the agent's coding CLI is signed in by checking only that its credential file exists, and it logs lifecycle lines with ids only — never a byte of the terminal. The PTY it needs is built into the sandbox image (`/opt/motir-terminal`), so the package still depends on `commander` alone; run anywhere else, `serve` says "The terminal server runs inside a Motir agent image."

## 0.8.0

### Minor Changes

- dfac59c: `motir next --parent` runs the next runnable container (a story, task or bug whose children are all leaves) as a parent run — exactly as `motir run <KEY>` would — and `motir next --bug` takes the next ready bug, running a bug with ready subtasks whole (MOTIR-6837). `motir ready` now prints the leaves grouped under their containers, `motir ready --parent` lists the containers and `motir ready --bug` the bugs. `--parent` refuses `--print`, `--kinds` and `--bug`; an empty lane says so and exits 0.
- dfac59c: The CLI reads the ready LANES (MOTIR-6835) instead of the flat ready set: `motir next` takes the next leaf and never picks a bug, `motir auto` drains every leaf before it takes the first bug, `motir batch` and a scoped run (`motir run <story>`) read leaves and bugs together so a story's edged bug is still claimed, and `motir ready` shows each row's runnable container. Needs a server serving `/api/v1` contract 1.54.0 or later; an older one is reported as version skew.

## 0.7.0

### Minor Changes

- 50b4d92: A hosted run indexes every checkout it clones with codegraph before the agent starts, and the hosted image now runs the CLI itself (MOTIR-6560). The container's entrypoint is a launcher for `motir run` (or `motir continue`) on the run the server opened, so a leaf, a leaf that spans several repositories and a parent all run hosted exactly as they do locally. The image carries `motir`, `gh`, git ≥ 2.36, the pinned OpenCode and codegraph, and no credential. The hosted `gh` shim now resolves a checkout's repository from its configured remote URL, not one rewritten by `url.insteadOf`.
- 50b4d92: A hosted run launches its own agent and reaches GitHub only as Motir's App (MOTIR-6559). With `MOTIR_DISPATCH_RUN_ID` set and no `--agent`, `motir run` launches OpenCode on `MOTIR_MODEL` through the gateway (`MOTIR_GATEWAY_URL`, `MOTIR_RUN_KEY`), configured exactly as the gateway's egress contract says and on an allow-listed environment that never holds the run credential. git and `gh` get the run's repository tokens from its git-credential route through a credential helper and a `gh` shim — never from an environment variable — and every commit is authored as the App's bot of its repository. Every pull request a hosted run opens names the person who dispatched it, the card and the run. A hosted run always reports its agent's output, so the stall watchdog sees a long step working.
- 50b4d92: A run now CHECKPOINTS its work (MOTIR-6539). While the agent works, the CLI
  pushes the card's work branch in every repository of the leg whenever it holds
  commits origin does not have yet — every 60 seconds, and once more when the
  agent ends however it ends — so a run that dies (hosted or local, a leaf or a
  parent's child) leaves its commits on origin for `motir continue`. It never
  commits on the agent's behalf, never pushes a branch with nothing new on it, and
  never touches the session branch. A failed checkpoint push is one `log` event on
  the run and is retried; it never fails the run. `checkout_ready` now names every
  repository's branch (`data.branches`), and the scope drain emits it too.
- 50b4d92: `motir run` gains a HOSTED mode (MOTIR-6558). Given `--run-id <id>` or
  `MOTIR_DISPATCH_RUN_ID`, it ADOPTS a run Motir already opened instead of opening
  one — a leaf, a multi-repository leaf, or a parent whose members the server
  claimed — and reads that run's cards and order back rather than claiming a
  second set. It needs no `.motir.json` (the project comes from the run, the
  checkouts go under `MOTIR_WORKSPACE`, default `/workspace`, cloned as
  `<root>/<name>`), never prompts, and keeps a scope going past a failed card. The
  env ladder gains the hosted names one rung below their general twins:
  `MOTIR_RUN_TOKEN` below `MOTIR_TOKEN`, `MOTIR_API_URL` below `MOTIR_SERVER`. A
  run without a run id is unchanged.

## 0.6.0

### Minor Changes

- 1b7744c: `motir run <key> --allow-soft-block` runs a work item held only by an
  ancestor's block (a SOFT block) and still refuses one with its own open blocker
  (a HARD block, which only `--force` passes). On a leaf it dispatches the
  soft-blocked item with one line naming the ancestor it overrode. On a story it
  refuses a story whose own blocker is open, and otherwise builds the scope from
  the ready read with `allowSoftBlock=true`, so the children held only by the
  story's ancestor chain are claimed and worked. Without the flag, the not-ready
  refusal's hint now names `--allow-soft-block` for a soft block and `--force` for
  a hard one. `--allow-soft-block` together with `--force` is refused as
  redundant; `motir next`, `motir auto` and `motir batch` do not take the flag
  (MOTIR-6355).

## 0.5.1

### Patch Changes

- 8bbdf81: The CLI no longer rejects a response because the server added a field it does
  not know. Every command reading a response shape that had grown a field since
  the CLI was built failed with "Unexpected response … must NOT have additional
  properties". Since `difficulty` shipped, that included `motir link` and
  everything else that reads the ready set. Missing fields and wrong types are
  still reported.

## 0.5.0

### Minor Changes

- 1491e94: Dispatch runs are recorded and watchable. Every dispatch command — `motir next`,
  `motir run <KEY>`, `motir run <scope>`, `motir batch` and `motir auto` — now opens
  a run: the set it owned, what happened to each work item, and why it stopped,
  watchable at `/runs/<id>`. Reporting is best-effort and can never break a run.

  A run that finds its work item wrong can log a bug and submit a re-plan, with the
  run's own policy electing which lanes are open. The dispatch prompt composes the
  WHAT and submits it through the plan-session tools, and a `manual` work item can
  be planned as a to-do list.

## 0.4.0

**`motir link` now brings the code down.** Linking a folder to a project used to
record the link and stop; it now clones that project's repositories into the
folder, so an agent has something to work in before it is dispatched. If you
manage checkouts yourself, `motir link --no-clone` keeps the old behaviour.

**A run can cover a whole story or sprint.** Where a run took one work item, it
can now take a story or a sprint and drain every leaf under it — claimed
atomically, so two runs cannot pick up overlapping halves of the same set, and
delivered as one pull request and one CI run rather than one per card.

**A work item that ships in more than one repository now runs as one job.** The
agent gets a worktree per repository and opens a pull request in each, and the
card does not complete until every one of them has merged.

**You decide, per run, what a run may do to the plan.** A run that finds its card
wrong can log a bug and propose a re-plan — and five new flags say whether it
may: `--no-log-bug` / `--disable-log-bug`, `--no-replan` / `--disable-replan`,
and `--auto-approve-replan` for an unattended `motir auto` that you trust to
apply its own correction.

**`--print-prompt` echoes each assembled prompt to stderr as it is sent**, so a
live run can be audited without reconstructing what the agent was told.

### What you may have to do

- **A pull request now belongs to a card only by an EXPLICIT link.** Writing
  `MOTIR-123` in a pull-request title used to be enough to move that card when
  the pull request merged; that parse is retired. The CLI links the pull requests
  it opens, so an ordinary `motir run` is unaffected — but **if you have scripts
  or habits that rely on the title alone, the card will no longer move.**
- **A card reaches In Review only when its CI is green.** A merged pull request
  with a red pipeline leaves the card at the new `implemented` status instead of
  advancing it. Nothing you pass changes this; it is worth knowing before you
  wonder why a card stopped one step short.
- **If you mint tokens by hand, approving a plan is now its own permission**
  (`ai:decide_plan`, split out of `ai:view_plan`), and archiving a work item
  needs two keys rather than one. Existing tokens keep the authority they had.

### Also in this release

- The sandbox image installs `claude` from the `stable` dist-tag, after a
  published version shipped no x64 platform package.
- The release lane writes its own digest table instead of asking a person to
  retype it.

**Nothing was removed.** Twenty-three commands before this release, twenty-three
after; seven flags added and none taken away. If you script against `motir`,
every invocation you have written still runs.

---

## 0.3.0

**A refused command now names a PERMISSION, not a scope.** Motir retired the six
coarse token scopes (`read`, `work_items:write`, `work_items:archive`,
`work_items:delete`, `sprints:write`, `integration`) in favour of the permission
catalog the rest of the product already enforces — the same `resource:action`
names you see on **Settings → Project → Roles & permissions**. So a 403 that used
to read

    This token lacks the 'read' scope required for getMe.

now reads

    This token is not granted the 'project:browse' permission required for getMe.

and the hint sends you to a switch that actually exists on the create-token
screen.

**What you may have to do.** Nothing, if your token still works — every token
minted before this change keeps exactly the authority it had; Motir expands the
old values when it reads them, and no token was reissued or rewritten. Two
narrowings are worth knowing about if you mint a NEW token:

- **AI planning is its own permission** (`ai:plan`). It used to travel with
  _edit work items_, which meant a token wired to file issues could also submit
  planning jobs that spend your credits. Tick it only if you want that.
- **Archiving now needs the same permission as deleting** (`work_item:delete`),
  because that is the gate the server has always applied to both. A token minted
  with the default grant can no longer archive; tick the permission if you need
  it.

`motir login` is unchanged and still mints its own narrow grant.

---

## 0.2.0

**The CLI now speaks Motir's public REST API.** Every command is an ordinary
HTTPS request to `/api/v1` with your personal access token as its bearer — the
same documented endpoints, the same credential and the same scopes any
third-party integration gets. Until this release it spoke the Model Context
Protocol at `/api/mcp`.

**Your commands, flags and output are unchanged.** That is the point of the
release rather than a footnote: the suite that drives the built binary end to
end asserts the same expected output it did before the migration, byte for byte,
and not one of those expectations was edited. If you script against `motir`,
nothing you have written needs to change.

### What you will actually notice

- **`@modelcontextprotocol/sdk` is gone.** Installing `@motir/cli` no longer
  pulls an agent-protocol SDK into your `node_modules`. Motir still serves MCP at
  `/api/mcp` — for agents — and the CLI is simply no longer one of its clients.
- **A missing scope now says which scope.** A refusal arrives as an HTTP 403 and
  the CLI names the scope the operation needed, instead of a generic tool error:
  `This token lacks the 'read' scope required for getProjectReadySet.` Scopes are
  fixed when a token is minted, so the fix is a new token, not a retry.
- **A rate-limited call tells you when to try again**, from the server's own
  reset header rather than a guess.
- **A server older than this CLI says so, once, clearly.** This is the only
  genuinely new thing to learn, and it exists because the CLI ships to npm on its
  own schedule while your Motir upgrades on yours:

  ```
  Error: This CLI needs Motir API >= 1.6.0; https://motir.example.com serves 1.4.0.
  Hint: Upgrade your Motir server, or install a CLI built for it.
  ```

  The numbers are the **API contract's** version — not an app release, not this
  CLI's `--version`. Two remedies, and only two: upgrade the server, or
  `npm install -g @motir/cli@<older>`. A server at or AHEAD of this CLI is never
  reported as skew, and a probe that cannot reach the spec leaves the original
  error standing rather than inventing a diagnosis.
  [Full section](../../docs/cli.md#when-your-server-is-older).

### For anyone integrating

The API this CLI uses is documented at
[`/docs/api`](https://app.motir.co/docs/api), with the machine-readable spec at
[`/api/openapi/v1.json`](https://app.motir.co/api/openapi/v1.json) — the same
document this package's types are generated from. Nothing the CLI does is
privileged; if you would rather script it yourself, you can.

---

## 0.1.1

Bumped so the published **sandbox images** would stop shipping a `motir` that
predated `motir login`: the image tagged `:claude` carried a binary from eleven
commits earlier and greeted new users with a credential banner naming a tier the
docs no longer described. No change to the CLI itself beyond the version string.

Also added the drift tripwire that makes the next such gap loud — a check that
compares the newest `cli-v*` tag against the repository and fails once unreleased
work has sat past its window.

---

## 0.1.0

First public release: the `motir` command set — `login` / `auth`, `link`,
`doctor`, the read commands (`ready` / `status` / `sprints` / `sprint` / `show`
/ `open`), single dispatch (`next` / `run` / `done`), the loop (`auto` /
`batch`), and `plan`. Published to npm with provenance, alongside the BYOK
sandbox images that carry the same binary by construction.

---

Notable changes to the `motir` command-line tool, newest first. Written for
someone who INSTALLS it: what changed for you, and what you might have to do
about it.

The version here is the CLI's own. It is not the Motir server's release number
and not the API contract version — see
[§ When your server is older](../../docs/cli.md#when-your-server-is-older) for
that distinction, which the 0.4.0 release makes visible for the first time.

Historical entries are hand-written prose. From the next release, the release
lane generates each entry with Changesets, appending a `### Major Changes` /
`### Minor Changes` / `### Patch Changes` bullet list under the same
`## <version>` heading, newest first, directly under this file's title. The two
shapes coexist under one heading level — prose for the record so far, generated
bullets from here on.
