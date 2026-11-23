# Indexing the code graph on the container fleet

**Status:** accepted · **Date:** 2026-08-03 · **Card:** MOTIR-1987 (Story MOTIR-1981 — index
the code graph on the fleet orchestrator) · **Implemented by:** MOTIR-1986, MOTIR-1988,
MOTIR-1989, MOTIR-1990, MOTIR-1995 · **Evidence pinned at:** `motir-core` `origin/main` @
`7df65d66` · `motir-ai` `origin/main` @ `a4bc960`

`docs/decisions/ci-runner-fleet.md` decided that Motir runs its own container fleet and what
isolates the containers on it. This record decides the **second workload** to land on that
fleet — the **code-graph index** — and, in doing so, generalizes two of that document's
arguments from "CI runners" to "every container Motir boots."

This is a `decision` card: **it fixes shapes and ships no behaviour.** Per `notes.html` #50 —
_a decision card is not an implementation_ — **nothing described here is a precondition any
sibling card may assume is present.** §12 names which card wires each part.

---

## §0 — What this record is, and the one rule for reading it

Nine decisions, all settled at plan time on MOTIR-1981 (2026-08-02) with their evidence. This
document is their durable home, because a work-item description is not where an architecture
lives: sibling cards cite this by path instead of each carrying the argument in its own body.
It **records** those decisions. It does not re-open them.

**A TENTH decision was added later — §14, offboarding (MOTIR-2162, 2026-08-05).** It is not one
of the nine and does not pretend to be: it answers a question §11 left open, on evidence read two
days after the nine were settled, and it carries its own dated evidence block rather than being
retrofitted into §13. **Section numbers are append-only in this file** — §11, §12 and §13 are
cited by cards, by `notes.html` #223 and by comments in both repos, so a later decision is
appended rather than slotted into the numeric run.

**It records the REJECTED alternatives with equal weight, and that is the point.** Three of
the nine were **proposed, pinned, and then reversed** during a single day's planning. An
argument that was strong enough to win once is strong enough to be re-proposed by the next
reader, and a record that lists only winners cannot tell that reader whether their idea was
rejected or simply never considered. §3.1, §5.1 and §8.1 are those three.

**Two corrections to the source card's own rationale are recorded inline**, because verifying
the evidence is what an ADR is for and the alternative is a document that reads as settled
while resting on a false premise:

- **§7.2** — the card justified the shared spend exposure as "one org means one provider spend
  cap … the provider cap is a backstop." **There is no provider spend cap.** Fly offers
  neither a cap nor a billing alert (`ci-runner-fleet.md` §9), and MOTIR-1997 has already
  shipped the product-side ceiling that actually holds the invoice.
- **§8.3** — the card rejected production-placement partly because the per-workspace admission
  cap "bounds `moooon` like any tenant." The **shipped** per-tenant CI cap **exempts** the meta
  org (`PROJECT_IN_FLIGHT_CAPS.meta = null`). MOTIR-1990 must not copy that exemption, or the
  rejection loses its support.

Neither changes a decision. Both change what the decision is allowed to claim.

## §1 — The nine decisions, in one table

