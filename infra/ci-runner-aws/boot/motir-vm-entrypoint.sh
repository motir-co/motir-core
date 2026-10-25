#!/usr/bin/env bash
#
# The AWS VM's ExecStart (MOTIR-9419): run what the boot mode says, and nothing
# else.
#
# `motir-runner-prepare` has parsed user-data by now and written the mode to
# /run/motir/mode. `exec` hands the unit to the mode's entrypoint, so its exit
# is the unit's exit and `ExecStopPost` powers the VM off after it:
#
#   ci         motir-ci-runner-entrypoint — `infra/ci-runner/entrypoint.sh`,
#              installed unchanged: one JIT-config GitHub job.
#   container  motir-container-entrypoint — one digest-pinned OCI image, run
#              once with the run's environment (a hosted agent run).
#
# Any other mode, or no mode file, is a boot that cannot be trusted: exit
# non-zero and let the unit power the VM off.

set -euo pipefail

MODE_FILE=/run/motir/mode

die() { printf '[motir-vm-entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

[ -r "${MODE_FILE}" ] || die "no boot mode at ${MODE_FILE} — motir-runner-prepare did not finish"
mode="$(cat "${MODE_FILE}")"

case "${mode}" in
  ci) exec /usr/local/bin/motir-ci-runner-entrypoint ;;
  container) exec /usr/local/bin/motir-container-entrypoint ;;
  *) die "unknown boot mode in ${MODE_FILE}" ;;
esac
