# The Motir CI runner image

The container every ephemeral fleet runner boots from — the thing
`MOTIR_RUNNER_IMAGE` names and that
`lib/orchestrator/adapters/fly/flyMachines.ts` refuses to start without.

| File                    | What it is                                                                  |
| ----------------------- | --------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its header carries the toolchain derivation + evidence table.    |
| `entrypoint.sh`         | dockerd → drop to `runner` → `exec run.sh --jitconfig`. One job, then exit. |
| `start-dockerd.sh`      | Starts dockerd and proves it can unpack a whiteout layer (MOTIR-8821).      |
| `job-started.sh`        | Runner hook: prints the dockerd storage outcome into the job log.           |
| `smoke/assert-image.sh` | The mechanical §7.2 / §7.4 assertions, on sources and on the built image.   |
| `smoke/prove-boot.sh`   | Boots the real image; proves dockerd + `run.sh` + a `services:` container.  |

Built, asserted and proven by `.github/workflows/runner-image.yml` on every
pull request; published by `.github/workflows/release-runner-image.yml` on a
`runner-v*` tag. `tests/ciFleet/ciRunnerImage.test.ts` guards the sources.

## Using it

The fleet consumes a **digest**, never a tag:

```
MOTIR_RUNNER_IMAGE=ghcr.io/motir-co/motir-ci-runner@sha256:<64 hex>
```

§7.2 of `docs/decisions/ci-runner-fleet.md` requires it: these containers run
agent-authored customer code, and a mutable tag could change what executes
between the boot decision and the pull. The release workflow prints the digest
into its job summary and pulls the image back by it before reporting.

MOTIR-1979 sets it in the deployment, alongside `FLY_FLEET_API_TOKEN` and
`FLY_FLEET_APP` (see `.env.example`).

## Boot contract

The orchestrator puts these on the Machine
(`lib/services/ciRunnerBootService.ts` → `buildSpec()`):

| Variable                         | Role                                              |
| -------------------------------- | ------------------------------------------------- |
| `ACTIONS_RUNNER_INPUT_JITCONFIG` | **Required.** The base64 JIT config. §7.4.        |
| `ACTIONS_RUNNER_CONFIG_ARGS`     | `--no-default-labels`; not forwarded — see below. |
| `MOTIR_RUNNER_LABEL`             | The single §M-compliant fleet label.              |
| `MOTIR_INTENT_ID`                | Attribution, echoed into the container log.       |
| `MOTIR_WORKFLOW_JOB_ID`          | Attribution, echoed into the container log.       |

`ACTIONS_RUNNER_CONFIG_ARGS` is deliberately not forwarded: it is a `config.sh`
flag and this image has no `config.sh`. The guarantee it restates — no default
labels — is already made at mint time, because a JIT config's `labels` array is
the runner's complete label set and GitHub adds no defaults to a JIT runner.

## dockerd storage (MOTIR-8821)

`start-dockerd.sh` does not trust a daemon that merely answers. It loads a
two-layer image whose second layer deletes a file (an overlay whiteout) and
creates a container from it, and tries storage candidates in order until that
works: `default` (containerd store + overlayfs), `overlay2` (classic graph
driver), `vfs`. A boot where none works fails. The winning candidate is printed
into every job log by the runner's job-started hook.

To measure a Machine, boot the image with `MOTIR_RUNNER_DOCKER_STORAGE=<candidate>`
to force one candidate; the boot log shows which are refused and why.

On a Fly Machine's root filesystem both overlay candidates are refused and only
`vfs` works, which copies every layer and fills the disk (MOTIR-8821, MOTIR-8839).
So the orchestrator gives each CI runner its own Fly volume at `/var/lib/docker`
(`MOTIR_CI_DOCKER_VOLUME_GB`, default 20, `0` to turn it off), where `overlay2`
works. The Fly adapter creates it with the machine, deletes it at teardown, and
the fleet reconciler sweeps any left behind. The job-started hook prints
`runner disk:` lines (`df -h / /var/lib/docker`) into every job log.

## Container DNS (MOTIR-8899)

`start-dockerd.sh` starts dockerd with `--dns=1.1.1.1 --dns=8.8.8.8`. Without it
a container (and each `RUN` step of the daemon's own builder, which is what
`flyctl deploy --local-only` uses) inherits the Machine's Fly resolver, an IPv6
address the IPv4 bridge cannot reach, and `apt-get` fails with
`Temporary failure resolving`. Set `MOTIR_RUNNER_DOCKER_DNS="<ip> <ip>"` on a
Machine to try other resolvers; the job log's storage line names the ones in use.

