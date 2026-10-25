#!/usr/bin/env bash
#
# The AWS VM's user-data parser (MOTIR-9419): user-data TEXT in, files out.
#
#   parse-user-data.sh <user-data-file> <out-dir>
#
# The VM has two boot modes, and user-data alone chooses between them. The parse
# lives here, apart from `motir-runner-prepare.sh`, so its refusal rules run in a
# unit test with no IMDS and no VM (`tests/ciFleet/awsRunnerUserData.test.ts`).
# It makes no network call, starts nothing and never runs user-data: every line
# is read with `read -r` and split at its FIRST `=`, and nothing is evaluated.
#
# ── CI mode — no mode line (MOTIR-9272's contract, unchanged) ────────────────
# Four keys and nothing else, each with a plain value:
#
#   ACTIONS_RUNNER_INPUT_JITCONFIG  (required) the base64 JIT config
#   MOTIR_RUNNER_LABEL              the fleet label
#   MOTIR_INTENT_ID                 attribution
#   MOTIR_WORKFLOW_JOB_ID           attribution
#
# Writes <out-dir>/mode = `ci` and <out-dir>/env (0600) holding those lines.
#
# ── Container mode — a hosted agent run ──────────────────────────────────────
#
#   MOTIR_BOOT_MODE=container                         the mode line
#   MOTIR_CONTAINER_IMAGE=<registry>/<repo>@sha256:<64 hex>   required, by digest
#   MOTIR_ENV_<NAME>=<value>                          zero or more; NAME matches
#                                                     ^[A-Z_][A-Z0-9_]*$
#
# Writes <out-dir>/mode = `container`, <out-dir>/container.image and
# <out-dir>/container.env (0600): one `<NAME>=<value>` per MOTIR_ENV_ line, the
# prefix stripped and the value unchanged. The prefix keeps the container's
# environment apart from the host's, so no user-data line can set a host
# variable. Which NAMES a run may carry is the adapter's allow-list; this
# script enforces the SHAPE.
#
# ── Refusals ────────────────────────────────────────────────────────────────
# A line that is not KEY=value, a repeated key, a key the mode does not accept
# (in container mode that includes the four CI keys), a malformed image or env
# name: the script exits 1 and writes nothing — not the mode, not an env file.
# An error names the KEY, never a value: user-data carries a credential in both
# modes.

set -euo pipefail

CI_KEYS=(ACTIONS_RUNNER_INPUT_JITCONFIG MOTIR_RUNNER_LABEL MOTIR_INTENT_ID MOTIR_WORKFLOW_JOB_ID)
IMAGE_RE='^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$'
ENV_NAME_RE='^[A-Z_][A-Z0-9_]*$'
CI_VALUE_RE='^[A-Za-z0-9+/=._:-]+$'

TMP_DIR=""
cleanup() { [ -z "${TMP_DIR}" ] || rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

die() { printf '[motir-parse-user-data] FATAL: %s\n' "$*" >&2; exit 1; }

[ "$#" -eq 2 ] || die "usage: parse-user-data.sh <user-data-file> <out-dir>"
USER_DATA="$1"
OUT_DIR="$2"
[ -r "${USER_DATA}" ] || die "cannot read the user-data file"

KEYS=()
VALUES=()

# Every non-empty line, split at its first `=`, into KEYS / VALUES. A repeated
# key is refused here, whatever the mode.
read_lines() {
  local line key seen=" "
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    [ -n "${line}" ] || continue
    case "${line}" in *=*) ;; *) die "user-data has a line that is not KEY=value (the line is not printed)" ;; esac
    key="${line%%=*}"
    [ -n "${key}" ] || die "user-data has a line with an empty key (the line is not printed)"
    case "${seen}" in *" ${key} "*) die "user-data sets ${key} twice" ;; esac
    seen="${seen}${key} "
    KEYS+=("${key}")
    VALUES+=("${line#*=}")
  done <"${USER_DATA}"
}

