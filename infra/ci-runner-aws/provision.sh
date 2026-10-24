#!/usr/bin/env bash
#
# Provisions the AWS runner AMI (MOTIR-9272). Packer runs this ONCE, as root,
# inside the temporary build VM; nothing here runs when a runner launches.
#
# It bakes what `infra/ci-runner/Dockerfile` bakes into the Fly image, layer for
# layer, so the two fleets run the same runner, Node, Docker and Playwright
# libraries. Read that Dockerfile for WHY each layer exists (its evidence
# table); this file only repeats the steps a VM needs.
#
# ── Pins: passed in, never typed here ────────────────────────────────────────
# Every version and checksum arrives in the environment from `build-ami.sh`,
# which reads them from the Dockerfile's ARGs. A pin written here would be a
# second copy that drifts; `tests/ciFleet/awsRunnerAmi.test.ts` fails if one is.
#
#   RUNNER_VERSION RUNNER_SHA256 NODE_VERSION NODE_SHA256
#   DOCKER_VERSION DOCKER_SHA256 PLAYWRIGHT_VERSION
#
# ── The scripts: copied, never rewritten ─────────────────────────────────────
# The Packer file provisioner uploads `infra/ci-runner/entrypoint.sh`,
# `start-dockerd.sh` and `job-started.sh` plus the boot files into
# ${STAGING}; they are installed below under the same names the Fly image uses,
# byte for byte, so a change to the Fly entrypoint reaches this image on its
# next build.

set -euo pipefail

STAGING=/tmp/motir-ci-runner
export DEBIAN_FRONTEND=noninteractive

log() { printf '[provision] %s\n' "$*"; }
die() { printf '[provision] FATAL: %s\n' "$*" >&2; exit 1; }

for pin in RUNNER_VERSION RUNNER_SHA256 NODE_VERSION NODE_SHA256 DOCKER_VERSION DOCKER_SHA256 PLAYWRIGHT_VERSION; do
  [ -n "${!pin:-}" ] || die "${pin} is not set — build-ami.sh passes it from infra/ci-runner/Dockerfile"
done

# The Dockerfile's base package set, exactly. The test compares this array with
# the Dockerfile's `apt-get install` block and fails on any difference.
APT_PACKAGES=(
  bash
  build-essential
  ca-certificates
  coreutils
  curl
  gh
  git
  gnupg
  gzip
  iptables
  jq
  locales
  openssh-client
  pipx
  python3
  python3-venv
  sudo
  tar
  unzip
  uidmap
  xz-utils
  zip
  zstd
)

wait_for_cloud_init() {
  # The build VM's own first boot is still running apt and snap work; starting
  # apt-get beside it races the dpkg lock.
  cloud-init status --wait >/dev/null || true
}

