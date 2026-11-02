#!/usr/bin/env bash
#
# Boot proof for the Motir CI runner image (MOTIR-1978, acceptance criterion 5).
#
#   ./prove-boot.sh --image motir-ci-runner:smoke
#
# ── The fidelity ladder, and where it honestly stops ─────────────────────────
#
# The criterion asks for "the runner registers, takes exactly one job,
# de-registers and exits, proven at the highest fidelity reachable in CI". The
# highest fidelity reachable in CI is NOT the full loop, and the reason is not
# effort: registering requires a JIT config minted against a real runner group by
# an org token with `Self-hosted runners: write`, and BOTH are MOTIR-1919's
# manual deliverables, which have not landed. There is nothing to register
# against yet.
#
# What IS proven here, all of it against the real image:
#
#   1. The ENTRYPOINT's dockerd path works — dockerd starts and becomes ready
#      inside the container, through the same code a Fly Machine will run.
#   2. `run.sh` is actually EXEC'd, as the unprivileged `runner` user, with the
#      JIT config — i.e. the entrypoint → setpriv → run.sh wiring is real and not
#      a missing file or a permission error. Only GitHub's acceptance of the
#      config remains unproven.
#   3. A `services:` container works: `postgres:16-alpine` with a published port,
#      reachable from the runner host on `localhost:5432` — the exact shape of
#      the starters' test / e2e / acceptance jobs, and the single riskiest thing
#      about a fleet runner that is a container rather than a VM image.
#
# What is HANDED TO MOTIR-1928, explicitly rather than implied:
#
#   - Live registration against a real runner group with a real JIT config.
#   - "Takes exactly ONE job, de-registers, exits" observed end to end.
#   - The container being NON-RESIDENT afterwards (Fly `auto_destroy`), which is
#      a Machine-lifecycle property this image cannot demonstrate at all.
#   - Real p50/p95 boot latency against §6, including this image's pull time.

set -euo pipefail

IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image needs a reference}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "${IMAGE}" ] || { echo "--image is required" >&2; exit 2; }

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; fails=$((fails + 1)); }

