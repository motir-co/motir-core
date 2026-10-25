# ADR: A hosted agent run, end to end

- **Status:** Proposed (2026-09-26), for acceptance at this card's `decision_approval` gate
- **Card:** MOTIR-685 (9.1.2) · **Story:** MOTIR-683 (9.1, "A card runs on the hosted agent")
- **Consumed by:**
  - MOTIR-684 (the design)
  - MOTIR-687 (the image)
  - MOTIR-688 (the run's Motir credential)
  - MOTIR-689 (the gateway wiring)
  - MOTIR-6447 (the credit pre-flight)
  - MOTIR-6448 (machine time by run)
  - MOTIR-6449 (the run's git credential)
  - MOTIR-690 (start), MOTIR-691 (the UI), MOTIR-692 and MOTIR-6451 (the test gates), MOTIR-6452 (the E2E) and MOTIR-6453 (production configuration), for the model choice in §7
  - through them, MOTIR-6450 (end)
- **AMENDED 2026-09-29 by MOTIR-6815, for Story MOTIR-1626 (9.8, the review agent) — §8, NEW: the REVIEW run.** A second kind of hosted run, which implements nothing: it reads a green card's pull requests against the card and returns ONE verdict to the `agent_review` gate ([`approval-gates.md`](approval-gates.md) §12). §8 decides its command and mode, attribution and billing, credential, what it reads and what it never writes, and the coding convention as OPTIONAL input. §2, §3, §7 and _What this does NOT decide_ each carry a pointer; nothing is struck. **Consumed by** MOTIR-6818, MOTIR-6820, MOTIR-6821, MOTIR-6824 and MOTIR-6904. **Revised the same day by the requester** (MOTIR-6817's design gate): **§8.6, the hosted REPAIR run** — a card a review sent back can be repaired on the hosted agent by a person's press.
- **AMENDED 2026-10-01 by MOTIR-7206, for Story MOTIR-7205 (a hosted run can be served by DeepSeek) — §7: the offered list spans every provider the transfer-basis record AND the egress contract allow, which ~~today is `anthropic` and `deepseek`~~ _(struck 2026-10-02, MOTIR-7242: four providers now, below)_; OpenCode's model is `<provider>/<bare id>`, taken from the offered model's own `provider`.** Motir's platform default stays Claude at every difficulty level, and a project's own per-difficulty override may name DeepSeek. §6 says there is still no model variable. §7 condition 2 and _One id, two spellings_ are struck in place, and so is the Anthropic-only line in _What this does NOT decide_. Follows `ai-upstream-transfer-basis.md`'s 2026-10-01 amendment (MOTIR-3687), which supersedes the finding that DeepSeek has no basis. **Consumed by** MOTIR-7207 (the gateway's egress contract), MOTIR-7208 (the start path, the CLI and the image), MOTIR-7209, MOTIR-7210 and MOTIR-7211 (the test gates), and the post-merge tasks MOTIR-7212 (pin the image), MOTIR-7213 (motir-ai lists `deepseek`) and MOTIR-7214 (one real hosted DeepSeek run).
- **AMENDED 2026-10-02 by MOTIR-7242, for Story MOTIR-4332 (a hosted run can be served by GLM and Qwen) — §7: the offered providers are `anthropic`, `deepseek`, `z-ai` and `qwen`, and a provider's recorded transfer basis decides its `transfer-basis` membership and its disclosure, not whether it is served.** GLM is reached only at Z.ai's international API and Qwen only at a configured Alibaba Model Studio Frankfurt workspace URL, both on `/v1/chat/completions` with the run key, the way DeepSeek is (MOTIR-3665). Claude stays Motir's default at every difficulty level. §7 condition 2's _Today that is `anthropic` and `deepseek`_ is struck in place, and so is the GLM/Qwen half of the _GLM, Qwen or Kimi_ line in _What this does NOT decide_. MOTIR-7206's spelling rule (`<provider>/<bare id>`) and its add-a-provider procedure stand. Follows the founder's direction in the planning conversation of 2026-10-01 (_"Serve like DeepSeek"_ over _"Keep the strict bar"_). **Consumed by** MOTIR-4332 and its children (MOTIR-7243 the egress contract, MOTIR-7244 the CLI and image, MOTIR-7245 and MOTIR-7246 the test gates, MOTIR-7195 the transfer-basis rows, MOTIR-7198 the channels), and the post-merge tasks MOTIR-7247 (pin the image), MOTIR-7248 (motir-ai lists `z-ai` and `qwen`) and MOTIR-7249 (one real hosted run on each), beside MOTIR-7201 (enable both channels on the running gateway).
- **AMENDED 2026-10-02 by MOTIR-7350, for Story MOTIR-7351 (a hosted run can be served by Kimi) — §7: the offered providers are `anthropic`, `deepseek`, `z-ai`, `qwen` and `moonshotai` (Kimi, Moonshot AI's international platform, `https://api.moonshot.ai`), served the way DeepSeek, GLM and Qwen are.** Kimi is reached only at Moonshot's international API, never at the mainland `api.moonshot.cn`, on `/v1/chat/completions` with the run key, and is billed at the `agent` lane. Its channel is served once it has a channel and a key; its recorded transfer basis decides only `transfer-basis` membership and disclosure (MOTIR-3665). Claude stays Motir's default at every difficulty level. §7 condition 2's _today that is `anthropic`, `deepseek`, `z-ai` and `qwen`_ is struck in place, §7's route table gains a `moonshotai` row, _Serving without a recorded basis_ names `moonshotai`, and the remaining _Kimi on hosted runs_ line in _What this does NOT decide_ is struck. MOTIR-7206's spelling rule (`<provider>/<bare id>`) and add-a-provider procedure, and MOTIR-7242's direction for GLM and Qwen, stand. Answers the open half of bug MOTIR-6258 (which endpoint the Moonshot channel uses) and replaces MOTIR-4332's _"Moonshot is not touched"_ scope line. Follows the founder's direction in the planning conversation of 2026-10-02 (_"we should be able to run kimi too with hosted agent like deepseek, glm, qwen"_). **Consumed by** MOTIR-7351 and its children (MOTIR-7356 the transfer basis, MOTIR-7357 the egress contract, MOTIR-7358 the relay key, MOTIR-7359 the transfer-basis row, MOTIR-7360 the public pages, MOTIR-7361 the CLI and image, MOTIR-7362 the channel's move to `.ai`, MOTIR-7363, MOTIR-7364 and MOTIR-7365 the test gates), and the post-merge tasks MOTIR-7352 (re-point and enable the running Moonshot channel), MOTIR-7353 (pin the image), MOTIR-7354 (motir-ai lists `moonshotai`) and MOTIR-7355 (one real hosted Kimi run).
- **AMENDED 2026-10-04 by MOTIR-7522, for Story MOTIR-7521 (platform admins curate which models Motir may plan with and run with) — §7: the models a hosted run may use are a platform-curated RUN-MODEL LIST, kept in motir-core and edited by a platform superadmin in the operator console, intersected live with motir-ai's offer.** The offer becomes _run list ∩ `GET /v1/agent-models`_, recomputed on every read. §7's _The list is served by motir-ai, never kept in motir-core_ paragraph and the _A list kept in motir-core_ rejection are marked superseded in place; the amendment is §7's last block, _AMENDED 2026-10-04 (MOTIR-7522) — the run-model list_. **Supersedes** MOTIR-6483 (_the list is motir-ai's, nothing here keeps a copy_) and MOTIR-6993 (a project override or platform default is valid whenever motir-ai offers the model). Follows the owner's direction of 2026-10-03 (_"a list in motir-core which is allowed to be use to run"_). **Consumed by** MOTIR-7525 (the list), MOTIR-7526 (the narrowed offer), MOTIR-7528 (its console), MOTIR-7529 and MOTIR-7530 (the test gates).
- **AMENDED 2026-10-26 by MOTIR-7656, for Story MOTIR-714 (9.4, hosted runs proven by dogfood) — §6 and NEW §9: the container and motir-core reach the gateway at TWO origins.** A hosted-run container dials the gateway's **run lane** at the public, Motir-owned `https://gateway-run.motir.co`, served by a separate edge app in front of the gateway. motir-core's own server (mint, revoke, status) keeps the private `http://motir-gateway.flycast`. §6's _so the container receives it verbatim_ is struck in place and gains `MOTIR_GATEWAY_RUN_URL`. Fly cross-org private networking is ruled out (§9). Follows the owner's decision while walking MOTIR-7656 (_"narrow public ingress on a Motir-owned hostname"_). **Consumed by** MOTIR-6453 (sets both values on production), MOTIR-6799 (the first real hosted run) and MOTIR-8342 (tenant apps on motir.site, built on the same edge).
- **Supersedes:** this card's own earlier scope, a `motir-ai/docs/hosted-execution.md` that was to choose a container orchestrator and a per-agent `*_BASE_URL` matrix. It was never written; both questions have since been settled elsewhere (see Context).

