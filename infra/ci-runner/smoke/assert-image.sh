#!/usr/bin/env bash
#
# Mechanical assertions for the Motir CI runner image (MOTIR-1978).
#
# The card's acceptance criteria say "assert by grep, not by eye" and "asserted
# mechanically" — this is that assertion, run by `runner-image.yml` on every pull
# request AND on the release lane before anything is pushed.
#
#   ./assert-image.sh --sources                 static checks, no Docker needed
#   ./assert-image.sh --image motir-ci-runner:x  the above plus runtime checks
#
# ── On scope, so the comment-stripping is not read as a loophole ─────────────
#
# The §7.4 criterion is that `config.sh` and `registration` appear nowhere in THE
# IMAGE or ITS ENTRYPOINT. Two different objects, checked two different ways:
#
#   - THE IMAGE — checked on the built filesystem (`--image`): no `config.*`
#     anywhere under the runner directory. That is the real guarantee and it is
#     checked against bytes, not against source.
#   - THE ENTRYPOINT — checked on its EXECUTABLE lines, comments stripped. The
#     Dockerfile has to name `config.sh` in order to `rm` it, and both files have
#     to explain WHY the registration path is absent; a check that failed on the
#     explanation would force the code to stop documenting its own security
#     property. So comments are excluded and the exclusion is asserted narrowly:
#     the only `config.sh` permitted in a non-comment Dockerfile line is on an
#     `rm` line, and `registration` is permitted nowhere at all.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "${HERE}")"
DOCKERFILE="${ROOT}/Dockerfile"
ENTRYPOINT="${ROOT}/entrypoint.sh"

IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sources) shift ;;
    --image) IMAGE="${2:?--image needs a reference}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

fails=0
ok()   { printf '  ok    %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; fails=$((fails + 1)); }

# Non-comment, non-blank lines of a shell/Dockerfile source.
code_of() { sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$1"; }

echo "== static assertions =="

# ── §7.2: nothing floats ─────────────────────────────────────────────────────
# The digest may be inline or reach FROM through an ARG (it does — so the value
# is bumpable in one place and overridable at build time). Either is digest
# form; what is forbidden is the TAG form, `FROM image:something`. The ARG's own
# value is checked to be 64 hex by the pin loop below, so the indirection loses
# nothing.
from_line=$(grep -E '^FROM[[:space:]]' "${DOCKERFILE}" | head -1)
if [[ "${from_line}" =~ @(sha256:[0-9a-f]{64}|\$\{[A-Z0-9_]+\})[[:space:]]*$ ]]; then
  ok "FROM is digest-pinned (${from_line})"
else
  fail "FROM is not digest-pinned (§7.2 requires a sha256 digest, not a tag): ${from_line}"
fi

if code_of "${DOCKERFILE}" | grep -nE ':latest|:stable|:edge|:main'; then
  fail "a floating tag appears in the Dockerfile"
else
  ok "no floating tag (:latest / :stable / :edge / :main) in the Dockerfile"
fi

# Every pin is a real pin: each *_SHA256 is 64 hex, each *_VERSION is numeric.
# ⚠️ `[A-Z0-9_]+`, WITH the digits — `RUNNER_SHA256` has one, and a name pattern
# without it silently skips every checksum ARG while still reporting green.
pins=0
while IFS= read -r line; do
  pins=$((pins + 1))
  name="${line%%=*}"; value="${line#*=}"
  case "${name}" in
    *_SHA256|UBUNTU_DIGEST)
      if [[ "${value}" =~ ^(sha256:)?[0-9a-f]{64}$ ]]; then ok "${name} is a 64-hex digest"
      else fail "${name}='${value}' is not a 64-hex digest"; fi ;;
    *_VERSION)
      if [[ "${value}" =~ ^[0-9]+(\.[0-9]+)+$ ]]; then ok "${name}=${value} is an exact version"
      else fail "${name}='${value}' is not an exact version"; fi ;;
  esac
