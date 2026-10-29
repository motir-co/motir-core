# syntax=docker/dockerfile:1
#
# The Motir SANDBOX BASE image (Subtask 7.9.7a / MOTIR-1505).
#
# What this is: the confined, reproducible container an unattended `motir auto`
# run executes in, instead of a skip-permissions coding agent loose on the host.
# Running `motir auto` in a normal console stays fully supported — the container
# is the RECOMMENDED path, not a requirement.
#
# What this image DOES confine: the FILESYSTEM blast radius. The only host
# surfaces inside are the two mounts below — a writable `/workspace` (your
# `.motir.json` tree) and a READ-ONLY `~/.config/motir` (the PAT). No docker
# socket, no host filesystem beyond those.
#
# What it does NOT confine: EGRESS. The network is open by default and stays
# that way — every coding agent needs its provider API, and every dispatched
# item needs git remotes + the Motir server. Confine the network at the docker
# level (`--network`) if your threat model needs it; this image will not pretend
# to.
#
# Build (context is the motir-core repo ROOT, not this directory):
#   docker build -f packages/cli/sandbox/Dockerfile -t motir-sandbox:base .
#
# Selecting an agent: `--build-arg AGENT=<profile>` layers one of the eight
# coding-agent profiles (claude / codex / opencode / kimi / antigravity / cursor
# / aider / goose) on top of this base — see `install-agent.sh` for the layers
# and README.md for the per-agent credential mount and verified auto-approve
# flag. The build/version matrix + write-confinement smoke tests are 7.9.7c
# (MOTIR-885); publishing to GHCR with digest pinning is 7.9.7e (MOTIR-1788).

# The Node base. Floored at >= 24.15, which clears every supported agent's own
# requirement with headroom — the highest of those, checked against the
# published packages while filling the profile matrix (7.9.7b), is Kimi Code's
# >= 22.19. The tag is an ARG so 7.9.7e can pin a digest at publish time without
# editing this file; the floor itself is ASSERTED below rather than trusted to
# the tag.
ARG NODE_TAG=24-bookworm-slim

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build the `motir` binary from this checkout and pack it as a tarball
# ─────────────────────────────────────────────────────────────────────────────
# `@motir/cli` IS on npm now (0.0.1 since MOTIR-1890, 0.2.0 as of MOTIR-2219),
# but the image still builds it from source ON PURPOSE: a `cli-v*` tag lane
# replays that tag's tree, so packing from the checkout makes the `motir` inside
# the image the same commit as the tag — where `npm install @motir/cli@<version>`
# would fetch whatever the registry holds under that version and reintroduce the
# gap the tag exists to close. `npm pack` produces the same artifact a published
# release would, so the runtime stage's install path is identical either way.
FROM node:${NODE_TAG} AS builder

WORKDIR /src

# pnpm comes from corepack so the version is the one pinned by the repo's
# `packageManager` field. The prompt must be disabled explicitly — corepack asks
# before downloading a package manager, and there is no TTY to answer it here.
# The npm fallback keeps the build working on a base image without corepack.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm || npm install -g pnpm@11.2.2

