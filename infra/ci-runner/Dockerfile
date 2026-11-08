# syntax=docker/dockerfile:1
#
# The MOTIR CI RUNNER image (Story 7.x / MOTIR-1916 · MOTIR-1978).
#
# What this is: the container every ephemeral fleet runner boots from. MOTIR-1921
# shipped `lib/orchestrator/` — the port, the Fly adapter, `reap()` — and reads
# the image out of `MOTIR_RUNNER_IMAGE` (`lib/orchestrator/adapters/fly/
# flyMachines.ts` → `flyFleetConfig()`), pushing it onto a `missing` list when it
# is unset. Until this file was built and published there was nothing for that
# variable to hold: the fleet was code-complete and could not boot a runner.
#
# ─── WHY THE CONTENTS ARE DERIVED, NOT CHOSEN ────────────────────────────────
#
# `docs/decisions/ci-minutes-allowance.md` §M fixes the fleet runner as
# *Linux-2-core-EQUIVALENT*, and §8 of `docs/decisions/ci-runner-fleet.md` buys
# the hardware for it (`performance-2x` + 4 GB → 2 vCPU / 8 GB). Hardware parity
# without TOOLCHAIN parity is not parity: every toolchain `ubuntu-latest` ships
# and this image does not is installed again by every customer build, on
# WALL-CLOCK-METERED minutes — the customer is billed for Motir's missing layer,
# and §8's ~80.5% margin erodes because the same slowdown is paid twice (once by
# the tenant's allowance, once by Motir's Fly invoice). That is §8's own argument
# for dedicated vCPU, applied one layer up.
#
# So the toolchain below is the UNION of what the two starters' workflows
# ACTUALLY install, not a remembered list of "what a CI image usually has". Every
# entry carries its evidence line; anything without one is not in the image.
# Evidence read 2026-08-02 against each starter's `origin/main`:
#
#   S = moooon-B-V/nextjs-prisma-vercel-starter @ 34a78d1 .github/workflows/
#   D = moooon-B-V/nextjs-prisma-vercel-starter-with-design @ 7bcfd06 .github/workflows/
#
#   | Toolchain          | Evidence                                              |
#   | ------------------ | ----------------------------------------------------- |
#   | Node.js 22         | S ci.yml:40-43,54-57,106-109,158-161,254-257,334-337   |
#   |                    | D ci.yml:22-24,36-38,80-82,119-121,172-174            |
#   |                    | (`actions/setup-node@v4`, `node-version: 22`)          |
#   | pnpm 11.2.2        | S/D ci.yml `pnpm/action-setup@v4` (no `version:`, so   |
#   |                    | it reads `packageManager` — both package.json:10)      |
#   | git                | S ci.yml:187-189 `fetch-depth: 0` + :206 `git diff`     |
#   |                    | — `actions/checkout` falls back to a tarball without    |
#   |                    | git, and the acceptance-specs job then has no diff.     |
#   | Docker             | S ci.yml:81-87,122-128,216-222,296-302 and             |
#   |                    | D ci.yml:49-51,97-99,136-138 — `services: postgres:`   |
#   |                    | `16-alpine` with `--health-cmd`. Service containers on  |
#   |                    | a self-hosted runner are started by the runner via      |
#   |                    | Docker ON THE RUNNER. No Docker ⇒ four of the           |
#   |                    | starter's six jobs cannot run at all. See the           |
#   |                    | §7.6 note in the docker layer below.                    |
#   | Playwright deps    | S ci.yml:268,348 · D ci.yml:185                        |
#   |                    | `pnpm exec playwright install --with-deps chromium`     |
#   | curl + jq          | S cleanup-preview-deployments.yml:101,115,121,143       |
#   |                    | (that workflow is on `vars.MOTIR_RUNNER` too, :63)      |
#   | bash + coreutils   | S ci.yml:194 `run: |` with `set -euo pipefail`          |
#   | unzip/zip/tar      | `actions/upload-artifact@v4` (S ci.yml:276,372) and     |
#   |                    | `actions/checkout`'s tarball fallback                   |
#
# Extended for MOTIR's OWN private repositories (Story MOTIR-8699 · MOTIR-8710),
# from the inventory `lib/ciFleet/fleetJobInventory.json` (MOTIR-8701), read
# 2026-10-15 against each repository's `origin/main`. Only PRIVATE repositories
# count: a public one never requests the fleet (the runner group access-lists
# private repositories only), so its gaps buy nothing here.
#
#   A = moooon-B-V/motir-ai      @ 38bfab2 .github/workflows/
#   G = moooon-B-V/motir-gateway @ 996e428 .github/workflows/
#   M = moooon-B-V/motir-meta    @ a7fd87b .github/workflows/
#
#   | Toolchain          | Evidence                                              |
#   | ------------------ | ----------------------------------------------------- |
#   | gh (GitHub CLI)    | A rate-drift.yml:240 · A rate-sync.yml:113            |
#   |                    | G catalog-refresh.yml:232,546 ·                        |
#   |                    | G rate-drift-dispatch.yml:73 — `gh api` / `gh pr` /     |
#   |                    | `gh issue` / `gh workflow run`, never installed by the  |
#   |                    | job; `ubuntu-latest` preinstalls it. Ubuntu's own       |
#   |                    | `gh` package (universe), so it is pinned the same way   |
#   |                    | every other apt entry is.                               |
#   | build-essential    | G ci.yml:61,127 · G linux-release.yml:48 ·              |
#   |                    | G catalog-refresh.yml:232 — `go build`/`go test` of a   |
#   |                    | module that depends on `mattn/go-sqlite3` (cgo,         |
#   |                    | G go.mod:86). With no C compiler Go silently builds     |
#   |                    | with CGO_ENABLED=0 and the sqlite driver fails at run   |
#   |                    | time; `linux-release` links `-extldflags '-static'`.    |
#   | python3            | M guards.yml:35,223 — `shell: python3 {0}` steps with   |
#   |                    | no `actions/setup-python` before them.                  |
#   | pipx               | A ci.yml:242 — `pipx install lizard` in the three       |
#   |                    | Vitest shards, with no setup step before it;            |
#   |                    | `ubuntu-latest` preinstalls pipx (MOTIR-8884). Its      |
#   |                    | installs land in ~/.local/bin, put on PATH below.       |
#
# The AWS deploy jobs, read 2026-11-03 against each repository's `origin/main`
# (MOTIR-10293). Both jobs run on `vars.MOTIR_RUNNER` and call the CLI with no
# setup step before it; `ubuntu-latest` preinstalls it.
#
#   A' = motir-co/motir-ai      @ 1e4f5f4 .github/workflows/
#   G' = motir-co/motir-gateway @ 2589312 .github/workflows/
#
#   | Toolchain          | Evidence                                              |
#   | ------------------ | ----------------------------------------------------- |
#   | AWS CLI v2         | A' ci.yml:898 `aws ssm get-parameter` ·                |
#   |                    | A' ci.yml:925 `aws ecr describe-images` ·              |
#   |                    | G' aws-deploy.yml:109 `aws ssm get-parameter` ·        |
#   |                    | G' aws-deploy.yml:142,182 `aws ecr describe-images`.   |
#   |                    | v2 is not an Ubuntu package (apt's `awscli` is the     |
#   |                    | unmaintained v1), so it is AWS's own installer zip,    |
#   |                    | pinned by version + checksum like the runner below.    |
#
# NOT installed, and the reason stated rather than left silent:
#   - The chromium BINARY. `playwright install --with-deps` downloads a build
#     keyed to the REPO's own Playwright version, which this image cannot know.
#     Baking one version would be a cache hit only by luck and a ~170 MB miss
#     otherwise — and on an EPHEMERAL runner the image is pulled per job, so a
#     baked browser trades a CDN download for an equal-sized registry pull. The
#     system LIBRARIES it needs are baked (they are version-stable and are the
#     slow half on a bare Ubuntu); the browser is not.
#   - `pg_isready`. It appears in S ci.yml:88-92's `options: --health-cmd`, but a
#     Docker healthcheck runs INSIDE the service container. Adding a postgres
#     client to the runner would be a toolchain entry with no evidence.
#   - QEMU / binfmt handlers (`binfmt-misc` in the inventory; G docker-image.yml:35
#     `docker/setup-qemu-action`). Not an image tool: the action registers
#     handlers in the HOST kernel, i.e. the Fly machine's, which no Dockerfile
#     line can provide. Whether that kernel accepts a privileged binfmt install
#     is verified on a live fleet machine, not here; until then that job stays
#     not-runnable in the manifest.
#   - The buildx / compose CLI plugins. Every Motir job that builds an image runs
#     `docker/setup-buildx-action` first, which installs buildx as the runner
#     user; no Motir job invokes `docker compose` (inventory, "Things that look
#     like gaps").
#
# ─── WHAT IS FIXED BY DECISION, NOT BY THIS FILE ─────────────────────────────
#
#   §7.2  The image is DIGEST-PINNED. Nothing here may float — the base is a
#         digest, the runner/Node/Docker are versions with checksums. A mutable
#         tag under a hostile workload is the supply-chain hole ephemerality was
#         bought to close.
#   §7.4  The entrypoint consumes a JIT CONFIG and never a registration token.
#         `config.sh` is DELETED from the extracted runner below, so the
#         container holds no registration capability at all — not "does not use
#         one", HAS none. Asserted mechanically by `smoke/assert-image.sh`.
#   §7.1  A JIT-config runner is ephemeral by construction: it takes exactly one
#         job, de-registers and exits. The exiting process is what Fly's
#         `auto_destroy: true` + `restart: no` turn into a destroyed Machine.
#
# ─── BUILD ───────────────────────────────────────────────────────────────────
#
#   docker build -f infra/ci-runner/Dockerfile -t motir-ci-runner:dev infra/ci-runner
#
# The build context is THIS DIRECTORY, not the repo root: the image contains
# nothing from motir-core's source tree, and a repo-root context would ship the
# whole checkout into a container that executes customer code.
#
# linux/amd64 only. Fly Machines are x86-64 and the fleet runs `performance-2x`
# in `iad` (§8, §11) — an arm64 leg would be an unpullable half of a manifest.

