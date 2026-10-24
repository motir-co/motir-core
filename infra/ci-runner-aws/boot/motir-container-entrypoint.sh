#!/usr/bin/env bash
#
# Container mode's entrypoint (MOTIR-9419): run ONE digest-pinned OCI image once,
# then let the VM power off.
#
# A hosted agent run on Fly is one Machine running the hosted-agent image with
# the run's environment, destroyed when the container exits. This is the same
# on an EC2 VM from the runner AMI: `motir-vm-entrypoint` execs this for
# `MOTIR_BOOT_MODE=container`, and the unit's `ExecStopPost` powers the VM off
# when this exits — with `InstanceInitiatedShutdownBehavior: terminate`, that
# ends the instance the way `auto_destroy` ends a Machine.
#
#   1. dockerd, started by `motir-ci-runner-dockerd` (`start-dockerd.sh`,
#      installed unchanged) on the data volume the prepare hook mounted, with
#      the storage the unit's environment forces.
#   2. `docker pull` of the image BY DIGEST, anonymously; then the pulled
#      image's RepoDigests must hold exactly that digest, so a wrong reference
#      fails the boot loudly instead of running something else.
#   3. `docker create` with the run's environment from `--env-file`, which reads
#      values literally and keeps them off every command line; no privilege, no
#      capabilities, no host network, no mount, no Docker socket.
#   4. The env file and the image file are deleted before the container starts.
#   5. `exec docker start --attach`: the container's exit is this process's
#      exit, and so the unit's.
#
# The metadata service is already closed to containers (the prepare hook's
# DOCKER-USER rule), so the agent cannot read back its own user-data, which
# carries the run's credentials. Nothing here traces itself or prints a value.

set -euo pipefail

STATE_DIR=/run/motir
IMAGE_FILE="${STATE_DIR}/container.image"
ENV_FILE="${STATE_DIR}/container.env"
NAME=motir-agent

log() { printf '[motir-container-entrypoint] %s\n' "$*"; }
die() { printf '[motir-container-entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

[ -r "${IMAGE_FILE}" ] || die "no image reference at ${IMAGE_FILE}"
[ -r "${ENV_FILE}" ] || die "no container environment at ${ENV_FILE}"
image="$(cat "${IMAGE_FILE}")"
digest="${image##*@}"
repo="${image%@*}"
case "${digest}" in sha256:*) ;; *) die "the image reference is not pinned by digest" ;; esac

log "starting dockerd"
/usr/local/bin/motir-ci-runner-dockerd

log "pulling ${image}"
docker pull --quiet "${image}" >/dev/null || die "could not pull ${image}"

# Belt and braces: the pull by digest already refuses a mismatched manifest.
pulled="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${image}")"
grep -qxF "${repo}@${digest}" <<<"${pulled}" || die "the pulled image does not carry ${digest}"

docker create --rm --env-file "${ENV_FILE}" \
  --security-opt no-new-privileges --cap-drop ALL \
  --name "${NAME}" "${image}" >/dev/null || die "could not create the container"
rm -f "${ENV_FILE}" "${IMAGE_FILE}"

log "running ${NAME}"
exec docker start --attach "${NAME}"