# The whole workspace is copied because `pnpm install --frozen-lockfile`
# validates the lockfile against EVERY workspace manifest; a partial copy fails
# the frozen check. `.dockerignore` keeps node_modules/.next/.git out of the
# context, so this stays small. `--filter @motir/cli...` then installs only the
# CLI's own dependency closure, and `--ignore-scripts` skips the root
# postinstall (prisma generate + design-system build) which the CLI never needs.
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @motir/cli...
# `npm pack` is run from the package directory, not via `--workspace`: this repo
# declares its workspace in pnpm-workspace.yaml, which npm does not read.
#
# `mkdir -p /pkg` is REQUIRED, not tidiness: `npm pack --pack-destination` does
# NOT create its destination, and fails with a bare
# `ENOENT … open '/pkg/motir-cli-0.1.0.tgz'` that reads like a missing INPUT
# rather than a missing output directory. This is what the first run of 7.9.7c's
# build matrix caught — the image had never been built by CI, so the whole
# Dockerfile was unverified.
RUN pnpm --filter @motir/cli build \
    && cd packages/cli \
    && mkdir -p /pkg \
    && npm pack --pack-destination /pkg

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1b — compile node-pty for the in-agent terminal server (MOTIR-6938)
# ─────────────────────────────────────────────────────────────────────────────
# `motir agent-terminal serve` hands a browser a shell through Motir's relay
# (`docs/decisions/agent-terminal.md` Q4), and it needs a real PTY to do it.
# node-pty is that PTY, and it is deliberately NOT a dependency of `@motir/cli`:
# its 1.1.0 ships prebuilt binaries for macOS and Windows only, so on Linux it
# compiles at install — and the package is also installed on laptops, which must
# never be asked for a C++ toolchain. So it is built HERE, in a stage that has
# one, into a directory the final stage copies, and `serve` loads it from there
# with `createRequire`. Outside this image `serve` refuses in words instead.
#
# The SAME `NODE_TAG` as the runtime stage, on purpose: a native addon is bound
# to the Node ABI it was compiled against, and a mismatch fails at `require`
# time on the user's machine rather than here.
#
# The version is PINNED EXACTLY (`--save-exact`, and the ARG is a version, not a
# range): a terminal server whose PTY changed under it between two builds of the
# same tag is the kind of drift nobody can bisect.
#
# The build tools stay in THIS stage. The runtime image gains the compiled
# directory and nothing else — no compiler for an unprivileged agent to find.
FROM node:${NODE_TAG} AS terminal-pty
ARG NODE_PTY_VERSION=1.1.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/motir-terminal
# The smoke test is a SPAWN, not a `require`: an addon that loads but cannot
# open a PTY is the failure that matters, and it must fail the BUILD — the same
# reason the runtime stage asserts `motir --version`.
RUN printf '%s\n' '{ "name": "motir-terminal", "private": true }' > package.json \
    && npm install --no-audit --no-fund --save-exact --foreground-scripts "node-pty@${NODE_PTY_VERSION}" \
    && node -e "const pty = require('node-pty'); \
const child = pty.spawn('/bin/sh', ['-c', 'exit 7'], { cols: 80, rows: 24 }); \
child.onExit(({ exitCode }) => process.exit(exitCode === 7 ? 0 : 1));" \
    && rm -rf /root/.npm /root/.cache

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — the sandbox base
# ─────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_TAG} AS base

LABEL org.opencontainers.image.title="motir-sandbox" \
      org.opencontainers.image.description="Confined sandbox for unattended `motir auto` runs (base image, no coding agent)." \
      org.opencontainers.image.source="https://github.com/moooon-B-V/motir-core" \
      org.opencontainers.image.licenses="GPL-3.0-only"

# Assert the Node floor rather than assuming the tag delivers it. A base image
# that silently drifted below 24.15 would fail at Kimi's first run instead of
# here, which is far more expensive to diagnose.
RUN node -e "const [maj, min] = process.versions.node.split('.').map(Number); \
if (maj < 24 || (maj === 24 && min < 15)) { \
  console.error('motir-sandbox: Node ' + process.versions.node + ' is below the >= 24.15 floor required by the supported coding agents.'); \
  process.exit(1); \
}"

