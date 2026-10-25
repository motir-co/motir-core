#!/usr/bin/env bash
#
# The AWS runner's ExecStartPre hook (MOTIR-9272).
#
# The Fly runner is a container: Fly hands its entrypoint an environment and a
# Docker volume. An EC2 VM gets neither, so this hook supplies the two things a
# VM needs before `motir-ci-runner-entrypoint` — installed byte for byte from
# `infra/ci-runner/entrypoint.sh` — can run exactly as it does on Fly:
#
#   1. the entrypoint's env contract, read from user-data, written to a 0600
#      root-only file that `motir-ci-runner.service` reads as its
#      EnvironmentFile (and removes once the entrypoint has started);
#   2. Docker's data root: the second 20 GB EBS volume, formatted ext4 if it is
#      blank, mounted at /var/lib/docker (MOTIR-8839: a runner with no disk
#      Docker can use died with ENOSPC).
#
# Then it closes the metadata service. user-data holds the JIT config, and on
# EC2 anything on the instance can read user-data back from 169.254.169.254 —
# the one exposure a Fly container does not have. Once this hook has read it,
# nothing needs the metadata service again.
#
# ── user-data is DATA, never a script ────────────────────────────────────────
# `KEY=value` lines and nothing else, parsed by `motir-parse-user-data`
# (`parse-user-data.sh`, MOTIR-9419), which chooses the boot mode and refuses
# any key that mode does not accept. cloud-init ignores text that is not a
# script or cloud-config, so a mistake in user-data cannot run code at launch.
#
#   CI mode (no mode line): the four keys of the entrypoint's contract
#   (`infra/ci-runner/entrypoint.sh` header), written to the unit's env file.
#   Container mode (`MOTIR_BOOT_MODE=container`): a hosted agent run — the
#   image by digest and its `MOTIR_ENV_` lines, written under ${STATE_DIR} for
#   `motir-container-entrypoint`, which runs it once.
#
# The disk mount, `MOTIR_RUNNER_DOCKER_STORAGE=overlay2` and the metadata block
# are the same in both modes, and all of them happen here, before the unit's
# ExecStart (`motir-vm-entrypoint`) starts anything.
#
# ── What this hook never does ────────────────────────────────────────────────
# It downloads and installs nothing: every tool is baked into the AMI by
# `provision.sh`, so a launch costs no customer minutes on Motir's setup. It
# never traces itself and never prints a user-data value — an error names the
# KEY, never the value. It never powers the VM off: `ExecStopPost` in the unit
# does that, for a failure here as much as for a finished job.

set -euo pipefail

IMDS=http://169.254.169.254
ENV_DIR=/run/motir-ci-runner
ENV_FILE="${ENV_DIR}/env"
STATE_DIR=/run/motir
PARSER=/usr/local/sbin/motir-parse-user-data
DOCKER_ROOT=/var/lib/docker
DISK_WAIT_SECONDS=60

log() { printf '[motir-runner-prepare] %s\n' "$*"; }
die() { printf '[motir-runner-prepare] FATAL: %s\n' "$*" >&2; exit 1; }

# ── 1. user-data → the entrypoint's environment ─────────────────────────────

# IMDSv2 only: a session token first, then the read. The AMI is registered
# `imds_support = v2.0`, so a plain GET would be refused anyway.
read_user_data() {
  local token
  token="$(curl -fsS --retry 10 --retry-connrefused --retry-delay 1 -X PUT \
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' "${IMDS}/latest/api/token")" \
    || die "could not get an IMDSv2 session token"
  curl -fsS --retry 10 --retry-connrefused --retry-delay 1 \
    -H "X-aws-ec2-metadata-token: ${token}" "${IMDS}/latest/user-data" \
    || die "could not read user-data over IMDSv2"
}

# Hands user-data to the parser as a 0600 root-only file, never on a command
# line, and removes it once parsed. The parser writes the mode and, for CI, the
# four-key env file under ${STATE_DIR}; a refusal there ends this hook.
parse_user_data() {
  local data="$1" raw
  install -d -m 0700 -o root -g root "${STATE_DIR}"
  raw="$(mktemp "${STATE_DIR}/user-data.XXXXXX")"
  chmod 0600 "${raw}"
  printf '%s\n' "${data}" >"${raw}"
  "${PARSER}" "${raw}" "${STATE_DIR}" || { rm -f "${raw}"; die "user-data was refused (see the parser's message above)"; }
  rm -f "${raw}"
  log "boot mode: $(cat "${STATE_DIR}/mode")"
}

# The unit's EnvironmentFile, in BOTH modes: CI mode's four keys when there are
# any, then the storage setting dockerd starts with. The file is created 0600
# and owned by root before a byte of the credential is written into it.
write_env_file() {
  local tmp
  install -d -m 0700 -o root -g root "${ENV_DIR}"
  tmp="$(mktemp "${ENV_DIR}/env.XXXXXX")"
  chmod 0600 "${tmp}"
  if [ -f "${STATE_DIR}/env" ]; then
    cat "${STATE_DIR}/env" >>"${tmp}"
    rm -f "${STATE_DIR}/env"
  fi
  # overlay2 on the mounted volume, forced: with the data disk in place the vfs
  # fallback in `start-dockerd.sh` could only ever hide a bad disk (MOTIR-8839).
  printf 'MOTIR_RUNNER_DOCKER_STORAGE=overlay2\n' >>"${tmp}"
  mv -f "${tmp}" "${ENV_FILE}"
  chown root:root "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
  log "wrote the unit environment"
}