> Structured **Status → Context → Decision → Consequences**, in the shape the other records here use. Every enumeration below was read on `origin/main` of motir-core `84b69443e`, motir-gateway `00f72c8` and motir-ai `c440da5` (2026-09-26).

---

## Context

Story 9.1 runs one card on OpenCode in a fresh metered container, as the person who dispatched it, and ends in a pull request. Almost every piece it needs already ships, and each was built without knowing the others:

| Shipped piece                                   | Where                                                                                      | What it keys on                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Container lifecycle and hosting meter           | `lib/services/hostedAgentContainerService.ts` (MOTIR-4336)                                 | a fleet slot `ref`; the meter row is attributed to org, workspace, project and repository, not to a run |
| The shared run record, ingest, stream and panel | `DispatchRun` / `DispatchRunEvent`, `/api/v1/dispatch-runs/*` (MOTIR-1789)                 | `DispatchRun.id`; `origin` is already `local \| hosted`                                                 |
| The per-run model key                           | motir-gateway `POST /api/motir/run-keys`, `DELETE /api/motir/run-keys/:runRef` (Story 9.0) | a `runRef` the caller chooses                                                                           |
| The run's usage and credits                     | motir-ai `GET /v1/agent-runs/:coreRunId/usage` (MOTIR-6381)                                | a `coreRunId` the caller chooses                                                                        |
| How OpenCode must be configured                 | motir-gateway `docs/hosted-run-egress.md`                                                  | the env names `MOTIR_GATEWAY_URL`, `MOTIR_RUN_KEY`                                                      |

The container orchestrator (Fly Machines in a separate org behind the `ContainerOrchestrator` port) was decided by MOTIR-1918 and built by MOTIR-4336. The harness was settled as OpenCode, on Motir's gateway key only, by the epic (MOTIR-673). **Neither is re-opened here.**

What nobody has recorded is how these pieces meet for one run. Seven questions have to be answered once, because at least two cards and usually two repositories depend on each.

---

## Decision

### 1 · One id: `DispatchRun.id`, everywhere

A hosted run's `DispatchRun.id` is the value passed as:

- the fleet slot `ref` (`fleetCeilingService.reserve`);
- the container meter row's run pointer (MOTIR-6448);
- the gateway key's `runRef`;
- motir-ai's `coreRunId`;
- the run credential's binding (§3).

It is created first (`dispatchRunService.open`, `origin: 'hosted'`), before anything is minted or booted, so every later write can name it. It is already what the run panel keys on, and 9.0 already bills by it.

**Rejected:** a separate "hosted run id". Every consumer would then need a join back to the run the person is looking at, and a key minted under one id and billed under another is a run that appears to cost nothing.

### 2 · The lifecycle, on the shared vocabulary only

> **AMENDED 2026-09-27 by [MOTIR-6525](run-death-keeps-work.md) — [`run-death-keeps-work.md`](run-death-keeps-work.md) §3.** No run end moves its card backwards. The **To Do** end state below is withdrawn: a failed, cancelled, stalled or backstopped run leaves its card at the status it holds, with its branch pushed and a _run died_ marker, and `motir continue` picks the work up. Success still moves the card to Implemented. The run statuses and teardown reasons in the table are unchanged.

The story forbids a hosted-only status or event vocabulary, so a hosted run is expressed entirely in what `DispatchRun` already has. **No `DispatchRunStatus` and no event kind is added.**

| Phase the panel shows | Written as                                                    | Written by                              |
| --------------------- | ------------------------------------------------------------- | --------------------------------------- |
| starting              | `run_opened`                                                  | the start path (MOTIR-690)              |
| cloned                | `checkout_ready`                                              | the in-container entrypoint (MOTIR-687) |
| running               | `agent_started`, then `log` events carrying OpenCode's output | the entrypoint                          |
| agent finished        | `agent_exited` (exit code)                                    | the entrypoint                          |
| pull request open     | `delivery_linked` (the pull request URL)                      | the entrypoint                          |
| done                  | `run_closed`                                                  | the end path (MOTIR-6450)               |

| How it ended                                                      | `DispatchRunStatus` | Teardown reason | The card becomes                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent exited 0 and a pull request opened                          | `succeeded`         | `job_completed` | **Implemented** (`in_progress → implemented`), exactly as a local run's card once its pull request opens. From there the pull request's own CI and merge move it, as for any card |
| agent exited non-zero, or any start step failed                   | `failed`            | `job_completed` | keeps its status, marked _run died_                                                                                                                                               |
| a person pressed cancel                                           | `cancelled`         | `gate_revoked`  | keeps its status, marked _run died_                                                                                                                                               |
| ~~wall-clock timeout, 90 minutes (§5)~~ the 12-hour backstop (§5) | `timed_out`         | `job_timed_out` | keeps its status, marked _run died_                                                                                                                                               |
| stalled (§5)                                                      | `timed_out`         | `job_timed_out` | keeps its status, marked _run died_                                                                                                                                               |

> **§2 · POINTER (MOTIR-6815, 2026-09-29).** A **review** run (§8) uses the same phases and statuses, with two differences: it emits no `delivery_linked`, and it moves **no card status on any end**. It succeeds when its ONE verdict is accepted; every other end is a review that could not run, written onto the gate ([`approval-gates.md`](approval-gates.md) §12.6).

Stall and timeout share a status because they are the same fact to the record: the run ran out of time. The run's closing `log` event names which one it was (_"stalled: no agent output for 15 minutes"_ / ~~_"timed out after 90 minutes"_~~ _"reached the 12-hour backstop"_), and that line is what the panel shows. ~~Both edges out of `in_progress` are legal in the default workflow (`lib/workflows/defaultWorkflow.ts`). **Returning to To Do rather than staying In Progress is deliberate:** a failed hosted run holds no worktree and no person, so In Progress would be a claim nobody is exercising, and both claim doors refuse it.~~ _Withdrawn 2026-09-27 ([`run-death-keeps-work.md`](run-death-keeps-work.md) §3, Rejected): sending the card back to To Do makes it lie about how far the work got and drops the branch out of sight. The card keeps its status and the_ run died _marker makes the state legible._