# git + gh are part of the CONTRACT, not conveniences: every dispatched item's
# GIT WORKFLOW section runs git, and the session-branch/PR steps run gh.
# ca-certificates/curl/gnupg are needed to add the GitHub CLI apt source;
# openssh-client covers SSH git remotes; less is gh's pager.
#
# python3 is contract for the SAME reason, and it was missed because the list
# above was reasoned entirely from the CLI DISPATCH path, which runs none
# (MOTIR-6195). The RUNBOOK path does: the `motir-sweep-planning-bugs` and
# `motir-fix-planning-bug` doors drive `prompts/sweep-planning-bugs.py` as their
# loop driver — the FIRST call of each, with no degraded mode — and every corpus
# guard in motir-meta (`DOORS.check.py`, `prompts/plan-rules/*.py`) is a Python
# script, so without an interpreter a rules change cannot be checked before it is
# pushed.
#
# ⚠️ IT IS `python3`, NOT `python3-minimal`, AND THE DIFFERENCE IS NOT A
# PREFERENCE (MOTIR-6204). MOTIR-6195 chose `-minimal` on the grounds that those
# scripts "import stdlib only" — true, and not the question `-minimal` asks.
# `libpython3.11-minimal` carries 81 modules, not the standard library: `re`,
# `collections`, `importlib`, `argparse`, `subprocess`, `tempfile`, `io`,
# `contextlib` and `functools` are in it; **`json`, `shutil` and `difflib` are
# NOT**. The corpus imports all three —
#
#   json     prompts/plan-rules/SELECTOR.check.py
#   difflib  prompts/plan-rules/SELECTOR.check.py, COMPRESSION.conserve.py
#   shutil   prompts/plan-rules/MIRROR.check.py
#
# — so `SELECTOR.check.py`, the guard that asserts MANIFEST.md is byte-identical
# to what `split.py` generates, died on `import json` in the image that was
# shipped to fix exactly that. Verified against bookworm's own file lists on
# 2026-09-24:
#   curl -fsSL https://packages.debian.org/bookworm/amd64/libpython3.11-minimal/filelist
# The full interpreter is the fix, and "stdlib only" now buys what it says.
#
# The METAPACKAGE is pinned (identical on amd64 and arm64), not `python3.11`
# itself: the interpreter's patch level follows Debian's security updates, and
# pinning THAT would fail the build on the day a CVE is fixed.
#
# The build-time assertion below is the IMPORTS THE CONSUMER MAKES, not a
# `--version`. That distinction is the whole of this fix: `-minimal` answered
# `python3 --version` perfectly for as long as it shipped, while the guard it
# was installed for could not start. Naming the three omitted modules is what
# makes a future narrowing of this package fail the BUILD instead of somebody's
# sweep.
ARG PYTHON_VERSION=3.11.2-1+b1
# `procps` is `ps`, which Codex's background app-server shells out to when it
# records its pid-managed startup (MOTIR-8868). `node:*-slim` ships none, and
# without it every `codex` after a successful sign-in dies with "failed to
# invoke ps for pid-managed app server". Pinned like python3: bookworm's own
# version, identical on amd64 and arm64.
ARG PROCPS_VERSION=2:4.0.2-3
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        less \
        openssh-client \
        "procps=${PROCPS_VERSION}" \
        "python3=${PYTHON_VERSION}" \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && ps --version \
    && python3 --version \
    && python3 -c 'import json, shutil, difflib, re, collections, importlib, argparse'