is_ci_key() {
  local k
  for k in "${CI_KEYS[@]}"; do [ "$1" = "${k}" ] && return 0; done
  return 1
}

# The mode: `container` when the mode line says so, `ci` when there is none.
boot_mode() {
  local i
  for i in "${!KEYS[@]}"; do
    if [ "${KEYS[$i]}" = MOTIR_BOOT_MODE ]; then
      [ "${VALUES[$i]}" = container ] || die "MOTIR_BOOT_MODE must be container (the value is not printed)"
      echo container
      return 0
    fi
  done
  echo ci
}

# MOTIR-9272's rules, exactly: the four keys, the plain-value charset, the JIT
# config required.
write_ci() {
  local i key value has_jit=0
  : >"${TMP_DIR}/env"
  for i in "${!KEYS[@]}"; do
    key="${KEYS[$i]}"
    value="${VALUES[$i]}"
    is_ci_key "${key}" || die "user-data carries a key that is not accepted (only: ${CI_KEYS[*]})"
    # A plain value only: systemd reads this file, and a quote, a space or a
    # backslash would be interpreted there. A base64 JIT config fits this set.
    [[ "${value}" =~ ${CI_VALUE_RE} ]] || die "user-data value for ${key} has characters outside [A-Za-z0-9+/=._:-] (the value is not printed)"
    [ "${key}" != ACTIONS_RUNNER_INPUT_JITCONFIG ] || has_jit=1
    printf '%s=%s\n' "${key}" "${value}" >>"${TMP_DIR}/env"
  done
  [ "${has_jit}" -eq 1 ] || die "user-data has no ACTIONS_RUNNER_INPUT_JITCONFIG"
  printf 'ci\n' >"${TMP_DIR}/mode"
}

write_container() {
  local i key value name image=""
  : >"${TMP_DIR}/container.env"
  for i in "${!KEYS[@]}"; do
    key="${KEYS[$i]}"
    value="${VALUES[$i]}"
    case "${key}" in
      MOTIR_BOOT_MODE) ;;
      MOTIR_CONTAINER_IMAGE)
        [[ "${value}" =~ ${IMAGE_RE} ]] || die "MOTIR_CONTAINER_IMAGE must be <registry>/<repo>@sha256:<64 hex>, with no tag (the value is not printed)"
        image="${value}"
        ;;
      MOTIR_ENV_*)
        name="${key#MOTIR_ENV_}"
        [[ "${name}" =~ ${ENV_NAME_RE} ]] || die "user-data env key ${key} does not name a variable matching ${ENV_NAME_RE}"
        # docker --env-file reads the value literally, so it goes in unchanged.
        printf '%s=%s\n' "${name}" "${value}" >>"${TMP_DIR}/container.env"
        ;;
      *)
        if is_ci_key "${key}"; then
          die "user-data carries the CI key ${key} in container mode"
        fi
        die "user-data carries a key that is not accepted in container mode: ${key}"
        ;;
    esac
  done
  [ -n "${image}" ] || die "container mode needs MOTIR_CONTAINER_IMAGE"
  printf '%s\n' "${image}" >"${TMP_DIR}/container.image"
  printf 'container\n' >"${TMP_DIR}/mode"
}

main() {
  local mode f
  umask 077
  read_lines
  mode="$(boot_mode)"
  install -d -m 0700 "${OUT_DIR}"
  TMP_DIR="$(mktemp -d "${OUT_DIR}/.parse.XXXXXX")"
  if [ "${mode}" = container ]; then write_container; else write_ci; fi
  # Nothing reaches <out-dir> until every line has passed: a refusal above
  # leaves no mode and no env file behind.
  for f in "${TMP_DIR}"/*; do
    chmod 0600 "${f}"
    mv -f "${f}" "${OUT_DIR}/$(basename "${f}")"
  done
}

main