cleanup() { docker rm -f motir-runner-boot motir-runner-svc >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# ─────────────────────────────────────────────────────────────────────────────
# 1 + 2 — the real entrypoint: dockerd up, then run.sh exec'd with the JIT config
# ─────────────────────────────────────────────────────────────────────────────
# ── Two flags that exist ONLY because this runs DinD on a GitHub-hosted runner.
# Neither is used on Fly, and neither weakens what is being proven:
#
#   --privileged        a container needs it to run dockerd. A Fly Machine is a
#                       Firecracker microVM that already owns its kernel, so it
#                       is root in its own VM by construction (Dockerfile, §7.6).
#   -v /var/lib/docker  an anonymous VOLUME for the inner daemon's data dir.
#                       Without it that dir sits on the outer daemon's overlay2
#                       rootfs, and overlay-on-overlay fails at container-create
#                       with `fstype: overlay … err: invalid argument` — which is
#                       exactly how this check first failed. The volume is real
#                       filesystem, which is what the inner overlay2 needs.
#
# ⚠️ That second flag is a statement about THE TEST HOST, not about the image.
# On Fly the Machine's rootfs IS a real ext4 block device, so `/var/lib/docker`
# is already backed by real filesystem and overlay2 works with nothing added.
# The volume reproduces the Fly condition here rather than papering over a
# defect — but it does mean CI cannot prove Fly's storage stack, only that the
# image's docker works when its data dir is real. MOTIR-1928 sees the real one.
#
# The JIT config is deliberate garbage. It gets far enough to prove the wiring;
# GitHub rejecting it is the expected outcome and is the line where CI stops.
echo "== 1/2 · entrypoint: dockerd, then run.sh as the runner user =="
docker run -d --name motir-runner-boot --privileged -v /var/lib/docker \
  -e ACTIONS_RUNNER_INPUT_JITCONFIG="$(printf 'motir-ci-not-a-real-jit-config' | base64 -w0)" \
  -e MOTIR_INTENT_ID=smoke-intent \
  -e MOTIR_WORKFLOW_JOB_ID=0 \
  -e MOTIR_RUNNER_LABEL=motir-smoke \
  -e ACTIONS_RUNNER_CONFIG_ARGS=--no-default-labels \
  "${IMAGE}" >/dev/null

# The container is short-lived by design — it execs run.sh, which fails on the
# garbage config and exits. Wait for it either way rather than racing its logs.
timeout 120 docker wait motir-runner-boot >/dev/null 2>&1 || true
boot_log="$(docker logs motir-runner-boot 2>&1 || true)"
printf '%s\n' "${boot_log}" | sed 's/^/    | /'

grep -q 'starting dockerd'                   <<<"${boot_log}" && ok "dockerd was started by the entrypoint" || fail "the entrypoint never started dockerd"
grep -q 'dockerd ready'                      <<<"${boot_log}" && ok "dockerd became ready inside the container" || fail "dockerd never became ready"
grep -q 'exec run.sh'                        <<<"${boot_log}" && ok "the entrypoint reached the run.sh exec" || fail "the entrypoint never reached run.sh"
grep -q 'No such file or directory'           <<<"${boot_log}" && fail "run.sh could not be executed (missing file)" || ok "run.sh was found and executed"
grep -qi 'permission denied'                  <<<"${boot_log}" && fail "run.sh hit a permission error as the runner user" || ok "no permission error dropping to the runner user"
grep -qi 'must not run with sudo'             <<<"${boot_log}" && fail "the runner refused the user it was given" || ok "the runner accepted the unprivileged user"

# The strongest thing CI can claim, and it is stronger than "run.sh started":
# the runner BINARY ran and CONSUMED the JIT config. On the garbage config above
# it emits a JSON parse error and exits — i.e. it base64-decoded the value the
# entrypoint handed it and tried to parse the result. Only GitHub's ACCEPTANCE
# of a real config is left, which is MOTIR-1928's.
#
# Matched on the runner's own lifecycle markers rather than the parse message,
# which is .NET-formatted text that a runner bump could reword.
grep -qE 'Runner listener|Exiting runner' <<<"${boot_log}" \
  && ok "the runner binary ran and consumed the JIT config" \
  || fail "no runner lifecycle output — run.sh started but the runner never did"

echo "  note  live registration / one-job / de-register is NOT proven here — MOTIR-1928 owns it (see this file's header)"

# ─────────────────────────────────────────────────────────────────────────────
# 3 — a `services:` container, the way the starters' workflows use one
# ─────────────────────────────────────────────────────────────────────────────
# S ci.yml:81-92 + :311 — `postgres:16-alpine`, `ports: - 5432:5432`, and a
# DATABASE_URL pointed at `localhost:5432`. The assertion is the one that
# matters for those jobs: is the published port reachable FROM THE RUNNER HOST.
# bash's /dev/tcp is used rather than a postgres client because adding
# `pg_isready` to the image would be a toolchain entry with no evidence behind
# it (Dockerfile header, "NOT installed").
echo
echo "== 3 · a services: container reachable on localhost:5432 =="
docker run -d --name motir-runner-svc --privileged -v /var/lib/docker --entrypoint '' "${IMAGE}" \
  bash -c 'motir-ci-runner-dockerd && sleep infinity' >/dev/null

svc_ok=1
docker exec motir-runner-svc bash -c '
  set -e
  # The image the first production window died on (MOTIR-8821): its layers
  # contain overlay whiteouts (`etc/alternatives/.wh.pager.1.gz`), which a Machine
  # whose storage refuses mknod/xattr cannot unpack. Pulled through the SAME
  # `motir-ci-runner-dockerd` the entrypoint runs, with no MOTIR_RUNNER_SKIP_DOCKER.
  for _ in $(seq 1 120); do docker version >/dev/null 2>&1 && break; sleep 1; done
  docker version >/dev/null
  docker pull pgvector/pgvector:pg18 >/dev/null
  docker run --rm pgvector/pgvector:pg18 true
  docker run -d --name pg -p 5432:5432 \
    -e POSTGRES_USER=nextjs_prisma_vercel_starter \
    -e POSTGRES_PASSWORD=nextjs_prisma_vercel_starter \
    -e POSTGRES_DB=nextjs_prisma_vercel_starter \
    postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then exit 0; fi
    sleep 1
  done
  echo "postgres:16-alpine never became reachable on localhost:5432" >&2
  docker logs pg 2>&1 | tail -30 >&2
  exit 1
' || svc_ok=0

if [ "${svc_ok}" -eq 1 ]; then
  ok "dockerd (via motir-ci-runner-dockerd) pulled a whiteout-bearing image; postgres:16-alpine ran and is reachable on localhost:5432"
else
  fail "a services: container is NOT usable — four of the starter's six jobs cannot run on this image"
fi

echo
[ "${fails}" -eq 0 ] && { echo "boot proof passed"; exit 0; }
echo "${fails} check(s) failed" >&2
exit 1
