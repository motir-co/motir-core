# The live code-graph lane

One suite, `retention.live.spec.ts`, walks story MOTIR-12250's verification recipe (steps 1–11)
across a running motir-core, motir-ai and motir-codegraph (card MOTIR-12260). Every step enters the
way production does: a signed GitHub delivery posted to motir-core's real `/api/github/webhook`
route, processed by motir-core's job worker, handed off to motir-ai, enqueued on motir-codegraph
and indexed by its worker.

```bash
pnpm test:live:codegraph
```

It is **on demand**. The default Playwright lane cannot pick it up (its `testDir` is `tests/e2e`),
the default Vitest run cannot either (it matches `*.test.*`), and CI does not run it. It **never
skips**: every input is checked before anything starts, and the suite's config checks its own
inputs again before the first case, so a missing or blank one fails the lane and names itself.

Unlike motir-ai's [code-graph client lane](https://github.com/motir-co/motir-ai/blob/main/docs/codegraph-client-lane.md),
which brings nothing up, **this lane brings the whole stack up itself** and stops what it
started. A run takes about 20 minutes, most of it the two windows.

## Inputs

Every input has a default a run on a developer machine or in a cloud session already holds. Set
one only to change it.

| Variable                  | Default                                                         | What it is                                                                                            |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `LIVE_AI_COMMIT`          | the head of motir-ai's default branch                           | the motir-ai commit the lane runs                                                                     |
| `LIVE_CODEGRAPH_COMMIT`   | the head of motir-codegraph's default branch                    | the motir-codegraph commit the lane runs                                                              |
| `LIVE_AI_DIR`             | unset: clone `LIVE_AI_REPO_URL`                                 | an existing motir-ai checkout; used in place when its clean HEAD is the commit, else a worktree at it |
| `LIVE_CODEGRAPH_DIR`      | unset: clone `LIVE_CODEGRAPH_REPO_URL`                          | the same, for motir-codegraph                                                                         |
| `LIVE_AI_REPO_URL`        | `https://github.com/motir-co/motir-ai.git`                      | where motir-ai is cloned from (read access needed)                                                    |
| `LIVE_CODEGRAPH_REPO_URL` | `https://github.com/motir-co/motir-codegraph.git`               | where motir-codegraph is cloned from (read access needed)                                             |
| `LIVE_PG_BIN`             | `pg_config --bindir`, else `/usr/lib/postgresql/{18,17,16}/bin` | a Postgres 16+ server's binaries (`initdb`, `pg_ctl`, `psql`)                                         |
| `LIVE_PG_OS_USER`         | `postgres` when run as root, else the caller                    | the OS user Postgres runs as (it refuses root)                                                        |
| `LIVE_WORK_DIR`           | a fresh directory under the system temp dir                     | the cluster, checkouts, certificate, scratch repository file and every log (`<dir>/logs/`)            |
| `LIVE_GREP`               | unset: every case                                               | passed to Playwright's `--grep` (the cases are serial, so a later case needs the earlier ones)        |
| `LIVE_KEEP_STACK`         | unset                                                           | `1` leaves the stack running after the suite, for a look at its logs and databases                    |

`git`, `pnpm` and `openssl` must be on `PATH`. Everything else — ports, tokens, secrets, the TLS
certificate — the lane makes for the run.

The suite itself reads what the lane hands it (`playwright.config.ts` lists them): the three
service addresses (`LIVE_CORE_URL`, `LIVE_CODEGRAPH_URL`), the three databases
(`LIVE_CORE_DATABASE_URL`, `LIVE_AI_DATABASE_URL`, `LIVE_CODEGRAPH_DATABASE_URL`), the
suite's own read client on motir-codegraph (`LIVE_CODEGRAPH_READ_TOKEN`,
`LIVE_CODEGRAPH_READ_CLIENT_ID`) and the operator token it grants that client with
(`LIVE_CODEGRAPH_OPERATOR_TOKEN`), the codegraph worker's log
(`LIVE_CODEGRAPH_WORKER_LOG`), the scratch repository file (`LIVE_SCENARIO`), the GitHub journal
(`LIVE_GITHUB_LOG`), the archive host (`LIVE_ARCHIVE_ORIGIN`), the windows, and the commits.

## How each service is brought up

