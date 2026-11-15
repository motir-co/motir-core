# ADR: Moving an agent to a newer sandbox image — on its owner's say-so, on the same machine and volume, checked live, and rolled back when the new image does not run

- **Status:** Proposed (2026-10-01), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-6948 · **Story:** MOTIR-6862 (_An instance offers the newer sandbox image and moves
  to it on your say-so, keeping its home and sign-in_) · **Epic:** MOTIR-6859
- **Answers** the _"Moving an instance to a newer image — MOTIR-6862's"_ line of
  [`agent-instances.md`](agent-instances.md)'s _What this does NOT decide_.
- **Amends, by name, without editing that file:**
  - [`agent-instances.md`](agent-instances.md) **§1** — _"An instance stays on the digest it was
    created from"_ now holds only until its owner presses **Update** (Q2).
  - [`agent-instances.md`](agent-instances.md) **§4** — the state table gains `updating` and its
    edges, and the record gains five fields (Q6).
  - [`agent-instance-run.md`](agent-instance-run.md) **§4** — the run start refuses an agent that is
    `updating` (Q8), and its _Owed on acceptance_ probe for a moved digest is answered (Q3).
- **Consumed by:**
  - MOTIR-6949 — the published-image catalog and the agent DTO's _Update available_ (Q1)
  - MOTIR-6950 — the persistent port's image move and the liveness exec (Q2, Q3, Q4)
  - MOTIR-6951 — the My agents design delta (Q6's states, Q8's refusals)
  - MOTIR-6952 — the update operation, its transitions, rollback, refusals and route (Q4–Q8)
  - MOTIR-6953, MOTIR-6954, MOTIR-6955 — the UI, the test gate and the E2E, through the above
- **Builds on, and changes nothing in:** [`agent-terminal.md`](agent-terminal.md) Q8 (the machine
  config update and the per-digest terminal probe), [`agent-instance-storage.md`](agent-instance-storage.md)
  (wake's admission), [`fleet-image-pull.md`](fleet-image-pull.md) §0 (the images pull anonymously).

---

## Context

**The question.** How does an agent move to a newer published image when its owner asks, keeping
its home, and fall back safely when the new image does not work? Every build card in MOTIR-6862
builds to this answer. A wrong answer can lose a customer's volume, or leave an agent between two
images.

**What ships today** (rung 2, `motir-core` `origin/main` at `e07585f29`):

1. **An agent is pinned to a digest.** `lib/agentInstances/imageDigest.ts` resolves
   `ghcr.io/motir-co/motir-sandbox:<profile>` to a digest through the anonymous `probeImagePull`.
   The machine boots `…@sha256:<digest>`. `model AgentInstance` keeps `imageTag` and `imageDigest`,
   and **no version**.
2. **The images carry no version label.** The Dockerfile's `LABEL` block has a title, description,
   source and licence only (`packages/cli/sandbox/Dockerfile`). The version is in the **tags**. One
   push step writes both `:<profile>` (moving) and `:<profile>-<version>` (immutable)
   (`.github/workflows/sandbox-images.yml`, _Push <profile>_). That step runs after the
   per-profile smoke, which includes the profile's liveness command. `packages/cli/sandbox/README.md`
   (_Published images_) calls the immutable tag _"a promise about specific bytes"_.
3. **The registry answers anonymously.** Measured 2026-10-01 00:48 UTC with the anonymous token from
   `https://ghcr.io/token?scope=repository:moooon-b-v/motir-sandbox:pull&service=ghcr.io`:
   - `GET /v2/moooon-b-v/motir-sandbox/tags/list` returned 117 tags. For `claude` they are `claude`,
     then `claude-0.1.0` … `claude-0.10.0`.
   - `HEAD …/manifests/claude` and `…/manifests/claude-0.10.0` both returned `Docker-Content-Digest:
sha256:294c0c7f…`. `claude-0.9.0` returned `sha256:9124810e…`.
   - The moving tag and the highest immutable tag agree, and an older version's digest is still
     readable.
4. **The persistent port** (`packages/orchestrator/src/types.ts`, `PersistentContainerOrchestrator`)
   already has the pieces it needs:
   - `stop`, `start`, `describePersistent`, `exec` (argv, a timeout, optional stdin);
   - `ensureMachineConfig`. It reads the machine's FULL config (`getMachineRaw`) and re-sends it
     through Fly's update with `skip_launch: true` and `current_version`. It rewrites only the
     terminal fields, keeping _"the image digest, the volume mount and every other field"_
     (`adapters/fly/persistent.ts`, `updateMachine`, MOTIR-6939).
5. **The home survives an image change.** The image keeps a copy of its build-time home at
   `/opt/motir-home-seed`. The entrypoint runs `motir-sandbox-seed-home` first, which _"adds back
   only what is MISSING and never overwrites"_ (`packages/cli/sandbox/seed-home.sh`,
   `entrypoint.sh`, MOTIR-6887). The coding agents install under `/opt/motir-agents` on the rootfs
   (`Dockerfile`: `ENV MOTIR_AGENT_PREFIX=/opt/motir-agents`), so a new image brings a new agent
   while the sign-in on the volume stays.
