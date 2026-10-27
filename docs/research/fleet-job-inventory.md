# Fleet job inventory — Motir's own CI against the fleet runner image

**Story:** MOTIR-8699 · **Card:** MOTIR-8701 · **Measured:** 2026-10-15
**Manifest:** [`lib/ciFleet/fleetJobInventory.json`](../../lib/ciFleet/fleetJobInventory.json)
(read by the readiness verdict, MOTIR-8713; flipped tool by tool by the image card, MOTIR-8710)

**Re-measured 2026-10-16 (MOTIR-8813):** motir-ai, motir-gateway and motir-meta at
their `main` heads, after the seam pull requests (motir-ai#760, motir-gateway#105,
motir-meta#624) changed only `runs-on:` lines. No job, workflow or verdict changed.
Each job's `runsOn` now reads the seam expression, except motir-gateway's
`macos-release` and `windows-release`, which stay GitHub-hosted on purpose. The
readiness verdict counts only jobs whose `runsOn` can resolve to the fleet, so
those two no longer hold the switch off. The one fleet-bound gap left in the
private set is motir-gateway `docker-image.yml · push_to_registries`
(`binfmt-misc`).

**Re-measured again (MOTIR-8815):** motir-gateway after it deleted one-api's four
tag-triggered release workflows (`docker-image.yml`, `macos-release.yml`,
`windows-release.yml`, `linux-release.yml`). None had ever run; the gateway ships
through `fly-deploy.yml`. Their jobs leave the manifest, and every fleet-bound job
in project MOTIR's private repositories is now `runnable`.
motir-meta is re-measured in the same pass at `c569dd54a`: #632 added one script to
`guards.yml`'s matrix arguments, with no job, runner or tool change.

**Staleness check (MOTIR-8870):** a newer workflow commit used to make a repository's
entry stale on its own, so motir-ai#768 and #776 each blocked the switch until the
entry was re-measured by hand, though neither added a job, runner or tool. Each
private repository's entry now records `structureFingerprint`, the digest of the
inputs the verdicts depend on (`lib/ciFleet/workflowFingerprint.ts`: every job's
`runs-on` and reusable call, plus the repository-wide sets of actions, `run:`
executables and shells). Readiness recomputes it at the new head and calls the entry
stale only if it differs. Any read that fails, or an entry with no fingerprint,
stays stale. To record it after a re-measure:
`pnpm exec tsx scripts/ci-fleet/fingerprint-workflows.ts <checkout> <sha>`.

**Quote-aware fingerprint (MOTIR-9126):** the first tokenizer split `run:` lines on
`|`, `;`, `(` and `)` even inside quotes, so motir-ai#778's quoted jq filter in
`sweep-planning-machines.yml` read as six new executables (`now`, `sub`,
`fromdateiso8601?`, …) and made the entry stale with no tool added. Separators now
count only outside quotes, words split only outside quotes, and a step whose
`shell:` is not bash or sh (motir-meta's two `python3 {0}` steps) contributes its
interpreter but not its lines. Every recorded fingerprint was recomputed at its
entry's sha. motir-ai is re-measured at `857ac4244`: the workflow set, the job set and
every `runsOn` are unchanged since `35d359a22`, and the fingerprint is identical at
both.

**Re-keyed after the org rename (MOTIR-9410, 2026-10-24):** GitHub renamed the
`moooon-B-V` org to `motir-co`, so every `repoRef` now names `motir-co/<name>`. The
readiness check also matches an entry by repository NAME within the org it reads
(an exact `owner/name` key still wins), so the next rename cannot make every
repository read as not inventoried. motir-ai (`30508ba10`), motir-gateway
(`24a54f497`), motir-meta (`ba13df74d`) and motir-skills (`ceff4048e`) are
re-measured at their `main` heads: `fingerprint-workflows.ts` gives the same digest
at the head as at the recorded sha, so no job, runner or tool changed.
nextjs-prisma-vercel-starter's head is the recorded sha. motir-core and
motir-marketing keep their 2026-10-15 shas: their workflows changed in structure
since then, they are public, and the readiness check never reads them, so moving
the sha without re-inventorying their jobs would record a measurement nobody made.

**motir-infra added (2026-10-27):** project MOTIR's new private repository, measured
at `b5221db3f` (motir-infra#1's head; its `main` has no workflow yet, so the
readiness check reads no newer workflow commit until that pull request merges, and
the merge carries the same fingerprint). Four jobs, all `runnable` on the image:
`pr.yml · checks` and `diff`, `main.yml · checks` and `deploy`. Each runs on the
seam expression and needs only checkout, pnpm's setup action, setup-node at Node 22
(`.nvmrc`), bash, and curl for the `actionlint` download in the shared `checks`
action; `diff` and `deploy` add `aws-actions/configure-aws-credentials` and
`actions/github-script`, which are JavaScript actions.

**Image under test:** `infra/ci-runner/Dockerfile` on `motir-core` `main` at
`4064243068` (last commit touching the file, 2026-10-12). Every "absent from the
image" below is read from that file: it installs Ubuntu 24.04 (by digest), the
Actions runner, Node 22.23.2 into the toolcache, static Docker 29.7.1 (no CLI
plugins), Playwright 1.62.1's chromium system libraries, and the apt set
`bash ca-certificates coreutils curl git gnupg gzip iptables jq locales
openssh-client sudo tar unzip uidmap xz-utils zip zstd` (Dockerfile lines
145–165), plus whatever `installdependencies.sh` and `playwright install-deps`
pull in (lines 231, 254).

## The answer

**132 jobs across the seven repositories. 111 can run on a `motir-runner` from
the current image, 19 need something the image lacks, and 2 can never run on the
fleet.** The image needs four additions, not a rebuild. Two other facts matter
more than any tool gap:

1. **`motir-core` and `motir-marketing` are PUBLIC repositories** (and so are
   `motir-skills` and `nextjs-prisma-vercel-starter`). The connected-org
   runner-group sync (MOTIR-8712) access-lists **private repositories only**,
   because a fork's pull request on a public repository can run arbitrary code
   on a self-hosted runner. So under the story's own rule, only **motir-ai,
   motir-gateway and motir-meta** (43 jobs) can move onto the fleet. The
   motir-core and motir-marketing seam cards (MOTIR-8704, MOTIR-8708) would add
   a `runs-on` that never resolves to the fleet. **This is a decision to make,
   not a downgrade I made:** either the story's "Motir's own private
   repositories" scope is the two-thirds it says, or public repositories need a
   different admission rule (for example, fleet runners for `push`/`merge_group`
   only, never `pull_request` from forks).
2. **Two motir-gateway jobs are `cannot-host`** (macOS and Windows release
   builds). They only run on a release tag, and they can stay on GitHub-hosted
   runners without blocking anything else. They still count as unmet in the
   readiness verdict until somebody decides that.

## Method

For each repository, `git fetch origin` and then, at `origin/main`:

```sh
git -C <repo> rev-parse origin/main
git -C <repo> ls-tree -r --name-only origin/main .github/workflows/
git -C <repo> ls-tree -r --name-only origin/main .github/actions/
gh api repos/moooon-B-V/<repo> --jq '.visibility, .archived'
```

Every workflow file was read with `git show origin/main:<path>` and parsed with
PyYAML's composer (a YAML parse, not a regex), so every job carries the line its
key sits on. For each job the run collected its `runs-on`, triggers, `services:`,
`container:`, every `uses:` (composite actions in `.github/actions/` and
reusable workflows expanded into the calling job) and every `run:` body. A
command-word pass over every `run:` body and composite action listed every
executable invoked, which was then checked against the Dockerfile.

A reusable-workflow caller (`jobs.<id>.uses: ./.github/workflows/x.yml`) is its
own entry in the manifest, at its own line, and inherits the worst verdict of
the jobs it calls. The called workflow's jobs are listed under that workflow's
own file. So every job key in every file appears exactly once.

| Repository                                   | `ls-tree` workflow files | Jobs (manifest) |
| -------------------------------------------- | ------------------------ | --------------- |
| `motir-core` @ `2bc338a9f`                   | 20                       | 70              |
| `motir-ai` @ `38bfab2a4`                     | 7                        | 26              |
| `motir-gateway` @ `996e4282e`                | 8                        | 13              |
| `motir-meta` @ `a7fd87b6d`                   | 1                        | 4               |
| `motir-marketing` @ `06c0411e3`              | 2                        | 9               |
| `motir-skills` @ `08d08eb15`                 | 1                        | 2               |
| `nextjs-prisma-vercel-starter` @ `2856141b9` | 3                        | 8               |

**What this run could not do:** `docker run` the published image. This session
has a Docker client but no daemon (`docker info` → _failed to connect to the
docker API at unix:///var/run/docker.sock_). Every absence is therefore read
from the Dockerfile. Where a tool could arrive transitively (python3 through an
apt dependency), the verdict stays conservative and the image card confirms it
with `command -v` on a built image before flipping it.

## Summary

| Repository                                | Visibility | SHA         | Workflow files | Jobs | runnable | needs-image | cannot-host |
| ----------------------------------------- | ---------- | ----------- | -------------- | ---- | -------- | ----------- | ----------- |
| `moooon-B-V/motir-core`                   | public     | `2bc338a9f` | 20             | 70   | 62       | 8           | 0           |
| `moooon-B-V/motir-ai`                     | private    | `38bfab2a4` | 7              | 26   | 24       | 2           | 0           |
| `moooon-B-V/motir-gateway`                | private    | `996e4282e` | 8              | 13   | 4        | 7           | 2           |
| `moooon-B-V/motir-meta`                   | private    | `a7fd87b6d` | 1              | 4    | 2        | 2           | 0           |
| `moooon-B-V/motir-marketing`              | public     | `06c0411e3` | 2              | 9    | 9        | 0           | 0           |
| `moooon-B-V/motir-skills`                 | public     | `08d08eb15` | 1              | 2    | 2        | 0           | 0           |
| `moooon-B-V/nextjs-prisma-vercel-starter` | public     | `2856141b9` | 3              | 8    | 8        | 0           | 0           |

No job states a hardware demand above the fleet machine's 2 vCPU / 8 GB
(`ci-runner-fleet.md` §8): no workflow sets `NODE_OPTIONS=--max-old-space-size`,
and no `runs-on` asks for a larger label. The fan-out is wide rather than deep:
motir-core's `e2e` matrix (8 `bulk-N` shards, `ci.yml:1632–1653`), the
acceptance lane's dynamic `shard` matrix (`acceptance-tests.yml:621`) and
motir-ai's 3-shard `test` (`ci.yml:205`). Each shard is one job and one machine,
so fan-out costs fleet slots and credits, not machine size.

## Missing tools, and the jobs that need each

| Slug          | Jobs | Why it is absent                                                                                                                                                                                                                                                                        | Recommendation                                                                                                                                                                                                                                               |
| ------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gh`          | 8    | Not in the Dockerfile's apt set (lines 145–165), and Ubuntu does not ship it. `ubuntu-latest` preinstalls it.                                                                                                                                                                           | **Bake it in** from GitHub's apt repository (`cli.github.com/packages`), pinned. 8 jobs across three repositories call it directly, and none installs it.                                                                                                    |
| `gcc`         | 4    | No compiler is installed (no `build-essential` in lines 145–165). motir-gateway depends on `github.com/mattn/go-sqlite3` (`go.mod:86`), which needs cgo. Without a C compiler, Go builds with `CGO_ENABLED=0` and the sqlite driver fails at runtime, so tests that open sqlite go red. | **Bake in `build-essential`**. It is what `ubuntu-latest` has, and `linux-release` also links statically with `-extldflags '-static'`.                                                                                                                       |
| `binfmt-misc` | 6    | Not an image tool. `docker/setup-qemu-action` runs `tonistiigi/binfmt` privileged to register QEMU handlers in the **host kernel**, which on the fleet is the Fly machine's kernel. The Dockerfile cannot settle whether that kernel exposes a writable `binfmt_misc`.                  | **Verify on a live fleet machine** (`docker run --privileged --rm tonistiigi/binfmt --install arm64` and check `/proc/sys/fs/binfmt_misc/`). If it fails, the multi-arch image builds stay GitHub-hosted.                                                    |
| `python3`     | 2    | No python in the apt set. The base `ubuntu:24.04` has none. Two motir-meta jobs run `shell: python3 {0}` with no `actions/setup-python` step before it.                                                                                                                                 | **Rely on the job**: add `actions/setup-python` to those two jobs (the other two motir-meta jobs already do, at `guards.yml:154,185`). The alternative is to bake `python3-minimal` (about 25 MB). Either is fine; the job-side fix keeps the image smaller. |

**`gh`**

- `motir-core` · `acceptance-tests.yml` · `membership` (`.github/workflows/acceptance-tests.yml:439`)
- `motir-core` · `release-sandbox.yml` · `readme` (`.github/workflows/release-sandbox.yml:280`)
- `motir-core` · `release.yml` · `release` (`.github/workflows/release.yml:164`)
- `motir-ai` · `rate-drift.yml` · `guard-on-live-artifact` (`.github/workflows/rate-drift.yml:240`)
- `motir-ai` · `rate-sync.yml` · `sync` (`.github/workflows/rate-sync.yml:113`)
- `motir-gateway` · `catalog-refresh.yml` · `refresh` (`.github/workflows/catalog-refresh.yml:232`)
- `motir-gateway` · `catalog-refresh.yml` · `failure_issue` (`.github/workflows/catalog-refresh.yml:546`)
- `motir-gateway` · `rate-drift-dispatch.yml` · `dispatch` (`.github/workflows/rate-drift-dispatch.yml:73`)

**`gcc`**

- `motir-gateway` · `catalog-refresh.yml` · `refresh` (`.github/workflows/catalog-refresh.yml:232`)
- `motir-gateway` · `ci.yml` · `unit_tests` (`.github/workflows/ci.yml:61`)
- `motir-gateway` · `ci.yml` · `opencode_e2e` (`.github/workflows/ci.yml:127`)
- `motir-gateway` · `linux-release.yml` · `release` (`.github/workflows/linux-release.yml:48`)

**`binfmt-misc`**

- `motir-core` · `ci.yml` · `sandbox` (`.github/workflows/ci.yml:1996`)
- `motir-core` · `image-cache-main.yml` · `sandbox` (`.github/workflows/image-cache-main.yml:184`)
- `motir-core` · `release-sandbox.yml` · `images` (`.github/workflows/release-sandbox.yml:86`)
- `motir-core` · `sandbox-images.yml` · `sandbox-smoke` (`.github/workflows/sandbox-images.yml:76`)
- `motir-core` · `sandbox-images.yml` · `sandbox-profiles` (`.github/workflows/sandbox-images.yml:280`)
- `motir-gateway` · `docker-image.yml` · `push_to_registries` (`.github/workflows/docker-image.yml:35`)

**`python3`**

- `motir-meta` · `guards.yml` · `discover` (`.github/workflows/guards.yml:35`)
- `motir-meta` · `guards.yml` · `complete` (`.github/workflows/guards.yml:223`)

## `cannot-host` jobs

| Repository      | Job                               | Reason                                                            | Evidence                                   |
| --------------- | --------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `motir-gateway` | `macos-release.yml` · `release`   | `runs-on: macos-latest`. The fleet boots Linux x64 machines only. | `.github/workflows/macos-release.yml:18`   |
| `motir-gateway` | `windows-release.yml` · `release` | `runs-on: windows-latest`. Same reason.                           | `.github/workflows/windows-release.yml:18` |

**Decision to make:** both run only on a release tag push. Leaving them on
GitHub-hosted runners (no seam) is the obvious answer. The readiness verdict
must be told so explicitly; otherwise they read as unmet forever.

## Things that look like gaps and are not

- **`docker buildx` / `docker build-push-action`.** The static Docker tarball
  ships no CLI plugins, but every job that builds an image runs
  `docker/setup-buildx-action` first (directly, or through motir-core's
  `.github/actions/buildx`). That action downloads buildx into
  `~/.docker/cli-plugins` as the runner user and works on a self-hosted
  runner.
- **`docker compose`.** No job invokes it. motir-core's Postgres comes from
  `.github/actions/postgres` (`docker pull` plus `docker run`), and the other
  repositories use `services:`. Both need only `dockerd`, which the image
  runs.
- **`psql` / `pg_isready`.** Used only inside the Postgres container, in
  `--health-cmd` (`.github/actions/postgres/action.yml:136`), never on the
  host.
- **Playwright browsers and fonts.** Every e2e and acceptance job runs
  `playwright install --with-deps chromium` and, for the acceptance lane,
  `sudo apt-get install fontconfig fonts-noto-cjk`
  (`acceptance-tests.yml:705–706`). Both work with the image's passwordless
  sudo.
- **`pkill`** (`procps`, absent) appears only in the e2e setup's apt-lock
  recovery (`.github/actions/e2e-setup/action.yml:272–273`) as
  `sudo pkill … || true`. A missing `pkill` is swallowed. Recovery would then
  be weaker, but the job does not go red. The image card may add `procps`
  anyway.
- **`flyctl`.** Every deploy job installs it with
  `superfly/flyctl-actions/setup-flyctl`. motir-core's `deploy` runs
  `flyctl deploy --local-only` (`ci.yml:2193`), which builds through the Docker
  Engine API of the in-machine `dockerd` and needs no buildx plugin.
- **`actions/setup-python` 3.9 / 3.12, `actions/setup-go`,
  `github/codeql-action`.** Each downloads into the toolcache, which the
  image's `runner` user owns. actions/python-versions publishes `ubuntu-24.04`
  builds for 3.9.25 and 3.12.15 (`versions-manifest.json`, read 2026-10-15).

## Not reached

None. Every job in all seven repositories carries a verdict, so the timebox
fallback (`missing: ["unverified"]`) was not needed.

## Per-job verdicts

### `moooon-B-V/motir-core`

| Workflow                     | Job                       | runs-on             | Verdict     | Missing     | Evidence                                          |
| ---------------------------- | ------------------------- | ------------------- | ----------- | ----------- | ------------------------------------------------- |
| `acceptance-tests.yml`       | `membership`              | `ubuntu-latest`     | needs-image | gh          | `.github/workflows/acceptance-tests.yml:439`      |
| `acceptance-tests.yml`       | `build`                   | `ubuntu-latest`     | runnable    | —           | `.github/workflows/acceptance-tests.yml:521`      |
| `acceptance-tests.yml`       | `acceptance`              | `ubuntu-latest`     | runnable    | —           | `.github/workflows/acceptance-tests.yml:589`      |
| `acceptance-tests.yml`       | `acceptance-complete`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/acceptance-tests.yml:857`      |
| `backfill-boards.yml`        | `backfill`                | `ubuntu-latest`     | runnable    | —           | `.github/workflows/backfill-boards.yml:32`        |
| `backfill-ci-state.yml`      | `backfill`                | `ubuntu-latest`     | runnable    | —           | `.github/workflows/backfill-ci-state.yml:51`      |
| `backfill-fix-reason.yml`    | `backfill`                | `ubuntu-latest`     | runnable    | —           | `.github/workflows/backfill-fix-reason.yml:41`    |
| `ci.yml`                     | `changes`                 | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:326`                    |
| `ci.yml`                     | `lint`                    | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:570`                    |
| `ci.yml`                     | `structural-guards`       | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:615`                    |
| `ci.yml`                     | `typecheck`               | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:636`                    |
| `ci.yml`                     | `design-system`           | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:793`                    |
| `ci.yml`                     | `cli`                     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:828`                    |
| `ci.yml`                     | `orchestrator`            | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:863`                    |
| `ci.yml`                     | `pages`                   | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:908`                    |
| `ci.yml`                     | `design-guards`           | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:970`                    |
| `ci.yml`                     | `docs-guards`             | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:1057`                   |
| `ci.yml`                     | `build`                   | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:1085`                   |
| `ci.yml`                     | `test`                    | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:1278`                   |
| `ci.yml`                     | `coverage`                | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:1457`                   |
| `ci.yml`                     | `e2e`                     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:1585`                   |
| `ci.yml`                     | `e2e-at-scale`            | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:1818`                   |
| `ci.yml`                     | `sandbox`                 | `["ubuntu-latest"]` | needs-image | binfmt-misc | `.github/workflows/ci.yml:1996`                   |
| `ci.yml`                     | `runner-image`            | `["ubuntu-latest"]` | runnable    | —           | `.github/workflows/ci.yml:2025`                   |
| `ci.yml`                     | `deploy`                  | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2087`                   |
| `ci.yml`                     | `story-4753-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2382`                   |
| `ci.yml`                     | `story-4905-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2436`                   |
| `ci.yml`                     | `story-6617-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2485`                   |
| `ci.yml`                     | `story-7858-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2535`                   |
| `ci.yml`                     | `story-8136-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2583`                   |
| `ci.yml`                     | `story-683-coverage`      | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2632`                   |
| `ci.yml`                     | `story-6860-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2681`                   |
| `ci.yml`                     | `story-727-coverage`      | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2726`                   |
| `ci.yml`                     | `story-7630-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2773`                   |
| `ci.yml`                     | `story-7631-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2819`                   |
| `ci.yml`                     | `story-7820-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2864`                   |
| `ci.yml`                     | `story-8060-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2910`                   |
| `ci.yml`                     | `story-7974-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:2957`                   |
| `ci.yml`                     | `story-7883-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3005`                   |
| `ci.yml`                     | `story-7928-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3052`                   |
| `ci.yml`                     | `story-7602-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3098`                   |
| `ci.yml`                     | `story-7797-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3153`                   |
| `ci.yml`                     | `story-7990-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3206`                   |
| `ci.yml`                     | `story-1626-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3254`                   |
| `ci.yml`                     | `story-5752-coverage`     | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3308`                   |
| `ci.yml`                     | `ci-complete`             | `ubuntu-latest`     | runnable    | —           | `.github/workflows/ci.yml:3406`                   |
| `codeql.yml`                 | `analyze`                 | `ubuntu-latest`     | runnable    | —           | `.github/workflows/codeql.yml:31`                 |
| `converge-ejected-cards.yml` | `converge`                | `ubuntu-latest`     | runnable    | —           | `.github/workflows/converge-ejected-cards.yml:46` |
| `deploy-freshness.yml`       | `freshness`               | `ubuntu-latest`     | runnable    | —           | `.github/workflows/deploy-freshness.yml:100`      |
| `hosted-agent-image.yml`     | `hosted-agent-image`      | `ubuntu-latest`     | runnable    | —           | `.github/workflows/hosted-agent-image.yml:72`     |
| `image-cache-main.yml`       | `sandbox`                 | `["ubuntu-latest"]` | needs-image | binfmt-misc | `.github/workflows/image-cache-main.yml:184`      |
| `image-cache-main.yml`       | `runner-image`            | `["ubuntu-latest"]` | runnable    | —           | `.github/workflows/image-cache-main.yml:192`      |
| `main-ci-retry.yml`          | `retry`                   | `ubuntu-latest`     | runnable    | —           | `.github/workflows/main-ci-retry.yml:79`          |
| `release-brand.yml`          | `release`                 | `ubuntu-latest`     | runnable    | —           | `.github/workflows/release-brand.yml:63`          |
| `release-cli.yml`            | `release`                 | `ubuntu-latest`     | runnable    | —           | `.github/workflows/release-cli.yml:73`            |
| `release-design-system.yml`  | `release`                 | `ubuntu-latest`     | runnable    | —           | `.github/workflows/release-design-system.yml:52`  |
| `release-runner-image.yml`   | `version`                 | `ubuntu-latest`     | runnable    | —           | `.github/workflows/release-runner-image.yml:50`   |
| `release-runner-image.yml`   | `release`                 | `["ubuntu-latest"]` | runnable    | —           | `.github/workflows/release-runner-image.yml:72`   |
| `release-sandbox.yml`        | `guard`                   | `ubuntu-latest`     | runnable    | —           | `.github/workflows/release-sandbox.yml:64`        |
| `release-sandbox.yml`        | `images`                  | `["ubuntu-latest"]` | needs-image | binfmt-misc | `.github/workflows/release-sandbox.yml:86`        |
| `release-sandbox.yml`        | `readme`                  | `ubuntu-latest`     | needs-image | gh          | `.github/workflows/release-sandbox.yml:280`       |
| `release.yml`                | `release`                 | `ubuntu-latest`     | needs-image | gh          | `.github/workflows/release.yml:164`               |
| `runner-image.yml`           | `runner-image`            | `ubuntu-latest`     | runnable    | —           | `.github/workflows/runner-image.yml:57`           |
| `sandbox-images.yml`         | `sandbox-smoke`           | `ubuntu-latest`     | needs-image | binfmt-misc | `.github/workflows/sandbox-images.yml:76`         |
| `sandbox-images.yml`         | `sandbox-profiles-matrix` | `ubuntu-latest`     | runnable    | —           | `.github/workflows/sandbox-images.yml:231`        |
| `sandbox-images.yml`         | `sandbox-profiles`        | `ubuntu-latest`     | needs-image | binfmt-misc | `.github/workflows/sandbox-images.yml:280`        |
| `sandbox-images.yml`         | `sandbox-published`       | `ubuntu-latest`     | runnable    | —           | `.github/workflows/sandbox-images.yml:408`        |
| `sandbox-images.yml`         | `sandbox-public`          | `ubuntu-latest`     | runnable    | —           | `.github/workflows/sandbox-images.yml:479`        |
| `sandbox-images.yml`         | `sandbox-commands`        | `ubuntu-latest`     | runnable    | —           | `.github/workflows/sandbox-images.yml:544`        |
| `sandbox-staleness.yml`      | `staleness`               | `ubuntu-latest`     | runnable    | —           | `.github/workflows/sandbox-staleness.yml:55`      |

### `moooon-B-V/motir-ai`

| Workflow                      | Job                      | runs-on             | Verdict     | Missing | Evidence                                           |
| ----------------------------- | ------------------------ | ------------------- | ----------- | ------- | -------------------------------------------------- |
| `ci.yml`                      | `lint`                   | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:109`                     |
| `ci.yml`                      | `build`                  | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:123`                     |
| `ci.yml`                      | `typecheck-ratchet`      | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:161`                     |
| `ci.yml`                      | `smoke`                  | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:175`                     |
| `ci.yml`                      | `test`                   | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:198`                     |
| `ci.yml`                      | `coverage-a`             | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:287`                     |
| `ci.yml`                      | `coverage-b`             | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:346`                     |
| `ci.yml`                      | `coverage-c`             | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:418`                     |
| `ci.yml`                      | `coverage-db-a`          | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:481`                     |
| `ci.yml`                      | `coverage-db-b`          | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:537`                     |
| `ci.yml`                      | `coverage-db-c`          | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:604`                     |
| `ci.yml`                      | `coverage-db-d`          | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:673`                     |
| `ci.yml`                      | `indexer-image`          | `["ubuntu-latest"]` | runnable    | —       | `.github/workflows/ci.yml:741`                     |
| `ci.yml`                      | `deploy`                 | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:753`                     |
| `ci.yml`                      | `deploy-codegraph`       | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:848`                     |
| `ci.yml`                      | `ci-complete`            | `ubuntu-latest`     | runnable    | —       | `.github/workflows/ci.yml:928`                     |
| `heal-indexer-mirror.yml`     | `heal`                   | `ubuntu-latest`     | runnable    | —       | `.github/workflows/heal-indexer-mirror.yml:69`     |
| `indexer-image.yml`           | `indexer-image`          | `ubuntu-latest`     | runnable    | —       | `.github/workflows/indexer-image.yml:69`           |
| `rate-drift.yml`              | `gate`                   | `ubuntu-latest`     | runnable    | —       | `.github/workflows/rate-drift.yml:118`             |
| `rate-drift.yml`              | `guard-on-live-artifact` | `ubuntu-latest`     | needs-image | gh      | `.github/workflows/rate-drift.yml:240`             |
| `rate-drift.yml`              | `guard-on-fixture`       | `ubuntu-latest`     | runnable    | —       | `.github/workflows/rate-drift.yml:294`             |
| `rate-drift.yml`              | `coverage`               | `ubuntu-latest`     | runnable    | —       | `.github/workflows/rate-drift.yml:347`             |
| `rate-sync.yml`               | `sync`                   | `ubuntu-latest`     | needs-image | gh      | `.github/workflows/rate-sync.yml:113`              |
| `release-indexer-image.yml`   | `version`                | `ubuntu-latest`     | runnable    | —       | `.github/workflows/release-indexer-image.yml:66`   |
| `release-indexer-image.yml`   | `release`                | `["ubuntu-latest"]` | runnable    | —       | `.github/workflows/release-indexer-image.yml:84`   |
| `sweep-planning-machines.yml` | `sweep`                  | `ubuntu-latest`     | runnable    | —       | `.github/workflows/sweep-planning-machines.yml:33` |

### `moooon-B-V/motir-gateway`

| Workflow                  | Job                     | runs-on          | Verdict     | Missing     | Evidence                                       |
| ------------------------- | ----------------------- | ---------------- | ----------- | ----------- | ---------------------------------------------- |
| `catalog-refresh.yml`     | `refresh`               | `ubuntu-latest`  | needs-image | gcc, gh     | `.github/workflows/catalog-refresh.yml:232`    |
| `catalog-refresh.yml`     | `failure_issue`         | `ubuntu-latest`  | needs-image | gh          | `.github/workflows/catalog-refresh.yml:546`    |
| `ci.yml`                  | `unit_tests`            | `ubuntu-latest`  | needs-image | gcc         | `.github/workflows/ci.yml:61`                  |
| `ci.yml`                  | `opencode_e2e`          | `ubuntu-latest`  | needs-image | gcc         | `.github/workflows/ci.yml:127`                 |
| `ci.yml`                  | `provenance`            | `ubuntu-latest`  | runnable    | —           | `.github/workflows/ci.yml:137`                 |
| `ci.yml`                  | `commit_lint`           | `ubuntu-latest`  | runnable    | —           | `.github/workflows/ci.yml:155`                 |
| `ci.yml`                  | `commit_lint_push_path` | `ubuntu-latest`  | runnable    | —           | `.github/workflows/ci.yml:168`                 |
| `docker-image.yml`        | `push_to_registries`    | `ubuntu-latest`  | needs-image | binfmt-misc | `.github/workflows/docker-image.yml:35`        |
| `fly-deploy.yml`          | `deploy`                | `ubuntu-latest`  | runnable    | —           | `.github/workflows/fly-deploy.yml:42`          |
| `linux-release.yml`       | `release`               | `ubuntu-latest`  | needs-image | gcc         | `.github/workflows/linux-release.yml:48`       |
| `macos-release.yml`       | `release`               | `macos-latest`   | cannot-host | —           | `.github/workflows/macos-release.yml:18`       |
| `rate-drift-dispatch.yml` | `dispatch`              | `ubuntu-latest`  | needs-image | gh          | `.github/workflows/rate-drift-dispatch.yml:73` |
| `windows-release.yml`     | `release`               | `windows-latest` | cannot-host | —           | `.github/workflows/windows-release.yml:18`     |

### `moooon-B-V/motir-meta`

| Workflow     | Job         | runs-on         | Verdict     | Missing | Evidence                           |
| ------------ | ----------- | --------------- | ----------- | ------- | ---------------------------------- |
| `guards.yml` | `discover`  | `ubuntu-latest` | needs-image | python3 | `.github/workflows/guards.yml:35`  |
| `guards.yml` | `guard`     | `ubuntu-latest` | runnable    | —       | `.github/workflows/guards.yml:122` |
| `guards.yml` | `generated` | `ubuntu-latest` | runnable    | —       | `.github/workflows/guards.yml:177` |
| `guards.yml` | `complete`  | `ubuntu-latest` | needs-image | python3 | `.github/workflows/guards.yml:223` |

### `moooon-B-V/motir-marketing`

| Workflow                | Job                 | runs-on         | Verdict  | Missing | Evidence                                     |
| ----------------------- | ------------------- | --------------- | -------- | ------- | -------------------------------------------- |
| `ci.yml`                | `lint`              | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:77`                |
| `ci.yml`                | `typecheck`         | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:92`                |
| `ci.yml`                | `build`             | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:106`               |
| `ci.yml`                | `test`              | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:133`               |
| `ci.yml`                | `design-guards`     | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:162`               |
| `ci.yml`                | `e2e`               | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:197`               |
| `ci.yml`                | `subprocessor-seam` | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:253`               |
| `ci.yml`                | `deploy`            | `ubuntu-latest` | runnable | —       | `.github/workflows/ci.yml:271`               |
| `subprocessor-seam.yml` | `seam`              | `ubuntu-latest` | runnable | —       | `.github/workflows/subprocessor-seam.yml:68` |

### `moooon-B-V/motir-skills`

| Workflow       | Job           | runs-on         | Verdict  | Missing | Evidence                            |
| -------------- | ------------- | --------------- | -------- | ------- | ----------------------------------- |
| `validate.yml` | `validate`    | `ubuntu-latest` | runnable | —       | `.github/workflows/validate.yml:12` |
| `validate.yml` | `install-e2e` | `ubuntu-latest` | runnable | —       | `.github/workflows/validate.yml:40` |

### `moooon-B-V/nextjs-prisma-vercel-starter`

| Workflow                          | Job                  | runs-on                | Verdict | Missing             | Evidence |
| --------------------------------- | -------------------- | ---------------------- | ------- | ------------------- | -------- | --- | ------------------------------------------------------ |
| `acceptance-tests.yml`            | `membership`         | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/acceptance-tests.yml:153`           |
| `acceptance-tests.yml`            | `acceptance`         | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/acceptance-tests.yml:221`           |
| `ci.yml`                          | `lint`               | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/ci.yml:36`                          |
| `ci.yml`                          | `typecheck`          | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/ci.yml:50`                          |
| `ci.yml`                          | `unit`               | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/ci.yml:80`                          |
| `ci.yml`                          | `build`              | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/ci.yml:121`                         |
| `ci.yml`                          | `e2e`                | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/ci.yml:173`                         |
| `cleanup-preview-deployments.yml` | `remove-deployments` | `${{ vars.MOTIR_RUNNER |         | 'ubuntu-latest' }}` | runnable | —   | `.github/workflows/cleanup-preview-deployments.yml:94` |

## Image extension

**Card:** MOTIR-8710. The work set is the union of `missing` over `needs-image`
jobs in **private** repositories only. A public repository never requests the
fleet, so its gaps are out of scope.

```sh
jq -r '.repos | to_entries[] | select(.value.visibility=="private") | .value
  | .. | objects | select(.verdict? == "needs-image") | .missing[]' \
  lib/ciFleet/fleetJobInventory.json | sort | uniq -c
```

At the base (the inventory as committed): `1 binfmt-misc · 4 gcc · 5 gh · 2 python3`.
After this change: `1 binfmt-misc`.

| Slug          | Disposition                                                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gh`          | **Baked** as Ubuntu's own `gh` package (noble/universe, 2.45.0) in the base apt list, at `infra/ci-runner/Dockerfile:190`. It is pinned the way every apt entry in the file is, through the base image digest.                                                                                                   |
| `gcc`         | **Baked** as `build-essential` (gcc, g++, make, libc6-dev) at `Dockerfile:186`. `assert-image.sh --image` also compiles and links a C program, because cgo is the reason it is there.                                                                                                                            |
| `python3`     | **Baked** at `Dockerfile:198`. **This deviates from the inventory's recommendation** (add `actions/setup-python` to the two jobs). That fix is a workflow edit in motir-meta, which this card may not make, and the jobs never install python themselves. Baking costs one apt package and closes both jobs now. |
| `binfmt-misc` | **Not cleared.** It is a capability of the fleet machine's kernel, not of the image, so it stays `needs-image` until somebody runs a privileged `tonistiigi/binfmt` install on a live fleet machine. Recorded in the Dockerfile's "NOT installed" notes.                                                         |

**Jobs flipped to `runnable` (10):**

- motir-ai: `rate-drift.yml` `guard-on-live-artifact`, `rate-sync.yml` `sync`.
- motir-gateway: `catalog-refresh.yml` `refresh` and `failure_issue`, `ci.yml` `unit_tests` and `opencode_e2e`, `linux-release.yml` `release`, `rate-drift-dispatch.yml` `dispatch`.
- motir-meta: `guards.yml` `discover` and `complete`.

**Private-repository jobs still not `runnable` (3):**

- motir-gateway `docker-image.yml` `push_to_registries` (`binfmt-misc`, above).
- motir-gateway `macos-release.yml` `release` (`cannot-host`).
- motir-gateway `windows-release.yml` `release` (`cannot-host`).

The manifest's `imageDockerfileBlob` is `git hash-object infra/ci-runner/Dockerfile`
at this change. The image was not built in this session, which has a Docker client
but no daemon. The `--image` assertions run in `runner-image.yml` on the pull
request, and that run is the build proof.
