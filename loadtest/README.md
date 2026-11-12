# The load test — runbook

This page takes an engineer who has never run the load test from a clean checkout
to a PASS/FAIL answer, and from a report to a correct reading of it. It is the
runbook for Story MOTIR-8538; the code it drives lives next to it in `loadtest/`.

> ⛔ **THIS PIPELINE STILL TARGETS FLY, AND CANNOT RUN TODAY.** Motir's own
> services moved to AWS (Story MOTIR-9716), and the Fly staging app, its Flycast
> origin and the `motir-loadgen` generator are gone with that move —
> `loadtest/staging/fly.staging.toml` was deleted by MOTIR-10962, which left
> `loadtest/staging/` host-neutral. Everything else under `loadtest/` — the run
> (`loadtest/run/`), the generator (`loadtest/generator/`), the preflight, the
> report's Fly Prometheus reads (`loadtest/report/`), the log capture, the
> profiles and the steps on this page that call `fly`, `flyctl` or a Flycast
> address — still assumes a Fly staging app and will not run until
> **MOTIR-11141** ports it to AWS or retires it. Read the rest of this page as
> the record of how the harness ran on Fly, not as steps to follow.

**The rule of this page.** Every step is **one command in a fenced block**,
followed by **what it prints** and the **line to check** before going on. Every
output block says where it came from:

- _format, not a captured run_ — the exact lines the code prints, quoted from the
  source file named beside it. Placeholders are written `<…>`.
- _to be captured by MOTIR-8674_ — a platform read (`fly`, `neonctl`) whose real
  output the first provisioning of staging (MOTIR-8674, which runs after this
  story merges) records here. Until then the block says only which field to read.

