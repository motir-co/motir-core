# Where motir-core runs — Fly.io, one process, and what the move costs

- **Status:** Accepted (2026-08-07, drafted for Story MOTIR-2384 per the
  decision-subtask ladder). This is the rung-1 record every other card in that
  Story reads. **No application behaviour ships in this subtask** — it writes
  this file and amends `attachment-access-control.md`, and changes no code, no
  workflow and no config.
- **Story / Subtask:** MOTIR-2384 (Move motir-core's hosting from Vercel to Fly)
  · Subtask MOTIR-2385.
- **Consumed by:** MOTIR-2386 (provisioning), MOTIR-2387 (the runtime),
  MOTIR-2388 (the app-URL contract), MOTIR-2389 (the blob store), MOTIR-2390
  (CI), MOTIR-2391 (the database account), MOTIR-2392 (cutover), MOTIR-2393
  (deleting the abandoned path), MOTIR-2394 / MOTIR-2395 (the Story's tests),
  MOTIR-2396 (retirement).
- **Builds on:** the incident MOTIR-2371 (production deploys failing in Vercel's
  "Deploying outputs" phase) and the spike MOTIR-2383 (`spike/fly-standalone`,
  PR #1922), which measured the alternative rather than arguing it.
- **Amends:** `attachment-access-control.md` — see its **Amendment 2
  (2026-08-07)**, which this record forces and Q2 below decides.
- **Supersedes / superseded by:** nothing. Twenty-four decision records exist in
  this directory and none of them says where the application runs; this is the
  first.

> Convention (set by `work-item-type-taxonomy.md`, followed by
> `billing-tiering.md` / `attachment-access-control.md`): a decision record is a
> markdown file under `docs/decisions/`, structured **Status → Context →
> Decision → Consequences**, with load-bearing facts pinned in explicit tables.
> The numbered-**Q** section shape and the per-Q rejected-alternatives table are
> `public-api-conventions.md`'s (Amendments 9–11).

---

## The problem

**Production deploys fail, and no configuration fixes them.** MOTIR-2371's builds
succeed and then die in Vercel's "Deploying outputs" phase. The cause is
structural rather than a misconfiguration: **Vercel packages one serverless
function per route**, each carrying its own traced copy of everything it
imports, so Prisma's 4.9 MB WASM query compiler is staged **490 times** into a
`/tmp` partition that Vercel support confirmed is a fixed infrastructure default
— not a function of the machine tier, and not a knob.

Eight levers were tried against it. Each was **measured**, and the numbers are in
Q1 below because their whole value is that nobody re-runs them. Six returned
exactly zero. The two that returned something asked for a change we were not
willing to make in exchange.

So the question this record answers is not "which flag" but **where the
application runs**, and the second-order questions that answer forces: what
happens to the blob store, to the three platform-injected URL variables, to
per-pull-request preview environments, and to the order of the pipeline.

---

## §1 — The decisions, in one table

| #      | Question                                 | Decision                                                                                                                   |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Q1** | Where does motir-core run?               | **Fly.io**, as ONE long-running process (`output: 'standalone'`), org `moooon`, region `iad`                               |
| **Q2** | What replaces Vercel Blob?               | **Tigris**, S3-compatible, **two buckets** (public assets / private content); S3 presigned URLs                            |
| **Q3** | What replaces the three `VERCEL_*` URLs? | **`MOTIR_BASE_URL`**, one variable, one accessor (`lib/baseUrl.ts`), two-rung precedence                                   |
| **Q4** | Do per-PR preview environments survive?  | **No. They are DROPPED** — a decision, with what is lost and what reverses it recorded                                     |
| **Q5** | What is the pipeline order?              | Existing gates FIRST, deploy after, Inngest sync as a failing step, verification read from the PLATFORM                    |
| **Q6** | How many machines, and who creates them? | **2**, created by `fly scale count 2` — an operator action, owned by MOTIR-2386, never by `fly.toml`                       |
| **Q7** | Is static-asset egress fronted by a CDN? | **No**, for now — the app serves its own static output at $0.02/GB, accepted explicitly with a trigger                     |
| **Q8** | What does the move NOT change?           | The database engine, migrations, Inngest, the E2E suite, the 4-layer convention, ~~motir-ai, motir-gateway~~ (Amendment 7) |

> **The amendments add Q9–Q20 and this table does not repeat them**, by the
> convention Amendments 1 and 6 already set. Q9 (the core→ai transport) is
> Amendment 1, corrected by 5; Q10 (region, as residency) is Amendment 6;
> **Q11–Q19 (the scaling posture for all three services) are Amendment 7**;
> **Q20 (the transport for every service seam, per leg) is Amendment 8**, which
> also settles the floor consequence Amendment 7 §15 deferred onto it.

---

## §2 — Q1: where motir-core runs

### The decision

**motir-core runs on Fly.io as a single long-running Node process**, built by a
multi-stage `Dockerfile` from Next's `output: 'standalone'` artifact, in the Fly
org that already holds `motir-ai` — **`moooon`** — primary region **`iad`**
(Ashburn) — the same region as motir-ai and as the Neon database.

`output: 'standalone'` is the load-bearing half. Next traces the app **once** and
emits one server in which every route shares one process and one `node_modules`,
so a heavy dependency is resident once instead of copied per route. That is not
a smaller version of the failure; **the failure has no analogue.**

### What was measured

| Measurement                                   | Vercel                                 | Standalone on Fly        |
| --------------------------------------------- | -------------------------------------- | ------------------------ |
| Deployable artifact                           | **4,240 MB** traced across 490 bundles | **374 MB** + 7 MB static |
| Copies of Prisma's 4.9 MB WASM query compiler | **490**                                | **1**                    |
| Ratio                                         | —                                      | **11× smaller**          |

The server was **booted**, not merely built — a build proves compilation, only a
boot proves the process model. It served `/sign-in`, `/docs/api`, `/docs/sandbox`
and `/explore` at HTTP 200 (MOTIR-2383).

Two findings from the spike are carried into MOTIR-2387 because they are the kind
that cost a day if rediscovered:

- **`HOSTNAME=0.0.0.0` is mandatory and fails silently.** Next's standalone
  server binds the _container hostname_ by default. The process logs `✓ Ready`,
  looks healthy, and nothing outside can reach it. On a first deploy it presents
  as a networking problem.
- **222 MB of the 374 MB is the `design/` tree**, pulled in by a single trace
  (`instrumentation.js.nft.json` references 324 design files).
  `outputFileTracingExcludes` does **not** remove it — verified with a clean
  rebuild. Harmless, but the real runtime payload is nearer **150 MB**.

  **Corrected 2026-08-07 (MOTIR-2403) — the cause, and it is not harmless.** The
  observation above is right and its explanation was missing, which let the
  config keep a key that read as a solution. `outputFileTracingExcludes` and
  `outputFileTracingIncludes` are consulted in exactly one module,
  `next/dist/build/collect-build-traces.js`, and `next/dist/build/index.js`
  invokes it behind `if (bundler !== Bundler.Turbopack && …)`. Next 16 builds
  with **Turbopack**, so the module never runs and **neither key has any effect
  in this repo** — for the standalone artifact here and, by the same guard, for
  the per-function traces on Vercel (which is why the table below measured a
  zero for it). Re-measured at `origin/main`: `.next/standalone` = **381 MB**,
  every excluded directory still present.

  It stopped being harmless when the artifact became an image every Fly machine
  pulls. The pruning therefore moved to a step that demonstrably prunes — a
  guarded `rm -rf` in the **builder** stage of the `Dockerfile`, before the
  runner copies the output (a prune after the `COPY` deletes nothing from the
  image; the bytes are already in that layer). Measured: **381 MB → 135 MB**,
  with `/sign-in`, `/docs/api`, `/docs/sandbox`, `/explore` and the `/explore`
  OG card all still served at 200 from the pruned output. `next.config.ts` no
  longer carries the exclusion; the comment in its place says why re-adding it
  would change nothing.

  **Amended 2026-08-20 (MOTIR-3219) — why the tracer swept at all, and the prune
  is now an assertion.** Both corrections above are about the REMEDY; neither
  asked why a single trace referenced 324 design files in the first place, and
  the answer is not that Turbopack's tracer is coarse. `instrumentation.ts`
  dynamic-imports the E2E boundary mocks, and each read its fixture from a path
  supplied by an env var — an argument the tracer cannot resolve, whose
  documented fallback is to trace the **entire project**. Next said so on every
  build (`Encountered unexpected file in NFT list … the whole project was traced
unintentionally`), naming one mock; because it names only the first module it
  reaches, unwiring that one merely promoted the next, which is how the condition
  read as ambient rather than fixable.

  Marking those reads `/* turbopackIgnore: true */` behind one module
  (`lib/test-fixture-file.ts`) took `instrumentation.js.nft.json` from **4510
  traced files to 168** and `.next/standalone` from **464 MB to 124 MB** — below
  the 135 MB the prune achieved, with nothing deleted. So **381 MB was the size
  of the bug, not the cost of a Turbopack standalone build**, and the six-lever
  table below measured its levers against an artifact three times larger than it
  had to be.

  The Dockerfile step therefore INVERTS rather than disappears: it now fails if
  any of those directories is in the output, because a `rm -rf` that removes
  nothing is the same silent no-op the inert config key was. `pnpm
assert:nft-trace` (CI's `build` job) asserts the same fact against the
  `.nft.json` files on every pull request; the Dockerfile is the backstop on the
  path that ships the bytes, and the only one of the two that runs during
  `flyctl deploy`, which happens after the merge.

### Rejected alternatives — every one MEASURED

Six of the eight levers below returned **zero**: the artifact did not shrink and
the deploy failed identically. They are recorded with their figures so that the
next person to meet a large build does not spend the same day rediscovering the
same zeroes. **Writing down what did not work is the more valuable half of this
document.**

| Alternative                                                   | Measured result                   | Why rejected                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputFileTracingExcludes`                                   | **0**                             | ~~None of the excluded packages were in the trace to begin with — the exclusion had nothing to remove.~~ **Corrected 2026-08-07 (MOTIR-2403):** the zero is right, the reason was not. The key is read only by `collect-build-traces.js`, which `build/index.js` skips entirely under Turbopack — so it removes nothing regardless of what is in the trace. See §2 above. |
| `binaryTargets` / `engineType`                                | **0**                             | There is no native engine to retarget. Prisma 7 uses the **WASM** query compiler, which is exactly the 4.9 MB being copied 490 times.                                                                                                                                                                                                                                     |
| The `prisma-client` generator (replacing `prisma-client-js`)  | **0**                             | The compiler **relocates** but is still traced — ×337 instead of ×490. Fewer copies of the same structural problem is not a fix.                                                                                                                                                                                                                                          |
| `serverExternalPackages`                                      | **0**                             | Externalizing a package moves it out of the bundle, not out of the per-function trace.                                                                                                                                                                                                                                                                                    |
| `VERCEL_FORCE_NO_BUILD_CACHE`                                 | **0**                             | The restored build cache was never the input to the packaging step that fails.                                                                                                                                                                                                                                                                                            |
| Three machine tiers (Standard, Elastic, Enhanced)             | **0**                             | `/tmp` is a **fixed infrastructure default, independent of tier** — confirmed by Vercel support. Paying more buys no packaging disk.                                                                                                                                                                                                                                      |
| **Prisma Accelerate**                                         | **~39%** reduction                | It works, and it is rejected on architecture: it puts a **paid proxy in the data path** to route around a packaging model. The price of the fix is a permanent dependency in every query.                                                                                                                                                                                 |
| **Catch-all route handlers**                                  | **~61%** reduction                | It works, and it is rejected on architecture: collapsing routes into catch-alls **reshapes the application to fit a bundler**, against the 4-layer route convention (`CLAUDE.md`) with no product reason.                                                                                                                                                                 |
| Stay on Vercel, change nothing                                | —                                 | Production deploys fail today. This is the status quo the record exists to end.                                                                                                                                                                                                                                                                                           |
| Another container host (Render / Railway / Cloud Run / a VPS) | not measured, and deliberately so | Each would solve the same structural problem the same way (one process, one image), so there is no measurement that would distinguish them — and each would add a **second** platform relationship to operate. `motir-ai` has run this exact shape on Fly for months: same org, same `iad` region, same `release_command`. The working precedent is the whole argument.   |

---

## §3 — Q2: the blob store

### The decision

**Attachments move to Tigris** — Fly's S3-compatible object store — **as two
buckets**, preserving the public/private split `attachment-access-control.md`
decided:

| Bucket      | Contents                                                          | Access                                |
| ----------- | ----------------------------------------------------------------- | ------------------------------------- |
| **public**  | avatars (the object `User.image` keys) and other public assets    | public-read; a directly fetchable URL |
| **private** | comment/description embeds, panel files, acceptance video + trace | no public read; presigned GET only    |

**The signing flow becomes S3 presigned URLs.** `@vercel/blob`'s
`issueSignedToken` → `presignUrl` delegation has no counterpart outside Vercel;
the S3 equivalent of a short-lived authenticated GET is a **presigned GET**, and
of `generateClientTokenFromReadWriteToken` a **presigned PUT**. Everything else
in `attachment-access-control.md` is untouched — the private store, the
authenticated `GET /api/attachments/[id]/content` route, the §3 authorization
matrix, the DTO exposing only `contentUrl`, and the **300 s** TTL, which carries
over unchanged as the presigned GET's expiry.

**One clause is a genuine behavioural difference and is pinned here rather than
discovered at run time: a presigned PUT carries only the metadata the SIGNER
set.** Content type must be bound at signing time, not sent by the browser, or
every client-uploaded object lands as `application/octet-stream`.

The swap is bounded to one file. `lib/blob/uploader.ts` is the **only** module
importing `@vercel/blob`, and it exports eight functions (and the three
interfaces they return) that everything else calls through — which is why this is
a code change and not an architecture change. _Corrected by Amendment 3._

### Rejected alternatives

| Alternative                                     | Why rejected                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep `@vercel/blob`, hosted from Fly            | It would work — the SDK is not tied to Vercel compute. But it keeps the Vercel account, the billing relationship and a store nobody can retire, which is precisely what this Story exists to end. A migration's deliverable is the deletion of the abandoned path, not merely its emptying.        |
| S3 on AWS                                       | A third provider account and cross-cloud egress, for an object store Fly already offers in-region.                                                                                                                                                                                                 |
| Make the store public and drop the signing flow | Already decided against, on security grounds, in `attachment-access-control.md`'s Context — a "public" blob is world-readable to any holder of the URL. **This is a recorded decision, not an open question**, and changing hosts does not re-open it.                                             |
| A single bucket with per-object ACLs            | Collapses a split that exists for a reason: an avatar renders with **no per-item auth context** and wants CDN-cacheable URLs, while content must never be readable without authorization. Two buckets make the difference structural instead of a per-object attribute someone can get wrong once. |

---

## §4 — Q3: the app-URL contract

### The decision

**`MOTIR_BASE_URL` is the one variable that carries the application's own
absolute origin, and `lib/baseUrl.ts` is the one place its precedence lives.**

Three Vercel-injected variables carry it today — `VERCEL_URL`,
`VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` — read in
`lib/baseUrl.ts` and `lib/auth/index.ts`. None exists on Fly.

**Precedence, in full — two rungs, and deliberately only two:**

| #   | Source                  | When                                                                                |
| --- | ----------------------- | ----------------------------------------------------------------------------------- |
| 1   | **`MOTIR_BASE_URL`**    | every deployed environment; set as a Fly secret. Production: `https://app.motir.co` |
| 2   | `http://localhost:3000` | local development and tests, when the variable is unset                             |

The platform-injected middle rungs are not replaced by Fly equivalents; they are
**deleted**, because the thing they existed for — a per-deployment URL nobody
configured — is exactly what Q4 drops. A trailing slash is trimmed by the
existing `resolveBaseUrlTrimmed`.

**Why this name and not a new one.** `MOTIR_BASE_URL` was already this
repository's name for this concept when this record was written:
`scripts/upload-acceptance-video.mjs` read it, defaulting to
`https://app.motir.co`, and `.github/workflows/acceptance-video.yml` set it.
Adopting the shipped name meant one vocabulary rather than two. **⚠️ Both of those
readers are retired (MOTIR-4096 — CI no longer publishes the acceptance
recording), so the acceptance workflow no longer sets the variable.** That
retires the ILLUSTRATION, not the decision: `MOTIR_BASE_URL` is still the
runtime's own name for the deployment's public origin, and
`resolveBaseUrlTrimmed` is still what reads it. `BETTER_AUTH_URL` was
the incumbent first rung, but it is a library-specific name now governing email
links, public-project URLs, Inngest registration and signed assets — the name
would keep lying about its scope. Better-Auth's `baseURL` is supplied **in code**
from the accessor, so nothing about Better-Auth depends on the variable's name.

**`trustedOrigins` collapses with it.** Better-Auth's allowlist exists in its
current shape only because a Vercel preview could arrive on a branch alias, a
deployment-unique URL or the custom domain. With one origin it becomes
`[MOTIR_BASE_URL, 'http://localhost:3000']`.

**`NEXT_PUBLIC_BETTER_AUTH_URL` stays unset and is NOT folded into this
contract.** `lib/auth/client.ts` defaults it to `''`, which Better-Auth resolves
to the current origin at request time — correct for a single-origin deployment,
which is what Fly serves. Adopting it would be actively wrong here: a
`NEXT_PUBLIC_*` value is **inlined at `next build`**, and in a Dockerfile that
build happens in the builder stage with no secrets present. Baking the browser's
auth origin into the image would make one image per environment, destroying the
build-once-deploy-anywhere property that is half the reason for the move. This
clause exists so that no card "fixes" it with a Docker build argument.

### Rejected alternatives

| Alternative                                                               | Why rejected                                                                                                                                                   |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep `BETTER_AUTH_URL` as the single variable                             | Zero migration cost, and a name that misdescribes its scope forever. The rename is one secret on a platform being provisioned fresh.                           |
| Introduce a new `MOTIR_APP_URL`                                           | A third name for a concept that already has two. `MOTIR_BASE_URL` is shipped and already means this.                                                           |
| Derive the origin from the request at runtime, with no variable           | Works for a browser request and fails for everything that has no request: emailed links, Inngest registration, a job building an absolute URL.                 |
| Keep a multi-rung precedence with Fly-injected variables (`FLY_APP_NAME`) | Reconstructs `<app>.fly.dev` — an origin the product is never served on once DNS moves, and a second answer to a question this Q exists to give one answer to. |

---

## §5 — Q4: preview environments are DROPPED

### The decision

**Per-pull-request preview environments do not survive the move. This is a
decision, not an omission** (Yue, 2026-08-07 — pre-launch, and CI already runs
the full suite on every pull request).

**What is lost, precisely:**

- The per-PR deployed URL Vercel creates and links on the pull request.
- The per-PR database branch that URL pointed at.
- `cleanup-preview-deployments.yml`, which reaps them (deleted by MOTIR-2393).
- A reviewer's ability to click a link and use the change without a checkout.

**What is kept, and is why the loss is affordable right now:** every pull request
still runs the full vitest suite and the **119 Playwright specs** against their
own ephemeral Postgres, unchanged (Q5). A change is verified by CI and by running
the app locally — which is already what happens.

**What would reverse it, concretely.** A Fly app per pull request plus a **Neon
branch per pull request** through Neon's API, created on open and destroyed on
close. That is real work and it belongs to a **future Story**, not to a deferral
hidden inside this one. The trigger to schedule it: **the first reviewer who is
not a committer** — a designer, a QA reviewer, or anyone accepting a Story who
should not need a local checkout to see the change.

### Rejected alternatives

| Alternative                                     | Why rejected                                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keep the Vercel project alive for previews only | Keeps the account, the billing relationship, `vercel.json`, and **two build paths that can disagree** — a preview that passes on a packaging model production no longer uses is worse than no preview. |
| One shared staging app                          | A queue for a single environment, and a second production to keep migrated, monitored and secret-managed. It answers a different question (pre-release soak) than previews do (per-change review).     |
| Build previews now, inside this Story           | It is the largest single piece of work in the migration and it gates nothing else. Doing it here would hold the fix for a failing production deploy behind a convenience feature.                      |

---

## §6 — Q5: the pipeline order, and where verification reads from

### The decision

**The existing gates run FIRST; the deploy follows them.** In order:

1. **vitest** and the **119 Playwright specs**, exactly as they are today — their
   own ephemeral Postgres container per leg (`pgvector/pgvector:pg16` since
   MOTIR-2696; `postgres:16-alpine` when this was written), their own web servers,
   `resetDatabase()` in `beforeEach`, nine parallel legs. **This Story changes
   none of it** (Yue, 2026-08-07). They are the gate.
2. **Build the image and deploy**, on the default branch only, `needs:` those
   jobs and skipped if either fails.
3. **`prisma migrate deploy` as Fly's `release_command`** — Fly runs it once per
   deploy, before new machines take traffic, so a migration cannot race a
   half-rolled-out release. This is the shape `motir-ai/fly.toml` has used for
   months.
4. **The Inngest sync as an explicit step after the release is live, which FAILS
   the job when it does not succeed.** `inngest-sync.yml` triggers on
   `deployment_status` today — an event **Vercel** raises and Fly does not. The
   trigger moves into the deploy job. This matters more than it looks: Inngest
   only invokes functions it has been told about, and a stale app registry drops
   events **silently** — five production jobs were dead for a month for exactly
   this reason (MOTIR-1970). A red check is the signal.
5. **Post-deploy verification reads the PLATFORM.**
   `GET https://api.machines.dev/v1/apps/<app>/machines`, or `fly status` —
   **never a line in `fly.toml`.** See Q6.
   _Narrowed 2026-08-26 (MOTIR-3570): that rule governs the OBSERVATION and is
   unchanged. The EXPECTATION it is compared against now comes from `fly.toml`'s
   `[processes]` and `min_machines_running`, because a stored total goes stale the
   moment a process group is added — which is what happened, and every deploy then
   ended red on a deploy that had succeeded. Deriving the expectation from the
   lines the release itself acts on is the opposite failure mode from MOTIR-2102's,
   not a repeat of it._

### Rejected alternatives

| Alternative                                            | Why rejected                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy in parallel with the gates                      | Faster, and it ships a build the suite is about to fail. The gates are the gate.                                                                                                                                              |
| Keep the Inngest sync on a `deployment_status` trigger | Fly raises no such event, so the sync would simply stop running — reproducing the exact silent failure MOTIR-1970 fixed.                                                                                                      |
| Let the sync fail soft                                 | Its entire history is of a failure that produced no signal at all.                                                                                                                                                            |
| Verify the deploy by reading `fly.toml`                | A config file is a **claim** about the deployment, not a reading of it. This is MOTIR-2102's failure verbatim: `motir-ai`'s `fly.toml` promised load spilling onto fresh machines while production ran one machine for weeks. |
| Re-point the E2E suite at the deployed environment     | The specs truncate the database they connect to in `beforeEach`, and the only deployed database is production. Out of scope by decision.                                                                                      |

---

## §7 — Q6: the machine pool, and who creates it

> **⚠️ SCOPE WIDENED by Amendment 7 (2026-08-20).** Everything below is about
> **`motir-core`** and stands unchanged. What it does not decide — and what Q8
> explicitly excluded — is `motir-ai` and `motir-gateway`. **Amendment 7 §13–§16
> decides all three**, and it separates two numbers this section runs together:
> the **pool** (which machines exist) and the **availability floor**
> (`min_machines_running`, how many the proxy will not stop). A pool of two with a
> floor of one is a single point of failure, which is what this app has been.

### The decision

**Production runs TWO machines** — org `moooon`, region `iad`,
`shared-cpu-2x` / 2 GB, `min_machines_running = 1`, `auto_stop_machines = "stop"`,
`auto_start_machines = true`.

**The count is created by `fly scale count 2`, an OPERATOR action, and it is
owned by MOTIR-2386.** This is the single most important sentence in this
section, because the mechanism is counter-intuitive and has already cost this
project three days once:

> **Fly's proxy never CREATES a machine.** `auto_start_machines` starts an
> existing **stopped** machine and nothing more. The ceiling on running machines
> is the number that already exist — created at `fly launch`, by
> `fly scale count <n>`, or by `fly machine clone`. **`flyctl deploy` updates the
> machines that exist; it does not add one.** So every knob in
> `[http_service]` is a policy over a fixed pool, never a request for capacity.

`motir-ai` ran `machine_count: 1` for weeks while its own `fly.toml` promised
otherwise, because no card ran the scale command (planning bug MOTIR-2106,
operator card MOTIR-2103). motir-core does not repeat it: the count is a step
with a spend consequence, on a named card, and MOTIR-2392 reads the result back
**from the platform**.

**Why 2 and not 1.** With one machine `auto_start_machines` has nothing to start
and `soft_limit` can never fire, so both settings are decoration — and every
rolling deploy and every Fly host drain is a **full outage**. Unlike motir-ai,
whose callers are service-to-service, this app serves interactive page loads, so
that outage is user-visible.

**Cost**, from Fly's published pricing (2026-08-07): `shared-cpu-2x` 2 GB =
**$11.83/machine/month** → **~$24/month** for the pair, plus $0.02/GB outbound.
The standby machine is stopped in steady state and Fly does not bill compute for
a stopped machine, so the always-on cost is the one warm machine.

**⚠️ The VM size is INHERITED from motir-ai, not measured for this app.** The
spike could size the artifact (374 MB) but not the resident set. See §10.

### Rejected alternatives

| Alternative                                          | Why rejected                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| One machine                                          | Makes the autostart policy inert and every deploy an outage, on a user-facing app. Saves the cost of a machine that is stopped most of the time.   |
| Scale to zero (`min_machines_running = 0`)           | A cold start on an interactive page load. Correct for a service-to-service backend, wrong for the surface a user is looking at.                    |
| Three or more                                        | No measured demand. The heavy workloads in this product live elsewhere (the container fleet, MOTIR-1981), and each machine bills whenever it runs. |
| Declare the count in `fly.toml` and consider it done | `fly.toml` cannot create a machine. This is the belief that produced MOTIR-2102.                                                                   |

---

## §8 — Q7: static-asset egress

### The decision

**No CDN in front of the app, for now.** The standalone server serves its own
`.next/static` and `public`, and Fly bills outbound transfer at **$0.02/GB**.
Vercel's CDN was bundled into the plan; on Fly it is a line item.

This is **accepted explicitly rather than left as a gap**, and it has a trigger:
revisit — by fronting the app with Cloudflare's free tier, which is the normal
answer — when the monthly egress bill is a **material fraction of the ~$24
compute cost**, or when a static-asset latency complaint arrives from outside
`iad`'s region. Until then it is one more moving part for a product with no
measured traffic problem.

### Rejected alternatives

| Alternative                                       | Why rejected                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front it with Cloudflare now                      | Another DNS-level component to configure, cache-bust and debug during a cutover whose failure modes should be few. It buys nothing measurable at current traffic. |
| Serve static assets from the Tigris public bucket | Splits the deployment across two origins and adds an asset-versioning problem Next already solves with immutable hashed filenames.                                |

---

## §9 — Q8: what the move does NOT change

Enumerated so nothing is assumed into scope:

| Element                                     | Disposition                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The database engine**                     | Neon stays Neon. The app connects with a plain `DATABASE_URL` through `PrismaPg` either way — **moving compute does not move data.** Only the _account_ moves, from a Vercel-managed Marketplace resource to the direct Neon account motir-ai uses (MOTIR-2391).                                                                                                                                                  |
| **Migrations**                              | `pnpm prisma migrate deploy`, as Fly's `release_command` — the shape motir-ai has used for months.                                                                                                                                                                                                                                                                                                                |
| **Inngest**                                 | A plain HTTP endpoint. Two secrets and a re-sync step; the Vercel Inngest integration is not installed.                                                                                                                                                                                                                                                                                                           |
| **The E2E suite**                           | Unchanged by decision (Yue, 2026-08-07). 119 specs, own ephemeral Postgres per leg, nine legs.                                                                                                                                                                                                                                                                                                                    |
| **Route shapes and the 4-layer convention** | Untouched. Q1 rejects the catch-all refactor precisely because it would change them.                                                                                                                                                                                                                                                                                                                              |
| **`motir-ai`, `motir-gateway`**             | ~~Out of scope. motir-ai already runs on Fly.~~ **⚠️ RETIRED by Amendment 7 (2026-08-20).** This row scoped the two sibling services out of this record, and for the _migration_ question it was right. It is no longer true of **scaling**: Amendment 7 decides the pool, the availability floor, the VM size, the concurrency signal and the instance ceiling for all three. Read §13–§16 there, not this cell. |
| **`motir.co` nameservers**                  | Already third-party, already outside Vercel. The cutover is a DNS **record** change, not a Vercel domain operation.                                                                                                                                                                                                                                                                                               |

---

## §10 — What this record deliberately does NOT decide

Each of these is named with its trigger, so a reader in six months finds a
boundary rather than a hole:

- **The VM size.** `shared-cpu-2x` / 2 GB is inherited from motir-ai, not
  measured for this app. **Trigger:** the first sustained memory or CPU reading
  from Fly's metrics after the cutover — MOTIR-2392 takes the first platform
  reading. Re-sizing is a one-line change plus a deploy; guessing now would be a
  measurement with no data behind it.
  > **First reading taken, 2026-08-20 (Amendment 7 §12).** `next-server` resident
  > **390 MB** of 1.92 GiB usable — **~4.9× headroom, at idle**. That is a
  > baseline, not a load reading, so **the trigger has not fired**: it asks for a
  > _sustained_ reading and this is a single idle sample. Recorded so the trigger
  > has something to fire against rather than nothing, which is the state it was
  > in for eleven days.
- **Per-PR preview environments.** Dropped by Q4 with a named reversal path;
  building them is a future Story.
- **A CDN.** Q7, with its trigger.
- **The blob objects' retention on the old store.** MOTIR-2396 deletes them after
  the new store has served the same stability window; how long that window is,
  is that card's to state.
- **Anything in `public-api-conventions.md` or any other ADR.** The `/api/v1`
  contract is unaffected: nothing here changes a route's shape, its payload or
  its version.

---

## Consequences — what this decision binds on MOTIR-2384's cards

Every card below is now required to do something specific by this record. Where a
card's own acceptance criteria did not already carry it, the card was amended as
part of this subtask (a work-item edit; no file outside `docs/decisions/` changes
here).

- **MOTIR-2386 (provisioning, human)** — creates the Fly app in org `moooon`,
  region `iad`; creates **two** Tigris buckets per Q2, the public one with
  public-read; sets the secrets including **`MOTIR_BASE_URL`** (Q3) and the
  Tigris credentials; creates `FLY_API_TOKEN`. **And runs `fly scale count 2`
  (Q6)** — the operator action nothing else can perform, recording the observed
  count from the platform. _Amended by this subtask to carry the scale step, the
  two-bucket split and the variable name._
- **MOTIR-2387 (the runtime)** — ships `output: 'standalone'`, the multi-stage
  `Dockerfile` with `HOSTNAME=0.0.0.0` and its reason, and `fly.toml` with the
  region, the `release_command`, and a comment recording the **intended** machine
  count and that `fly scale count` — not this file — is what creates it (Q6).
  _Amended by this subtask: its criterion previously asked `fly.toml` to "declare
  an explicit machine count", which is the belief MOTIR-2102 disproved._
- **MOTIR-2388 (the app-URL contract)** — implements **`MOTIR_BASE_URL`** with
  the two-rung precedence of Q3 behind one accessor, collapses `trustedOrigins`,
  and leaves `NEXT_PUBLIC_BETTER_AUTH_URL` unset and un-inlined. Its own criterion
  already says the ADR's name wins; this is that name.
- **MOTIR-2389 (the blob store)** — reimplements all eight
  `lib/blob/uploader.ts` functions (and the three interfaces they return) against
  the S3 client per Q2: presigned GET at **300 s**, presigned PUT **with content
  type bound at signing time**, and the two-bucket public/private split
  preserved. The expiry and the split are what `attachment-access-control.md`'s
  Amendment 2 records. _Count corrected by Amendment 3._
- **MOTIR-2390 (CI)** — implements the Q5 order: gates first, deploy after on the
  default branch, the Inngest sync as a step that fails the job, and a post-deploy
  check that reads `machine_count` from Fly's API.
- **MOTIR-2391 (the database account)** — unaffected by Q1's choice of host, and
  bound by Q8: the engine does not move, only the account. Its ordering hazard
  (never uninstall the integration first) is its own and is untouched here.
- **MOTIR-2392 (cutover)** — verifies on the Fly URL before DNS, and reads
  `machine_count` **from the platform** (Q5, Q6). It also takes the first memory
  reading that §10's VM-size trigger depends on.
- **MOTIR-2393 (deleting the abandoned path)** — deletes `@vercel/blob`, the
  `VERCEL_*` and `BLOB_*` reads and `cleanup-preview-deployments.yml`. Q4 is why
  the preview-cleanup workflow goes: it reaps something that no longer exists.
  **`vercel.json` was NOT in that set, and the exception was load-bearing:** it
  was not a client of the old platform but the MUZZLE on it — its
  `git.deploymentEnabled: false` plus the `ignoreCommand` were the only things
  stopping the still-connected Vercel Git integration from building every branch.
  Deleting it while the project lived re-enabled a caller instead of removing
  one (measured on motir-core#1983: with the file gone, Vercel built the branch
  and the deploy failed on the 250 MB function-size limit — the same packaging
  wall §"What is lost" describes). So it went with the project, in MOTIR-2508,
  `blocked_by` MOTIR-2396. _Done 2026-08-26: MOTIR-2396 deleted the Vercel
  project `motir-core` (`prj_okYo…`) outright — not downgraded, not merely
  Git-disconnected — and MOTIR-2508 then deleted `vercel.json`. There is no
  longer a project whose Git integration the two keys could muzzle, so the file
  is what MOTIR-2393 originally took it for: inert configuration naming a
  platform this repository has left._
- **MOTIR-2394 / MOTIR-2395 (the Story's tests)** — the no-Vercel-import guard is
  an exact set because Q1 leaves no legitimate Vercel import; the blob seam is
  exercised through its real consumers because Q2 changes semantics behind an
  unchanged signature.
- **MOTIR-2396 (retirement)** — ends the rollback. Q4 is the reason there is no
  preview workload left on Vercel to strand. **MOTIR-2508** followed it and
  deleted `vercel.json`, which could not go before the project it silenced.
  _Both done 2026-08-26: the Neon Marketplace resource, both blob stores and the
  Vercel project are deleted, and `vercel.json` is gone with them. Nothing of
  motir-core is left on the old platform, and the rollback is a rebuild._

---

## Sources

| Fact                                                                 | Source                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The failure, and the eight measured levers                           | MOTIR-2371 (incident) — Vercel support's confirmation that `/tmp` is a fixed default                                                                              |
| 374 MB vs 4,240 MB, 490 → 1 WASM copies, the boot at 200             | MOTIR-2383, branch `spike/fly-standalone`, PR #1922                                                                                                               |
| `HOSTNAME=0.0.0.0`; 222 MB of `design/**` in the trace               | MOTIR-2383's `Dockerfile` comments and PR body                                                                                                                    |
| The release-command shape, region `iad`, the VM size                 | `motir-ai/fly.toml` — the working precedent                                                                                                                       |
| Fly's proxy never creates a machine; the count is an operator action | `motir-ai/fly.toml`'s `[http_service]` comment; planning bug MOTIR-2106, operator card MOTIR-2103, incident MOTIR-2102                                            |
| $11.83/machine/month, $0.02/GB egress                                | fly.io/docs/about/pricing, read 2026-08-07                                                                                                                        |
| The signing flow being amended, the two-store model, the 300 s TTL   | `docs/decisions/attachment-access-control.md` §1–§5 and its 2026-07-07 amendment                                                                                  |
| The three `VERCEL_*` reads and their two call sites                  | `lib/baseUrl.ts`, `lib/auth/index.ts` on `origin/main`                                                                                                            |
| `MOTIR_BASE_URL` already meaning this                                | ~~`scripts/upload-acceptance-video.mjs`, `.github/workflows/acceptance-video.yml`~~ — both retired by MOTIR-4096; the reading is unchanged, the CI reader is gone |
| A stale Inngest app registry drops events silently                   | `.github/workflows/inngest-sync.yml`'s header (MOTIR-1970)                                                                                                        |
| Uninstalling the Vercel integration deletes the Neon organization    | Neon's documentation, cited on MOTIR-2391 and MOTIR-2396                                                                                                          |

---

## Amendment 1 (2026-08-07) — the core→ai seam moves onto Fly private networking; `MOTIR_BASE_URL` stays PUBLIC

> **Written by Story MOTIR-2384 · Subtask MOTIR-2420.** **Decided by Yue,
> 2026-08-07:** once motir-core runs on Fly, it reaches motir-ai over the org's
> private network. This amendment RECORDS that decision and the boundary around
> it. It changes no secret, no code and no configuration — **MOTIR-2426 applies
> the value and proves it from inside a deployed machine**, which cannot happen
> until the cutover (MOTIR-2392) has produced one.
>
> **Numbered 1** — the first amendment to this record. (MOTIR-2410, which
> corrects the org name in §1 / §2 / §7, is a separate PR against this same file
> and takes the next number.)

**Amends:** it ADDS a decision — **Q9**, the transport between motir-core and
motir-ai — which §1's decision table did not carry. §1 is deliberately not
rewritten in place; this section is Q9's entry, in the convention this directory
uses (`attachment-access-control.md` Amendment 2, `public-api-conventions.md`
Amendments 1–11).

**It re-opens nothing.** Q1 (Fly, `iad`), Q3 (`MOTIR_BASE_URL` and its two-rung
precedence) and Q7 (no CDN, egress accepted at $0.02/GB) all stand exactly as
written. Q7 is cited below as the REASON this is worth doing, not as a decision
being revisited.

### Q9 — how motir-core reaches motir-ai

#### The decision

**`MOTIR_AI_URL` becomes `http://motir-ai.internal:8080`** — the private 6PN
address of the `motir-ai` app inside the org, in place of the public
`https://motir-ai.fly.dev`.

> ⚠️ SUPERSEDED by **Amendment 9** (2026-10-03, MOTIR-7407): production
> `MOTIR_AI_URL` is the PUBLIC origin `https://motir-ai.fly.dev` since
> 2026-10-02, because motir-ai's pool now suspends to zero and `.internal`
> cannot wake it. Q9 below is the record of what was decided on 2026-08-07, not
> the deployed value — do not "restore" it.

|                   | public `https://motir-ai.fly.dev`                               | private `http://motir-ai.internal:8080`                           |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| path              | out to the public internet and back in through Fly's edge proxy | direct machine-to-machine over the encrypted WireGuard (6PN) mesh |
| **outbound bill** | **$0.02/GB** — the line item Q7 accepted                        | **free** — same-region app-to-app transfer is not billed          |
| latency           | edge proxy hop + a TLS handshake per connection                 | one hop, no TLS termination                                       |
| reachable by      | anyone on the internet who can resolve the hostname             | only from inside the org's private network                        |
| auth              | `MOTIR_AI_SERVICE_TOKEN` on every call                          | **`MOTIR_AI_SERVICE_TOKEN` on every call — unchanged**            |

The last row is not filler. **Going private does not replace authentication.**
The service token still gates every request; the private address removes public
reachability, it does not confer trust. Nothing here licenses dropping the token
because "it is internal now."

#### The facts this rests on — each READ, not assumed

| Fact                                 | Value                        | How it was read (2026-08-07)                                                   |
| ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------ |
| Both apps are in the SAME Fly org    | `moooon`                     | `fly apps list` — `motir-ai`, `motir-core`, `motir-gateway` all owner `moooon` |
| …and that org exists under that slug | `moooon` (display `MOOOON`)  | `fly orgs list` — `personal`, `motir-fleet`, `moooon`                          |
| Both apps are in the SAME region     | `iad`                        | `motir-ai/fly.toml` `primary_region`; this record's Q1 for motir-core          |
| motir-ai's port behind the proxy     | `8080`                       | `motir-ai/fly.toml` `[http_service] internal_port`                             |
| Public egress rate                   | $0.02/GB (NA/EU)             | fly.io/docs/about/pricing                                                      |
| Same-region app-to-app transfer      | free; cross-region $0.006/GB | fly.io/docs/about/pricing — "the following types of traffic are free"          |

**⚠️ §1, §2 and §7 of this record name the org as `zhu-yue`. That org does not
exist** — it is the personal org's DISPLAY name slugified by hand, and the
personal org (slug `personal`) holds neither service. The correction to those
three sections is **MOTIR-2410**'s, deliberately not made here so that two cards
do not edit the same lines. This amendment states the observed value because the
decision above depends on it: private networking works **because both apps are in
one org**, and a reader checking that premise against a non-existent org name
would conclude the premise is false.

> _Discharged by **Amendment 2** (below, 2026-08-07): §1, §2, §7 and the
> `Consequences` bullet now read `moooon`. The paragraph above is left as
> written — it records what was true when Amendment 1 landed, and the pointer is
> the only thing added to it._

**The "free" claim is region-conditional, and that is why it is written this way
rather than as "not billed".** Both apps are in `iad` today, so the transfer is
free. If either app is ever given a second region, the same traffic becomes
$0.006/GB — still 3× cheaper than the public path, but no longer zero. The
cheapness of this change is a property of the current topology, not of private
networking.

### ⚠️ The boundary — `MOTIR_BASE_URL` is NOT the internal seam and must never be repointed

**This is the load-bearing half of the amendment.** The two services call each
other in both directions, and the obvious symmetry is wrong.

- **core → ai** is `MOTIR_AI_URL`, a **motir-core** secret. It is a
  service-to-service address and nothing else. **It goes private.**
- **motir-core's own origin** is **`MOTIR_BASE_URL`** (Q3) — and it is **NOT a
  service address at all.** It is the absolute origin the application prints
  about ITSELF, resolved through the single accessor `lib/baseUrl.ts`, and it
  lands in **password-reset links, workspace-invite links, OAuth callback URLs
  (Google, GitHub, GitLab, Jira, Linear, Plane), public-project canonical and
  OpenGraph URLs, the sitemap, and the automation e-mail CTA**. Every one of
  those is opened by a human in a browser, off the Fly network. **It stays
  `https://app.motir.co`. Pointing it at a `.internal` address would not error —
  it would silently mint links nobody outside a Fly machine can open.**

By Q3's design motir-core has **exactly one** variable for its own origin and
**exactly one** accessor, so there is no "internal variant" of it to set. A
reader who has seen half the traffic move inside and reaches for `MOTIR_BASE_URL`
to finish the job is not completing this decision — they are breaking every
emailed link in the product. **The job is finished. This paragraph is the record
of that.**

**What this amendment does NOT decide:** motir-ai's own `MOTIR_CORE_URL` — the
address it calls back on, carrying `CORE_CALLBACK_SECRET` — is a **motir-ai**
secret, in another repository, under another record. It is unchanged and out of
scope here. It is named only so it is not confused with `MOTIR_BASE_URL`; the two
are different variables in different applications.

### Where `.internal` does NOT resolve — and what is deliberately unchanged

`motir-ai.internal` resolves **only from inside the org's private network** — a
Fly machine in `moooon`, or a device joined to the org's WireGuard peer network.
An ordinary developer laptop, a GitHub Actions runner and a Playwright web server
are none of those.

So **this is ONE deployed Fly secret, and nothing else changes**:

| Surface                                          | Value                                       | Why                                                                   |
| ------------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| the `motir-core` Fly app's `MOTIR_AI_URL` secret | `http://motir-ai.internal:8080`             | the only place the private address belongs                            |
| `.env.example`'s documented default              | `http://localhost:8001` — **unchanged**     | it is what a developer runs against; `.internal` breaks every machine |
| `playwright*.config.ts`                          | their existing stub origins — **unchanged** | the E2E lanes intercept this origin; they never reach Fly             |
| `.github/**` workflows                           | **unchanged**                               | a runner is outside the 6PN mesh                                      |

The enforcing check is a grep, not a count:
`grep -rn 'motir-ai.internal' .env.example playwright*.config.ts .github/` must
return nothing.

> ⚠️ SUPERSEDED by **Amendment 9** (MOTIR-7407): the first row's value is now
> `https://motir-ai.fly.dev`, not `.internal`. The other three rows and the grep
> still hold — `.internal` is now deployed NOWHERE, so it belongs in none of
> those files either.

### Why the value was not simply set during provisioning

MOTIR-2386 set `MOTIR_AI_URL` to the **public** `https://motir-ai.fly.dev`, on
purpose, and recorded why: a provisioning card **transcribes** configuration, it
does not redesign a seam. Improving a value quietly in the middle of a migration
destroys the one property that makes a cutover debuggable — the ability to tell a
**migration** fault from an **optimisation** fault. The private address was
therefore carded (this record, and MOTIR-2426) rather than slipped in.

### The rollback

**One command:** `fly secrets set MOTIR_AI_URL=https://motir-ai.fly.dev -a motir-core`.

That it is this cheap is the whole argument **against** building anything in
code — no fallback chain, no dual-address probing, no health-gated switch. A
seam whose reversal is one secret does not need a mechanism.

### Who applies it, and what they must VERIFY rather than assume

**MOTIR-2426** owns the change and the proof. It cannot run before the cutover:
the address can only be exercised from a machine inside the mesh, and no
motir-core machine exists until MOTIR-2392's first deploy. Two things it must
verify from inside that machine, because this record does not assert either:

- **That `force_https = true` in `motir-ai/fly.toml` does not break a plain-HTTP
  6PN request.** That setting is a Fly **edge-proxy** policy, and 6PN traffic
  goes straight to the machine's internal port; the expectation is that it is
  simply not in the path. **Expectation is not evidence** — MOTIR-2426 issues the
  request and reads the response.
- **That `machine_count` and the app's health are read from the platform**, not
  from `fly.toml` (Q5, Q6).

A decision with no owner for its execution is the gap this section exists to
close.

### Rejected alternatives

| Alternative                                                           | Why rejected                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the public URL                                                   | It works, and it pays $0.02/GB to send traffic out of a datacentre and back into the same one, while leaving an internal service boundary addressable from the internet. Q7 accepted that cost for **static assets served to users**, not for this. |
| Move `MOTIR_BASE_URL` to `.internal` as well, for symmetry            | It is not a service address. It is the origin printed into emailed links and OAuth callbacks — see the boundary above. This is the specific mistake the amendment exists to prevent.                                                                |
| Set `.internal` as `.env.example`'s default                           | `.internal` resolves nowhere outside the 6PN mesh, so this breaks every developer machine and every CI runner on the first `pnpm dev`, with a DNS error that reads like a network fault.                                                            |
| Add an in-code fallback: try `.internal`, fall back to the public URL | It doubles the failure modes (which path served this request?) and hides a misconfiguration behind a silent, billed detour. The rollback is one `fly secrets set`; a mechanism cannot beat that.                                                    |
| Put a Fly Machines private-network proxy or an internal LB in between | An extra hop and an extra thing to operate, for two apps in one org and one region that Fly already gives a flat private address space.                                                                                                             |
| Do it inside MOTIR-2386 (provisioning)                                | A provisioning card transcribes configuration; changing a seam mid-migration makes a migration fault indistinguishable from an optimisation fault. See above.                                                                                       |

### Sources — additions

| Fact                                                            | Source                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Org `moooon` holds all three apps; `zhu-yue` does not exist     | `fly apps list` / `fly orgs list`, 2026-08-07 (also MOTIR-2386's execution comment) |
| motir-ai's `internal_port = 8080`, and `force_https = true`     | `motir-ai/fly.toml` on its `origin/main`                                            |
| Same-region app-to-app transfer is free; cross-region $0.006/GB | fly.io/docs/about/pricing, read 2026-08-07                                          |
| `.internal` is org-scoped 6PN service discovery                 | fly.io/docs/networking/private-networking/, read 2026-08-07                         |
| Everything `MOTIR_BASE_URL` ends up inside                      | `lib/baseUrl.ts`'s header and its call sites on `origin/main` (MOTIR-2388)          |
| Why provisioning set the public value                           | MOTIR-2386's closing comment                                                        |
| The org name correction in §1 / §2 / §7                         | MOTIR-2410                                                                          |

---

## Amendment 2 (2026-08-07) — the Fly org is `moooon`; `zhu-yue` never existed

> **Written by Story MOTIR-2384 · Subtask MOTIR-2410.** This amendment corrects a
> NAME. **It re-opens no decision** — Q1 still chooses Fly.io and region `iad`,
> Q6 still chooses two machines created by `fly scale count 2`, and every other
> section stands exactly as written. What changes is that the three places which
> stated _which org_ the application runs in now state an org that exists.
>
> **Numbered 2.** Amendment 1 (the core→ai private-networking seam, MOTIR-2420)
> was written against this same file in parallel and merged first; it reserved
> this number for this correction and deliberately left these lines alone. The
> two amendments touch no common text.

**Amends:** the org NAME in **§1**'s Q1 decision-table row, **§7**'s Q6 decision
paragraph, and the **MOTIR-2386 bullet** under _Consequences_; **§2**'s Q1
paragraph, which named the org only by description ("the Fly org that already
holds `motir-ai`"), now also carries the slug. It also **discharges Amendment
1's ⚠️ paragraph**, which stated that those sections name a non-existent org and
left the correction to this card — that paragraph now carries a pointer here and
is otherwise unchanged. Nothing else in this record changes, and no clause is
withdrawn.

### What was wrong

Three sections of this record stated the Fly organisation as **`zhu-yue`**. **No
organisation of that name has ever existed.** It is the personal org's DISPLAY
name (`Zhu Yue`) slugified by hand rather than read back from the platform — and
the personal org's actual slug is `personal`, which holds neither service.

The error was self-concealing in a specific way: §2's Q1 paragraph described the
org correctly and by reference ("the Fly org that already holds `motir-ai`"),
which is true and unambiguous, while the three sections that named it gave a
slug that resolves to nothing. A reader who followed the description would have
reached the right place; a reader who copied the slug would have found nothing
there, and the most likely reaction to that is to conclude the app must live
somewhere else and create a second one.

### What the platform reports — read, not assumed

Observed 2026-08-07, first on MOTIR-2386 (which created the app) and again while
writing this amendment:

```
$ fly orgs list
Name                 Slug                 Type
----                 ----                 ----
Zhu Yue              personal             PERSONAL
motir-fleet          motir-fleet          SHARED
MOOOON               moooon               SHARED

$ fly apps list
 NAME                │ OWNER       │ STATUS    │ LATEST DEPLOY
 motir-ai            │ moooon      │ deployed  │ 7h47m ago
 motir-core          │ moooon      │ pending   │
 motir-gateway       │ moooon      │ deployed  │ Aug 5 2026 01:52
 motir-ci-runners    │ motir-fleet │ suspended │
 motir-index-runners │ motir-fleet │ pending   │
```

| Fact                         | Value                                              |
| ---------------------------- | -------------------------------------------------- |
| The org this record means    | **`moooon`** (display name `MOOOON`)               |
| What `zhu-yue` resolves to   | **nothing** — no org carries that slug             |
| The personal org's real slug | `personal` — holds neither motir-ai nor motir-core |
| Apps owned by `moooon`       | `motir-ai`, `motir-gateway`, **`motir-core`**      |

So `moooon` is not a new choice being made here — it is what Q1's own reasoning
already meant ("the Fly org that already holds `motir-ai`"), and it is where
MOTIR-2386 actually created the app.

### Why an amendment rather than a silent replacement

A find-and-replace would leave this record looking as though it had always been
right. It has not: it carried a non-existent org name for the whole window in
which the cards downstream of it were being executed, and anyone who acted on the
old value needs to be able to discover that it changed and why. The convention in
this directory — `attachment-access-control.md`'s Amendment 2,
`public-api-conventions.md`'s Amendments 9–11 — is that a correction is recorded,
not overwritten.

### The general lesson this record now carries

**An org, project or account has a display name and a separate short identifier,
and only the identifier is real to the tooling.** Writing the display name in the
shape identifiers usually take produces a value that reads perfectly and resolves
to nothing. Every such value in this directory should be pasted from the
platform's own output — `fly orgs list`, `fly apps list`, `vercel env ls` — never
transcribed from a console header. That is the same rule MOTIR-2102 arrived at
from the other direction: read the platform, not our own file.

### What this amendment does NOT touch

- **`fly.toml`.** Its line 12 comment (`claimed by MOTIR-2386 in org 'zhu-yue'`)
  carries the same wrong name and is corrected by **MOTIR-2428**, its own card —
  the file is runtime configuration, not this record, and it pins no org (an
  app's org is fixed at creation and cannot be set from `fly.toml`).
- **Any decision.** Q1's choice of Fly, Q6's count of 2, and every other Q stand.
- **Anything on the platform.** Nothing is created, moved or renamed; MOTIR-2386
  already created `motir-core` under `moooon`.

---

## Amendment 3 (2026-08-07) — `lib/blob/uploader.ts` exports eight functions, not nine

> **Written by Story MOTIR-2384 · Subtask MOTIR-2431.** This amendment corrects a
> COUNT. **It re-opens no decision** — Q2 still chooses S3-on-Tigris, the
> two-bucket split still stands, the 300 s presigned GET and the content type
> bound at signing time are all untouched, and every other section stands exactly
> as written. What changes is that the two places which stated _how many_ exports
> the seam has now state a number the file agrees with.
>
> **Numbered 3.** Amendment 1 (the core→ai private-networking seam, MOTIR-2420)
> and Amendment 2 (the Fly org, MOTIR-2410) are both in this file already; the
> highest heading was re-read at edit time rather than taken from the card.

**Amends:** the export COUNT in **§3**'s "the swap is bounded to one file"
paragraph and in the **MOTIR-2389 bullet** under _Consequences_. Nothing else in
this record changes, and no clause is withdrawn. The companion correction to the
same count in `attachment-access-control.md` is that record's Amendment 3, landed
by this same card.

### What was wrong

Both sites stated that `lib/blob/uploader.ts` **"exports nine functions"**. It
exports **eight**, alongside three interfaces — so nine is neither the function
count nor the export count, and matches no reading of the file.

The paragraph it sits in is the one a reader leans on hardest: its whole argument
is that the provider swap is _bounded_, and the number is offered as the measure
of that boundedness. The boundedness was real — the swap was bounded by the LIST
of exports, which MOTIR-2389 worked from and which is correct — but the number
quantifying it was never read back from the file.

### What the file actually exports — read, not assumed

Observed on `origin/main`, 2026-08-07:

```
$ git grep -c '^export' origin/main -- lib/blob/uploader.ts
11
$ git grep -c '^export async function' origin/main -- lib/blob/uploader.ts
8
$ git grep -c '^export interface' origin/main -- lib/blob/uploader.ts
3
```

| Reading           | Value                                               |
| ----------------- | --------------------------------------------------- |
| `async function`s | **8**                                               |
| `interface`s      | **3** (`PutResult`, `PrivatePutResult`, `BlobHead`) |
| Total `export`s   | **11**                                              |
| What was written  | 9 — neither                                         |

**The number was never right, not even for the pre-migration file this record was
describing.** The same greps at `16bef033` — the last commit before MOTIR-2389
was authored — return the identical eight function names and three interfaces.
This is not a count that drifted as the file grew; it was wrong when written.

The authoritative list of the eight, name by name, lives on **MOTIR-2402** and
**MOTIR-2389**, which work from a table of them. This record deliberately does not
restate that table: an ADR needs the correct count and a pointer, not a duplicated
API listing that acquires its own drift.

### Why an amendment rather than a silent replacement

A find-and-replace would leave this record looking as though it had always been
right. The convention in this directory — Amendment 2 above,
`attachment-access-control.md`'s Amendment 2, `public-api-conventions.md`'s
Amendments 9–11 — is that a correction is recorded, not overwritten, and that
holds even when the corrected fact turned out to be harmless.

That harmlessness is the point rather than a reason to shrug. An unverified fact
that happens to be harmless is indistinguishable, at the moment it is written,
from one that is not; this one travelled from a card into two accepted decision
records without anyone opening the file it described. Left in place, it teaches
the next reader that the numbers in these documents are decorative.

### The general lesson this record now carries

**A count is a reading, not a recollection.** The same rule Amendment 2 arrived at
for identifiers — paste the value from the tool that owns it — applies to
quantities about our own code: a number describing a file belongs in a document
only with the command that produced it. `git grep -c '^export' <file>` costs one
command, and it is the difference between a fact and an impression.

### What this amendment does NOT touch

- **`lib/blob/uploader.ts` or any code.** Nothing is renamed, added or removed;
  the file is only counted.
- **Any decision.** Q2's choice of S3-on-Tigris, the two-bucket split, the 300 s
  expiry and the signing-time content type all stand.
- **The eight names themselves.** They live on MOTIR-2389 / MOTIR-2402; this
  record points at them rather than copying them.

---

## Amendment 4 (2026-08-08) — the public bucket's contents are the objects `User.image` KEYS, not a URL it stores

> **Written by Story MOTIR-2384 · Subtask MOTIR-2444.** This amendment
> disambiguates ONE table cell. **It re-opens no decision and changes no fact** —
> Q2 still chooses S3-on-Tigris, the two-bucket split stands, the public bucket is
> still public-read, the 300 s presigned GET and the signing-time content type are
> untouched. Avatars are **not** becoming private.
>
> **Numbered 4.** Amendment 3 was the highest heading in this file, re-read at
> edit time rather than taken from the card, and no unmerged branch carries a
> higher one. The primary correction — the false sentence this cell merely sat
> near — is `attachment-access-control.md`'s Amendment 4, landed by this same
> card, and carries the full reasoning.

**Amends:** the **public** row of §3's bucket table. Nothing else in this record
changes, and no clause is withdrawn.

### What was ambiguous

The row read:

> | **public** | avatars (`User.image`) and other public assets | public-read; a directly fetchable URL |

Each half is true of what it describes — the parenthetical names which assets go
in the bucket, the access clause describes what the bucket grants — but they sit
on one row, and after **MOTIR-2404** (motir-core#1937) the juxtaposition reads as
a claim the column does not support. `User.image` now persists the object **key**;
the public URL is composed at the read boundary by `storedAssetUrl`
(`lib/blob/referencedUrls.ts`). The bucket is still directly fetchable. The column
no longer stores what you fetch.

The row now reads "avatars (the object `User.image` keys)". The access clause is
unchanged, because it was never wrong.

### Why the cell was worth touching at all

An ambiguity a reader resolves correctly nine times out of ten is not free in a
record like this one. `User.image` was the last place a **hosting origin** was
persisted as data, and removing it is what lets this Story move hosts without a
data migration. A table that can be read as "the column holds the URL" is an
invitation to put one back, and the invitation is hardest to refuse in exactly the
situation that produces it — a future migration, written by someone reading this
record precisely because they were not there.

### What this amendment does NOT touch

- **Any decision.** Q1's choice of Fly, Q2's S3-on-Tigris and the two-bucket
  split, and every other Q stand.
- **The access model.** The public bucket is public-read; the private bucket is
  presigned-GET only.
- **Any code or anything on the platform.** MOTIR-2404 shipped the change this
  cell now reflects; no bucket, object or ACL is touched here.

---

## Amendment 5 (2026-08-10) — Q9's premise was wrong: one ORG is not one 6PN. The seam is applied, and it now depends on motir-ai never scaling to zero

> **Written by Story MOTIR-2384 · Subtask MOTIR-2426.** Amendment 1 recorded the
> decision to move the core→ai seam onto private networking. **This amendment
> records what happened when it was applied**, and corrects the premise that
> amendment rested on. **Q9's decision STANDS and is now in force** —
> `MOTIR_AI_URL` is `http://motir-ai.internal:8080` in production. What changes is
> the _reason it works_, and a new operational constraint that came with it.
>
> **Numbered 5.** Amendment 4 was the highest heading in this file, re-read at
> edit time from `origin/main` rather than taken from the card; no unmerged branch
> and no sibling worktree carries a higher one, and the repository has no open pull
> requests. All clock times below are the platform's own, in UTC.

> ---
>
> ## ⚠️ CORRECTION (2026-08-21, [MOTIR-3231](motir:cmt1l327r009wi3phchsbix05)) — the sentence above was TRUE WHEN WRITTEN and FALSE IN PRODUCTION for at least eleven days
>
> **"Q9's decision STANDS and is now in force" did not describe the deployment.**
> Read from inside motir-core machine `83d1300b7460e8` on 2026-08-20 22:34Z:
>
> ```
> $ printenv MOTIR_AI_URL
> https://motir-ai.fly.dev
> ```
>
> The PUBLIC origin — and an explicitly set Fly secret, not an unset variable
> falling back to a default. **The deployed value was the rollback this very
> amendment documents below as "executed and reversed".**
>
> **WHEN it reverted is NOT KNOWN, and this record will not guess.** A Fly secret
> carries a digest and a `Deployed` marker, not a history, so nothing available
> distinguishes "the reversal never took" from "a later change re-applied the
> rollback". The window is bounded only at its ends: correct when this amendment
> was written on 2026-08-10, wrong when it was read on 2026-08-20.
>
> **HOW it was re-applied** — 2026-08-21, after checking the 6PN allocation on
> both sides first (`/48 = fdaa:ab:2cdf` on all four machines, and
> `motir-ai.internal` resolving from inside motir-core to both motir-ai
> machines):
>
> ```
> # SUPERSEDED (Amendment 9, MOTIR-7407) — what was run on 2026-08-21. Do NOT run it:
> # since 2026-10-02 motir-ai suspends to zero and `.internal` cannot wake it.
> # The value in force: fly secrets set -a motir-core MOTIR_AI_URL=https://motir-ai.fly.dev
> fly secrets set -a motir-core MOTIR_AI_URL=http://motir-ai.internal:8080
> ```
>
> read back from inside **every** running motir-core machine rather than from the
> command's exit code — one machine is not the deployment (the lesson
> [MOTIR-3281](motir:cmt24usrq0030i4phr6ujdcg0) paid for, where a `secrets set`
> half-applied and the machine one would naturally sample was the one that looked
> right).
>
> **What this does NOT change in the amendment below.** Its correction of Q9's
> premise — that one ORG is not one 6PN — stands and was never in question. Its
> `force_https` finding stands _for `.internal`_, and Amendment 8 §26 records why
> it does not transfer to a proxy-routed private address. Its **NEW CONSTRAINT**
> (that motir-ai cannot scale to zero because `.internal` cannot wake a stopped
> machine) is still true of the transport — but it has not been the binding reason
> for that app's floor since Amendment 7 §14: the floor there is the
> job-concurrency ceiling, and Amendment 8 §25 confirms the transport does not
> unpin it.
>
> **And `.internal` is the INTERIM here, not the destination.** Amendment 8 §23
> decides **Flycast** for this leg; §26 records why it cannot be applied until
> motir-ai's `force_https` is off, which needs this seam off the public origin
> first. This correction is that first step.
>
> **SCOPE — this correction touches ONE secret.** It changes `MOTIR_AI_URL` and
> nothing else. The **ai→gateway** leg is not in its scope and was not altered by
> it: that leg moved from `motir-gateway.internal:3000` to
> **`motir-gateway.flycast`** separately and deliberately, under Amendment 8 §23
> and [MOTIR-3281](motir:cmt24usrq0030i4phr6ujdcg0) — with its own measurement,
> its own `force_https` change and the release of that app's public addresses.
> Neither card is licence for the other, and the ai→core callback
> (`MOTIR_CORE_URL`) stays public permanently under §23 regardless.
>
> **The general lesson, since this record is where a reader will look for it:** an
> amendment that says a decision is _in force_ is asserting something about the
> DEPLOYMENT, and only a reading of the deployment can support it. A `secrets set`
> that exited 0 cannot.
>
> ---
>
> ⚠️ SUPERSEDED by **Amendment 9** (2026-10-03, MOTIR-7407): the "in force"
> value above — and the correction's re-application of `.internal` — no longer
> describe production. `MOTIR_AI_URL` is `https://motir-ai.fly.dev` since
> 2026-10-02, when the NEW CONSTRAINT below came true.
>
> ---

**Amends:** Amendment 1's _"The facts this rests on"_ table and the sentence that
generalises it. It adds no Q and withdraws no decision. §1's Q1, Q3 and Q7 are
untouched, as are Amendments 2, 3 and 4.

### The premise that was wrong

Amendment 1 says, of Q9:

> private networking works **because both apps are in one org**

Both apps are in one org — that reading was correct, and Amendment 2 corrected the
org's name to `moooon`. **The inference from it was not.** Being in one
organisation does not put two apps on one 6PN, and — the case actually
encountered — it does not guarantee that machines in one organisation hold
addresses from the **same allocation**.

When MOTIR-2426 ran, `http://motir-ai.internal:8080` **timed out at TCP connect**
from inside a motir-core machine. Not a redirect, not a refusal: no route at all.
The private addresses were:

| machine                        | created    | private /48    |
| ------------------------------ | ---------- | -------------- |
| motir-gateway `1850e6ef954d98` | 2026-06-17 | `fdaa:79:c4a6` |
| motir-ai `3d8d5d20b37348`      | 2026-07-10 | `fdaa:79:c4a6` |
| motir-core `7817663f103648`    | 2026-08-09 | `fdaa:ab:2cdf` |
| motir-core `83d1300b7460e8`    | 2026-08-09 | `fdaa:ab:2cdf` |

**The split followed machine creation date, not the app.** A 6PN address is
allocated at _machine_ creation and survives `fly deploy`, which updates machines
in place — motir-ai's machine was created on 2026-07-10 and merely updated on
2026-08-07, so it still carried a July address after every deploy since.

Four control-plane views said all three apps were in one network (Machines API
`network: "default"`; GraphQL `networkId` identical; `_apps.internal` listing all
three; `motir-ai.internal` resolving). Only `_instances.internal` — the registry
of actual machine membership — omitted the June/July machines. **A name that
resolves is not a route.**

### What the fact table should have said

Replace the reasoning behind the first row, not the row itself. The determinant is
not organisation membership but this:

- **Two apps can reach each other over `.internal` when their MACHINES hold
  addresses from the same 6PN allocation.** Same org is necessary and not
  sufficient.
- **The check is a comparison, not a lookup**: `fly machine list -a <app> --json`
  → `private_ip`, and compare the `/48` on both sides. `_instances.internal`, read
  from inside a machine, is the authoritative membership list; `<app>.internal`
  resolving proves nothing.
- **The probe that isolates the layer** is a TCP connect to **port 22** of the
  target's private address: Fly's hallpass always listens there, so `TIMEOUT`
  means no route (a network problem) and `ECONNREFUSED` means routed with nothing
  listening (an application-bind problem).

### The remedy, and why it was cheap

**Recreating the machine is the whole fix.** `fly scale count 2 -a motir-ai`
created a machine on `fdaa:ab:2cdf` — same app, same `fly.toml`, same image, same
guest; only the creation date differed. The stale machine was destroyed and the
pair restored, both now on the current allocation. No Flycast, no app recreation,
no `fly.toml` change.

⚠️ **`fly deploy` will NOT do this.** It updates machines in place and preserves
their addresses. Only creating a machine allocates a new one.

Had the apps genuinely been on separate 6PNs, the remedy would have been far more
expensive, and it is worth recording why so nobody re-derives it: an app's 6PN is
fixed **at app creation and cannot be changed**, so the only supported path is
Flycast — which routes through the Fly **proxy** rather than machine-to-machine,
and whose documentation says _"Don't use `force_https`; Flycast is HTTP-only."_
That would have forced a change to motir-ai's public listener, not a secret flip.

### The `force_https` question is SETTLED, by observation

Amendment 1 left deliberately unasserted whether motir-ai's `force_https = true`
would redirect plain-HTTP 6PN traffic. It does not, and the reason is structural:
**`.internal` is machine-to-machine and never traverses the proxy that
`force_https` configures.**

Measured from motir-core machine `83d1300b7460e8`:
`GET http://motir-ai.internal:8080/health` → **200**, `{"status":"ok"}`, **no
`location` header**, served by motir-ai machine `8d1020fee34298`. `/` returns 404
on both the internal and public origins alike — motir-ai has no route at root.

### ⚠️ NEW CONSTRAINT — the seam now depends on `min_machines_running`

The same property that makes `force_https` irrelevant has a cost: **no proxy is
involved, so nothing can autostart a stopped machine for `.internal` traffic.**
motir-ai runs `auto_stop_machines = true`, and it does stop machines — the platform
log during this work reads _"App motir-ai has excess capacity, autostopping
machine … 1 out of 2 machines left running"_.

**This is safe today, and that was measured rather than assumed.** Fly
**deregisters stopped machines from `.internal` DNS**: with one motir-ai machine
stopped, `motir-ai.internal` resolved to the started machine only, and ten
consecutive name-based requests all returned 200.

**It is safe because `min_machines_running = 1` guarantees one machine is always
up.** If motir-ai is ever set to scale to zero, `motir-ai.internal` resolves to
nothing and there is no proxy to wake it — the seam fails with no fallback. That
constraint did not exist while `MOTIR_AI_URL` was the public origin, and it is the
real price of Q9.

> ⚠️ **This came true on 2026-10-02** — see **Amendment 9** (MOTIR-7407).
> motir-ai's `fly.toml` went to `min_machines_running = 0` with self-suspending
> machines (MOTIR-7095), and every core→ai call made while the pool slept failed
> as `fetch failed` from 13:27 to 19:16 UTC. The seam moved back to the public
> origin.

### Rollback — proven, not merely written down

`fly secrets set -a motir-core MOTIR_AI_URL=https://motir-ai.fly.dev`. It was not
recorded and left untested: it was **executed and reversed** during MOTIR-2426, as
the control for an unrelated ambiguity, so its validity is an observation. The
public origin answered `/health` with 200 before the switch, while rolled back,
and again at the end. Nothing in this Story decommissions motir-ai's public
listener.

### A related fact this record should carry

**motir-core does not listen on IPv6.** Its Dockerfile sets `ENV HOSTNAME=0.0.0.0`
deliberately — the comment there warns that omitting it fails silently — and
`0.0.0.0` is IPv4-only. The Fly proxy reaches it; `.internal` cannot. Measured:
motir-core → its own private address on port 8080 gives ECONNREFUSED while port 22
on that same address is OPEN.

This does not affect Q9, whose direction is core→ai. **It means the reverse
direction is not available without a bind change**, which is worth knowing before
anyone proposes one. motir-ai has no such problem: it binds via Hono's
`serve({ fetch, port })` with no hostname, which Node defaults to `::`.

### What this amendment does NOT touch

- **Any decision.** Q9 stands and is in force; Q1, Q3 and Q7 stand as Amendment 1
  left them.
- **`MOTIR_BASE_URL`.** Still the public `https://app.motir.co` — verified
  unchanged, by digest, across the switch. The callback direction stays public
  because those links appear in mail users click.
- **Authentication.** `MOTIR_AI_SERVICE_TOKEN` still gates every request.
  Amendment 1's last row was not filler then and is not now: a private address
  removes public reachability, it does not confer trust.
- **Any application code**, `.env.example`, any Playwright config, or any
  workflow. `grep -n 'motir-ai.internal'` over all of them returns no hits; the
  internal address exists only as a deployed secret.

---

## Amendment 6 (2026-08-10) — hosting stays in `iad`, and this is now a RESIDENCY decision rather than only a latency one

> **Numbered 6.** Amendments 1–5 were checked on `origin/main` and on every
> unmerged `parent/*`, `subtask/*`, `design/*` and `docs/*` branch before this
> number was taken; none carried a sixth. Authored on
> `docs/MOTIR-1122-production-service-stack` (MOTIR-1122).

**This record chose `iad` twice — in Q1 and again in Q6 — and both times argued it
from co-location and latency.** Neither mention asks where the personal data of a
Dutch company's users is allowed to rest. That question was put to this record on
2026-08-10 while MOTIR-1122 was deciding the production service stack, and the
answer belongs here rather than in that card, because it governs the platform and
not the vendors.

**It re-opens nothing.** Q1 still chooses Fly, Q6 still chooses two machines, and
the region is still `iad`. What changes is that `iad` is now a decision with a
recorded reason and a named reversal trigger, instead of a value inherited from
`motir-ai/fly.toml`.

### Q10 — may moooon B.V. host the application and its database in the US?

#### The decision

**Yes, and it does. Production stays in `iad` (us-east-1): motir-core, motir-ai
and motir-gateway on Fly, the Neon database, and the two Tigris buckets.**

#### The regulation, stated once so nobody re-derives it

|                                                             |                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GDPR** applies, and hosting location does not change that | Art. 3(1) covers processing in the context of an EU establishment's activities **"regardless of whether the processing takes place in the Union or not."** moooon B.V. is established in the Netherlands, so GDPR applies to Motir in Virginia exactly as it would in Amsterdam                           |
| **There is no data-localisation requirement**               | Nothing in GDPR requires an EU controller to store data in the EU. Chapter V regulates _transfers_; it does not prohibit them                                                                                                                                                                             |
| **Dutch specifics**                                         | The `UAVG` implements GDPR nationally; the supervisory authority is the **Autoriteit Persoonsgegevens**. Cookies/tracking are governed by **Telecommunicatiewet art. 11.7a**, not by GDPR — which is why the analytics choice in `production-service-stack.md` §5 matters and the hosting region does not |
| **NIS2**                                                    | Out of scope at current size (medium-enterprise threshold). Re-check on growth                                                                                                                                                                                                                            |

**A US transfer needs one of two bases**, and which one is a per-vendor fact:

- **Adequacy** — the EU-US Data Privacy Framework (Commission Implementing
  Decision (EU) 2023/1795). A transfer to a **DPF-certified** US organisation
  needs nothing further.
- **Standard Contractual Clauses** — Decision 2021/914, plus the transfer impact
  assessment _Schrems II_ (C-311/18) requires, for any recipient that is not
  certified.

⚠️ **Do not architect as though adequacy is permanent.** The DPF is the third
attempt: Safe Harbour fell in 2015, Privacy Shield in 2020, both at the CJEU. The
insurance is cheap and is therefore required — **every processor's DPA must also
offer SCCs**, so an adequacy collapse is a paperwork event and not a migration.
Verifying this per vendor is MOTIR-1160's, against the public DPF list rather
than against a vendor's marketing page.

#### Why STAY, given the move to the EU is technically available

Fly has `ams` / `fra`, Neon has EU regions, Tigris is region-configurable. The
argument is not that EU hosting is hard; it is that it is not worth buying today.

1. **The switching cost was just spent.** MOTIR-2391 created the Neon project in
   `us-east-1` and dumped-and-restored into it on 2026-08-07. Moving now means
   doing that again, plus re-regioning three Fly apps that **cannot** be split
   (Amendment 1's private-networking seam and Q7's free same-region transfer both
   assume co-location), plus re-copying two Tigris buckets — a second platform
   migration landing on top of one that has not finished retiring its predecessor.
2. **Self-hosting is Motir's residency answer, and it is a better one than a
   region.** A buyer who requires EU residency runs the GPL-3.0 core in their own
   datacentre. That is what the open-core split in Q1's sibling record is for. The
   segment EU hosting would additionally unlock is _"requires EU residency AND
   will not self-host"_ — real, but narrow.
3. **Sovereignty is not the product's pitch.** The three pillars are AI planning,
   project management and agent orchestration. Infrastructure should not be spent
   on a differentiator that is not being sold.
4. **`iad` is the better neutral default** for a product with an undecided market:
   Amsterdam is better for Europe and worse for the US and Asia.

#### What would reverse it — one trigger, and it is commercial

**The first prospect with a contractual EU-residency requirement who will not
self-host.** Then the migration is funded by a deal, which is the only condition
under which it should happen. Not a preference, not a feeling about where a Dutch
company ought to keep its data — a signed requirement.

**Two obligations keep that reversal cheap, and they are the price of this
decision:**

- **Adopt nothing region-locked.** Every element of the stack has an EU region
  today; a dependency that does not is a decision to re-open this one.
- **MOTIR-2391's runbook is the migration script for move #2.** Its acceptance
  criteria already required recording the database size and the dump/restore
  duration. That is what makes a second move a replay rather than a rediscovery,
  and it is why waiting is safe rather than merely cheaper.

#### Rejected alternatives

| Alternative                              | Why not                                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Move everything to `ams` / `fra` now** | A full repeat of a migration completed three days ago, for a benefit no customer has asked for and that self-hosting already answers                                                    |
| **Compute in `iad`, database in the EU** | The worst of both: a cross-Atlantic round trip on every query, and the processing still happens in the US — so it does not even buy the residency claim it looks like it buys           |
| **A Neon read replica in the EU**        | A replica is not residency. The primary still holds the data and the writes still land in it. Naming this so nobody later mistakes one for the other                                    |
| **Defer, and decide when asked**         | What this amendment refuses. "No decision" reads identically to "`iad` because motir-ai was there", which is how the question went unasked through Q1, Q6 and an entire migration Story |

#### What this amendment does NOT touch

- **Any existing decision.** Q1 (Fly, `iad`), Q6 (two machines), Q7 (egress) and
  Amendment 1's private-networking seam all stand exactly as written.
- **The vendor choices.** Those are `production-service-stack.md`'s. This record
  governs only where the application and its database run — which is the input
  that record's §3 reads when it picks a monitoring region.
- **Any code, workflow or config.** `fly.toml`'s `primary_region` is already
  `iad`; this amendment records why, and changes no line.

#### Sources — additions

| Claim                                                                 | Source                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| GDPR applies regardless of where processing occurs                    | Regulation (EU) 2016/679, Art. 3(1)                                                          |
| Transfers to DPF-certified US organisations need no further mechanism | Commission Implementing Decision (EU) 2023/1795 (10 July 2023)                               |
| SCCs as the non-adequacy route; TIA required                          | Commission Decision 2021/914; CJEU C-311/18 (_Schrems II_)                                   |
| Dutch implementation and supervisory authority                        | `Uitvoeringswet AVG`; Autoriteit Persoonsgegevens                                            |
| Cookie/tracking consent is ePrivacy, not GDPR                         | Telecommunicatiewet art. 11.7a                                                               |
| The database is in `us-east-1`, moved 2026-08-07                      | MOTIR-2391, `done` — its own acceptance criteria record the project identity and the restore |

## Amendment 7 (2026-08-20) — the scaling posture for ALL THREE services: the pool is a ceiling, the FLOOR is the availability decision, and on `motir-ai` the floor is also the job-concurrency ceiling

> **Written by Story MOTIR-2781 · Subtask MOTIR-2780.** Q6 decided a machine pool
> for `motir-core` and Q8 explicitly scoped `motir-ai` and `motir-gateway` OUT of
> this record. **This amendment retires that exclusion** and decides the pool, the
> availability floor, the VM size, the concurrency signal and the instance ceiling
> for all three.
>
> **Numbered 7.** Amendment 6 was the highest heading on `origin/main`, re-read at
> edit time; every remote branch was scanned for a seventh
> (`git show origin/<branch>:docs/decisions/application-hosting.md | grep '^## Amendment 7'`
> over all heads, 2026-08-20) and none carries one. The one open pull request
> against this repository (#2209) does not touch this file. All clock times are the
> platform's own, in UTC.

**Amends:** §7/Q6's scope (motir-core only → all three) and §9/Q8's row
_"`motir-ai`, `motir-gateway` — out of scope"_, which is **withdrawn**. It
withdraws no decision: Q6's pool of two stands, Q10's `iad` stands, Amendment 5's
`.internal` constraint stands and is load-bearing below.

### Why this record and not a new one

Three services, one platform, one mechanic, and the mechanic is the whole
difference between a scaling story that works and one that reads as though it
does. Splitting it across three records would put the same paragraph in three
places and let two of them drift. The exclusion in Q8 was written when this record
was about **moving motir-core**; it was never a judgement that the other two
should be decided elsewhere.

---

### §11 — The mechanic, restated once, because every number below depends on it

**Fly Proxy's autostart/autostop never CREATES or DESTROYS a machine.** It starts
and stops machines that already exist. So:

- **The pool is the ceiling.** `fly scale count <n>` — an operator action — is the
  only thing that raises it. `fly.toml` cannot, and `flyctl deploy` updates the
  machines that exist without adding one.
- **`min_machines_running` is a floor on how many of that pool the proxy will not
  stop.** It is **not** a failover guarantee. If the last running machine dies,
  `flyd` restarts _that machine_ — a boot, with boot latency, on the same host
  class. Nothing takes over. **Two machines RUNNING is the only configuration that
  survives losing one without a gap**, and that is a different setting from a pool
  of two.
- **A stopped pool member is nearly free** — rootfs only, $0.15/GB per 30 days, no
  compute (Fly pricing, read 2026-08-13). **So the pool should be sized for the
  peak you must be able to SERVE, not for the load you have**: capacity you have
  not pre-created is capacity the proxy cannot give you, and capacity you
  pre-create and never run costs cents. The bill follows what actually runs.
- **There is no spend cap and no billing alert.** `ci-runner-fleet.md` §9, re-read
  on `origin/main` 2026-08-20 and unchanged by #2174: _"We don't support billing
  alerts (yet)"_ and _"there's no soft ceiling."_ The pool is the only backstop
  that exists.

### §12 — Measured first, 2026-08-20, from the PLATFORM

Every number below was read from Fly's Machines API or from inside the running
machine on 2026-08-20, not from a `fly.toml`.

| app             | pool | states at 13:05Z         | VM                     | MemTotal     | main process, RSS at idle                                       |
| --------------- | ---- | ------------------------ | ---------------------- | ------------ | --------------------------------------------------------------- |
| `motir-core`    | 2    | 1 `started`, 1 `stopped` | 2× shared CPU / 2 GB   | 2 015 600 kB | `next-server` **399 732 kB (390 MB)**                           |
| `motir-ai`      | 2    | 1 `started`, 1 `stopped` | 2× shared CPU / 2 GB   | 2 015 600 kB | `node` **234 164 kB** + a second `node` 114 860 kB = **341 MB** |
| `motir-gateway` | 2    | 1 `started`, 1 `stopped` | 1× shared CPU / 512 MB | 469 852 kB   | `one-api` **81 364 kB (79 MB)**                                 |

All three `iad`-only. Command:
`fly ssh console -a <app> --machine <id> -C "/bin/sh -c 'for p in /proc/[0-9]*; do … VmRSS … done | sort -rn | head'"`.
**Every reading is AT IDLE** — it sizes the baseline and says nothing about load.

**⚠️ Two rows have moved since this Story was written, and both matter:**

- **`motir-gateway`'s pool is 2, not 1.** `fly scale count 2` was run out of band
  on 2026-08-13, creating machine `2862102a006e98`. This amendment **ratifies**
  it (§13).
- **`motir-gateway` PR #15 MERGED on 2026-08-14, and it did NOT set
  `min_machines_running = 0`.** MOTIR-2782 records it as open and proposing 0.
  What actually merged keeps the floor at **1**, raises `SYNC_FREQUENCY` 60 → 600,
  and writes out the reason at length — ending _"MOTIR-2780 owns that pairing."_
  §14 is that answer.

#### Has `motir-core`'s spare ever started? — MOTIR-2785 AC2, answered

**Yes, and it starts on every deploy — then the proxy stops it about five and a
half minutes later.** Read from the Machines API `events[]` for
`7817663f103648`, 2026-08-20:

```
12:29:18.569Z  start     started   flyd     ← a deploy started it
12:34:48.720Z  cordon    started   proxy
12:34:58.772Z  stop      stopping  proxy    ← the proxy stopped it, 5m40s later
12:34:59.395Z  exit      stopped   flyd
12:35:01.807Z  uncordon  stopped   flyd
```

So the pool is not decoration and the autostart path works. **What it does not do
is stay up.** From 12:35Z onward `motir-core` served its entire load from one
machine, which is the state this amendment is about. (The API retains five events
per machine, so this is the recent window, not the lifetime history.)

---

### §13 — Q11: the POOL, per service

| service         | pool                                         | decision                                                               |
| --------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `motir-core`    | **2**                                        | Unchanged. Q6 stands and its reasoning is untouched.                   |
| `motir-ai`      | **2**                                        | Unchanged. Its `fly.toml` already reasons the mechanic out correctly.  |
| `motir-gateway` | **2 now, 4 once the rate limiter is shared** | **Ratifies** the out-of-band scale of 2026-08-13, and gates the raise. |

**Why the gateway's pool is ratified rather than reversed.** Reversing is one
command and the pool is not the hazard — the _second running process_ is (§16).
At a floor of 1 the spare only starts above `soft_limit`, and current traffic is
nowhere near it, so the pool of two is inert in exactly the way the pool of one
used to be. Reversing would buy nothing and would have to be undone.

**Why the gateway's ceiling is the one raised ahead of demand.** It is the only
service whose load we do not control — customers' own applications and Epic 9's
hosted agents ([MOTIR-673](motir:cmqfb4me600k82d0ieesj6uul)) — and a ceiling
converts a spike into an **outage** rather than a cost. Four stopped
`shared-cpu-1x` machines cost rootfs only. **The gate is MOTIR-2782's rate-limiter
work, not a traffic number**: see §16.

### §14 — Q12: the AVAILABILITY FLOOR. This is the decision, and it is not the pool

The current answer on all three is `min_machines_running = 1`, which means **one
machine is a single point of failure on every service we run**, whatever the pool
says. The spare is stopped; it wakes on load crossing `soft_limit`, never on its
sibling dying.

| service         | floor                                  | when                                                                          | why                                                                                                                                                          |
| --------------- | -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `motir-core`    | **1 → 2**                              | now — MOTIR-2785                                                              | user-facing; a crash or host drain today is a visible outage until `flyd` reboots                                                                            |
| `motir-ai`      | **1 → 2**                              | **only after MOTIR-3221 + 3222 + 3223 have merged AND deployed** — MOTIR-2783 | the floor is the JOB-CONCURRENCY ceiling here, and raising it makes the mid-job kill hazard live                                                             |
| `motir-gateway` | **1, and explicitly NOT 0; NOT 2 yet** | now — MOTIR-2782                                                              | `.internal` cannot wake a suspended machine (floor 0 = outage); a second _running_ process doubles every rate limit (floor 2 = a silently weakened throttle) |

#### `motir-core` — 2, and the marginal database cost is zero

Cost: **+$11.83/mo** (`shared-cpu-2x` 2 GB, Fly pricing 2026-08-13), taking the
pair to $23.66/mo running continuously.

**And no database cost, which is the half Q8 asks for.** motir-core runs **no
in-process background loop**: `grep -rn 'setInterval(' lib app` over `origin/main`
returns five hits and every one of them is in a `'use client'` hook or component.
Its scheduled work runs through Inngest, which reaches the app **over HTTP** and
would reach one machine whether or not a second is warm. So a second warm
motir-core machine adds machine-hours and **not** compute-hours.

> **⚠️ Revisit trigger, stated now because it will not be obvious later.**
> MOTIR-2852 and MOTIR-2853 exist to stop motir-core's timers holding its Neon
> compute awake (measured duty cycle 99%, 2026-08-13). **When they land, the
> database will begin to sleep, and at that point a second warm machine still
> costs nothing extra** — it runs no query of its own. The trigger that WOULD
> re-price this floor is any future in-process poll on motir-core, which this
> paragraph is the standing argument against.

#### `motir-ai` — 2, and the reason is not availability

**The floor on `motir-ai` is the job-concurrency ceiling, and this is the finding
that reframes MOTIR-2783's question.** Read on `origin/main` 2026-08-20:

- `startWorker` (`src/jobs/worker.ts`) guards its loop with a `ticking` flag, so
  **one machine runs at most ONE job at a time.** `claimNextQueued`'s own comment
  says so outright: _"one machine runs one job at a time."_
- A **stopped** machine runs no worker at all.

So **peak concurrent planning jobs = the number of RUNNING machines**, and today
that number is **one**. The queue can be arbitrarily deep and nothing will wake
the spare, because the only thing that wakes it is HTTP concurrency and the job
backlog does not move HTTP concurrency (Q2). **`min_machines_running = 2` is not a
nicety on this service; it is the only mechanism by which a second worker exists.**

**But it must not be applied yet.** Raising the floor to 2 puts two machines
permanently in the state where both are doing work, and that is exactly the state
in which a machine can be killed mid-job — with, today, no drain and no reaper, so
the job stays `running` forever and wedges its whole planning session (§16). The
sequence is therefore decided rather than left to whoever runs the card:

1. **MOTIR-3221** — the claim takes ownership (`claimedBy` + `leaseExpiresAt`).
2. **MOTIR-3222** — the reaper expires a stale lease and frees the wedged key.
3. **MOTIR-3223** — the worker drains on `SIGTERM` instead of being killed at five
   seconds.
4. **Then** MOTIR-2783 raises the floor to 2.

The plan already encodes step 4's dependency (MOTIR-2783 is `blocked_by`
MOTIR-3222); this record is why.

Cost: **+$11.83/mo** when applied. **Database: $0, and since 2026-08-20 that is
structural rather than a margin.** The second machine's worker runs **no idle
poll** — [MOTIR-3224](motir:cmt1gpozk00kpi2phgjsqn228) deleted the re-arm, so an
idle worker issues no query at all and cannot hold the compute awake. (This
paragraph previously priced the same $0 against a 10-minute idle tick clearing a
five-minute suspend threshold. Both halves of that sentence were wrong by
2026-08-20: the tick is gone, and the threshold is ~9 minutes measured, not five
— see §21.)

#### `motir-gateway` — 1, and the floor and the transport are ONE decision

**Not 0.** This ratifies, rather than re-derives, the reasoning that merged in
PR #15: `motir-ai` addresses this app as `http://motir-gateway.internal:3000/v1`;
6PN is machine-to-machine, **no proxy is involved**, and suspended machines are
deregistered from `.internal` DNS (measured 2026-08-13 at a pool of 2). At a floor
of 0, four minutes of quiet suspends every machine, the name resolves to nothing,
and **every planner LLM call and every search call fails with nothing in the
system able to start a machine again.** The saving — about $9.75/mo of Neon
compute — is real and is not worth a planning layer that a quiet afternoon takes
down.

**`min_machines_running = 0` becomes available the moment `motir-ai` reaches this
app through something the proxy serves** — Flycast (private, proxy-routed, _can_
autostart) or the public origin. That is the pairing PR #15 named this card to
decide, and the answer is: **not until the transport changes.** It is not on this
Story; it is a candidate for whoever next revisits the seam, and it is the only
route to scale-to-zero here.

**And not 2 either, yet** — for a completely different reason: see §16.

**`auto_stop = "suspend"` stands**, with the caveat unchanged and now more
pointed: Fly documents `stop` as compute-free and documents **nothing** about
billing in the `suspended` state. **The saving attributed to suspend is an
expectation, not a contract — check it against a real invoice.** (Observed
2026-08-20: the gateway's spare sits `stopped`, not `suspended`, because a deploy
on 2026-08-19T22:43Z left it stopped and nothing has started it since. The
`suspend` path applies to a machine the proxy stops, not to one a deploy leaves
down.)

### §15 — Q13: WHICH signal each service scales on

`soft_limit` counts HTTP concurrency at the proxy. That is the right dimension for
exactly one of the three.

| service         | `type`            | soft / hard   | is it the scaling signal?                                                   |
| --------------- | ----------------- | ------------- | --------------------------------------------------------------------------- |
| `motir-core`    | `requests`        | 200 / 250     | **Yes.** Short interactive requests; HTTP concurrency _is_ the load.        |
| `motir-ai`      | `requests`        | 20 / 25       | **No — retired as a scaling signal.** Kept as a protective per-machine cap. |
| `motir-gateway` | **`connections`** | **100 / 150** | **Yes, once the dimension is right.** A stream is not a request.            |

**`motir-core` — the dimension is right and the NUMBER is an unmeasured
inheritance.** 200/250 has never been measured against a 2× shared-CPU box
running Next.js. It is recorded here as an **ESTIMATE**, not a reading.
**Trigger to revise:** the first sustained request-concurrency or p95-latency
reading from Fly metrics. Changing it on no data would be a measurement with
nothing behind it, which is the failure §10 already names.

**`motir-ai` — statically sized, and the number is now written down.** Q2 asked
for what replaces `soft_limit` or an explicit acceptance of static sizing. **It is
static sizing, and the capacity is `running machines × 1 job`.** The assumed peak
concurrent-job count is **1**, and its basis is that the only consumer is the
`moooon` tenant's own planning, driven by one human. **Trigger to resize:** a
second concurrent planning consumer — Epic 9, or self-hosted callers (§18, scoped
out). The 20/25 block stays as a cap that protects a box from a control-plane
burst; its comments must say it is not the scaling signal.

**`motir-gateway` — `connections`, because it holds each one open for the life of
a completion.** 200 concurrent _short requests_ and 200 concurrent _long-lived
streams_ are not the same load, and `requests` was transcribed from motir-core
where it means something else. **100 / 150 is an ESTIMATE**, chosen conservatively
for one shared vCPU: the memory reading says memory is not the binding constraint
(79 MB resident of 459 MB usable, ~5.7× headroom, so even at 100 KB of buffers per
stream the box holds thousands), so the constraint is CPU and upstream provider
limits, for neither of which we have a reading. **Trigger:** the first measured
concurrent-stream count under real traffic.

> **⚠️ ORDERING, inside MOTIR-2782's single PR.** Lowering the gateway's soft
> limit makes the proxy start the second machine SOONER — which is precisely the
> event that doubles every rate limit (§16). **So the concurrency block must not
> be lowered before the limiter is fixed.** In that card: resolve the limiter
> first, then the concurrency block, in one PR.

### §16 — Q14: the instance CEILING, per service, with the behaviour AT it

Fly offers neither a spend cap nor a billing alert, so **the pool is the cap** and
we have no way to be told we reached it. That fact shapes every row.

| service         | ceiling   | behaviour AT the ceiling                                                                   | how we learn                                        | 24/7 cost if all run |
| --------------- | --------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------- | -------------------- |
| `motir-core`    | **2**     | proxy queues behind `hard_limit` (250/machine), then refuses                               | a user report, or Fly metrics. **No alert exists.** | **$23.66/mo**        |
| `motir-ai`      | **2**     | jobs stay `queued` in `PlanJob` — the correct behaviour for a job runner; nothing 5xxs     | queue depth: `queued` rows with an old `createdAt`  | **$23.66/mo**        |
| `motir-gateway` | **2 → 4** | proxy queues, then refuses — **for a customer's production application that is an outage** | a customer report. **No alert exists.**             | **$13.28/mo** at 4   |

**Why the gateway alone gets headroom bought ahead of demand.** For motir-core and
motir-ai the caller is us, and a ceiling that turns a spike into queueing is a
cost control working as intended. For the gateway the caller is a customer's
production application, and the same ceiling is a refusal on their traffic. Since
a stopped member costs rootfs only, buying the ceiling ahead of the demand costs
approximately nothing, and **not buying it cannot be fixed at the moment it is
needed** — the proxy cannot create a machine.

#### The cost delta of everything decided above — AC6, in one place

Fly pricing read 2026-08-13: `shared-cpu-2x` 2 GB = **$11.83/mo** running;
`shared-cpu-1x` 512 MB = **$3.32/mo** running; a **stopped** machine is rootfs
only, **$0.15/GB per 30 days**, no compute; a **suspended** machine is documented
neither way. All three apps are on shared IPv4 (no $2/mo dedicated address) and
Anycast IPv6 is free. Egress $0.02/GB.

| change                                                     | machine delta           | database delta                                                                             |
| ---------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `motir-core` floor 1 → 2                                   | **+$11.83/mo**          | **$0** — ~~no in-process poll (§21)~~ the compute is already always on (the worker's poll) |
| `motir-ai` floor 1 → 2 (after 3221/3222/3223)              | **+$11.83/mo**          | **$0** — no in-process poll (§21)                                                          |
| `motir-gateway` floor stays 1                              | $0                      | $0                                                                                         |
| `motir-gateway` pool 2 → 4, both extra members **stopped** | **≈ $0** — rootfs cents | $0                                                                                         |
| **Total, once all of it is applied**                       | **≈ +$23.66/mo**        | **$0**                                                                                     |

> ⚠️ SUPERSEDED by [`always-on-database-job-cadence.md`](always-on-database-job-cadence.md) (MOTIR-6893, 2026-09-29): the `motir-core` row's
> $0 stands for a second web machine, but its reason is now that the compute is already always on
> because of the job worker's ≤ 5 s poll, not that nothing polls (MOTIR-6934).

For scale: the fleet runs at **≈ $27/mo** today (11.83 + 11.83 + 3.32), so this is
roughly a **doubling of the machine bill and no change to the database bill** —
and the database is the larger line item on any service that polls (§21). **The
availability floor is the expensive half of this amendment and the pool is the
cheap half**, which is the opposite of the intuition the word "scaling" produces.

⚠️ **Every figure here is a LIST PRICE, not an invoice.** The suspend gap (§22) is
the one that could move it, and it moves the gateway only.

#### ⚠️ THE GATE ON THE GATEWAY'S CEILING IS A RATE LIMITER, NOT A TRAFFIC NUMBER

`motir-gateway`'s rate limiting is **per process**, and `REDIS_CONN_STRING` is
**not set** — verified again 2026-08-20 (`fly secrets list -a motir-gateway`: ten
secrets, none of them Redis). `GlobalAPIRateLimit()` guards the whole `/api`
router and `CriticalRateLimit()` guards password reset, verification and
registration. **Every one of those limits becomes N× looser at N running
machines**, silently, with nothing in the config or the logs saying so.

**So the decision is:**

1. **The gateway's floor stays 1 and its ceiling stays 2 until the limiter is
   shared or the configured numbers are divided by the pool size.** Dividing is
   the fail-closed direction — it makes the limits _tighter_ when only one machine
   runs — and it is an acceptable interim; a shared limiter is the target.
2. **Redis is not a free companion to scaling and must not be added as a
   performance tweak.** `main.go` sets `config.MemoryCacheEnabled = true` whenever
   `RedisEnabled`, which switches ON the cache paths (`CacheGetTokenByKey`,
   `CacheGetUserQuota`, `CacheGetRandomSatisfiedChannel`). The gateway is
   machine-agnostic **today because those caches are off** and every lookup reads
   through to the shared Postgres. Turning Redis on moves that correctness from
   "there is no cache" onto "the cache is genuinely shared and correctly expired".
   **Land Redis together with the pool raise, or raise nothing.**

### §17 — Q15: stickiness. NO affinity anywhere, and the reasons, so nobody adds it

**`motir-ai` is genuinely stateless across machines.** Two independent reasons,
both read from the code rather than assumed:

- `claimNextQueued` claims with `SELECT … FOR UPDATE OF j SKIP LOCKED` inside a
  transaction — a **Postgres row lock**, exclusive across machines, not merely
  within a process.
- Progress is **DB-relayed**: `ctx.emit` persists each frame and
  `GET /v1/jobs/:id/stream` polls it back, so a client that submits to machine A
  and streams from machine B sees the same frames.

So motir-core reaching a freshly-woken motir-ai instance is **correct**, not a
bug. What it costs is cold start, not consistency — and the floor of 1 (§14)
already means no caller pays an unmeasured boot.

**`motir-gateway` is machine-agnostic in PART, and the part that is not is worth
naming precisely — because the card that raised this question got it wrong, and
so did the first draft of this section.** Read from `origin/main` 2026-08-20:

| state                                                      | gated on                                                  | at a pool of 2                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| sessions                                                   | `cookie.NewStore(SessionSecret)` — same secret everywhere | **shared.** No affinity needed                                                               |
| tokens, user quota, user group, user enabled, group models | `common.RedisEnabled` — **false** here                    | **shared.** Every one of these falls through to `DB.Where(...)` against the same Postgres    |
| **channel selection** (`CacheGetRandomSatisfiedChannel`)   | `config.MemoryCacheEnabled`                               | ⚠️ **PER PROCESS.** An in-memory map, refreshed by `SyncChannelCache` every `SYNC_FREQUENCY` |
| **options** (`SyncOptions`)                                | `config.MemoryCacheEnabled`                               | ⚠️ **PER PROCESS**, same refresh                                                             |

**The correction is that `MemoryCacheEnabled` is NOT derived from Redis.**
`common/config/config.go` reads it straight from the environment —
`strings.ToLower(os.Getenv("MEMORY_CACHE_ENABLED")) == "true"` — and
`motir-gateway`'s `fly.toml` sets `MEMORY_CACHE_ENABLED = "true"`. `main.go`
additionally forces it on when Redis is enabled, which is what makes _"Redis off
⇒ the caches are off"_ such a natural and wrong inference. **The caches are ON
today, with Redis off.**

**So the consequence, stated as a duration rather than a category:** with
`SYNC_FREQUENCY = 600`, two running machines can disagree about which channels
and options exist for up to **ten minutes** after an admin edit. Not about who a
token belongs to, or what quota they have left — those are read-through. About
which upstream a completion is routed to.

`fly.toml`'s `MEMORY_CACHE_ENABLED` comment already anticipated exactly this —
_"Safe on a single warm machine (`min_machines_running = 1`); revisit if scaled
out (needs `REDIS_CONN_STRING` for cross-instance cache coherency)"_ — and the
pool is now 2, so **the revisit is due**. It is not urgent for the same reason the
rate-limiter exposure is not: at a floor of 1 only one machine runs in steady
state, so there is one cache. **And it is a THIRD independent reason the floor
must not go to 2 before the shared-store work lands** (§14), alongside the
doubled rate limits. All three resolve together, or none of them does.

**No affinity, still** — that would paper over a divergence rather than remove
it, and it would break the read-through half for no benefit.

### §18 — Q16: the mid-job autostop hazard, MEASURED

**MEASURED on the real deployment, 2026-08-20. The hazard is REAL: Fly's proxy
stopped a machine that was pinned at 100% CPU with no HTTP arriving.**

Q5 suspected this and said _"VERIFY IT — do not reason about it."_ Here is the
verification. `motir-ai` runs `auto_stop_machines = "stop"` with
`min_machines_running = 1`, so machine `895905f6d67d68` was the one **above** the
floor.

**The experiment.** Start the spare; give it work that consumes CPU and is
invisible to the proxy — exactly the shape of a planning job, which is background
work on a machine that may be receiving no HTTP at all; send it no requests; poll
the machine state once a minute.

```
13:09:16Z  fly machine start 895905f6d67d68 -a motir-ai
13:09:19Z  start / started / flyd
13:09:2xZ  fly ssh console … -C "nohup sh -c 'while …; do :; done' &"   ← 100% CPU, no HTTP
           /proc/loadavg confirms the burn running
13:14:52.917Z  cordon  / started  / source=PROXY
13:15:03.042Z  stop    / stopping / source=PROXY     ← stopped WHILE BUSY
13:15:06.036Z  uncordon/ stopping / flyd
13:15:09.136Z  exit    / stopped  / flyd
```

**Elapsed from start to the proxy's stop: 5 min 44 s.** The busy process died with
the machine.

**The same window, measured independently the same day on a different app.**
`motir-core`'s spare `7817663f103648` (§12): `start` 12:29:18.569Z → proxy `stop`
12:34:58.772Z = **5 min 40 s**, with the identical `cordon → stop → uncordon →
exit` sequence. Two apps, two configurations, one window of roughly five and three
quarter minutes. **The idle timer is the proxy's, it is about REQUESTS, and it does
not look at the machine at all.**

#### What this proves, and what it does not

**Proves:** `auto_stop` on both `stop` (motir-ai, motir-core) is driven entirely
by proxy-visible traffic. A machine above the floor doing CPU-bound work with no
inbound requests **is stopped**, in under six minutes. Fly's own guidance agrees
in advance — for apps with background work it says _"have your app shut itself
down when idle"_ rather than rely on the proxy — but a vendor doc describing a
mechanism is not a reading of our machine, and this is the reading.

**Does not prove:** that a real `PlanJob` handler would be killed _today_.
It would not, and the reason is arithmetic rather than safety:
`min_machines_running = 1` shields one machine, the worker is single-flight, and
**with one machine running there is exactly one job and it is on the shielded
machine.** The hazard is unreachable at a floor of 1 and becomes reachable the
instant the floor is 2 — which is precisely what §14 decides to do.

#### ⚠️ AND THERE IS A SECOND WAY IN THAT IS LIVE TODAY, WHICH THE FLOOR DOES NOT SHIELD

The autostop path is the one Q5 asked about. **It is not the one that has been
firing.** Verified on `origin/main` 2026-08-20:

- `src/index.ts` is `serve(...)` plus `startWorker()`, and **the `stop()` that
  `startWorker` returns is discarded.** There is no `SIGTERM` or `SIGINT` handler
  anywhere in `src/`.
- `fly.toml` sets no `kill_timeout`, so Fly's default of **5 seconds** applies.

**So every deploy signals the machine, waits five seconds and force-kills whatever
job was mid-flight** — and the floor shields nothing, because a deploy replaces the
machine the floor is protecting. There were **six deploys in the thirteen hours
before 2026-08-20 10:00Z**.

#### The remedy, decided

A killed job is not merely lost. `claimNextQueued` selects `WHERE status =
'queued'` and its sibling clause skips any job whose `concurrencyKey` has a
`running` row — and `concurrencyKeyFor` derives `session:<aiProjectId>:<scopeKey>`.
**So one abandoned `running` row wedges every future job of that planning session,
permanently.** No poll interval reaches it; the predicate excludes it at every
tick, forever. Its `PlanningRun` strands too (`jobId` is `@unique`; only
`closeRunSafe` closes it), so metering keeps a run that never ended.

The remedy is three cards, and it is **prevention plus recovery, because neither
alone is sufficient**:

| card                                          | does                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MOTIR-3221](motir:cmt1gmu6c00i6i2phjiybnd5j) | the claim takes OWNERSHIP — `claimedBy` + `leaseExpiresAt`, renewed while the handler runs, every terminal write claim-scoped                        |
| [MOTIR-3222](motir:cmt1gnqvv00ixi2phf1mnz8he) | the REAPER — one atomic UPDATE at the top of each tick expires a stale lease, fails the job `ai_job_abandoned` and closes its orphaned `PlanningRun` |
| [MOTIR-3223](motir:cmt1gon3s00jpi2phtgfoofp4) | DRAIN on `SIGTERM` — stop claiming, leave the proxy, finish the in-flight job, with a `kill_timeout` sized against Fly's **300 s maximum**           |

**Fly caps `kill_timeout` at 300 seconds and a planning job can exceed five
minutes, so draining cannot be a guarantee** — which is exactly why the reaper is
not optional. Draining prevents most abandonments; reaping makes the remainder
recoverable instead of permanent.

**And it is a genuinely FAILING recovery, not a retry**: every claim opens a
metering run and debits credits, so silently re-running a killed job double-charges
a tenant for tokens already burned. `ai_job_abandoned` is a distinct code so
motir-core can tell _"the machine died under your job"_ from _"the handler rejected
your input"_.

**This is the sequencing §14 encodes.** The floor on `motir-ai` does not move to 2
until all three have merged and deployed.

### §19 — Q17: self-hosted `motir-core` callers — SCOPED OUT, with the trigger

**Every number in this amendment is sized for ONE internal caller.** If self-hosted
`motir-core` instances call hosted `motir-ai`, four things change at once and the
sizing is the least of them:

- **Origin** — traffic arrives from the public internet rather than 6PN. motir-ai
  already has a public listener, so this is not new capability; it becomes a
  load-bearing one.
- **Load shape** — many small tenants with uncorrelated peaks instead of one
  bursty internal caller. A _better_ shape for autoscaling and a worse one for a
  static size chosen against one caller, which is what §15 decides.
- **Auth** — the core→ai boundary is one shared `MOTIR_AI_SERVICE_TOKEN`. **A
  shared secret across many independent installations is the same class of problem
  [MOTIR-2778](motir:cmspvd9480054i3phmyvwhcbj) records at the gateway**: an
  identity that cannot distinguish callers. **Named here as OUT OF SCOPE so it is
  not discovered twice**; it is a security decision, not a sizing one.
- **Region** — self-hosters are not all in `iad`, which turns Q10 from a residency
  decision into a latency budget as well.

**The trigger that reopens this section: the first self-hosted instance pointed at
hosted `motir-ai`.** Not the first request for the capability — the first one
configured.

### §20 — Q18: region. Already decided; NOT re-decided here

**`iad`, all three, unchanged.** Amendment 6 (Q10) decided this as a **residency**
decision with a named reversal trigger — _the first prospect with a contractual
EU-residency requirement who will not self-host_ — and with two standing
obligations (adopt nothing region-locked; MOTIR-2391's runbook is the migration
script). Nothing in this amendment's traffic model touches that reasoning.

**Q4 of MOTIR-2780 asked for the region to be decided or deferred with a trigger.
It was decided, ten days earlier, in this same file.** Recording the pointer
rather than a second answer is the point: two live answers to one question is how
a record starts contradicting itself.

### §21 — Q19: the DATABASE coupling. The floor is priced with compute, not machine-hours

> **⚠️ AMENDED IN PLACE 2026-08-20 by [MOTIR-3257](motir:cmt1u6a2q000ai5ph1wjb16wa),
> after [MOTIR-3224](motir:cmt1gpozk00kpi2phgjsqn228) merged
> ([motir-ai#256](https://github.com/moooon-B-V/motir-ai/pull/256), 19:05Z).** Two
> things this section said on the morning of 2026-08-20 are corrected below, and the
> correction is recorded rather than quietly applied because the second one is an
> input error that every floor priced here inherited:
>
> 1. The `motir-ai` row named a constant that no longer exists. The worker's idle
>    poll is **deleted**, not lengthened.
> 2. **Five minutes was the documented SETTING floor, not the measured DELAY.** The
>    delay was never measured until 2026-08-20, and it is **~9 minutes**. The rule
>    this section states survives intact; only its number needed correcting.
>
> Everything else in §21 — the mechanic, the property to protect, the duty-cycle
> readings — stands, and is left as it was written.

**Two different numbers, and conflating them is what cost the last card that read
this section.**

- **The SETTING floor: five minutes.** `suspend_timeout_seconds` cannot be set
  below 300 s on the Launch plan (probed 2026-08-13:
  `suspend_timeout_seconds: 60` → _"suspend interval is too short for your
  plan"_). That probe established what Neon will **accept**; it never observed a
  compute going quiet.
- **The observed DELAY: ~9 minutes**, measured 2026-08-20 by sampling the Neon
  control plane every 30 s — **no database connection**, so the probe cannot wake
  what it measures.

| endpoint           | last activity | went `idle` | delay     |
| ------------------ | ------------- | ----------- | --------- |
| `motir-ai`         | 10:23:43      | 10:33:26    | **9m43s** |
| `motir-ai`         | 10:35:14      | 10:43:34    | **8m20s** |
| a sibling endpoint | 10:01:30      | 10:11:01    | **9m31s** |

So **any service whose warm machine queries Postgres more often than roughly every
nine minutes holds its database awake permanently**, and the database is the larger
bill: a `shared-cpu-1x` machine is $3.32/mo, its Neon compute at the 0.25 CU floor
for 730 h is **$19.50/mo**.

**And the gap between the two numbers is not pedantry — it is the whole cost of
[MOTIR-3224](motir:cmt1gpozk00kpi2phgjsqn228)'s interval.** A 10-minute poll was
chosen to clear the documented five minutes with 2× margin. Against the real delay
it cleared it by about a minute, so the compute suspended and was re-woken almost
immediately: a measured **77% duty cycle over a 30-minute window**, not the ~50%
the five-minute arithmetic predicts. **An interval that sits "past the threshold"
is only ever as good as the threshold, and the threshold here is an observation
Neon does not contract to.** No poll at all is the only form of this that cannot
rot.

| service         | in-process poll on a warm machine                                                            | does a second warm machine add compute-hours?                                                                  |
| --------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `motir-core`    | ~~**none** — every `setInterval` in the repo is client-side~~                                | ~~**No.** Scheduled work arrives via Inngest over HTTP and reaches one machine anyway.~~                       |
| `motir-ai`      | **none** — no timer re-arms on an idle queue ([MOTIR-3224](motir:cmt1gpozk00kpi2phgjsqn228)) | **No, and not by a margin.** There is no timer to price: an idle worker schedules nothing and issues no query. |
| `motir-gateway` | the two sync goroutines, **`SYNC_FREQUENCY = 1800` s** — raised for margin; see below        | **No** — and the database does sleep: measured 46.6% asleep at 600 s, ~83% projected at 1800 s. See below.     |

> ⚠️ SUPERSEDED by [`always-on-database-job-cadence.md`](always-on-database-job-cadence.md) (MOTIR-6893, 2026-09-29): `motir-core` now runs an
> in-process poll — the job worker, every ≤ 5 s (`IDLE_MAX_MS`, `lib/jobs/engine/worker.ts`) — and
> its scheduled work runs on that worker, not via Inngest over HTTP. The `motir-ai` and
> `motir-gateway` rows are unchanged (MOTIR-6934).

**All three rows re-checked against shipped code on 2026-08-20** by
[MOTIR-3257](motir:cmt1u6a2q000ai5ph1wjb16wa), rather than carried forward:

- **`motir-core` — confirmed unchanged.** `grep -rn 'setInterval(' lib app` on
  `origin/main` still returns **exactly five** hits, and every one of them sits in a
  file whose first line is `'use client'` (`lib/hooks/usePlanGeneration.ts`,
  `ExpansionNudgeBanner.tsx`, `RepositoriesRoom.tsx`, `NotificationBell.tsx`,
  `MigrateWizard.tsx`). The count is the same five this amendment's own Sources
  row recorded on 2026-08-20.
- **`motir-ai` — corrected.** The idle-poll constant, its export and the idle
  re-arm are gone from `src/jobs/worker.ts` — deliberately not named here, because
  a record that cites a deleted symbol sends its next reader grepping for
  something that is not there. A tick that finds nothing sets its delay to `null`,
  which schedules nothing; the next tick comes from `wakeWorker()` on submit. Two
  timers survive and **neither is a poll**: an error backoff that escalates
  5 s → 300 s over seven attempts and then **stops**
  (`errorBackoffMs` returns `null`, deliberately, so an outage cannot re-create the
  poll at 5-minute spacing), and a per-job lease renewal that exists only while a
  handler is running.
- **`motir-gateway` — confirmed unchanged, and since 2026-08-23 confirmed from the
  PLATFORM rather than from the repo.** `fly.toml` still sets `SYNC_FREQUENCY = "600"`
  and `common/config/config.go:110` still defaults it to `10*60` s. This used to carry
  only a code reading's warrant — _"read from the repo, not from the platform"_, the
  deployed value being an `[env]` entry rather than a secret. It no longer has to:
  [MOTIR-3264](motir:cmt1ws6ke007ti1n8a0epdlyb) observed the running service wake its
  database at **601, 602, 591, 601 s** intervals, so **600 s is what is deployed**, not
  merely what is committed. A cadence read off production closes the merged-is-not-
  deployed gap that a file read leaves open.

**⚠️ THE GATEWAY'S ROW IS NOW MEASURED, AND THE SUSPECTED DEFECT IS FALSIFIED
(2026-08-23, [MOTIR-3264](motir:cmt1ws6ke007ti1n8a0epdlyb)).** What stood here said the
`No` in that row was correct _for the opposite reason_ — that a second warm gateway adds
no compute-hours because the first one may already be holding the compute awake around
the clock, since 600 s clears a ~9 min delay by only about a minute. **That was an
inference from a delay measured on OTHER endpoints, and it does not survive measuring
this one.**

Sampled from the control plane every 20 s with **no database connection of the run's
own**, over **44m52s** in which the gateway served **zero API requests** (verified from
`fly logs`, so the two sync goroutines were the only thing touching Postgres):

|                       |                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| endpoint              | `ep-crimson-dew-ai3vmlx0` (Neon project `autumn-sky-90851862`, name `motir-gateway`)                                                        |
| window                | 2026-08-23 20:48:11Z → 21:33:03Z, 133 samples                                                                                               |
| wakes (`last_active`) | 20:45:28 · 20:55:29 · 21:05:31 · 21:15:22 · 21:25:23 — Δ **601, 602, 591, 601 s**, each matching a `syncing options from database` log line |
| suspend delay         | **~5m12s**, bounded 4m46s–5m37s across five consecutive cycles                                                                              |
| duty cycle            | **53.4% awake** (71 of 133 samples), 46.6% asleep                                                                                           |

**So the database sleeps between syncs, and 600 s clears the real delay by about five
minutes rather than by one.** The gateway is not the third copy of the `motir-ai` defect.
Its row is now measured rather than inferred, and the standing cost is roughly **half** of
the $19.50/mo an always-awake compute would bill, not the whole of it — which is what the
`fly.toml` cost comment already claimed and had never had evidence for.

**⚠️ AND THE FINDING THAT OUTLIVES THIS CARD IS THE ONE ABOVE THE NUMBER.** This section
states the observed delay as **~9 minutes**, measured on 2026-08-20 by the same method on
two sibling endpoints. Three days later the gateway's endpoint gives **~5 minutes**,
consistently, and **nothing in our configuration explains the gap**: all four Neon projects
in the organization (`snowy-truth-13928044` motir-core, `autumn-sky-90851862` motir-gateway,
`hidden-thunder-40380051` motir-ai, `odd-silence-89227746` taq) carry the identical
`suspend_timeout_seconds: 0` and the same `0.25 – 8` CU autoscale, read from the platform
on 2026-08-23. **The 2026-08-20 table below is left exactly as it was** — it is a true
record of what was measured then, and rewriting it would destroy the evidence for this
paragraph.

**⚠️ AND THE INTERVAL WAS THEN RAISED 600 → 1800 s ON THAT FINDING — NOT ON THE SAVING
([MOTIR-3411](motir:cmt6cyvie003ei4ph1uyq1qsm), 2026-08-23).** The measurement above says 600 s
was adequate _on the day it was measured_. Run the same arithmetic at the other reading the same
method has produced and it is the fragile value:

| interval   | awake at ~5m12s (2026-08-23) | awake at ~9 min (2026-08-20) |
| ---------- | ---------------------------- | ---------------------------- |
| **600 s**  | 52%                          | **~98%** — the near-miss     |
| **1800 s** | 17%                          | 31%                          |

**600 s is one platform change away from being the defect this section went looking for; 1800 s
is not.** The Neon line goes from ~$10.00/mo to ~$3.33/mo against the $19.35 an always-awake
0.25 CU compute bills — but ~$6.70/mo is a side effect. The margin against a threshold already
observed to move is the reason.

**The 46.6% is a reading of 600 s and is labelled as such rather than deleted; the ~83% at
1800 s is a PROJECTION from the same measured delay and is labelled as such too.** Nobody has
re-measured the endpoint at the new interval. The cost is that a channel or option edited in the
gateway admin UI reaches the running machine after up to 30 min instead of 10 — not token or
quota enforcement, which are Redis-only paths with Redis deliberately off, and not an urgent
cut-off, which is a `fly apps restart` away.

**One knock-on for §22/§25, recorded here because the number it moves lives there.** The
`fly.toml` cost argument priced `min_machines_running = 0` at roughly $9.75/mo of extra saving,
reasoning that a stopped machine runs no sync. Most of that has now been taken by the interval
instead: scaling to zero is worth about $3.33/mo of Neon plus the $3.32/mo machine. §25's open
question is unchanged; the prize behind it is smaller than the figure it was gated on.

The rule this section already states survives, and gets stronger: _"an interval is only
ever as good as the threshold it clears."_ The correction is that **a threshold from
MEASUREMENT is not a contract either.** It is a reading with a date on it, and this one
moved by four minutes in three days. Any future interval here is priced against a delay
re-measured at that time, with the date written down beside it — and whether the ~9 min
and ~5 min readings differ by endpoint or by a platform change is **not settled by this
card**, which measured one endpoint and says so.

> ⚠️ SUPERSEDED by [`always-on-database-job-cadence.md`](always-on-database-job-cadence.md) (MOTIR-6893, 2026-09-29), for `motir-core` only: its job
> worker polls Postgres every ≤ 5 s (`IDLE_MAX_MS`), so its floor is already priced against an
> always-on compute rather than raised without a database bill. The struck sentences still hold
> for `motir-ai` and `motir-gateway` (MOTIR-6934).

~~**All three floors above can therefore be raised without a database bill**, which
is not a coincidence — it is the result of separate cards having already taken
every polling loop out of the path. **That is the property to protect.**~~ A future
in-process poll on any of these services re-prices every floor in this amendment,
and is a decision to bring back here rather than a constant to tune. **Note what
that sentence no longer says:** it used to license any interval longer than five
minutes. It licenses none — an interval is priced against a delay nobody
guarantees, and the two services that have no timer at all cost nothing to reason
about.

Duty cycles measured 18:15→20:46Z on 2026-08-13, from Neon's own API: `motir-core`
**99%**, `motir-ai` **~100%**, `motir-gateway` **~100%** — all three databases were
awake essentially continuously, driven by timers rather than by users.
**`motir-ai`'s driver is gone as of 2026-08-20**
([MOTIR-3224](motir:cmt1gpozk00kpi2phgjsqn228)); that reading is now historical for
that service and has not been re-taken. **And `motir-gateway`'s ~100% has now been
RE-TAKEN and does not reproduce** — 53.4% awake over a traffic-free window on
2026-08-23 ([MOTIR-3264](motir:cmt1ws6ke007ti1n8a0epdlyb), the block above). The
2026-08-13 figure was measured while `SYNC_FREQUENCY` was still **60 s**, before PR #15
raised it to 600; it is a true reading of the old interval and is not evidence about the
current one. Two of the three numbers in this line are now historical, and only
`motir-core`'s **99%** has been re-confirmed since (2026-08-21, still 100%).

**⚠️ `motir-core` RE-MEASURED 2026-08-21 AFTER the admission wake shipped, and the
number did not move: still 100%** ([MOTIR-2853](motir:cmss0x0xf00lki5phahz5bhzo)).
Sampled from the control plane every 5 minutes for **6 h 12 m** against release
**v96**, with no database connection of the run's own: **76 samples,
`current_state: "active"` in every one**, `active_time_seconds` accruing at
**100.8%** of wall-clock over the cleanest 3 h 16 m sub-window (one containing no
deploy and no merge; the >100% is refresh-boundary jitter on a counter that batches
every ~90–105 min). The compute did not suspend once.

**[MOTIR-2852](motir:cmss0vww500l9i5phpl0lngzi) was not the cause, and no single
cadence is.** Delete `CI_RUNNER_PROVISION_SWEEP_CRON` outright and the remaining
`system.*` schedules still wake the compute at minutes
{0,7,10,17,20,22,27,30,37,40,47,50,52,57} — a longest quiet gap of **7 minutes**,
under the ~9 min delay measured above. Every one of those ticks is a guaranteed
database WRITE rather than a possible read: `lib/jobs/defineJob.ts` records a
`job_run` row _before_ the handler body runs and flips it after, so no early return
in any job avoids it. **The cost is the schedule's SHAPE — its fourteen distinct
offsets — not the frequency of its loudest member**, which is the opposite of what
the reaper's own "offset so it never lines up" rationale assumed. Clustering the
schedules is the fix, and it is a coordinated change across every `system.*` job
rather than a constant to tune; it has its own work item.

> ⚠️ SUPERSEDED by [`always-on-database-job-cadence.md`](always-on-database-job-cadence.md) (MOTIR-6893, 2026-09-29). The job worker polls Postgres every ≤ 5 s
> (`IDLE_MAX_MS`, `lib/jobs/engine/worker.ts`), so `motir-core`'s compute never suspends
> whatever the cron shape: the `{0, 30}` cluster, its gap guard, the ~30% / ~17% predictions and
> the owed re-measurement below are retired, not pending. Struck in place, not deleted
> (MOTIR-6934).

~~**⚠️ AND THE SCHEDULE IS NOW CLUSTERED — MOTIR-3314, 2026-08-26. THE NUMBERS BELOW
ARE PREDICTED, NOT MEASURED, AND MUST NOT BE READ AS THE PARAGRAPH ABOVE IS READ.**
The paragraph above is a MEASUREMENT of the old shape. This one is the change made
in response to it, and its duty cycle has not been observed.~~

~~**The change.** All fourteen `system.*` crons are re-timed onto two shared minutes
past the hour — `SCHEDULE_CLUSTER_MINUTES = {0, 30}` in `lib/jobs/schedules.ts`.
Nine expressions moved, five already sat on a clustered minute; the loudest,
`CI_RUNNER_PROVISION_SWEEP_CRON`, went from `* * * * *` to `0,30 * * * *`.~~

|                           | ~~before~~                                                                                 | ~~after~~              |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- |
| ~~union of wake-minutes~~ | ~~every minute (`* * * * *`), and `{0,7,10,17,20,22,27,30,37,40,47,50,52,57}` without it~~ | ~~**`{0, 30}`**~~      |
| ~~longest quiet gap~~     | ~~**1 min** as deployed · 7 min with the sweep deleted~~                                   | ~~**30 min**~~         |
| ~~duty cycle~~            | ~~**100%**, measured over 6 h 12 m (above)~~                                               | ~~**~30% predicted**~~ |

~~**The gap is COMPUTED, not asserted** — `lib/jobs/schedules.ts` unions the MINUTE
field of every registered expression and measures the cyclic stretches between
them, and `tests/jobs/schedule-cluster.test.ts` fails the build if one drops below
the floor. That is the part of this change that outlives the number: a fifteenth
job picking a free-looking minute is the failure mode that produced the 100%, and
it now breaks a test instead of a bill.~~

~~**⚠️ AND THE GUARD ASSERTS THE SHORTEST GAP, NOT THE LONGEST — worth stating
because the longest is the number this section quotes.** A longest-gap assertion
does not defend the bill, which was found by writing the test that adds a
fifteenth job and watching it pass: put one job at :17 on a `{0, 30}` schedule and
the minutes become `{0, 17, 30}` — :17 splits ONE half-hour and leaves the OTHER
untouched, so the longest gap is still 30 while the compute stops sleeping for
half of every hour. A compute sleeps in a gap only for the part exceeding the
delay, so awake time is driven by EVERY gap and the smallest is what binds: **a
schedule is only as clustered as its tightest pair.** MOTIR-3314's criterion asks
for the longest gap, which is the right summary of the OLD shape — 7 minutes,
honestly describing a set with no gap wide enough to sleep in — and the wrong
quantity to guard on. Both are computed; the longest is reported, the shortest is
asserted.~~

~~**What the margin is priced against, and when it was last measured.** 30 minutes
against the **~9 min** delay measured **2026-08-20** (the table at the top of this
section: two endpoints, control-plane sampling with no database connection of the
run's own) is **21 minutes of margin, 3.3×**. Against the **~5m12s** measured
**2026-08-23** on `motir-gateway`'s endpoint by the same method it is **5.8×**.
**Deliberately priced against the MEASUREMENTS and deliberately not against a
threshold**, because this section's own finding is that a measured delay is a
reading with a date on it and this one moved by four minutes in three days. 30 is
the same spacing `motir-gateway` took for the same reason
([MOTIR-3411](motir:cmt6cyvie003ei4ph1uyq1qsm)), after 10-minute spacing cleared the
then-believed threshold by about a minute and cost a **77%** duty cycle. A gap
chosen to sit just past ~9 min would be that near-miss for a third time.~~

| ~~gap~~        | ~~awake at ~5m12s~~ | ~~awake at ~9 min~~                         |
| -------------- | ------------------- | ------------------------------------------- |
| ~~10 min~~     | ~~52%~~             | ~~**~98%** — the near-miss, twice already~~ |
| ~~15 min~~     | ~~35%~~             | ~~60%~~                                     |
| ~~**30 min**~~ | ~~**17%**~~         | ~~**30%**~~                                 |

~~**What it costs.** The tightest cadence in the set IS the gap — no arrangement of
the other jobs can produce a quiet stretch longer than the shortest one — so the
clustering is one decision, not fourteen. It is paid mostly by
`system.plan-target-lock-sweep`: a stranded planning lease's worst-case wait goes
from 30 + 10 = **40 min** to 30 + 30 = **60 min**. The other costs are a CI-runner
orphan surviving up to 30 min instead of 10, and a dropped boot dispatch recovered
in up to 30 min instead of 60 s — the latter on a backstop path only, since the
hot path is the `workflow_job` webhook and the admission wake. Each trade is argued
at its own constant. The nightly table-walking sweeps did **not** lose their
separation: it moved from the minute axis to the HOUR axis (03:30 → 04:00 → 04:30 →
05:00), which is why the cluster has two slots rather than one, and is strictly
more clearance than the old 04:10/04:15 pair had.~~

~~**⚠️ THE RE-MEASUREMENT IS OWED, AND THIS SECTION IS NOT SETTLED UNTIL IT IS
TAKEN.** ~30% predicts a Neon line of roughly **$5.85/mo** against the $19.50/mo
measured above. **Nobody has watched the compute at this shape.** The method is
[MOTIR-2853](motir:cmss0x0xf00lki5phahz5bhzo)'s and is what makes the reading
trustworthy: sample the Neon control plane only — **no database connection of the
run's own**, or the probe wakes what it measures — for **≥ 6 h**, against the
deployed release, in a window carrying **no `motir` commands, no deploy and no
merge**, and read `current_state` plus `active_time_seconds` against wall-clock.
Until that is done, every figure in this block is a projection and is labelled as
one. The prediction is also FALSIFIABLE in a specific way worth naming: if the
delay at `motir-core`'s endpoint is nearer the gateway's ~5 min than the ~9 min
measured on 2026-08-20, the duty cycle comes in at ~17% rather than ~30% — a
better result from the same change, and evidence about the endpoint question this
section explicitly leaves open.~~

**So the `motir-core` row above stands, and its $19.50/mo is a standing bill that
is now measured rather than inferred.**

### §22 — What this amendment does NOT decide

- **Whether `suspend` bills.** Fly documents `stop` as compute-free and documents
  the `suspended` state neither way. **Trigger:** the next real invoice. If
  suspend bills near a running machine, `motir-gateway` switches to `stop` and
  takes the slower resume.
- **The gateway's VM size.** It stays `shared-cpu-1x` / 512 MB. The only reading
  we have (79 MB resident, ~5.7× headroom) says **memory is not the constraint**,
  and we have no CPU reading at all for a TLS-terminating streaming relay.
  **Trigger:** the first sustained CPU reading under real streaming traffic — Epic
  9's agents or a customer application, whichever arrives first. Sizing up now
  would be guessing in the expensive direction.
- **A shared rate limiter's shape.** §16 requires one before the gateway's ceiling
  rises; whether that is Redis, a Fly-native store, or limits divided by the pool
  size is MOTIR-2782's to decide and record.
- **Scale-to-zero on the gateway.** Available only behind a transport change
  (§14), which is not on this Story.
- **A second region.** Q10's, with Q10's trigger.
- **⚠️ WHETHER AMENDMENT 5's Q9 IS ACTUALLY IN FORCE. It is not, and this
  amendment does not fix it.** Found 2026-08-20 while measuring for MOTIR-2783:
  `MOTIR_AI_URL` read from inside a running motir-core machine is
  **`https://motir-ai.fly.dev`** — the PUBLIC origin — while Amendment 5 states
  _"Q9's decision STANDS and is now in force — `MOTIR_AI_URL` is
  `http://motir-ai.internal:8080` in production."_ The deployed value is the
  rollback that amendment documents. `.internal` itself works (`GET /health` →
  200 from the same machine), so this is drift, not a workaround.
  **Filed as MOTIR-3231, which owns both the secret and the correction to
  Amendment 5.** Named here rather than left silent, because until it is fixed
  every reader of Amendment 5 will reason from a seam that is not in use — and
  because _this_ amendment's §14 argument for `motir-gateway`'s floor rests on the
  ai→gateway leg, which was separately verified and **is** `.internal`. The two
  legs must not be swept together.
  > ⚠️ SUPERSEDED by **Amendment 9** (MOTIR-7407): the public origin is now the
  > DECIDED value for this leg, not drift.
- **Alerting.** There is none, and this amendment does not invent one. Every "how
  we learn" cell in §16 is honest about that; a spend tripwire is
  `ci-runner-fleet.md` §9.2's shape and belongs with the meter, not here.

### §23 — What each card below must do, and must not re-decide

| card                                                          | executes                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MOTIR-2785](motir:cmspw6flk00ati1phgihgdtvl) `motir-core`    | floor 1 → **2**; pool unchanged; `requests` 200/250 retained and LABELLED an estimate; §12's memory reading recorded against §10's trigger                             |
| [MOTIR-2782](motir:cmspw58b6008gi1phpdzuy8p2) `motir-gateway` | the rate limiter FIRST, then `connections` **100/150**; floor stays **1**; pool stays **2**; `suspend` retained with the invoice caveat                                |
| [MOTIR-2783](motir:cmspw5w0k009ki1phkgmw22v1) `motir-ai`      | floor 1 → **2**, but only after 3221/3222/3223 have merged and deployed; 20/25 retained as a CAP, documented as not the signal; peak concurrent jobs recorded as **1** |

**None of them re-decides a number.** A number that looks wrong at execution time
is a re-plan of this card, not a judgement call there.

### Sources — additions

| Claim                                                       | Source                                                                                                                                                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The proxy never creates or destroys machines                | <https://fly.io/docs/launch/autostop-autostart/>                                                                                                                                             |
| Machine states, and that `stop` is compute-free             | <https://fly.io/docs/machines/machine-states/> · <https://fly.io/docs/about/pricing/>                                                                                                        |
| No spend cap, no billing alert                              | Fly cost-management docs, quoted in `ci-runner-fleet.md` §9 (re-read on `origin/main`, 2026-08-20)                                                                                           |
| Machine states, VM sizes, event histories                   | `GET https://api.machines.dev/v1/apps/<app>/machines`, 2026-08-20                                                                                                                            |
| Resident memory per service                                 | `fly ssh console -a <app> --machine <id>` → `/proc/*/status` `VmRSS`, 2026-08-20                                                                                                             |
| One machine runs one job at a time                          | `motir-ai` `src/jobs/worker.ts` (`ticking` guard) and `src/jobs/planJobRepository.ts`, `origin/main`                                                                                         |
| ~~motir-core has no server-side poll~~                      | ~~`grep -rn 'setInterval(' lib app` on `origin/main`, 2026-08-20 — five hits, all `'use client'`~~                                                                                           |
| `REDIS_CONN_STRING` unset on the gateway                    | `fly secrets list -a motir-gateway`, 2026-08-20                                                                                                                                              |
| Neon's five-minute SETTING floor is not lowerable on Launch | Neon API probe, 2026-08-13, recorded on MOTIR-2780 — this is the minimum `suspend_timeout_seconds`, NOT the observed delay                                                                   |
| Neon's observed suspend DELAY is ~9 min, not five           | Neon control-plane sampling every 30 s with no database connection, 2026-08-20 — three samples (9m43s / 8m20s / 9m31s), recorded on MOTIR-3224 (motir-ai#256) and carried here by MOTIR-3257 |
| motir-ai runs no in-process poll                            | `src/jobs/worker.ts` on `origin/main` after MOTIR-3224 — an idle tick sets its delay to `null` and schedules nothing                                                                         |

> ⚠️ SUPERSEDED by [`always-on-database-job-cadence.md`](always-on-database-job-cadence.md) (MOTIR-6893, 2026-09-29): the `motir-core` row
> above is a true reading of 2026-08-20 and no longer describes the code (MOTIR-6934).

---

## Amendment 8 (2026-08-21) — Q20: the transport is decided PER LEG. Flycast is the answer for both service seams, and it is BLOCKED TODAY by `force_https` — measured, not predicted

> **Written by Story [MOTIR-3277](motir:cmt24s41g002di3n8agfu87hc) · Subtask
> [MOTIR-3280](motir:cmt24ub7o003di3n87p9rb8fz).** Amendment 7 §15 states that
> _"the floor and the transport are ONE decision, not two"_, decides the floor,
> and explicitly defers the transport to _"whoever next revisits the seam"_. This
> is that revisit.
>
> **Numbered 8.** Amendment 7 was the highest heading on `origin/main`, and every
> remote branch carrying this file was checked for an eighth before the number
> was taken.

**Amends:** it ADDS **Q20** — which address each service seam uses — and settles
the floor consequence Amendment 7 §14–§15 left hanging on it. Amendments 1–7 are
otherwise untouched.

⚠️ **This amendment does NOT correct Amendment 5's "in force" sentence.** That
paragraph is wrong as deployed and is owned by
[MOTIR-3231](motir:cmt1l327r009wi3phchsbix05) AC5. Two cards editing one sentence
is how a record acquires two accounts of the same event.

### §23 — Q20: which address does each leg use?

**Four legs. Two change, two do not, and the two that do not are stated here on
purpose** — a reader must not be able to take the private-networking argument
below and carry it to a leg where it is wrong. Amendment 1 names that as the
specific mistake it exists to prevent.

| leg                                                      | today                                          | DECIDED                                      | why                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **core → ai** (`MOTIR_AI_URL`)                           | `https://motir-ai.fly.dev` — drift, MOTIR-3231 | **Flycast** — `http://motir-ai.flycast:8080` | private, and proxy-routed so it load-balances across machines and fails over on a health check. `.internal` is DNS round-robin with no health awareness                                                                               |
| **ai → gateway** (`LLM_GATEWAY_BASE_URL`, `_SEARCH_URL`) | `http://motir-gateway.internal:3000/v1`        | **Flycast**                                  | same, plus this is the leg where the proxy unpins a floor (§25)                                                                                                                                                                       |
| **ai → core callback** (`MOTIR_CORE_URL`)                | `https://app.motir.co`                         | **public, permanently**                      | it is not a service address. Those origins are printed into password-reset mail, invite links and OAuth callbacks. Also unavailable over 6PN regardless: motir-core sets `HOSTNAME=0.0.0.0` and does not listen on IPv6 (Amendment 5) |
| **browser → core** (`MOTIR_BASE_URL`)                    | `https://app.motir.co`                         | **public, permanently**                      | it is the front door                                                                                                                                                                                                                  |

> ⚠️ SUPERSEDED for the **core → ai** row by **Amendment 9** (2026-10-03,
> MOTIR-7407): that leg is DECIDED as the public origin `https://motir-ai.fly.dev`.
> Flycast needs `force_https = false`, which is safe only with no public ingress
> (§26) — and motir-ai has public callers it cannot shed. The other three rows
> stand.

**Why Flycast rather than `.internal`, when both are private.** The argument for
`.internal` was never _"we want machine-to-machine"_ — it was _"we do not want
this endpoint on the internet"_. Flycast satisfies that sentence completely: a
private IPv6 anycast address, unreachable from outside the org, that is routed
**through Fly Proxy**. What that buys back is everything forfeiting the proxy
cost us — load balancing, health-checked failover, and autostart of a stopped
machine. It is allocated with `fly ips allocate-v6 --private` and costs **$0/mo**
(§26).

**Why not the public origin, which the proxy also serves.** Both seams
authenticate with one long-lived shared bearer, and the gateway's spends real
provider money — on a public origin that token is a complete credential for
anyone on the internet. The payloads are customer code graphs, plan bodies and
LLM prompts, and "internal service traffic never leaves the private network" is a
materially shorter answer for a Dutch controller than the alternative (Amendment
6 made region a residency question; this is the same axis one layer down).

### §24 — what the wake measurement permits, now that it exists

[MOTIR-3279](motir:cmt24ts8c002ni4ph4oe2oyon) took the reading Amendment 7 and
`motir-ai/fly.toml` had both been reasoning without. Three samples per app,
`fly machine stop` → one request forced at that machine via `fly-force-instance-id`:

| app · path                           | request → first 200 | machine | app-ready |
| ------------------------------------ | ------------------- | ------- | --------- |
| `motir-gateway` · `suspend` → resume | **0.58 – 0.73 s**   | ~0.42 s | ~0.24 s   |
| `motir-core` · `stop` → autostart    | 10.7 – 11.0 s       | ~1.0 s  | ~9.8 s    |
| `motir-ai` · `stop` → autostart      | 12.8 – 13.3 s       | ~1.4 s  | ~11.5 s   |

Plus a Neon resume of **~0.7 s** (1278 ms cold vs 603 ms warm, after 13 min of
verified idleness), which rides on top of any of them.

**What it permits, stated against the real deadlines rather than as "fast
enough":**

- **The gateway leg has three orders of magnitude of headroom.** `motir-ai`'s
  gateway client is `new OpenAI({ baseURL, apiKey })` with no `timeout`, so
  `OpenAI.DEFAULT_TIMEOUT` — **600 s** — governs. A 0.6 s resume against a 600 s
  deadline is not a latency question at all.
- **The core→ai leg fits, with ~2.3× to spare.** `MOTIR_AI_REQUEST_TIMEOUT_MS`
  is 30 s and a cold motir-ai answers in ~13 s. Real headroom, not generous.
- **And nine tenths of that 13 s is our own boot, not Fly.** Any future attempt
  to make a cold path cheaper should start at the app, or switch that app to
  `suspend` — which is precisely why the gateway is 18× faster.

### §25 — the floor each transport permits, and the floor we choose

**The pairing Amendment 7 §15 named. It resolves differently per service, and
only one of the three floors was ever transport-gated.**

| service         | floor permitted by the decided transport | floor CHOSEN                    | what actually binds                                                                                                                                                                                       |
| --------------- | ---------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `motir-core`    | n/a — it is the front door, not a callee | **2**                           | availability: two machines RUNNING is the only shape that survives losing one (§14). Unchanged                                                                                                            |
| `motir-ai`      | 0                                        | **2**                           | **not transport.** The floor here is the JOB-CONCURRENCY ceiling — one machine runs one job — so 13 s would be affordable and ONE WORKER would not be. Flycast does not unpin this and was never going to |
| `motir-gateway` | **0**                                    | **1 today, 0 once §22 answers** | transport, and nothing else                                                                                                                                                                               |

⚠️ **A correction to the reasoning, not to a number.** It is tempting to say a
floor of 0 makes §16's hazards (the doubled per-process rate limit, the 600 s
`MEMORY_CACHE_ENABLED` divergence) more reachable. **It does not.** Both hazards
need TWO machines _running_, and at floor 0 exactly as at floor 1 the second
machine starts only when load crosses `soft_limit`. The floor changes who pays
the first request after idle; it does not change when a second process appears.
§16 gates the CEILING, not the floor, and conflating them would block a floor
change on work that has nothing to do with it.

So the gateway's floor of 0 has exactly two remaining conditions: the transport
(this amendment), and **§22's open question of whether a `suspended` machine
bills** — which the next invoice answers. Note the Neon saving does not depend on
that answer: it comes from the machine actually sleeping and its two 600 s sync
goroutines stopping.

### §26 — ⚠️ FLYCAST IS BLOCKED TODAY BY `force_https`, and this is measured

Amendment 5 records that `.internal` never traverses the proxy and therefore
never sees `force_https` — _"200, no `location` header"_. **That finding is a
property of having no proxy in the path, and Flycast puts the proxy back.**
Measured 2026-08-21 from inside motir-core machine `83d1300b7460e8`, against the
Flycast address allocated on `motir-ai` (`fdaa:ab:2cdf:0:1::2`):

```
GET http://motir-ai.flycast/health    → 301, location: https://motir-ai.flycast/health   (64 ms)
GET https://motir-ai.flycast/health   → ECONNRESET — TLS never establishes
```

**Both ends fail.** `force_https = true` redirects the plain call, and the scheme
it redirects to has no certificate for a `.flycast` name, so a client that
follows the redirect hits a reset. **A seam pointed at Flycast today would be
broken in both directions**, and a caller that does not follow redirects would
silently receive a 301 body instead of an answer.

**The remedy, and the ordering it forces:**

1. **`force_https = false` on the app's `http_service`.** It is one setting for
   the whole service, so it cannot be true for public ingress and false for
   Flycast.
2. **Which is only safe once nothing reaches that app over the public origin** —
   otherwise the public listener starts accepting plain HTTP. For `motir-ai`
   that means the core→ai leg moves FIRST.
3. **The end state is stronger and should be taken: release the app's PUBLIC IPs
   entirely.** `motir-ai` and `motir-gateway` serve no browsers; with no public
   ingress there is no `force_https` question, and the blast-radius argument in
   §23 stops being an argument and becomes a property. Owned by
   [MOTIR-3281](motir:cmt24usrq0030i4phr6ujdcg0).

> ⚠️ For **motir-ai**, step 3 is SUPERSEDED by **Amendment 9** (MOTIR-7407):
> motir-ai cannot release its public IPs — fleet index containers reach it from
> another org and it serves the public Stripe webhook — so steps 1–3 were never
> taken there. They were taken for `motir-gateway` (MOTIR-3333).

**Consequence for [MOTIR-3231](motir:cmt1l327r009wi3phchsbix05), which is
blocked on this card:** it should apply **`.internal`**, not Flycast. That fixes
the live drift immediately with no deploy and no `force_https` change, and leaves
the Flycast move to 3281 where the config change belongs. The interim is Q9 as
written, which is the state the record already claims.

### §27 — cost

| item                                  | figure                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A Flycast address                     | **$0/mo.** Fly bills dedicated IPv4 only ($2/mo); _"IPv6 addresses and shared IPv4 Anycast addresses are free"_   |
| Same-region transfer between machines | **$0.** All three apps are `iad`-only; cross-region private transfer would be $0.006/GB                           |
| Gateway floor 1 → 0                   | ~**$3.3/mo** of `shared-cpu-1x`/512 MB, plus the ~**$9.75/mo** of Neon compute §15 attributes to keeping it awake |
| Whether `suspended` bills             | **STILL OPEN** — §22's trigger (the next invoice) is unchanged by this amendment                                  |

### §28 — what this amendment does NOT decide

- **Amendment 5's "in force" sentence.** [MOTIR-3231](motir:cmt1l327r009wi3phchsbix05) AC5 owns it.
- **`MOTIR_BASE_URL` / `MOTIR_CORE_URL`.** Public, permanently — §23.
- **motir-core's posture.** Public origin, floor **2**, and **scale-to-zero is
  rejected**: it serves interactive page loads, plus Stripe and GitHub webhooks
  and OAuth callbacks that carry their own deadlines and, in the OAuth case, no
  retry. A ~11 s cold boot in front of a human is not a trade worth ~$23.66/mo,
  and the app cannot be reached over 6PN anyway. Recorded so the next reader does
  not re-open it as an oversight.
- **Authentication.** `MOTIR_AI_SERVICE_TOKEN` and the gateway virtual key still
  gate every request. A private address removes reachability; it does not confer
  trust. Amendment 1's last row is not filler and is not superseded.

### Sources — additions

| Claim                                                           | Source                                                                                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flycast is private and proxy-routed, and can autostart machines | <https://fly.io/docs/networking/flycast/>                                                                                                          |
| IPv6 and shared IPv4 are free; dedicated IPv4 is $2/mo          | <https://fly.io/docs/networking/services/> · <https://fly.io/docs/about/pricing/>                                                                  |
| `force_https` 301s a Flycast call, and the https form resets    | `fly ssh console -a motir-core --machine 83d1300b7460e8`, `fetch()` with `redirect: manual`, 2026-08-21                                            |
| The wake path, three samples per app, decomposed                | [MOTIR-3279](motir:cmt24ts8c002ni4ph4oe2oyon) — `fly machine stop` + `fly-force-instance-id`, timings from the Machines API `events[]`, 2026-08-21 |
| The gateway client sets no timeout, so 600 s applies            | `motir-ai/src/llm/gatewayClient.ts` on `origin/main`; `OpenAI.DEFAULT_TIMEOUT = 600000`, openai 6.42.0                                             |

---

## Amendment 9 (2026-10-03) — the core→ai leg is the PUBLIC origin, decided: motir-ai suspends to zero, `.internal` cannot wake it, and Flycast needs public ingress motir-ai cannot give up

> **Written by Bug [MOTIR-7407](motir:cmurmvo4f00a0hvoik9f2bc86)** (a `decision`
> card), found while running [MOTIR-7337](motir:cmur02yj303p4hnpxzleqlry9).
> **Decided by Yue, 2026-10-03.**
>
> **Numbered 9.** Amendment 8 was the highest heading on `origin/main`, and no
> remote branch carrying this file has a ninth.

**Amends:** Amendment 8 §23 (Q20) for the **core → ai** row only, which decided
Flycast; Amendment 5's "in force" sentence and its 2026-08-21 correction, which
put `.internal` back; and Amendment 1's Q9. Each carries a SUPERSEDED pointer to
this section where it states the old value. The ai → gateway, ai → core callback
and browser → core rows of Q20 are untouched.

### Q21 — the core→ai transport now that motir-ai's floor is zero

#### The decision

**`MOTIR_AI_URL` is `https://motir-ai.fly.dev` in production — the public
origin, through the Fly proxy, over TLS, authenticated by
`MOTIR_AI_SERVICE_TOKEN`.** It is the decided seam, not drift and not an interim.

The value in force, and the runbook line for it:

```
fly secrets set -a motir-core MOTIR_AI_URL=https://motir-ai.fly.dev
```

Read back on 2026-10-03 from inside motir-core machine `8576143c4ee538` (`iad`):
`printenv MOTIR_AI_URL` → `https://motir-ai.fly.dev`. A Fly secret is app-wide,
so every motir-core machine carries the same value.

#### What forced it — Amendment 5's NEW CONSTRAINT came true

[MOTIR-7095](motir:cmuosmgo600frhyshby5cqydb) (motir-ai `218a931`, merged
2026-10-02 12:36 UTC) turned motir-ai into a planning pool whose idle machines
**suspend themselves**: `min_machines_running = 0`, `auto_start_machines = true`,
`auto_stop_machines = "off"`. **Only the Fly proxy resumes a suspended machine.**
`.internal` is 6PN, machine to machine, and never passes through the proxy — the
exact property Amendment 5 warned about: _"If motir-ai is ever set to scale to
zero, `motir-ai.internal` resolves to nothing and there is no proxy to wake it."_

| when (UTC, 2026-10-02) | what happened                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 12:36                  | MOTIR-7095 merged and deployed; the pool may now sleep                                                                                                                                                                                                                                                                  |
| 13:27 – 19:16          | every worker → motir-ai call made while the pool slept failed as `MotirAiUnavailableError: motir-ai is unavailable: fetch failed` — **78 events across five Sentry issues** (embeddings, monitor-bug enrichment created + backfill, code-graph refresh, platform meter report), filed as MOTIR-7337 and four duplicates |
| 19:16 – 19:49          | the motir-core secret set by hand to `https://motir-ai.fly.dev`; no event since                                                                                                                                                                                                                                         |

#### Why not Flycast, which Q20 decided

Q20's reasoning for Flycast still holds in general — private AND proxy-routed is
strictly better than either alone. **It cannot be applied to motir-ai**, and §26
already says why: Flycast's proxy honours `force_https`, `force_https` is one
setting for the whole `[http_service]`, and turning it off is safe only once the
app has **no public ingress**. That is how `motir-gateway` did it
([MOTIR-3333](motir:cmt2s6su3006ci4ph1ueyefng): `force_https = false` and every
public IP released). **motir-ai has public callers it cannot shed:**

| caller                                 | why it needs motir-ai's public origin                                                                                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fleet index containers**             | they run in the `motir-fleet` org (`code-graph-index-fleet.md` §3.2). A 6PN — and a Flycast address — is org-scoped, so they reach motir-ai at `MOTIR_AI_CONTAINER_URL` = `https://motir-ai.fly.dev` (MOTIR-4518)          |
| **Stripe** (`POST /v1/stripe/webhook`) | motir-ai's lifecycle ingress (`src/app.ts`), signature-authenticated and called from the internet. Its planned host `ai.motir.co` (`billing-tiering.md`) does not resolve as of 2026-10-03; the route is public either way |

So `force_https = false` on motir-ai would make its **public** listener accept
plain HTTP. A second plain-HTTP service port only for Flycast does not help: Fly
serves every service port on every IP the app holds, public ones included.

#### What this costs, and what it gives up

- **The private-ingress property Amendment 1 and Q20 wanted is gone for this
  leg.** It is worth less than it reads: motir-ai is publicly reachable for the
  callers above whatever motir-core does, so moving only core's traffic off the
  public origin would not remove any attack surface. The bearer token still gates
  every call, and the transport is TLS.
- **One edge-proxy hop and a TLS handshake per connection** (Amendment 1's
  latency row), against a 30 s `MOTIR_AI_REQUEST_TIMEOUT_MS` and a ~0.6 s resume
  from `suspend`.
- **Egress at $0.02/GB** (Amendment 1's billing row) for core→ai bytes. The
  payloads are request/response JSON, not assets.
- **What it buys:** the proxy is back in the path, so a sleeping pool is woken
  by the request itself, and load-balancing and health-checked failover return.

#### What would reopen it — one trigger

**motir-ai having no public callers** — index containers reaching it through a
relay or from inside `moooon`, and the Stripe webhook landing on motir-core.
Then motir-ai can do what MOTIR-3333 did (release its public IPs, `force_https =
false`) and Q20's Flycast row becomes applicable as written. Until then,
`.internal` is wrong because the pool sleeps, and Flycast is wrong because the
app is public.

#### The same constraint on the gateway, recorded so it is not rediscovered

`motir-gateway` is on Flycast **because** it has no public ingress. Any future
work that gives it public callers — Epic
[MOTIR-4539](motir:cmtnhxwo90000hxn8lqhlugn6) (the gateway standing alone), or a
hosted multi-tenant gateway — must not re-allocate public IPs while
`force_https = false`. The constraint is noted on that epic.

### What this amendment does NOT touch

- **The other three legs of Q20.** ai → gateway stays Flycast; the ai → core
  callback and browser → core stay public, permanently.
- **Authentication.** `MOTIR_AI_SERVICE_TOKEN` gates every call — Amendment 1's
  last row is not filler.
- **`MOTIR_AI_CONTAINER_URL`.** Already the public origin, for the reason above.
- **motir-ai's pool, floor or `fly.toml`.** MOTIR-7095's record owns those.

### Sources — additions

| Claim                                             | Source                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| motir-ai suspends to zero; only the proxy resumes | `motir-ai/fly.toml` `[http_service]` on `origin/main` (`218a931`, MOTIR-7095)                    |
| `force_https = true` on motir-ai                  | `motir-ai/fly.toml:169` on `origin/main`, 2026-10-03                                             |
| The outage window and event count                 | [MOTIR-7337](motir:cmur02yj303p4hnpxzleqlry9) and its duplicates (Sentry)                        |
| The deployed value                                | `fly ssh console -a motir-core -C 'printenv MOTIR_AI_URL'`, machine `8576143c4ee538`, 2026-10-03 |
| Index containers need a public motir-ai address   | `code-graph-index-fleet.md` §3.2; `lib/ai/motirAiClient.ts` `motirAiContainerBaseUrl`            |
| motir-ai's public Stripe webhook route            | `motir-ai/src/app.ts` `POST /v1/stripe/webhook` on `origin/main`                                 |

## Amendment 10 (2026-10-27) — production moves to AWS under `motir-infra`; the CDK becomes the source of size and deploy

> **Written by Subtask [MOTIR-9719](motir:cmvprl5cg01cvhmu1xfdrhdav)**, under
> Story [MOTIR-9706](motir:cmvprl4a201bwhmu1noqu2bac) (the CDK foundation) of
> Epic [MOTIR-9699](motir:cmvprl3vo01blhmu1of10bhko).
> **Decided by Yue**: the move itself in the requirements page
> [_Motir on AWS and self-host — requirements_](/pages/cmvpk4tpk01bihnr9thk2ftd9),
> and the region in the requirements-Q1 decision
> ([MOTIR-9701](motir:cmvprl40b01brhmu1545xvikl)), approved 2026-10-27.
>
> **Numbered 10.** Amendment 9 was the highest heading on `origin/main` when
> this was written, and no remote branch carrying this file has a tenth.

> **A note on numbering.** The requirements page numbers its own open
> questions Q1–Q8. They are NOT this record's Q1–Q8 (§1), and not Amendment 6's
> Q10. Every question taken from that page is written **requirements Q<n>**
> below; a bare **Q<n>** is this record's own.

**Amends:** §2 (Q1, where motir-core runs), §3 (Q2, the blob store), Amendment 8
§23 (Q20, the transport for each service seam) and Amendment 9 (Q21, the core→ai
leg on the public origin). **None of them is superseded by this amendment.**
Each is retired by the later story in Epic MOTIR-9699 named in the table below,
when that story lands, and that story adds the SUPERSEDED pointer at the old
text. Until then they still describe what production runs on.

### Q22 — where Motir production runs next, and what defines it

#### The decision

**Motir production moves to AWS, in one VPC, in the `us-east-1` (US East, N.
Virginia) region**, the region the requirements-Q1 decision
([MOTIR-9701](motir:cmvprl40b01brhmu1545xvikl)) named: _"Motir production on
AWS deploys into us-east-1 only."_ That covers motir-core (web, worker and
relay), motir-ai, motir-codegraph, motir-gateway, the databases and the blob
store.

**It is defined by one parameterised CDK app, in TypeScript, in the
`motir-co/motir-infra` repository.** The same app defines the services and the
fleet pool accounts. Every value that differs between installs (accounts,
region, zones, domain, which fleets and image repositories exist) is a
parameter, and Motir production is one parameter file. Changes reach AWS by a
pull request to `motir-infra` and a CI deploy from its `main`, through the
foundation [MOTIR-9706](motir:cmvprl4a201bwhmu1noqu2bac) builds.

The source of the move is the requirements page, §2 goal 1 and §3. Its §7 lists
this record's Q1, Q2 and Amendments 8–9 as the parts the move supersedes.

#### The source of size and deploy

**For each service, once it serves from AWS, the CDK is the single source of its
size, its floor and its deploy strategy** (rolling or blue-green, with health
checks). Those values live in `motir-infra`'s stacks and parameter files, not in
a `fly.toml`.

**Until that service's cutover story lands, its `fly.toml` stays the source for
that service**, and the tests that pin it (for example
`tests/fly-runtime-config.test.ts`) stay in force. Amendment 7's scaling posture
(Q11–Q19) describes the Fly services for as long as they run. The decommission
story ([MOTIR-9716](motir:cmvprl54901clhmu143y6z3l2)) retires the Fly-pinned
configuration and its tests.

#### Which story retires each superseded part

| Part                       | What it decides today                                                                          | Retired by                                                                                                                                                                                                                        | Stops being true when                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Q1** (§2)                | motir-core runs on Fly.io as one process, org `moooon`, region `iad`                           | [MOTIR-9712](motir:cmvprl4qg01c2hmu1kyfvucjx), the data and core cutover. The Fly apps themselves go in [MOTIR-9716](motir:cmvprl54901clhmu143y6z3l2), the decommission                                                           | `app.motir.co` serves from Fargate                                                                         |
| **Q2** (§3)                | The blob store is Tigris, two buckets (public assets, private content), with S3 presigned URLs | [MOTIR-9712](motir:cmvprl4qg01c2hmu1kyfvucjx), the data and core cutover, onto the S3 buckets [MOTIR-9707](motir:cmvprl4cl01bxhmu1s2n07ia3) (the data stack) builds. Tigris goes in [MOTIR-9716](motir:cmvprl54901clhmu143y6z3l2) | core's blob store points at the S3 buckets. **The two-bucket public/private split stays**                  |
| **Amendment 8** (§23, Q20) | The transport per leg: Flycast for core → ai and ai → gateway                                  | [MOTIR-9713](motir:cmvprl4ts01c3hmu1vpyeflw3), the ai, codegraph and gateway cutover                                                                                                                                              | core reaches motir-ai and the gateway, and motir-ai reaches the gateway, over private addresses in the VPC |
| **Amendment 9** (Q21)      | core → ai goes over motir-ai's public origin, `MOTIR_AI_URL = https://motir-ai.fly.dev`        | [MOTIR-9713](motir:cmvprl4ts01c3hmu1vpyeflw3), the ai, codegraph and gateway cutover                                                                                                                                              | core reaches motir-ai over a private address in the VPC                                                    |

**One caller Amendment 9 names is not retired by that story.** The fleet → motir-ai
path (`MOTIR_AI_CONTAINER_URL`, the index containers in Amendment 9's table of
public callers) is decided by the requirements-Q8 decision
([MOTIR-9705](motir:cmvprl47x01bvhmu1ibq4gxw4)), not by this amendment and not by
MOTIR-9713's choice of a private core → ai address.

#### How each retiring story closes its part

The retiring story edits the old text when it lands, the way Amendment 9 did
for Q20: a **SUPERSEDED** pointer where the old value is stated, naming the
story and the section that replaces it. This amendment adds no such pointer,
because on the day it is written every part in the table still describes
production. Marking them early would make the record wrong the other way.

### What this amendment does NOT decide

- **Marking Q1, Q2 or Amendments 8–9 superseded.** Each retiring story does that
  when it lands (above).
- **The fleet → motir-ai path.** Requirements Q8, decided in
  [MOTIR-9705](motir:cmvprl47x01bvhmu1ibq4gxw4).
- **The database engine.** Requirements Q3, decided in
  [MOTIR-9702](motir:cmvprl41l01bshmu1szum55xp). This record's own Q8 (§9)
  still describes the Neon databases production uses today.
- **Email.** Requirements Q5, decided in
  [MOTIR-9703](motir:cmvprl44201bthmu1z30v3gns).
- **Service-to-service authentication.** `MOTIR_AI_SERVICE_TOKEN` keeps gating
  every core → ai call, exactly as Amendment 1's last row and Amendment 9 say.
  A private address changes the transport, not the credential.
- **Sizes, floors and deploy strategies for any service.** Each service's
  cutover story writes them into the CDK; until then `fly.toml` holds them.
- **Commercial self-host.** The same CDK app installs it later, but its shape
  (requirements §4) is not decided here.

### Sources — additions

| Claim                                                                                             | Source                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production deploys into `us-east-1` only                                                          | The requirements-Q1 decision, [MOTIR-9701](motir:cmvprl40b01brhmu1545xvikl), page _Decision — Motir production on AWS deploys into us-east-1 only; no EU region now_, version 1, approved 2026-10-27                                           |
| Production moves to AWS under one parameterised CDK app; Q1, Q2 and Amendments 8–9 are superseded | Page [_Motir on AWS and self-host — requirements_](/pages/cmvpk4tpk01bihnr9thk2ftd9), §2 goals 1–3, §3 and §7                                                                                                                                  |
| The CDK becomes the single source of size, as `fly.toml` is today                                 | The same page, §3 _Compute (services)_                                                                                                                                                                                                         |
| `MOTIR_AI_URL` is the public origin and `MOTIR_AI_CONTAINER_URL` a public caller                  | Amendment 9 (Q21) above, on `origin/main` 2026-10-27                                                                                                                                                                                           |
| The stories that retire each part                                                                 | Epic [MOTIR-9699](motir:cmvprl3vo01blhmu1of10bhko): [MOTIR-9712](motir:cmvprl4qg01c2hmu1kyfvucjx), [MOTIR-9713](motir:cmvprl4ts01c3hmu1vpyeflw3), [MOTIR-9716](motir:cmvprl54901clhmu143y6z3l2), [MOTIR-9707](motir:cmvprl4cl01bxhmu1s2n07ia3) |