`implementationSource: hosted` (with `implementationHarness: opencode`) is stamped at start and never cleared. It records how the card was attempted, and a later local run overwrites it through its own seam, as provenance already does (`docs/decisions/work-item-provenance.md`).

### 3 · The run's Motir credential: a run-bound `ApiToken`

The container needs to call Motir to report through the shared ingest and to read its card's dispatch prompt. It gets **one `ApiToken`**:

- **Bound to the run:** a new nullable `ApiToken.dispatchRunId`. A token carrying it is accepted by `/api/v1/dispatch-runs/{id}/events` and `/close` **only for that `{id}`**, refused on `POST /api/v1/dispatch-runs` (the server opens hosted runs itself), and allowed to read `GET /api/v1/work-items/[key]/dispatch-prompt` **only for that run's card**.
- **Owned by the dispatcher**, so every write it makes is attributed to the person who pressed Run hosted, as the story requires.
- **Grant:** `HOSTED_RUN_TOKEN_GRANT` = `['project:browse', 'work_item:edit']`, the two keys those routes assert. The binding in the first bullet is what narrows it; the keys alone are as coarse as the CLI's. It holds no `ai:*` key, so it cannot author or read plans.
- **Lifetime:** `expiresAt` = boot time + the run's timeout (§5) + 5 minutes for settle. _Amended 2026-09-27 ([`run-death-keeps-work.md`](run-death-keeps-work.md) §1): the run's timeout is now the 12-hour backstop, so this is boot + 12 hours + 5 minutes._
- **Death:** revoked at run end by the end path. Revoking an `ApiToken` **deletes its row** (MOTIR-3546), so a revoked run token cannot be revived. Its expiry is the backstop if revocation fails.

> **§3 · POINTER (MOTIR-6815, 2026-09-29).** A review run's token is the same run-bound `ApiToken` with the same grant. The binding admits two more routes, for that run's card only and only while the run's command is `review`: the review prompt, and the verdict `POST /api/v1/work-items/{key}/agent-review` (§8.4).

**Reference:** GitHub Actions' `GITHUB_TOKEN`, minted per job, limited to that job's repository and declared permissions, and invalid when the job ends. **Rejected:** a second, purpose-built token system. `ApiToken` already carries hashing, expiry and grant checks, so a run token differs by one column and one grant.

### 4 · The git identity: how the pull request is authored as the dispatcher

**The question was genuinely open, and the answer depends on who owns the repository.**

**Decision.**

- **A repository the USER owns** (reached through the opt-in "Motir Agent" App, MOTIR-1894): a **GitHub App user access token for the dispatcher**.
  - It is exchanged with `repository_id` set to that one repository, so it reaches nothing else.
  - It expires in 8 hours, longer than any run (§5).
  - It is revoked at run end with `DELETE /applications/{client_id}/token`.
  - Commits and the pull request are then the dispatcher's own, shown with the App's badge.
  - **If the dispatcher has not authorized the Motir Agent App, the run is refused before anything boots**, with the reason _"link your GitHub account to Motir to run hosted on owner/name"_. There is no bot fallback on a user's repository.