install_base_packages() {
  log "base packages"
  apt-get update
  apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
  rm -rf /var/lib/apt/lists/*
}

# Node into the tool cache, so `actions/setup-node` is a cache hit (Dockerfile:
# "Node.js — installed INTO THE TOOL CACHE"), and onto PATH.
install_node() {
  local tools="/opt/hostedtoolcache/node/${NODE_VERSION}/x64" b
  log "node into ${tools}"
  mkdir -p "${tools}"
  curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
  tar -xJf /tmp/node.tar.xz -C "${tools}" --strip-components=1
  rm /tmp/node.tar.xz
  touch "/opt/hostedtoolcache/node/${NODE_VERSION}.complete"
  for b in node npm npx corepack; do ln -sf "${tools}/bin/${b}" "/usr/local/bin/${b}"; done
  node --version
}

# The static Docker tarball, as in the image: dockerd is started by the
# entrypoint, never by a systemd unit, so the VM and the container start it the
# same way.
install_docker() {
  log "docker static binaries"
  curl -fsSLo /tmp/docker.tgz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz"
  echo "${DOCKER_SHA256}  /tmp/docker.tgz" | sha256sum -c -
  tar -xzf /tmp/docker.tgz -C /usr/local/bin --strip-components=1
  rm /tmp/docker.tgz
  dockerd --version
  # The mountpoint the boot hook mounts the data volume on.
  install -d -m 0711 /var/lib/docker
}

install_playwright_libraries() {
  log "playwright chromium system libraries"
  npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium
  rm -rf /var/lib/apt/lists/* /root/.npm
}

# The runner, then `config.sh` and `config.cmd` deleted: the image holds no
# registration capability, only the JIT path (`run.sh`).
install_runner() {
  log "actions runner"
  mkdir -p /home/runner/actions-runner
  (
    cd /home/runner/actions-runner
    curl -fsSLo runner.tar.gz "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
    echo "${RUNNER_SHA256}  runner.tar.gz" | sha256sum -c -
    tar -xzf runner.tar.gz
    rm runner.tar.gz
    ./bin/installdependencies.sh
    rm -rf /var/lib/apt/lists/*
    rm -f config.sh config.cmd
    test -x run.sh
    test ! -e config.sh
  )
}

# The unprivileged `runner` user with passwordless sudo and docker-group
# membership — GitHub-hosted parity, as in the image. uid 1001: the cloud
# image's own `ubuntu` user holds 1000.
create_runner_user() {
  log "runner user"
  groupadd --gid 1001 runner
  useradd --uid 1001 --gid 1001 --home-dir /home/runner --shell /bin/bash runner
  groupadd --system docker
  usermod -aG docker runner
  echo 'runner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/runner
  chmod 0440 /etc/sudoers.d/runner
  mkdir -p /home/runner/actions-runner/_work
  chown -R runner:runner /home/runner /opt/hostedtoolcache
}

install_scripts() {
  log "runner scripts and boot unit"
  install -m 0755 "${STAGING}/entrypoint.sh" /usr/local/bin/motir-ci-runner-entrypoint
  install -m 0755 "${STAGING}/start-dockerd.sh" /usr/local/bin/motir-ci-runner-dockerd
  install -m 0755 "${STAGING}/job-started.sh" /usr/local/bin/motir-ci-runner-job-started.sh
  install -m 0755 "${STAGING}/motir-runner-prepare.sh" /usr/local/sbin/motir-runner-prepare
  # Container mode (MOTIR-9419): the parser, the mode dispatch and the
  # container entrypoint, root-owned and not writable by `runner`.
  install -m 0755 -o root -g root "${STAGING}/parse-user-data.sh" /usr/local/sbin/motir-parse-user-data
  install -m 0755 -o root -g root "${STAGING}/motir-vm-entrypoint.sh" /usr/local/bin/motir-vm-entrypoint
  install -m 0755 -o root -g root "${STAGING}/motir-container-entrypoint.sh" /usr/local/bin/motir-container-entrypoint
  install -m 0644 "${STAGING}/motir-ci-runner.service" /etc/systemd/system/motir-ci-runner.service
  systemctl enable motir-ci-runner.service
  rm -rf "${STAGING}"
}

# A launch runs no package work of its own: the OS's daily apt jobs would take
# the dpkg lock just as a customer step runs `apt-get install`, and a snap
# refresh would download at boot.
quiet_background_updates() {
  log "disabling boot-time apt and snap updates"
  systemctl disable apt-daily.timer apt-daily-upgrade.timer
  systemctl mask apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
  if command -v snap >/dev/null; then snap refresh --hold; fi
}

# Leave nothing of the build VM in the image: Packer's temporary SSH key, the
# cloud-init state and the machine-id (every instance must get its own, or they
# share a DHCP identity).
clean_up() {
  log "cleaning the build VM out of the image"
  rm -f /home/ubuntu/.ssh/authorized_keys
  cloud-init clean --logs --machine-id
}

main() {
  wait_for_cloud_init
  install_base_packages
  install_node
  install_docker
  install_playwright_libraries
  install_runner
  create_runner_user
  install_scripts
  quiet_background_updates
  clean_up
  log "done"
}

main "$@"