done < <(grep -oE '^ARG[[:space:]]+[A-Z0-9_]+=[^[:space:]]+' "${DOCKERFILE}" | sed -E 's/^ARG[[:space:]]+//')

# The count guard: without it every assertion above passes vacuously the moment
# the pattern stops matching, which is exactly how the digit bug hid.
if [ "${pins}" -ge 10 ]; then
  ok "found all ${pins} pinned ARGs"
else
  fail "only ${pins} pinned ARG(s) parsed — the pin checks above are passing vacuously"
fi

# Every download in the file is checksum-verified. A `curl` with no matching
# `sha256sum -c` in the same RUN is an unpinned artifact wearing a pinned file's
# clothes, which is exactly what §7.2 is about.
curls=$(code_of "${DOCKERFILE}" | grep -c 'curl -fsSLo' || true)
sums=$(code_of "${DOCKERFILE}" | grep -c 'sha256sum -c -' || true)
if [ "${curls}" -eq "${sums}" ] && [ "${curls}" -gt 0 ]; then
  ok "all ${curls} downloads are checksum-verified"
else
  fail "${curls} download(s) but ${sums} checksum check(s) — every download must be verified"
fi

# ── §7.4: no registration capability ─────────────────────────────────────────
# Two permitted shapes: the `rm` that deletes it, and the build-time `test ! -e`
# that fails the BUILD if the rm ever stops applying. Anything else is a use.
if code_of "${DOCKERFILE}" | grep 'config\.sh' | grep -qvE 'rm -f|test ! -e'; then
  fail "the Dockerfile USES config.sh rather than only removing it (§7.4)"
else
  ok "the Dockerfile only removes config.sh, never uses it"
fi

for f in "${DOCKERFILE}" "${ENTRYPOINT}"; do
  if code_of "${f}" | grep -qi 'registration'; then
    fail "$(basename "${f}") contains 'registration' in executable code (§7.4)"
  else
    ok "$(basename "${f}") has no 'registration' in executable code"
  fi
done

if code_of "${ENTRYPOINT}" | grep -q 'config\.sh'; then
  fail "the entrypoint references config.sh (§7.4)"
else
  ok "the entrypoint never references config.sh"
fi

if code_of "${ENTRYPOINT}" | grep -q 'ACTIONS_RUNNER_INPUT_JITCONFIG'; then
  ok "the entrypoint consumes ACTIONS_RUNNER_INPUT_JITCONFIG"
else
  fail "the entrypoint does not read ACTIONS_RUNNER_INPUT_JITCONFIG (the boot contract)"
fi

# The exec spans continuation lines, so the check is on the joined command, not
# on any single line. `exec` (not a background process) is the load-bearing part:
# run.sh exiting must BE the container exiting (§7.1).
entry_joined=$(code_of "${ENTRYPOINT}" | tr '\n' ' ' | sed 's/\\ / /g')
if grep -qE 'exec setpriv .*run\.sh --jitconfig' <<<"${entry_joined}"; then
  ok "the entrypoint execs run.sh --jitconfig as the unprivileged runner user"
else
  fail "the entrypoint does not exec run.sh --jitconfig"
fi

# `setpriv` keeps root's environment, so the drop must hand the runner its own
# HOME / USER / LOGNAME or every step inherits `HOME=/root` (MOTIR-8820).
for assignment in HOME=/home/runner USER=runner LOGNAME=runner; do
  if grep -qE "exec setpriv .*env .*${assignment} .*run\.sh --jitconfig" <<<"${entry_joined}"; then
    ok "the privilege drop sets ${assignment}"
  else
    fail "the privilege drop does not set ${assignment} — steps would inherit root's"
  fi
done

if code_of "${DOCKERFILE}" | grep -q 'RUNNER_ALLOW_RUNASROOT'; then
  fail "RUNNER_ALLOW_RUNASROOT is set — the runner must drop to the unprivileged 'runner' user"
else
  ok "RUNNER_ALLOW_RUNASROOT is never set"
fi

if [ -z "${IMAGE}" ]; then
  echo
  [ "${fails}" -eq 0 ] && { echo "static assertions passed"; exit 0; }
  echo "${fails} assertion(s) failed" >&2; exit 1