[The smoke run](#7-set-n-and-run) replaces the _format_ blocks of the run and
report commands with its captured output on its first run.

> ⚠️ **ONE TYPO AWAY FROM PRODUCTION.** Every command that names a Fly app does so
> with `-a` / `--app`, and production's web app is called `motir-core` — the
> staging app's name minus `-staging`. A dropped suffix on a `fly deploy`,
> `fly scale`, `fly secrets` or `fly machine` command **targets production**.
> `pnpm loadtest:run`, `pnpm loadtest:preflight` and `pnpm loadtest:report` refuse
> `motir-core` themselves before any platform call (`loadtest/run/run.ts`,
> `loadtest/preflight/sideEffects.ts`, `loadtest/report/prometheus.ts`), but
> **`fly deploy` and `neonctl branches reset` do not**: read the `-a` value and the
> `--project-id` / branch name twice before pressing enter.

> **The shell rule.** `fly ssh console -C "<cmd>"` does **not** run its command
> through a shell: a pipe, a redirect, `&&` or `$VAR` arrives as a literal
> argument. So any remote command with shell syntax is written
> `fly ssh console -a <app> --machine <id> -C "sh -c '<script>'"`, with the script
> single-quoted so your local shell does not expand it. A plain `printenv NAME`
> needs no shell. The run command follows the same rule
> (`loadtest/run/fly.ts` `shScript`).

**Names used on this page.** `motir-core-staging` (the staging app) and
`motir-loadgen` (the generator app) are the names MOTIR-8674 plans to create. If
provisioning records different names, use those, and set
`LOADTEST_STAGING_APP` / `LOADTEST_GENERATOR_APP` to match. Neon's project and
branch are never written out here: every Neon command reads them from
`$LOADTEST_NEON_PROJECT` and `$LOADTEST_NEON_BRANCH`.

---

## 1. What this measures and what it never touches

Two questions:

1. **How much does one `app` instance hold** under an agent-dominated mix — MCP
   tool calls (reads, writes, claims), container-less agent runs over the
   dispatch-run API, many agents per user and per workspace — beside signed-in
   readers holding the workbench stream and browsing?
2. **Does adding instances add throughput?** The same profile at N = 2 is judged
   against a named N = 1 baseline.

**What runs:** synthetic agents (personal access tokens minted by the seed)
calling MCP and `/api/v1`, and synthetic signed-in readers, all driven by k6 on a
generator machine inside Fly's private network, against a staging app that runs
production's CI-built image on a Neon branch copied from production.

**What never runs:** no agent container, no real email (the `console` provider),
no GitHub write, no call to production's motir-ai, no event in production's Sentry
project from the server, no fleet machine, no credit spent. Each of those is a
row of `loadtest/staging/sideEffectSwitches.ts`, and the preflight
([section 9](#9-checking-each-side-effect-sink)) refuses a run while any is live.

The experiment itself is data:

- the profiles — [`loadtest/profiles/smoke.json`](./profiles/smoke.json) and
  [`loadtest/profiles/default.json`](./profiles/default.json), validated by
  `loadtest/profiles/schema.ts`;
- the scenarios, their metric names, tags and the outcome classes
  `ok | empty | limited | error` —
  [`loadtest/k6/scenarios/README.md`](./k6/scenarios/README.md).

---

## 2. Before you start

### Tools

Run each and keep the answer for the PR or the run notes.

```sh
flyctl version
```

```sh
neonctl --version
```

Neon's newer docs call the binary `neon` with `neonctl` as an alias; Homebrew's
formula is `neonctl`. If only `neon` answers, use it everywhere this page says
`neonctl`.

```sh
pnpm --version
```

```sh
jq --version
```

```sh
psql --version
```

```sh
node --version
```

**Check:** Node's major version is **22**, the version `.github/workflows/ci.yml`'s
`setup-node` step uses (`node-version: 22`).

### Access

- **Fly:** a member of the `moooon` organisation, with a `FLY_API_TOKEN` that can
  read and scale the staging app and start and stop the generator app.
- **Neon:** the account holding production's project. If the project is managed
  through the Vercel integration, MOTIR-8674 records which account and which
  permissions reach it; until then, treat this as unverified.
- **Sentry:** read access to the staging Sentry project and to production's
  project (for the [Sentry check](#sentry)).

**Network.** You need the Fly CLI and the database access the seed uses. You do
**not** need a route to the private staging app: the run command's readiness and
pin checks run **on the generator machine** over `fly ssh console`
(`loadtest/run/run.ts` header, _WHERE EACH STEP RUNS_). When a by-hand check needs
to reach staging, [section 8](#8-reaching-private-staging-by-hand) gives
`fly proxy`.

### Environment variables

| Variable                                   | Read by                                                                                                                        | Where the value comes from (and how to read it back)                                                                                                                                                                                     | Secret  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `LOADTEST_STAGING_APP`                     | `loadtest:preflight` (required), `loadtest:run` (the default for `--app`; must equal it)                                       | The staging app's name. Read back: `fly status -a motir-core-staging`                                                                                                                                                                    | no      |
| `LOADTEST_GENERATOR_APP`                   | `loadtest:run`                                                                                                                 | The generator app's name. Read back: `fly machine list --json -a motir-loadgen`                                                                                                                                                          | no      |
| `LOADTEST_NEON_PROJECT`                    | `loadtest:run`, the run-window capture, sections 3–4                                                                           | The Neon project id holding production. Read back: `neonctl projects list -o json`                                                                                                                                                       | no      |
| `LOADTEST_NEON_BRANCH`                     | `loadtest:run`, the run-window capture, sections 3–4                                                                           | The staging branch's name. Read back: `neonctl branches get "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" -o json`                                                                                                       | no      |
| `LOADTEST_DATABASE_URL`                    | `loadtest:run` (passed to the seed as `DATABASE_URL`)                                                                          | The staging branch's **pooled** `motir_app` URL, set in your shell from Neon (below), never written to a file                                                                                                                            | **yes** |
| `LOADTEST_DATABASE_URL_UNPOOLED`           | `loadtest:run` (optional; passed to the seed as `DATABASE_URL_UNPOOLED`, defaulting to `LOADTEST_DATABASE_URL`)                | The same branch's **direct** URL, set the same way                                                                                                                                                                                       | **yes** |
| `LOADTEST_ALLOWED_DB_HOST`                 | `loadtest:run`, `loadtest:preflight`, `loadtest:seed`, `loadtest:seed:reset`                                                   | The staging branch's direct endpoint host (`ep-…`, no `-pooler`). Read back with the host-only command below                                                                                                                             | no      |
| `LOADTEST_PRODUCTION_DB_HOSTS`             | `loadtest:preflight`, `loadtest:seed`, `loadtest:seed:reset` — **both fail closed when it is unset**                           | Production's endpoint hosts, comma-separated, recorded by MOTIR-8674                                                                                                                                                                     | no      |
| `LOADTEST_PRODUCTION_SENTRY_PROJECT_ID`    | `loadtest:preflight` — **fails closed when it is unset**                                                                       | Production's Sentry project id (the number at the end of its DSN), recorded by MOTIR-8674                                                                                                                                                | no      |
| `LOADTEST_NEON_API_KEY`                    | the run-window capture (Neon endpoint readings; without it they read `unmeasured`), the post-refresh role rotation (section 4) | A Neon API key that may reset role passwords and read endpoints. Neon's docs do not state the scope required; MOTIR-8674 records the scope it found to work                                                                              | **yes** |
| `LOADTEST_NEON_API_URL`                    | the run-window capture (optional)                                                                                              | Defaults to `https://console.neon.tech/api/v2` (`loadtest/capture/neon.ts`)                                                                                                                                                              | no      |
| `LOADTEST_FLY_PROM_TOKEN`                  | `loadtest:report`                                                                                                              | A Fly token for the managed Prometheus; see [the token setup](#the-prometheus-token). Without it the report runs `fly auth token`                                                                                                        | **yes** |
| `LOADTEST_FLY_PROM_TOKEN_SCHEME`           | `loadtest:report`                                                                                                              | `FlyV1` (the default, what a `fly auth token` value needs) or `Bearer`                                                                                                                                                                   | no      |
| `LOADTEST_PROM_URL`                        | `loadtest:report` (optional)                                                                                                   | Defaults to `https://api.fly.io/prometheus/moooon` (`loadtest/report/report.ts` `OPTIONS.env`)                                                                                                                                           | no      |
| `LOADTEST_PROM_SETTLE_SECONDS`             | `loadtest:report` (optional)                                                                                                   | Seconds after the run ends before Prometheus is read; default 60                                                                                                                                                                         | no      |
| `STAGING_BASE_URL`                         | `loadtest:run` (and `scripts/staging`)                                                                                         | Staging's origin **as seen from the generator** — the Flycast address, `http://motir-core-staging.flycast` (`loadtest/staging/sideEffectSwitches.ts` `REQUIRED_SET`)                                                                     | no      |
| `STAGING_ALLOWED_HOST`                     | `loadtest:run` (and `scripts/staging`)                                                                                         | The host `STAGING_BASE_URL` must have: `motir-core-staging.flycast`. A mismatch refuses before any request (`scripts/staging/lib/pinnedClient.ts` `assertAllowedBaseUrl`)                                                                | no      |
| `FLY_API_TOKEN`                            | `loadtest:run` (required), `scripts/assert-machine-pool.mjs`, every `fly` command                                              | `fly tokens create` for the `moooon` organisation                                                                                                                                                                                        | **yes** |
| `BETTER_AUTH_SECRET`                       | `loadtest:run` (for its seed step), `loadtest:seed`, `loadtest:seed:reset`                                                     | **The staging app's own value**, which provisioning generated and you saved. Fly secrets are write-only: a lost value cannot be read back — set a new one on staging (`fly secrets set … -a motir-core-staging`), deploy, and seed again | **yes** |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `loadtest:run` (seed step), `loadtest:seed`, `loadtest:seed:reset`                                                             | Placeholders suffice: `lib/auth/index.ts` requires them at import                                                                                                                                                                        | no      |
| `NODE_ENV`                                 | `loadtest:run` (seed step), `loadtest:seed`, `loadtest:seed:reset`                                                             | Must be `production`, as staging runs, so the session cookie's attributes match (`loadtest/seed/guard.ts` `missingSeedEnv`)                                                                                                              | no      |
| `MOTIR_BASE_URL`                           | `loadtest:seed`, `loadtest:seed:reset` (by hand only — the run command sets it from `STAGING_BASE_URL`)                        | Staging's own origin, the same value as `STAGING_BASE_URL`. Better-Auth derives the session cookie's **name** from it                                                                                                                    | no      |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED`    | `loadtest:seed`, `loadtest:seed:reset` (by hand only — the run command sets them from `LOADTEST_DATABASE_URL*`)                | The pooled and the direct staging URLs, as above                                                                                                                                                                                         | **yes** |

The seed reads the session cookie's **name** from Better-Auth's own configuration
built from this environment (`loadtest/seed/manifest.ts`, `cookieName`). This page
does not state the name: it follows the scheme of `MOTIR_BASE_URL`, so an
`http://…flycast` origin and an `https://` one give different names.

**The two URL variables are set in your shell, never stored.** Each holds the
`motir_app` role's password, which section 4 rotates after every refresh:

```sh
export LOADTEST_DATABASE_URL="$(neonctl connection-string "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" --role-name motir_app --pooled)"
```

```sh
export LOADTEST_DATABASE_URL_UNPOOLED="$(neonctl connection-string "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" --role-name motir_app)"
```

Neither prints anything. `neonctl connection-string` takes the branch as a
positional argument, returns the direct host unless `--pooled` is given, and the
URL it returns contains the password — so it only ever goes into a variable or a
pipe.

The endpoint host, without the password:

```sh
neonctl connection-string "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" --role-name motir_app | sed -E 's#^[^@]*@([^/:?]+).*#\1#'
```

_Output — to be captured by MOTIR-8674:_

```text
ep-<endpoint id>.<region>.aws.neon.tech
```

**Check:** this is the value of `LOADTEST_ALLOWED_DB_HOST`, and it is in none of
`LOADTEST_PRODUCTION_DB_HOSTS`.

### Keeping the values

Keep the non-URL values in two **uncommitted** local files at the repository
root, both covered by `.gitignore`'s `*.local` rule:

- `loadtest.env.local` — the `LOADTEST_*`, `STAGING_*` and seed values;
- `staging.secrets.local` — the staging app's secrets, filled from
  `loadtest/staging/staging.secrets.example` (section 3).

Load the first into a shell with:

```sh
set -a; . ./loadtest.env.local; set +a
```

It prints nothing.

> ⚠️ **`loadtest/.out/` holds tokens and cookies** — the seed manifest
> (`loadtest/.out/manifest.json`, mode `0600`), and each run directory. It is
> gitignored. Never print, paste, attach or share anything from it except a
> report published with `pnpm loadtest:report <run dir> --publish`
> ([section 10](#10-what-a-run-leaves-behind)).

---

## 3. Reuse or provision staging

### Reuse: is staging already there?

Five reads. If every one answers as described, skip to
[section 4](#4-refresh-the-branch-from-production).

**3.1 — the staging app.**

```sh
fly status -a motir-core-staging
```

_Output — to be captured by MOTIR-8674._

**Check:** the app exists, and its `app` and `worker` process groups are listed.

**3.2 — its machines.**

```sh
fly machine list --json -a motir-core-staging | jq -r '.[] | [.id, .config.metadata.fly_process_group, .state, .config.guest.cpu_kind, .config.guest.cpus, .config.guest.memory_mb, .image_ref.tag] | @tsv'
```

_Output — to be captured by MOTIR-8674. The fields are the ones the run command
parses (`loadtest/run/fly.ts` header):_

```text
<machine id>	app	started	<cpu kind>	<cpus>	<memory MB>	<sha>
<machine id>	worker	started	<cpu kind>	<cpus>	<memory MB>	<sha>
```

**Check:** every `app` machine is `started` (a stopped `app` machine makes the
run command exit `4`), and every tag is the same SHA.

**3.3 — no public address.**

```sh
fly ips list --json -a motir-core-staging
```

_Output — to be captured by MOTIR-8674._

**Check:** the only address is a private (Flycast) one. A public v4 or v6
address means staging is reachable from the internet: stop and report it.

**3.4 — the Neon branch.**

```sh
neonctl branches get "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" -o json
```

_Output — to be captured by MOTIR-8674._

**Check:** the branch exists, its parent is production's branch, and it is not
protected and has no child branches (either blocks a refresh, section 4).

**3.5 — the generator.**

```sh
fly machine list --json -a motir-loadgen | jq -r '.[] | [.id, .region, .state] | @tsv'
```

_Output — to be captured by MOTIR-8674:_

```text
<generator machine id>	iad	stopped
```

**Check:** exactly one machine, region `iad`, state `stopped` — its normal
resting state. The run command starts it and stops it again
(`loadtest/run/generator.ts`), and refuses a generator outside `iad`.

### Provision: when any read above is missing

These are MOTIR-8674's **planned** steps. That card runs them for the first time
and replaces this list with the commands it actually ran, their real outputs and
the custody note for `BETTER_AUTH_SECRET`. Until then every output here is _to be
captured by MOTIR-8674_.

**3.6 — create the staging app.**

```sh
fly apps create motir-core-staging --org moooon
```

**Check:** the app is created in `moooon`.

**3.7 — create the staging branch from production's branch.**

```sh
neonctl branches create --project-id "$LOADTEST_NEON_PROJECT" --name "$LOADTEST_NEON_BRANCH" --parent <production branch>
```

**Check:** the new branch's parent is production's branch. Then rotate its role
passwords exactly as [step 4.4](#4-refresh-the-branch-from-production) does —
the branch starts with production's passwords.

**3.8 — fill the secrets.** Copy the generated template; it lists exactly the
names the preflight demands, and an extra or a missing name refuses a run.

```sh
cp loadtest/staging/staging.secrets.example staging.secrets.local
```

It prints nothing. Fill the empty values: `DATABASE_URL` and
`DATABASE_URL_UNPOOLED` from step 4.6's commands, the **staging** Sentry
project's DSN, a fresh `BETTER_AUTH_SECRET` (save it — section 2),
placeholders for Google, `MOTIR_BASE_URL="http://motir-core-staging.flycast"`.
Never paste a production value.

**3.9 — stage them on the app.**

```sh
fly secrets import --stage -a motir-core-staging < staging.secrets.local
```

**Check:** the command lists the names it staged and nothing else.

**3.10 — a private address only.** Flycast's documented command:

```sh
fly ips allocate-v6 --private -a motir-core-staging
```

**Check:** the address it prints is private (`fdaa:…`).

**3.11 — the first deploy.** [Section 5](#5-deploy-a-chosen-sha)'s command,
which needs `loadtest/staging/fly.staging.toml` (MOTIR-8674 checks it in; this
repository does not carry it yet). The first deploy is also where the cross-app
image pull is confirmed (section 5).

**3.12 — the generator app.**

```sh
fly apps create motir-loadgen --org moooon
```

**3.13 — its volume** (k6's point file is written there; the run command refuses
a generator with nothing mounted at `/data`, `loadtest/run/generator.ts`
`VOLUME_MOUNT`). `loadtest/generator/fly.loadgen.toml` mounts a volume named
`loadgen_data` there, so create it under that name:

```sh
fly volumes create loadgen_data --region iad --size 3 -a motir-loadgen
```

**Check:** `fly volumes list -a motir-loadgen` shows `loadgen_data` in `iad`.

**3.14 — its one machine.** The image recipe is `loadtest/generator/Dockerfile`: it builds
the k6 and `xk6-sse` pair `loadtest/k6/versions.env` pins and puts it at
`/opt/loadtest/k6` (`REMOTE_K6`). One command builds it on Fly's builder and deploys the
machine, with the volume attached:

```sh
loadtest/generator/deploy.sh
```

It prints Fly's deploy log and ends with the machine id. A machine that already exists
without the volume (the one MOTIR-8674 made by hand) cannot take it: destroy it first with
`fly machine destroy <id> --force -a motir-loadgen`.

**Check:** one machine in `iad`, and the binary and mount are in it:

```sh
fly ssh console -a motir-loadgen -C '/opt/loadtest/k6 version'
fly ssh console -a motir-loadgen -C 'grep " /data " /proc/mounts'
```

The first lists `k6 v1.2.1` and `github.com/phymbert/xk6-sse v0.1.12`; the second prints the
volume's device line.

**3.15 — leave it stopped.**

```sh
fly machine stop <generator machine id> -a motir-loadgen
```

**3.16 — the preflight reads `0`.** Run [step 9.1](#9-checking-each-side-effect-sink).
Staging is provisioned when it prints `OK: …` and exits `0`.

---

## 4. Refresh the branch from production

A refresh gives staging production's latest data. It is **the one command on this
page that writes to staging's database**, and it is aimed by `--project-id` and a
branch **name** — never at production's branch. Whoever holds the Neon credential
for the project (MOTIR-8674 records who) runs it.

What Neon's documentation says about `branches reset … --parent`:

- `--parent` is a boolean flag with no value, and resetting from the parent is the
  only supported reset. (`--preserve-under-name <name>` keeps the old data under
  another name; it is not used here.)
- The branch's data and schema are replaced with the parent's latest. The
  **branch ID and the connection details do not change**; existing connections
  are **temporarily dropped and then re-established**.
- A reset is **blocked** when the branch has **child branches** of its own (so
  nothing may be branched from the staging branch), when it is a **root** branch,
  when it is **protected**, and for **up to 24 hours after the parent is restored
  from a snapshot**.

What follows for this runbook: a refresh discards every seeded row (the run
command seeds again on every run, so nothing is lost), and the next deploy's
`release_command` migrates the branch — so **a refresh is always followed by a
deploy** ([section 5](#5-deploy-a-chosen-sha)).

**4.1 — reset.**

```sh
neonctl branches reset "$LOADTEST_NEON_BRANCH" --parent --project-id "$LOADTEST_NEON_PROJECT"
```

_Output — to be captured by MOTIR-8674._ Neon's own example prints the branch with
the **same branch ID** as before and a new `Last Reset At`.

**Check:** the branch ID is unchanged.

**4.2 — record the copied-from time, straight away.** The branch JSON's reset
field is not documented, so the refresh records its own completion time. The run
command reads it first (`loadtest/run/neon.ts` `copiedFrom`: `refresh.json`, then
a reset key on the branch JSON, then `parent_timestamp`, then `created_at`, and
`run.json` names which one answered as `neon.copiedAtField`).

```sh
neonctl branches get "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" -o json | jq -c --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{branchId: (.branch.id // .id), refreshedAt: $t}' > loadtest/.out/refresh.json
```

It prints nothing; `loadtest/.out/refresh.json` holds `{branchId, refreshedAt}`.

**Check:** the file's `branchId` is the ID from 4.1. ⚠️ The run command does not
compare that ID with the branch it reads, so if you ever recreate the branch,
delete `loadtest/.out/refresh.json` first.

**4.3 — the endpoint host is still the allowed one.**

```sh
neonctl connection-string "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" --role-name motir_app | sed -E 's#^[^@]*@([^/:?]+).*#\1#'
```

_Output — to be captured by MOTIR-8674._

**Check:** it equals `LOADTEST_ALLOWED_DB_HOST`. If it does not, the refresh moved
the endpoint: update `LOADTEST_ALLOWED_DB_HOST` and re-run section 2's two
`export` commands before anything else.

### After every refresh: the roles

Neon's documentation is silent on whether a reset restores the parent's roles and
passwords. If it does, staging holds **production's passwords** again, undoing
provisioning's rotation. **Unverified until the first refresh (MOTIR-8674)
checks it**, so these steps run after every refresh.

**4.4 — read the RLS bypass flags** through the direct URL (section 2's
`export`, re-run after 4.1).

```sh
psql "$LOADTEST_DATABASE_URL_UNPOOLED" -Atc "select rolname, rolbypassrls from pg_roles where rolname in ('motir_app', '<owner role>')"
```

_Output — to be captured by MOTIR-8674:_

```text
motir_app|f
<owner role>|t
```

**Check:** `motir_app` is `f` (false) and the owner is `t`.

**4.5 — rotate each role's password** (`motir_app`, then the owner role
MOTIR-8674 names), through the Neon API — `neonctl roles` has only `list`,
`create` and `delete`. The response carries the new password, so the `jq` filter
drops it and keeps only the operations:

```sh
curl -sS -X POST -H "Authorization: Bearer $LOADTEST_NEON_API_KEY" "https://console.neon.tech/api/v2/projects/$LOADTEST_NEON_PROJECT/branches/<branch id>/roles/motir_app/reset_password" | jq '[.operations[] | {id, action, status}]'
```

_Output — to be captured by MOTIR-8674._

**Check:** wait until every listed operation is `finished` before going on. Neon's
reference says the old password stays valid until then (one Neon FAQ says it
stops at once), and connections to the endpoint are dropped — so the next steps
verify rather than assume.

**4.6 — put the new URLs on staging** (staged; the deploy in section 5 applies
them). One command each; the URL goes from Neon straight into Fly and is never
shown.

```sh
neonctl connection-string "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" --role-name motir_app --pooled | sed 's/^/DATABASE_URL=/' | fly secrets import --stage -a motir-core-staging
```

```sh
neonctl connection-string "$LOADTEST_NEON_BRANCH" --project-id "$LOADTEST_NEON_PROJECT" --role-name motir_app | sed 's/^/DATABASE_URL_UNPOOLED=/' | fly secrets import --stage -a motir-core-staging
```

_Output — to be captured by MOTIR-8674._ **Check:** each names exactly one secret.

**4.7 — refresh your own two variables:** re-run section 2's two `export`
commands.

**4.8 — test one connection.**

```sh
psql "$LOADTEST_DATABASE_URL" -Atc "select current_user"
```

_Output:_ `motir_app`. **Check:** it connects with the new password. Then repeat
step 4.3: the host is still `LOADTEST_ALLOWED_DB_HOST`.

---

## 5. Deploy a chosen SHA

Staging runs **production's CI-built image**, so "the same image" is literally
true and the platform records the SHA. The tag is the SHA because
`.github/workflows/ci.yml`'s `deploy` job builds with
`--image-label "$GITHUB_SHA"`. (`--image-label` is only for a build Fly runs; it
is not passed with `--image`.) Do **not** `git checkout <sha>` and `fly deploy`
from a checkout: that builds a different image.

**5.1 — re-diff the staging config against production's, every time.** A
production change to `[env]`, the process groups or `release_command` must reach
staging deliberately, not by accident.

```sh
diff fly.toml loadtest/staging/fly.staging.toml
```

_Output — to be captured by MOTIR-8674_ (the file is its deliverable). The
differences you should see, and why:

- `app` names the staging app.
- `[http_service] force_https = false` — Fly's Flycast documentation says Flycast
  is HTTP-only and not to use `force_https` with it; production's `true` would
  make `http://…flycast` requests unusable.
- No auto-stop: production carries `auto_stop_machines = "stop"` and
  `min_machines_running = 2`; staging carries `auto_stop_machines = "off"` and
  `auto_start_machines = false` (the Machines API documents `autostop` as
  `off | stop | suspend`, default `off`, and `min_machines_running` as applying
  only when `autostart` is on). The run command refuses an `app` service whose
  `autostop` is not `off`.
- `[http_service.concurrency]` with `type = "requests"` and **explicit**
  `soft_limit` and `hard_limit` — unset, Fly means 20 and unlimited. The run
  command refuses an unset limit and a limit below what the profile requires
  (`loadtest/run/run.ts` step 2).

`tests/loadtest/storyGate.runToReport.test.ts` holds the checked-in file to
`force_https = false`, auto-stop off, auto-start false, type `requests` and both
limits set.

**Check:** no other difference than these, unless you meant it.

**5.2 — deploy.**

```sh
fly deploy -a motir-core-staging --config loadtest/staging/fly.staging.toml --image registry.fly.io/motir-core:<sha> --no-public-ips --ha=false
```

_Output — to be captured by MOTIR-8674._

**Check:** the release command (the migration) succeeds and every machine is
updated.

**Cross-app image pull.** Fly staff say, in community threads, that an app can
deploy `registry.fly.io/<other-app>:<tag>` from another app in the same
organisation when the token can access both; Fly's own documentation only shows
deploying a private image with `--image` and the full registry path. **Expected to
work; the first deploy (MOTIR-8674) confirms it.** If it does not, MOTIR-8674
records the fallback here — for example building the same SHA with
`--build-arg MOTIR_RELEASE=<sha>`, which gives up the byte-identical image and
must say so in every report header it produces.

**5.3 — read back that every machine runs that image.**

```sh
fly machine list --json -a motir-core-staging | jq -r '.[] | [.id, .config.metadata.fly_process_group, .state, .image_ref.tag] | @tsv'
```

_Output — to be captured by MOTIR-8674._

**Check:** every `app` and `worker` line ends in `<sha>`. The run command records
the tag as `sha` in `run.json` and, given `--sha <sha>`, exits `4` with
`deployed sha is <read sha>, expected <sha>` on a mismatch
(`loadtest/run/run.ts`).

**5.4 — production's size,** a read-only read the run command also makes to
compare machine sizes:

```sh
fly machine list --json -a motir-core | jq -r '.[] | select(.config.metadata.fly_process_group == "app") | [.config.guest.cpu_kind, .config.guest.cpus, .config.guest.memory_mb] | @tsv'
```

**Check:** staging's `app` machines (step 5.3) are the same size. If they differ
the run command exits `4` unless you pass `--candidate-size`
([section 7](#7-set-n-and-run)).

**How N is reached.** You never scale by hand for a run:
`pnpm loadtest:run --instances <N>` scales the `app` group with Fly's documented
`fly scale count app=<N>` form (falling back to `--process-group app`,
`loadtest/run/fly.ts` `SCALE_SPELLINGS`), only when the started count differs
from N, and then reads N back. How `fly scale count` treats **stopped** machines
is not documented, so the run command refuses a group holding a stopped `app`
machine rather than rely on a count.

---

## 6. Seeding

**The run command seeds and resets on every run** (`loadtest/run/run.ts` step 8),
so a person never has to. These commands are for checking a seed by hand. They
need section 2's seed environment — `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`MOTIR_BASE_URL`, `NODE_ENV=production`, `LOADTEST_ALLOWED_DB_HOST` and
`LOADTEST_PRODUCTION_DB_HOSTS` — with the two database URLs set from section 2's
variables.

What to know first:

- **The seed never prints a token or a cookie** (`loadtest/seed/seed.ts` header).
  Every token's plaintext and every reader's cookie go only into the manifest,
  `loadtest/.out/manifest.json`, written mode `0600`. Only a token's hash is
  stored in the database, so a lost manifest is recovered by seeding again, never
  by a reset.
- **Seeding the same `--tag` again** reuses its users, workspaces, projects,
  cards and plans, **deletes the tag's previous tokens and mints new ones**, and
  writes a fresh manifest.
- The run command uploads the manifest to the generator into tmpfs
  (`/dev/shm/loadtest/manifest.json`, mode `0600`) and deletes it there after the
  run; `run.json`'s `manifestDeleted` says whether that succeeded.

**6.1 — seed.** Flags: `--shape <file.json>` (the profile's `seed` section; the
smoke shape when omitted), `--tag <run tag>` (default `lt`), `--out <manifest
path>` (default `loadtest/.out/manifest.json`).

```sh
pnpm loadtest:seed --tag lt
```

_Output — format, not a captured run (`loadtest/seed/seed.ts`,
`loadtest/seed/tenants.ts`):_

```text
seeding tag "lt" (smoke shape) into <LOADTEST_ALLOWED_DB_HOST>
re-seeding a tag reuses its users, workspaces and projects, deletes its previous tokens and mints new tokens and cookies
users: <n>
workspaces: <n>
projects: <n> (backlog, pools and read plans in place)
deleted <n> previous lt tokens (new ones are minted below)
agents: <n> (read <n>, write <n>, claim <n>, run <n>)
burst agents: <n> × <burst size> cards; scratch plans: <n>
sessions: <n> (no two-factor hold)
manifest written to <path> (mode 0600; it holds credentials — never commit or print it)
```

**Check:** the first line names `LOADTEST_ALLOWED_DB_HOST`, and the command exits
`0`. (`deleted …` appears only when the tag had tokens.)

**What the guard prints when it refuses** — exit `2`, before any database
connection (`loadtest/seed/seed.ts`, `loadtest/seed/guard.ts`):

```text
refused: missing environment — <every missing name, NODE_ENV (must be production, got <value>)>
refused: LOADTEST_ALLOWED_DB_HOST is unset: the seed writes only to the staging branch host it names.
refused: LOADTEST_PRODUCTION_DB_HOSTS is unset: the guard fails closed without the production deny-list.
refused: DATABASE_URL points at a PRODUCTION endpoint (<host>). Refused.
refused: DATABASE_URL points at <host>, not LOADTEST_ALLOWED_DB_HOST (<allowed host>). Refused.
refused: --tag must match [a-z0-9][a-z0-9-]{0,23}, got <tag>
```

A `PRODUCTION endpoint` refusal is the guard doing its job: fix the variable, and
report how a production URL reached it.

**6.2 — reset the pools** without re-seeding (claimed and run cards back to
`todo`, burst cards back to their first parent, grown scratch plans replaced).
Flag: `--manifest <path>` (default `loadtest/.out/manifest.json`, rewritten in
place).

```sh
pnpm loadtest:seed:reset
```

_Output — format, not a captured run (`loadtest/seed/reset.ts`,
`loadtest/seed/tenants.ts`):_

```text
resetting tag "lt" in <LOADTEST_ALLOWED_DB_HOST>
pool cards restored: <n>
scratch plans replaced: <n>
manifest rewritten at <path>
```

**Check:** exit `0`. A missing manifest exits `3` with
`refused: no seed manifest at <path>. A reset cannot recover one: …` — seed again.
A manifest seeded into another host exits `2`.

---

## 7. Set N and run

One command per run. Its flags (`loadtest/run/run.ts` `OPTIONS.flags`):

| Flag                       | Meaning                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `--profile <name or path>` | `smoke`, `default`, or a path to a profile file (required)                                       |
| `--instances <N>`          | the staging `app` instances to run at (required)                                                 |
| `--app <staging app>`      | the staging Fly app (default `LOADTEST_STAGING_APP`); must end in `-staging`, never `motir-core` |
| `--baseline <run dir>`     | required for N > 1: a run directory at 1 instance with the same profile load hash                |
| `--candidate-size`         | allow a staging `app` size that differs from production's (recorded in `run.json`)               |
| `--sha <sha>`              | the deployed SHA the `app` machines must run                                                     |
| `--tag <seed tag>`         | the seed run tag (default `lt`)                                                                  |

It needs `FLY_API_TOKEN`, `LOADTEST_GENERATOR_APP`, `LOADTEST_NEON_PROJECT`,
`LOADTEST_NEON_BRANCH`, `LOADTEST_DATABASE_URL`, `LOADTEST_ALLOWED_DB_HOST`,
`STAGING_BASE_URL`, `STAGING_ALLOWED_HOST`, and the preflight's own
`LOADTEST_STAGING_APP` and `LOADTEST_PRODUCTION_SENTRY_PROJECT_ID`
(`OPTIONS.requiredEnv`), plus the seed's `BETTER_AUTH_SECRET`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NODE_ENV=production` and
`LOADTEST_PRODUCTION_DB_HOSTS`. A missing one exits `2` before any platform call.

**7.1 — the smoke run at N = 1.**

```sh
pnpm loadtest:run --profile smoke --instances 1 --app motir-core-staging
```

**7.2 — the same at N = 2,** against the N = 1 run directory printed by 7.1
(refused with exit `2` without `--baseline`, or with a baseline that ran at
another N or a different load):

```sh
pnpm loadtest:run --profile smoke --instances 2 --app motir-core-staging --baseline loadtest/.out/runs/<N = 1 run id>
```

**7.3 — the default profile,** at N = 1 and then N = 2 the same way:

```sh
pnpm loadtest:run --profile default --instances 1 --app motir-core-staging
```

Add `--sha <sha>` to any of them to have the run refuse a staging app that is not
running the SHA you deployed.

_Output — format, not a captured run. The run command prints these lines, in this
order (`loadtest/run/run.ts`, `loadtest/profiles/resolve.ts` `describeResolved`,
`loadtest/seed/*`, `loadtest/report/report.ts`):_

```text
profile smoke at 1 instance(s) — load hash <12 hex>
VUs <n>: agents <n> (read <n> · write <n> · claim <n> · run <n>), readers <n> (tab <n> · browse <n>), burst <n>
offered ≤ <rps> req/s per instance (MCP <rps> · /api/v1 <rps> · readers <rps>) against targetRps <n> (bound <rps>)
per token: MCP <rps> req/s · /api/v1 <rps> req/s; busiest workspace <rps> req/s of <allowed> allowed
held streams <n> per instance → proxy concurrency required: hard ≥ <n>, soft ≥ <n> (type requests)
scaling motir-core-staging app group <started> → <N>
seed | seeding tag "lt" (<smoke | custom> shape) into <LOADTEST_ALLOWED_DB_HOST>
seed | …
k6 started on <generator machine id>; polling every 10 s
k6 | <k6's own progress lines: VUs and iterations>
run directory: loadtest/.out/runs/<UTC stamp>-<profile>-n<N>
report: waiting <s> s for Prometheus to ingest the run's last scrape
verdict: <PASS | FAIL | UNMEASURED | INVALID>[ — <reasons>]
report: <run dir>/report.md
```

**Check:** the `verdict:` line. The `scaling …` line appears only when the
started count differed from N; `capture: <recorder> failed — …` lines may appear
(the run goes on, and the report reads that recording as `unmeasured`); a
refusal adds `exit <code>: <reason>` just before `run directory:`.

The steps the command takes between those lines **print nothing** and are
recorded instead: the platform read-backs, N read back and the machine ids
(`run.json` `app.machines`, `instances`), the generator start and stop
(`generator.startedAt` / `stoppedAt`), the preflight lines (`preflight.txt`), the
database witness (`neon.endpointHost`, `neon.branchId`, `neon.copiedAt`) and the
end read-back (`instancesHeld`). Per-route and per-tool rates are in the report,
not in k6's progress lines.

> ⚠️ **THE RUN COMMAND'S EXIT IS WHETHER THE RUN COMPLETED, NEVER WHETHER IT
> PASSED.**
>
> - Exit `0` means _completed_. A failed threshold does not change it. The run
>   gives k6 no thresholds, so k6's exit `99` (failed thresholds) does not occur;
>   it is tolerated anyway (`loadtest/run/generator.ts` `K6_COMPLETED_CODES`).
> - **The verdict is the report's.** The command ends by writing the report; read
>   it from `report.md`, or run `pnpm loadtest:report <run dir>`, which **exits
>   `0` PASS · `1` FAIL · `3` UNMEASURED · `6` INVALID** (and `2` when the run
>   directory or its `run.json` is missing). A script that gates on a run must
>   read **that** exit, not the run command's.

**The run command's exit codes**, quoted from `loadtest/run/run.ts`:

| Exit | `loadtest/run/run.ts` says                                                                                                                                                                                                 | Commonest cause → fix                                                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | the run completed (not: passed)                                                                                                                                                                                            | Read the verdict line.                                                                                                                                                                                                                                                                                                                                                  |
| `2`  | configuration refused — nothing scaled or sent (bad profile, missing env or flag, `motir-core` or a non-`-staging` app, a missing or mismatched --baseline), or refused after run.json exists (preflight LIVE, seed short) | A `refused: …` line names it: set the variable or flag. After `run.json` exists, `preflight.txt` names the LIVE row → fix the **staging secret**, never the switch table ([section 9](#9-checking-each-side-effect-sink)).                                                                                                                                              |
| `4`  | the platform is not in the required state                                                                                                                                                                                  | The `exit 4: <reason>` line: a stopped `app` machine, a size differing from production's (pass `--candidate-size` only for a sizing run), `autostop` not off, a concurrency limit unset or too low, a SHA mismatch, an `app` machine not ready, the generator not in `iad` or without its volume, or the machine set changing during the run. Fix the platform, re-run. |
| `5`  | k6 could not be started, did not finish, or its summary could not be fetched                                                                                                                                               | `k6.log` in the run directory; check the generator (`fly machine list --json -a motir-loadgen`) and re-run.                                                                                                                                                                                                                                                             |

After exit `4` or `5` the report still runs and says `INVALID` with the reason.

**`--candidate-size`.** Without it, a staging `app` machine whose size differs
from production's makes the run exit `4`. It is legitimate **only for a sizing
run** — trying a candidate machine size on purpose — and the report header
records `candidateSize: true`, so such a report is never compared with one at
production's size.

**7.4 — after the run: scale staging back to one machine.** The run command does
not scale down.

```sh
fly scale count app=1 -a motir-core-staging --yes
```

_Output — to be captured by the smoke run._ **Check:** `fly machine list` then
shows one started `app` machine.

**7.5 — confirm the generator is stopped.**

```sh
fly machine list --json -a motir-loadgen | jq -r '.[] | [.id, .state] | @tsv'
```

**Check:** `stopped`. The run command stops it itself, also when the run fails
(`loadtest/run/run.ts` step 11), and prints
`⚠️ could not stop generator <id>: <reason> — stop it by hand` if it cannot. A
machine still `started` after a run that printed no such line is a defect to
report. The running and stopped costs are recorded by MOTIR-8674's provisioning
evidence.

---

## 8. Reaching private staging by hand

Staging has no public IP. To curl it or open it, go through Fly's private network
with `fly proxy` or `fly wireguard`, and use `http://` — Flycast is HTTP-only.
Remote commands go through `fly ssh console … -C "sh -c '…'"` (the shell rule at
the top).

**8.1 — a local port to staging.**

```sh
fly proxy 8080:80 motir-core-staging.flycast -a motir-core-staging
```

_Output — to be captured by the smoke run._ It holds the port open until you stop
it.

**8.2 — readiness through it,** in a second terminal:

```sh
curl -sS http://localhost:8080/api/health/ready
```

**Check:** HTTP 200 with the state `ready` — the path the run command's pin loop
probes (`loadtest/run/pinned.ts` `READY_PATH`).

**From the generator instead** (start it first with
`fly machine start <generator machine id> -a motir-loadgen`, and stop it again
afterwards):

```sh
fly ssh console -a motir-loadgen --machine <generator machine id> -C "sh -c 'curl -sS http://motir-core-staging.flycast/api/health/ready'"
```

The two-machine check (MOTIR-8621, `scripts/staging`) runs from the generator or
over WireGuard the same way.

> ⚠️ **Do not open staging in a browser during a run.** The image is
> production's, and the browser Sentry DSN (`NEXT_PUBLIC_SENTRY_DSN`) is inlined
> at build time (`lib/monitoring/config.ts` `clientSentryDsn`), so a browser on
> staging can send errors to **production's** Sentry project. k6 runs no client
> JavaScript, so a run itself sends none. If you did open it, report anything that
> appears in production's project.

> ⚠️ **Staging's logs are sensitive.** Staging sends no mail, but the `console`
> email provider prints every message — recipient address and body — to stdout
> (`lib/email.ts`), and copied production data can reach a notification. Treat
> `fly logs` and the run's `app-logs.ndjson` as production data.

---

## 9. Checking each side-effect sink

**9.1 — the preflight.** It reads each **started** staging machine's environment
(`fly ssh console … -C printenv`, parsed in memory, never printed) and the app's
secret **names**, and judges every row of
`loadtest/staging/sideEffectSwitches.ts`. Its one flag is `--app <staging app>`,
which must equal `LOADTEST_STAGING_APP`. The run command runs it as step 6.

```sh
pnpm loadtest:preflight --app motir-core-staging
```

_Output — format, not a captured run (`loadtest/preflight/sideEffects.ts`
`formatLine`, one line per row × machine, then the summary):_

```text
PASS    secret-names       read=<ISO time> — <n> names, exactly the template's
PASS    email              machine=<id> image=<digest> read=<ISO time> — 2 keys at their sink state
LIVE    email              machine=<id> image=<digest> read=<ISO time> — EMAIL_PROVIDER is not "console"
UNREAD  email              machine=<id> image=<digest> read=<ISO time> — environment not read (fly ssh exited <code>)
PASS    billing            machine=<id> image=<digest> read=<ISO time> — covered by motir-ai
PASS    required-set       machine=<id> image=<digest> read=<ISO time> — 6 required names present

OK: <n> checks passed
```

**Check:** the last line is `OK: …` and the exit is `0`.

- `LIVE` — a switch is on, or `MISSING` — a required name is absent: exit `2`,
  summary `EXIT 2: <n> live or missing: <row>@<machine>, …`.
- `UNREAD` — a machine or the secret list could not be read: exit `4`, summary
  `EXIT 4: <n> unread: …`. `UNREAD` refuses exactly like `LIVE`.
- The secret names must equal the generated template's set **exactly**: an extra
  secret reads as `LIVE    secret-names … — <NAME> is a secret the template does not set`.

**Exit `2` or `4` is fixed by correcting the staging secret** (`fly secrets
unset … -a motir-core-staging`, or `fly secrets import`), **never by editing the
switch table** — the table is reviewed code. Refusals before any read, exit `2`:
`refused: LOADTEST_STAGING_APP is not set; …`, `refused: --app motir-core is
production; the preflight never reads it.`, `refused: --app <app> is not
LOADTEST_STAGING_APP (<value>).`, and the three fail-closed messages for
`LOADTEST_ALLOWED_DB_HOST`, `LOADTEST_PRODUCTION_DB_HOSTS` and
`LOADTEST_PRODUCTION_SENTRY_PROJECT_ID`.

The by-hand checks below are made **while a run is under load** (or right after,
over the run's own files). Each ends with a record slot that the smoke run fills
on its first run. `<run dir>` is the directory the run printed.

### `email`

The staging logs show the `console` provider and no Resend send.

```sh
grep -c '\[EMAIL\]' <run dir>/app-logs.ndjson
```

**Check:** any count is fine (console sends are the sink working). Then:

```sh
grep -c 'api.resend.com' <run dir>/app-logs.ndjson
```

**Clean:** `0`.

Record: date — · run id — · result —

### `github`

No installation token can be minted; anything that tries throws
`GithubAppNotConfiguredError` (`lib/github/appAuth.ts`).

```sh
grep -c 'GITHUB_APP_NOT_CONFIGURED\|GithubAppNotConfiguredError' <run dir>/app-logs.ndjson
```

**Clean:** `0`, or a count of refusals only — never a GitHub API response. Report
a non-zero count: something on the load path tried to write to GitHub.

Record: date — · run id — · result —

### `sentry`

Search **production's** Sentry project, over the run window from `run.json`'s
`window.startedAt` to `window.endedAt`:

```text
environment:staging
```

**Clean:** nothing in production's project, and the staging project shows the
run's events and traces. (The shipped 24-hour counter,
`lib/monitoring/sentryErrorCount.ts`, sees errors only, not transactions, so it
cannot be this check.)

Record: date — · run id — · result —

### `motir-ai`

No request reaches production's motir-ai; anything that tries throws
`MotirAiConfigError` (`lib/ai/errors.ts`).

```sh
grep -c 'MotirAiConfigError' <run dir>/app-logs.ndjson
```

**Clean:** `0`, or refusals only. Report a non-zero count.

Record: date — · run id — · result —

### `fleet`

The fleet app's machine list is unchanged before and after the run. Run this
once before and once after, and compare:

```sh
fly machine list --json -a <fleet app> | jq -r '.[] | [.id, .state] | @tsv' | sort
```

**Clean:** the two lists are identical. (`<fleet app>` is the fleet app's name,
which MOTIR-8674 records; this read is of its machines only, never its secrets.)

Record: date — · run id — · result —

### `billing`

Covered by the `motir-ai` row (`coveredBy: 'motir-ai'` in the switch table): core's
only billing calls are read-throughs to motir-ai, and its only charge, container
usage, needs a fleet machine. The preflight prints it as
`… billing … — covered by motir-ai`.

```sh
grep -E '^(PASS|LIVE|UNREAD) +billing ' <run dir>/preflight.txt
```

**Clean:** every line is `PASS`, and the `motir-ai` and `fleet` checks above are
clean.

Record: date — · run id — · result —

### `database`

The run's database witness: the in-machine host (with `-pooler` stripped) equals
`LOADTEST_ALLOWED_DB_HOST` and is not in `LOADTEST_PRODUCTION_DB_HOSTS`. The run
command exits `4` otherwise (`staging reads <host>, not the branch's endpoint
<host>`); the host it read is in `run.json`:

```sh
jq '.neon' <run dir>/run.json
```

**Clean:** `endpointHost` equals `LOADTEST_ALLOWED_DB_HOST`, and `branchId` is the
staging branch's.

Record: date — · run id — · result —

### `stored-credentials`

The decryption keys for stored provider tokens are absent on every machine, per
the preflight:

```sh
grep -E ' stored-credentials ' <run dir>/preflight.txt
```

**Clean:** every line is `PASS`.

Record: date — · run id — · result —

### `provider-seams`

The GitLab, Jira, Linear and Plane OAuth secrets, the webhook secrets, the relay
and gateway addresses and the object-storage keys are absent, per the preflight:

```sh
grep -E ' provider-seams ' <run dir>/preflight.txt
```

**Clean:** every line is `PASS`.

Record: date — · run id — · result —

---

## 10. What a run leaves behind

Each run writes `loadtest/.out/runs/<UTC stamp>-<profile>-n<N>/`. **The directory
is gitignored**: it sits beside the manifest and holds the app's logs, which carry
copied production data. Never share it.

| File                                                 | Written by                                             | Feeds                                                              | Access it needs                              |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------- |
| `run.json`                                           | the run command, before any exit                       | the header, the `comparable` block, `INVALID`                      | `fly`, `neonctl`                             |
| `profile.resolved.json`                              | the run command                                        | every threshold limit                                              | —                                            |
| `seed-shape.json`                                    | the run command                                        | the seed step                                                      | —                                            |
| `preflight.txt`                                      | the side-effect preflight                              | section 9                                                          | `fly ssh console`, `fly secrets list`        |
| `summary.json`, `k6.log`, `k6-points.json.gz`        | k6 on the generator, fetched back                      | every k6 line (`k6-points.json.gz`); cross-checks (`summary.json`) | `fly ssh`                                    |
| `generator-cpu.csv`                                  | the generator                                          | generator saturation (`INVALID`)                                   | `fly ssh`                                    |
| `app-logs.ndjson` + `app-logs.gaps.json`             | `fly logs -a <app> --json`, streamed for the whole run | P2028 corroboration; Fly proxy codes `PL01` / `PL02` / `PR01`      | `fly logs`                                   |
| `db-samples.csv`                                     | a read-only sampler on the direct endpoint, every 10 s | the database bottleneck candidate                                  | `neonctl connection-string`, database access |
| `neon-endpoint-start.json`, `neon-endpoint-end.json` | the Neon API                                           | the endpoint's compute state                                       | `LOADTEST_NEON_API_KEY`                      |
| `pgss-before.json`, `pgss-after.json`                | `pg_stat_statements`, top 200 by three rankings        | the top-statements table                                           | `neonctl connection-string`, database access |
| `report.md`, `report.json`                           | `pnpm loadtest:report`                                 | you                                                                | `LOADTEST_FLY_PROM_TOKEN` (Prometheus)       |

About the log capture (`loadtest/capture/appLogs.ts`): `fly logs` with no
`--machine` is unfiltered, so it covers every machine of the app, read through
each line's `instance` field. `--no-tail` returns only Fly's short buffer, so the
capture streams during the run; a reconnect cannot backfill, and the uncovered
interval goes into `app-logs.gaps.json`. The log is corroboration only for P2028 —
nothing in the app writes a P2028 line to stdout today.

**A `<name>.state.json` beside a file means that recording failed.** The run goes
on, and every reading that file feeds says `unmeasured` with the state file's
reason (`loadtest/report/inputs.ts`).

**10.1 — publish a report.** Only `report.md` and `report.json` ever leave the run
directory, and only through:

```sh
pnpm loadtest:report <run dir> --publish
```

_Output — format, not a captured run (`loadtest/report/report.ts`
`runReportCli`):_

```text
verdict: <VERDICT>[ — <reasons>]
report: <run dir>/report.md
published: loadtest/reports/<date>-<profile>-n<N>-<runId8>
```

It copies exactly the two files into `loadtest/reports/<date>-<profile>-n<N>-<runId8>/`
(`<runId8>` is the time part of the run id's UTC stamp, for example `T221500Z`,
so two runs of the same profile and N on one day land in two folders) for a
reviewed commit,
and refuses content shaped like a token, cookie or connection string:
`NOT published — refused to publish: <file> contains a cookie, bearer token or
connection string`. The verdict and exit code are unchanged by a refusal.

**Check:** the `published:` line.

---

## 11. Reading a report

`report.md` reads top to bottom in the order you need it
(`loadtest/report/render.ts`): the verdict, the what-answered header, the
`comparable` block, the threshold lines, P2028, the rate-limit refusals, the
`proxy_shed` reading, the first bottleneck, then the supporting tables.
`report.json` carries the same as fields.

### The header — what answered

`instances` (N read back), `sha` and `shaReadFrom`, `neon` (branch id, endpoint
host, `copiedAt` and `copiedAtField` — the rule of section 4.2), `app` (name,
size, every machine's id, region, size and image), `production` (its size),
`candidateSize`, `instancesHeld`, `pinEnforced`, `profile` (name, path, load
hash), `traceRate`, `concurrency` and `requiredConcurrency`, `rateLimits`,
`offered`, `generator` (machine id, region, cpus, CPU mean and max), `k6`
(version, extensions), `window`, `prometheus` (endpoint, app, queried at),
`pgStatStatements` (host, compute start, `stats_reset`), `baseline`.

**Two reports are comparable** when they have the same profile **load hash**
(sha256 over the load-shaping sections — `name`, `notes` and `thresholds` are
excluded, `loadtest/profiles/schema.ts` `NON_LOAD_SECTIONS`), the same machine
size, the same N or a valid baseline, and stated copied-from times read by the
rule in section 4. The **`comparable`** block holds identifiers and configuration
only — SHA, branch id and copied-from time, app and machine ids, size, N, profile
name and load hash, concurrency limits, rate limits, trace rate, generator
machine id and cpus, k6 version, baseline (`loadtest/report/report.ts`
`comparableOf`). Measured values — generator CPU, latencies, window times — are
outside it by design, so two identical runs give identical `comparable` blocks.

### The four verdicts

From `loadtest/report/report.ts` (`EXIT`, `OPTIONS.exits`):

| Verdict      | Exit | Means                                                                            |
| ------------ | ---- | -------------------------------------------------------------------------------- |
| `PASS`       | `0`  | every judged line passed                                                         |
| `FAIL`       | `1`  | at least one judged line failed                                                  |
| `UNMEASURED` | `3`  | a threshold could not be read, so the run cannot PASS                            |
| `INVALID`    | `6`  | the run did not hold its instances, did not complete, or saturated its generator |
| —            | `2`  | the run directory or its `run.json` is missing                                   |

- **`UNMEASURED` is never a pass.** Its reasons name each line; the common causes
  and fixes:
  - a log gap (`app-logs.gaps.json` overlaps the window) — re-run; check `fly logs`
    access;
  - a missing Prometheus series, or `Prometheus answered <status>` — check the
    token (below) and that the app label is staging's;
  - `stats_reset differs between the snapshots` — something reset
    `pg_stat_statements` mid-run; re-run;
  - `no Prometheus token: LOADTEST_FLY_PROM_TOKEN is unset and \`fly auth token\`
    failed` — set the token;
  - a `<name>.state.json` in the run directory — that recorder failed.
- **`INVALID`** means the generator saturated (its CPU passed the profile's
  `generator` limits), the instance count drifted (`instancesHeld` false), or the
  run command failed (`the run exited <code>: <reason>`).

Re-read a run at any time:

```sh
pnpm loadtest:report <run dir>
```

_Output — format, not a captured run (`loadtest/report/report.ts`):_

```text
verdict: <PASS | FAIL | UNMEASURED | INVALID>[ — <reasons>]
report: <run dir>/report.md
```

### `n/a` versus `unmeasured`

A line that **does not apply at this N** — the scale-out line at N = 1, the
throughput line at N > 1 — reads `n/a` and **does not affect the verdict**. A line
that applies and **could not be taken** reads `unmeasured` with its reason and
**blocks a PASS** (`loadtest/report/thresholds.ts`).

### The threshold lines

Every limit comes from `profile.resolved.json`; none is written in the report
code. Every k6 number covers the **steady window** (after the ramp, before the
ramp-down). Outcomes are bucketed `ok` → served, `empty` → empty, `limited` →
refused, `error` → error.

- **throughput** (`perInstance.targetRps`, N = 1 only) — served + empty requests
  per second, the stream and the run `recycle` step excluded. A closed model: a
  miss can be a slow server or latency lengthening each VU cycle; read it beside
  the latency lines.
- **reads p95 / p99** (`readP95Ms`, `readP99Ms`) — MCP reads, reader routes but
  the stream, and the run `read` step.
- **writes, claims and runs p95 / p99** (`mutateP95Ms`, `mutateP99Ms`) — MCP
  write / claim / burst and run steps but `read` and `recycle`.
- **error rate** (`errorRate`) — errors ÷ (all − refused − stream). `empty` and a
  refused claim are not errors.
- **P2028** (`p2028`) — below.
- **held streams lost** (`streamLost`) — over the whole run.
- **rate-limit refusals** (`rateLimitedMax`) — below.
- **scale-out** (`scaleOut.efficiency`, N > 1) — below.

### The rate-limit line, and the Fly-proxy 503 reading

**Rate-limit refusals are their own line, never folded into errors or success**
(MOTIR-8548): a `limited` outcome is the app's limiter answering as designed, so
counting it as an error would fail a healthy run and counting it as served would
inflate throughput. The line gives the refused share, the count, and the p95 of
`Retry-After`.

Beside it, **`proxy_shed` is a reading, not a threshold** — nothing judges it.
Fly's documentation names no header that marks a proxy-made response and does not
say what a client sees at a concurrency limit, so the reading comes from the
**platform**: the per-instance `fly_app_http_responses_count{status="503"}`
counter (Fly's Prometheus documentation lists it with an `instance` label), beside
the proxy-error codes in the captured app log (`PL01` / `PL02` — concurrency
limit, `PR01` — no healthy machine), beside k6's own `http_503` count. A
client-side 503 count alone is never read as proxy shedding.

### The P2028 line

Read from the platform's `db_tx_wait_seconds_count{outcome=~"p2028_.*"}` counters
over the **whole** run window, ramp included — end value minus start value per
instance, an absent series counting as zero (`loadtest/report/p2028.ts`).

- **Positive control:** each instance's `committed` count must have risen over
  the window. One that did not (unscraped or restarted) is `unmeasured`, never 0;
  an unreadable counter is `unmeasured`, never 0.
- **The app log is corroboration only:** a P2028 line there can turn the line
  FAIL, never PASS, and log silence is not evidence of zero.
- **Blind spot, printed in the line:** `p2028_*` counts only failures **before**
  the transaction body ran (`lib/monitoring/transactionSpan.ts` `failedOutcome`);
  a mid-body expiry is labelled `rolled_back` and shows as an `error` outcome in
  the latency lines instead.

### The scale-out line and the per-instance share

At N > 1: served rps at N ≥ `efficiency` × N × the baseline's served rps
(`loadtest/report/scaleOut.ts`). The baseline is the `--baseline` run's
`report.json`; it is usable when its verdict is PASS, FAIL or UNMEASURED, and
`unmeasured` when its report is missing, INVALID, or ran a different load hash or
machine size.

**Routing is checked before scaling is judged.** Fly's proxy fills toward
`soft_limit` before it spills to another machine, so each instance's share of
requests (from `fly_app_http_responses_count` by instance, else
`db_tx_wait_seconds_count`) must be within ±25 % of 1/N. A share outside that
makes the line `unmeasured` — `routing, not scaling` — never a FAIL.

### The first bottleneck

Five candidates — Fly proxy limit, app CPU, app memory, connection pool, database
(Neon load) — each with the time it saturated (held for the profile's
`bottleneck.holdSeconds`). **The earliest onset wins.** When something failed but
no candidate saturated, the block reads **`unattributed`** and names the worst
route by p95, the highest wait/hold p95 and the top statement by total-time
delta. When nothing failed and nothing saturated, it reads
**`no resource saturated`**. Two caveats are printed with it: the database
candidate reads the direct endpoint only (it cannot see pooler saturation), and
each held stream costs one watermark read per second. The supporting tables
follow: agent mix, per route, wait and hold, top statements.

### The agent mix

**`Agent mix (steady window)`** splits what was served by the class of load the
profile offered it: `read`, `write`, `claim` and `burst` (the MCP `group` tag),
`run` (`role=run`) and `readers` (`role=reader`), with `readers · tab` and
`readers · browse` beneath when k6's `scenario` tag names them. Each row sets the
VUs `profile.resolved.json` offered the class beside its served rps, its share of
all served, its `ok` / `empty` / `error` / `limited` counts and the p95 / p99 of
its `ok` latency (`loadtest/report/mix.ts`). Served is `ok` + `empty`, as the
throughput line counts it; the held stream and the run recycle step are in no
class, so the top-level rows sum to the served rps on the `total` row. A class
with no points reads `unmeasured`, never 0. Read it before any threshold line: it
says whether the served mix matched the offered one, and whether one class
starved while another was fine. `report.json` carries it as `tables.mix`; an
existing run directory gets it by re-running `pnpm loadtest:report <run dir>`.

### Where a FAIL goes

A FAIL goes to [the sizing task](motir:cmv7wtta000bchvsh237q63pp) or
[the baseline run](motir:cmv7wtt0o00b7hvshxi39woy0) — **never to a hand-tuned
threshold**. A PASS on staging says nothing about production's own proxy limit:
staging's limits are raised for the test, and the report says so in its header.

### The Prometheus token

`LOADTEST_FLY_PROM_TOKEN` is a token from `fly auth token`, sent as
`Authorization: FlyV1 <token>` (the default): Fly answers that value `401` as
`Bearer` and `200` as `FlyV1`. Set `LOADTEST_FLY_PROM_TOKEN_SCHEME=Bearer` to send
`Authorization: Bearer <token>` instead (`loadtest/report/prometheus.ts`). The
report never prints the token.

**11.1 — check it answers,** with the header form the report sends by default
(`FlyV1`):

```sh
curl -sS -G -H "Authorization: FlyV1 $LOADTEST_FLY_PROM_TOKEN" "https://api.fly.io/prometheus/moooon/api/v1/query" --data-urlencode 'query=count(fly_app_http_responses_count{app="motir-core-staging"})' | jq -r '.status'
```

_Output — to be captured by the smoke run:_ `success`. **Check:** `success`; a
`401` or `403` body means the wrong token or the wrong header form.

---

## 12. Changing the experiment

**A threshold, weight, ratio or count is changed by editing
`loadtest/profiles/*.json` in a reviewed PR** — never with a flag, and never to
make a red report green. The profile is strict: an unknown field is refused, and
the mix and the role split must each sum to 1 (`loadtest/profiles/schema.ts`).

- **`scaleWithN`** lists the counts multiplied by N when a run is at N instances
  (`clients`, `seed.users`, `seed.workspaces`, `seed.burstAgents`,
  `tenancy.agentWorkspaces`, `burst.agents`), so each instance is offered the
  same load at every N. A field not listed stays fixed.
- **`notes`** is the profile's list of assumptions: every number that is chosen
  rather than measured says so there (`ASSUMPTION — …`, `COMPUTED — …`). Change a
  number, change its note.
- The run command refuses a profile that cannot offer its own target before any
  platform call: seeded agents and users must cover every role's VUs, `targetRps`
  must be reachable from the offered load, and no workspace may be offered more
  than 70 % of the `agent:workspace` ceiling (`loadtest/profiles/resolve.ts`).
- `name`, `notes` and `thresholds` are outside the **load hash**, so changing a
  threshold keeps a baseline usable; any other change makes a new load, and an
  N > 1 run needs a new N = 1 baseline.

### For engineers changing the harness

Changes to `loadtest/` are covered by the unit suites under `tests/loadtest/` and
by the end-to-end lane, which runs the real run command and report against a
local stand-in for staging:

```sh
pnpm test:loadtest-e2e
```

It needs a **local production build** of the app, a **migrated Postgres**, and the
**built k6 binary** at `loadtest/.out/k6`:

```sh
loadtest/k6/build.sh
```

_Output — format, not a captured run (`loadtest/k6/build.sh`):_

```text
building k6 v1.2.1 with github.com/phymbert/xk6-sse@v0.1.12 in grafana/xk6:1.4.14 -> <repo>/loadtest/.out/k6
<k6 version output>
```

**Check:** the version output lists `xk6-sse`; the script exits `1` otherwise. It
uses Docker when a daemon answers, else `go` and `xk6` on `PATH`. The pinned pair,
and the `grafana/xk6` builder image tag, live in `loadtest/k6/versions.env`; do not move
one pin without the other.

When a CLI gains or renames a flag, update this page in the same PR:
`tests/loadtest/readme.test.ts` fails when a documented `pnpm loadtest:*` script
or flag no longer exists, or when a switch-table row has no section-9 subsection,
and `tests/loadtest/storyGate.runToReport.test.ts` fails when an exported flag is
not documented here.
