# ADR: How a browser reaches a shell in your agent — a relay app, an inbound hop to the machine, and a terminal server inside the image

- **Status:** Proposed (2026-09-29), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-6936 · **Story:** MOTIR-6861 (_Open an instance beside the page and work in its
  terminal_) · **Epic:** MOTIR-6859
- **Consumed by** (every sibling in the story reads it):
  - MOTIR-6937: the panel design (Q3's refusals, Q5's reconnect, Q7's three sign-in states, Q8's
    image-too-old state)
  - MOTIR-6938: the terminal server in `packages/cli` (Q3's relay token, Q4, Q5, Q7, Q8's sinks)
  - MOTIR-6939: the machine's process, port and address (Q2's service and IP, Q3's key, Q8's
    image detection)
  - MOTIR-6940: the relay (Q1, Q2, Q3, Q6, Q8)
  - MOTIR-6941: the panel (Q3's ticket, Q4's frames, Q5, Q6's heartbeat)
  - MOTIR-6942, MOTIR-6943: the story test gate and the E2E, through the above
- **Builds on, and changes nothing in:** `agent-instances.md` (the machine, the volume, the org app,
  the idle window, the 12-hour backstop, §9's profile rule), `application-hosting.md` Q1 (motir-core
  on Fly).
- **Evidence refs:** rung-2 paths are read at `origin/main` **`2464b8dc9`** (the MOTIR-6860 merge).
  Rung-1 pages were read on **2026-09-29**.

---

## Context

`agent-instances.md` left one question open and named this card as its owner: _"The terminal
transport — how a browser reaches a shell in the instance. That is MOTIR-6861's decision, as is the
relay that later bumps `lastActivityAt`."_ What is already true:

1. **An agent is one Fly Machine plus a volume at `/home/node`**, in its organisation's own app
   `motir-inst-<hash>`, on that app's own private network, in the fleet Fly organisation
   (`agent-instances.md` §1, §7). motir-core runs in a different Fly organisation, `moooon`
   (`fly.toml`).
2. **The machine runs no process of Motir's.** `createMachine` sets no `init`, no `services` and no
   IP (`packages/orchestrator/src/adapters/fly/persistent.ts`), so the machine keeps the image's
   `ENTRYPOINT ["motir-sandbox-entrypoint"]` + `CMD ["bash", "-l"]`
   (`packages/cli/sandbox/Dockerfile`). Its env carries only `MOTIR_INSTANCE_ID`
   (`lib/services/agentInstanceLifecycleService.ts`, `create`).
3. **The adapter can already run a command on a running machine** — `exec`, `POST
…/machines/{id}/exec`, which the lifecycle uses to clone repositories (`persistent.ts`,
   `exec`; `cloneRepositories` in the lifecycle service).
4. **`touchActivity(instanceId)` is the one activity door.** It bumps `lastActivityAt` and re-arms
   the debounced `agent-instance/idle-check` timer (30-minute window, `agent-instances.md` AMENDMENT
   1).
5. **motir-core serves HTTP from a Next standalone server** (`fly.toml` `[processes] app = "node
server.js"`, `http_service.processes = ["app"]` on port 443), beside a `worker` group with no port.
   No WebSocket code ships in motir-core.
6. **The `motir` CLI's only runtime dependency is `commander`** (`packages/cli/package.json`), and it
   is published to npm and installed on developers' laptops as well as in the image.
7. **The image records its profile** as `ENV MOTIR_SANDBOX_AGENT=${AGENT}`, and the entrypoint sources
   `$HOME/.motir-sandbox/agent-config/env.sh` before `exec "$@"`, so a process it starts has
   `CLAUDE_CONFIG_DIR` / `CODEX_HOME` as the agent sees them (`entrypoint.sh`, `agent-config.sh`).
8. **Where each coding agent keeps its sign-in** is pinned in `packages/cli/src/agentProfiles.ts`
   `credentialPaths`: a file for `claude`, `codex` and `opencode`; none for `kimi`, `aider`, `goose`.

Rung-1 facts:

- Fly: `fly-force-instance-id` _"Forces routing to a specific Machine. The Fly Proxy will attempt to
  reach the Machine multiple times if the Machine is unhealthy. No fallback if Machine is ultimately
  unavailable."_ And _"an application returning `fly-replay` headers should not negotiate a web
  socket upgrade itself."_ (Fly, _Dynamic Request Routing_,
  https://docs.fly.io/networking/dynamic-request-routing/, read 2026-09-29.)
- Fly: a public service is `internal_port` + `ports` + `handlers`; an app receives public traffic on
  its allocated IPs, and several `services` map several internal ports to several **external
  ports** — an app routes by port, not by path (Fly, _Public Network Services_,
  https://docs.fly.io/networking/services/, and _App configuration_,
  https://docs.fly.io/reference/configuration/, both read 2026-09-29).
- Next.js: _"When using standalone output mode, it does not trace custom server files. This mode
  outputs a separate minimal `server.js` file, instead. These cannot be used together."_ (Next.js,
  _How to set up a custom server_, https://nextjs.org/docs/app/guides/custom-server, v16.3.7, read
  2026-09-29.)
- Coder's web terminal is _"Browser ↔ WebSocket ↔ Coder Server ↔ Workspace Agent ↔ Shell Process"_;
  _"Your shell session continues running even when the browser is closed"_ because the agent holds
  the PTY; each terminal has a UUID reconnection token, and the agent buffers output while
  disconnected. The page does not state a buffer size or a session lifetime (Coder, _Web Terminal_,
  https://coder.com/docs/user-guides/workspace-access/web-terminal, read 2026-09-29).
- `node-pty` compiles on Linux: its README's Linux dependencies are `make python build-essential`
  (https://github.com/microsoft/node-pty, read 2026-09-29), and 1.1.0 ships prebuilt binaries for
  macOS and Windows only.

## Decision

### Q1 · Where the relay runs — its own Fly app, `motir-relay`, from motir-core's image, on 443

**The relay is a separate Fly app, `motir-relay`, in the `moooon` organisation.** It is deployed from
**the same image** as motir-core, like the `worker` group. The build stages one more bundle,
`/app/relay/relay.mjs`, and the app's own config `fly.relay.toml` runs `node relay/relay.mjs`.

- **Address:** `wss://relay.motir.co`, external port **443** (`handlers = ["tls", "http"]`),
  internal port **8080**. It has its own certificate on its own app.
- **Deploy:** the same deploy job runs a second `flyctl deploy --app motir-relay --image <the same
ref>`, with no `release_command`, because the web deploy already migrated.
- **Secrets:** `DATABASE_URL`, `MOTIR_TERMINAL_MASTER_KEY` (Q3), `MOTIR_BASE_URL` (the Origin check),
  and `SENTRY_DSN`. **It holds no Fly token.** It never starts, stops or execs a machine.
- **Machines:** at least one running (`min_machines_running = 1`), `shared-cpu-1x`, 512 MB. Its
  services concurrency is `type = "connections"`.
- **It is stateless.** The shell and its replay buffer live on the agent (Q5). A relay restart or
  deploy drops only the transport, and the panel reconnects to the same shell.

**Rejected:**

- **A custom server in the web process** (wrapping Next's handler to take `upgrade`). Next says
  custom servers and standalone output _"cannot be used together"_ (above), and motir-core ships
  standalone output (`Dockerfile`). It would also change how every page is served to host one feature.
- **A `relay` process group in motir-core's own app.** An app routes by port, and 443 already
  belongs to `http_service` (`processes = ["app"]`). The relay would have to answer on a port like
  8443, which many corporate proxies block for WebSockets.
- **A Next route handler.** It cannot upgrade a WebSocket (the card's premise; nothing in motir-core
  does today).

### Q2 · Which way the connection is made — INBOUND: the relay dials the agent's machine

**Browser → relay → the org app's public service → the one machine.** The relay opens a WebSocket
to `wss://<instance.flyApp>.fly.dev/v1/terminal` with header **`fly-force-instance-id:
<instance.machineId>`**. Only the relay makes that call; a browser WebSocket cannot set the header.

The machine gets a **public service** (MOTIR-6939):

- `internal_port = 7681`, one external port 443, `handlers = ["tls", "http"]`;
- **`autostart = false` and `autostop = "off"`.** Fly's proxy must never wake a hibernated agent
  (that would bypass Motir's wake, its credit check and its charge), and must never stop one (Motir
  hibernates);
- the org app gets public IPs when it is ensured: a shared IPv4 and an IPv6. The exact Fly endpoint
  is MOTIR-6939's to verify.

**What inbound costs, and why it is accepted:**

- **A public address per organisation app.** It answers nothing without the relay's per-instance
  token (Q3): an unauthenticated upgrade is refused before a PTY exists. Teammates' agents share the
  org app's private network (`agent-instances.md` §7), so they can reach port 7681 directly too, and
  the same token is required there.
- **The hop crosses the public internet**, TLS-terminated at Fly's edge. Only terminal bytes and a
  60-second token travel on it.

**Rejected — OUTBOUND (the agent dials the relay, Coder's shape):**

- Every running agent would hold a socket open to the relay, so the relay becomes stateful.
- With two relay machines, the browser and its agent can land on different ones, so pairing needs a
  replay or a broker between them.
- The agent needs a credential that authenticates it TO Motir, on a machine its user controls.
  That credential would grant a Motir-side capability, not only its own shell.

Inbound keeps the relay stateless and every Motir credential on Motir's side.

**Also rejected:**

- **A per-agent address the browser connects to directly.** The browser cannot pick the machine
  (no custom headers), and the agent would face the internet with the user's session as its only
  guard.
- **Fly's private network (6PN/WireGuard) from motir-core.** The relay is in `moooon` and the agents
  are in the fleet organisation. Crossing organisations needs explicit configuration, and a relay
  inside the fleet organisation would share networks the org apps were separated to avoid.

### Q3 · How each hop authenticates the previous one

**Browser → Motir web: the session.**
`POST /api/projects/[key]/instances/[id]/terminal-ticket` sits beside the existing instance routes.

- It checks the session, `instance:use`, and **ownership**: the owner only, whatever the viewer's
  role, as `agent-instances.md` §8 says.
- It checks the instance is `running`.
- It returns `{ url, ticket, expiresAt }`.

It refuses in words:

- `not_owner` (403, a server refusal and not a hidden button);
- `not_running` (409 — the panel wakes the agent first, Q6);
- `no_terminal_server` (Q8).

**The ticket:**

- **32 random bytes**, stored only as its SHA-256 in `agent_terminal_ticket`, with `userId`,
  `instanceId` and an optional `sessionId` (Q5).
- **It lives 60 seconds.**
- **It is single-use:** it is consumed by a guarded update (`consumed_at IS NULL AND expires_at >
now()`), so two relays cannot both redeem it.
- **A reconnect mints a new ticket.** A revoked permission therefore takes effect at the next
  connection.

**Browser → relay: the ticket, in the first frame, never in the URL.**

- The browser opens `wss://relay.motir.co/v1/terminal`. It must send `{"t":"auth","ticket":"…"}`
  within 5 seconds, or the relay closes the socket. Keeping the ticket out of the URL keeps it out
  of every access log.
- The relay checks that `Origin` equals `MOTIR_BASE_URL`.
- It redeems the ticket.
- It re-reads the instance: still that user's, not deleted, still `running`.

Refusals are WebSocket close codes the panel maps to words:

| code | meaning                                        |
| ---- | ---------------------------------------------- |
| 4401 | the ticket is invalid, expired or already used |
| 4403 | the user does not own this agent               |
| 4409 | the agent is not running                       |
| 4410 | the agent's image has no terminal server       |
| 4502 | the machine did not answer                     |

**Relay → terminal server: a per-instance key the machine holds, and a one-shot token.**

- **The machine's key** is `instanceKey = HMAC-SHA256(MOTIR_TERMINAL_MASTER_KEY, instanceId)`. It is
  set as machine env `MOTIR_TERMINAL_KEY` (MOTIR-6939). The master key lives only on the relay and
  the web app.
- **The token.** For each connection the relay sends `Authorization: Motir-Relay <token>` on the
  upgrade. The token is `base64url(payload).base64url(HMAC-SHA256(instanceKey, payload))`, with
  `payload = { instanceId, machineId, exp: now + 60 s, nonce: 16 random bytes, sessionId? }`.
- **The server's checks:**
  - the signature against its own key;
  - `instanceId` equals its `MOTIR_INSTANCE_ID`;
  - `machineId` equals the machine id — `MOTIR_MACHINE_ID`, else `FLY_MACHINE_ID` (AMENDMENT 2);
  - `exp` is not past;
  - the nonce is unseen, from an in-memory set kept until its `exp`.
- **What a stolen key grants: that one machine's shell, and nothing else.** The owner already has
  that shell. The key is readable by the machine's own user (same uid as the server). It is still
  removed from the shell's environment, so an agent printing `env` does not leak it into a
  transcript.
- **Rotation:** rotating the master key invalidates every derived key. The next wake re-applies the
  machine config with the new one (Q8's config version).

**Rejected:**

- **A long-lived shared secret on every machine** — one leak would open every agent.
- **A Motir PAT on the machine** — it grants Motir API scope, not a shell.
- **The session cookie over the WebSocket.** The relay is on its own host, and a cookie widened to
  `.motir.co` would travel to every subdomain.

### Q4 · The in-image terminal server — `motir agent-terminal serve`, on `node-pty` compiled in the image

- **Command:** `motir agent-terminal serve [--port 7681]`, a subcommand of `packages/cli`, listening
  on `0.0.0.0:7681`.
- **Main process** (MOTIR-6939): the machine's `init.cmd` becomes

  ```
  sh -c 'motir agent-terminal --help >/dev/null 2>&1 && exec motir agent-terminal serve; exec sleep infinity'
  ```

  under the unchanged image entrypoint. The entrypoint seeds the home and sources the agent's config
  env first (Context 7).
  - A current image runs the server.
  - An image whose `motir` has no such command idles instead of crash-looping (Q8).

- **PTY: `node-pty`, compiled in a build stage of the sandbox image and NOT a dependency of
  `@motir/cli`.**
  - The stage has build tools and builds a **pinned exact version** into `/opt/motir-terminal`. The
    final stage copies that directory.
  - `serve` loads it from there with `createRequire`.
  - Run anywhere else (a laptop), `serve` refuses in words: _"The terminal server runs inside a
    Motir agent image."_
  - So the npm package keeps `commander` as its only dependency, and no laptop install ever
    compiles native code.
- **Rejected PTYs:**
  - `node-pty` as a dependency or optional dependency: Linux compiles it at install (above).
  - `script` / `socat`: neither can resize a PTY it does not control, and `socat` is not in the
    image.
  - A Python `pty` helper: `python3` is in the image, but that is a second language and a second
    framing protocol between two processes, for what `node-pty` does in-process.
- **The shell:**
  - `bash -l` as `node` (the machine already runs as `node`), in `$HOME/workspace`;
  - `TERM=xterm-256color`, `COLORTERM=truecolor`;
  - the environment is the server's own **minus `MOTIR_TERMINAL_KEY`** (Q3).
  - The server adds nothing that changes a coding agent's sign-in (Q9's requirement 2).
- **Wire protocol** — one WebSocket per terminal, at `/v1/terminal`. The relay forwards every frame
  in both directions unchanged, except the browser's `auth` frame, which it consumes.
  - **Binary frames:** terminal bytes, both ways.
  - **Text frames:** JSON control, as below.

    | direction       | frame                                   | meaning                                                                |
    | --------------- | --------------------------------------- | ---------------------------------------------------------------------- |
    | browser → relay | `{"t":"auth","ticket"}`                 | first frame; consumed by the relay (Q3)                                |
    | client → server | `{"t":"open","cols","rows","session"?}` | attach: a new session, or resume `session` (Q5)                        |
    | client → server | `{"t":"resize","cols","rows"}`          | resize the PTY                                                         |
    | client → server | `{"t":"ping","active"}`                 | heartbeat every 20 s; `active` = the page is visible (Q6)              |
    | server → client | `{"t":"ready","session","resumed"}`     | attached; on a resume, the replay follows as binary before live output |
    | server → client | `{"t":"signin","profile","state"}`      | the sign-in state, on attach and on every change (Q7)                  |
    | server → client | `{"t":"exit","code","signal"}`          | the shell exited; the session is gone                                  |
    | server → client | `{"t":"pong"}` · `{"t":"error","code"}` | `code`: `session_limit`, `unknown_session`, `taken_over`               |

- **Room for the chat story.** The chat story (MOTIR-6863) adds its stream as another path on the
  same server and port (`/v1/chat`), behind the same relay token. The terminal protocol does not
  change for it.

### Q5 · Reconnect to the same shell — a session token, a 256 KiB replay ring, at most 4 sessions

- **Session:** the server mints a random UUID v4 on a new `open` and returns it in `ready`. It is
  the reconnect token. The panel keeps it in `sessionStorage`, per tab, so a reload or a dropped
  connection reattaches that tab's shell. It rides through the ticket (`sessionId`) and the relay
  token, and the server attaches only to a session it holds.
- **A detached PTY lives until the machine stops.** It is not killed on detach: Coder's _"your shell
  session continues running even when the browser is closed"_. The bound is the idle window. With no
  terminal attached, the agent hibernates 30 minutes after the last activity, and hibernation ends
  every process (`agent-instances.md` §2).
- **The replay buffer:** a **256 KiB ring of output per session**, in the server's memory, on the
  user's own machine. On a resume it is sent before live output, so the screen can be redrawn.
  **Nothing on Motir's side buffers anything.**
- **At most 4 live sessions per agent.** A fifth `open` reaps the longest-detached session. If all
  four are attached, the server refuses with `session_limit`.
- **One connection per session.** A second attach to an attached session takes it over, and the
  first connection receives `taken_over`. Two tabs can each have their own shell; one shell cannot
  be driven from two places at once.

**Rejected:**

- **Killing the PTY on disconnect.** It breaks the story's acceptance criterion.
- **A replay buffer in the relay or in Motir storage.** It would store the stream Motir must not
  store (Q8, Q9).

### Q6 · What counts as activity — an open terminal on a visible page, bumped at most once a minute

**The relay calls `touchActivity(instanceId)`:**

- when a connection opens;
- when it closes, so the idle window starts from the close;
- on **any binary frame, in either direction**, so a build scrolling in the terminal keeps the
  agent awake;
- on a `ping` with `active: true`.

**At most once per 60 seconds per instance per relay machine**, from an in-memory throttle. Each bump
re-arms the debounced timer, so a tighter bump would only enqueue jobs.

- **An open, silent terminal on a visible page keeps the agent awake**, because the panel pings
  every 20 seconds with `active: true` — the story's _"an open, active terminal keeps the instance
  awake"_.
- **A hidden tab stops counting.** Its pings carry `active: false`, so an agent left open in a
  background tab hibernates at the end of the idle window unless its output is still moving.
- The 20-second ping also keeps both hops of the WebSocket inside any proxy idle timeout. Fly's
  timeout is not stated on the pages read. The relay also sends WebSocket protocol pings to both
  sides.
- **The 12-hour backstop still applies** (`agent-instances.md` §2), whatever the terminal is doing.

**Opening a hibernated agent** is the panel's two calls: the existing Wake route, then the ticket
once the instance reads `running`. It needs no second click (MOTIR-6941). The relay never wakes
anything: it holds no Fly token, and a ticket route refusing `not_running` keeps waking in one place.

**Rejected:**

- **Bumping on every frame.** It queues a job per keystroke for no change in outcome.
- **Counting any open socket.** A forgotten background tab would hold a billed machine for 12 hours.
- **An activity reporter inside the image.** `agent-instances.md` §2 already rejects trusting a
  signal from a machine the user controls.

### Q7 · The sign-in check — the server stats one file, never opens it, and pushes the state

- **Profile:** `MOTIR_SANDBOX_AGENT` (Context 7).
- **Paths:** `credentialPaths` from `agentProfiles.ts`, resolved in the server's own environment,
  which the entrypoint gave `CLAUDE_CONFIG_DIR` / `CODEX_HOME`:

  | profile                    | the file checked                                                                                          | states                               |
  | -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------ |
  | `claude`                   | `$CLAUDE_CONFIG_DIR/.credentials.json` (the image sets it to `$HOME/.motir-sandbox/agent-config/.claude`) | signed in · not signed in            |
  | `codex`                    | `$CODEX_HOME/auth.json` (`$HOME/.motir-sandbox/agent-config/.codex`)                                      | signed in · not signed in            |
  | `opencode`                 | `$XDG_DATA_HOME/opencode/auth.json` (default `$HOME/.local/share/opencode/auth.json`)                     | signed in · not signed in            |
  | `kimi` · `aider` · `goose` | none (`credentialPaths: () => []`)                                                                        | **can't tell for this coding agent** |

- **The check:**
  - `fs.stat` of each path, never `open` or `read`;
  - **signed in** when any path is a regular file of non-zero size;
  - **not signed in** otherwise;
  - **`unknown`** when the profile has no path.
  - The answer is `{ profile, state }` only: no path, no size, no time.
- **Cadence:** the server checks on every attach, then **every 5 seconds while at least one session
  is attached**, and pushes a `signin` frame only when the state changes. **The relay never asks**;
  it forwards the frame. So the header turns to _signed in_ within seconds of the vendor's flow
  finishing, with no reload.
- **Before the terminal connects** (waking, connecting), the panel shows no sign-in state rather
  than a guess.
- **Rejected:**
  - Reading the file to validate it — §9 condition 4 forbids reading the credential.
  - A Fly `exec` from the relay — the relay holds no Fly token, and `exec` would be a second channel
    to the machine.
  - Checking only the config directory — a directory is never proof of a sign-in (MOTIR-4957,
    `agentProfiles.ts`).

### Q8 · What is never logged, and what an image without the server gets

**No terminal byte reaches any of these sinks.** Each sink, and how it stays clean:

| sink                                                             | how it is kept clean                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the relay's own logs (stdout → Fly)                              | it logs lifecycle lines with ids only: connection opened and closed, close code, duration. It never logs a frame, a ticket or a token, and never builds an `Error` message from one                  |
| Sentry, in the relay                                             | the same `serverSentryInitOptions()` (`sendDefaultPii: false`), plus a `beforeBreadcrumb` that drops `console` breadcrumbs in the relay process. Frame payloads are never attached to an event       |
| Sentry, in the browser                                           | session replay stays off (`instrumentation-client.ts`: `replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0`). The panel never passes terminal content to a breadcrumb, an event or analytics |
| the web app's logs and Sentry                                    | the ticket route logs no ticket value; it stores only the hash                                                                                                                                       |
| the terminal server's stdout (Fly log shipping from the machine) | it logs ids and lifecycle only. The PTY's input and output are the socket's, never the process's stdout or stderr                                                                                    |
| the database                                                     | no stream. **One row per connection** in `agent_terminal_connection`: instance, user, `openedAt`, `closedAt`, close reason (the duration is derived). Nothing else about a terminal is persisted     |
| the job log                                                      | `touchActivity` and `agent-instance/idle-check` carry ids only (`lib/jobs/types.ts`)                                                                                                                 |
| URLs and access logs                                             | the ticket travels in the first frame, not the query string (Q3)                                                                                                                                     |

The 256 KiB replay ring (Q5) lives in the memory of the user's own machine. It is not Motir storage,
and it dies with the process.

**An image without the server.**

- **Detection.** After each boot, the lifecycle runs `exec` of `motir agent-terminal --help` on the
  machine and records on the instance whether the server is present (MOTIR-6939). The `exec` door
  already exists (Context 3). It is re-probed only when the digest changes.
- **Machine config.**
  - The machine config carries a version in its metadata (`motir_machine_config`).
  - A wake of an agent whose config is older updates it before starting: the Q2 service, the Q3 key,
    the Q4 command.
  - Because the Q4 command idles when the subcommand is missing, a new config on an old image boots
    and stays up.
- **What the panel shows.** The ticket route refuses `no_terminal_server`, and the panel shows the
  image-too-old state. Its words are MOTIR-6937's: the agent was made before the terminal existed,
  and moving it to the newer image is coming. This record builds no image move; that is MOTIR-6862's.

### Q9 · The four Anthropic conditions, as requirements on the build cards

From `agent-instances.md` §9, quoting _Claude Code — Legal and compliance_
(https://code.claude.com/docs/en/legal-and-compliance):

1. **_"The Claude Code binary must not be modified."_** The terminal starts the vendor's binary as
   the image installed it. Nothing wraps, shims or aliases `claude` (MOTIR-6938, MOTIR-6939).
2. **The platform _"may not remove, disable, or restrict any authentication method built into
   it."_** No wrapper, environment variable or config file set by the server, the machine config or
   the relay narrows any coding agent's sign-in. Examples: no `ANTHROPIC_API_KEY`, and no setting
   that forces or hides a login method (MOTIR-6938, MOTIR-6939).
3. **The sign-in _"must complete through Anthropic's own flow."_** The user runs `claude` and
   `/login` in this terminal, and opens the printed URL in their own browser. Motir pre-fills
   nothing (MOTIR-6941, MOTIR-6943 with a stubbed vendor CLI).
4. **The platform _"may not collect, store, or intermediate Claude.ai credentials."_**
   - The stream that carries a pasted sign-in code is stored nowhere (Q8).
   - The sign-in check reads only whether the credential file exists (Q7).
   - The credential lives only on the user's volume.
   - The relay moves bytes it never inspects: it parses only the small JSON control frames, never
     binary terminal data.

The same four apply to every offered profile (`agent-instances.md` §9's rule).

## Consequences

- **A new Fly app to run** (`motir-relay`), with its own certificate, secrets and a second deploy
  step. That is the price of 443 and of keeping the Next standalone server untouched.
- **Every organisation app gains public IPs and a public service.** It is reachable only with a
  valid relay token, and never wakes a machine.
- **The sandbox image gains a native-build stage** for `node-pty`. The published `@motir/cli` gains
  no dependency.
- **A relay deploy or crash drops connections but never a shell.** The panel reconnects with its
  session token and replays up to 256 KiB.
- **Two new tables:** `agent_terminal_ticket` (hash, 60-second life, swept) and
  `agent_terminal_connection` (open and close only).
- **A new secret,** `MOTIR_TERMINAL_MASTER_KEY`, on the web app and the relay.

**Which card acts on each question** (every answer above has an owner):

| question | card(s)                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| Q1       | MOTIR-6940 (the relay and its app config)                                                            |
| Q2       | MOTIR-6939 (service, IPs) · MOTIR-6940 (the dial)                                                    |
| Q3       | MOTIR-6940 (ticket route, redeem, token) · MOTIR-6938 (verify) · MOTIR-6939 (the key on the machine) |
| Q4       | MOTIR-6938 (server, PTY, frames) · MOTIR-6939 (the main process) · MOTIR-6941 (the client side)      |
| Q5       | MOTIR-6938 · MOTIR-6941                                                                              |
| Q6       | MOTIR-6940 · MOTIR-6941                                                                              |
| Q7       | MOTIR-6938 (the check) · MOTIR-6937 and MOTIR-6941 (the three states)                                |
| Q8       | MOTIR-6940 · MOTIR-6938 · MOTIR-6939 · MOTIR-6942 (the no-byte-in-a-log guard)                       |
| Q9       | MOTIR-6938 · MOTIR-6939 · MOTIR-6941 · MOTIR-6943                                                    |

## Owed on acceptance

- **A `manual` card beside MOTIR-6940, which MOTIR-6940 is `blocked_by`:** create the `motir-relay`
  app in `moooon`, point `relay.motir.co` at it with its certificate, and set its secrets
  (`DATABASE_URL`, `MOTIR_TERMINAL_MASTER_KEY`, `MOTIR_BASE_URL`, `SENTRY_DSN`), plus
  `MOTIR_TERMINAL_MASTER_KEY` on motir-core. No card in this story owns that today; it is proposed
  once this record is accepted, as `agent-instances.md`'s own _Owed on acceptance_ did.
- **The CLI release that carries the server** is MOTIR-6945, already planned.

## What this does NOT decide

- **The chat story's adapters** (MOTIR-6863). This record only reserves `/v1/chat` on the same
  server behind the same token.
- **Moving an agent to a newer image** (MOTIR-6862). This record detects an image without the server
  and shows it; it moves nothing.
- **Any price.** Terminal time is machine time, already charged per interval
  (`agent-instances.md` §5, AMENDMENT 2).
- **The idle window's length or the 12-hour backstop.** Both stay `agent-instances.md` §2's.
- **The panel's layout and copy**, which are MOTIR-6937's design. This record names only the states
  it must draw.
- **Git credentials inside the terminal.** They are the developer's own (`gh auth login`), and a
  run's credential is MOTIR-6864's.
- **Letting anyone but the owner into an agent** — sharing, pairing or support access. This record
  keeps `agent-instances.md` §8's owner-only rule and adds no exception.
- **Recording terminal sessions** for audit or playback. That is refused by Q8 and Q9, and nothing
  here builds it.

## AMENDMENT 1 — with the terminal OFF, the machine idles (MOTIR-7336, 2026-10-02)

The record said that without `MOTIR_TERMINAL_MASTER_KEY` machines _"boot as before the terminal"_,
assuming such a machine stays up. It did not: with no main-process override the machine ran the
sandbox image's own `CMD ["bash", "-l"]`, which exits 0 at once with no TTY, and Fly's `on-failure`
policy does not restart a clean exit. Production had no key, so every agent created there stopped two
seconds after it started (machine `80e9030c0e67e8`: `start` 12:57:08 → `exit`, `exit_code=0` 12:57:10).

**The choice: give the machine a main process that stays up, not refuse create and wake.** Q4 already
idles an image with no server (`exec sleep infinity`) so that a machine _"boots and stays up"_; a
deployment with no terminal gets the same idle. `PersistentContainerSpec.idleCommand` carries it
(`AGENT_IDLE_COMMAND = ['sleep', 'infinity']`, `lib/agentInstances/terminal.ts`), under the image's
unchanged `ENTRYPOINT`, with no service. When the terminal is on, its command is the main process and
`idleCommand` is ignored. Refusing would have made the terminal key a precondition for agents at all,
which the record never said.

**Not covered:** an agent CREATED terminal-off before this change keeps a machine config with no main
process, because a wake rewrites the config only to install the terminal (Q8). Its wake now ENDS
`failed` in words (`agent-instances.md` AMENDMENT 5) instead of hanging; setting the master key and
waking brings it up on Q8's terminal config, or the owner deletes it.

## AMENDMENT 2 — the machine id has a host-neutral name, and an AWS VM sets it (MOTIR-10817, 2026-11-09)

The record took the machine id from `FLY_MACHINE_ID`, which the Fly platform sets on every machine.
EC2 sets no such variable, so on an AWS agent VM (`agent-instances` on AWS, MOTIR-9361) the server
refused to start, the container's main process exited, and the boot's first clone found the
container stopped (EC2 `i-00df27f5ec6ca138a`, 2026-11-09 19:35:02 UTC).

**The choice.** The server reads the machine id as `MOTIR_MACHINE_ID` first and `FLY_MACHINE_ID`
second, and refuses in words naming both when neither is set; a Fly machine, which sets only the
second, behaves exactly as before. The AWS boot script reads the instance id from the metadata
service on EVERY boot — a create and a wake alike — and writes it into the container's env under
both names (`@motir/orchestrator` `MACHINE_ID_ENV_KEYS`), after the document's own env so nothing
else can stand in for it. It is the value the relay mints tokens with, because an AWS instance row's
`machine_id` is the instance id RunInstances returned, so a token for that instance passes the
`machineId` check above. `FLY_MACHINE_ID` is written too because an instance keeps booting the image
digest it was created on, and an image published before this change reads only that name.