fi

echo
echo "== runtime assertions against ${IMAGE} =="

# `--entrypoint ''` because the image's entrypoint boots a runner; these checks
# interrogate the filesystem it boots FROM.
inspect() { docker run --rm --entrypoint '' "${IMAGE}" bash -lc "$1"; }

# §7.4, on the built filesystem rather than on source.
if inspect 'ls /home/runner/actions-runner/config.sh /home/runner/actions-runner/config.cmd' >/dev/null 2>&1; then
  fail "config.sh / config.cmd EXIST in the image (§7.4)"
else
  ok "no config.sh / config.cmd in the image"
fi

# Captured rather than piped, for the same pipefail reason as the boot check
# below: `find /` exits non-zero on unreadable paths, which under pipefail would
# make an EMPTY result and a FAILED search indistinguishable.
stray=$(inspect 'find / -xdev \( -name "config.sh" -o -name "config.cmd" \) 2>/dev/null | head -5' || true)
if [ -n "${stray}" ]; then
  printf '%s\n' "${stray}" | sed 's/^/        | /' >&2
  fail "a config.sh / config.cmd exists somewhere in the image (§7.4)"
else
  ok "no config.sh / config.cmd anywhere on the image filesystem"
fi

if inspect 'test -x /home/runner/actions-runner/run.sh'; then
  ok "run.sh is present and executable"
else
  fail "run.sh is missing — the JIT path has nothing to exec"
fi

# The environment a job step actually gets (MOTIR-8820). Every check above runs
# as root; this one runs through the entrypoint's OWN drop — the same `setpriv`
# flags and the same `env` assignments, read from the entrypoint BAKED INTO THE
# IMAGE rather than restated — and does what `actions/checkout` does first: write
# global git config. An image built without the assignments fails here.
drop_env=$(inspect 'cat /usr/local/bin/motir-ci-runner-entrypoint' \
  | sed -e 's/[[:space:]]*#.*$//' | tr '\n' ' ' | sed 's/\\ / /g' \
  | grep -oE 'exec setpriv .*run\.sh' | grep -oE '(HOME|USER|LOGNAME)=[^ ]+' | tr '\n' ' ' || true)
as_runner=$(inspect "setpriv --reuid=runner --regid=runner --init-groups env ${drop_env} \
  bash -c 'id -un; echo \"\$HOME\"; git config --global user.name probe && git config --global --get user.name'" 2>&1 || true)
if [ "${as_runner}" = "$(printf 'runner\n/home/runner\nprobe')" ]; then
  ok "a step runs as runner with HOME=/home/runner and can write global git config"
else
  printf '%s\n' "${as_runner}" | sed 's/^/        | /' >&2
  fail "a step after the privilege drop is not runner with a writable HOME=/home/runner"
fi

# The derived toolchain, checked as present rather than assumed.
for bin in node npm npx corepack git jq curl unzip zip tar docker dockerd containerd runc setpriv sudo gh gcc make python3 pipx aws; do
  if inspect "command -v ${bin} >/dev/null"; then ok "${bin} on PATH"
  else fail "${bin} is missing from the image"; fi
done

# The tools baked for Motir's own private repositories (MOTIR-8710): each must
# RUN in the built image, not merely sit on PATH — a broken package link or a
# missing shared library is exactly what `command -v` cannot see.
for check in 'gh --version' 'gcc --version' 'make --version' 'python3 --version' 'pipx --version' 'aws --version'; do
  if inspect "${check} >/dev/null"; then ok "\`${check}\` exits 0"
  else fail "\`${check}\` fails in the built image"; fi
done

# The AWS deploy jobs (MOTIR-10293) get the CLI the Dockerfile pins, not merely
# some `aws`: the version is read from the Dockerfile's ARG, never restated.
awscli_pin=$(grep -E '^ARG AWSCLI_VERSION=' "${DOCKERFILE}" | head -1 | cut -d= -f2-)
awscli_got=$(inspect 'aws --version' 2>&1 || true)
if [ -n "${awscli_pin}" ] && grep -qF "aws-cli/${awscli_pin} " <<<"${awscli_got}"; then
  ok "aws is the pinned AWS CLI ${awscli_pin}"