# ── A Postgres to DEBUG AGAINST (MOTIR-6204) ─────────────────────────────────
#
# WHY IT IS HERE AT ALL. The agent inside this container is unprivileged and
# there is no `sudo`, so anything absent at BUILD time is absent for every run —
# `apt-get install` answers `Could not open lock file /var/lib/dpkg/lock-frontend`
# and there is no way around it from inside. A test that touches the database is
# therefore unrunnable in this image today, and a coding agent that cannot run
# the test it just changed is debugging blind.
#
# WHAT IT IS FOR, precisely: running the FEW tests around a failure while
# debugging — never the suite, never CI parity. That scope is what settles the
# three questions below, and it is why `fsync` is off: a cluster nobody is
# recovering can trade durability for speed.
#
# WHY A SERVER AND NOT A CLIENT. A client would have nothing to connect to. A
# compose SIDECAR was the other candidate and reaches neither recipe this image
# documents — the `docker run` one-liner at the foot of this file, and the
# devcontainer route, which is a single container by construction.
#
# ⚠️ WHY 16 AND NOT THE NEWEST — THIS ONE ENTRY IS A DELIBERATE CARVE-OUT FROM
# "latest", AND IT IS NOT AN OVERSIGHT TO FIX. A debugging database has one job:
# reproduce the failure being chased and manufacture none of its own. Three
# properties decide that, and all three point away from `newest`:
#
#   Postgres 16  — motir-core `docker-compose.yml` + `.github/actions/postgres`
#                  (`image-tag: pg16`), motir-ai `docker-compose.yml` + its
#                  `ci.yml`, and nextjs-prisma-serverless-starter `docker-compose.yml`
#                  + `ci.yml` all pin 16. Unanimous across four repositories, so
#                  a newer major here debugs on an engine no CI ever runs.
#   pgvector     — motir-core's `work_item_embedding` migration runs
#                  `CREATE EXTENSION vector` (MOTIR-2696) and motir-ai's
#                  `20260624000000_enable_pgvector` does the same. Both repos
#                  moved OFF the official image to get it. Without it migrations
#                  fail outright and NO database test runs.
#   C.UTF-8      — `lib/workItems/positioning.ts` mints base-62 fractional keys
#                  that mix cases, so `'Zz' < 'a0'` holds only under BYTE
#                  ordering; production (Neon) is `datcollate = 'C.UTF-8'` and
#                  `tests/db-collation.test.ts` asserts it at runtime. The last
#                  cluster that drifted to glibc's `en_US.utf8` turned ELEVEN
#                  ordering assertions red across three Vitest shards, naming no
#                  cause. A debugging database that invents eleven failures is
#                  worse than no database.
#
# Versions read from apt.postgresql.org's bookworm-pgdg Packages index on
# 2026-09-24 and pinned exactly; both published architectures carry the same
# two versions, so the arm64 leg cannot diverge:
#   curl -fsSL https://apt.postgresql.org/pub/repos/apt/dists/bookworm-pgdg/main/binary-$arch/Packages.gz \
#     | gunzip | awk '/^Package: (postgresql-16|postgresql-16-pgvector)$/{p=$2} /^Version:/{if(p){print p" "$2; p=""}}'
ARG PG_MAJOR=16
ARG PG_VERSION=16.15-1.pgdg12+2
ARG PGVECTOR_VERSION=0.8.6-1.pgdg12+2
# The cluster lives outside /var/lib/postgresql so it is plainly not Debian's.
# `create_main_cluster = false` below stops postgresql-common making one at all:
# its cluster is initialised under the SYSTEM locale, which is exactly the
# collation this layer exists to avoid, and not creating it beats creating and
# then dropping it — a drop is a step that can fail, and a build that fails to
# remove a cluster nobody wanted would still be shipping the right one beside it.
ENV PGDATA=/var/lib/motir-postgres
# The role, database and port every CI job in these repositories already sets,
# so a test command runs AS TYPED rather than after a round of env wrangling.
ENV DATABASE_URL=postgresql://prodect:prodect@localhost:5432/prodect
ENV PATH=/usr/lib/postgresql/${PG_MAJOR}/bin:$PATH
RUN set -eux; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        -o /etc/apt/keyrings/pgdg.asc; \
    chmod go+r /etc/apt/keyrings/pgdg.asc; \
    echo "deb [signed-by=/etc/apt/keyrings/pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list; \
    mkdir -p /etc/postgresql-common; \
    echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}=${PG_VERSION}" \
        "postgresql-client-${PG_MAJOR}=${PG_VERSION}" \
        "postgresql-${PG_MAJOR}-pgvector=${PGVECTOR_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p "$PGDATA"; \
    chown node:node "$PGDATA"; \
    chmod 700 "$PGDATA"

# ⚠️ ENV PATH does NOT reach a LOGIN shell — the same fact the agent-prefix layer
# below records, and it bites here for the same reason: Debian's /etc/profile
# REPLACES PATH for a non-root user, and a login shell is exactly what this
# image's own `CMD ["bash", "-l"]` starts. Without this, `psql` and `pg_ctl` are
# missing from the shell a reader actually gets, while working perfectly under
# `docker run … bash -c`, which is the shape the smoke suite uses. The helper
# itself is unaffected (it lives on the default PATH and calls the binaries by
# absolute path) — this is for the person who types `psql`.
RUN printf '%s\n' \
    '# motir-sandbox: the Postgres client binaries, for a LOGIN shell (MOTIR-6204).' \
    'case ":$PATH:" in *:/usr/lib/postgresql/16/bin:*) ;; *) PATH="/usr/lib/postgresql/16/bin:$PATH" ;; esac' \
    'export PATH' \
    > /etc/profile.d/motir-postgres-path.sh