# ─────────────────────────────────────────────────────────────────────────────
# The pins. Every one is a digest or a version+checksum; `assert-image.sh`
# greps this file for a floating tag and fails the build if it finds one.
# ─────────────────────────────────────────────────────────────────────────────

# Ubuntu 24.04 — `ubuntu-latest` IS ubuntu-24.04, and §8's parity target is
# GitHub's `ubuntu-latest` on a PRIVATE repo. Resolved 2026-08-02.
ARG UBUNTU_DIGEST=sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

FROM ubuntu@${UBUNTU_DIGEST}

LABEL org.opencontainers.image.title="motir-ci-runner" \
      org.opencontainers.image.description="Ephemeral GitHub Actions runner for the Motir CI fleet (JIT config only, single job, self-destroying)." \
      org.opencontainers.image.source="https://github.com/moooon-B-V/motir-core" \
      org.opencontainers.image.licenses="GPL-3.0-only"

# The GitHub Actions runner. Pinned version + the SHA256 GitHub publishes in the
# release body, so a tampered or truncated download fails the BUILD.
#
# ⚠️ THIS PIN EXPIRES ON GITHUB'S SCHEDULE, NOT OURS. The runner runs with
# self-update off, and GitHub serves no job to a runner that is still behind 30
# days after a newer release came out: it connects, says "Runner version v<x> is
# deprecated and cannot receive messages", and exits, and the VM powers off with
# the job still queued (MOTIR-10706, v2.336.0). The daily health check's
# `runner-version-support` step reads this line on the default branch and fails
# 14 days before that cut-off (`lib/ciFleet/runnerVersionSupport.ts`); a bump
# then ships as a `runner-v*` release and a `ci-runner-ami-v*` AMI, both pinned.
ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40