## What is not proven in CI

`smoke/prove-boot.sh` proves the entrypoint's dockerd path, that `run.sh` is
exec'd as the unprivileged `runner` user with the JIT config, and that a
`services: postgres:16-alpine` container is reachable on `localhost:5432` the
way the starters' jobs need.

It does **not** prove live registration, "takes exactly one job, de-registers,
exits", or non-residency after the job — those need a JIT config minted against
a real runner group by an org token with `Self-hosted runners: write`, both of
which are **MOTIR-1919**'s manual deliverables and have not landed. **MOTIR-1928
owns that proof**, together with the real p50/p95 boot latency against §6 (this
image's pull time is a term in it — the compressed size is printed by the build
workflow's job summary for exactly that attribution).

It also does not prove **Fly's** storage stack. CI runs the image as a container
on a GitHub-hosted runner, where `/var/lib/docker` would land on the outer
daemon's overlay2 rootfs and overlay-on-overlay fails at container create; the
proof mounts a volume there to reproduce the real-filesystem condition a Fly
Machine has by construction (its rootfs is an ext4 block device). So what CI
shows is that the image's Docker works when its data dir is real — the Fly one
is MOTIR-1928's. The entrypoint logs the selected storage driver at boot so that
diagnosis reads off the boot log rather than off a customer's failed build.

## Local build

```sh
docker build -f infra/ci-runner/Dockerfile -t motir-ci-runner:dev infra/ci-runner
infra/ci-runner/smoke/assert-image.sh --image motir-ci-runner:dev
infra/ci-runner/smoke/prove-boot.sh   --image motir-ci-runner:dev   # needs --privileged
```

The build context is this directory, not the repo root: the image contains
nothing from motir-core's tree, and a root context would ship the whole checkout
into a container that executes customer code.

## Bumping a pin

Every pin is an `ARG` at the top of the `Dockerfile` with a checksum beside it.
To move one, update both, then let CI rebuild — `assert-image.sh` fails the
build if a version stops being exact or a download stops being verified.

- **Actions runner** — `RUNNER_VERSION` + `RUNNER_SHA256` from the release body
  of <https://github.com/actions/runner/releases>. This one is not optional
  upkeep: the runner has self-update off, and GitHub stops serving jobs to a
  runner still behind 30 days after a newer release (MOTIR-10706). The daily
  health check's `runner-version-support` step fails 14 days before that, naming
  the deadline; bump the pin, release `runner-v*` and `ci-runner-ami-v*`, and
  pin both.
- **Ubuntu** — `UBUNTU_DIGEST`. `ubuntu-latest` is what §8's parity target
  tracks, so move this when GitHub moves `ubuntu-latest`, not before.
- **Node** — `NODE_VERSION` + `NODE_SHA256` from `nodejs.org/dist/v<x>/SHASUMS256.txt`.
  Stay on the major the starters' `setup-node` asks for (22).
- **Docker / Playwright** — `DOCKER_VERSION` + `DOCKER_SHA256` (the static
  tarball) and `PLAYWRIGHT_VERSION` (whose own `install-deps` list is used).
- **AWS CLI v2** — `AWSCLI_VERSION` + `AWSCLI_SHA256` (AWS's versioned installer
  zip). AWS publishes a PGP signature rather than a checksum: download
  `awscli-exe-linux-x86_64-<x>.zip` and its `.sig`, `gpg --verify` it against
  the AWS CLI Team key in AWS's install guide, then take the zip's `sha256sum`.
  The AWS image's build reads the same two ARGs. Its evidence is the AWS deploy
  jobs on `vars.MOTIR_RUNNER`, which call the CLI with no setup step:
  motir-ai `.github/workflows/ci.yml:925` (`aws ecr describe-images`, and
  `aws ssm get-parameter` at :898) and motir-gateway
  `.github/workflows/aws-deploy.yml:142` (`aws ecr describe-images`, again at
  :182, and `aws ssm get-parameter` at :109) — MOTIR-10293.

Adding a toolchain entry is not a free choice: the derivation rule is that the
image carries the **union of what the two starters' workflows actually install**,
with the file:line evidence recorded. An entry with no evidence line does not
belong in the image; a starter workflow that starts installing something new
does.