# The cluster is initialised AS `node`, at build time, so the runtime user owns
# every byte of it and needs no privilege to start it — the same reasoning as the
# agent prefix below, one directory over. `su node -c` rather than a `USER` flip,
# because the agent layer after this still has to run as root.
#
# Baking the initialised cluster rather than initialising on first boot is what
# makes the locale and the extension PROPERTIES OF THE IMAGE: a first-boot initdb
# would be a runtime step that can be skipped, mis-locale'd, or silently fail in a
# container nobody is watching. The `'Zz' < 'a0'` probe fails the BUILD if the
# collation is ever wrong, for the same stated reason `motir --version` does.
#
# ⚠️ `unix_socket_directories = '/tmp'` IS LOAD-BEARING, not tidiness. The
# compiled-in default is /var/run/postgresql, which the postgres PACKAGE creates
# owned by postgres:postgres — so a server run by `node` cannot create its lock
# file there and refuses to start with a permission error that names a directory
# nobody chose. Everything below therefore also connects over `-h localhost`
# rather than the socket, because libpq's own default socket path is the
# compiled-in one and would look where the server is not.
RUN set -eux; \
    su node -c "/usr/lib/postgresql/${PG_MAJOR}/bin/initdb \
        --pgdata=$PGDATA \
        --username=prodect \
        --encoding=UTF8 \
        --locale=C.UTF-8 \
        --auth-local=trust \
        --auth-host=trust"; \
    printf '%s\n' \
        "listen_addresses = 'localhost'" \
        'port = 5432' \
        "unix_socket_directories = '/tmp'" \
        '# A debugging cluster is never recovered — see this layer header.' \
        'fsync = off' \
        'synchronous_commit = off' \
        'full_page_writes = off' \
        >> "$PGDATA/postgresql.conf"; \
    su node -c "/usr/lib/postgresql/${PG_MAJOR}/bin/pg_ctl -D $PGDATA -w start"; \
    su node -c "/usr/lib/postgresql/${PG_MAJOR}/bin/createdb -h localhost --username=prodect prodect"; \
    su node -c "/usr/lib/postgresql/${PG_MAJOR}/bin/psql -h localhost --username=prodect --dbname=prodect \
        -c \"ALTER ROLE prodect WITH PASSWORD 'prodect'\" \
        -c 'CREATE EXTENSION IF NOT EXISTS vector'"; \
    su node -c "/usr/lib/postgresql/${PG_MAJOR}/bin/psql -h localhost --username=prodect --dbname=prodect -tAc \"SELECT 'Zz' < 'a0'\"" \
        | grep -qx 't'; \
    su node -c "/usr/lib/postgresql/${PG_MAJOR}/bin/pg_ctl -D $PGDATA -w stop"

# The server is NOT started by the entrypoint, and that is a decision rather than
# an omission: `"overrideCommand": true` means the devcontainer route never runs
# the entrypoint at all (the MOTIR-4956 note below), so an entrypoint start would
# work on one of the two documented routes and silently not on the other. A named
# command on PATH is the shape that reaches both — the same pattern MOTIR-4959
# established for the agent-config setup.
COPY --chmod=0755 packages/cli/sandbox/postgres.sh /usr/local/bin/motir-sandbox-postgres