# Node 22 — the version every job's `setup-node@v4` asks for. Pinned to the
# current v22 LTS line with nodejs.org's own SHASUMS256 entry.
ARG NODE_VERSION=22.23.2
ARG NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307

# Docker, from the STATIC binary tarball rather than the apt repo: the tarball is
# pinned by URL and checksummable, it ships dockerd + containerd + runc +
# docker-init + docker-proxy in one artifact, and it needs no systemd — which a
# container does not have anyway.
ARG DOCKER_VERSION=29.7.1
ARG DOCKER_SHA256=0fcea2a8b4d1b54ccc9010e3451b78504a369d414f37eb3bb79300e1b5c22ce6

# The Playwright version whose OWN `install-deps` list is used to pick the
# chromium system libraries. Asking Playwright beats hardcoding a package list
# from memory — this is the derive-from-evidence rule applied to a dependency
# that publishes its own answer. `^1.60.0` (both starters' package.json) resolves
# here today.
ARG PLAYWRIGHT_VERSION=1.62.1

# The AWS CLI v2, from AWS's VERSIONED installer zip (the unversioned URL floats).
# AWS publishes a PGP signature, not a checksum, so the SHA256 below was taken
# from the zip after its `.sig` verified against the AWS CLI Team key in AWS's
# install guide (fingerprint FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C).
# To move it: download the new zip and its `.sig`, `gpg --verify`, then
# `sha256sum` the zip.
ARG AWSCLI_VERSION=2.38.6
ARG AWSCLI_SHA256=66974301c11f8116a6cb96bf72acae57453734b61fa8dd3f56422de9eaab0e42

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# ─────────────────────────────────────────────────────────────────────────────
# Base OS packages
# ─────────────────────────────────────────────────────────────────────────────
# `iptables` is not optional: dockerd programs bridge NAT through it, and
# `services:` publishes `5432:5432` (S ci.yml:89-90) through exactly that path.
# `sudo` is parity — GitHub's `runner` user has passwordless sudo, and
# `playwright install --with-deps` shells out to it when not running as root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        ca-certificates \
        coreutils \
        curl \
        gh \
        git \
        gnupg \
        gzip \
        iptables \
        jq \
        locales \
        openssh-client \
        pipx \
        python3 \
        python3-venv \
        sudo \
        tar \
        unzip \
        uidmap \
        xz-utils \
        zip \
        zstd \
    && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────────────────────
