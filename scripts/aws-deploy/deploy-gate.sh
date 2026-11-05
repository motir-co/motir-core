#!/usr/bin/env bash
# The check an AWS deploy runs immediately before it rolls (MOTIR-10436).
#
#   DEPLOY_STACKS="<stack> [<stack>...]" bash <this file>
#
# Two things nothing else coordinates:
#
#   1. motir-infra's deploys change the same ECS services. A roll that overlaps a
#      stack update loses to it, and the merge never reaches ECS. So wait for the
#      stacks that own these services to settle.
#   2. Deploys are serialised, not ordered, so an older commit can roll after a
#      newer one and put the older image back with every run green. So a first
#      attempt whose commit is no longer main's newest stands down: the newer
#      commit's deploy carries it. A re-run or a manual dispatch is deliberate and
#      still deploys, with a warning.
#
# It writes `deploy=true|false` to $GITHUB_OUTPUT and always exits 0. A check that
# cannot answer (no permission, no network) warns and deploys, because it must
# never stop a deploy that would otherwise have gone out.
#
# It narrows the race and does not close it: a stack update that starts after the
# roll begins still collides. Closing that needs a lock shared across the repos.
set -uo pipefail

wait_seconds="${DEPLOY_GATE_WAIT_SECONDS:-1200}"
poll_seconds="${DEPLOY_GATE_POLL_SECONDS:-20}"
deadline=$((SECONDS + wait_seconds))

while :; do
  busy=""
  for stack in ${DEPLOY_STACKS:-}; do
    if ! status="$(aws cloudformation describe-stacks --stack-name "$stack" \
      --query 'Stacks[0].StackStatus' --output text 2>&1)"; then
      echo "::warning::could not read stack ${stack}, not waiting for it: ${status}"
      continue
    fi
    case "$status" in
      *_IN_PROGRESS) busy="${busy} ${stack}=${status}" ;;
    esac
  done
  [ -z "$busy" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::warning::still busy after ${wait_seconds}s, deploying anyway:${busy}"
    break
  fi
  echo "waiting for a stack update to finish:${busy}"
  sleep "$poll_seconds"
done

deploy=true
head="$(git ls-remote origin refs/heads/main 2>/dev/null | cut -f1)"
if [ -z "$head" ]; then
  echo "::warning::could not read main's newest commit, deploying ${GITHUB_SHA}"
elif [ "$head" != "$GITHUB_SHA" ]; then
  if [ "${GITHUB_EVENT_NAME:-}" = "push" ] && [ "${GITHUB_RUN_ATTEMPT:-1}" = "1" ]; then
    deploy=false
    echo "::notice::${GITHUB_SHA} is no longer main's newest commit (${head}); that commit's deploy carries it, so this one stands down"
  else
    echo "::warning::deploying ${GITHUB_SHA} on request, though main's newest commit is ${head}: this puts the older image on the services"
  fi
fi

echo "deploy=${deploy}" >> "${GITHUB_OUTPUT:-/dev/null}"
exit 0
