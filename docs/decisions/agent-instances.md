# ADR: A user agent instance — a persistent machine that hibernates, wakes and is charged per running interval

- **Status:** Proposed (2026-09-28), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-6866 · **Story:** MOTIR-6860 (_Create, list, hibernate, wake and delete your agent
  instances_) · **Epic:** MOTIR-6859
- **Consumed by** (every sibling in the story reads it):
  - MOTIR-6867 — provision the instance lane's Fly configuration (§7)
  - MOTIR-6868 — the Instances page design (§4 states, §9 profile picker, §5 and §6 refusals)
  - MOTIR-6869 — the orchestrator port and Fly adapter (§1, §2, §3, §7)
  - MOTIR-6870 — the instance record, its intervals and the permission key (§4, §8)
  - MOTIR-6871 — motir-ai: the interval debit (§5)
  - MOTIR-6872 — the lifecycle service and its API (§1, §2, §4, §5, §6, §8)
  - MOTIR-6873 — the idle sweep, the interval settle and the charge (§2, §5, §6)
  - MOTIR-6874, MOTIR-6875, MOTIR-6876, MOTIR-6877 — the page, the two test gates and the E2E, through the above
- **Builds on, and changes nothing in:** `hosted-agent-machine-charge.md` (the rate and the rounding),
  `ci-runner-fleet.md` §7.5 (the separate fleet Fly organisation), `fleet-image-pull.md` §0 (public
  images pull anonymously), `run-death-keeps-work.md` §1 (the 12-hour backstop).

---

## Context

Everything Motir runs on its fleet today is a single-use container. The Fly adapter creates every
machine with `auto_destroy: true` and `restart: { policy: 'no' }`
(`packages/orchestrator/src/adapters/fly/flyMachines.ts`, `createMachine`), and the port knows four
operations: `provision · teardown · describe · reap` (`packages/orchestrator/src/types.ts`).

A user agent instance is different on every axis that matters:

- It belongs to one developer and one project, and outlives any process in it.
- Its home directory must survive, because the agent's sign-in lives there.
- It must stop costing machine time when nobody is using it, and start again on request.
- The developer runs arbitrary commands in it, as themselves, with their own vendor credential.

Five facts from the shipped code and the provider shape the answers below:

1. **The fleet reaper destroys every tagged machine in the fleet app older than its cutoff**
   (`adapters/fly/index.ts`, `reap`: _"THE WHOLE FLEET, NOT JUST THE RUNNERS"_). A long-lived
   machine in that app is reaped by design.
2. **`isTerminalState` counts `stopped` and `suspended` as terminal** (`flyMachines.ts`,
   `TERMINAL_STATES`). For a single-use container that is right; for an instance, `stopped` is a
   normal resting state.
3. **Whole-machine usage spans the machine's life.** `startedAtOf` takes the FIRST `start` event and
   `stoppedAtOf` the LATEST `stop`/`exit`/`destroy` (`flyMachines.ts`). Billed through `usageFor`, a
   machine woken three times would be charged for every hour it was asleep in between.