`lane.mjs`, in order. Every child gets a **sanitized environment**: `PATH`, `HOME` and the locale,
plus what the lane sets. No credential of the calling shell reaches a service, and `next dev` does
not see an agent's markers (it rewrites `CLAUDE.md` when it does).

1. **Postgres** — `initdb` a throwaway cluster on a free port, with one database each for
   motir-core and motir-ai; motir-codegraph's bootstrap makes its own.
2. **motir-codegraph**, from its README: `pnpm db:bootstrap`, `pnpm db:migrate`,
   `pnpm operator:bootstrap` (with an `OPERATOR_TOKEN` the lane generates), then `serve` and
   `worker`. The worker carries the windows, because the sweep runs there:
   `DEFAULT_BRANCH_RETENTION_WINDOW_MS=120000`, `REF_RETENTION_WINDOW_MS=600000`,
   `RETENTION_SWEEP_INTERVAL_MS=30000`. It trusts the lane's certificate (`NODE_EXTRA_CA_CERTS`)
   and may fetch from `127.0.0.1` (`FETCH_ALLOWED_HOSTS`).
3. **The suite's read client** — `live-suite-reader`, made with `POST /v1/operator/clients` and
   `POST /v1/operator/clients/<id>/credentials`. The suite grants it the tenant motir-ai registers
   (`POST /v1/operator/grants`) before its first read. motir-ai's own credentials are never made
   here (step 5).
4. **The archive host** (`archiveHost.mjs`) — HTTPS on `127.0.0.1` with a certificate the lane
   mints with `openssl`, serving each commit of the scratch repository as GitHub's archive does
   (one top-level directory, gzipped tar). motir-codegraph's worker downloads from it.
5. **motir-ai** — `prisma generate`, `prisma migrate deploy`, then its server, whose job worker
   runs in the same process, started through motir-ai's `scripts/serve-with-local-codegraph.ts`.
   The lane hands that script the service only (`LOCAL_CODEGRAPH_ORIGIN`,
   `LOCAL_CODEGRAPH_BOOTSTRAP_TOKEN`); it mints motir-ai's operator and read client itself, as
   motir-ai's
   [lane doc](https://github.com/motir-co/motir-ai/blob/main/docs/codegraph-client-lane.md#bringing-the-service-up)
   describes, and drops the bootstrap token before serving. motir-core never holds motir-ai's
   code-graph credential (the MOTIR-11649 guard).
6. **motir-core** — `scripts/migrate-deploy.mjs`, `pnpm build:worker`, `next dev`, then the job
   worker bundle with the GitHub preload:
   `node --import tests/live/codegraph/githubFake.preload.mjs .worker/worker.mjs`. Both have
   `MOTIR_AI_URL` set to the local motir-ai.
7. **The suite** — `playwright test -c tests/live/codegraph/playwright.config.ts`.

## The boundaries

| Boundary                                                                       | Seam                                                                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| motir-core → motir-ai                                                          | real, `MOTIR_AI_URL`                                                                                                              |
| motir-ai → motir-codegraph                                                     | real, the settings motir-ai's `serve-with-local-codegraph` script mints                                                           |
| background work                                                                | three real worker processes: motir-core's job worker, motir-ai's (in its server), motir-codegraph's                               |
| GitHub: installation token, pull-request head, changed paths, archive redirect | `githubFake.preload.mjs` in motir-core's job worker, answering `api.github.com` from the scratch repository file (`scenario.mjs`) |
| GitHub: the source archive                                                     | `archiveHost.mjs`, fetched by motir-codegraph's worker                                                                            |
| a fork's pull request                                                          | a delivery whose head repository id differs from the base's; the skip happens before anything is fetched                          |

Nothing is stubbed in the test runner's process: it posts deliveries, writes the scratch
repository file, and reads.

## Waits

Every step asserts what its delivery did before the next is posted: the inbox row
(`postSignedWebhook`), each motir-core job the delivery must enqueue reaching `succeeded`, and a
published current layer in motir-codegraph's database. After a window, the suite waits for a
`retention sweep pass` line the codegraph worker logged whose `startedAt` is past the window. There
is no fixed sleep.

A green run proves the three services agree with each other at the commits it names. It proves
nothing about a deployed environment.