| #   | Decision                                                                                                                       | Where                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| 1   | Indexing runs in a **container on the `ContainerOrchestrator` port**, not a Vercel function                                    | [§2](#2--decision-1)                 |
| 2   | Containers run in the **shared `motir-fleet` org** — not production, not a per-workload org                                    | [§3](#3--decision-2)                 |
| 3   | Isolation comes from **credential scope**, not org count                                                                       | [§4](#4--decision-3)                 |
| 4   | The **container builds** the graph; motir-ai is **control plane only**                                                         | [§5](#5--decision-4)                 |
| 5   | **One container per REPO**, forced by the shipped ledger contract                                                              | [§6](#6--decision-5)                 |
| 6   | The concurrency cap lives in the **orchestrator's admission control**                                                          | [§7](#7--decision-6)                 |
| 7   | The **META org runs indexing on the fleet**, exactly like a customer                                                           | [§8](#8--decision-7)                 |
| 8   | `isMeta` bypasses the **CHARGE** — not the placement and **not the meter**                                                     | [§9](#9--decision-8)                 |
| 9   | The container holds **no GitHub credential**                                                                                   | [§10](#10--decision-9)               |
| 10  | A graph is derived customer data with a **defined retention window** — offboarding removes all three artifacts, snapshot first | [§14](#14--decision-10--offboarding) |

§11 records what this deliberately does **not** change. §12 binds it to MOTIR-1981's cards.
**Decision 10 (§14) was added 2026-08-05** by MOTIR-2162 and is not part of the original nine —
see §0.

## §2 — Decision 1

**Indexing runs in a container on the `ContainerOrchestrator` port, not in a Vercel function.**

The old path is `system.code-graph-index`: fetch a whole repo tarball into the function's heap
(`fetchRepoTarball` → `res.arrayBuffer()`, `lib/git/providers/github.ts:147`), POST those bytes
to motir-ai, and have motir-ai parse them inside that one synchronous request.

**Every failure of that path descends from one shape** — a whole-repo fetch and a synchronous
build inside a memory- and time-bounded function. Measured, not characterised:

| symptom                                                             | evidence                                                                                                                                                                                                                       | why a container removes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OOM on a large repo**                                             | `instance was killed because it ran out of available memory` — `motir-core`, **5/5 attempts**, 2026-08-02 (logged as MOTIR-1976, archived when this story superseded the patch)                                                | the fetch happens in a container sized for it                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **180 s motir-ai deadline**                                         | the upload call's own client deadline, `180_000` ms in `lib/ai/motirAiClient.ts` (deleted with the call in MOTIR-2138); **3 repos dead-lettered** on `MotirAiUnavailableError … within 180000ms`                               | the expensive parse leaves the synchronous call                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **`maxDuration = 300`**                                             | `app/api/inngest/route.ts:38`; MOTIR-1974's checkpointing exists only to fit under it. **⚠️ SEE §7.5 — this ceiling has since gone with Vercel itself, and the checkpointing it justified is gone with it (MOTIR-3484)**       | the work is not on Vercel                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **200 MB ingress ceiling**                                          | `CODE_GRAPH_MAX_BODY_BYTES`, `motir-ai/src/app.ts` — recorded in `docs/decisions/code-access-for-planning.md:51`. Never reached, but structurally next                                                                         | the upload becomes an ~8–80 MB graph, not a ~350 MB tarball                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **tarball re-fetched PER PROJECT** — ⚠️ **SUPERSEDED (MOTIR-2029)** | bytes cannot cross an Inngest step boundary — the MOTIR-1974 note, in `lib/jobs/codeGraphSteps.ts` until MOTIR-2057 deleted it                                                                                                 | ~~one container fetches once and builds once~~ **IT DOES NOT.** A container is project-scoped by construction (one `MOTIR_INDEX_RUN_CREDENTIAL`, bound to one `aiProjectId`), so the fan-out boots one per (repo × project) and the re-fetch SURVIVES the move — it only leaves Vercel, and it now costs billed compute per project. §6's one-container-per-REPO argument is untouched; this row was the orthogonal ×N over PROJECTS, which was never sized. See `code-graph-index-fan-out.md`. |
| **motir-ai is the throughput ceiling**                              | `indexParseGate = new Semaphore(1)` (`motir-ai/src/codegraph/indexConcurrency.ts:102`); ~**924 MB** peak RSS per index (MOTIR-1515); `fly.toml` scales on `soft_limit = 20` **requests**, which long index requests never trip | the build leaves motir-ai; capacity becomes container count                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The port already exists and already has a consumer: `ContainerOrchestrator`
(`lib/orchestrator/types.ts:155`) with `provision` / `teardown` / `describe`, the Fly adapter,
and a `fake` adapter for tests. Indexing is its **second** consumer; Epic 9's hosted agents are
the third.

**Why this is not a fourth patch to the old path.** MOTIR-1974, MOTIR-1976 and MOTIR-1977 are
three consecutive cards on one code path, and MOTIR-1983 logs the planning bug that no gate
asked whether the **shape** was wrong. This is that question answered: the shape was wrong.

## §3 — Decision 2

**Containers run in the SHARED fleet org, `motir-fleet`** — alongside CI runners and Epic 9's
hosted agents. **Not** the production org (`motir-ai` / `motir-gateway`), and **not** a
per-workload org. The org was stood up and wired by MOTIR-1979; its slug is immutable, which
is why the rename happened before anything else consumed it.

### §3.1 — REJECTED: a dedicated `motir-index-fleet` org

**Proposed, pinned, and then reversed on 2026-08-02.** The argument was structural and not
obviously wrong: Fly's 6PN private network is **organization-scoped and on by default**
(`lib/orchestrator/adapters/fly/flyMachines.ts:21-25`), so an index container holding a repo
credential would share a network with CI containers that execute customer-authored code.

**It was rejected as inconsistent with the shipped model**, on two counts:

1. `motir-ci-fleet` (as it then was) **already** places tenant A's runner beside tenant B's on
   one 6PN. A third org would harden index-vs-CI adjacency while leaving tenant-vs-tenant
   adjacency — the larger surface — exactly as it was.
2. `ci-runner-fleet.md` §7.5 argues only against sharing a 6PN with **production**: _"customer
   code, inside Motir's own production network, by default."_ It does not argue for one org per
   workload, and reading it that way over-extends it.

**Recorded because the intuition will recur.** "An index container next to a CI container feels
unsafe" is a reasonable first reaction, and it costs a Fly org, a payment method, a token, a set
of env vars and a provisioning card (MOTIR-1984, archived) every time someone has it. §4 is the
answer to it.

### §3.2 — THE COROLLARY NOBODY WROTE DOWN: the container is in a DIFFERENT org from motir-core, so it needs a DIFFERENT motir-ai ADDRESS

**Appended 2026-09-04 (MOTIR-4518), after two weeks of it being false in production.**

§3 says the container runs in `motir-fleet`. §3.1 says a 6PN is **organization-scoped**. Put the
two sentences next to each other and the consequence is immediate — and for a year nobody did:

| caller                 | organization      | how it reaches motir-ai                                                                                                                                                                                                                |
| ---------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motir-core`           | `moooon`          | `MOTIR_AI_URL` — `https://motir-ai.fly.dev` since 2026-10-02 (`application-hosting.md` Amendment 9); `http://motir-ai.internal:8080` from 2026-08-21 to 2026-10-02, a 6PN name resolvable because motir-core and motir-ai share an org |
| an **index container** | **`motir-fleet`** | **that same name is NXDOMAIN.** It needs an address that resolves from outside `moooon`                                                                                                                                                |

> ⚠️ SUPERSEDED for the `motir-core` row by `application-hosting.md` **Amendment 9** (MOTIR-7407):
> motir-ai's pool suspends to zero and a 6PN name cannot wake it, so that leg moved to the public
> origin.
> The index-container row and this section's argument stand: the container still needs an address
> that resolves outside `moooon`, and `MOTIR_AI_CONTAINER_URL` stays a separate variable.

**What actually happened.** `codeGraphIndexDispatchService.bootIndexContainer` resolved the
container's `MOTIR_AI_BASE_URL` by calling `motirAiBaseUrl()` — motir-core's own accessor.
`lib/ai/motirAiClient.ts`'s doc comment even said the fleet container was that accessor's
consumer, so the dispatcher was doing exactly what the code told it to. It was correct while
`MOTIR_AI_URL` was public and became wrong the day the seam went private (MOTIR-3277, private
ingress allocated `2026-08-21 09:47`; the coordination rows stop moving at `11:48–11:58`). From
then on **every** index run booted, downloaded its repository, spent up to two hours building a
45 MB graph, and then died at

```
[indexer] error: run failed IndexerError: motir-ai /v1/code-graph/run/upload-grant
  was unreachable — caused by TypeError: fetch failed
  — caused by Error: getaddrinfo ENOTFOUND motir-ai.internal
{"ok":false,"failure":"UPLOAD","exitCode":40}
```

one call before the upload. "Build once, sync forever" (MOTIR-3249) had never run since, because
nothing could reach `recordSnapshotPointer` to advance the coordination row the sync path reads.

**The decision.** The container's address is resolved by a **separate accessor with its own
variable** — `motirAiContainerBaseUrl()` / `MOTIR_AI_CONTAINER_URL` — sitting immediately beside
`motirAiBaseUrl()` so a reader of one meets the other. `MOTIR_AI_URL` is **unchanged** and stays
on the private seam: MOTIR-3277 decided that for motir-core's own transport, and moving it to
satisfy a different consumer would undo a decision it is not about.

**There is NO fallback between the two, deliberately.** A default is what made this cost two
weeks instead of one dead-lettered run: unset now throws inside `bootIndexContainer`'s deployment
gate, which releases the admission slot and records a failure, before a machine is billed.

**Does this widen the fleet's exposure?** The reachability changes; the AUTHORITY does not. §4 is
untouched — the container still carries only its run-scoped credential, and motir-ai's three
container-facing routes are gated on it by `runCredentialAuth`. Verified anonymously against the
public host on 2026-09-04: `GET /health` answers `{"status":"ok"}`, and
`POST /v1/code-graph/run/upload-grant` answers **401 `service_unauthorized` — "A run-scoped
credential is required."** The route was already reachable from the public internet; what was
missing was telling the container about it.

**And the guard, because the shape of this fault is the point.** Every gating signal was green
throughout — both fleet boot preflights reported `bootable`, the job ledger reported 259
`succeeded` rows, motir-ai logged only its own re-index contract working as designed. Both
preflights ask whether a container can **boot**; neither had ever asked whether the booted
container can **reach** anything. `system.daily-health-check` now carries a third probe that does
(`fleetPreflightService.checkIndexContainerAiAddress`). It is loud on the two verdicts motir-core
is entitled to be loud about — the variable is unset, or the address is **private/network-scoped
and therefore cannot resolve from another organization whatever this process sees** — and only
`indeterminate` when a probe from `moooon` fails, which is a statement about motir-core's network
rather than about the address. It cannot prove the fleet's view from here; the structural arm is
the one that would have caught this on day one, and it needs no probe.

## §4 — Decision 3

**Isolation comes from CREDENTIAL SCOPE, not org count.**

`ci-runner-fleet.md` §7.4 chose JIT configuration over a registration token for one reason,
stated there in CI's vocabulary: a registration token _"can register **any** runner in the
org"_, while a JIT config is _"one runner, one config, no registration capability inside the
container."_ **What makes the fleet safe is that the container holds nothing worth stealing.**

**This record generalizes that from a runner rule to a fleet rule:** _every container the fleet
boots carries only narrowly-scoped, short-lived credentials, whatever its workload._ For
indexing that means a **pre-signed single-repo tarball URL** (§10) and a **motir-ai token scoped
to this run** — never a shared service token, never a DB credential, never an object-storage
credential, never a Fly token, never a GitHub App key.

**Why this is stronger than org separation, not weaker.** Org separation is a property of the
network; credential scope is a property of the container. A third org would have defended
index-vs-CI and nothing else. Credential scope also defends **tenant-vs-tenant** — the case org
separation never addressed, because both tenants are in the same org either way — and it keeps
holding if a fourth workload lands tomorrow without its own org.

**Production stays separate, and for a different reason.** Not "because it is a different
workload" but because production is **long-lived and holds the real secrets and the real DB
reach**. A fleet container is ephemeral and holds one job's credential. That asymmetry, not the
org count, is the boundary — which is why §7.5's separation survives this generalization intact
rather than being generalized away.

## §5 — Decision 4

**The container BUILDS the graph; motir-ai is control plane only.** motir-ai mints a scoped
upload URL and records the snapshot pointer. The **graph bytes go container → object storage
directly** and never pass through motir-ai.

**Why the delta is small.** motir-ai already separates the two halves: `graphIndexPublisher`
builds, `graphSnapshotStore` content-hashes into object storage, and
`codeRepoService.recordSnapshot` writes the pointer. Moving only the BUILD leaves the persist
path where it is.

**What it buys, in the units the failure modes were measured in** (§2):

- The upload shrinks from a ~350 MB **tarball** to an ~8–80 MB **graph**.
- motir-ai's **1-permit parse gate leaves the index critical path**. That gate is not a
  conservative guess: `motir-ai/docs/decisions/codegraph-production-topology.md` §2 records the
  measurement — the max-safe concurrent index at 512 MB was **N = 0**, a single whole-tree index
  peaks at **924 MB RSS** with **861 MB of it off the V8 heap**, and two would stack. **One index
  per machine is a measured ceiling, not a policy**, which is precisely why capacity has to
  become container count rather than a bigger number in `fly.toml`.
- No DB credential and no object-storage credential ever enter a container (§4).

### §5.2 — AMENDMENT 2026-09-10 (MOTIR-4652 · MOTIR-4642): the tarball is no longer re-fetched PER PROJECT

This section reasoned about a fan-out that no longer exists. Under the shape it was written for, one
repository connected in an organisation booted **one container per project of its workspace**, so the
tarball was fetched — and the graph built, and the snapshot uploaded — once per project, producing
byte-identical output each time.

**MOTIR-2029 decided against that model and MOTIR-4652 retired it.** There is now ONE index per
`(organisation, repoRef)`: `codeGraphIndexService.resolveIndexTarget` resolves the repo's workspace to
its `organizationId` and `indexFleetSteps` dispatches once. The per-project loop is gone from the code.

Nothing in §5's own argument changes — the container still builds, motir-ai is still control plane only,
the bytes still go container → object storage — but the **units** it quotes are now per organisation
rather than per project. An organisation with three projects sharing a repository spends one upload, not
three.

⚠️ **The saving is an INDEX ALLOWANCE and internal COGS.** Indexing is ABSORBED: the allowance is
included in the organisation's tier and is invisible to the customer, so the cost is real and internal
rather than customer-facing (MOTIR-4541). The old shape drew that allowance once per project and consumed
Motir's own container time once per project, for one output.

### §5.1 — REJECTED: the container calls motir-ai's tarball ingest route, and motir-ai builds

**Pinned, then reversed.** The container would fetch the repo and POST the bytes to
`POST /v1/code-graph/index`, leaving the parse in motir-ai. Rejected on three counts:

1. **It makes the container a download proxy.** The container's whole justification is that the
   heavy work needs a box sized for it; a container that only moves bytes has no reason to exist
   and re-introduces the 200 MB ingress bound it was meant to escape.
2. **It leaves `indexParseGate`'s 1-permit ceiling in the critical path** — the throughput
   ceiling §2's last row identifies. Capacity would still be "one index at a time per motir-ai
   machine," and the container would have bought nothing.
3. **It falsifies §4's own rationale.** A container that parses nothing holds nothing and needs
   no isolation argument — so the credential-scope reasoning that justifies the whole shape
   would have had no subject.

It also rested on a **false claim**: that an embedded indexer needs motir-ai's DB credential.
motir-ai's build/persist split (above) means the container can hand over an artifact while
holding only a run-scoped token.

## §6 — Decision 5

**One container per REPO.** This is not a preference; it is **forced by the shipped ledger
contract**, in two places that already read it:

- `jobRunRepository.listSucceededCodeGraphIndexRepoRefs` (`lib/repositories/jobRunRepository.ts:101`)
  reads `output.repoRef` off each **succeeded** `system.code-graph-index` row and builds a set.
  A run carrying no `repoRef` deliberately does not count as an index.
- `MigrateIndexRepoDto` (`lib/dto/migrateOnboarding.ts:65`) is **one row per repo**, and
  `MigrateIndexStatusDto.allIndexed` gates the onboarding wizard's Next button off exactly that
  set.

**So a run means "this one repoRef is indexed."** Batching N repos into one container would emit
one `repoRef` for N repos, and the other **N−1 would read as never-indexed forever** — the sweep
gate would never close and the wizard's rows would never all turn green.

Note the same DTO already records a related limitation in its own comment: _"the ledger cannot
tie a running row to a specific repo, so the in-flight state is aggregate, not per-repo."_
One-container-per-repo is what keeps the **succeeded** state per-repo, which is the state both
consumers actually gate on. **Re-modelling the ledger to allow batching is out of scope.**

### §6.1 — AMENDMENT 2026-09-04 (MOTIR-4519): the permanent claim was made 313 times about repos nothing had indexed

**Nothing in §6 is retracted — the contract held and the CLASSIFIER held. What failed is one field
read, three layers below either.** It is recorded here because §6 is where a reader goes to ask what
a `succeeded` row means, and for eight days the answer was not the one written above.

`packages/orchestrator/src/adapters/fly/flyMachines.ts`'s `exitCodeOfEvent` preferred Fly's
`exit_event.guest_exit_code` over `exit_code`, on a comment asserting the guest's number was the
container's own. **Production says the reverse.** Read from the fleet's Machines API on 2026-09-04:
**180 of 180** exit events carried `{ "guest_exit_code": 0, "exit_code": 40 }`, on containers whose
own logs read `{"ok":false,"failure":"UPLOAD","exitCode":40}` (MOTIR-4518's cause — every one of them
died at the upload grant). `guest_exit_code` is the guest VM's status and is `0` on any clean guest
shutdown, so the fallback never fired and **every** failed container reached `classifyIndexExit` as a
`0`, the one code that grants `indexed: true`.

Measured on production the same day:

|                                                                                          |                                                                                        |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `index-settle:*` memos in `job_step`, 2026-08-28 → 2026-09-04                            | **601, every one `exitCode: 0` / `exitClass: indexed`** — not one `40`, not one `null` |
| `succeeded` rows carrying `{ indexed: true, repoRef, projectsIndexed: 2 }`, 8-day window | **313** (312 `system.code-graph-refresh` + 1 `system.code-graph-index`)                |
| newest row in motir-ai's `CodeRepo` pointer table                                        | **2026-08-21T11:58:20Z** — seven days BEFORE the first of those 601                    |

So §6's _"a `succeeded` row is a permanent claim that the repo is indexed"_ was being asserted, per
repo, about a fleet that had uploaded nothing since 2026-08-21.

**⚠️ AND THE REPOSITORY ALREADY HELD THE CONTROL THAT SETTLES IT.**
`fleet-image-pull.md` §2.4 ran `sh -c 'exit 99'` and `sh -c 'exit 0'` inside a fleet Machine and wrote:
_"Read `exit_code` in the machine's `exit` event, **not** `guest_exit_code`, which read `0` in every
probe including the `exit 99` control — a trap worth recording for MOTIR-2006."_ MOTIR-2006 is the
card family that wrote the parse. **The corpus contained its own refutation and nothing compared the
two** — which is the durable half of this amendment: a record that contradicts a code comment is
worth as much as a production reading, and neither is consulted by the other.

The preference is inverted, and the guard that survives is
`tests/ciFleet/codeGraphIndexDispatch.test.ts`'s _classifies the code FLY REPORTED_ — it walks the
whole exit taxonomy from a production-shaped `exit_event` through the real adapter parse into
`classifyIndexExit`, so the ledger's `indexed` claim is pinned to the CONTAINER's own code rather
than to the step having completed.

## §7 — Decision 6

**The concurrency cap lives in the ORCHESTRATOR's admission control** — a global bound from
config, with a per-workspace bound of `ceil(global / 2)` so one tenant cannot starve another.
MOTIR-1990 owns it.

**Not in Inngest.** Per-tenant concurrency there would need a **keyed** limit, and `defineJob`
discards Inngest's concurrency `key`/`scope` entirely (MOTIR-1982) — so the substrate cannot
express it today. This is why MOTIR-1981 is **not** `blocked_by` that bug: the cap is being put
somewhere that can hold it, not waiting for the place that cannot.

The shipped `concurrency: 2` on the job (`lib/jobs/definitions/codeGraphIndex.ts:35`) was never
a tenancy control — its own comment records what it was for: five simultaneous runs against a
scale-to-zero motir-ai whose **cold start alone took 23.3 s** on 2026-08-02, each paying it and
none benefiting.

### §7.2 — CORRECTION: there is no provider spend cap underneath any of this

MOTIR-1981 justified the shared-org exposure as: _"one org means one provider spend cap, so a
runaway in any workload could stop all three — accepted only because each workload carries its
own in-Motir admission cap, making the provider cap a backstop rather than the operative
control."_

**The premise is false, and the conclusion is stronger without it.** `ci-runner-fleet.md` §9
established, quoting Fly's own cost-management documentation, that **Fly offers neither a
spending cap nor a billing alert**: _"We don't support billing alerts (yet), so budget
accordingly"_ and _"Free allowances don't cap your bill. … there's no soft ceiling. If you go
over, we'll bill you."_ MOTIR-1935 — the card titled _"set the fleet's provider-side spending
cap + alerts"_ — closed with that finding: there was no cap and no alert to set.

**Nothing sits underneath the product-side number.** So the layering, stated accurately:

| layer                                                              | what it bounds                                  | owner                    |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------ |
| `MOTIR_FLEET_MAX_IN_FLIGHT` — the **cross-workload** fleet ceiling | **the invoice** — every container, any workload | MOTIR-1997 (**shipped**) |
| Per-workspace index cap, `ceil(global / 2)`                        | **index fairness** — tenant vs tenant           | MOTIR-1990 (this story)  |
| Per-project CI cap (`PROJECT_IN_FLIGHT_CAPS`)                      | CI fairness                                     | MOTIR-1922 (shipped)     |
| Epic 9's agent cap                                                 | seats                                           | Epic 9                   |
| ~~Provider spend cap~~                                             | **does not exist**                              | —                        |

**MOTIR-1997 was caused by these decisions and has already landed.** Its registry comment
(`lib/ciFleet/workloads.ts`) names them directly: _"MOTIR-1981 decisions 2–3 put CODE-GRAPH
INDEX containers in the same Fly org and Epic 9 adds HOSTED AGENT containers; neither writes a
runner intent. Two independent per-workload caps do not compose into a bound."_ The ceiling now
counts every container under one `fleet` admission lock, summed by `fleetCeilingService.census`
over a **totality-guarded** `Record<FleetWorkloadKind, …>` — `code_graph_index` is already a
declared member, so this workload is counted **before** it ships rather than after.

**Two consequences MOTIR-1990 must honour:**

- Its per-workspace cap is **fairness underneath the ceiling**, not the spend bound. The spend
  bound is `MOTIR_FLEET_MAX_IN_FLIGHT` (default `DEFAULT_FLEET_IN_FLIGHT_CEILING = 24`,
  `lib/ciFleet/limits.ts:55`), and it is not this story's to re-derive.
- The index dispatcher must **take a `fleet_in_flight_slot`**, because that is how a workload
  with no intent table of its own becomes visible to the census. A cap that only counts index
  containers repeats exactly the defect MOTIR-1997 fixed.

This is `notes.html` #185 applied rather than restated: _express enforcement in terms the
product controls, not in the provider's billing controls._ The shared org's real accepted cost
is not "one provider cap for three workloads" — it is **one invoice with nothing but Motir's own
counter in front of it.**

### §7.3 — CORRECTION: the caps only bind the FIRST run for a (repo × project) — MOTIR-2160

MOTIR-1990 shipped the slot key as `<projectId>:<repoRef>`, _"deterministic, and deliberately not
run-scoped"_, so that a redelivery, an Inngest replay and a job retry find the slot they already
hold instead of taking a second one. That reasoning is sound and the key has not changed. **What
it silently also assumed is that a held slot could only ever be the asking run's own** — and
nothing in the system was holding that assumption up.

`system.code-graph-refresh` debounces pushes on `installationId/owner/name` with a **2-minute**
window (`lib/jobs/definitions/codeGraphRefresh.ts`). That coalesces merges INSIDE one window and
does nothing once a run has started: a push arriving mid-index opens a new window and fires a
second run. An index takes **minutes** — §11 records `motir-core`'s own tree failing to parse in
180 s — so a second run for a repo the first is still indexing is ordinary merge cadence, not an
exotic race. And the job deliberately carries **no `concurrency`** (MOTIR-2057, correctly: it
would cap supervisors, not containers), so nothing else serialized it either.

Two consequences, both of which contradict §7 / §7.2 as written:

- **`admit` returned `already_held` BEFORE evaluating any cap** — that early return is what makes
  a replay idempotent — so the second run's container booted having been judged against **none**
  of `workspaceIndexInFlightCap`, `indexInFlightCap` or `fleetInFlightCeiling`, the last of which
  §7.2 establishes has nothing whatsoever behind it.
- **Whichever run settled first released the shared slot**, so the census under-counted a
  container that was still running and still billing — the one direction §7 says the ceiling must
  never err in — and a third dispatch could then take the freed row only to have it deleted in
  turn by the second run's settle.

**The correction keeps the key and adds the OWNER.** `fleet_in_flight_slot.owner_ref` records the
dispatching run (`ctx.runId`, stable across a run's replays and retries, different for every new
run). Admission compares it: the same run keeps its capacity (`already_held`, still ahead of the
caps, still not a refusal), a different run is `deferred` with the new reason
`repo_index_in_flight` and waits on the existing budget — 60 attempts, 5 s → 60 s, `step.sleep`,
so waiting costs no invocation. Release is ownership-checked (`releaseOwned`), which is the half
that stops the cascade and is worth having on its own.

Putting the run in the **key** would have re-created exactly what MOTIR-1990 rejected — every
retry taking its own slot and walking past the cap. Putting it in an **owner column** does not:
the key still names one unit of index work, and the row now also says who is doing it.

**And it closes a second defect by construction, in the other repo.** motir-ai's `recordSnapshot`
writes the pointer unconditionally (no compare against the row's `commitSha`/`indexedAt`), so two
overlapping runs finishing out of start order could land the OLDER graph while stamping
`indexedAt = now()` — a stale code graph that claims to be current, with no detection point until
the next push. Serializing the runs removes the only way two writers for one (repo × project) can
exist, so no motir-ai card is owed. If a later decision ever tolerates overlap again, that guard
comes back with it.

### §7.4 — CONFIRMATION: the debounce this section reasons from is REAL, and its `timeout` is not — MOTIR-2994

§7.3 above, the job's own comment, and §11's _"one container per (repo × project) per debounced
push"_ all reason from `system.code-graph-refresh`'s debounce COALESCING. Nothing had ever tested
that. The only assertion on it read the option off `fn.opts` — which proves it was FORWARDED and
passes whatever the executor does with it, including declining to enqueue the second run. MOTIR-2902
then read a dev-server log as saying exactly that (_"error enqueueing debounce job: queue item
already exists"_, and 3 derivation runs where its E2E required 4) and MOTIR-2994 was filed to find
out whether this section's premise was false.

**It is not.** Measured against the real scheduler — `inngest-cli` 1.27.0, the binary CI's E2E lane
and every self-hosted deployment run, via `scripts/experiments/inngest-debounce-coalescing.mjs`; the
full table is in `docs/jobs.md` § Debounce:

- **A same-key burst coalesces into exactly ONE run carrying the LAST event**, in every delivery
  shape a real producer uses (serial, concurrent, and the whole array in one `send`). No run was
  dropped, and the error string above appeared **zero** times in ~20 trials. So §7.3's _"that
  coalesces merges INSIDE one window"_ stands, and so does the §7.2/§11 cost model built on it.
- **Distinct keys stay independent** — 30 keys in one `send` produced 30 runs — so one repo's push
  storm cannot suppress another repo's refresh. That is the property the per-(repo × project)
  container accounting needs, and it is now asserted in `tests/jobs/debounce-burst.test.ts`.

**Two things this section should NOT keep claiming, both now measured false on the dev server:**

- **`timeout: '15m'` is not a deferral cap.** The job's comment says _"`timeout` caps the total
  deferral so a steady push stream still refreshes at least every 15m."_ At an inter-event gap of
  1.0 s the cap fires on schedule; at 0.7 s and below it never fires at all and the run lands only
  once the stream STOPS. **This job is not exposed** — its producer is default-branch pushes to one
  repo, which do not arrive faster than one a second — so the disposition is to KEEP the debounce
  unchanged and record the limit, not to replace the mechanism. But the guarantee is weaker than the
  comment claimed, and a future job with a machine-generated producer would be exposed.
- **An unresolvable `key` MERGES rather than disabling the debounce.** Events whose key expression
  names a field they do not carry all land in ONE bucket, so N unrelated events yield ONE run and
  N−1 vanish silently. `key` is a CEL string, so nothing type-checks it. This job is safe —
  `CodeGraphRefreshData` makes all three key fields required, now asserted — and MOTIR-2902 is what
  the trap looks like when it is not.

**Cloud is UNMEASURED.** Production runs Inngest Cloud, a different scheduler implementation;
probing it needs the production `INNGEST_EVENT_KEY` (a Fly secret) and is human-gated per
`docs/jobs.md` § Cloud wiring. Inngest documents the coalescing contract without distinguishing
environments and documents nothing about an unresolvable key — so on Cloud the first two findings
are a documented promise and the last two are unknown, not known-good. Same shape as the concurrency
fairness numbers in `docs/jobs.md`, which are also dev-server-only and say so.

### §7.5 — AMENDMENT 2026-08-26 (MOTIR-3488): the invocation ceiling this record reasons from is GONE, and the stepped shape went with it

§2's table lists **`maxDuration = 300`** among the five failures a container removes, noting that
"MOTIR-1974's checkpointing exists only to fit under it". §11's _"one container per (repo × project)
per debounced push"_ and §7.3/§7.4 reason from the shape that checkpointing produced. All of it was
true, and one of its premises has expired.

**What changed, and it is not this record's subject.** `app/api/inngest/route.ts` declares
`maxDuration = 300`, which is a Next.js route-segment directive the DEPLOYMENT PLATFORM enforces.
motir-core has run as a long-lived Fly process since MOTIR-2384 — `Dockerfile` ends
`CMD ["node", "server.js"]` — and the Postgres job engine's worker is its own process group with a
renewed lease. Nothing kills a long-running handler.

**What MOTIR-3484 therefore did.** `lib/jobs/indexFleetSteps.ts` drove
`codeGraphIndexDispatchService` as durable steps — `index-admit:<pid>:<n>` ×60, `index-boot:<pid>`,
`index-wait:<pid>:<n>` / `index-poll:<pid>:<n>` up to 500, `index-settle:<pid>` — while the SAME
service already carried the composition without the step ids, marked _"NOT THE PRODUCTION PATH"_ for
exactly this reason. There is ONE composition again: the job drives `runIndexContainer` through an
optional step seam, and the loop is an ordinary `while` with an `await`.

**§2's CONCLUSION IS UNTOUCHED, and the distinction matters.** Every other row of that table — the
OOM, the 180 s deadline, the ingress ceiling, the per-project re-fetch, motir-ai as the throughput
ceiling — is about where the WORK runs, and the answer is still a container. Only the `maxDuration`
row was about the SHAPE of the supervisor, and that row now records history rather than a live
constraint. **A container is still the decision; the stepping never was one.**

**§7.3 and §7.4 are unaffected in substance.** The admission cap, the `dispatchId`-owned slot and the
debounce's coalescing are all properties of the WORK, not of the supervisor's shape:
`codeGraphIndexAdmissionService` and `lib/ciFleet/limits.ts` are untouched by MOTIR-3417 by explicit
instruction, because a regression there costs money. What §7.4 measured about Inngest's debounce is
now half the story — the Postgres engine implements the option itself (MOTIR-3483) and honours the
`timeout` cap §7.4 found does not fire, which is documented beside the measurement in
`docs/jobs.md` § The engine's debounce.

**What replaces the ceiling as the reason for a step.** Not duration — a WORKER RESTART.
`docs/decisions/job-queue-foundation.md` §13 states the rule (the durable boundary is the SIDE
EFFECT, never the WAIT) and tables the disposition of every call site. For this fleet: `resolve-target`,
`index-admit:<pid>`, `index-boot:<pid>`, `index-settle:<pid>` and `cancel-offboarding` keep their
steps; the waits and the polls do not. The ledger contract §6 fixes — ONE `job_run` per repo,
`succeeded`, one `output.repoRef` — is unchanged and is asserted through the real worker in
`tests/jobs/supervisor-cutover-story-gate.test.ts`.

**And §11's "one container per (repo × project) per debounced push" still holds**, on both lanes.

## §8 — Decision 7

**The META org runs indexing ON the fleet, by the same path a customer takes.**

### §8.1 — The test is CIRCULARITY, not meta-vs-customer

MOTIR-1915 keeps `moooon-B-V`'s **CI** on GitHub-hosted runners, and its reason is specific:
_"don't put your own release path on infrastructure you are still building."_ A broken CI fleet
would block shipping the fix to the CI fleet.

**That reasoning does not extend to indexing.** A broken index fleet makes Motir's planner
code-blind; it does **not** block shipping. There is no circular dependency, so the exclusion
does not carry over. Read the exclusion as _"is our own recovery path on this?"_ — not as
_"is this ours?"_

_(For Epic 9 the test bites again: if Motir's own story runs move to hosted agents on the fleet,
a broken fleet means no agent to fix it. That is acceptable **only while a non-fleet escape
hatch exists** — today the BYOK/local CLI path. Recorded here because it is the same test, not
because this story decides it.)_

### §8.2 — REJECTED: run meta's containers in the production org

**Defensible on its face**, which is why it needs recording: meta indexing parses _Motir's own_
source, which is trusted, so the untrusted-input rationale for fleet isolation genuinely does
not apply to it.

**Rejected for EXERCISE, not for security.** `moooon` is currently the only real tenant, so
meta-in-production means **nothing runs in the fleet at all**. The index path would ship, pass
its `fake`-adapter tests, and sit as **dead code** until the first customer connects a repo —
surfacing every wiring bug at once, in front of that customer.

**That is a shape this project has already paid for.** MOTIR-1980 records it: _"the fleet
shipped code-complete and UNBOOTABLE"_ — five green cards, an unbuilt runner image, an unwired
org, and nothing able to start. Placing meta in production would reproduce it deliberately.

It would also require an **`isMeta` branch in the boot path** — a code path only meta takes,
which means the tested path is the one nobody runs, and the untested path is the one every
customer gets.

**The budget concern that motivates it is real and is solved elsewhere:** meta metered as its
own queryable line (§9), plus the admission cap that bounds `moooon` like any tenant (§8.3).
**Org placement is the wrong lever for an accounting problem.**

### §8.3 — CORRECTION: "bounded like any tenant" is not what the shipped cap does

§8.2's rejection leans on meta being bounded by the per-tenant cap. The **shipped CI** cap does
the opposite: `PROJECT_IN_FLIGHT_CAPS.meta = null` (`lib/ciFleet/limits.ts:85`) — meta is
**exempt** from the per-project allowance, by MOTIR-1922's acceptance criterion.

The exemption is bounded and honest about itself: its comment reads _"exempt per the card, and
ONLY from this cap"_, and `fleetCeilingService`'s NO-BYPASS block is explicit that `isMeta` does
not lift the fleet ceiling — _"a meta-org runaway costs Motir exactly as much as any other."_
So meta is bounded by **the invoice ceiling**, not by a per-tenant one.

**Binding on MOTIR-1990: the per-workspace index cap applies to the meta workspace.** Do not
copy `PROJECT_IN_FLIGHT_CAPS`'s meta row into the index cap. The reasons differ — CI's exemption
is about a tier allowance for work Motir is not billing itself for, while the index cap's job is
**tenant-vs-tenant fairness**, and `moooon` indexing its own repos can starve a customer exactly
as any tenant can. If MOTIR-1990 concludes otherwise, §8.2's rejection needs re-deciding, not
quietly weakening.

## §9 — Decision 8

**`isMeta` bypasses the CHARGE — not the PLACEMENT, and not the METER.**

Meta compute runs **on the same fleet, by the same path**, and is **metered as COGS attributed
to Motir**, queryable as its own line. It simply never debits a ledger. Unmetered dogfooding is
unbounded and invisible spend, and "we don't bill ourselves" is not a reason not to know the
number.

### §9.1 — The generalization, and why it is recorded as a warning

**`isMeta` is a BILLING flag that has been used as a proxy for "this workload is not real."**
That proxy was safe while meta ran nothing on shared infrastructure. **It stops being safe the
moment meta shares infrastructure with customers** — which is what decision 7 does.

**Every `isMeta` branch should be read as _"should this be un-charged?"_ — never as _"should
this be un-measured?"_ or _"should this run somewhere else?"_**

**This is not hypothetical; it is live in shipped code.** `ciFleetCostMeterService`
(`lib/services/ciFleetCostMeterService.ts:117-121`) resolves `isMeta` and returns
`{ outcome: 'bypassed_meta' }` **before** writing the usage row — so a meta container's
**container-seconds and cost are not recorded at all**, not merely not charged. The stated
rationale is about billing (_"attributing this cost would bill the house to itself"_), but the
implementation drops the measurement. The same shape sits in `ciMinutesMeterService`
(`bypassed_meta`) and in `allowance.ts`'s `bypassed` state.

For CI the branch is currently **unreachable** — MOTIR-1915 keeps `moooon-B-V` off fleet
runners, so no meta CI container exists to meter — and that unreachability is exactly why it
survived unexamined. **Decision 7 makes the equivalent branch reachable for indexing.**

**Binding on MOTIR-1995 (the index COGS meter):** meta index containers are **metered**, with
their seconds and cost attributed to the org and distinguishable from CI and agent spend within
the shared org. `isMeta` may suppress a charge; it may not skip the write. Whether
`ciFleetCostMeterService`'s CI bypass should change is **not decided here** — it is a live
question about a different workload, and this record only fixes that the index meter must not
inherit the pattern.

The separability itself is already prepared: the CI meter stamps `workload: 'ci'` on its rows,
with a comment naming index and agent containers as recording their own.

## §10 — Decision 9

**The container holds NO GitHub credential.**

motir-core resolves GitHub's **pre-signed `codeload` URL** and passes that URL — not a token —
in the container spec. GitHub 302-redirects `/repos/{owner}/{repo}/tarball/{ref}` to a
`codeload.github.com` URL **authorized by its own signed query string**.

**The evidence is already in the code**, in the comment on today's fetch
(`lib/git/providers/github.ts:124-129`): _"GitHub 302-redirects `/tarball` to a PRE-SIGNED
codeload.github.com URL. `fetch` follows the redirect and (per the fetch spec) STRIPS the
[`Authorization` header] … the codeload URL is already authorized by its signed query string."_

So the property this decision relies on is **not a new assumption** — it is the mechanism the
current path already depends on, observed rather than hoped for: the installation token does
not reach `codeload` today either. **Handing the resolved URL to a container therefore leaks
nothing, and is strictly less privilege than handing over an installation token**, which would
grant repo-wide API access for its lifetime.

**What MOTIR-1989 must change:** today's call lets `fetch` follow the redirect internally and
buffers the body (`res.arrayBuffer()`, the OOM in §2). Dispatch instead issues the request with
`redirect: 'manual'` and reads the `Location` header, so the **URL** — not the bytes — is what
crosses into the container spec. The URL is short-lived and single-repo, which is §4's rule
satisfied for the fetch half; the motir-ai run-scoped token (MOTIR-1986) is §4 satisfied for the
upload half.

## §11 — What this does NOT change

**The `motir-projects`-only CI boundary is untouched** (MOTIR-1915 / MOTIR-1916). This story
uses the **orchestrator PORT**, not the runner layer: **no runner registers, no `runs-on`
resolves, no `workflow_job` fires, and nothing bills as CI minutes.** Sharing an org does not
change that — **a container is not a runner.** No `moooon-B-V` repo gains a Motir `runs-on`
label and no GitHub runner is provisioned for one.

**Indexing cannot be a GitHub Actions workflow, and this is a hard constraint, not a
preference.** It must work for **BYOK repos Motir does not own** (MOTIR-1754): injecting a
workflow file mutates a customer's code, requires Actions to be enabled, and is impossible on a
read-only connection. It would also gate a user's code graph behind their **CI credit balance** —
`ci_credits_exhausted` would silently mean "your planner is code-blind." Two unrelated products
would share one refusal.

**Still building in-process, unchanged:** ~~`system.code-graph-refresh`~~ and motir-ai's
**hydrate-on-read** path both keep running behind `indexParseGate`. **Retiring motir-ai's
tarball ingest route is a later decision**, not this one — the route stays.

> **AMENDED 2026-08-04 (MOTIR-2057): the refresh half of that sentence was wrong, and
> production paid for it.** Leaving one caller on an abandoned path is not a neutral
> "unchanged" — `system.code-graph-refresh` does architecturally the same work (fetch a
> repo's bytes, parse a whole tree) and kept doing it inside a Vercel function under the
> 180 s upload client deadline. `motir-core`'s own graph does not
> parse in 180 s, so its refresh failed deterministically, and its five idempotent retries
> then queued against motir-ai's single 1-permit `indexParseGate` and starved every other
> repo's refresh: a measured **~68% failure rate over three days** (Aug 2 7/18, Aug 3 7/16,
> Aug 4 8/17), presenting as intermittent motir-ai unavailability. `system.code-graph-refresh`
> now drives the SAME `runIndexFleetSteps` shape as the first index, keeping only its
> per-repo debounce, and the in-process module (`lib/jobs/codeGraphSteps.ts`) plus
> `codeGraphIndexService.indexRepoIntoProject` are DELETED so no third caller can adopt
> them. motir-ai's hydrate-on-read path and its ingest route are untouched, as above.
>
> Two facts worth carrying, both established while diagnosing it:
>
> - **A refresh was never incremental.** motir-ai's incremental entry is
>   `GraphIndexPublisher.refresh`; the ingest route runs `receiveAndIndex` →
>   `indexAndPublish` → `store.indexRepo`, a whole-tree build, and nothing has ever called
>   the incremental one. Moving refresh onto the fleet therefore loses no incremental
>   semantics — the same whole-tree parse moves off a 180 s budget onto a container's
>   30-minute one — but it does move the cost onto a metered container per (repo × project)
>   per debounced push, admitted by `codeGraphIndexAdmissionService` (§7).
> - **The lesson generalizes past this file** (`motir-meta/notes.html` #215): a migration's
>   unit is the SET OF CALLERS of the path being abandoned, not the one caller that
>   motivated it.

> **AMENDED AGAIN 2026-08-05 (MOTIR-2138): "the route stays" is no longer the whole
> picture, because the CLIENT does not.** With both jobs on the fleet, `motir-core`'s
> byte-upload method sat exported and tested with no call site for weeks — the same
> "leaving an abandoned path reachable is not neutral" shape the amendment above paid for,
> one layer down. It is now DELETED, and with it the second deadline this boundary
> carried; every remaining method on `lib/ai/motirAiClient.ts` is a JSON request under the
> single 30 s `MOTIR_AI_REQUEST_TIMEOUT_MS`. **motir-core can no longer POST bytes to
> motir-ai at all** — anything that wants a graph built dispatches a container, which
> fetches the repo from a pre-signed URL itself.
>
> Retiring motir-ai's ingest ROUTE — the "later decision" §11 deferred without filing a
> card, which is the planning bug MOTIR-2140 records — is now MOTIR-2139, in the other
> repo. Until it lands the route exists with no caller anywhere; that is the intended
> ordering, since removing an unused client can break nothing while removing the server
> first would leave a client whose only possible outcome is a 404.

**Not decided here:** MOTIR-1974's checkpointing is not re-opened; how the product _asks_ for a
repo or surfaces index _freshness_ stays with MOTIR-1754; motir-ai's graph **engine** and its
1-permit semaphore are unchanged and not weakened; Epic 9's container lifetime, cap and metering
remain Epic 9's.

> **AMENDED 2026-08-05 (MOTIR-2162): this section never asked what happens when a repo goes
> AWAY, and the answer turned out to be "nothing, anywhere."** Every sentence above is about
> what still BUILDS a graph. Nothing here — or in the nine decisions — says what removes one,
> and §5 moved the persist path's justification ("the delta is small; leave persist where it
> is") without anyone noticing that the persist path had no inverse. **That is now Decision 10,
> §14.** It is recorded as an omission rather than a change of mind: no decision above is
> reversed by it, and the gap was found by MOTIR-2161 standing in front of the code, not by any
> gate.

### §11.1 — The workload asymmetry, for whoever reads this from Epic 9

Index containers and agent containers are shaped differently, and the numbers here do not
transfer:

| axis             | index container          | agent container (Epic 9) |
| ---------------- | ------------------------ | ------------------------ |
| lifetime         | **minutes** — job-shaped | **hours** — story-shaped |
| credential       | per-**job**              | per-**session**          |
| what a cap means | **throughput**           | **seats**                |

Two consequences. A cap number that reads as "throughput" for indexing reads as "seats" for
agents, so **Epic 9 must size its own** rather than copy §7's. And **teardown-time costing
under-reports a long-running container for its whole life** — the index meter records at
teardown because minutes-long containers make that accurate; hours-long ones do not.

`DEFAULT_FLEET_SLOT_TTL_SECONDS` is 6 hours (`lib/ciFleet/limits.ts:70`) and is a **safety net,
not a timeout** — deliberately longer than any container Motir boots. An agent workload should
check that assumption against its own lifetime rather than inherit it.

## §12 — Binding on MOTIR-1981's cards

Per `notes.html` #50, this record ships nothing. Each line below is what a sibling card owns,
and each may cite **this file by path** instead of restating the argument:

| Card           | Owns                                                                                                                                  | Sections       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **MOTIR-1986** | motir-ai reduced to control plane: run-scoped credential, single-key upload URL, pointer recorded                                     | §4, §5         |
| **MOTIR-1988** | the indexer image — fetch a tarball URL, build the graph, hand over the pointer; digest-pinned, mirrored per `fleet-image-pull.md` §1 | §5, §10        |
| **MOTIR-1989** | dispatch a container instead of fetching in-function; `redirect: 'manual'`; the ledger contract preserved                             | §2, §6, §10    |
| **MOTIR-1990** | the admission cap — global + per-workspace `ceil(global / 2)`; takes a `fleet_in_flight_slot`; **no meta exemption**                  | §7, §7.2, §8.3 |
| **MOTIR-1995** | the COGS meter — per-container seconds + cost, `workload` stamped, **meta metered and not charged**                                   | §9, §9.1       |
| **MOTIR-1994** | live verification that a container really boots in `motir-fleet` and its credentials are provably narrow                              | §3, §4         |
| **MOTIR-2160** | the slot's OWNER — one run at a time per (repo × project), ownership-checked release                                                  | §7.3           |

**Already shipped, and load-bearing for this story:** MOTIR-1979 (the `motir-fleet` org),
MOTIR-1997 (the cross-workload ceiling that counts `code_graph_index` before it exists),
MOTIR-2005 / MOTIR-2006 (how a fleet machine obtains image bytes — the indexer image is built
from motir-ai's **closed** source, so `fleet-image-pull.md` §1 puts it in the **mirror** column).

**Decision 10 (§14) binds its own cards, in §14.6** — they belong to MOTIR-2162, not to MOTIR-1981,
so they are listed there rather than added to the table above.

## §13 — Sources

**Read or measured 2026-08-02 – 2026-08-03.** Code references are pinned at `motir-core`
`7df65d66` and `motir-ai` `a4bc960`.

- `docs/decisions/ci-runner-fleet.md` — **§7.4** (JIT config over registration token, the
  argument §4 generalizes), **§7.5** (org-scoped 6PN; production separation), **§9** (Fly offers
  neither a spending cap nor an alert), **§9.1a** (the cross-workload amendment).
- `docs/decisions/fleet-image-pull.md` §1 — public-vs-mirror by source visibility.
- `docs/decisions/code-access-for-planning.md:51` — the 200 MB ingress bound.
- `motir-ai/docs/decisions/codegraph-production-topology.md` §1–§2 — the measured
  one-index-per-machine ceiling (924 MB peak, 861 MB off-heap; N = 0 safe at 512 MB), grounded in
  MOTIR-1515's `results-local.md`.
- `lib/orchestrator/types.ts:155` · `lib/orchestrator/adapters/fly/flyMachines.ts:21` — the port,
  and the 6PN comment §3.1 rests on.
- `lib/git/providers/github.ts:109-147` — `fetchRepoTarball`, the `res.arrayBuffer()` that OOMs,
  and the pre-signed `codeload` redirect §10 rests on.
- `lib/repositories/jobRunRepository.ts:101` · `lib/dto/migrateOnboarding.ts:65` — the per-repo
  `output.repoRef` contract §6 rests on.
- `lib/ciFleet/workloads.ts` · `lib/services/fleetCeilingService.ts` · `lib/ciFleet/limits.ts:55,70,85` —
  the shipped cross-workload ceiling, its census, and the per-tier caps.
- `lib/services/ciFleetCostMeterService.ts:117-121` · `lib/services/ciMinutesMeterService.ts` ·
  `lib/ciMetering/allowance.ts:60` — the live `bypassed_meta` instances §9.1 warns about.
- `lib/ai/motirAiClient.ts:94` · `app/api/inngest/route.ts:38` ·
  `lib/jobs/definitions/codeGraphIndex.ts:24-35` — the deadlines and the old cap.
- `motir-ai/src/codegraph/indexConcurrency.ts:102` · `motir-ai/fly.toml` — the 1-permit gate and
  the request-based scaling that long indexes never trip.
- `notes.html` **#50** (a decision card is not an implementation), **#185** (express enforcement
  in terms the product controls).

## §14 — Decision 10 — Offboarding

**Status:** accepted · **Date:** 2026-08-05 · **Card:** MOTIR-2162 · **Implemented by:** MOTIR-2165,
MOTIR-2166, MOTIR-2168, MOTIR-2169, MOTIR-2171 (and MOTIR-2163, the pointer back into motir-ai) ·
**Evidence pinned at:** `motir-core` `origin/main` @ `c27c6776` · `motir-ai` `origin/main` @ `cc36f74`

**A repo's code graph is DERIVED CUSTOMER DATA held under a DEFINED RETENTION WINDOW — not a permanent
cache. Offboarding removes all three artifacts, snapshot first.**

This is a later decision, not one of the nine (§0). It exists because §11 recorded what this story does
not change and never asked what happens when a repo goes **away** — and the answer, found by MOTIR-2161
while deleting two caller-less functions, was **nothing, anywhere.**

### §14.1 — The gap, measured

Under §4–§5 a repo's graph lives in three places. On `origin/main` at the date above, **no code path
removes any of them on purpose:**

| #   | artifact                                               | what removes it today                                                                                                                                    |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the Postgres `CodeRepo` coordination row               | only the `AiProject` FK cascade — and nothing in motir-ai `src/` deletes an `AiProject`, so in practice it never fires                                   |
| 2   | the per-machine local root under the adapter's FS root | nothing. `graphCacheManager`'s LRU evicts **handles** and deliberately leaves the file on disk (`graphCacheManager.ts:28`)                               |
| 3   | the durable object-storage snapshot                    | nothing. `graphSnapshotStore.prune` is a SIZE bound that returns early for `keep <= 0` (`:376-377`), so no argument to it removes a repo's last snapshot |

**And the one deletion the system CAN do makes it worse.** The FK cascade removes the coordination rows,
which are the only inventory of which snapshot keys exist. The objects stay under
`codegraph/<aiProjectId>/<repoRef>/<commitSha>.db.gz` (`snapshotPrefix`, `:479`), reachable only by a
bucket-wide `ListObjectsV2` diffed against live projects — a sweep that does not exist. **Retained data
becomes UNREFERENCED retained data.**

`prisma/schema.prisma` already carries an informal position on this — the `AiProject.codeRepos` comment
says the snapshots and caches are then _"rebuildable-only."_ **That sentence is the accident this section
replaces with a decision.** It is not wrong about the engineering; it simply never asked whether
rebuildable and disposable are the same thing, and nobody had to answer because no code depended on it.

### §14.1a — AMENDMENT 2026-09-10 (MOTIR-4657 · MOTIR-4642): the cascade this section argues from is now the ORGANISATION's, and the argument has to be MADE AGAIN rather than re-pointed

§14.1's finding survives the re-key. Its **sentence** does not, and the difference matters more than it
looks — which is why this amendment restates the argument instead of substituting a word.

**What the old argument said.** `CodeRepo` hung off `AiProject` with `onDelete: Cascade`. Deleting a
project therefore destroyed the coordination rows, which are the only inventory of which snapshot keys
exist, leaving the objects under `codegraph/<aiProjectId>/<repoRef>/<commitSha>.db.gz` reachable only by a
bucket-wide diff against live **projects**.

**Why substituting "organisation" for "project" would have been wrong.** It would read correctly and
describe a relation nobody had checked. Three things are different, not one:

1. **The edge is different.** `CodeRepo.aiOrganizationId` is a second FK, added by MOTIR-4650 and
   cascading from `AiOrganization` — it did not replace `aiProjectId`, it joined it. For the width of the
   re-key BOTH relations point at the same rows and BOTH cascade, so a project delete still destroys
   coordination rows even though a project no longer owns a graph. MOTIR-4666 drops the old column in a
   release of its own; until it does, the inventory has _two_ ways to vanish, not one.
2. **The prefix is different, and so is what a diff can find.** The key is
   `codegraph/<aiOrganizationId>/<repoRef>/<commitSha>.db.gz` since MOTIR-4657, and the enumeration that
   reads it was RENAMED — `listProjectSegments` → `listOrganizationSegments` — precisely because a
   method whose name says _project_ returning organisations is how the next reader gets it wrong. Both
   ids are cuids, so nothing downstream could have refused the mismatched pair.
3. **The blast radius of getting it wrong is different, and it was measured.** Under the old model a
   mismatched diff found some orphans. Under the new one, a reconciler still resolving segments as
   projects finds that EVERY segment is an orphan — MOTIR-4646 read production on 2026-09-09 and
   recorded 2 segments, 2 live, **both orphaned the instant the key space moves**. An applied pass would
   have deleted every live graph Motir holds.

**So the restated finding:** the coordination row is still the only inventory of which object keys belong
to a repo, and it can still be destroyed by a cascade — now from either end. What changed is that the
diff which could recover from that must ask motir-core about ORGANISATIONS
(`POST /api/internal/ai/live-organizations`, MOTIR-4647), and that the cost of asking the wrong question
went from partial to total.

### §14.2 — Why "it is a rebuildable cache, keep it" was rejected

It is the cheaper answer and it is defensible on the engineering: every artifact really can be rebuilt
from the source tree, and keeping it costs storage and nothing else. It was rejected on two counts.

1. **A graph is not a cache of public data — it is a derivative of a customer's PRIVATE source.** It
   holds their file paths, symbol names and call structure. "We keep a rebuildable artifact" describes
   the cost model, not the obligation; the obligation follows the input, not the reconstructability.
2. **The mirror does not do it either, and the terms this product ships under do not allow the silence.**
   GitHub's Marketplace terms make the provider responsible for deleting the user's data _"within its
   defined window"_ — the obligation is to **have** a defined window and be able to state it. Silence is
   the one answer that is not available.

**Rejected with it: "delete immediately on disconnect."** Sourcegraph — the closest mirror for
code-graph data specifically — makes retention a first-class, configurable policy rather than an instant
purge, and keeps a removed repository's data on disk _"so that in the event the repository is added
again it doesn't need to be recloned."_ That is the accidental-disconnect case, and it matters more here
than there: a re-index is a **metered container per (repo × project)** (§7), so an instant purge bills the
user for their own misclick.

**So the decision is the shape both rejections point at: a stated, bounded window.**

### §14.3 — Per trigger

Every trigger below is a control that already ships. **`repoRef` scope is per-repo where the trigger is
per-repo, and whole-project otherwise.**

| trigger                   | shipped site (motir-core)                                                                                   | scope               | when             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- | ---------------- |
| disconnect ONE repo       | `gitlabConnectionService.disconnectProject`; the GitHub `deleteExcept` prune in `githubInstallationService` | that `repoRef`      | after the window |
| disconnect the CONNECTION | `gitlabConnectionService.disconnect`                                                                        | every repo on it    | after the window |
| ARCHIVE a project         | `projectsService.archiveProject`                                                                            | whole project       | after the window |
| DELETE a workspace        | `workspacesService.deleteWorkspace`                                                                         | every project in it | **immediately**  |

**There is no project hard-delete to decide for.** `archiveProject` is this product's terminal project
lifecycle action — its own comment says so, and `git grep` finds no `project.delete` anywhere in `lib/`
or `app/`. MOTIR-2162 was authored asking what "deleting a project" should remove; the honest answer is
that the operation does not exist, and archive is the edge that stands in for it. That is the same
reading MOTIR-1972 already took when it hung the runner-group cleanup off archive.

**Why the workspace arm has no window.** The other three leave the project row standing, so the scope
remains readable and a re-connect can cancel the pending removal. `deleteWorkspace` is a hard delete
that cascades: there is no surface left to undo into, so a window would protect nothing and only extend
retention. **A grace period the user cannot reach is not a grace period.**

**The window is 30 days**, one named constant in motir-core (MOTIR-2166), interpolated into the copy that
states it (MOTIR-2171) rather than retyped — so the promise and the behaviour cannot drift.

**Re-onboarding CANCELS a pending offboard.** A repo reconnected, or re-indexed, before its due date
clears the queue row. This is what makes the window a grace period rather than a delay, and it is why
the window is worth having at all.

### §14.4 — The ORDER, and why it is the load-bearing part

**Snapshot → local root → coordination row. Always, and asserted by a test rather than a comment.**

The row is the only record of which object keys belong to a repo. Removing it first does not merely
waste a step — it strands the snapshot as garbage nobody can name, which is **precisely what the FK
cascade does today** (§14.1). A removal path that ships in the wrong order closes green and makes the
defect strictly worse.

**Every step is idempotent by construction** — `DeleteObjects` over a prefix, `rm -f`, `deleteMany` — so a
partial run followed by a re-run converges. Offboarding is therefore a **re-runnable sweep keyed by
(aiProjectId, repoRef)**, never a one-shot fired at the trigger.

#### §14.4a — AMENDMENT 2026-09-10 (MOTIR-4657 · MOTIR-4642): the sweep's key, and the one step that is now a NO-OP

The ORDER is unchanged and is still the load-bearing part. Two things around it changed.

**The key is `(aiOrganizationId, repoRef)`.** `graphSnapshotStore.removeAll`,
`graphCacheManager.removeLocal` and `codeRepoRepository.deleteByOrgAndRepoRef` all take the organisation
now, and the per-machine cache path moved with them —
`<CACHE_DIR>/<layout>/<aiOrganizationId>/<repoRef>/…` (MOTIR-4655, which also versions the layout so the
project-keyed trees already on disk are swept once rather than stranded for ever; nothing else would ever
have reclaimed them, because the LRU evicts handles and leaves files).

**⚠️ AND A PROJECT-SCOPED OFFBOARD NOW REMOVES NOTHING.** This is a semantics change, not a rename, and
it is the one a reader is most likely to miss. Before the re-key, deleting a project deleted its graph —
right, while the graph was the project's. Now the graph belongs to the organisation, and the same call
would delete something a SIBLING PROJECT is still reading. The sibling would not error: a read against a
missing graph returns the empty answer by design, so it would simply plan without code.

So `offboard({ coreWorkspaceId, coreProjectId })` returns
`skipped: 'project-scope-no-longer-owns-graph'` and removes nothing, reported rather than silent because
motir-core's retention sweep deletes its queue row on success and "removed nothing, correctly" has to be
distinguishable from "removed everything" six months later. What DOES remove a graph is
`offboardOrganization`, and the reconciler drives it against ORGANISATION liveness.

**The trade, stated:** a project delete no longer reclaims anything. Retaining a graph the organisation
still owns costs storage; deleting one a sibling still reads costs that sibling its code context,
silently. §14's retention obligation is about the customer's data, and the customer here is the
organisation — so the obligation is discharged when the organisation goes.

### §14.5 — The SEAM, pinned

**Trigger → `CodeGraphOffboarding` queue row (motir-core) → `system.code-graph-offboard-sweep` cron
(motir-core) → `POST /v1/code-graph/offboard` (motir-ai) → the three deletions.**

Three properties, each checked against shipped reality rather than assumed:

- **The queue row is deliberately NOT foreign-keyed to the workspace or project.** It must outlive the
  cascade that makes it necessary. An FK here would reproduce the exact defect this section exists to
  fix, one repo over — and it would look correct in review, because every other table in that schema
  should have one.
- **The clock lives in motir-core.** `git grep` over motir-ai's `src/` finds no cron, no interval and no
  scheduled entrypoint — it receives `POST /v1/jobs` and serves `/v1/*`. motir-core already owns every
  recurring sweep (`system.attachment-gc`, `system.automation-retention-sweep`, `system.ci-runner-reap`),
  and keeping the clock there preserves §5's control-plane-only shape for motir-ai.
- **The queue IS the retry.** The row is deleted only on a successful response, so a motir-ai outage
  leaves it due and the next tick picks it up. No bespoke attempt counter, no dead-letter table.

**Why a queue rather than the `deleteQuietly` precedent.** `archiveProject` already fires a post-commit,
best-effort external cleanup at a runner group (MOTIR-1972, `ci-runner-fleet.md` §7.3), and that is the
right **shape** — outside the transaction, never failing the user's action. It is the wrong
**mechanism** twice over: a window cannot be implemented by a call that happens now, and `deleteQuietly`'s
failure mode is a stale access list somebody tidies later, while a dropped call here means customer-derived
data retained forever underneath a promise that it was not. `notes.html` #185 — express enforcement in
terms the product controls.

**Enqueue is still post-commit and non-fatal**, which is correct and has a consequence: some enqueues will
be lost. That is what the reconciliation backstop (MOTIR-2169) is for, and it is also the only thing that
can ever find the graphs the FK cascade has **already** orphaned — the bucket-wide sweep MOTIR-2162 named
as not existing.

#### §14.5a — AMENDMENT 2026-09-10 (MOTIR-4657 · MOTIR-4642): the backstop subtracts ORGANISATION liveness

§14.5's three properties are unchanged: the queue row is still not foreign-keyed, the clock still lives in
motir-core, and the queue is still the retry.

What changed is the **backstop's question**. `codeGraphReconcileService` derives deletion scope by
subtracting a motir-core liveness read from a storage enumeration, and both halves moved together — by
necessity, in ONE pull request, because a deploy window in which the prefix had moved and the reconciler
had not is the total-loss window (§14.1a, point 3).

- the enumeration is `listOrganizationSegments` (renamed, not re-pointed);
- the liveness read is `POST /api/internal/ai/live-organizations` (MOTIR-4647), not
  `/api/internal/ai/live-projects`.

**The three safety properties this section rests on are unchanged and were re-asserted rather than
assumed:** `apply` still defaults to `false`; `unknown` is still never `absent`; a liveness read that
throws still aborts the pass and deletes nothing. The first is now pinned by a test that FINDS a
candidate and still removes nothing, so it cannot pass by finding nothing.

### §14.6 — What this does NOT decide, and the card for each

Per `notes.html` #223 — the lesson written about **this document's §11** — every deferral below is a filed
card, cited by key, filed before this section merged. There is no sentence here that names no card.

| deferred                                                                                                  | card                        |
| --------------------------------------------------------------------------------------------------------- | --------------------------- |
| the removal endpoint + the three deletions, in order, idempotent                                          | **MOTIR-2165** (motir-ai)   |
| the queue table, the four triggers, cancel-on-reconnect, the window constant                              | **MOTIR-2166** (motir-core) |
| the cron that drains the queue through the seam                                                           | **MOTIR-2168** (motir-core) |
| the reconciliation backstop + the pre-existing cascade orphans                                            | **MOTIR-2169** (motir-ai)   |
| stating the window on the disconnect / archive / delete surfaces                                          | **MOTIR-2171** (motir-core) |
| carrying this decision back into motir-ai's `codeRepoService` pointer and the `codeRepoOffboarding` guard | **MOTIR-2163** (motir-ai)   |

Per `notes.html` #50, **this section ships nothing** and is not a precondition any of those cards may
assume is present.

**Account closure is out of scope and is not a deferral** — Motir has no account-closure operation to
hang a trigger on. When one is built, it inherits the workspace arm (immediate, no window) for every
workspace it removes; that is a line in that feature's own design, not an unfiled card here.

**No design amendment is owed.** The rule that a decision introducing a new affordance must spawn one
(`notes.html` #143) was evaluated, not skipped: every trigger above is an existing control, and MOTIR-2171
adds body copy to dialogs that already ship. That card carries its own instruction to STOP and file a
design card if the copy turns out to need an element the dialogs cannot express.

### §14.7 — Sources

**Read 2026-08-05.** §13's list is pinned to 2026-08-02–03 and is deliberately left alone.

- `motir-core`: `lib/services/projectsService.ts` (`archiveProject`, its terminal-lifecycle comment, and
  the `projectRunnerGroupService.deleteQuietly` post-commit precedent) · `lib/services/workspacesService.ts`
  (`deleteWorkspace`) · `lib/services/gitlabConnectionService.ts` (`disconnectProject`, `disconnect`) ·
  `lib/services/githubInstallationService.ts` (`deleteExcept`) · `lib/jobs/definitions/` (`system.attachment-gc`,
  `system.automation-retention-sweep`, `system.ci-runner-reap` — the shipped sweep shapes).
- `motir-ai`: `src/codegraph/graphSnapshotStore.ts` (`prune` `:376-377`, `snapshotPrefix` `:479`,
  `DeleteObjectsCommand` `:62`) · `src/codegraph/graphCacheManager.ts` (`:28`, the file left on disk) ·
  `src/services/codeRepoService.ts` (MOTIR-2161's header block) · `src/app.ts` (the `/v1` table; no
  scheduler anywhere in `src/`) · `prisma/schema.prisma` (`AiProject` `:75`, `CodeRepo` `:156`, the
  "rebuildable-only" comment).
- **Sourcegraph docs** — configurable code-graph data retention policies, and a removed repository's data
  kept on disk against re-add: <https://sourcegraph.com/docs/code-search/code-navigation/explanations/uploads>
  and <https://docs.sourcegraph.com/admin/how-to/remove-repo>.
- **GitHub Marketplace terms** — the provider deletes the user's data _"within its defined window"_:
  <https://docs.github.com/en/site-policy/github-terms/github-marketplace-terms-of-service>.
- `notes.html` **#50** (a decision ships nothing), **#143** (a new affordance owes a design amendment),
  **#185** (enforcement in terms the product controls), **#206** (a method with no caller is not a path),
  **#223** (a deferral is a card filed in the same action — written about §11 of this file).

## §15 — Decision 11 — the container may be handed its PREVIOUS snapshot (MOTIR-3252)

**Appended 2026-08-20.** §4's rule is unchanged and this is an instance of it, not an exception:
the container's isolation is credential SCOPE, and this adds a third **pre-signed URL**, not a
third kind of credential.

**What changed.** An index run has always rebuilt the whole tree, because that is the only thing
the container could do: the engine's incremental call needs the PREVIOUS graph, and the container
holds no object-storage credential to fetch it with and no database credential to look up its key.
Both of those are §4/§5 decisions and neither is being relaxed. Instead **motir-ai — which has the
`CodeRepo` row and the bucket — resolves the key and mints a single-key, `GET`-only, minutes-long
grant**, returned alongside the run credential motir-core already fetches at dispatch
(`POST /v1/code-graph/run-credential`) and forwarded into the spec as `MOTIR_INDEX_SNAPSHOT_URL`.

So the boot contract is four variables, or five. (§18 briefly made it six; §19 withdrew that and
the sixth variable is gone.) Everything §10 and §5 list as ABSENT is still absent: no GitHub App key, no installation token, no `DATABASE_URL`, no object-storage credential,
no service token, no Fly token.

**Why it is worth the fifth variable.** Measured on a dev box, ten changed files in motir-core sync
in **0.7 s / 256 MB** against **32.0 s / 1191 MB** for the rebuild the fleet performs today — and
the fleet performs it on every debounced push, per repo, per project.

**Three conditions, all decided rather than defensive.** The grant is offered only when a snapshot
exists AND its stored `codegraphVersion` is the engine the container will run AND the grant mints.
The middle one is `prisma/schema.prisma`'s _"a `codegraphVersion` bump forces a re-index"_, kept at
the only layer that can see the column — and it is the **one sanctioned rebuild trigger**: there is
deliberately no drift threshold and no "rebuild if the diff is large" branch (MOTIR-3249,
decision 1). The third degrades to a full build rather than failing the dispatch: a run with no
snapshot indexes correctly, just slowly, and turning "object storage hiccuped" into "this repo is
not indexed" would be strictly worse than the rebuild it replaces.

**The container's side of the same decision** (MOTIR-3253, in `motir-ai`): the run verifies the
snapshot exactly as `graphSnapshotStore.pull` does — decompress, then check the SHA-256 the object
carries — and **falls back to a full build that SUCCEEDS** on every disappointment: pruned (only
the latest three survive), expired, truncated, unverifiable, tampered, unreachable, or an engine
that will not open it. A stale pointer must never turn a refresh into a failed job. The restored
snapshot lands inside the run's work directory, so §5's retention invariant — _"delete everything,
always"_ — covers it by construction rather than by a second rule.

**What this does NOT decide.** The warm per-org sync worker (MOTIR-3254 through MOTIR-3256) is a
separate question and a separate amendment: it would replace _one container, one repo, then it dies
holding nothing_ with _one machine, one org, over time_, which is a change to §4's isolation
argument and to §5's retention invariant. Nothing here touches either. This decision is about a
per-run container that still dies holding nothing.

## §16 — Decision 12 — the warm per-org sync worker (MOTIR-3254)

**Appended 2026-08-20.** MOTIR-3249 settled the worker's OUTLINE — per-org, its own org's syncs
only, never cross-org, expiring when idle. This section settles what that costs and what it
forces, because **two of this file's written invariants do not survive it unchanged** and a
container that quietly breaks them is worse than no worker at all.

It ships no behaviour. §16.5 names the card that implements each part.

### §16.0 — The measurement everything below rests on

`indexer-v0.3.0`, production, 2026-08-20, seven refreshes across two repos and two projects
(MOTIR-3250 carries the full table). The sharpest single row — motir-core, an already-indexed
repo, a two-file push:

```
sync:   filesChecked 3570 · filesAdded 1 · filesModified 1 · nodesUpdated 33
phases: fetch 14075 · snapshot 3083 · build 124364 · compress 5448 · upload 1274
total:  148 369 ms
```

**Two files changed; 124 seconds in the build phase.** The same 3 569-file tree syncs in **5.3 s**
on a warm local process, and that box's _full build_ of it takes 41 s against production's ~124 s
— so production is **3× slower at parsing and 23× slower at syncing**. A gap that is not
proportional to the work is not the algorithm. What remains is per-container and cold: a 2-vCPU
machine, an empty page cache, a freshly extracted tree, an engine loading its grammars and opening
a ~100 MB SQLite from scratch, every single run.

**So the worker's value is NOT what MOTIR-3249 assumed.** The parent says _"the saving is not boot
time — it is the data movement a per-sync container repeats."_ The data movement is 14 s in and
6.7 s out: **14 % of the run.** The other ~84 % is work redone from cold, which is neither boot nor
bytes. A worker sized to save 20 s and one sized to save 135 s are different machines with
different idle policies, and every number below is derived from the second figure.

### §16.1 — Q1 · Isolation, which §4 makes a property of the CREDENTIAL

§4's rule is _"every container the fleet boots carries only narrowly-scoped, short-lived
credentials, whatever its workload."_ **The worker keeps it, and the mechanism is that the worker
is PUSHED work and never picks any up.**

**Decision: there is no job pickup.** The control plane hands the worker one job at a time — a
`repoRef`, the pre-signed snapshot GET, a pre-signed tarball URL when its checkout is cold, and a
run credential scoped to `(aiProject, repoRef, run)` exactly as a per-sync container gets today.
The worker holds no queue reader, no job list, no credential that names an org, and no way to ask
for work. **Cross-org pickup is impossible by construction because there is no pickup** — which is
what the card asks for, and it is a stronger property than an authorization check on a pull.

**The boundary is the ORG**, not the workspace and not the project: org is where Motir's tenancy
actually binds — billing, offboarding (§14) and metering (§7) all key on it, so a machine that
never crosses one crosses nothing that matters. An org with fifty repos does not need fifty warm
checkouts to be worth having; the disk is bounded and evicted LRU (§16.2).

**What a compromised worker reaches, stated plainly.** A per-run container today: one repo's
source and one snapshot key, for minutes, then it dies holding nothing. A warm worker: **one
org's source and the graphs derived from it, for as long as it lives**. That is strictly more
reach, and it is the price of the change rather than a detail of it. It is bounded by three
things and no others — one org per machine (enforced at provision, never by filtering), no
credential at rest that outlives the job it was handed, and a lifetime measured in minutes
(§16.3).

**⚠️ §14 GAINS A FOURTH DELETION, and this is not optional.** Offboarding removes the snapshot,
then the local root, then the coordination row, in that order and for the reason §14.4 gives. A
warm worker is a **fourth place a tenant's source lives**, and it is the only one that is not
reachable from a database row. An offboard that leaves a live worker holding the source of the
project it just erased is the failure §14 exists to prevent, arriving through a door §14 did not
know about. **No card owns this today** — see §16.5.

### §16.2 — Q2 · Retention, which the worker contradicts by design

`runIndex.ts` states it as _"delete everything, always"_, on the ground that _"a container's disk
is not private: it is a rootfs on shared infrastructure, and the machine may be paused rather than
destroyed."_ A worker keeps tenant source **precisely so it does not have to re-fetch it**. The
invariant is therefore amended here, in writing, as MOTIR-3249 required — not excepted.

**The amendment.** The invariant was never really "delete after every run"; that was the shape it
took when the boundary and the run were the same thing. What it protects is:

> **No tenant's data outlives the boundary it was fetched for, and no boundary spans two tenants.**

For a per-run container the boundary IS the run, and the old wording and the new one describe the
same behaviour — `runIndex.ts` is unchanged and stays the invariant's home for that path. For a
worker the boundary is **its own lifetime, within one org**. So the worker: holds one org's data
and never a second org's; deletes everything when it expires; and can be made to delete on demand
when that org offboards (§16.1).

**The compensating controls, which are what make the amendment more than a relabelling:**

1. **One org per machine**, decided at provision — a worker is never re-pointed at a second org.
2. **A bounded lifetime**, in minutes (§16.3), so "as long as it lives" is a short sentence.
3. **No credential at rest.** Every credential is per-job and expires in minutes; a worker at rest
   holds source and graphs, never a key to fetch more.
4. **Expiry DESTROYS the machine rather than stopping it.** The rootfs goes with it. A stopped or
   suspended machine keeps its disk, which is the exact case the original invariant's own sentence
   was written against.
5. **Offboarding reaches it** (§16.1).

**And the eviction bound:** a worker holds at most the checkouts and graphs it can serve, evicting
least-recently-used when its disk fills. An org with fifty repos gets a warm few, not fifty — and
a cold repo on a warm worker is served exactly as it is today, by fetching.

### §16.3 — Q3 · Idle policy: DIE AFTER N. Suspend is rejected

**Decision: die after N seconds idle, N derived below. Suspend/resume is rejected on three
independently sufficient grounds**, and the card's instruction to _"investigate SUSPEND first"_ is
discharged by investigating it and finding it unavailable rather than by adopting it.

1. **The port cannot express it, and its Fly adapter reads it as death.**
   `ContainerOrchestrator` has exactly three operations — `provision`, `teardown`, `describe`
   (`lib/orchestrator/types.ts`). There is no suspend and no resume. Worse:
   `flyMachines.ts` has `TERMINAL_STATES = new Set(['stopped', 'suspended', …])`, so a suspended
   machine reads to the dispatcher as a container that has **finished**. Adding suspension means
   new port operations and a change to that set — which CI runners share.
2. **Motir's own meter would not benefit.** `ContainerAccrual.accruedSeconds` is
   `ceil(observedAt − startedAt)` (`billableSecondsFor`) — **wall clock, not running time**.
   Suspending stops Fly's CPU/RAM invoice; it does **not** stop the number this project reports as
   its own COGS. _"A suspended machine stops accruing"_ is false of Motir's meter as it stands,
   and making it true is a change to the accrual model, i.e. MOTIR-3255's territory, not a free
   property of the platform.
3. **It fights §16.2.** A suspended machine keeps its rootfs **and** a memory snapshot,
   indefinitely — _"the machine may be paused rather than destroyed"_, which is the sentence the
   retention invariant was written against, quoted back at us.

**And the benefit is not guaranteed even where it applies.** Fly's own documentation: starting a
suspended Machine _"will attempt (but is not guaranteed) to resume the Machine from the snapshot,
rather than performing a cold boot"_, and stopping a suspended Machine _"will invalidate its
snapshot"_. A policy whose saving is best-effort cannot carry a break-even.

**⚠️ The known "a stopped machine restarts itself" trap does not apply here, verified rather than
assumed.** That trap is `http_service` + `auto_start_machines` + a public hostname — Fly's proxy
restarting a machine on inbound traffic. `motir-index-runners` has no public route and is
orchestrator-managed; nothing routes to it. It is also moot under this decision, which destroys
rather than stops.

**N is DERIVED — and NOT from the fetch cost, which MOTIR-3254 asked for before the numbers
existed.** The fetch is 14 s, 9 % of a run; an N computed from it would be an order of magnitude
too small. The quantity a warm worker actually saves is the whole cold cost:

| saved by staying warm                                        | seconds  |
| ------------------------------------------------------------ | -------- |
| fetch + extract                                              | 14.1     |
| snapshot GET + restore                                       | 3.1      |
| the cold half of the build (124.4 measured − ~5.3 warm)      | ~119.1   |
| **total avoided per warm sync**                              | **~136** |
| still paid, warm or cold (compress + upload + control plane) | ~6.8     |

Idling and working are the same machine class at the same rate
(`performance-2x / 8192 MB`, `$0.000031636049`/s), so the seconds compare one to one:

> **Idling N seconds costs N seconds. Serving one sync warm saves ~136. So the break-even is
> N ≈ 136 s, at a sync-arrival probability of 1 — which means N must be materially BELOW that to
> be positive under uncertainty.** At N = 60 s the policy pays whenever a second sync arrives
> within the minute more than 44 % of the time.

**Observed arrival, same evening, one active development session:** refreshes at 21:41, 21:42,
21:44 (×2), 21:47, 22:01, 22:30 — gaps of 1, 2, 3, 14 and 29 minutes. Bursts of a few minutes,
then nothing. **A short N captures the burst and expires before the silence**, which is exactly
the shape the arrival data has. **Recommended starting value: N = 90 s**, tunable by env, with
the invariant — _N < the measured cold cost it avoids_ — recorded as the thing that must stay
true when the number is tuned.

### §16.4 — Q4 · What the admission cap means for a worker

**A worker must NOT hold an index slot for its whole life.** `DEFAULT_INDEX_IN_FLIGHT_CAP = 6` is
index fairness under the fleet ceiling, and six idling workers would hard-cap indexing at zero —
which is precisely the failure `limits.ts` records against the job's old `concurrency: 2`, _"which
under the stepped supervision shape would have held its Inngest slot for the CONTAINER'S WHOLE
LIFE."_ Repeating it one layer down would be the same mistake with a new name.

**Decision, in three parts:**

1. **The SYNC still takes an index slot.** A sync served by a worker is index work and is admitted
   exactly as a per-sync container is, so §7's fairness math is untouched and the existing
   per-tenant relation (`ceil(global / 2)`) keeps meaning what it means.
2. **The worker's IDLE LIFE takes a worker slot, from its own ceiling** — a fourth workload with
   its own bound (`MOTIR_FLEET_MAX_WARM_WORKERS`), so "N orgs become N permanent machines" is
   answered by a number an operator sets rather than by the org count.
3. **Admission for a worker FAILS CLOSED to a per-sync container.** Over the worker ceiling, the
   sync is served the way it is served today. MOTIR-3256 already requires that fallback for
   availability; it is also what keeps this ceiling safe to set low.

**The fleet-wide ceiling still binds everything.** `MOTIR_FLEET_MAX_IN_FLIGHT = 24` counts a
worker like any other machine, and §7.2 is why that matters more here than anywhere else: there is
**no provider-side spend cap** underneath it — _"there's no soft ceiling. If you go over, we'll
bill you."_ A long-lived machine class makes Motir's own counter the only thing between an idle
policy bug and an invoice, so the worker ceiling is a spend control, not a tuning knob.

### §16.5 — Which card implements what, and the one that does not exist

| part                                                                           | card                                   |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| the sync path the worker rides on                                              | **MOTIR-3251 / 3252 / 3253** — shipped |
| the measurement every number here is derived from                              | **MOTIR-3250** — shipped               |
| attribution when one handle serves many repos, incl. **who owns idle seconds** | **MOTIR-3255**                         |
| the worker itself: provision per org, pushed jobs, die-after-N, fallback       | **MOTIR-3256**                         |
| **§14 offboarding reaching a live worker's checkout**                          | **NONE — a gap, see below**            |

**⚠️ The offboarding gap is filed as a deferral rather than left in prose.** §16.1 establishes that
a warm worker is a fourth home for tenant source and that §14's deletion order must reach it.
Nothing in MOTIR-3249's tree covers it: MOTIR-3256's criteria are about provisioning, scoping,
expiry, metering and fallback, and none of them says the word offboard. **The worker must not ship
before that card exists** — an offboard that leaves a live machine holding the source of a project
it just erased is a data-deletion failure, not a latency one.

### §16.6 — Rejected, with the reasons that make them tempting

- **Suspend/resume** — §16.3, three grounds. Recorded first because the card asked for it
  explicitly and because it is the intuitive answer: keeping the disk _and_ the memory is exactly
  what "warm" means. It fails on Motir's port, on Motir's meter, and on Motir's retention rule —
  each sufficient alone.
- **Per-workspace or per-project workers** — finer isolation, and the tempting evidence is real:
  two projects of the same org indexed the same repo at the same commit within seventeen seconds
  tonight (21:44:01 and 21:44:18). But it multiplies idle machines by the workspace count, and the
  org boundary is where offboarding and billing already bind. **Note what this does NOT license:**
  a per-org worker may reuse a CHECKOUT across projects of the same org, but each `(project, repo)`
  keeps its own graph and its own snapshot — the content-hash dedupe is DECLINED (MOTIR-3249,
  decision 2) and a warm worker is not a reason to re-open it.
- **A worker that PULLS jobs from a queue** — the shape the card's own wording suggests
  (_"picks up sync jobs"_). Rejected: pulling requires a credential naming a scope wider than one
  job, which is the §4 property the entire fleet rests on. Pushing keeps the credential model
  identical to today's.
- **Keep the per-sync container and make the image boot faster** — rejected on §16.0's
  measurement. The cold cost is not boot; it is whole-tree work redone cold, 124 s for a two-file
  diff against 5.3 s warm. A faster boot moves a number that is not in the table.
- **Do nothing.** The honest baseline: a refresh costs ~148 s and the sync path already made it
  correct and bounded. If the worker does not ship, that is what Motir keeps — which is
  substantially better than the ~30-minute runs MOTIR-3245 measured, and is why none of the above
  is urgent enough to justify shipping it without §16.5's missing card.

## §17 — Decision 12 is WITHDRAWN — the warm worker was measured and dropped (MOTIR-3357)

**Appended 2026-08-21, hours after §16.** §16 decided the shape of a warm per-org sync worker. It
was never built, and it should not be: the cost it removes was measured on the fleet's own hardware
and is worth a few seconds of a 148-second run. **§16 stands as a record of a decision that was
correctly reasoned from numbers that did not yet exist, and is superseded here rather than edited —
its isolation, retention and admission analysis remains the right analysis IF a worker is ever
wanted again, and the numbers below are why it is not.**

Cards MOTIR-3256 (the worker), MOTIR-3290 (its runtime), MOTIR-3291 (the port operation) and
MOTIR-3292 (its offboarding obligation) are cancelled. The §14 deletion order is therefore
UNCHANGED and still complete: three homes for tenant source, all reachable from a database row.

### §17.1 — The measurement

One machine of the fleet's own class — `performance-2x / 8192 MB`, `iad`, booted from the
production image `registry.fly.io/motir-index-runners:indexer-0.3.0`, destroyed afterwards — running
the identical script used on a 14-core dev box, over the same generated 3 500-file corpus:

|                                | dev box (14 cores) | **fleet (2 vCPU)** | ratio |
| ------------------------------ | ------------------ | ------------------ | ----- |
| full build                     | 7.58 s             | **208.59 s**       | 27.5× |
| no-op sync                     | 1.57 s             | **3.99 s**         | 2.5×  |
| sync again, SAME process       | 1.64 s             | **4.41 s**         | —     |
| sync with 60× the source bytes | —                  | **7.54 s**         | —     |

### §17.2 — What each row eliminates

- **Process warmth buys NOTHING.** The second sync in a process is _slower_ than the first, on both
  machines, in both rounds (1.05×, 1.10×). There is no grammar, JIT or page-cache effect for a
  resident process to keep. **This removes the mechanism §16 was built on**, and it is the single
  finding that ends the worker.
- **The 2-vCPU machine is not slow at syncing.** It is 27.5× slower at a _full build_ — which is
  real, is CPU-bound, and is exactly why the pre-MOTIR-3251 rebuilds took ~30 minutes — but it
  syncs 3 500 files in **4 seconds**.
- **Byte volume is weak.** Sixty times the source costs 1.9× the sync. The work is per-FILE.
- **File count matches production.** Production reports `filesChecked: 3570`; the corpus is 3 500.

Production's sync build phase is **124.4 s**. That is **16×** the heaviest reproduction available on
identical hardware at the same file count — so it is not the machine, not the boot, and not the
cache. It is work the sync performs on the real corpus, and it is performed on every run, warm or
cold, on any machine.

### §17.3 — What the worker would actually have saved

Read off MOTIR-3250's production phase table for motir-core:

| phase                             | ms          | would a warm worker avoid it?                                                                                                                                                         |
| --------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fetch + extract                   | 14 075      | **No** — the tarball is fetched unconditionally and is how the container learns the new commit; MOTIR-3249 declined changed-path plumbing, so there is no incremental source transfer |
| snapshot GET + restore            | 3 083       | Yes                                                                                                                                                                                   |
| **build (the sync)**              | **124 364** | **No** — measured identical warm and cold                                                                                                                                             |
| compress + upload + control plane | 6 847       | No                                                                                                                                                                                    |

**≈3 s of 148 s, for a resident runtime in motir-ai, a fourth port operation, tenant source living
on a machine indefinitely, a new §14 obligation, an idle-billing policy and per-repo attribution.**

### §17.4 — Where the time actually is, and the lever that reaches it

The sync walks the WHOLE TREE to discover what a push already names. Measured on the real motir-core
tree — 3 570 files, a 202 MB graph — with the two-file change production actually sees:

| operation                              | wall       | touched                           |
| -------------------------------------- | ---------- | --------------------------------- |
| full build                             | 36.95 s    | everything                        |
| whole-tree `sync()` — what ships today | **4.29 s** | checked **3 571** files to find 3 |
| `indexFiles([2 paths])`                | **0.59 s** | **2**                             |

**7.3× cheaper, and the same 27 nodes either way.** That is the next factor, it is larger than
anything the worker would have recovered, and it is **MOTIR-3357**.

⚠️ **This does NOT re-open MOTIR-3249's decision 1 on its own terms.** That decision refused a
GitHub _compare_ call — a network round trip and a credential the container is defined by not
holding — and that refusal still stands. What changed is the observation that **the changed paths
arrive free with the push event that triggers the refresh**: `githubWebhookService` reads that
payload today and discards the file lists. No compare, no credential, no new grant.

### §17.5 — What §16 leaves behind that is still true

- **§16.0's measurement** — the phase table, and that the build phase is 84 % of a refresh.
- **§16.3's finding on `accruedSeconds`**: it is `ceil(observedAt − startedAt)`, wall clock rather
  than running time, so Motir's COGS meter would keep accruing through any suspension. That is a
  property of the meter and outlives the worker.
- **MOTIR-3255's attribution model shipped and is unaffected.** Per-sync slices under one handle,
  idle derived and owned by the org: no workload emits slices today, every current row is written
  exactly as before, and the record is ready if a multi-repo handle ever exists.
- **The one-container-per-sync shape is CONFIRMED, not merely retained.** Boot, fetch, ship and die,
  with the sync in the middle — §5's shape, now with a number under it.

## §18 — Decision 13 — the container may be told WHICH PATHS changed (MOTIR-3358)

**Appended 2026-08-21, after §17.** §17 withdrew the warm worker because the sync's cost is not
process warmth. §18 is what the same measurements pointed at instead — and like §15, it is an
INSTANCE of §4's rule rather than an exception: the container is handed a list of file paths from a
repository it is already being handed in full. No new credential, no new grant, no widening.

**What the number is.** On the real motir-core tree (3 570 files, a 202 MB graph, the two-file push
production actually sees, measured 2026-08-21):

| operation                             | wall       | files touched                   |
| ------------------------------------- | ---------- | ------------------------------- |
| full build                            | 36.95 s    | everything                      |
| whole-tree `sync()` — today's refresh | **4.29 s** | checked **3 571** to find **3** |
| `indexFiles([the 2 changed paths])`   | **0.59 s** | **2**                           |

**7.3× cheaper, and the same 27 nodes either way.** In production the walk IS the run: 124 s of a
148 s refresh, because a 2-vCPU fleet machine is I/O-bound against a 202 MB graph (§17.1: 7.7× the
graph costs 5.67× the sync there, against 1.27× on a dev box).

**Where the list comes from, and why it is free.** Every refresh is triggered by a push webhook, and
GitHub's push payload names each commit's `added` / `modified` / `removed`. `githubWebhookService`
reads that payload today and throws the file lists away. So this is not a new input — it is one
Motir already receives and discards.

**⚠️ This does NOT re-open MOTIR-3249's decision 1.** That refused a GitHub _compare_ API call: a
network round trip on the dispatch path and a credential the container is defined by not holding.
The refusal stands, and nothing in §18 calls GitHub.

### §18.1 — The list cannot ride the event, and that is structural

The obvious design puts the file list on the `system.code-graph-refresh` event. It cannot work.
`codeGraphRefresh` debounces two minutes per `(installation, owner, repo)`, and **a debounce
delivers exactly ONE event — the LAST one** (`tests/jobs/debounce-burst.test.ts`). A run standing
for four pushes would carry one push's paths, index those, and leave the other three pushes' files
stale — in a graph no reader can tell is stale, feeding every planner answer built on it. And
coalescing is the NORMAL case, not the edge: the window is two minutes.

So each push **appends a row** to `code_graph_pending_change` and the run **drains every row for its
repo**; the union is the delta it may index.

### §18.2 — The drain is a CLAIM, and the failure direction is the whole design

A run that took these rows and then failed must not consume them: their files would stay stale
forever, invisibly. So the shape is **claim → index → delete-on-success / release-on-anything-else**
— the same posture `fleet_in_flight_slot` takes, and for the same reason: what is being protected is
not the row, it is the work the row stands for. Claims older than an hour are reclaimable, so a
crashed supervisor cannot strand a repo; reclaiming early costs one whole-tree sync, which is what
happens today anyway.

**⚠️ The claim is held under the TRIGGER's event id, never `ctx.runId`.** `ctx.runId` is re-derived
on every Inngest pass, and the claim is taken before the first container while the settle runs many
passes later — so a claim held under it can never be settled. This is the same cross-pass identity
the admission slot uses (§9), and the two are now computed once at the top of the handler and shared
so a later edit cannot drift one of them back.

### §18.3 — Every ambiguous case declines the list

The asymmetry that governs this whole decision: **an incomplete list produces a graph that is
quietly wrong and that nothing downstream can detect, while NO list costs a whole-tree sync — which
is exactly what ships today.** The fast path is the optional one. So the run carries no list when:

- any push in the window arrived without a file list (a force-push, or a payload GitHub truncated at
  its 20-commit cap) — recorded as an EMPTY row, deliberately, so it poisons the union it belongs to
  rather than leaving the other rows looking complete;
- there is no head sha to pin the tree to;
- the union exceeds 500 paths — the crossover MOTIR-3249 measured at the other end, where a
  2 481-file diff synced SLOWER than a rebuild.

### §18.4 — The paths and the commit travel together

A path list describes a TREE. An unpinned tarball is whatever the branch points at when the
CONTAINER fetches it — later than the dispatch, and possibly a commit those paths do not describe —
so indexing "exactly these paths" against it would leave whatever landed in between stale. **When
the dispatch carries a list it resolves `/tarball/{headSha}`; when it does not, it resolves the
branch, exactly as before.** The pairing is the correctness argument, not a refinement of it.

### §18.5 — The boot contract is now four variables, and at most six

§15's fifth (`MOTIR_INDEX_SNAPSHOT_URL`) is joined by a sixth, `MOTIR_INDEX_CHANGED_PATHS`. It is
neither a credential nor a secret, and it is an OPTIMISATION: **a container that ignored it entirely
would produce exactly the same graph, more slowly.** Everything §10 and §5 list as ABSENT is still
absent — no GitHub App key, no installation token, no `DATABASE_URL`, no object-storage credential,
no service token, no Fly token.

The container's side is MOTIR-3357 (`motir-ai`): given the list, the run calls the engine's
`indexFiles()` against the restored snapshot instead of `sync()`. Until that ships, the variable is
set and ignored — which is precisely the degradation this section is built around.

## §19 — Decision 13 is WITHDRAWN — the changed-path list was measured and dropped (MOTIR-3380)

**Appended 2026-08-22, a day after §18.** §18 decided that a run should be told WHICH PATHS changed
so it could index exactly those instead of walking the tree. The producer shipped (MOTIR-3358); the
consumer never did. **Measured on the fleet's own hardware, the saving does not exist**, and §18 is
superseded here rather than edited — its reasoning was correct from the numbers available at the
time, and the numbers below are why it is not being built.

Cards MOTIR-3357 (the motir-ai consumer) and MOTIR-3358's machinery are cancelled and removed.
**§4's credential scope and §5's retention invariant are unaffected** — nothing persistent was ever
added — and the boot contract returns to §15's four variables, or five.

### §19.1 — The measurement

Real motir-core tree (3 570 indexed files, **232 MB graph**), engine 1.5.0, one machine of the
fleet's own class — `performance-2x / 8192 MB`, `iad`, destroyed afterwards. **The run order was
alternated**, because page-cache warmth had already flattered an earlier comparison:

| run                                       | wall       | filesChecked |
| ----------------------------------------- | ---------- | ------------ |
| whole-tree `sync()` _(whole-first)_       | **7.79 s** | 3 571        |
| scoped `sync({ paths })` _(whole-first)_  | **7.70 s** | **2**        |
| scoped `sync({ paths })` _(scoped-first)_ | **7.92 s** | **2**        |
| whole-tree `sync()` _(scoped-first)_      | **7.77 s** | 3 571        |

**Checking 2 files instead of 3 571 saves nothing, and is slower in one direction.** Both are inside
the noise; the alternation is what makes that a result rather than an artifact.

### §19.2 — Why, and what it means for the next person who has this idea

The tree walk was never the cost at production scale. The ~7.8 s is spent **opening, resolving
against and writing back a 232 MB graph** — work that happens whether the run names two paths or
every path. A changed-path list has nothing left to remove.

⚠️ **This is a different failure from §17's.** §17 dropped the warm worker because process warmth was
not the lever. §18 fell to the same class of mistake one level down: an optimisation aimed at a cost
that is not the dominant one. **The dominant cost of a refresh is the graph, not the tree.**

### §19.3 — Three measurements, each true, none of production

Worth recording, because each was a real number that pointed the wrong way:

1. **7.3×** — the figure §18 was written on. It compared **nodes only**; edges were never checked,
   and the engine call it used (`indexFiles`) silently drops the re-indexed file's `calls` /
   `imports` / `instantiates` edges. Wrong API, and a graph that was worse rather than cheaper.
2. **1.75×** — the right API (`sync({ paths })`, engine 1.5.0+), edge-for-edge correct, measured on
   a 14-core dev box.
3. **1.0×** — the same comparison at production scale.

The dev box's advantage came from a **17 MB** graph. §17 had already concluded that graph SIZE drives
fleet cost, and every measurement before the last used a corpus too small to test it. **Measure the
real tree on fleet hardware, or the number is about something else.**

### §19.4 — What survives

- **The engine upgrade is the win instead (MOTIR-3376).** codegraph 1.1.6 → 1.5.0 takes the
  production refresh's dominant phase from **~124 s to ~7.8 s (~16×)** with no changed-path plumbing
  at all, because 1.5.0 sizes its worker pools from the container's allowance rather than the host's.
- **MOTIR-3249 decision 1 is vindicated twice.** It refused a GitHub `compare` call to obtain changed
  paths. Not only was the credential and round trip unnecessary — the paths themselves were worthless.
- **motir-ai keeps `tests/codegraphChangedPaths.test.ts`**, the executable record that `indexFiles`
  drops resolved edges on both 1.1.6 and 1.5.0. Unused code, deliberately kept: it is the cheapest
  way for the next person to learn this without re-deriving it.

## §20 — §9.1's warning, RE-TAKEN against the shared fleet: every `isMeta` branch dispositioned, and Decision 8 re-affirmed in its internal-accounting form (MOTIR-4543, 2026-09-12)

**Dated 2026-09-12. Measured at `motir-core` `0e35d4cbc` and `motir-ai` `8ca2138`.** Nothing above this line is edited; §9 and §9.1 stand as written, and this section says what has changed since them.

> ⚠️ **Motir does not charge for code indexing.** This section describes an internal allowance and internal cost accounting, never a customer charge. It is the sentence a later reader should be able to quote out of it.

§9.1 filed a warning against its own Decision 8: `isMeta` is a **billing** flag that had been used as a proxy for _"this workload is not real"_, and that proxy stops being safe the moment meta shares infrastructure with customers. **Decision 7 shipped, so that condition is today's condition.** §9.1 could not dispose of the branches it warned about — _"whether `ciFleetCostMeterService`'s CI bypass should change is not decided here"_ — and this section does.

### §20.1 — The rule, in one sentence

**`isMeta` may suppress a CHARGE, a PRICE, an ENTITLEMENT CAP, a PAYWALL or a REFUSAL — it may never suppress a MEASUREMENT, and it never decides WHERE work runs.**

### §20.2 — The enumeration, with its commands

```
# motir-core @ 0e35d4cbc
git grep -n 'isMeta' 0e35d4cbc -- lib app scripts packages     # 139 hits in 46 files

# motir-ai @ 8ca2138 — the flag as it arrives on the job-submit envelope
git grep -n 'isMeta' 8ca2138 -- src scripts                    #  30 hits in 11 files
```

Tests are outside both path sets on purpose: a test that names the flag asserts a branch, it is not one.

**Of the 169 hits, 13 are BRANCHES** — a conditional whose outcome depends on the flag. Every one is dispositioned in §20.3. The other **156** are comments, types, propagation onto the envelope, queries and seed data; every one of them is accounted for, per file, in §20.6, and those tables sum to the two counts above.

### §20.3 — The branches and their dispositions

Three dispositions, and only three: **CORRECT AS IT STANDS** (suppresses a charge or an entitlement and nothing else) · **CORRECT AND NOW DEAD** (also suppresses a measurement, but unreachable — with the premise and what would revive it) · **WRONG AND OWED A FIX** (suppresses a measurement on a reachable path — with the card that fixes it; this section fixes nothing).

**motir-core — 11 branch lines:**

| #   | branch (`0e35d4cbc`)                                                                                                          | what it suppresses                                                                                                                              | disposition                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | `app/(authed)/settings/organization/billing/_components/BillingClient.tsx:66` — `isBillingExempt` returns `data.isMeta`       | the billing storefront — a price and a charge                                                                                                   | **CORRECT AS IT STANDS**                      |
| 2   | `app/(authed)/settings/organization/usage/_components/OrgUsageClient.tsx:58` — `planningIsCreditGated` returns `!data.isMeta` | the _planning is paused_ credit-gate framing; the usage figure itself renders for every org (the ternary that hid it was deleted by MOTIR-4572) | **CORRECT AS IT STANDS**                      |
| 3   | `lib/billing/entitlements.ts:150` — `pmTierForOrg` → `'meta'`                                                                 | seat and entitlement caps                                                                                                                       | **CORRECT AS IT STANDS**                      |
| 4   | `lib/services/entitlementsService.ts:267` — `hasUncappedOrg` includes `o.isMeta`                                              | entitlement caps                                                                                                                                | **CORRECT AS IT STANDS**                      |
| 5   | `lib/services/billingService.ts:252` — `if (org?.isMeta) return notApplicableAiAccess()`                                      | the AI paywall                                                                                                                                  | **CORRECT AS IT STANDS**                      |
| 6   | `lib/services/ciActionsGateService.ts:101` — `{ outcome: 'bypassed', reason: 'meta' }`                                        | the CI Actions dispatch gate — a refusal                                                                                                        | **CORRECT AS IT STANDS**                      |
| 7   | `lib/services/ciAllowanceService.ts:143` — pool accounting returns `state: 'bypassed'`                                        | the CI minutes POOL — an entitlement. The zero figures it returns sit under `applicable: false` and are never rendered as figures               | **CORRECT AS IT STANDS**                      |
| 8   | `lib/services/ciAllowanceService.ts:256` — overage charge `{ outcome: 'bypassed', reason: 'meta' }`                           | the CI overage charge                                                                                                                           | **CORRECT AS IT STANDS**                      |
| 9   | **`lib/services/ciMinutesMeterService.ts:305` — `bypassed_meta`, returned BEFORE the usage row is written**                   | **the minutes MEASUREMENT itself**                                                                                                              | **WRONG AND OWED A FIX — MOTIR-5283** (§20.4) |
| 10  | `app/(admin)/admin/tenants/[orgId]/page.tsx:127` — the `isMeta` chip                                                          | nothing — it displays the flag to platform staff                                                                                                | **CORRECT AS IT STANDS**                      |
| 11  | `app/(admin)/admin/tenants/page.tsx:168` — the `isMeta` chip                                                                  | nothing — display                                                                                                                               | **CORRECT AS IT STANDS**                      |

**motir-ai — 2 branch lines:**

| #   | branch (`8ca2138`)                                                                                       | what it suppresses                                                                                                                                                                                 | disposition              |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 12  | `src/jobs/worker.ts:120` — `assertHasCredits`: `if (isMeta) return;`                                     | the worker's out-of-credits **refusal**. The debit is still written — the function's own comment: _"its balance may even go negative; the gate ignores it"_ — so meta's token usage stays measured | **CORRECT AS IT STANDS** |
| 13  | `src/services/gatewaySyncService.ts:331` — `hasCredits = (org?.isMeta ?? false) \|\| balanceCredits > 0` | the gateway pre-flight **refusal**                                                                                                                                                                 | **CORRECT AS IT STANDS** |

**Two conditionals that look like branches and are not policy**, named so a reader re-running the command does not have to rediscover it: `motir-ai` `src/envelope.ts` tests the RAW wire value's type (`tenant.isMeta must be a boolean when present`), and `src/services/aiOrganizationService.ts` `syncOrgFlags` skips a write when the stored flags already equal core's. Neither decides anything about a meta org.

**No branch is CORRECT AND NOW DEAD.** The candidate for that disposition — row 9 — is reachable, which is §20.4.

### §20.4 — The two branches §9.1 left undecided, by name, with the premise re-read

§9.1 left both on one premise: **meta CI never reaches the fleet.** It is re-read here rather than inherited.

**The premise, re-read 2026-09-12: TRUE TODAY — and held on the LABEL axis, not by `isMeta`.**

- The fleet provisions a runner only for a job whose requested labels name the Motir runner: `ciRunnerProvisioningService` returns `not_fleet_job` unless `isMotirFleetJob(event.requestedLabels)`. `lib/ciFleet/config.ts` states the axis outright — _"⚠️ AND NOT BY TENANT FLAG. `Organization.isMeta` (§4.4) and `moooon-B-V` (a GitHub org) are DIFFERENT AXES that happen to coincide today."_
- Motir's own workflows request no such label: `git grep -nE "runs-on:.*motir" <ref> -- .github` returns **0** in `motir-core` @ `0e35d4cbc` and **0** in `motir-ai` @ `8ca2138`; both run `ubuntu-latest`.
- **What would make it false, and it is one provisioning away:** repositories Motir provisions read `runs-on: ${{ vars.MOTIR_RUNNER || 'ubuntu-latest' }}` (`config.ts`, §N's portability seam). The first meta-org project Motir provisions puts meta CI on the fleet — and no `isMeta` branch anywhere prevents it, correctly (`fleetCeilingService`: _"`isMeta` does NOT lift it"_).

**`ciMinutesMeterService`'s `bypassed_meta` → WRONG AND OWED A FIX (MOTIR-5283).** It returns **before the measurement**, and the premise does not protect it, because this meter is not fleet-only: it meters Actions wall-clock for connected repositories, GitHub-hosted runs included. So it fires on every meta workflow run that reaches it — real Motir spend, paid on the GitHub bill and recorded nowhere in Motir. And on the day the premise fails, `ciFleetCostMeterService` records the meta org's container COGS (it has no bypass) while this meter records no minutes, leaving `getOrgPeriodCostBasis`'s denominator empty for exactly that org. **The fix is to move the bypass from the measurement to the charge — and the charge is already bypassed twice** (rows 7 and 8), so recording the row charges nothing. MOTIR-5283 carries the criteria.

> **FIXED — MOTIR-5283, 2026-09-13, and "bypassed twice" was half true.** Row 7 reads `isMeta` itself. **Row 8 does not**: `chargeForMeteredRun`'s `meta` bypass is keyed on an optional `isMeta` ARGUMENT, and its one production caller (`githubWebhookService.handleWorkflowRun`) never passed it — safe only while row 9 kept a meta run from ever reaching that call. Deleting row 9 alone would have charged moooon B.V. for every minute past its pool. So the fix is two edits, not one: the meter writes the row for a meta org and carries `isMeta` out on its `metered` outcome (the `bypassed_meta` outcome is gone), and the webhook hands that flag to the charge. `tests/ciMetering/ciMinutesMeterService.test.ts` pins both halves through the webhook seam — a 1,200-minute meta run is recorded, writes no `ci_period_charge` row, and leaves the entitlement `bypassed`.

**`lib/ciMetering/allowance.ts`'s `bypassed` state → CORRECT AS IT STANDS.** Its one hit is the state's own doc comment — _"`isMeta`, or `MOTIR_CLOUD=false` — no pool accounting at all"_. It is the value row 7 returns: the absence of an entitlement pool. It suppresses no measurement; the measurement is the meter's, above.

**The worked example — `ciFleetCostMeterService` has NO `isMeta` branch at all.** MOTIR-1995 removed it on purpose, and the module header records why: meta indexing runs on the shared fleet, so a bypass would mean _"real Fly spend with no row"_, and meta's cost is readable as its own line instead (`getMetaPeriodCostSplit`). Its six hits are all comments. That is what a correct disposition looks like, and row 9's fix makes the minutes meter look the same.

### §20.5 — Decision 8, re-taken: the charge decision (MOTIR-4541)

**Re-affirmed, not inherited — decided 2026-09-05 and amended twice on 2026-09-12, by Yue.** Transcribed in MOTIR-4541's own terms.

**The option: absorb, in INTERNAL-ACCOUNTING form — two separate pools, a soft gate that reports rather than blocks, and hard gates that stop. Motir does not charge for code indexing, does not say that it does, and never announces otherwise.**

| pool                | drawn by                          | the customer sees                                     |
| ------------------- | --------------------------------- | ----------------------------------------------------- |
| **credit balance**  | planner · hosted agent            | **yes** — and it is the whole truth about that number |
| **index allowance** | code-graph indexing, nothing else | **no**                                                |

Indexing can never draw the visible balance, under any condition. Internally a tier is costed at the sum; `catalog.ts`'s `allotment.credits` stays the advertised figure.

- **Soft gate — the index allowance.** Crossing it does not stop indexing on a paid tier; Motir absorbs the overrun and records a crossing. It is a calibration instrument, not enforcement.
- **Hard gate A — the visible balance is zero ⇒ indexing stops**, because an org with no credit is not planning. A staleness-gated catch-up runs when the gate lifts.
- **Hard gate B — index COGS reaches the reserved headroom (`agent-lane margin × revenue`) ⇒ indexing stops**, on the list basis, for the safety reason recorded in MOTIR-4541. **Not active yet:** its margin input is undecided (MOTIR-4483, MOTIR-4598), and it is its own task, MOTIR-5280.
- **At a hard stop the graph freezes; it is not withheld** — the planner is told how far behind it is and reaches current source through `read_file`.

**Amended 2026-09-12:**

- **The Free tier:** its index allowance is **one-time**, never re-granted, and **a hard stop** — a zero-revenue tier has no margin to absorb an overrun against. Hard gate B does not apply to it. A shared pool (free-tier indexing drawing the visible credits) was considered and rejected: it would make _"Motir does not charge for code indexing"_ false for that tier.
- **No entitlement gate on cloud:** every connected repository is indexed, and the allowance is what bounds its cost. The previous _no AI plan ⇒ no indexing_ position was withdrawn, because in practice it guaranteed every new organisation's first planning session would be code-blind.
- **A prerequisite this exposed:** the Free tier's one-time credit grant is decided (`billing-tiering.md`) but never issued in code, so gate A currently stops every Free organisation — MOTIR-5281.

**The code-blind argument (MOTIR-1981's rejection of charging indexing to CI credits): INAPPLICABLE.** It was about a refusal blinding a planner by coupling two products through one exhaustion state. Under two pools the planner draws a pool indexing cannot touch, so indexing can never stop a planner; and where indexing stops, `read_file` keeps the planner sighted. The argument has not weakened; it no longer has a subject.

**The triggers that re-open it** — stated against what this story ships:

1. **The soft-gate crossing rate per tier**, read on Monitoring's _Index allowance_ section (MOTIR-4595). Large on a tier ⇒ the gate is mis-derived; still large after recalculating ⇒ the ratio is the wrong instrument and the choice of option is taken again. MOTIR-4588 proposes the threshold and cadence.
2. **Index COGS stops tracking token consumption** — the `index` line of `pnpm ops:fleet-cost` (MOTIR-4540) against token spend for the same period.
3. **Orgs reach hard gate B routinely** rather than as outliers.
4. **The gap between the soft gate and the reserved headroom is thin**, so the absorption the design promises does not exist.

### §20.6 — Every hit that is not a branch, per file

Each count is `git grep -c 'isMeta' <ref> -- <paths>` for that file; the totals equal §20.2's.

**motir-core @ `0e35d4cbc`:**

| file                                                                       |    hits | what they are                                                                          |
| -------------------------------------------------------------------------- | ------: | -------------------------------------------------------------------------------------- |
| `app/(admin)/admin/tenants/[orgId]/_components/ClassificationBar.tsx`      |       1 | comment only                                                                           |
| `app/(admin)/admin/tenants/[orgId]/page.tsx`                               |       2 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `app/(admin)/admin/tenants/page.tsx`                                       |       2 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `app/(authed)/settings/organization/billing/_components/BillingClient.tsx` |       6 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `app/(authed)/settings/organization/billing/_components/searchFigures.ts`  |       1 | comment only                                                                           |
| `app/(authed)/settings/organization/usage/_components/OrgUsageClient.tsx`  |       9 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `app/(authed)/settings/organization/usage/_components/searchUsage.ts`      |       1 | comment only                                                                           |
| `lib/ai/tenantOrg.ts`                                                      |       4 | propagation onto the job-submit tenant envelope                                        |
| `lib/ai/types.ts`                                                          |       3 | type / DTO field                                                                       |
| `lib/billing/aiEntitlement.ts`                                             |       1 | comment only                                                                           |
| `lib/billing/entitlements.ts`                                              |       3 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `lib/ciFleet/config.ts`                                                    |       1 | comment only                                                                           |
| `lib/ciMetering/allowance.ts`                                              |       1 | comment only                                                                           |
| `lib/dto/aiUsage.ts`                                                       |       2 | type / DTO field                                                                       |
| `lib/dto/billing.ts`                                                       |       3 | type / DTO field                                                                       |
| `lib/dto/platform.ts`                                                      |       1 | type / DTO field                                                                       |
| `lib/mappers/platformMappers.ts`                                           |       1 | query / select / mapper                                                                |
| `lib/repositories/ciContainerPeriodCostRepository.ts`                      |       8 | query / select / mapper                                                                |
| `lib/repositories/organizationMembershipRepository.ts`                     |       4 | query / select / mapper                                                                |
| `lib/repositories/organizationRepository.ts`                               |      10 | query / select / mapper                                                                |
| `lib/services/acceptanceVideoEligibilityService.ts`                        |       1 | comment only                                                                           |
| `lib/services/aiAskService.ts`                                             |       4 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiBugTelemetryService.ts`                                    |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiChatService.ts`                                            |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiConventionService.ts`                                      |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiExplanationService.ts`                                     |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiGenerationService.ts`                                      |       4 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiJobsService.ts`                                            |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiPlanEditsService.ts`                                       |       6 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiSprintPlanningService.ts`                                  |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/aiUsageService.ts`                                           |       5 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/billingService.ts`                                           |       3 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `lib/services/ciActionsGateService.ts`                                     |       5 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `lib/services/ciAllowanceService.ts`                                       |       5 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `lib/services/ciFleetCostMeterService.ts`                                  |       6 | comment only                                                                           |
| `lib/services/ciMinutesMeterService.ts`                                    |       5 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `lib/services/ciRunnerAdmissionService.ts`                                 |       1 | comment only                                                                           |
| `lib/services/ciRunnerProvisioningService.ts`                              |       1 | comment only                                                                           |
| `lib/services/codeGraphIndexAdmissionService.ts`                           |       2 | comment only                                                                           |
| `lib/services/codeGraphIndexDispatchService.ts`                            |       5 | comment only                                                                           |
| `lib/services/conventionEstablishService.ts`                               |       2 | propagation onto the job-submit tenant envelope                                        |
| `lib/services/entitlementsService.ts`                                      |       2 | BRANCH file (branch lines listed above; remaining hits are comments, reads and fields) |
| `lib/services/fleetCeilingService.ts`                                      |       1 | comment only                                                                           |
| `lib/services/platformBillingClassificationService.ts`                     |       2 | comment only                                                                           |
| `scripts/plan-seed/seed.ts`                                                |       2 | seed data / comment                                                                    |
| `scripts/plan-seed/testProject.ts`                                         |       1 | seed data / comment                                                                    |
| **total**                                                                  | **139** |                                                                                        |

**motir-ai @ `8ca2138`:**

| file                                           |   hits | what they are                                                                    |
| ---------------------------------------------- | -----: | -------------------------------------------------------------------------------- |
| `src/creditKinds.ts`                           |      1 | comment only                                                                     |
| `src/envelope.ts`                              |      9 | envelope type + wire parsing (a type check on the raw value, not a policy)       |
| `src/jobs/planJobService.ts`                   |      2 | flag sync from core (a no-op-if-equal compare, not a policy)                     |
| `src/jobs/worker.ts`                           |      4 | BRANCH file (branch line listed above; remaining hits are the type and the read) |
| `src/repositories/aiOrganizationRepository.ts` |      1 | flag sync from core (a no-op-if-equal compare, not a policy)                     |
| `src/seed/dogfoodDirectionDocs.ts`             |      2 | seed data / comment                                                              |
| `src/seed/seedBaseLessons.ts`                  |      1 | seed data / comment                                                              |
| `src/seed/testProjectPreplan.ts`               |      1 | seed data / comment                                                              |
| `src/services/aiOrganizationService.ts`        |      5 | flag sync from core (a no-op-if-equal compare, not a policy)                     |
| `src/services/gatewaySyncService.ts`           |      1 | BRANCH file (branch line listed above; remaining hits are the type and the read) |
| `src/services/orgReconciliationService.ts`     |      3 | operator report field                                                            |
| **total**                                      | **30** |                                                                                  |

---

## §21 — A `redispatchable` exit is re-dispatched, once, inside the run (MOTIR-6586, 2026-09-27)

**Dated 2026-09-27. Read at `motir-core` `e3be83c90`.** Nothing above this line is edited.

**The defect.** `classifyIndexExit` has marked `20` repo_unfetchable, `40` upload_failed and `41` pointer_unrecorded `redispatchable: true` since the classifier was written, and nothing in the application read the flag (`git grep -n redispatchable` found only its definition, the classifier, a test of the classifier's own value, and a step-shape pin). The job's retry did not stand in for it. A settle RETURNS its verdict rather than throwing, so `index-settle:<pid>` is memoized, and `lib/jobs/engine/step.ts` is explicit that a retry does not clear the step ledger — so attempts 2–5 of `system.code-graph-refresh` / `system.code-graph-index` replayed admit → boot → settle out of `job_step` and threw the identical error without booting a container. One transient fault left a repository's graph stale until its next push. MOTIR-6585's Sentry issue carries `job_terminal_failure=true` for an exit the classifier calls re-dispatchable.

**The decision: honour the flag, inside the run, with a cap of two containers.** `advanceIndexContainer` now drives dispatch ATTEMPTS: when an attempt settles un-indexed with a `redispatchable` verdict and fewer than `MAX_DISPATCH_ATTEMPTS` (2) have run, it dispatches again — fresh admission, fresh boot (so a fresh tarball URL, which is what clears `20`), fresh supervision. When the cap is spent the run fails on the LAST attempt's verdict, and `IndexDispatchFailedError` names the class and the attempt count. The alternative the card offered — delete the flag — was refused: the three classes it marks really are transients, and `40` was the commonest failure in production.

- **Attempt 1's ids are byte-identical to every id written before this change.** An attempt is named by its supervision subject, `indexAttemptSubject(projectId, n)`: the bare `projectId` for attempt 1, `<projectId>:r<n>` after. The subject keys the three memoized steps and the `job_supervision` row, so a run in flight across the deploy resumes on the memos it holds, and a run whose attempt-1 settle already failed re-dispatches on its next pass. The `r` keeps the suffix apart from the retired `index-admit:<pid>:<n>` shape of the old admission loop.
- **The attempt number is re-derived on every pass, never stored.** A settled attempt replays its settle memo and polls nothing, so which attempt a run is on is a fact of `job_step`.
- **The abandoned-supervision sweep needs no change.** It reads the boot memo back as `index-boot:<subject>`, and the subject is the same string for the row and the memo on every attempt.
- **The admission slot is per attempt.** Each attempt's settle releases its slot, and the next attempt queues for admission like any dispatch. The `dispatchId` does not change, because it names the dispatch rather than the container.
- **The count rides OUT of the dispatch, not INTO a memo.** `IndexDispatchOutcome` is what `index-boot:` and `index-settle:` memoize, and those steps provision and tear down, so they may not take new ids. The count is attached after the steps return (`IndexAdvanceOutcome`), as `coreTimings` is.

**`supervision_timed_out` stops being re-dispatchable.** It was `true` only because nothing read it. The deadline and the poll ceiling are the whole supervision budget, so such a container already cost the most any container may, and a fresh one on the same tree at the same size mostly repeats it — the reasoning `137` already carries. `never_started` stays re-dispatchable: nothing ran, and its boot deadline is minutes.

**Unchanged.** A non-re-dispatchable class (`10`, `30`, `50`, `137`, `null`, unclassified, a timed-out supervision) is final after one container, as before. Every non-`settled` outcome (deferred admission, refused provision, unpullable image, failed teardown) is returned as it stands, from whichever attempt produced it.

## §22 — RETIRED: the index workload has left the container fleet (MOTIR-12041 · Story MOTIR-11026, 2026-11-23)

**Everything above describes the past.** Indexing runs through motir-ai and motir-codegraph since
Story MOTIR-11022: motir-core's triggers hand motir-ai the source URL they already mint, and no
container of this record's workload is admitted, booted or billed by motir-core any more. Story
MOTIR-11026 removed the machinery this record decided, card by card: the admission and dispatch
services and their two capacity pause reasons (MOTIR-12036), the index container spec, its Fly and
AWS boot paths, the indexer image pin and AMI setting and the daily indexer checks (MOTIR-12037), the
merged Host account's second row (MOTIR-12038), the index line on billing for new usage (MOTIR-12039)
and the admin and settings surfaces' indexer elements (MOTIR-12040).

MOTIR-12041 removed the fleet kind itself. motir-core has three fleet kinds — `ci_runner`,
`hosted_agent` and `agent_instance` — in `FleetWorkloadKind`, `FLEET_WORKLOADS` and every map over
them, and the provider switch `MOTIR_INDEX_FLEET_PROVIDER` is gone. Migration
`20261123180000_retire_code_graph_index_fleet_kind` deleted the kind's remaining rows (in-flight
slots, capacity requests on its shards, quota requests, growth events, shards and its switch row) and
tightened the three `fleet_kind` CHECK constraints, so the database refuses the kind.

**What stays, on purpose:** the `index` cost line on past `ci_container_usage` rows (billing history),
the stored kind on the merged account's past capacity requests (re-pointed onto its `agent_instance`
row and listed by billing), the merged account's AWS name `host-‹org›-index` (a provisioning replay
finds the account by it), and the migrations that created the kind. Section numbers stay append-only:
§0–§21 are cited as they stand, and read as history.