4. **Fly suspends only small machines.** _"A machine can use suspend if it has: ≤ 2 GB memory"_, no
   swap and no schedule, and resume _"is not guaranteed"_ (Fly, _Machine Suspend and Resume_,
   https://docs.fly.io/reference/suspend-resume/, read 2026-09-28). The one priced agent machine is
   8 GB (`FLEET_CONTAINER_SIZE` in `packages/orchestrator/src/rates.ts`: `performance`, 2 CPUs,
   8192 MB).
5. **Machines in one Fly app share a private network.** _"Customer Machines can communicate freely
   within their app (or between apps in their network)"_, and _"Apps on separate 6PNs can never
   communicate unless explicitly configured to do so"_ (Fly, _Custom private networks_,
   https://docs.fly.io/networking/custom-private-networks/, read 2026-09-28).

## Decision

### §1 · Persistence — a Fly Machine with one Fly volume mounted at the sandbox user's home

**Each instance is one Fly Machine plus one Fly volume, and the volume is mounted at `/home/node`**,
the sandbox image's `HOME` (`packages/cli/sandbox/Dockerfile`: `ENV HOME=/home/node`, `USER node`).

- **The machine** is created with `auto_destroy: false` and `restart: { policy: 'on-failure' }`. A
  crashed main process is restarted by Fly. An explicit stop through the API is not a failure, so it
  stays stopped.
- **The image is pinned by DIGEST.** At create, the profile's tag
  (`ghcr.io/motir-co/motir-sandbox:<profile>`) is resolved to its digest and the machine boots
  `…@sha256:<digest>`. The instance record keeps the digest (§4). The image is public, so Fly pulls it
  anonymously (`fleet-image-pull.md` §0).
- **Only the home survives.** Fly: _"The root file systems of a Fly Machine are ephemeral"_ (Fly,
  _Volumes overview_, https://docs.fly.io/volumes/overview/, read 2026-09-28). Everything outside
  `/home/node` is reset to the image on every wake. So the project's repositories are cloned into
  **`$HOME/workspace/<repository name>`**, not into the image's `/workspace`, which is on the rootfs.
- **The empty volume must be SEEDED from the image's own home.** The image writes into `/home/node`
  at build time: the agent config home `$HOME/.motir-sandbox/agent-config` that `entrypoint.sh`
  sources, and the `.bashrc` hook for `/etc/profile.d/motir-sandbox-agent-config.sh`. An empty volume
  mounted over `/home/node` hides all of it. **The image therefore keeps a copy of its build-time
  home outside `$HOME`, and the entrypoint copies it into an empty or older home without overwriting
  anything already there** (`cp -a --no-clobber` semantics). No sibling card owns that image change
  today; see _Owed on acceptance_.
- **The main process** is the image entrypoint followed by a long-lived idle process. The terminal
  story (MOTIR-6861) replaces it with its relay; nothing in this story listens on a port.

**The port gains, beside the unchanged ephemeral operations:**

| operation                    | what it does                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisionPersistent(spec)`  | ensure the organisation's instance app (§7), create a volume in the region, then create the machine mounting it; returns a **persistent handle** `{ app, machineId, volumeId, region, createdAt }` |
| `stop(handle)`               | `POST …/machines/{id}/stop`; idempotent on an already-stopped machine                                                                                                                              |
| `start(handle)`              | `POST …/machines/{id}/start`; always a cold boot of the rootfs, with the volume intact                                                                                                             |
| `describePersistent(handle)` | the machine's state in the instance vocabulary below, plus the `start`/`stop` event instants of the CURRENT run                                                                                    |
| `destroyPersistent(handle)`  | destroy the machine, then the volume; idempotent, and it never destroys the volume while the machine still exists                                                                                  |
| `listPersistent(orgApp)`     | every machine and volume in one organisation's instance app; the reconcile's read (§5)                                                                                                             |

`describePersistent` maps Fly's states: `created`/`starting` → `starting`, `started` → `running`,
`stopping` → `stopping`, `stopped` → `stopped` (**not terminal**), `destroying`/`destroyed` or a 404 →
`gone`, `failed` → `failed`. It does not reuse `isTerminalState`.

**Rejected:**

- **`suspend` as hibernate, with `stop` as the fallback.** Fly suspends only machines of ≤ 2 GB
  (Context fact 4), and the priced agent machine is 8 GB, so every suspend would be refused and the
  fallback would always run. The port does not get an operation that can never succeed on the one size
  it boots. If a ≤ 2 GB priced size ever exists, suspend is added then.
- **The ephemeral path plus a snapshot of the home to object storage.** Slow to wake, and it copies the
  user's credential file through Motir's storage, which the vendor terms in §9 forbid for Claude Code.
- **A VM product outside Fly.** A second provider and a second meter for one workload.

### §2 · Hibernate and wake — `stop` and `start`, on a server-side idle signal

- **Hibernate is `stop`.** The machine stops, the volume stays, and no CPU or RAM accrues. Fly:
  _"Suspended machines cost the same as stopped machines: storage only. There are no CPU/RAM
  charges."_ (suspend-resume page, above).
- **Wake is `start`.** Every wake is a cold boot of the rootfs with the home intact. The UI's `waking`
  state lasts for the boot.
- **The idle signal is server-side.** An instance is idle when, for the whole idle window, it has had:
  - no open terminal or chat connection through Motir's relay,
  - no active run,
  - and no create or wake.

  The instance record keeps `lastActivityAt` (§4). In THIS story nothing but create and wake bumps it,
  because the relay and the runs are later stories'; each of them bumps it on its own activity. Nothing
  inside the image reports anything.

- **The idle window is 30 minutes**, GitHub Codespaces' default idle timeout (GitHub Docs, _Setting
  your timeout period for GitHub Codespaces_). **Rejected:** a shorter window (every return costs a
  cold boot) and an in-instance activity reporter (it would trust a signal from a machine the user
  controls).
- **The sweep** runs every 5 minutes. It hibernates every `running` instance that is idle, that has
  reached the 12-hour interval backstop, or whose organisation the credit pre-flight now refuses (§5).
- **The 12-hour backstop.** No running interval lasts longer than 12 hours, the same backstop as a
  hosted run (`run-death-keeps-work.md` §1). At the backstop the sweep hibernates the instance, even if
  a connection is open; the user wakes it again. This is what bounds a relay that stopped reporting
  activity, and it sizes the fleet slot's TTL (§6).

### §3 · Sizes

- **Machine: `FLEET_CONTAINER_SIZE`** (`performance`, 2 CPUs, 8 GB), the one priced agent class
  (`hosted-agent-machine-charge.md` §2, `rates.ts` `CONTAINER_RATES`). It runs the sandbox image's
  agent plus the Postgres and browser the image ships (MOTIR-6204). **Rejected:** a ≤ 2 GB shared
  machine. It would allow suspend, but it cannot run the image's toolchain, and it is unpriced, so the
  boot's unpriced-size refusal (MOTIR-4713) would stop it.
- **Volume: 10 GB, fixed, no auto-extend.** Fly volumes extend but never shrink, and max out at 500 GB
  (volumes overview). **Rejected:** auto-extend, because volume storage is not charged (_What this does
  NOT decide_) and auto-extend would make an uncharged cost unbounded.
- **A full volume** surfaces as a failed write (`ENOSPC`) inside the instance. It is not a Motir state.
- **Region:** `FLY_INSTANCES_REGION`, default `iad`, the fleet's region (`flyFleetConfig`). The volume
  and the machine are always created in the same region.

### §4 · The instance record and its state machine

**`AgentInstance`:**

- owner user, organisation, workspace, project;
- name, unique per (owner, project, name);
- sandbox profile id, image tag, **image digest**;
- Fly app, machine id, volume id, region (the persistent handle);
- `state`, `failureReason`, `stateChangedAt`, `lastActivityAt`, `createdAt`, and `deletedAt`.

A deleted instance keeps its row with `deletedAt` set, so its intervals keep their parent for billing
history. Every list excludes it, and the page row disappears.

**`AgentInstanceInterval`**, one row per running stretch:

- instance, organisation, `startedAt`, `endedAt`, `endReason`;
- `billableSeconds`, `credits`, the charge reference and the charge outcome.

`endReason` is one of `hibernated · idle · backstop · credits · deleted · lost`.

**States:** `starting · running · hibernating · hibernated · waking · failed · deleting`.

| from                                 | to                | by                                                                                                |
| ------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| (new)                                | `starting`        | create                                                                                            |
| `starting`                           | `running`         | the machine reports `running`; an interval opens                                                  |
| `starting`                           | `failed`          | the boot fails or times out                                                                       |
| `running`                            | `hibernating`     | Hibernate, the idle sweep, the backstop, or a credit refusal                                      |
| `hibernating`                        | `hibernated`      | the machine reports `stopped`; the interval closes                                                |
| `hibernated`                         | `waking`          | Wake (or a later story's door into the instance)                                                  |
| `waking`                             | `running`         | the machine reports `running`; a new interval opens                                               |
| `waking`                             | `failed`          | the start fails, for example the volume's host has no capacity                                    |
| `running`                            | `hibernated`      | the reconcile finds the machine already `stopped`; the interval closes at Fly's stop instant      |
| `running` · `hibernating` · `waking` | `failed`          | the reconcile finds the machine or volume `gone`; any open interval closes with `endReason: lost` |
| `failed`                             | `waking`          | Wake, when the machine and volume still exist                                                     |
| `running` · `hibernated` · `failed`  | `deleting`        | Delete                                                                                            |
| `starting` · `waking`                | `deleting`        | Delete — AMENDMENT 4                                                                              |
| `hibernating`                        | `deleting`        | Delete — AMENDMENT 4                                                                              |
| `deleting`                           | (row `deletedAt`) | the machine and volume are destroyed; any open interval closes with `endReason: deleted`          |

Every other pair is illegal. **Every transition is a guarded compare-and-set**: one conditional
update that applies only when the row is in the expected prior state, so two clicks, or a click racing
the sweep, cannot both win. The Fly call happens after the guard commits, outside the transaction
(`motir-core/CLAUDE.md`, side effects outside the transaction).

**A stop that never reached its machine is sent again (MOTIR-7406).** `running → hibernating` records
the reason the stop was begun for (`hibernate_reason`), and the interval closes with it however the
stop settles: inline, or on a later sweep. When the sweep finds a `hibernating` agent whose machine
still reports `running`, Fly refused or lost the stop, so the sweep sends it again, once per pass, and
reads the machine again. `stop` is idempotent, so a stop that did land costs nothing.

### §5 · The charge — one debit per running interval

- **An interval** runs from the machine's `start` event to its `stop` or `destroy` event, read from
  Fly's event log for THAT run. Where Fly has no event, Motir's own observed instant is the fallback.
  `billableSeconds = ⌈endedAt − startedAt⌉`.
- **It is never measured with `usageFor` / `ContainerUsage`.** Those span the machine's whole life
  (Context fact 3) and would bill the hibernated hours.
- **The price is `hosted-agent-machine-charge.md`'s, unchanged:** 1 credit per minute, whole credits,
  **rounded up once per interval**: `credits = ⌈billableSeconds ÷ 60⌉`. An interval with 0 seconds is
  not debited. No allowance. Never refused for balance at settle (that ADR, Decision 8).
- **The debit goes through motir-ai's `POST /v1/credits/agent-machine` under the `agent_machine`
  kind**, and the route learns a second reference:
  - The body carries **exactly one** of `coreRunId` (a hosted run, as today) or **`instanceIntervalId`**.
  - **Idempotency:** the ledger's `externalRef` is `agent-instance-interval:<interval id>`, so a retried
    settle charges nothing more. The prefix keeps it disjoint from a dispatch run id.
  - **An interval charge writes NO `AgentRunUsage` row.** That table is a run's cost
    (`debitAgentMachine`, motir-ai `src/services/creditService.ts`), and an instance is not a run.
  - An unknown organisation stays `not_found`, with nothing created, as today.
- **Every exit settles:** hibernate, delete, the backstop, a credit refusal, and a machine found lost.
  **An interval that ends because the machine was destroyed outside Motir is still charged**, from
  Fly's last event or, failing that, from the instant the reconcile first saw it gone.
- **The reconcile** replaces the fleet reaper for instances, because the fleet reaper never lists an
  instance app (§7). It runs inside the same 5-minute sweep and does two things:
  - A **record** whose machine is `gone` or `stopped` is moved as the table in §4 says, closing and
    charging its interval.
  - A **machine or volume** in an instance app that no live record owns is destroyed, and logged.
- **The credit pre-flight gates create and wake.** Both call motir-ai's
  `POST /v1/credits/agent-run-check` (MOTIR-6447) before any Fly call, and `mayRun: false` refuses
  with the reason in words. That route answers `mayRun: false` for an organisation motir-ai has never
  seen, so every instance that boots belongs to an organisation the debit knows. The sweep asks the
  same question of each running instance's organisation and hibernates on `false` (`endReason:
credits`). An instance's agent is signed in on the user's own credential, so no gateway 429 would
  otherwise stop it.
- **The meter stays COGS.** Each interval also writes one `ci_container_usage` row, keyed by the
  interval, so Motir's machine cost is measured exactly as the hosted agent's is. The charge is a
  separate reader of the same seconds (`hosted-agent-machine-charge.md`, Consequences).

### §6 · The fleet ceiling

- **A new workload kind, `agent_instance`**, slot-backed like `hosted_agent`
  (`lib/ciFleet/workloads.ts`). The `Record<FleetWorkloadKind, …>` totality guards give it a metadata
  tag, a name prefix and a counter in one compile.
- **A slot is held for exactly as long as an interval is open.** It is taken at create or wake, before
  the Fly call, and released when the interval closes, whatever closes it. `ref` is the instance id and
  `ownerRef` the interval id (MOTIR-2160), so a stale release cannot free a newer interval's slot.
  `expiresAt` is the interval's start + 12 h + 15 minutes, the backstop plus one sweep's margin. A
  `hibernated` instance holds no slot.
- **It counts under `MOTIR_FLEET_MAX_IN_FLIGHT`**, the one invoice ceiling (`lib/ciFleet/limits.ts`).
- **Two caps of its own, because that ceiling is shared with CI:**
  - `MOTIR_INSTANCE_MAX_RUNNING`, default **8**: running instances fleet-wide, so instances can never
    take more than a third of the default 24 slots from CI.
  - `MOTIR_INSTANCE_MAX_RUNNING_PER_ORG`, default **3**: one organisation cannot take all 8.
  - A refused create or wake names which ceiling refused it.
- **A cap on EXISTING instances:** at most **10 per user**, so the uncharged volumes stay bounded.

### §7 · Which Fly app — one app per Motir organisation, each on its own private network

- **Instances boot in the fleet's Fly ORGANISATION, never in the fleet APP.** The fleet organisation
  is already separate from `motir-ai` and `motir-gateway` (`ci-runner-fleet.md` §7.5).
- **Each Motir organisation gets its own instance app, created lazily** on its first instance by
  `provisionPersistent`: `POST /v1/apps` with a `network` field (custom private networks page, above).
  - App name: `<FLY_INSTANCES_APP_PREFIX>-<hash of the organisation id>`.
  - Network: the same string.
  - The app id is stored on each instance (§4).
- **What that isolates:**
  - A user's shell shares no private network with CI runners, the OpenCode hosted agent, or another
    customer's instances.
  - Instances of ONE organisation share a network. They belong to the same team, and they hold the
    same project's repositories.
- **Configuration**, read only by the instance lane (never `FLY_FLEET_*`):
  - `FLY_INSTANCES_API_TOKEN`: a token for the fleet Fly organisation that may create apps, machines
    and volumes;
  - `FLY_INSTANCES_REGION`, default `iad`;
  - `FLY_INSTANCES_APP_PREFIX`, default `motir-inst`.
- **Rejected:**
  - **The fleet app.** The fleet reaper destroys every tagged machine in it (Context fact 1), and it
    would put a user's shell on the CI runners' network.
  - **One shared instances app.** Every customer's instance could reach every other's over the app's
    private network (Context fact 5): a dev server one user binds to `0.0.0.0` is open to every other
    tenant.
  - **One app per instance.** It multiplies apps without isolating anything more than the
    organisation boundary does.

### §8 · The permission — `instance:use`

- **A new catalog key, `instance:use`** (`lib/permissions/catalog.ts`), project-scoped.
- **Granted by default** to the built-in `member` role and every role above it; **not** to `viewer`.
- It gates the create control and every instance route.
- **It never grants another user's instance.** Every read and every operation is also owner-scoped:
  no key, including a manager's, opens, wakes, hibernates or deletes someone else's instance.
- **Rejected:** reusing `ai:plan` or `work_item:edit`. Neither says _may run a billed machine on this
  project_, and a workspace could not grant one without the other.

### §9 · Which sandbox profiles are offered

**The rule for every offered profile:**

- the binary is unmodified, and no authentication method it ships is removed or disabled;
- the sign-in runs through the vendor's own flow, in the user's own terminal inside the instance;
- Motir never pre-fills, stores, proxies or reads the credential;
- Motir never pays for, resells or intermediates the vendor's usage.

A profile is offered only where the vendor's terms allow that. It is not offered where they forbid it,
where they could not be read, or where they do not address it and the question stays open. **All eight
profiles were read on 2026-09-28.**

| profile       | vendor · terms                                                                                                                                                            | clause                                                                                                                                                                                                                                                                                                                                                                                                                                    | verdict                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `claude`      | Anthropic · _Claude Code — Legal and compliance_, https://code.claude.com/docs/en/legal-and-compliance                                                                    | Hosting is expressly allowed: _"preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below"_; and it does not prevent _"an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code"_. | **offered**                                                                                                       |
| `codex`       | OpenAI · Codex CLI licence (Apache-2.0), https://github.com/openai/codex/blob/main/LICENSE; _Terms of Use_, https://openai.com/policies/row-terms-of-use/                 | _"You may not share your account credentials or make your account available to anyone else."_ Each user signs in to their own account on their own instance, so nothing is shared. The Terms of Use page refused an automated fetch (HTTP 403), so this quote was taken from a search snippet, not a page read.                                                                                                                           | **offered** — a person reads the full Terms of Use before launch (_Owed on acceptance_)                           |
| `opencode`    | SST · MIT licence, https://github.com/sst/opencode/blob/dev/LICENSE                                                                                                       | The licence places no condition on hosting. The model provider's terms govern the credential the user brings.                                                                                                                                                                                                                                                                                                                             | **offered**                                                                                                       |
| `kimi`        | Moonshot · kimi-cli licence (Apache-2.0), https://github.com/MoonshotAI/kimi-cli/blob/main/LICENSE; _Kimi Code benefits_, https://www.kimi.com/en/help/kimi-code/benefits | _"keep the tool's genuine identity; tampering with the client identifier (User-Agent) will be treated as a violation"_; a membership benefit _"is for personal development only"_. Both are conditions on the user and the binary, which the rule above already meets.                                                                                                                                                                    | **offered**                                                                                                       |
| `antigravity` | Google · _Google Antigravity Additional Terms of Service_, https://antigravity.google/terms/                                                                              | _"Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."_ A Motir-hosted machine is a third-party service used to access it.                                                                                                                                                                                                                   | **not offered** — forbidden                                                                                       |
| `cursor`      | Anysphere · _Terms of Service_, https://cursor.com/terms-of-service                                                                                                       | _"you may not: … (iii) rent, lease, lend, or sell the Service"_. The terms do not address a platform hosting the CLI on the user's own account either way.                                                                                                                                                                                                                                                                                | **not offered** — the terms are silent, and silence is not permission; offered when Cursor confirms it in writing |
| `aider`       | Aider-AI · Apache-2.0, https://github.com/Aider-AI/aider/blob/main/LICENSE.txt                                                                                            | The licence places no condition on hosting. The model provider's terms govern the credential.                                                                                                                                                                                                                                                                                                                                             | **offered**                                                                                                       |
| `goose`       | Block · Apache-2.0, https://github.com/block/goose/blob/main/LICENSE                                                                                                      | The licence places no condition on hosting. The model provider's terms govern the credential.                                                                                                                                                                                                                                                                                                                                             | **offered**                                                                                                       |

**The four Anthropic conditions are REQUIREMENTS on the build cards**, quoted from the same page:

1. _"The Claude Code binary must not be modified"_ — the image installs the vendor's binary as published.
2. The platform _"may not remove, disable, or restrict any authentication method built into it"_ —
   no environment variable, config file or wrapper narrows sign-in.
3. The sign-in _"must complete through Anthropic's own flow"_ — the user runs it in the instance's
   terminal (MOTIR-6861).
4. The platform _"may not collect, store, or intermediate Claude.ai credentials"_ — the credential
   lives only on the user's volume, and no Motir process reads it.

Two more follow from the same page: Motir accepts Anthropic's Commercial Terms of Service before the
Claude Code profile ships, and Motir's own branding does not use the Claude Code name or logo.

**For the open-source CLIs** (`opencode`, `aider`, `goose`) the model provider's terms still bind the
credential. Anthropic does not permit a third-party application to offer Claude.ai subscription login
(same page), so in those CLIs a Claude model is used with the user's Anthropic API key. The create
dialog says so beside those profiles.

## Consequences

- **The existing ephemeral path is untouched.** CI, indexing and the hosted agent keep
  `provision · teardown · describe · reap` and `auto_destroy: true`.
- **The fleet reaper never sees an instance**, because it lists only `FLY_FLEET_APP`. The instance
  reconcile (§5) is its equivalent for instance apps.
- **Every wake is a cold boot.** Anything the user installed outside `$HOME` is gone after a wake;
  the home, the repositories under `$HOME/workspace` and the agent's sign-in are not.
- **A volume lives on one physical host.** Fly: _"If the NVMe drive hosting your volume fails, that
  instance of your app goes down"_ (volumes overview). A wake that finds no capacity on that host
  fails, and the instance reads `failed` with the reason. Fly's daily volume snapshots (5 days'
  retention by default) are the only copy; restoring from one is not built here.
- **Instance machine time is charged; volume storage is not.** Storage is Motir's cost, bounded by
  §3's fixed size and §6's per-user cap.

**Consumer criteria this record makes false**, each to be amended on its card once this record merges:

- **MOTIR-6867:**
  - No app is created by hand; apps are created per organisation by the adapter (§7).
  - Its criteria become: the fleet-organisation token that may create apps, and the three
    `FLY_INSTANCES_*` values of §7, set on motir-core and read back.
  - `fly apps list -o <fleet org>` succeeds with the token.
- **MOTIR-6869:**
  - **Suspend is dropped.** The criteria _"suspend … falls back to stop"_ and _"start reports warm vs
    cold"_ become _"stop"_ and _"start is a cold boot"_ (§1, §2).
  - `provisionPersistent` also ensures the organisation's app with its network (§7).
  - _"The reaper spares a persistent machine…"_ becomes the reconcile's list operation
    (`listPersistent`), because the fleet reaper never lists an instance app.
- **MOTIR-6870:** the record also carries the Fly app and the region (§4), and `deletedAt`, because a
  deleted instance keeps its intervals.

## Owed on acceptance

- **The sandbox image carries a copy of its build-time home, and the entrypoint seeds an empty or
  older home from it without overwriting** (§1). No card in this story owns it, and the persistence
  criterion of MOTIR-6860 cannot pass without it. It is proposed as a sibling that MOTIR-6872 is
  `blocked_by`.
- **A person reads OpenAI's full Terms of Use** for the Codex profile, which the automated read could
  not fetch (§9).
- **Anthropic's Commercial Terms of Service are accepted** before the Claude Code profile ships (§9).

## What this does NOT decide

- **The terminal transport** — how a browser reaches a shell in the instance. That is MOTIR-6861's
  decision, as is the relay that later bumps `lastActivityAt`.
- **The chat adapters** — MOTIR-6863's.
- **The price.** 1 credit per machine minute stays `hosted-agent-machine-charge.md`'s. This record adds
  no rate.
- **Charging volume storage.** Not charged here. If it ever is, that is its own decision.
- **Moving an instance to a newer image** — MOTIR-6862's. An instance stays on the digest it was created
  from.
- **Restoring a home from a Fly snapshot** after a host failure.
- **Running a card in an instance** — MOTIR-6864's.
- **Offering Cursor.** Cursor stays off until Cursor confirms it in writing; this record does not
  decide that confirmation.

## AMENDMENT 1 — the sweep's cadence (MOTIR-6873, 2026-09-28)

**§2's "every 5 minutes" could not be built as written.** The job substrate refuses a cron off the
clustered minutes `0` and `30` (`SCHEDULE_CLUSTER_MINUTES`, pinned by
`tests/jobs/schedule-cluster.test.ts`): the database suspends when idle, every scheduled tick is a
guaranteed wake, and a finer cadence is a decision for `application-hosting.md` §21, not a minute to
pick. So the sweep is split by what each part needs:

- **The idle window rides a per-instance timer**, not the sweep. `agent-instance/idle-check` is a
  debounced job keyed on the instance, armed when it starts running and re-armed on every activity
  bump, with `period: 30m` and `timeout: 12h`. It fires once the instance has been quiet for the
  window, so an idle instance hibernates at 30 minutes rather than at up to 35. It wakes nothing
  while no instance exists.
- **`system.agent-instance-sweep` runs at `0,30 * * * *`** for everything else: settling a
  transition left in motion, the reconcile, the 12-hour backstop, the credit refusal, orphans, the
  charge backstop, and an idle instance whose timer was lost.
- **The fleet slot's TTL grows to 12 h + 45 minutes**, the backstop plus one 30-minute sweep and a
  quarter hour, in place of §6's 12 h + 15 minutes.
- **The orphan cleanup** destroys a volume only once its machine is gone from the inventory it
  read, so an orphan volume is removed one pass after its machine.

The 12-hour backstop is unchanged. Worst case it now lands at 12 h + 30 minutes, since both the
timer's debounce cap and the sweep enforce it.

## AMENDMENT 2 — no organisation cap, an own pool, and a charge that runs while the machine runs (2026-09-29)

Asked by the product owner, after reading §6's numbers: _"3 for a whole org? If I have 100 users in the
org how does the number work? And why do we need the limits?"_ Each limit was re-examined against what
it actually protects. This amendment **replaces §6's two running caps** and **extends §5's charge**.

### 1 · §5 charged too late: the credit pre-flight could not stop a running machine

The pre-flight asks one question, _"is the balance above zero?"_. It holds nothing and reserves nothing
(motir-ai `agent-run-check`: _"No threshold and no hold"_), and machine time was debited only when an
interval **closed**, up to the 12-hour backstop later. The sweep's credit check could not help, because
a running agent's own minutes never lowered the balance it read. An organisation with one credit could
run a machine for twelve hours. A hosted run is protected by the gateway's 429. An instance's model
usage is on the user's own sign-in, so nothing in the middle stopped it.

**Now the machine is charged while it runs.** Each sweep pass first **rolls** every running
instance's open interval:

- it closes the interval `rolled` at its last whole-minute boundary;
- it opens the next interval of the same run there, in one transaction;
- it charges the closed interval like any other: once, under its own `agent-instance-interval:<id>`
  key.

Only after every running instance has been charged does the pass ask each organisation for credits,
and it hibernates (`credits`) where the answer is no.

- **Overdraft** is bounded by the sweep's 30 minutes instead of the backstop's 12 hours.
- **Rounding** stays exact: a rolled interval is whole minutes, so only a run's final interval rounds.
- **motir-ai** is unchanged. It still debits one interval per key.

**A run is now one or more intervals.** Each interval carries `runId`, the id of the run's first
interval, and `runStartedAt`. The **fleet slot is keyed on the run** (`ownerRef = runId`), and the
**12-hour backstop counts from `runStartedAt`**, so rolling changes neither.

### 2 · Instances have their own pool, not a share of CI's

§6 counted instances under `MOTIR_FLEET_MAX_IN_FLIGHT`, the ceiling CI, indexing and hosted runs
share. It then capped them at 8, a third of that ceiling's default 24, so they could not starve CI.
Instances already run in their own per-organisation Fly apps (§7), are paid for by the minute, and
live for hours. They do not belong in CI's ceiling. `agent_instance` is now an **`own`-pool
workload** (`FleetPool` in `lib/ciFleet/workloads.ts`):

- It still takes and releases a slot under the fleet admission lock.
- It is **neither counted in, nor refused by, the shared ceiling**.

### 3 · No organisation cap; the pool's cap is a safety valve, not a product limit

`MOTIR_INSTANCE_MAX_RUNNING_PER_ORG` (default 3) is **removed**. It was a fairness split of the 8
slots. It was never a statement of what an organisation should be allowed, and it made no sense for
a 100-person organisation. With the charge running (1), **credits decide how many agents an
organisation runs**.

`MOTIR_INSTANCE_MAX_RUNNING` stays, as the **agent pool's safety valve**: the most machines Motir will
have running for instances at once, across everyone. Fly has no spending cap of its own, so
something in the product must bound the worst case.

- Its default rises from 8 to **50**, well above ordinary use.
- An operator raises it as usage grows.
- Reaching it reads as _"Motir is busy, try again in a few minutes"_, not as a limit a person owns.

**The per-person cap stays: at most 10 live instances per user.** Every instance, hibernated or not,
keeps a 10 GB volume Motir pays for and does not charge (§3). The cap bounds that cost. It can go if
volume storage is ever charged.

### What a person sees

| Refusal            | Before                                       | After                                                 |
| ------------------ | -------------------------------------------- | ----------------------------------------------------- |
| Organization limit | _"Your organization already has 3 running…"_ | **removed**                                           |
| Your limit         | _"You already have 10 agents…"_              | unchanged                                             |
| Motir is busy      | the fleet-wide 8, or CI's ceiling            | the agent pool's safety valve only                    |
| Not enough credits | at create / wake only                        | at create / wake, **and within a pass while running** |

## AMENDMENT 3 — the running cap is each organisation's own, and Motir's own organisations have no agent limits (MOTIR-6926, 2026-09-30)

Decided by the product owner on 2026-09-29 and recorded in
[MOTIR-6902](motir:cmumft28b009phvoi3as70ybt)'s brief (`agent-instance-storage.md` §3 and §5). Two
changes to AMENDMENT 2 §3; everything else in AMENDMENT 2 stands.

### 1 · `MOTIR_INSTANCE_MAX_RUNNING` is counted per organisation

_"50 is not enough for all motir orgs for sure, motir is multi tenants, we should change
MOTIR_INSTANCE_MAX_RUNNING to per org."_ AMENDMENT 2 kept the variable as ONE count across every
organisation, so one busy organisation could make every other one read _"Motir is busy"_.

- `MOTIR_INSTANCE_MAX_RUNNING` keeps its name and its default of **50**, and now means **running
  agent instances ONE organisation may hold**.
- It is counted under the same fleet admission lock that takes the agent slot, keyed on the slot's
  organisation (`reserveSlot` in `agentInstanceLifecycleService`), so two creates racing for an
  organisation's last slot cannot both take it, and another organisation's create in the same instant
  is not counted against it.
- Reaching it refuses `org_running_cap` (since AMENDMENT 7, `org_cap`, judged on LIVE agents at create only), worded as the My agents delta draws it (MOTIR-6916): _"Your
  organization is running {limit} of its {limit} agents. Hibernate one to start another."_ The number
  travels on the refusal (`limit`), never typed into copy.
- **There is no fleet-wide agent cap any more.** `fleet_busy` (_"Motir is busy"_) answers only the
  operator's kill switch, `MOTIR_FLEET_MAX_IN_FLIGHT=0`, which still stops every boot of every
  workload ([MOTIR-6907](motir:cmumkykha000whwshso5thqxq)), or an admission that could not be
  evaluated.

### 2 · Motir's meta and internal organisations have no agent limits

_"meta org and internal org have no limit."_ An organisation with `Organization.isMeta` OR
`Organization.internalBilling` (`isUnlimitedAgentOrg` in `lib/agentInstances/config.ts`, the one
predicate) skips:

- the per-person cap (`user_cap`, 10 live agents);
- the per-organisation running cap (1);
- the credit pre-flight at create and wake, and the sweep's hibernate on `credits`.

It is **still charged exactly like any organisation**: every machine interval and every daily storage
debit lands on its ledger, and an internal organisation's are offset by motir-ai's `internal_offset`
(`internal-billing-classification.md`), so its usage stays true. Neither flag gains a meaning here;
this reads both and sets neither. The paid-AI-plan answer for the same two is the shared gate's
(`aiPlanGateService`, MOTIR-6909), and their exemption from plan-lapse deletion is MOTIR-6921's.

### What AMENDMENT 2 kept

The charge while the machine runs (§1), the agents' own pool outside CI's shared ceiling (§2), and the
per-person cap for every other organisation are unchanged.

### What a person sees

| Refusal                   | AMENDMENT 2                       | Now                                                    |
| ------------------------- | --------------------------------- | ------------------------------------------------------ |
| Your organization's limit | —                                 | at the organisation's own `MOTIR_INSTANCE_MAX_RUNNING` |
| Motir is busy             | the fleet-wide safety valve       | the operator's kill switch only                        |
| Your limit                | 10 per person                     | 10 per person, except in Motir's own organisations     |
| Out of credits            | at create / wake and in the sweep | the same, except in Motir's own organisations          |

## AMENDMENT 4 — Delete from a boot or a stop that has not settled (MOTIR-7341, 2026-10-02)

§4 let Delete leave only `running`, `hibernated` and `failed`, because it assumed every transitional
state settles on its own within minutes. **It does not always.** A machine that exits during boot
leaves the agent `starting` (or `waking`) with nothing to move it on
([MOTIR-7336](motir:cmuqzyp9u001chzshpjp1shvh)), and a stop that Fly never carries out leaves it
`hibernating` the same way. Found on production on 2026-10-02: the owner's Delete was disabled, the
service refused it, and the sweep's own plan-lapse deletion skipped it. The agent still held its fleet
slot, a place under the owner's agent cap, its machine and its volume, and nobody could remove it
without editing infrastructure by hand.

### 1 · The new edges

| from          | to         | by     |
| ------------- | ---------- | ------ |
| `starting`    | `deleting` | Delete |
| `waking`      | `deleting` | Delete |
| `hibernating` | `deleting` | Delete |

`deleting` then settles exactly as before: the machine is destroyed **whatever state it is in**, then
the volume, the open interval closes `deleted`, its slot is released, and the row takes `deletedAt`.
The sweep's plan-lapse deletion (`beginDelete`) uses the same guard, so it no longer skips an agent
that is mid-boot or mid-stop.

**`updating` keeps no Delete edge.** `agent-image-update.md` Q6 refuses Hibernate and Delete there on
purpose, and an update cannot stall: its settle's own deadlines end it in `running` or `failed`, and
`failed` is deletable.

### 2 · What does not change

- **Never under a running run** (`agent-instance-run.md`): Delete is still refused, in words, while a
  run works in the agent. The person cancels it first.
- **One winner.** The move to `deleting` is the same guarded compare-and-set. A boot, stop or fail
  settle that runs after it — the boot that finishes while the delete runs — loses its own
  compare-and-set and changes nothing: it never moves the agent to `running`, `hibernated` or
  `failed`, and it closes no interval, so the interval's end reason is the delete's.

### 3 · What a person sees

The My agents row menu and the agent panel offer Delete… for a `starting`, `waking` or `hibernating`
agent, with the same confirmation. It stays disabled for `deleting` and `updating`.

## AMENDMENT 5 — every boot ends (MOTIR-7336, 2026-10-02)

§4's table says `starting` and `waking` move to `running` or `failed`, and the settle failed a boot
only on `gone` or `failed`. A machine that EXITED during a boot reads `stopped`, which §1 rightly calls
not terminal — so the boot read as still in motion, the sweep asked again every pass with no deadline,
and the agent sat in `starting` for as long as nobody looked, with no reason and no log line.

`settleBoot` now ends every boot (`lib/services/agentInstanceLifecycleService.ts`):

- **A machine that started during THIS boot and then stopped** — its stop instant is at or after the
  boot's `stateChangedAt` — **is failed with its exit code.** A clean exit (code 0) fails at once:
  `on-failure` never restarts it. Any other exit, or one with no code, fails once it has stayed stopped
  for `INSTANCE_BOOT_EXIT_GRACE_MS` (2 minutes), which leaves room for Fly's restart. A stop from
  BEFORE the boot — the hibernate a wake's `start` has not replaced yet — is not an exit during it.
- **A boot not `running` within `INSTANCE_BOOT_DEADLINE_MS` (10 minutes) of its start is failed**,
  whatever the machine says. The sweep settles every boot each 5-minute pass, so no boot outlives the
  deadline by more than one pass.
- Each such failure is `failInstance`'s: `failed` with a `failureReason` in words, the interval closed
  `lost`, the slot released. It also logs ONE lifecycle line — the instance id, its state, the
  provider's state and the exit code, never a credential.
- `PersistentContainerStatus.exitCode` carries the exit code of the CURRENT run's exit (Fly: the
  latest `exit` event's `exit_code`, only when the current run has stopped).
- A create now stamps `stateChangedAt` from the lifecycle clock, the one the deadline is read against.

## AMENDMENT 6 — a boot is driven by its own job and read out step by step (MOTIR-7394, 2026-10-02)

**Story:** MOTIR-7393 (_Watch your agent boot_). **Builds on** AMENDMENT 5
([MOTIR-7336](motir:cmuqzyp9u001chzshpjp1shvh), PR #3355).

### The problem

A boot today has no owner and no record:

- `create` provisions the machine, then blocks in `waitFor(INSTANCE_INLINE_BOOT_WAIT_MS, settleBoot)`.
  `wake` does the same after `start`. So the dialog stays open while the server waits.
- Whatever the inline wait does not finish waits for `system.agent-instance-sweep`
  (`AGENT_INSTANCE_SWEEP_CRON`, every 5 minutes), whose step 1 calls `settleBoot`.
- The run launcher's `awaitAgent` also calls `settleBoot`.
- **Three parties may therefore clone, probe and settle the same boot at once, with no lock between
  them.** Only the final compare-and-set to `running` is guarded. The clone itself is not.
- Nothing is recorded between `starting` and `running`, so there is nothing for a person to watch, and
  a failed boot leaves only its `failureReason`.

### Options

- **A — keep the sweep and shorten its cron. Rejected.** Every boot still waits up to one sweep
  interval. A short cron runs the whole sweep (idle, charging, reconcile) far too often. Nothing is
  recorded per step, so a read-out has nothing to read.
- **B — finish the boot inline in the create request. Rejected.** The request blocks for the clone (up
  to 10 minutes per exec), so the dialog cannot close at once, and wake has the same problem. A dropped
  connection orphans the boot.
- **C — a per-agent event-triggered boot job that defers itself, steps recorded in their own table,
  and a server-sent stream over them. Chosen.** It costs a new table, a new job id and a new stream
  route. It forecloses nothing: the sweep keeps its other duties and becomes a backstop for boots.

### 1 · The steps

A boot is five steps, in this order:

| step             | covers                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provision`      | create: the volume and machine created (`provisionPersistent`). Wake: the machine config brought up to date and the `start` request accepted              |
| `machine_start`  | the image pulled and the machine started, until `describePersistent` reports `running`. Pull and start are ONE step, because Fly reports no pull progress |
| `clone`          | ONE row per project repository, carrying its `owner/name`, in the order the project lists them                                                            |
| `terminal_check` | the terminal-server and run-capability probes (`probeTerminalServer`, `probeRunCapabilities`)                                                             |
| `ready`          | the move to `running`                                                                                                                                     |

**Each step is in exactly one of five states:** `waiting` · `in_progress` · `done` · `failed` ·
`skipped`.

Each step records `startedAt`, `endedAt` and a `detail`: the failure's words, the machine's exit code,
or the terminal probe's answer.

- **A wake writes its `clone` rows `skipped`.** The home survives a wake (§1), and `settleBoot` clones
  only on a first boot today.
- **`terminal_check` is `skipped`** where the deployment's terminal is off, as the probes are today.
  The probes never fail a boot, so this step ends `done` or `skipped` unless the boot ends while it is
  in progress.
- **The steps after a failed one stay `waiting`.** The read-out ends on the row that failed.
- **A boot that ends by deletion** records the step in progress as `failed` with detail `deleted`
  (section 4).
- **Cloning is one exec per repository**, not one per credential as `cloneRepositories` does today, so
  that each repository's row starts, ends and fails on its own. The credentials are still minted once
  per installation and revoked after that installation's last repository.

### 2 · The boot attempt

Steps belong to a **boot attempt**, numbered per agent from 1. Each create and each wake opens attempt
n+1 with every step written `waiting` (or `skipped`), so a read shows the current attempt and an earlier
attempt's history is never overwritten.

The attempt records:

- `kind`: `create` or `wake`;
- the lease, `leaseHolder` and `leaseExpiresAt` (section 4);
- its `outcome` once closed: `running`, `failed` or `deleted`, with `endedAt`.

**Every step write stamps a `seq`**, monotonic per AGENT (not per attempt). The stream's cursor reads it
(section 7). Per agent is what lets a cursor taken during one attempt resume into the next one without
a gap.

A wake that enters `updating` (a pinned image update, `agent-image-update.md` Q5) opens no boot attempt.
Its progress is that flow's.

### 3 · The driver — `agent-instance/boot`

**A boot is advanced by one event job, `agent-instance/boot`, with payload `{ instanceId, attempt }`.**
It has the shape of `agent-instance-run/launch` (`lib/jobs/definitions/agentInstanceRunLaunch.ts`):
each pass reads the agent and its attempt from the top, does what is possible now, and defers with
`deferRun` when it must wait. The attempt's step rows are its durable state, as `deferRun` requires.

- **While the machine is not started**, a pass reads `describePersistent` and defers
  `AGENT_BOOT_POLL_MS` (2 seconds, named in code). The machine's own launch, start and exit instants,
  where `describePersistent` reports them (MOTIR-7396), stamp the `machine_start` row. Otherwise the
  driver's observed instants do.
- **Once the machine is started**, the driver clones repository by repository, one exec each,
  recording each row as it starts and ends. Then it probes, then transitions the agent to `running` and
  arms the idle timer exactly as `settleBoot` does today.
- **Any failure** transitions the agent to `failed` through the existing `failInstance`, with the
  failing step recorded `failed` and its detail. That covers a machine reporting `gone` or `failed`, a
  clone that fails, and AMENDMENT 5's two rules.
- **The deadline is AMENDMENT 5's**, read, not redefined: `INSTANCE_BOOT_DEADLINE_MS` and
  `INSTANCE_BOOT_EXIT_GRACE_MS`, measured from the same `stateChangedAt`. A boot past the deadline fails
  on the step that is in progress. A machine that exited during the boot fails on `machine_start`, with
  its exit code as the detail.
- **`settleBoot` survives only as the driver's step function.** No other caller remains.

### 4 · One party advances a boot — the lease

**The attempt row carries a lease: `leaseHolder` (the job run that holds it) and `leaseExpiresAt`.**

- **The driver takes the lease with a guarded compare-and-set** that applies only when the lease is
  absent, expired, or already its own, and renews it at every pass and before every step.
- **Only the lease holder may write steps or transition the agent out of `starting` / `waking`.** A
  driver that loses the compare-and-set exits, writing nothing.
- **The lease outlasts the longest step taken without a renewal**, one clone exec (600 seconds). It is
  `AGENT_BOOT_LEASE_MS`, 11 minutes, named in code. A deferred pass keeps its lease, because a defer
  keeps the same job run.

**§2's sweep no longer finishes a boot whose lease is alive.** For a `starting` or `waking` agent, its
step 1 now does one thing: when the current attempt's lease is absent or expired, it sends
`agent-instance/boot` again for that attempt. The event's idempotency key carries the expired
`leaseExpiresAt`, so a resend is never swallowed as a duplicate of the first. A lost send (the event
never enqueued) is recovered the same way. A resent driver **resumes from the last recorded step,
never from the top**: a `done` row is not redone. The `in_progress` row it finds is redone, because its
holder died mid-step. Two drivers sent for one attempt are harmless: only one wins the lease.

**The run launcher's `awaitAgent` no longer calls `settleBoot`.** It reads the agent's state and defers
until the driver has finished: `ready` at `running`, `failed` at `failed`, and its own
`AGENT_RUN_BOOT_WAIT_MS` bound unchanged. A second caller cloning a boot that the driver is cloning
writes into the same `$HOME/workspace`, races the driver's compare-and-set, and holds a 10-minute exec
inside the launch job. The launch job needs only the outcome, and the driver owns the outcome.

**Deletion closes the attempt.** AMENDMENT 4's move to `deleting` (Delete, or the sweep's plan-lapse
`beginDelete`) closes the current attempt in the same transaction: the step in progress becomes `failed`
with detail `deleted`, the outcome becomes `deleted`, and the lease is cleared. A driver pass after it
finds the attempt closed and the agent out of a boot state, and exits writing nothing. This is the
one-winner rule of AMENDMENT 4, applied to the attempt.

### 5 · Create and wake answer before the boot

**§4's create and wake now answer at `starting` / `waking`, without waiting for the boot.**

- **Create** keeps every synchronous refusal (name, profile, plan, cap, credits, running limit) and the
  provisioning call. It opens attempt 1 with `provision` recorded, sends `agent-instance/boot`, and
  answers `201 { instance }` at `starting`.
- **Wake** does the same at `waking`: it opens attempt n+1 with `provision` recorded and its `clone`
  rows `skipped`, sends the event, and answers.
- **The inline `waitFor` and `INSTANCE_INLINE_BOOT_WAIT_MS` are removed** from create and wake.
- **A provisioning error is recorded as `provision` `failed`**, and the agent is `failed` through
  `failInstance` as today. The agent row exists, so it is shown with its read-out, not lost.
- **Opening an attempt is the opener's write**, the one write to the attempt before any lease exists:
  create or wake writes the attempt and its `provision` row, then the driver writes everything after.

### 6 · The read

`GET /api/projects/[key]/instances/[id]/boot` answers the CURRENT attempt:

```
{ attempt, kind: 'create' | 'wake', outcome, seq,
  steps: [{ step, repository, state, startedAt, endedAt, detail, seq }] }
```

`repository` is `owner/name` on a `clone` row and null elsewhere. `seq` at the top is the attempt's
highest. The read is owner-only, with the same gate as the instance read: another member's agent
answers 404.

### 7 · The stream

`GET /api/projects/[key]/instances/[id]/boot/stream?since=<seq>` is a server-sent event stream that
mirrors `app/api/dispatch-runs/[id]/stream/route.ts`, and has the same gate as the read:

- The route polls the read every second (`AGENT_BOOT_STREAM_POLL_MS`) and sends a **`step` frame** for
  each step written since its cursor, the step's row plus its `attempt` and its monotonic `seq`.
- A **`:` heartbeat** comment every 15 seconds (`AGENT_BOOT_STREAM_HEARTBEAT_MS`) keeps the connection
  open.
- Once the attempt is closed, it sends one terminal **`done` frame** `{ state: 'running' | 'failed' |
'deleted' }`, the attempt's outcome, then closes.
- **Reconnecting with `since` resumes without gaps.** Every step write carries a new `seq` and the
  stream sends every row whose `seq` exceeds the cursor, so a reload, a second tab or a dropped
  connection sees the same rows in the same states.

### What a person sees

Pressing **Create** closes the dialog as soon as the server answers, and the new agent's panel reads
out its boot live, row by row, until it is running or has failed on a named step with its reason. A
wake reads out the same way with its clone rows skipped. The panel, its states and its copy are
MOTIR-7395's design and MOTIR-7400's build.

### What this amendment does NOT decide

- **The boot deadline's values.** `INSTANCE_BOOT_DEADLINE_MS` and `INSTANCE_BOOT_EXIT_GRACE_MS` stay
  AMENDMENT 5's.
- **What a boot DOES.** The same clone command, the same probes and the same `running` transition. Only
  who calls them, and what is recorded, changes.
- **The sweep's other duties**: the idle check, the charge, the reconcile, the backstop, the credit
  stop and the plan-lapse deletion (§2, §5, AMENDMENT 1).
- **The `updating` and `hibernating` progress.** An update keeps its own settle
  (`agent-image-update.md`), and a hibernate keeps `settleStop`.
- **The table's name, columns, indexes and RLS**, which are MOTIR-7397's, within sections 1, 2 and 4.
- **The panel's layout, copy and states**, which are MOTIR-7395's design.
- **The run launcher's own wait bound**, `AGENT_RUN_BOOT_WAIT_MS`, which is unchanged.

## AMENDMENT 7 — the organisation's agent figure counts every live agent, and is judged at create only (MOTIR-9954, 2026-10-28)

AMENDMENT 3 §1 made the organisation's cap a count of RUNNING agents, and MOTIR-9374 moved its number
onto the org's plan as `agentsRunningPerOrg`, judged at create and at wake. An organisation could
therefore hold any number of hibernating agents, each charged for its storage every day, while the
plan's "per organisation" figure only limited how many were awake at once.

**Owner decision (2026-10-28):** the figure is **agents per organisation: every live (not deleted)
agent, running and hibernating together.**

- The plan field is **`agentsPerOrg`** (`lib/billing/planCaps.ts`). Its numbers are unchanged — they
  stay MOTIR-9668's (Standard 2, Pro 10, Max 20, Max ×2 20, Host floor 20, larger pools 50), and
  Host's own-account lift raises it the same way.
- It is judged **at create only**, beside `agentsPerUser`: under the same fleet admission lock that
  takes the agent slot, the org's live instances plus the creates already holding a slot whose row is
  not inserted yet are counted in one statement (`agentInstanceRepository.countLiveOrAdmitting`), so
  two creates one below the figure cannot both pass.
- Reaching it refuses **`org_cap`** (it replaces `org_running_cap`), naming the plan and the figure,
  and saying to delete one to create another — as `user_cap` does.
- **A wake is never refused by it.** A hibernating agent already counts, so waking it changes nothing
  the figure measures. A wake still takes its slot under the lock (the kill switch still stops it), and
  `agentRunsInParallel` and the shared pool still bound machines, unchanged.
- The org admin's Fleet use row shows the org's live agents against the figure. The platform
  monitor's agent-instance count stays a count of RUNNING machines and is no longer drawn against the
  figure, which no longer bounds it.

Motir's own organisations still have no agent limits (AMENDMENT 3 §2).
