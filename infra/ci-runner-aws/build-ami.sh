#!/usr/bin/env bash
#
# Validates or builds the AWS CI runner AMI (MOTIR-9272).
#
#   infra/ci-runner-aws/build-ami.sh validate   no AWS credentials needed
#   infra/ci-runner-aws/build-ami.sh build      needs AWS credentials (the
#                                               release workflow assumes the
#                                               build role over OIDC)
#
# The pins live ONCE, as ARGs in `infra/ci-runner/Dockerfile`. This script reads
# them from there by grep and hands them to Packer, so the Fly image and the AMI
# can never disagree about the runner, Node, Docker, AWS CLI or Playwright version.
#
# Environment it reads:
#   AWS_ORG_ARN           optional: an AWS Organization ARN given launch
#                         permission on the AMI, so every member (shard) account
#                         can launch it. Unset: the AMI stays private.
#   AMI_BUILD_SUBNET_ID   optional: the subnet the build VM runs in. Unset: the
#                         build account's default VPC.
#   AMI_BUILD_SECURITY_GROUP_ID
#                         optional: the security group the build VM runs in, so
#                         Packer creates none. Needs AMI_BUILD_SUBNET_ID, the
#                         group's own subnet. Unset: Packer makes a temporary one.
#   GITHUB_SHA / GITHUB_REF_NAME / GITHUB_STEP_SUMMARY   set in Actions; the
#                         commit, the release tag, and where the summary goes.
#
# On `build` it prints the AMI id and the command that sets it as
# MOTIR_AWS_RUNNER_AMI_ID on motir-core — the AWS counterpart of
# MOTIR_RUNNER_IMAGE — to stdout and to the job summary.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
DOCKERFILE="${ROOT}/infra/ci-runner/Dockerfile"
TEMPLATE="${HERE}/packer/runner.pkr.hcl"

log() { printf '[build-ami] %s\n' "$*" >&2; }
die() { printf '[build-ami] FATAL: %s\n' "$*" >&2; exit 1; }

# The value of `ARG <name>=<value>` in the Fly Dockerfile.
pin() {
  local value
  value="$(grep -E "^ARG $1=" "${DOCKERFILE}" | head -n1 | cut -d= -f2-)"
  [ -n "${value}" ] || die "no 'ARG $1=' in ${DOCKERFILE}"
  printf '%s' "${value}"
}

git_sha() {
  if [ -n "${GITHUB_SHA:-}" ]; then printf '%s' "${GITHUB_SHA}"; else git -C "${ROOT}" rev-parse HEAD; fi
}

# The release tag when there is one; otherwise the build is labelled by commit.
release_version() {
  local sha="$1"
  if [[ "${GITHUB_REF_NAME:-}" =~ ^ci-runner-ami-v.+$ ]]; then
    printf '%s' "${GITHUB_REF_NAME}"
  else
    printf 'manual-%s' "${sha:0:7}"
  fi
}

packer_vars() {
  local sha="$1" org_arns="[]"
  if [ -n "${AWS_ORG_ARN:-}" ]; then
    [[ "${AWS_ORG_ARN}" =~ ^arn:aws:organizations::[0-9]{12}:organization/o-[a-z0-9]+$ ]] \
      || die "AWS_ORG_ARN is not an Organization ARN: ${AWS_ORG_ARN}"
    org_arns="[\"${AWS_ORG_ARN}\"]"
  fi
  # A group belongs to one VPC, and the default VPC is not the build network's.
  if [ -n "${AMI_BUILD_SECURITY_GROUP_ID:-}" ] && [ -z "${AMI_BUILD_SUBNET_ID:-}" ]; then
    die "AMI_BUILD_SECURITY_GROUP_ID is set without AMI_BUILD_SUBNET_ID"
  fi
  VARS=(
    -var "runner_version=$(pin RUNNER_VERSION)"
    -var "runner_sha256=$(pin RUNNER_SHA256)"
    -var "node_version=$(pin NODE_VERSION)"
    -var "node_sha256=$(pin NODE_SHA256)"
    -var "docker_version=$(pin DOCKER_VERSION)"
    -var "docker_sha256=$(pin DOCKER_SHA256)"
    -var "awscli_version=$(pin AWSCLI_VERSION)"
    -var "awscli_sha256=$(pin AWSCLI_SHA256)"
    -var "playwright_version=$(pin PLAYWRIGHT_VERSION)"
    -var "git_sha=${sha}"
    -var "version=$(release_version "${sha}")"
    -var "org_arns=${org_arns}"
    -var "subnet_id=${AMI_BUILD_SUBNET_ID:-}"
    -var "security_group_id=${AMI_BUILD_SECURITY_GROUP_ID:-}"
  )
}

summary() {
  printf '%s\n' "$*"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >>"${GITHUB_STEP_SUMMARY}"; fi
}

publish_result() {
  local manifest="$1" ami_id
  ami_id="$(jq -r '.builds[-1].artifact_id' "${manifest}" | cut -d: -f2)"
  [[ "${ami_id}" =~ ^ami-[0-9a-f]+$ ]] || die "no AMI id in ${manifest}"
  summary "## AWS CI runner AMI"
  summary ""
  summary "- AMI: \`${ami_id}\` (us-east-1)"
  summary "- Runner: $(pin RUNNER_VERSION) · commit \`$(git_sha)\`"
  summary "- Shared with: ${AWS_ORG_ARN:-nobody (private to the build account)}"
  summary ""
  summary "Set it on motir-core (the adapter reads \`MOTIR_AWS_RUNNER_AMI_ID\`):"
  summary ""
  summary '```sh'
  summary "fly secrets set -a motir-core MOTIR_AWS_RUNNER_AMI_ID=${ami_id}"
  summary '```'
}

main() {
  local mode="${1:-}" sha manifest
  case "${mode}" in validate | build) ;; *) die "usage: $0 validate|build" ;; esac
  command -v packer >/dev/null || die "packer is not on PATH"
  sha="$(git_sha)"
  packer_vars "${sha}"

  log "packer init"
  packer init "${TEMPLATE}"
  log "packer validate"
  packer validate "${VARS[@]}" "${TEMPLATE}"
  [ "${mode}" = build ] || { log "valid"; return 0; }

  manifest="$(mktemp -t packer-manifest.XXXXXX)"
  log "packer build"
  packer build -color=false "${VARS[@]}" -var "manifest_path=${manifest}" "${TEMPLATE}"
  publish_result "${manifest}"
}

main "$@"