6. **The boot already re-probes per digest.** `settleBoot` probes `terminalServer` and `runLauncher`
   for any digest not probed yet, and `signInState` on every boot
   (`lib/services/agentInstanceLifecycleService.ts`). `agent-instance-run.md` _Owed on acceptance_
   asks this decision to say how a moved digest gets its `runLauncher` probe.
7. **The reconcile destroys an orphaned volume** once its machine is gone from the inventory it read
   ([`agent-instances.md`](agent-instances.md) AMENDMENT 1). A volume is only safe while its machine
   exists.
8. **One running run per agent**, enforced by a partial unique index. Hibernate and Delete already
   refuse a running run in words (`AgentInstanceRunActiveError`,
   [`agent-instance-run.md`](agent-instance-run.md) §5–§6).

**What the references say** (rung 1, all read 2026-10-01):

- **Fly, _Machines resource_** (https://docs.fly.io/machines/api/machines-resource/):
  - _"If the Machine is running and the request is successful, it will reboot; if the Machine isn't
    running, and you don't want it to start up, set `skip_launch`."_
  - _"You cannot change which volume a Machine is attached to by updating the Machine's config. If
    you want to use a different volume, you'll need to destroy the Machine and create a new one that
    mounts to the desired volume."_
- **Fly, _Update Machine_** (https://docs.fly.io/api/machines/machines/update-machine): lists
  `skip_launch` with no description. It describes `current_version` as _"an optional
  optimistic-concurrency guard"_. The page does not say what an update does to mounts. The
  _Machines resource_ sentence above is the one that does.
- **Fly, `fly machine update`** (https://docs.fly.io/flyctl/machine-update/): `--skip-start`,
  _"Updates machine without starting it."_
- **GitHub Codespaces, _Rebuilding the container in a codespace_**
  (https://docs.github.com/en/codespaces/developing-in-a-codespace/rebuilding-the-container-in-a-codespace):
  - _"Your repository is cloned into the `/workspaces` directory … Any changes you make inside this
    directory … are preserved when you stop and start the codespace, and when you rebuild the
    container."_
  - _"Outside `/workspaces` … any changes you make are preserved when you stop and start your
    codespace, but are not preserved when you rebuild the container."_
  - The reference product swaps the image under a persistent mount, and the user starts the rebuild.
    That is the shape adopted here, with `$HOME` in the role of `/workspaces`.

Every reference named on the card was reached.

## Decision

### Q1 · Finding the newest image and naming versions — the registry's tags, read anonymously

**Chosen: (a), the moving tag decides which image is newest, and the immutable tags give it a
version.**

- **Newest for a profile** = the digest the moving `:<profile>` tag resolves to. That is exactly what
  Create boots today, so Create and Update always agree on "newest".
- **Its version** = the `x.y.z` of the immutable `<profile>-x.y.z` tag with the same digest. The
  tags come from `GET /v2/<repository>/tags/list` behind GHCR's anonymous bearer token, matched with
  `^<profile>-(\d+\.\d+\.\d+)$`, and each is resolved with `HEAD …/manifests/<tag>`.
- **When the two tags disagree**, the moving tag wins. If no immutable tag shares the moving tag's
  digest, **no update is offered** and the catalog logs a warning. A moving tag pointing at an
  unversioned digest is a publishing defect, and no customer is moved onto it.
- **A downgrade is never offered.** _Update available_ shows only when the newest version is
  semver-greater than the agent's. An operator rolling the moving tag back to an older release
  therefore moves nobody backwards.
- **An agent with no version on its record** is named by looking its `imageDigest` up among the
  profile's immutable tags. Every agent created so far was pinned from a moving tag that had an
  immutable twin, so the lookup normally finds it.
  - Create writes `imageVersion` from then on (Q6).
  - A digest no tag matches is shown as _"an earlier build"_. Update is offered whenever its digest
    differs from the newest.
- **The cache**, in-process, per profile:
  - the tag list and the moving tag's digest are reused for **10 minutes**;
  - an immutable tag's digest is cached for the life of the process, because it never changes.
- **When the registry cannot be reached**, the catalog answers `unknown`, and the agent DTO says it
  could not check. It never says _"up to date"_. The exact copy is MOTIR-6951's.
- **Pressing Update re-resolves the moving tag fresh**, bypassing the cache, and pins the exact
  digest and version it found on the record (Q6). The agent moves to what was newest at the press.

**Rejected:**

- **Take the highest semver immutable tag as newest.** It could offer a release an operator has
  rolled the moving tag back from, and Create and Update would then disagree.
- **(b) Read `@motir/cli`'s latest version from npm.** npm publishes before the image lane finishes,
  and a failed image job leaves npm ahead of any image. It is also a second registry to reach for an
  answer the image registry already gives.
- **(c) Record every release's digests in Motir at release time.** That is a write path and a
  credential from CI into every deployment, self-hosted ones included, for data the registry serves
  to anyone.

### Q2 · How Update changes the image — Fly's machine update on the same machine and volume

**Chosen: (a).** The adapter does the following:

1. Read the machine's full config (`getMachineRaw`).
2. Replace **only** `config.image` with `<repository>@<target digest>`. Mounts, `restart`
   (`on-failure`), `auto_destroy` (`false`), services, processes, env, guest, and metadata (including
   [`agent-terminal.md`](agent-terminal.md) Q8's stamp) are re-sent byte for byte.
3. Send it with `current_version`.

- **A running machine** gets the update without `skip_launch`, so Fly reboots it on the new image
  (_Machines resource_, above).
- **A stopped machine** gets it with `skip_launch: true` and is then started through the one `start`
  door. When the terminal config is also stale, the wake applies both changes in ONE update (Q5).
- **The handle never changes:** same app, machine id, volume id and region. The relay's
  `fly-force-instance-id` pin, the reconcile's inventory and every stored reference stay valid.
- **The adapter refuses its own mistake.** It compares the mounts it is about to send with the mounts
  it read, and throws without calling Fly if they differ.
- **A provider error, a 409 on `current_version` included** (the machine changed under the read),
  surfaces as the port's error and sends no second request. The service treats it as a failed move
  (Q4).
- **The port gains one operation that moves the image**, `{ launch }` saying whether to start a
  stopped machine, in the Fly and fake adapters. MOTIR-6950 names it, and this record calls it _the
  move_. Liveness reuses `exec`.

**Rejected:**

- **(b) Destroy the machine and create a new one mounting the same volume.** Between the destroy and
  the create, the volume has no machine. The reconcile destroys a volume once its machine is gone
  from its inventory (Context 7), so a create that fails, or a sweep that lands in that gap, deletes
  the customer's home. It also changes the machine id, which the relay pins.

### Q3 · The liveness check — the profile's liveness command, plus no regression of the terminal server

**Chosen: (a), plus one guard from the existing probes.** The new image passes when all of these
hold, in this order:

1. **Started.** `describePersistent` reports `running` within **5 minutes** of the move.
2. **The coding agent runs.** `exec` of the profile's liveness argv exits `0` within a **60-second**
   timeout. The argv is `claude --version` for Claude Code, and the matching command for the other
   profiles.
3. **The terminal server did not disappear.** The boot's `terminalServer` probe, run for the new
   digest as at every boot, must not read `absent` when the agent's previous digest read `present`.
   An update that removed the terminal would strand the user without the panel they update through.

- The same settle also records the `runLauncher` and `signInState` probes for the new digest. **That
  answers [`agent-instance-run.md`](agent-instance-run.md)'s owed probe:** the move probes
  `runLauncher` for the digest it moves to before the agent reads `running`.
- **Sign-in is not part of liveness.** The credential is on the volume and the seed never overwrites
  it (Context 5), so it is expected to survive. If a newer agent reads it as signed out, that is
  recorded like any other probe answer. It is not a reason to roll back: a version that needs a
  fresh sign-in could otherwise never be adopted.
- **Where the command lives:**
  - `lib/agentInstances/profiles.ts` gains a `liveness: readonly string[]` on each offered profile.
  - A drift guard test asserts it equals `packages/cli/sandbox/smoke/profiles.json`'s `liveness`,
    split on whitespace, for every offered profile.
  - motir-core's runtime never reads the smoke file, and CI fails the moment the two disagree.

**Rejected:**

- **(b) The terminal server answers.** That proves Motir's own server is up, not the coding agent
  the owner updated for. It also needs a dial through `motir-relay`, a separate app, on the update's
  critical path.
- **(c) Both, with a live relay dial.** The relay dependency stays the cost. The `terminalServer`
  probe already detects the one regression that matters without the dial.

### Q4 · Rollback — back to the record's digest, the volume never touched

**On any liveness failure** — not started in 5 minutes, the liveness exec exits non-zero or times
out, the terminal server regressed, or the move itself failed — the agent stays `updating` and
rolls back:

1. Move the machine back to the agent's `imageDigest`, through the same Q2 path. That digest is the
   one it ran before: the record's digest changes only on success (Q6).
2. Wait for `running`, up to the same 5 minutes. The previous image already ran on this volume, so
   reaching `running` is the rollback's success test. Its liveness command is not re-gated.
3. Move `updating → running`, with `updateFailureReason` in words, for example _"The update to
   0.10.0 didn't work: `claude --version` exited 127. Your agent is back on 0.9.0."_
4. Clear the target fields.

The open interval and the slot are untouched throughout (Q7).

**When the rollback itself fails** (Fly refuses the move back, or the machine does not reach
`running`):

- The agent moves `updating → failed`, with _"The update to 0.10.0 didn't work, and your agent
  couldn't be brought back on 0.9.0: <detail>. Wake to try again, or delete it."_
- The existing `failInstance` path closes the interval and releases the slot.
- The record's `imageDigest` is still the previous one.
- **Wake from `failed` puts it right.** The wake's machine-config step also asserts that the
  machine's image equals the record's `imageDigest`, and moves it back if not (MOTIR-6950,
  MOTIR-6952). This extends `ensureMachineConfig`'s "is it current?" test from the terminal stamp to
  the image.

**The volume is never destroyed or detached on any branch.**

- An update and a rollback call only the move, `start`, `describePersistent` and `exec`. They
  never call `destroyPersistent`, `destroyMachine`, `destroyVolume` or `provisionPersistent`.
- The mounts are asserted unchanged on every move (Q2), and Fly does not change a volume
  attachment through an update anyway (_Machines resource_, above).
- The machine id never changes, so the reconcile never sees an orphaned volume (Context 7).

### Q5 · A hibernated agent — the target is recorded now and applied at its next wake

- **Update on a `hibernated` agent changes no machine.** It pins the target digest and version on the
  record (Q6) and leaves the agent `hibernated`. The row then shows the version it will take at its
  next wake (copy: MOTIR-6951).
- **Its next wake applies it.** That is the owner's Wake, or the wake a run's launch job makes
  ([`agent-instance-run.md`](agent-instance-run.md) §4 step 8).
  - Wake's admission runs **unchanged** first: the AI-plan check, credits, the organisation's running
    limit and the slot, as [`agent-instance-storage.md`](agent-instance-storage.md) orders them.
  - Then the agent moves `hibernated → updating`, opening its interval exactly as `waking` would.
  - The machine is moved with `skip_launch: true`, together with any stale terminal config, and
    started.
  - The new image's liveness is checked **at that wake**, by the same settle as a running update
    (Q3).
- **A failure at that wake rolls back** (Q4) **before the agent is ever reported `running`**. A run
  whose launch job caused the wake waits, as it already waits for `running`, and starts on whichever
  image the settle left the agent on.
- **How long the previous digest is kept:** it is the record's `imageDigest` until a move succeeds,
  so it needs no column of its own, and the agent can always fall back to it. After a successful
  move it is not kept, because no downgrade is offered (Q1).
- **The pinned target is honoured, not re-resolved.** A release published between the press and the
  wake does not change what the owner agreed to. Pressing Update again re-targets the newest.
- **An agent never updated never moves.** A wake changes the image only when a target is pinned, so
  [`agent-instances.md`](agent-instances.md) §1's pin holds indefinitely across hibernate and wake
  for an agent nobody updated.

**Rejected: updating the stopped machine at the press.** For days the machine would hold an image the
record does not name. A later wake that failed would have to discover which digest it was on before
it could roll back.

### Q6 · States and record — a new `updating` state, and five fields

**Chosen: a new `updating` state.** It amends [`agent-instances.md`](agent-instances.md) §4's
table with these rows. Every row not named here is unchanged.

| from         | to         | by                                                                                                                                                       |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`    | `updating` | **Update** on a running agent with no running run; the interval stays open and the slot held                                                             |
| `hibernated` | `updating` | **Wake** when a target is pinned (Q5), after wake's admission; a new interval opens, as on `waking`                                                      |
| `updating`   | `running`  | liveness passed on the target (`imageDigest` ← target), OR the rollback reached `running` (`imageDigest` unchanged, `updateFailureReason` set)           |
| `updating`   | `failed`   | the rollback failed (Q4); the interval closes and the slot is released                                                                                   |
| `updating`   | `failed`   | the reconcile finds the machine or volume `gone`; any open interval closes with `endReason: lost` (the existing reconcile row, now also from `updating`) |

- **Every move is a guarded compare-and-set**, and the Fly call happens after the guard commits,
  outside the transaction, as §4 already requires.
- **`updating` is a running state.** It joins `RUNNING_STATES` (`lib/agentInstances/stateMachine.ts`),
  so it holds a slot and counts toward the pool's safety valve.
- **The sweep never hibernates an `updating` agent.**
  - The idle timer, the backstop and a credit refusal act on `running` only. They act at the first
    pass after the update settles.
  - The 30-minute roll of the interval DOES include `updating`, because the machine is running and
    charged.
- **An update outlives the request, and its own job settles it** (amended by MOTIR-8954,
  2026-11-15 — see _How an update is settled_ below). Update, and the wake that applies a pinned
  update, answer at once with the agent `updating`, and hand the settle to the
  `agent-instance/update-settle` job. Each pass of that job reads where the machine actually is:
  - **gone** → `failed`, `lost` (the row above);
  - **on the target digest and not yet verified** → once started, run Q3's liveness now, then
    `running` or a rollback; not started within Q3's 5 minutes → the rollback begins;
  - **on the record's digest** → a rollback was under way: `running` with the reason once started,
    `failed` (Q4) if it does not start.

  While nothing can be decided yet (the new image is still pulling or starting), the pass defers
  `AGENT_UPDATE_POLL_MS` (2 seconds), so the update lands within one poll of the machine allowing it.
  **The sweep is the net under the job, not the normal path:** it settles an update only once its
  `stateChangedAt` is over **10 minutes** old (`UPDATE_SWEEP_AFTER_MS`) — the job's event was lost,
  its worker died, or the provider could not be read for the whole window — and the job stops
  deferring at that same mark. The settle is idempotent and guarded, like `settleBoot`, so the job
  and the sweep cannot both win: the move out of `updating` is one compare-and-set, and a rollback is
  recorded only while no failure is recorded yet, so it moves the machine back once.

- **Hibernate and Delete refuse an `updating` agent** with the existing state-conflict words. The
  owner waits for it to settle, which takes minutes at most.

**The record** (`model AgentInstance`) gains:

| field                     | holds                                                                                                                                | written                                      | cleared                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------- |
| `imageVersion` (nullable) | the `x.y.z` of `imageDigest` (Q1)                                                                                                    | at Create, and when a move succeeds          | never; an older agent's null is named by digest lookup at read |
| `targetImageDigest`       | the digest Update pinned. **Set with `hibernated` = an update waiting for the wake; set with `updating` = the image being moved to** | at the Update press                          | when the move settles: success, rollback or `failed`           |
| `targetImageVersion`      | its version                                                                                                                          | with it                                      | with it                                                        |
| `updateFailureReason`     | the last update's failure, in words (Q4)                                                                                             | on a rollback, or on `failed` from an update | at the next Update press, and when a move succeeds             |
| `updateFailedAt`          | when                                                                                                                                 | with it                                      | with it                                                        |

**`imageDigest` always names a digest that has run on this agent**: the one it was created from, or
one that passed liveness on it. That is why a rollback needs no _previous digest_ column. During
`updating`, the machine may briefly run the target while the record still names the previous digest.
The settle reads the machine to tell which (above).

**Rejected: reusing `starting`, `waking` and `hibernated`.**

- `waking` on a running agent would claim an interval opened that never closed.
- None of them can say "rolling back".
- The run start's refusal, and Hibernate's and Delete's, would each have to tell an update's
  `waking` from an ordinary one by reading other fields. That is a state the table no longer names.

#### How an update is settled — AMENDMENT (MOTIR-8954, 2026-11-15)

**What this record said.** _"An agent left `updating` (a process died mid-update) is settled by the
sweep once its `stateChangedAt` is over 10 minutes old."_ The premise was that the request's own
20-second inline settle (`INSTANCE_INLINE_UPDATE_WAIT_MS`) finishes an ordinary update and the
sweep only catches a dead process.

**What production showed (MOTIR-6956, 2026-10-18).** A real update's machine was `started` 29 s
after the press. The inline wait had given up at 20 s, the sweep skips an update younger than ten
minutes, and so the record sat `updating` for 10 minutes with nothing left to wait for — Hibernate
and Delete refused, the idle timer off, the panel saying "updating" on an agent already on the new
version. Pulling a new image takes longer than 20 s as a rule, so the fallback was the normal path,
with a worst case near 15 minutes.

**Decided.** The update takes the shape create and wake already took in
[`agent-instances.md`](agent-instances.md) AMENDMENT 6: the request answers at once and a job owns
the wait. `INSTANCE_INLINE_UPDATE_WAIT_MS` is removed; the Q6 bullet above says how the job and the
sweep share an update. The deadlines are unchanged: Q3's 5-minute start deadline still begins the
rollback, and Q4's 5-minute rollback deadline still fails the agent.

**Rejected: keeping the request's 20-second wait and only settling in the sweep sooner** (every
pass once 20 s have passed). It still leaves an ordinary update `updating` for up to one sweep
pass — five minutes — and keeps an HTTP request open for 20 seconds that a job can wait out instead.

**What the owner sees.** The Update dialog closes at once on an agent in `updating`; the page
already polls an agent in motion (`AGENT_STATES_IN_MOTION`) and shows it running on the new version
within a couple of seconds of its liveness check passing.

### Q7 · Slot, interval and credits — a running update keeps all three, and runs no admission

- **A running agent's interval stays open across the reboot.** The reboot takes seconds of the
  owner's own choosing, and an interval runs from the machine's start to its stop
  ([`agent-instances.md`](agent-instances.md) §5). Closing and reopening would split one run into two
  and move the slot to a new `runId` for no gain. The sweep's roll still splits it every 30 minutes,
  as for any running agent.
- **It keeps its fleet slot** (the same `runId`), and **it runs no admission**: no AI-plan check, no
  credit pre-flight, no running-limit check.
  - It already holds the slot, and its organisation's credits are asked on every sweep pass.
  - Re-running admission mid-update could refuse an agent the owner is actively using, at the moment
    its machine is rebooting.
- **A hibernated agent's update runs wake's admission, unchanged**, at the wake that applies it
  (Q5). That is whatever [`agent-instance-storage.md`](agent-instance-storage.md)'s wake runs once
  MOTIR-6914 and MOTIR-6906 land, so this record adds no admission of its own.

### Q8 · Refusals — each in the words the owner sees

**The route** is `POST /api/projects/[key]/instances/[id]/update`, beside `wake` and `hibernate`. It
calls one service method, `agentInstanceLifecycleService.update`, behind `instance:use` and owner
scope ([`agent-instances.md`](agent-instances.md) §8). It refuses with:

| refusal                                                                                   | code                                                     | words                                                                              | HTTP |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| not the caller's agent, missing or deleted                                                | `agent_instance_not_found` (existing, no leak)           | the existing not-found answer                                                      | 404  |
| a run is running in the agent                                                             | `agent_instance_run_active` (existing, action `updated`) | _"This agent is running MOTIR-123, so it can't be updated. Cancel the run first."_ | 409  |
| already on the newest image                                                               | `agent_instance_up_to_date`                              | _"This agent already runs the newest version (0.10.0)."_                           | 409  |
| not `running` or `hibernated` (starting, waking, hibernating, updating, failed, deleting) | `agent_instance_state_conflict` (existing)               | _"This agent is waking, so it can't be updated right now."_, with the state named  | 409  |
| the registry could not be reached                                                         | `agent_image_catalog_unavailable`                        | _"Motir couldn't check for a newer version just now. Try again in a few minutes."_ | 503  |
| the lane is not configured                                                                | `agent_instances_unavailable` (existing)                 | the existing words                                                                 | 503  |

- **A `failed` agent is refused** (state conflict). Wake it first: an update needs a machine known
  to run.
- **The run refusal and the update cannot both lose.**
  - The update's guarded `running → updating` and the run start's insert of a `running` run (the
    partial unique index, [`agent-instance-run.md`](agent-instance-run.md) §5) serialise on the agent
    row.
  - The update re-checks for a running run inside the same transaction as its guarded move, under a
    row lock.
  - The run start's state check refuses an `updating` agent with the existing
    `agent_instance_state_conflict`. This is the one change to
    [`agent-instance-run.md`](agent-instance-run.md) §4's refusal set, and MOTIR-6952 carries it.
- **Hibernate and Delete** refuse `updating` with the existing state-conflict words (Q6).

## Consequences

- **The home, the clones, the sign-in and the chat sessions survive an update.** They are all on the
  volume, and the volume is never touched. Everything on the rootfs is replaced, which is the point,
  and it was already replaced on every wake.
- **An update costs the owner a reboot, under a minute of agent time, inside their running
  interval.** Nothing extra is charged and no rate is added.
- **Nothing updates by itself.** An agent nobody updates keeps its digest for ever, as
  [`agent-instances.md`](agent-instances.md) §1 promised. The only new door is the owner's press.
- **Agents created before the run launcher shipped can now be moved onto it.** That clears
  [`agent-instance-run.md`](agent-instance-run.md)'s _image too old_ for agents whose owners press
  Update.
- **A broken published image is caught per agent, not per release.** The liveness check runs on the
  customer's machine. A release that passed CI's smoke and still fails on a real volume rolls each
  agent back with the reason. That is a signal to the operator to move the tag back, and with it the
  newest offered version (Q1).

## Owed on acceptance

- Nothing outside this story. The five consumer cards above carry every build item. The run start's
  added refusal (Q8) and the wake's image assertion (Q4) are MOTIR-6952's, and the port's
  move is MOTIR-6950's.

## What this does NOT decide

- **Building, testing or publishing the images.** The `cli-v*` release lane
  (`.github/workflows/release-sandbox.yml`, `sandbox-images.yml`) is unchanged.
- **Moving an agent to a different profile** (Claude Code → Codex). That is a new agent.
- **Downgrading to an older version, or offering a version other than the newest.** Neither is
  offered.
- **Updating agents automatically, or in bulk across an organisation.** Every move is one owner's
  press on one agent.
- **Cancelling an update in flight**, or withdrawing an update pinned on a hibernated agent. Neither
  is offered. A pinned target is applied at the next wake, or replaced by pressing Update again.
- **Restoring a home from a Fly snapshot.** That is still [`agent-instances.md`](agent-instances.md)'s
  open line.
- **Any price.** The update runs inside the agent's existing intervals.
- **The page's layout and copy.** Those are MOTIR-6951's design. This record names the states and
  refusals the design must draw.
