#!/usr/bin/env bash
#
# The AWS VM's exit report (MOTIR-10706): the unit's first ExecStopPost, run as
# root once the entrypoint has exited and BEFORE the power-off.
#
# A VM's whole life is one unit, and ExecStopPost powers it off however the
# entrypoint ended. That made a runner GitHub REFUSED indistinguishable from one
# that ran its job: both were an instance that stopped. On 2026-11-08 every
# runner of the AWS fleet connected, printed "Runner version v2.336.0 is
# deprecated and cannot receive messages", exited and powered off about twenty
# seconds after boot, with every job still queued, and nothing on the machine
# said that no job had been taken.
#
# So this prints ONE line, to the console `aws ec2 get-console-output` reads,
# saying which it was. The job-started hook (`infra/ci-runner/job-started.sh`)
# writes /run/motir-ci-runner-job/started when GitHub hands the runner a job; a
# CI-mode exit with no marker is the runner leaving WITHOUT a job, and the line
# says so, with the unit's result and where to look next.
#
# It never fails: the unit runs it with a `-` prefix, and it exits 0 on every
# path besides, so a report can never stand between the VM and its power-off.
# It reads only files this boot wrote and the result systemd hands every
# ExecStopPost (SERVICE_RESULT, EXIT_CODE, EXIT_STATUS) — never the env file or
# a user-data value.

set -uo pipefail

# RUN_DIR is /run on every boot; it is a variable only so the test can drive the
# script against a scratch directory (`tests/ciFleet/awsRunnerAmi.test.ts`).
RUN_DIR="${MOTIR_RUNNER_RUN_DIR:-/run}"
MODE_FILE="${RUN_DIR}/motir/mode"
JOB_MARKER="${RUN_DIR}/motir-ci-runner-job/started"

log() { printf '[motir-runner-exit] %s\n' "$*"; }

mode="$(cat "${MODE_FILE}" 2>/dev/null || true)"
result="result=${SERVICE_RESULT:-unknown} ${EXIT_CODE:-exit}=${EXIT_STATUS:-unknown}"

case "${mode}" in
  '')
    log "the boot ended before it chose a mode (${result}) — see the motir-runner-prepare FATAL above; powering off"
    ;;
  ci)
    if [ -e "${JOB_MARKER}" ]; then
      log "the runner took its job at $(cat "${JOB_MARKER}" 2>/dev/null || echo '<unknown>') and exited (${result}); powering off"
    else
      log "FATAL: the runner exited WITHOUT TAKING A JOB (${result}); the GitHub job is still queued"
      log "the runner's own lines above say why: \"is deprecated and cannot receive messages\" means the baked Actions runner (RUNNER_VERSION in infra/ci-runner/Dockerfile) is out of GitHub's support window — bump it and release a new AMI (MOTIR-10706); a JIT config error means the boot credential was spent or revoked"
    fi
    ;;
  *)
    log "boot mode ${mode} ended (${result}); powering off"
    ;;
esac

exit 0