else
  printf '%s\n' "${awscli_got}" | sed 's/^/        | /' >&2
  fail "aws is not the pinned AWS CLI '${awscli_pin}'"
fi

# cgo is the reason build-essential is here (motir-gateway's go-sqlite3): a C
# toolchain that cannot compile and link a trivial program does not serve it.
if inspect 'printf "int main(void){return 0;}\n" > /tmp/t.c && gcc -o /tmp/t /tmp/t.c && /tmp/t'; then
  ok "gcc compiles and links a C program"
else
  fail "gcc cannot compile and link a C program — cgo builds would fall back to CGO_ENABLED=0"
fi

if inspect 'node --version | grep -q "^v22\."'; then
  ok "node is v22 (setup-node's requested major)"
else
  fail "node is not v22 — every starter job asks for node-version: 22"
fi

# The tool cache is the difference between a setup-node cache hit and a download
# on every job, which is the parity cost this image exists to remove.
if inspect 'v=$(node -p "process.versions.node"); test -d "/opt/hostedtoolcache/node/${v}/x64" && test -f "/opt/hostedtoolcache/node/${v}.complete"'; then
  ok "node is registered in the hostedtoolcache with its .complete marker"
else
  fail "node is not a usable hostedtoolcache entry — setup-node will re-download it every job"
fi

if inspect 'id -u runner >/dev/null && id -nG runner | tr " " "\n" | grep -qx docker'; then
  ok "the runner user exists and is in the docker group"
else
  fail "the runner user is missing or cannot reach the docker socket"
fi

if inspect 'sudo -n -u runner true 2>/dev/null || grep -q "runner ALL=(ALL) NOPASSWD:ALL" /etc/sudoers.d/runner'; then
  ok "the runner user has passwordless sudo (ubuntu-latest parity)"
else
  fail "the runner user has no passwordless sudo — playwright install --with-deps will fail"
fi

# Fail-fast on a missing credential: the boot contract's one required variable.
#
# ⚠️ The output is CAPTURED, not piped. `set -o pipefail` is on and this
# `docker run` is SUPPOSED to exit non-zero, so `docker run … | grep -q …`
# reports the pipeline's status — the container's failure — rather than the
# grep's match, and the check fails whenever it should pass. That is exactly how
# this assertion failed on its first CI run while the behaviour it tests was
# correct all along.
boot_out=$(docker run --rm "${IMAGE}" 2>&1 || true)
boot_status=$(docker run --rm "${IMAGE}" >/dev/null 2>&1; echo $?)

if grep -q 'ACTIONS_RUNNER_INPUT_JITCONFIG' <<<"${boot_out}"; then
  ok "boot without a JIT config names the missing variable"
else
  printf '%s\n' "${boot_out}" | sed 's/^/        | /' >&2
  fail "boot without ACTIONS_RUNNER_INPUT_JITCONFIG did not name it in the error"
fi

if [ "${boot_status}" -ne 0 ]; then
  ok "boot without a JIT config exits non-zero"
else
  fail "boot without a JIT config exited 0 — the container would idle to its timeout, billed"
fi

# Deliberately run WITHOUT `--privileged` and WITHOUT MOTIR_RUNNER_SKIP_DOCKER:
# the credential check sits BEFORE the dockerd block precisely so a
# configuration mistake fails in a second instead of after a 30s dockerd
# timeout. This asserts that ORDER, which is the only reason the check is first.
if grep -q 'starting dockerd' <<<"${boot_out}"; then
  fail "dockerd was started before the JIT config was validated — a config mistake now costs a boot timeout"
else
  ok "the credential is validated BEFORE dockerd is started"
fi

echo
[ "${fails}" -eq 0 ] && { echo "all assertions passed"; exit 0; }
echo "${fails} assertion(s) failed" >&2
exit 1