# Node.js — installed INTO THE TOOL CACHE, not just onto PATH
# ─────────────────────────────────────────────────────────────────────────────
# `actions/setup-node@v4` looks in `/opt/hostedtoolcache/node/<version>/x64` for
# a version satisfying the requested range BEFORE it queries the manifest, and
# `check-latest` defaults to false — so a cached 22.x makes every job's
# setup-node step a cache HIT instead of a ~50 MB download. That download is the
# single most repeated avoidable cost in the starter's six jobs, and on a
# wall-clock-metered runner the customer pays for it.
#
# The `.complete` marker is REQUIRED, not decorative: the toolkit treats a
# version directory without it as a partial extraction and ignores it.
#
# The same install is symlinked onto PATH so `node`/`npm`/`npx`/`corepack` exist
# before any setup-node step runs — `pnpm/action-setup@v4` is ordered FIRST in
# every starter job (S ci.yml:39 before :40) and must not depend on setup-node
# having run.
RUN set -eux; \
    tools="/opt/hostedtoolcache/node/${NODE_VERSION}/x64"; \
    mkdir -p "${tools}"; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C "${tools}" --strip-components=1; \
    rm /tmp/node.tar.xz; \
    touch "/opt/hostedtoolcache/node/${NODE_VERSION}.complete"; \
    for b in node npm npx corepack; do ln -sf "${tools}/bin/${b}" "/usr/local/bin/${b}"; done; \
    node --version; \
    npm --version

# ─────────────────────────────────────────────────────────────────────────────
# Docker — for `services:` containers
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️ Read this against §7.6 ("no host filesystem, no Docker socket") before
# concluding it violates it. §7.6 forbids the CONTAINER reaching the HOST — a
# mounted host socket or host bind. This is a dockerd running INSIDE the Fly
# Machine's own Firecracker microVM, on that VM's own kernel, destroyed with it.
# The isolation boundary §7.6 buys is hardware virtualization at the VM edge, and
# nothing here crosses it: the socket is created inside the guest and no host
# path is mounted. The alternative — shipping no Docker — makes four of the
# starter's six jobs unrunnable, which is `notes.html` #200's exact failure
# shape: a component decision that contradicts the thing the fleet exists to do.
RUN set -eux; \
    curl -fsSLo /tmp/docker.tgz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz"; \
    echo "${DOCKER_SHA256}  /tmp/docker.tgz" | sha256sum -c -; \
    tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1; \
    rm /tmp/docker.tgz; \
    dockerd --version; \
    docker --version; \
    containerd --version; \
    runc --version

# ─────────────────────────────────────────────────────────────────────────────
# The AWS CLI v2 — for the deploy jobs that look up images and manifests
# ─────────────────────────────────────────────────────────────────────────────
# Installed where `ubuntu-latest` has it: `/usr/local/aws-cli`, with `aws` in
# `/usr/local/bin`. `aws --version` runs at build time, so a broken install
# fails the BUILD; `smoke/assert-image.sh` checks it again on the built image.
RUN set -eux; \
    curl -fsSLo /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip"; \
    echo "${AWSCLI_SHA256}  /tmp/awscliv2.zip" | sha256sum -c -; \
    unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2; \
    /tmp/awscliv2/aws/install; \
    rm -rf /tmp/awscliv2.zip /tmp/awscliv2; \
    aws --version | grep -F "aws-cli/${AWSCLI_VERSION} "