# ── A browser to RUN SPECS WITH (MOTIR-6204) ─────────────────────────────────
#
# Two halves, and only one of them could ever be added later:
#
#   the system LIBRARIES — root-only, so an unprivileged agent can NEVER install
#     them. Without them a downloaded browser does not launch at all. This is the
#     half that makes the other half possible, and the reason the layer exists.
#   the BROWSER BINARY — a plain download into a user-writable path, so an agent
#     could fetch it at run time. It is baked anyway, for the reason the sibling
#     image gives for NOT baking one, read the other way round.
#
# ⚠️ `infra/ci-runner/Dockerfile` bakes the libraries and REFUSES the binary, and
# this file disagrees with it ON PURPOSE. That image runs one job per container
# and is pulled per job, so a baked browser there "trades a CDN download for an
# equal-sized registry pull". THIS container is pulled once and then lived in for
# days or weeks across many runs, so the same bytes are paid once instead of per
# debugging session. Same evidence, opposite arithmetic, because the container
# lifetimes are opposite. Neither file is wrong; see MOTIR-6204.
#
# The package list is ASKED FOR rather than asserted — `playwright install-deps`
# emits the apt set for the detected distro — which is ci-runner's pattern and
# keeps this layer tracking upstream instead of drifting from a list typed once.
#
# The VERSION is the consumer's, not the newest, for the same reason Postgres's
# is: a browser exists here to run a repository's own specs, and the repositories
# this image serves resolve 1.62.x (motir-marketing `^1.62.1`, motir-core
# `^1.60.0`), while `infra/ci-runner/Dockerfile` already pins 1.62.1. npm's
# `latest` was 1.63.0 on 2026-09-24 — known, and declined, because a build no
# consumer asks for is a download nobody uses. A repo that needs another version
# runs `playwright install` itself: the libraries are the part it could not add.
ARG PLAYWRIGHT_VERSION=1.62.1
# A shared, node-owned browser path — NOT the default ~/.cache/ms-playwright,
# which a devcontainer's home mount can shadow and which a root-run install would
# write to root's home rather than the runtime user's.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/motir-browsers
RUN set -eux; \
    mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"; \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium; \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm

