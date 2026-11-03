#!/usr/bin/env bash
#
# The runner image's TOOL LIST (MOTIR-10290) — every command name a job step on
# this image can call, printed comma-joined on one line, sorted, deduplicated.
#
#   ./list-tools.sh --image motir-ci-runner:x
#
# `runner-image.yml` stamps the output onto the published image as the OCI label
# `co.motir.ci-runner.tools`, and re-measures the image it pushed BY DIGEST to
# prove the label describes those bytes. The fleet readiness verdict reads the
# label from the image `MOTIR_RUNNER_IMAGE` pins and judges each private
# repository's jobs against it (`lib/ciFleet/runnerImageTools.ts`), so pinning a
# new image updates the comparison with no list kept by hand.
#
# MEASURED, NOT DECLARED: `compgen -c` is bash's own answer to "what can I run" —
# every executable on PATH, plus builtins and keywords — taken as the `runner`
# user a job runs as, with no profile or rc file, the way the Actions runner
# starts a `run:` step's shell. `LC_ALL=C` makes the order byte-stable.

set -euo pipefail

IMAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="${2:?--image needs a reference}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "${IMAGE}" ] || { echo "usage: $0 --image <ref>" >&2; exit 2; }

docker run --rm --entrypoint '' --user runner "${IMAGE}" \
  bash --noprofile --norc -c 'compgen -c' \
  | tr -d '\r' \
  | grep -E '^[A-Za-z0-9_][A-Za-z0-9._+-]*$' \
  | LC_ALL=C sort -u \
  | paste -sd, -