- **A repository MOTIR created** (reached through `motir-studio` in Motir's own organization, MOTIR-704 / MOTIR-1966): a **narrowed installation access token**.
  - Its access-token request body limits it to that one repository, `contents: write` and `pull_requests: write`.
  - It lasts one hour and is revoked with `DELETE /installation/token`.
  - Commits are authored as the dispatcher (their linked GitHub noreply address when they have one, otherwise their Motir name and verified email).
  - The pull request is opened by `motir-studio[bot]`, and its body names the dispatcher.

**Why the split, not one answer.**

- A user access token can only reach what the user can reach: _"The app can only access resources that the user has access to"_. A dispatcher is normally not a member of Motir's own organization, so the user token cannot work on a Motir-created repository.
- On a user's own repository the bot option can work, but it does not make the dispatcher the author. Only a user access token does: _"the GitHub UI will show the user's avatar photo along with the app's identicon badge as the author"_.

**Evidence.**

- GitHub, _Authenticating with a GitHub App on behalf of a user_:
  - attribution, and access limited to the overlap of the user's and the app's.
- GitHub, _Generating a user access token for a GitHub App_:
  - _"By default, the user access token expires after 8 hours"_;
  - `repository_id`: _"The ID of a single repository that the user access token can access."_
- GitHub REST, _Create an installation access token for an app_:
  - `repositories` / `permissions` narrowing;
  - _"Installation tokens expire one hour from the time you create them."_
- GitHub REST, _Revoke an installation access token_, and _OAuth authorizations: delete an app token_.
- GitHub, _Permissions required for GitHub Apps_: `POST /repos/{owner}/{repo}/pulls` needs `pull_requests: write`.

**Reference products, as observed in their own documentation (2026-09-26).**

- **GitHub Copilot's cloud agent** authors commits itself, _"with the developer who assigned the issue … marked as the co-author"_, and opens the pull request as Copilot. That is the bot option, and it is what the Motir-created-repository branch does.
- **Google Jules** opens the pull request as Jules. That is also the bot option.
- **Devin** defaults to its bot but offers an admin setting _"Open PRs as: User only"_, which _"opens as the user, and fails if their git account is not linked"_. That is this decision's user-repository branch, refusal included.
- **OpenAI Codex cloud** appears to act through the user's connected GitHub account, but no official OpenAI document states the pull request's author, so it is not relied on here.

**Rejected alternatives:**

- **The bot option everywhere.** It is simplest, but the story's "authored as the dispatcher" would then be true only of the commits, never of the pull request.
- **A user token with a bot fallback when not linked.** It silently changes who authored the work depending on a setting the dispatcher cannot see from the card. A refusal says what to do.

**Permissions.** Opening a pull request needs `pull_requests: write` under both branches, so the Motir Agent App needs **`contents: write` + `pull_requests: write`**. MOTIR-1894's title currently says _`Contents: write` — the ONLY permission_, and that is amended (Consequences).

**`workflows: write` is deliberately NOT requested.** A token holding it lets an autonomous agent rewrite the CI that runs with the repository's secrets. A run whose change touches `.github/workflows/` therefore fails at push. GitHub refuses it with _"refusing to allow a GitHub App to create or update workflow … without `workflows` permission"_, and that message becomes the run's failure reason.

### 5 · Timeout and stall

> **AMENDED 2026-09-27 by [MOTIR-6525](run-death-keeps-work.md) — [`run-death-keeps-work.md`](run-death-keeps-work.md) §1–§2.** A healthy run has no wall-clock limit: the 90-minute timeout below is withdrawn, struck through rather than deleted so its reasons stay readable. A hosted run's timeout is now the **12-hour backstop** (`HOSTED_AGENT_MAX_TIMEOUT_MS`), a spend backstop and not a target, and every expiry this section derived "from the timeout" now derives from it. The **15-minute stall** and the **no-heartbeat-from-the-container** rule stand, with their reasons.

- ~~**Wall-clock timeout: 90 minutes.**~~ _Withdrawn: any fixed number kills the one run that was about to finish and still says nothing about a run that died a minute in; liveness answers the question the timeout stood in for._
  - ~~The planning corpus caps a leaf's agent run at 60 minutes, and a card sized past that is split before it is dispatched.~~
  - ~~To that add clone, dependency install, codegraph index, push and pull request. This is an allowance of up to 30 minutes, not a measured figure; the dogfood story (MOTIR-714) measures real runs, and the value is revisited if they disagree.~~
  - ~~90 minutes lets a correctly sized card finish, and stops a runaway one at 1.5× its budget.~~ The seam's own ceiling, `HOSTED_AGENT_MAX_TIMEOUT_MS` (12 hours), is a spend backstop, not a target — and it is now the run's timeout. It exists so that no run, however it fails, can hold a machine indefinitely.
- **Stall window: 15 minutes with no agent output.**
  - "Output" is any line OpenCode writes to stdout or stderr, forwarded by the entrypoint as `log` events. The watchdog reads the time of the run's latest event.
  - The entrypoint sends **no heartbeat**: a heartbeat would prove the container is alive, and the watchdog exists to catch an agent that is alive and stuck.
  - 15 minutes clears the longest silent step a normal card runs, a full local test file or a cold dependency install, while ending a hung agent within a sixth of the budget.

Every credential's expiry is derived from the timeout — ~~90 minutes~~ the 12-hour backstop since 2026-09-27: the run key's `expiresAt`, the run token's `expiresAt`, and the git credential's (bounded by GitHub's own 8 hours or 1 hour). Nothing a run holds can outlive it by more than the 5-minute settle margin.

### 6 · motir-core's configuration names

| Name                        | Holds                                                                                    | Notes                                                                                                                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MOTIR_GATEWAY_URL`         | the gateway's PRIVATE origin, no trailing `/v1` (`http://motir-gateway.flycast`)         | motir-core's own calls only: mint, revoke, status. ~~the same name and meaning as the gateway's egress contract, so the container receives it verbatim~~ _(struck 2026-10-26, MOTIR-7656: no container can reach this origin — §9)_ |
| `MOTIR_GATEWAY_RUN_URL`     | the gateway's run-lane PUBLIC origin, no trailing `/v1` (`https://gateway-run.motir.co`) | handed to the container AS `MOTIR_GATEWAY_URL`, so the egress contract's name and the image are unchanged (§9). Added 2026-10-26, MOTIR-7656                                                                                        |
| `MOTIR_RUN_KEY_MINT_SECRET` | the mint secret                                                                          | the same name the gateway reads, character for character                                                                                                                                                                            |
| `MOTIR_HOSTED_AGENT_IMAGE`  | `ghcr.io/motir-co/motir-hosted-agent@sha256:…`                                           | **a digest, never a tag**, so a publish cannot change what a running deployment boots                                                                                                                                               |

_(Amended 2026-10-24, MOTIR-9420, for Story MOTIR-9359: **one `MOTIR_HOSTED_AGENT_IMAGE` serves both the Fly fleet and the AWS agent-runner fleet** — there is no second, AWS-only variable, because two that agree today drift at the next pin. An agent-runner VM boots with no instance profile and no Fly org credential, so it pulls the image anonymously, and the image must therefore stay on a public registry (public on GHCR, `fleet-image-pull.md` §1). A mirror to `registry.fly.io` or to ECR would leave agent-runner VMs unable to pull it: `hostedAgentImage('aws')` refuses either host, and the daily health check's anonymous `verifyHostedAgentImagePullable()` preflight fails loudly when the pinned digest stops being publicly pullable.)_

All of them are server-only: no public-env prefix, and never serialized to the browser. **There is no model variable:** the model is the dispatcher's choice, validated against motir-ai's list (§7). _(Re-read 2026-10-01, MOTIR-7206: still true with a second provider. The provider travels with the offered model, not in configuration.)_

### 7 · The model: the dispatcher picks it from the models that can actually run

**Why the run has a model chosen for it at all.** Something has to name one before the container boots, and it cannot be OpenCode or the container:

- OpenCode is started with `OPENCODE_DISABLE_MODELS_FETCH=true` and runs as `opencode run --model <provider/id>` (motir-gateway `docs/hosted-run-egress.md`, container environment). It has no catalog to fall back on, so a run with no model named does not start.
- The run key is minted with a `models` allow-list, and the gateway refuses any other model with `403` (egress contract §1 and its threat table, `middleware/auth.go`). That allow-list is what stops an exfiltrated key from being spent on a dearer model, so the minter must know the model **before** the container boots.
- motir-ai debits every turn at the model's effective `ModelCreditRate` in the `agent` lane, and `debitForTurn` throws when the model has none (`src/services/creditService.ts`; the comment on `PLANNER_MODELS` in `src/llm/gatewayClient.ts`). A model with no rate is a run whose first call fails.

**The decision.** The person who presses **Run hosted** chooses the model, from a list of the models that can run a hosted card, with a default already selected. The server checks the choice again when the run starts, and the run is refused before anything is opened, minted or booted when the model is not on the list.

**Reference products, checked 2026-09-26.**

- GitHub Copilot's coding agent shows a model picker at the moment a task starts: when an issue is assigned to Copilot, and in the agents panel, GitHub Mobile and Raycast. It defaults to _Auto_ (docs.github.com, _Changing the AI model for GitHub Copilot cloud agent_; changelog 2025-12-08 and 2026-02-19).
- Cursor's Cloud Agents API takes an optional model on launch, validated against the ids its `GET /v1/models` returns. With none given, it falls back to the user's default, then the team's, then the system's (cursor.com/docs/cloud-agent/api/endpoints).

Both put the choice at dispatch time and both limit it to a list the service publishes. Neither offers a free-text model id.

**The offered set** is every model that meets all three conditions:

1. **The gateway serves it.** It is in the servable set the gateway's daily catalog refresh adopts, `motir/catalog/upstream-prices.json`.
2. **Its provider is one the hosted agent is configured for.** ~~Today that is `anthropic` only. The egress contract sets OpenCode's `enabled_providers` to `["anthropic"]`, and Anthropic is in the gateway's `transfer-basis` routing group (`motir/catalog/channel-groups.sh`). A hosted run sends the customer's repository to the model, so a provider without a recorded transfer basis is never offered. That rules out DeepSeek, which `ai-upstream-transfer-basis.md` finds has no basis and whose channel sits in the `default` group only.~~ **AMENDED 2026-10-01 (MOTIR-7206):** a provider is offered when **both** records allow it — `ai-upstream-transfer-basis.md` (as amended 2026-10-01 by MOTIR-3687, which supersedes the no-basis finding and names hosted runs as a DeepSeek consumer) and the gateway's egress contract, whose OpenCode `enabled_providers` must list it. ~~Today that is **`anthropic` and `deepseek`**.~~ _(Struck 2026-10-02, MOTIR-7242.)_ **AMENDED 2026-10-02 (MOTIR-7242):** ~~today that is **`anthropic`, `deepseek`, `z-ai` (GLM, Z.ai international) and `qwen` (Qwen, Alibaba Model Studio Frankfurt)**~~ _(struck 2026-10-02, MOTIR-7350)_ — the catalog's own provider ids, which motir-ai's catalog rows already carry (`prisma/migrations/20260926132025_rate_sync_00f72c8`). **AMENDED 2026-10-02 (MOTIR-7350):** today that is **`anthropic`, `deepseek`, `z-ai` (GLM, Z.ai international), `qwen` (Qwen, Alibaba Model Studio Frankfurt) and `moonshotai` (Kimi, Moonshot AI international, `https://api.moonshot.ai`)** — `moonshotai` being the catalog's own provider id, which motir-ai's catalog rows already carry for `kimi-k2.6` and `kimi-k2.7-code` (same migration). For a provider, the transfer-basis record "allows" it once the record carries a dated disposition row for its endpoint, whatever that row's verdict (_Serving without a recorded basis_, below). A new provider is added by amending those two records first, then motir-ai's provider constant (`HOSTED_AGENT_PROVIDERS`), never the constant alone. A hosted run still sends the customer's repository to the model; what changed is the position on a provider's practices: they are disclosed, and the customer chooses (the transfer-basis amendment's OpenRouter shape).
3. **motir-ai has an effective `agent`-lane rate for it.** A model that fails this cannot be billed, so it is not shown.

_(Superseded 2026-10-04 by MOTIR-7522: motir-ai still serves which models EXIST, and motir-core now keeps the run-model list of which of them MAY be used — see the last block of §7.)_ ~~**The list is served by motir-ai, never kept in motir-core.**~~ motir-ai holds the rates, and after the rate-sync story it holds the servable set too. It answers a service-auth `GET /v1/agent-models` with the offered models and the default. motir-core reads that list to draw the picker, and again inside the start path to validate the choice.

The planning picker is the counter-example. It is fed by a copy in motir-core (`lib/projectAiSettings/plannerModels.ts`, `PLANNER_MODEL_IDS`) that still lists DeepSeek while motir-ai's planner default has moved to `claude-opus-4-8`. A second copy for hosted runs would go stale the same way.

**Rates follow the catalog.** A model can appear in the catalog before anyone has priced it; today `claude-opus-5-5`, `claude-opus-5` and `claude-sonnet-5` are served but unrated. So condition 3 needs rates to be created when the catalog adopts a model or moves a price, not when somebody remembers to write a migration. That is a new story under AI economics (MOTIR-4329). When the gateway's `upstream-prices.json` changes on `main`, motir-ai generates a proposal (a pull request a person merges, like the gateway's own refresh) that does two things:

- adds the rate generations for every new or re-priced servable model, in **both lanes**, by the derivation `credit-model.md` §2a and `prompt-cache-pricing.md` §2 already fix;
- records the servable set with each model's provider.

Until that story lands, the offered set is the Anthropic models already rated and served: `claude-fable-5`, `claude-opus-4-8` and `claude-sonnet-4-6`.

**The default** is a motir-ai constant, `HOSTED_AGENT_MODELS.default`, in the shape of `PLANNER_MODELS`. It starts as `claude-opus-5-5`: the newest Opus the gateway serves, and cheaper per token than Opus 4.8 ($4 / $20 against $5 / $25 per million tokens in the catalog). If the default is not in the offered set, for example because it is not yet rated, the list returns no default and the picker selects the first model offered. The dogfood story (MOTIR-714) measures real runs, and the default is revisited if they disagree.

**What each state does:**

| State                                                    | What happens                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the list loads                                           | the picker shows the offered models with the default selected                                                                                                |
| the list is empty, or motir-ai cannot be reached         | **Run hosted** is disabled and says why. Nothing is started                                                                                                  |
| the chosen model has left the list since the page loaded | the start path refuses with `hosted_model_not_offered` before the run is opened, and the panel asks the person to choose again                               |
| the run starts                                           | `DispatchRun.model` records the choice, the card's `implementationModel` is stamped with it, and the run key is minted with that one model as its allow-list |

> **§7 · POINTER (MOTIR-6815, 2026-09-29).** A review run has no dispatcher to choose, so it takes the list's **default**, and the first offered model when the list names none. An empty or unreachable list is a review that could not run, reason _no model_ (§8.1).

**One id, two spellings, never mixed.** The list, `DispatchRun.model`, `implementationModel` and the key's `models` allow-list all hold the gateway's **bare** id (`claude-opus-5-5`), because the gateway compares the request's bare id against the allow-list. ~~The start path adds the `anthropic/` prefix only for OpenCode's `--model` flag.~~ _(Struck 2026-10-01, MOTIR-7206.)_ **The start path builds OpenCode's `--model` as `<provider>/<bare id>`, taking `<provider>` from the offered model's own `provider` field** (`anthropic/claude-opus-5-5`, `deepseek/deepseek-v4-pro`), never from a fixed prefix. Putting the prefixed form on the allow-list would get every call refused with `403`.

**AMENDED 2026-10-01 (MOTIR-7206) — how each provider reaches the gateway, and who picks it.**

- **Anthropic** calls go through `POST /v1/messages`, which keeps prompt caching (`cache_control`) intact. **DeepSeek** calls go through the OpenAI-shaped `POST /v1/chat/completions` on the same run key, because `/v1/messages` relays to Anthropic channels only (egress contract §3, item 6). DeepSeek's automatic cache is metered from its own `prompt_cache_hit_tokens` (motir-gateway `relay/controller/motir_credit_sync.go`). Both are billed to the run's organisation at the `agent` lane.
- **A hosted run carries no `X-Motir-Data-Policy` header.** There is no per-workspace policy to carry, because MOTIR-3665 retired it, so the run takes the gateway's default (unconstrained), and the person's choice of model is the control.
- **Motir's platform default stays Claude at every difficulty level** (`HOSTED_AGENT_MODELS.default` and the per-difficulty defaults, MOTIR-6989). **A project may make DeepSeek its own default for a level** through MOTIR-6989's per-project override, which accepts any offered model, and _Run hosted_ then preselects it. That choice is the customer's: Motir serves customers globally, and it does not impose its strictest customer's provider policy on everyone (the MOTIR-3687 decision gate, 2026-10-01).

**AMENDED 2026-10-02 (MOTIR-7242) — GLM and Qwen, and the four routes.**

| Provider (`provider` id)                                          | Upstream endpoint                                                      | Gateway route on the run key                                 | OpenCode `--model` (example) |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------- |
| `anthropic`                                                       | Anthropic                                                              | `POST /v1/messages`, prompt caching (`cache_control`) intact | `anthropic/claude-opus-5-5`  |
| `deepseek`                                                        | DeepSeek                                                               | `POST /v1/chat/completions`                                  | `deepseek/deepseek-v4-pro`   |
| `z-ai` (GLM, Zhipu)                                               | Z.ai's international API, `https://api.z.ai`                           | `POST /v1/chat/completions`                                  | `z-ai/glm-4.6`               |
| `qwen` (Alibaba)                                                  | Alibaba Cloud Model Studio, the **configured Frankfurt workspace URL** | `POST /v1/chat/completions`                                  | `qwen/qwen-plus`             |
| `moonshotai` (Kimi, Moonshot AI) — _added 2026-10-02, MOTIR-7350_ | Moonshot AI's international API, `https://api.moonshot.ai`             | `POST /v1/chat/completions`                                  | `moonshotai/kimi-k2.6`       |

- **Never a mainland endpoint.** GLM is never reached at `open.bigmodel.cn` and Qwen never at `dashscope.aliyuncs.com`: both mainland platforms need a PRC-registered company, which moooon B.V. is not (MOTIR-6258). The Frankfurt URL is configuration, not a constant, because Model Studio issues it per workspace.
- **All four are billed to the run's organisation at the `agent` lane**, from the rates motir-ai already holds for every `z-ai` and `qwen` model in the catalog.
- **Motir's own defaults never resolve to GLM or Qwen.** Claude stays `HOSTED_AGENT_MODELS.default` and every per-difficulty default; a person picks GLM or Qwen in _Run hosted_, exactly as for DeepSeek above.

**AMENDED 2026-10-02 (MOTIR-7350) — Kimi, the fifth route.**

- **Kimi is reached only at Moonshot AI's international API, `https://api.moonshot.ai`**, on `POST /v1/chat/completions` with the run key, the way DeepSeek, GLM and Qwen are. It is **never** reached at the mainland `api.moonshot.cn`: that platform needs a company registered in mainland China, which moooon B.V. is not (MOTIR-6258). The gateway already lists Moonshot's models from `.ai` (motir-gateway `motir/catalog/providers/providers.go`, `DefaultBaseURL`); moving the channel itself there is MOTIR-7362.
- **Kimi is billed to the run's organisation at the `agent` lane**, from the rates motir-ai already holds for the `moonshotai` models in the catalog, like the other four.
- **Motir's own defaults never resolve to Kimi.** Claude stays `HOSTED_AGENT_MODELS.default` and every per-difficulty default; a person picks Kimi in _Run hosted_, exactly as for DeepSeek, GLM and Qwen.

**Serving without a recorded basis.** A provider is **served** once the gateway has a channel and a key for it: its channel is enabled in the `default` group whether or not a transfer basis is recorded. The recorded basis (`ai-upstream-transfer-basis.md`'s per-vendor row, mirrored in motir-gateway `motir/residency/residency.go`) decides only two things: whether the channel **also** joins the `transfer-basis` group, and what the published subprocessor pages say about the provider. A caller that needs a basis selects that policy per request through the gateway. This is how DeepSeek is already served, and the position MOTIR-3665 took when it retired the per-workspace data policy: a provider's practices are disclosed where the model is chosen, the policy filter stays in the gateway, and the customer chooses. It replaces, for `z-ai` and `qwen`, MOTIR-4332's earlier rule that a channel whose basis cannot be established is seeded disabled (`status=2`). **AMENDED 2026-10-02 (MOTIR-7350):** the same holds for `moonshotai` beside `z-ai` and `qwen`. Kimi is served once the gateway has a Moonshot channel at `https://api.moonshot.ai` and a key for it; its recorded basis decides only whether that channel also joins `transfer-basis` and what the public pages disclose (MOTIR-3665).

**AMENDED 2026-10-04 (MOTIR-7522) — the run-model list.**

- **motir-ai owns WHICH MODELS EXIST for hosted runs**: servable, chat-capable, rated in the `agent` lane — the three conditions above, answered by `GET /v1/agent-models`.
- **motir-core owns WHICH OF THOSE MAY BE USED**: the **run-model list**, one platform-wide set of bare model ids stored in motir-core, edited only by a platform superadmin in the operator console, every change audited in `PlatformAuditLog` with the reason the console already asks for on staff writes.
- **The offer is the INTERSECTION, read fresh every time**: a model is offered when it is on the list AND in motir-ai's live answer. The Run hosted picker, the project's per-difficulty settings and the start path's check (`assertOffered`) all read that one intersection, uncached, so a model motir-ai withdraws disappears at once and an unlisted model never appears. A project keeps choosing per difficulty from the offer (MOTIR-6993); its override and Motir's platform per-difficulty default are now valid only while the model is on the list as well.
- **The list is seeded with motir-ai's offer at the moment it is first read after deploy**, so no project loses the model it has selected. **A model a project override or the platform per-difficulty default uses cannot be removed from the list**; the refusal names the projects and levels.

**Why this is not the copy this section forbade.** The rejected copy was a list of FACTS about models — that they exist, are served, are priced — kept in a second place, which goes stale the moment the first place changes: the planner picker's `PLANNER_MODEL_IDS` still offered DeepSeek after motir-ai had moved on. The run list records none of those facts. It holds one thing motir-ai cannot know: which models a person at Motir has decided customers may run on. Every question of existence, price and reachability is still asked of motir-ai on every read, and the intersection means the list can only ever NARROW that answer, never widen or outlive it. A listed model motir-ai drops is simply not offered; nothing here can make it come back.

**Rejected.**

- **motir-ai's offer alone** (this section until now). Every model the catalog prices becomes runnable the day it is priced, including ones nobody has evaluated for coding, with no record of who allowed it and no way to hold one back short of a code change.
- **A list per organization or project.** Still not decided (below); the run list is platform-wide.
- **Keeping the list in motir-ai beside its offer.** The list is a decision about what Motir's product lets customers run, which is motir-core's console and audit log; motir-ai stays the authority on what can run at all.

**Rejected.**

- **One model per deployment, set by configuration.** This was the first version of this section. It hides from the dispatcher a choice that decides what the run costs and how capable it is, and both reference products put that choice at dispatch. The configuration name `MOTIR_HOSTED_AGENT_MODEL` goes with it (§6).
- **The whole gateway catalog.** It lists 63 models across six providers. Some cannot be billed, and OpenCode is not configured for most of their providers. ~~and DeepSeek has no transfer basis for customer code~~ _(Struck 2026-10-01, MOTIR-7206: superseded by `ai-upstream-transfer-basis.md`'s 2026-10-01 amendment; DeepSeek is offered through condition 2.)_
- ~~**A list kept in motir-core.** This is the planning picker's defect, described above.~~ _(Superseded 2026-10-04, MOTIR-7522: a list of facts kept in motir-core is still rejected; a curated SELECTION intersected live is not that list — see the last block of §7.)_
- **A list per organization or project.** It needs a settings surface and a rule for what a narrower list may refuse. Neither is in Story 9.1 (below).

### 8 · The REVIEW run — AMENDED 2026-09-29 (MOTIR-6815, for Story MOTIR-1626 · 9.8)

A card's delivery set has gone green in a project with the review agent on, and [`approval-gates.md`](approval-gates.md) §12 has raised an `agent_review` gate. This section decides the hosted run that answers it. Everything in §1–§7 applies unless a point below says otherwise.

#### 8.1 · What starts, and as whom

- **One review run per awaiting `agent_review` gate**, started by the server from the gate's raise (the `agent-review/requested` job, MOTIR-6820), and again only on _Review again_. Nothing else starts one, and nothing retries one.
- It is a `DispatchRun` with **`command: review`** (a new `DispatchCommand` member), **`origin: hosted`**, and **`MOTIR_RUN_MODE=review`** in the container. The launcher's `run` / `continue` seam (`packages/cli/sandbox/hosted/entrypoint.ts`, MOTIR-6527) gains that third mode, and the container runs `motir review <KEY>` (MOTIR-6824).
- **It makes NO to-do claim.** The card is already in the review band, and a review changes nobody's claim on it. The run is not a claim either: the gate it answers is the one-review-at-a-time lock.
- **Every Run-hosted pre-flight still applies**: the fleet slot, the organisation's agent credits, the offered model (§7, taking the default), and a credential for every delivery-set repository (§4). A refusal before anything boots opens no container and is written onto the gate as the reason the review could not run.
- **Attributed to the card's assignee, else its reporter, else the workspace's stand-in manager** — the actor the CI-feedback path already writes as when no person pressed anything. `DispatchRun.dispatcherId`, the run token's owner and the verdict's `decidedById` are that user. The authority column, not the user, says a machine decided (`approval-gates.md` §12.3).
- **Billed to the organisation at the agent-lane rate**, exactly as any hosted run: the same run key, the same meter by `DispatchRun.id` (§1). A review is paid work, which is why the switch defaults off.

#### 8.2 · What it reads

- **Both bodies of the card** (description and explanation), its **acceptance criteria**, its published **How to test**, and **every pull request of the delivery set at the reviewed head** — the `subjectVersion` the gate names, never a head read later. A card with pull requests in two repositories is ONE review over both.
- **The coding convention for each repository, when there is one** — §8.5.
- It reads them from a **server-assembled review prompt** (MOTIR-6821), served to the run through its token. The run does not assemble its own brief, for the same reason a build run does not: the prompt is the same text for every agent by design.

#### 8.3 · What it never writes

- **It pushes nothing.** The pull requests are checked out read-only at their reviewed heads, and the launcher never pushes in this mode. On a Motir-created repository the §4 installation token is requested with **`contents: read`** only. On a user's repository the §4 user token cannot be narrowed by permission, so the launcher's no-push rule is the guard there.
- **It posts nothing to GitHub** — no review, no comment, no check. [MOTIR-4910](motir:cmtt4ogrf000hhutxyjqeaxeq)'s one-directional rule stands: the agent's review lives in Motir only.
- **It writes no card status on any end** (§2's pointer). A review that finds problems is To fix by the gate's derivation, never by a status write.

#### 8.4 · How the verdict reaches Motir

- **A run-token REST route, `POST /api/v1/work-items/{key}/agent-review`** (MOTIR-6821), because a run token cannot use the MCP (`lib/mcp/auth.ts`, the `dispatchRunId` arm).
- The body is **`pass`** or **`changes_requested`** with **findings in Markdown** (required and non-empty for `changes_requested`), and the version the run reviewed.
- **ONE verdict per run.** The first accepted verdict ends the question; a second is refused.
- **A verdict for a superseded gate** — the head moved mid-review — decides nothing (`approval-gates.md` §12.5). It is recorded on the run while the run is alive; a run the supersede already cancelled has lost its token, so its late verdict is refused at authentication and the cancelled close is the record.
- The run then closes `succeeded`. **A run that ends without an accepted verdict** — failed, stalled, backstopped, cancelled, or exited without submitting — is written onto the gate as a review that could not run (`approval-gates.md` §12.6).

#### 8.5 · The coding convention is OPTIONAL input

- **For each delivery-set repository, the review prompt carries the derived convention Motir holds for it, when there is one** — motir-ai's `getConvention` (`lib/ai/motirAiClient.ts`), keyed `owner/name`, the convention Code Health shows. The reviewer checks the CHANGED code against it, and a finding that relies on it quotes the rule it breaks. It is read server-side over the service credential while the prompt is assembled, never through the `/code` page's admin-gated read (`aiConventionService`), which a review has no admin to satisfy.
- **Three absent cases, and none of them stops the review:**
  1. **there is no convention** for the repository;
  2. **motir-ai is not configured** on this deployment;
  3. **motir-ai errors or times out** when asked.

  In each, that repository is **reviewed against the card alone**. **None of the three is a review that could not run** (`approval-gates.md` §12.6): it raises no gate reason and holds nothing, and **a missing convention is never grounds for `changes_requested`**. It is the same tolerance `/code` already has (`readRepoConvention`, `app/(authed)/code/_health.ts`, which turns a `MotirAiError` into "no convention").

- **A repository's own `CLAUDE.md` / `AGENTS.md`** is read as the same kind of standard only when the checkout has one. It is never required.
- **Where a card's criteria explicitly require what a convention forbids, the card wins.** The convention says how code is usually written here; the card says what this change must do.
- A convention is capped to a bounded size in the prompt (MOTIR-6904 sets the cap), so one repository's long convention cannot crowd out the card.

#### 8.6 · The hosted REPAIR run — _Fix on the hosted agent_ (the requester, 2026-09-29; `approval-gates.md` §12.4b)

A card a review sent back — To fix `changes_requested` — can be repaired on the hosted agent. It is `motir fix` in a container, and every rule of a local `motir fix` holds.

- **Started by a person's press**, never by the refusal and never retried. The press is offered to whoever may press **Run hosted** on the card, and passes the same pre-flights (fleet slot, agent credits, the model — the pressing person picks it, as in §7 — and a credential per repository).
- **It is the server's REPAIR claim**, exactly as `motir fix` takes it: a `DispatchRun` with **`command: fix`**, **`origin: hosted`**, opened by the claim, and the open run IS the one-repair-at-a-time lock. A repair already open on the card — local or hosted — refuses the press and names who holds it. **No to-do claim and no status write**, as for a local repair.
- **`MOTIR_RUN_MODE=fix`** — the launcher's third mode beside `run` / `continue`, alongside `review` (§8.1). The container ADOPTS the run the claim opened, checks out **each pull request's own branch**, and runs `motir fix <KEY>` with the review's findings in its prompt.
- **It pushes to those branches, and opens nothing.** Unlike §8.3's review, a repair must write: its credential is §4's, with `contents: write` on each repository of the delivery set. It opens no pull request, merges nothing, and posts nothing to GitHub.
- **Attributed to the person who pressed**, billed to the organisation at the agent-lane rate, and identified by `DispatchRun.id` as every hosted run (§1).
- **Its ends are §2's**, with one difference: no end moves the card. A push moves the head, which retires the review's version, and CI's next green is reviewed again. A repair that ends without pushing leaves the card To fix.

### 9 · The gateway origin a hosted-run container dials — AMENDED 2026-10-26 (MOTIR-7656, for Story MOTIR-714 · 9.4)

**The problem.** §6 handed the container the same `MOTIR_GATEWAY_URL` motir-core uses. Since MOTIR-3333 the gateway has no public address: it answers only over Flycast, which is org-scoped to `moooon`. Hosted runs boot elsewhere — on Fly machines in the `motir-fleet` org ([`application-hosting.md`](application-hosting.md), the fleet org) and on AWS agent-runner VMs in us-east-1 (MOTIR-9359), whose shard network (`packages/orchestrator/src/adapters/aws/network.ts`) has public IPv4 egress, no inbound, no NAT and no VPC endpoint. Neither can resolve `motir-gateway.flycast`. Measured 2026-10-26 on a probe VM on a shard-shaped network in `ci-aws-use1-01`: `getent hosts motir-gateway.flycast` exits 2 while `ghcr.io` resolves (evidence on MOTIR-7656). It is MOTIR-4518's mistake again, for the gateway.

**Decision: two origins, one per network.**

| Caller                                                                                                     | Origin                                                                                     | Why it is reachable from there                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| motir-core's server — mint, revoke (`lib/gateway/runKeyClient.ts`), status (`lib/gateway/statusClient.ts`) | `MOTIR_GATEWAY_URL` = `http://motir-gateway.flycast`                                       | motir-core and the gateway are both in `moooon`, so Flycast resolves      |
| motir-ai → gateway                                                                                         | `http://motir-gateway.flycast` (unchanged)                                                 | same org; MOTIR-3333's seam is not touched                                |
| a hosted-run container, on the Fly `motir-fleet` org OR an AWS agent-runner VM                             | `MOTIR_GATEWAY_RUN_URL` = `https://gateway-run.motir.co`, handed in as `MOTIR_GATEWAY_URL` | public DNS and HTTPS; both fleets have outbound internet and nothing else |

**The run-lane edge.** `gateway-run.motir.co` is a SEPARATE Fly app in `moooon`, in front of the gateway — not a public address on the gateway itself:

- The gateway app keeps no public IP and keeps `force_https = false`. Its `fly.toml` explains why a public IP there would break the Flycast seam; the edge never touches that.
- The edge forwards ONLY `/v1/...` (the model routes) and `/api/status`, to `http://motir-gateway.flycast`. The run-key mint, revoke and token API, the admin UI and every operator route are **not routed** at all.
- TLS only, with HSTS. Per-key and per-IP rate limits. No response buffering, and idle timeouts above a model's longest streaming pause. No retries of model calls.
- The gateway accepts only run keys on this lane. A run key is revoked at run end (§2) and carries a hard TTL as backstop.
- It is stateless, so it scales by machine count behind its anycast IPs. The starting targets: 2 always-on machines in `iad` plus stopped standbys, which Fly's proxy starts past a per-machine connection soft limit. These are targets, not measurements; revisit after MOTIR-6799's first runs.
- **The hostname is Motir's, not `*.fly.dev`**, so the edge or the gateway can later move host or cloud by changing a DNS record, with nothing in motir-core, the egress contract or the image changing.

**The container keeps the name `MOTIR_GATEWAY_URL`.** `hostedRunKeyService` fills the container's `MOTIR_GATEWAY_URL` from `MOTIR_GATEWAY_RUN_URL`. The egress contract's OpenCode config (`{env:MOTIR_GATEWAY_URL}/v1`) and the pinned image do not change; only the value the container receives does. motir-gateway `docs/hosted-run-egress.md` §2 is amended to name `https://gateway-run.motir.co` as the origin a container is given.

**Rejected:**

- **Fly cross-org private networking, or moving the fleet into `moooon`.** An AWS agent-runner VM has no Fly 6PN, so it leaves every AWS hosted run with no address. Moving the fleet into `moooon` would also undo the isolation of untrusted run containers from Motir's own apps.
- **An AWS→Fly tunnel** (WireGuard peers into `moooon`'s 6PN, or a relay per AWS account). It needs per-account or per-VM network material and a separate cross-org answer for `motir-fleet`. It puts untrusted containers on, or one hop from, a private network where motir-core and motir-ai also live. And it gives motir.site apps (MOTIR-8342) no path.
- **A public IP on the gateway app itself.** `force_https` is one setting for the whole `http_service`, so it would have to go back to `true`, which breaks Flycast for motir-ai and motir-core.
- **AWS PrivateLink to a gateway on AWS.** It would mean moving the gateway off Fly, plus an interface endpoint in every shard VPC. `ensureAwsShardNetwork` deliberately has none, and the Fly fleet would still need a public path. The Motir-owned hostname keeps this open later without deciding it now.

**What it accepts.** A run-key-gated model route is reachable from the internet. The guard is the run key (short-lived, per run, revoked at run end, lane-bound) together with the edge's route allowlist and rate limits — the same zero-trust pattern by which sandboxed agents reach a provider's public API.

## Consequences

- **Every consumer builds against one id and one vocabulary**, and the story's contract guards (no hosted-only status or event, no cost column on `DispatchRun`) are checkable against this document.
- **A dispatcher who has not linked GitHub cannot run hosted on their own repository** until they do. That is a real setup step, and it is the price of the pull request being theirs.
- **Owed on acceptance of this decision** (its close-out, filed as work, not done here):
  1. **Amend MOTIR-1894**: the Motir Agent App requests `contents: write` + `pull_requests: write`, never `workflows: write`, and enables user authorization ("Request user authorization (OAuth) during installation" plus expiring user tokens). Its title's "the ONLY permission" becomes false.
  2. **A "Link your GitHub account" surface**: a `design` card and a `code` card under 9.1. It covers where a person authorizes the Motir Agent App for their user and where the run's refusal sends them. MOTIR-6449 (the git credential) reads the stored authorization; it does not build the surface.
  3. **MOTIR-6449's criteria are amended** to the split above: a user token narrowed by `repository_id` for a user-owned repository, and a narrowed installation token for a Motir-created one.
  4. **The model choice (§7)**, proposed in the same re-plan as this revision:
     - MOTIR-684, MOTIR-689, MOTIR-690, MOTIR-691, MOTIR-692, MOTIR-6451 and MOTIR-6452 carry the picker, the validation and the minted allow-list;
     - MOTIR-6453 drops `MOTIR_HOSTED_AGENT_MODEL`;
     - a new motir-ai card serves `GET /v1/agent-models`;
     - a new story under MOTIR-4329 makes rates follow the catalog.

---

## What this does NOT decide

- **The orchestrator, the fleet, the machine size or its price.** These are MOTIR-1918 and MOTIR-4336, plus AI economics.
- **The gateway's contract, or how usage is billed.** These are Story 9.0 and `docs/hosted-run-egress.md`.
- **Several hosted runs at once, a queue, or choosing among agents.** These are out of Story 9.1.
- **A model list per organization or project**, ~~or a provider other than Anthropic for hosted runs~~. §7 offers one list, the same for everyone, drawn from the providers the egress contract configures. _(Struck 2026-10-01, MOTIR-7206: a second provider IS decided now — see §7 condition 2 and **One id, two spellings**.)_
- **Whether DeepSeek is switched on in production.** §7 says a hosted run MAY be served by DeepSeek. Pinning the rebuilt image, motir-ai adding `deepseek` to its provider list and the first real run are the post-merge tasks MOTIR-7212, MOTIR-7213 and MOTIR-7214.
- **~~GLM, Qwen or~~ ~~Kimi on hosted runs.~~** ~~Each~~ ~~It needs the same two records amended first~~ ~~(MOTIR-4332)~~. _(Struck 2026-10-02, MOTIR-7242: GLM and Qwen ARE decided now — see §7 condition 2 and **Serving without a recorded basis**.)_ _(Struck 2026-10-02, MOTIR-7350: Kimi IS decided now — see §7 condition 2, **Kimi, the fifth route** and **Serving without a recorded basis**.)_
- **Whether GLM and Qwen are switched on in production.** §7 says a hosted run MAY be served by them. Enabling both channels on the running gateway, pinning the rebuilt image, motir-ai adding `z-ai` and `qwen` to its provider list and the first real run on each are MOTIR-7201, MOTIR-7247, MOTIR-7248 and MOTIR-7249.
- **Whether Kimi is switched on in production.** §7 says a hosted run MAY be served by Kimi. Re-pointing and enabling the running Moonshot channel, pinning the rebuilt image, motir-ai adding `moonshotai` to its provider list and the first real run are the post-merge tasks MOTIR-7352, MOTIR-7353, MOTIR-7354 and MOTIR-7355. Moonshot international's transfer-basis verdict is MOTIR-7356's reading and MOTIR-7359's row.
- **Each provider's transfer-basis verdict.** Whether Z.ai international or Alibaba Frankfurt has a recorded basis is MOTIR-7192's reading and MOTIR-7195's rows; §7 decides only what that verdict does and does not change.
- **A data policy carried by a hosted run.** Today it carries none; adding one is a later decision.
- **How rates are generated from the catalog.** §7 depends on it; the rate-sync story under AI economics (MOTIR-4329) decides and builds it.
- **Network-level egress enforcement.** The lock is the credential (egress contract §4).
- **The tenant-app lane on the run-lane edge.** §9's edge is built so MOTIR-8342 can add its own route list and key lane for motir.site apps; which routes and keys, and on which hostname, is MOTIR-8342's.
- **Whether Motir consolidates its hosting on one cloud.** §9's Motir-owned hostname keeps that open; it is not decided here.
- **What a _local_ run's card becomes on failure.** Only hosted runs are decided here.
- **How a hosted run is re-run automatically after a design is sent back.** That is Story 9.2, which calls the start path this document's §1–§3 describe.
- **What a review DECIDES, or what its verdict does to the card.** That is [`approval-gates.md`](approval-gates.md) §12; §8 decides only the run that produces the verdict.
- **Any AUTOMATIC re-run after a review.** A review never starts a run; §8.6's hosted repair starts only on a person's press. ~~A hosted `motir fix` … is its own ask~~ — reversed by the requester for a card a review sent back (§8.6).
- **A hosted repair for the other To-fix reasons** (a red build, a merge-queue failure). §8.6 covers a card a REVIEW sent back.
- **How a coding convention is derived.** That is the `/code` surface's; §8.5 only reads what it has derived.
- **Whether Motir-created repositories ever move to user-authored pull requests.** That belongs to repository handover (MOTIR-711), not here.