# The `motir` binary itself. Installed globally from the packed tarball so it is
# on PATH for every user, and smoke-tested in the same layer — a base that
# cannot run `motir --version` must fail the BUILD, not the first `motir auto`.
COPY --from=builder /pkg/*.tgz /tmp/motir-cli.tgz
RUN npm install -g /tmp/motir-cli.tgz \
    && rm /tmp/motir-cli.tgz \
    && motir --version

# ── The terminal server's PTY (MOTIR-6938) ───────────────────────────────────
# The compiled node-pty from stage 1b, at the path `motir agent-terminal serve`
# loads it from. Root-owned, like the `motir` binary above, so the agent can
# neither replace the addon the server spawns shells with nor break it.
#
# `motir agent-terminal --help` exiting 0 is exactly what an agent machine's
# init probes before it starts the server (Q4, Q8), so it is asserted here: an
# image that cannot answer it must fail the BUILD, not boot into `sleep`.
COPY --from=terminal-pty /opt/motir-terminal /opt/motir-terminal
RUN motir agent-terminal --help >/dev/null \
    && node -e "require('module').createRequire('/opt/motir-terminal/package.json')('node-pty')"

# ── CodeGraph: the coding agent's own navigation graph (7.9.7d / MOTIR-1513) ─
# The structural code-graph engine the 7.5.3 spike selected, so the agent inside
# this container can ask `callers` / `impact` / `explore` / `search` instead of
# grepping its way around an unfamiliar repo.
#
# ⚠️ This is the CODING AGENT's per-container graph — NOT motir-ai's planner
# code graph (7.5.4). Same engine, different consumer and a different store;
# nothing here talks to motir-ai.
#
# It sits BEFORE the agent layer for two reasons: the per-agent seam below wires
# the codegraph MCP server into each agent and so needs the binary on PATH, and
# an agent-independent layer stays cached across all eight profile builds.
#
# Telemetry is disabled BOTH ways on purpose. The env var is what actually holds
# in an unattended run — it survives a home directory replaced by a bind mount,
# which the persisted `telemetry off` state file does not.
ENV CODEGRAPH_TELEMETRY=0
RUN npm install -g --no-fund --no-audit @colbymchenry/codegraph \
    && HOME=/home/node codegraph telemetry off \
    && codegraph --version

# ── The per-agent layer seam (AGENT build-arg selector) ──────────────────────
# `--build-arg AGENT=<profile>` selects which coding agent is installed on top
# of this base; the layer itself is the matching case arm in `install-agent.sh`.
# The default `base` is a deliberate no-op: the base image ships no agent, which
# is exactly what the CI build/version matrix and a `--print` workflow want.
# The layer runs as ROOT and before `USER node` below, which is why every arm
# installs onto the GLOBAL path rather than into a user's home.
ARG AGENT=base
ENV MOTIR_SANDBOX_AGENT=${AGENT}

# ── The agents live in a prefix the RUNTIME user owns (MOTIR-6183) ───────────
# A sandbox may run for weeks, and a reader who wants a coding agent's update
# should get it where they are: a rebuild keeps /workspace and the Motir sign-in
# but loses the agent's own sign-in, anything installed in the container, shell
# history and any running session. So every agent is installed under ONE prefix
# that is chowned to `node` below, and its self-updater (Claude Code's is the one
# reported: "Auto-update failed: no write permission to npm prefix") can write
# there. An update lives as long as the container; a rebuild returns the image's
# version, because nothing here is a volume that could shadow the image's copy.
#
# ⚠️ Set AFTER the `motir` and codegraph installs above, on purpose. Those stay
# root-owned in /usr/local, so the agent can update itself but cannot rewrite the
# `motir` binary that supervises it. `motir`'s own upgrade notice (MOTIR-4973)
# derives writability from its execPath, so it is unaffected.
#
# NPM_CONFIG_PREFIX makes `npm install -g` — the arms' at build time, and an
# updater's at run time — land here; PATH puts it ahead of /usr/local/bin.
ENV MOTIR_AGENT_PREFIX=/opt/motir-agents
ENV NPM_CONFIG_PREFIX=/opt/motir-agents
ENV PATH=/opt/motir-agents/bin:$PATH
# ⚠️ ENV PATH does NOT reach a LOGIN shell: Debian's /etc/profile REPLACES PATH
# for a non-root user (`PATH="/usr/local/bin:/usr/bin:/bin:…"`) — and a login
# shell is what this image's own `CMD ["bash", "-l"]` and any `sh -lc` start.
# Built and measured: without this line `claude` was not on PATH as `node` in a
# login shell. /etc/profile.d runs AFTER that reset, so it puts the prefix back,
# first, once.
RUN printf '%s\n' \
    '# motir-sandbox: the node-owned agent prefix, first on PATH (MOTIR-6183).' \
    'case ":$PATH:" in *:/opt/motir-agents/bin:*) ;; *) PATH="/opt/motir-agents/bin:$PATH" ;; esac' \
    'export PATH' \
    > /etc/profile.d/motir-agents-path.sh
COPY --chmod=0755 packages/cli/sandbox/install-agent.sh /usr/local/lib/motir-sandbox/install-agent.sh
# Sourced by install-agent.sh: the download-and-verify step every vendor install
# script goes through instead of `curl … | bash` (MOTIR-6495).
COPY --chmod=0644 packages/cli/sandbox/fetch-installer.sh /usr/local/lib/motir-sandbox/fetch-installer.sh
RUN /usr/local/lib/motir-sandbox/install-agent.sh "${AGENT}"

COPY --chmod=0755 packages/cli/sandbox/entrypoint.sh /usr/local/bin/motir-sandbox-entrypoint

# ── The agent-config setup, reachable from ANY shell (MOTIR-4959 / MOTIR-4956) ─
#
# `"overrideCommand": true` — which every devcontainer recipe needs, because the
# `CMD ["bash", "-l"]` below exits immediately — replaces the container's
# ENTRYPOINT as well as its CMD. So the entrypoint is NOT a reliable place to put
# work the agent cannot start without: on the Dev Containers route none of it
# ran, CLAUDE_CONFIG_DIR stayed unset, and the agent fell back to a `~/.claude`
# that is read-only and, on a macOS host, holds no credential at all.
#
# The setup therefore goes on PATH under its own name, and two shell hooks call
# it. That is what repairs a `.devcontainer/devcontainer.json` somebody has
# already copied into their own repository, which no edit to a recipe can reach.
COPY --chmod=0755 packages/cli/sandbox/agent-config.sh /usr/local/bin/motir-sandbox-agent-config

# SOURCED, never executed: a child process cannot put CLAUDE_CONFIG_DIR into the
# shell that needs it. Two hooks, because they cover different shells and a
# devcontainer produces both — /etc/profile.d is read by a LOGIN shell (this
# image's own `bash -l`, and any `sh -lc`), ~/.bashrc by an INTERACTIVE NON-LOGIN
# one, which is what a VS Code terminal usually opens. Neither existed before.
COPY --chmod=0644 packages/cli/sandbox/agent-config-profile.sh /etc/profile.d/motir-sandbox-agent-config.sh
RUN printf '%s\n' \
    '' \
    '# motir-sandbox: the agent-config setup, for an interactive NON-login shell.' \
    '# /etc/profile.d is not read by one, and a VS Code terminal is usually one.' \
    '[ -r /etc/profile.d/motir-sandbox-agent-config.sh ] && . /etc/profile.d/motir-sandbox-agent-config.sh' \
    >> /home/node/.bashrc

# Run unprivileged. The node image already ships a `node` user at uid/gid 1000,
# which is the common host uid — so files the agent writes into the /workspace
# bind mount stay owned by the invoking user rather than by root.
#
# The chown covers the WHOLE home, not just .config: the layers above run as
# root and write the codegraph MCP wiring into the runtime user's home
# (~/.cursor/mcp.json, ~/.motir-sandbox/agent-config/…, …). Left
# root-owned, an agent that rewrites its own config file at startup would fail
# on a home it cannot write.
#
# The agent prefix is chowned for the same reason, one level out (MOTIR-6183):
# it is what lets an agent update itself in a long-running container. The
# mkdir makes it exist in `base`, which installs no agent into it.
#
# The BROWSER path is chowned on the same grounds (MOTIR-6204): a repository
# pinned to a Playwright this image did not bake runs `playwright install`
# itself, and that download has to land somewhere the runtime user can write.
# The CLUSTER was chowned at its own layer — `initdb` had to run as `node` to
# produce files it owns, so there is nothing left to do for it here.
RUN mkdir -p /workspace /home/node/.config/motir /opt/motir-agents/bin /opt/motir-browsers \
    && chown -R node:node /workspace /home/node /opt/motir-agents /opt/motir-browsers

# ── A copy of the build-time home, for a PERSISTENT home to seed from (MOTIR-6887) ─
#
# A user agent instance mounts a Fly volume over /home/node
# (`docs/decisions/agent-instances.md` §1), and an empty volume hides everything
# the layers above wrote there — the agent config home the entrypoint sources,
# the `.bashrc` hook, the codegraph MCP wiring. So the finished home is copied
# OUT of $HOME here, as the LAST write to it, and the entrypoint adds back
# whatever a mounted home is missing (`seed-home.sh`, never overwriting).
#
# Owned by `node` so the copy it makes is `node`'s, and not writable by anyone
# else, so nothing at run time can plant a file every future home would inherit.
# It must stay AFTER every layer that writes into /home/node, or the seed is
# missing that layer's files.
COPY --chmod=0755 packages/cli/sandbox/seed-home.sh /usr/local/bin/motir-sandbox-seed-home
RUN cp -a /home/node /opt/motir-home-seed \
    && chown -R node:node /opt/motir-home-seed \
    && chmod -R go-w /opt/motir-home-seed

USER node
# HOME is set explicitly because the CLI resolves its config dir from
# `MOTIR_CONFIG_HOME` -> `XDG_CONFIG_HOME` -> `$HOME/.config` (see
# src/config/userConfig.ts) — pinning HOME is what makes the read-only PAT mount
# target below deterministic.
ENV HOME=/home/node
WORKDIR /workspace

# The entrypoint drops into /workspace so `motir auto` is a one-liner:
#   docker run --rm -it \
#     -v "$PWD:/workspace" \
#     -v "$HOME/.config/motir:/home/node/.config/motir:ro" \
#     motir-sandbox:base motir auto --agent "<cmd>"
# With no command it opens an interactive shell instead.
ENTRYPOINT ["motir-sandbox-entrypoint"]
CMD ["bash", "-l"]
