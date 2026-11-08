#!/usr/bin/env bash
#
# The runner's job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED, set by
# `entrypoint.sh`). Whatever it prints lands in the JOB LOG, which is the only
# log a tenant or Motir can read from GitHub. It reports the dockerd storage
# outcome `start-dockerd.sh` recorded, so a Docker failure inside a job (MOTIR-8821)
# names its storage candidate and driver without anyone needing the Machine console.
#
# Informational only: it must never fail a job.

# The marker `entrypoint.sh` made room for (MOTIR-10706): this runner took a job.
# Read after the runner exits, so an exit with no marker is reported as one that
# never took its job rather than passing for a finished one.
date -u +%Y-%m-%dT%H:%M:%SZ >/run/motir-ci-runner-job/started 2>/dev/null || true

cat /run/motir-ci-runner-docker-storage 2>/dev/null \
  || echo "dockerd storage: not started (MOTIR_RUNNER_SKIP_DOCKER or a pre-start boot)"
# The disk a job starts with (MOTIR-8839): the rootfs and Docker's data root,
# which is its own volume when the orchestrator mounted one. A job that later
# dies of ENOSPC is diagnosable from these two lines.
df -h / /var/lib/docker 2>/dev/null | sed 's/^/runner disk: /' || true
exit 0