# cloud-init keeps its own copies of user-data on disk. They are root-only, but
# the runner user has passwordless sudo, so they go once the env file exists.
scrub_cloud_init_copies() {
  rm -f /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/user-data.txt.i
}

# ── 2. Docker's data root on the second EBS volume ──────────────────────────

# The whole disk that is NOT the one holding / and carries no partition and no
# mountpoint. Device names are not trusted: NVMe numbering varies by instance
# type, and the AMI's `/dev/sdb` arrives as some /dev/nvmeXn1. When an instance
# type adds local NVMe storage beside it, the EBS one is preferred by model.
find_docker_disk() {
  local root_src root_disk name type candidates=() ebs=()
  root_src="$(findmnt -no SOURCE /)"
  root_disk="$(lsblk -no PKNAME "${root_src}" | head -n1)"
  [ -n "${root_disk}" ] || root_disk="$(basename "${root_src}")"
  while read -r name type; do
    [ "${type}" = disk ] || continue
    [ "${name}" != "${root_disk}" ] || continue
    [ "$(lsblk -nro NAME "/dev/${name}" | wc -l)" -eq 1 ] || continue
    [ -z "$(lsblk -dnro MOUNTPOINT "/dev/${name}")" ] || continue
    candidates+=("${name}")
    if grep -qs 'Elastic Block Store' "/sys/block/${name}/device/model"; then ebs+=("${name}"); fi
  done < <(lsblk -dnro NAME,TYPE)
  if [ "${#candidates[@]}" -eq 1 ]; then echo "${candidates[0]}"; return 0; fi
  if [ "${#ebs[@]}" -eq 1 ]; then echo "${ebs[0]}"; return 0; fi
  if [ "${#candidates[@]}" -eq 0 ]; then return 1; fi
  # Called in a command substitution, so it cannot `die` itself: 2 is
  # "ambiguous", which the caller fails on at once rather than waiting out.
  echo "${candidates[*]}"
  return 2
}

mount_docker_disk() {
  local disk="" fstype status deadline=$((SECONDS + DISK_WAIT_SECONDS))
  if mountpoint -q "${DOCKER_ROOT}"; then
    log "${DOCKER_ROOT} is already a mountpoint; leaving it"
    return 0
  fi
  # The volume is attached at launch, but its block device can appear a moment
  # after this unit starts.
  while :; do
    status=0
    disk="$(find_docker_disk)" || status=$?
    [ "${status}" -ne 0 ] || break
    [ "${status}" -ne 2 ] || die "more than one blank disk could be Docker's (${disk}); refusing to guess"
    [ "${SECONDS}" -lt "${deadline}" ] || die "no blank data disk for ${DOCKER_ROOT} after ${DISK_WAIT_SECONDS}s — the launch must keep the AMI's 20 GB data volume in its mapping"
    udevadm settle --timeout=5 || true
    sleep 1
  done
  fstype="$(blkid -o value -s TYPE "/dev/${disk}" || true)"
  if [ -z "${fstype}" ]; then
    log "formatting /dev/${disk} ext4 for ${DOCKER_ROOT}"
    mkfs.ext4 -q -L motir-docker /dev/"${disk}"
  else
    # Never format a disk that already carries a filesystem.
    log "/dev/${disk} already carries ${fstype}; mounting it as it is"
  fi
  install -d -m 0711 "${DOCKER_ROOT}"
  mount -o noatime /dev/"${disk}" "${DOCKER_ROOT}"
  log "mounted /dev/${disk} at ${DOCKER_ROOT}"
}

# ── 3. Close the metadata service ───────────────────────────────────────────

# Three rules, all inserted at the top of their chain:
#   - OUTPUT for uid runner: the job's own processes.
#   - OUTPUT for everyone: the runner has passwordless sudo, so a uid rule alone
#     is one `sudo curl` from useless, and a `--network host` container is root
#     in the host's namespace. Nothing on the VM needs the metadata service
#     after this hook: cloud-init has finished its network stage (the unit is
#     ordered after it) and the instance has no instance profile.
#   - DOCKER-USER: containers on Docker's bridge, whose traffic is FORWARDed,
#     not OUTPUT. dockerd creates this chain and keeps rules already in it, so
#     creating it here, before dockerd starts, is what lets the rule exist from
#     the first container on.
block_metadata_service() {
  iptables -w -I OUTPUT 1 -d 169.254.169.254/32 -m owner --uid-owner runner -j REJECT
  iptables -w -I OUTPUT 1 -d 169.254.169.254/32 -j REJECT
  iptables -w -N DOCKER-USER 2>/dev/null || true
  iptables -w -I DOCKER-USER 1 -d 169.254.169.254/32 -j REJECT
  # The IPv6 endpoint exists only when the launch enables it; closed either way.
  ip6tables -w -I OUTPUT 1 -d fd00:ec2::254/128 -j REJECT || true
  log "metadata service closed to the runner, to sudo and to containers"
}

main() {
  local user_data
  user_data="$(read_user_data)"
  parse_user_data "${user_data}"
  unset user_data
  write_env_file
  scrub_cloud_init_copies
  mount_docker_disk
  block_metadata_service
}

main "$@"
