#!/usr/bin/env bash
# The hosting guard image's smoke test (MOTIR-9947), run by
# `.github/workflows/hosting-guard-image.yml` against the image it just built,
# and runnable locally: `packages/hosting-guard/smoke.sh <image>`.
#
#   1. Without its configuration it refuses to start, naming the variable.
#   2. Started, it answers 403 to a request without the origin secret, and lets
#      one with the secret through — 502 here, since no app runs behind it.
#
# The secret below is a throwaway for this check, not a credential.
set -euo pipefail
image="${1:?usage: smoke.sh <image>}"
name="motir-hosting-guard-smoke-$$"

if out="$(docker run --rm "$image" 2>&1)"; then
  echo "::error::the guard started with no MOTIR_GUARD_ORIGIN_SECRET"
  exit 1
fi
echo "$out"
echo "$out" | grep -q MOTIR_GUARD_ORIGIN_SECRET

docker run -d --rm --name "$name" -p 9180:9180 \
  -e MOTIR_GUARD_ORIGIN_SECRET=smoke-only-secret -e MOTIR_GUARD_APP_PORT=8080 \
  "$image" >/dev/null
trap 'docker logs "$name" || true; docker stop "$name" >/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null http://127.0.0.1:9180/ && break
  sleep 1
done
without="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9180/health)"
with="$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Motir-Origin-Secret: smoke-only-secret' http://127.0.0.1:9180/health)"
echo "without the secret: $without; with it: $with"
[ "$without" = 403 ] && [ "$with" = 502 ]