# ─────────────────────────────────────────────────────────────────────────────
# Playwright's chromium system libraries
# ─────────────────────────────────────────────────────────────────────────────
# The package list is ASKED FOR, not asserted: `playwright install-deps chromium`
# emits the apt set for the detected distro, so this layer tracks upstream
# instead of drifting from a list typed out once. On a bare Ubuntu that install
# is ~100 packages — on GitHub's far fatter `ubuntu-latest` most are already
# present, so NOT baking them is where the parity gap would actually open.
#
# The starter still runs `playwright install --with-deps chromium` at job time
# (S ci.yml:268); with these present that step is an apt no-op plus the
# version-matched browser download, which is the part no image can pre-empt.
RUN set -eux; \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium; \
    rm -rf /var/lib/apt/lists/* /root/.npm

# ─────────────────────────────────────────────────────────────────────────────
# The Actions runner
# ─────────────────────────────────────────────────────────────────────────────
# `installdependencies.sh` ships INSIDE the tarball and knows which libicu /
# libkrb5 / liblttng the .NET-based runner needs on THIS distro. Running it beats
# naming those packages here for the same reason the Playwright layer above asks
# rather than asserts — and it stays correct when RUNNER_VERSION moves.
#
# ⚠️ `config.sh` and `config.cmd` are DELETED. §7.4's guarantee is that the
# container holds no registration capability; deleting the script that consumes a
# registration token is the mechanical form of that promise, and
# `smoke/assert-image.sh` asserts their absence in the BUILT image rather than
# trusting this line. `run.sh` — the JIT path — is what remains.
RUN set -eux; \
    mkdir -p /home/runner/actions-runner; \
    cd /home/runner/actions-runner; \
    curl -fsSLo runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"; \
    echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c -; \
    tar -xzf runner.tar.gz; \
    rm runner.tar.gz; \
    ./bin/installdependencies.sh; \
    rm -rf /var/lib/apt/lists/*; \
    rm -f config.sh config.cmd; \
    test -x run.sh; \
    test ! -e config.sh

# ─────────────────────────────────────────────────────────────────────────────
# The `runner` user
# ─────────────────────────────────────────────────────────────────────────────
# The runner REFUSES to run as root without `RUNNER_ALLOW_RUNASROOT`, and setting
# that would also break parity: GitHub-hosted jobs run as an unprivileged
# `runner` user with passwordless sudo and docker-group membership, and customer
# workflows are written against that. Reproduce it exactly rather than papering
# over it with a root runner.
RUN set -eux; \
    groupadd --gid 1001 runner; \
    useradd --uid 1001 --gid 1001 --create-home --home-dir /home/runner --shell /bin/bash runner; \
    groupadd --system docker; \
    usermod -aG docker runner; \
    echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner; \
    chmod 0440 /etc/sudoers.d/runner; \
    mkdir -p /home/runner/actions-runner/_work; \
    chown -R runner:runner /home/runner /opt/hostedtoolcache

# `pipx install <tool>` puts its command in ~/.local/bin, which a GitHub-hosted
# runner has on PATH and a bare Ubuntu user does not (MOTIR-8884).
ENV PATH="/home/runner/.local/bin:${PATH}"

COPY --chmod=0755 entrypoint.sh /usr/local/bin/motir-ci-runner-entrypoint
# dockerd start + the whiteout-unpack proof the entrypoint runs (MOTIR-8821), and
# the runner hook that prints its outcome into the job log.
COPY --chmod=0755 start-dockerd.sh /usr/local/bin/motir-ci-runner-dockerd
COPY --chmod=0755 job-started.sh /usr/local/bin/motir-ci-runner-job-started.sh

# No runner ENV is set here on purpose. `PLAYWRIGHT_BROWSERS_PATH` stays at its
# default (see the not-installed note in the header), and
# `RUNNER_ALLOW_RUNASROOT` is deliberately NEVER set — the entrypoint drops to
# the `runner` user instead, which is what GitHub-hosted parity means.

WORKDIR /home/runner/actions-runner

# Runs as ROOT so it can start dockerd, then drops to `runner` to exec the
# runner itself. The container's whole life is one job: the entrypoint execs
# `run.sh`, `run.sh` exits when the job is done, and Fly's `auto_destroy: true`
# turns that exit into a destroyed Machine (§7.1).
ENTRYPOINT ["motir-ci-runner-entrypoint"]
