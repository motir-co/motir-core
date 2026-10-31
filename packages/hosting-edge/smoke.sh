#!/usr/bin/env bash
# The edge forwarder image's smoke test (MOTIR-10127), run by
# `.github/workflows/hosting-edge-image.yml` against the image it just built,
# and runnable locally: `packages/hosting-edge/smoke.sh <image>`.
#
#   1. Without its configuration it refuses to start, naming the variable.
#   2. Started against a stand-in contract and a stand-in TLS upstream on a
#      private network, it proves:
#        - a forward: the upstream answers, having received the visitor's host
#          in x-forwarded-host and the derived origin secret;
#        - an `aws_sigv4` answer renders the Unavailable page at 503;
#        - an unknown host renders the Not-found page at 404 with noindex.
#
# The key, token and certificate below are throwaways for this check, not
# credentials.
set -euo pipefail
image="${1:?usage: smoke.sh <image>}"
run="motir-hosting-edge-smoke-$$"
node_image="node:22-alpine"
work="$(mktemp -d)"

if out="$(docker run --rm "$image" 2>&1)"; then
  echo "::error::the edge started with no MOTIR_BASE_URL"
  exit 1
fi
echo "$out"
echo "$out" | grep -q MOTIR_BASE_URL

if out="$(docker run --rm -e MOTIR_BASE_URL=http://contract:8000 -e MOTIR_EDGE_CONTRACT_TOKEN=t "$image" 2>&1)"; then
  echo "::error::the edge started with no MOTIR_HOSTING_ORIGIN_SECRET_KEY"
  exit 1
fi
echo "$out"
echo "$out" | grep -q MOTIR_HOSTING_ORIGIN_SECRET_KEY

cleanup() {
  docker logs "$run-edge" 2>&1 | tail -20 || true
  docker rm -f "$run-edge" "$run-contract" "$run-upstream" >/dev/null 2>&1 || true
  docker network rm "$run" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# A self-signed certificate for the stand-in upstream, trusted by the edge
# through NODE_EXTRA_CA_CERTS, so the forward runs over real TLS.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=upstream" \
  -addext "subjectAltName=DNS:upstream" \
  -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
# The containers run as other users: the directory must be traversable.
chmod 755 "$work"
chmod 644 "$work/key.pem" "$work/cert.pem"

cat >"$work/contract.mjs" <<'JS'
import { createServer } from 'node:http';
const answers = {
  'app.example.com': {
    kind: 'application',
    workspace: { name: 'Acme' },
    application: { id: 'a1', slug: 'shop' },
    upstream: { origin: 'https://upstream:8443', appRef: 'mh-smoke', credential: 'origin_secret' },
  },
  'fn.example.com': {
    kind: 'application',
    workspace: { name: 'Acme' },
    application: { id: 'a2', slug: 'fn' },
    upstream: { origin: 'https://upstream:8443', appRef: 'fn-smoke', credential: 'aws_sigv4' },
  },
};
createServer((req, res) => {
  const host = decodeURIComponent(req.url.replace('/api/public/hosts/', ''));
  const answer = req.headers.authorization === 'Bearer smoke-token' ? answers[host] : undefined;
  res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(answer ?? { code: 'NOT_FOUND' }));
}).listen(8000);
JS

cat >"$work/upstream.mjs" <<'JS'
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
const expected = createHmac('sha256', 'smoke-key').update('origin:mh-smoke').digest('hex');
createServer(
  { key: readFileSync('/work/key.pem'), cert: readFileSync('/work/cert.pem') },
  (req, res) => {
    const secret = req.headers['x-motir-origin-secret'] === expected ? 'secret-ok' : 'secret-wrong';
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`upstream ${req.headers['x-forwarded-host']} ${secret} ${req.url}`);
  },
).listen(8443);
JS

docker network create "$run" >/dev/null
docker run -d --name "$run-contract" --network "$run" --network-alias contract \
  -v "$work:/work:ro" "$node_image" node /work/contract.mjs >/dev/null
docker run -d --name "$run-upstream" --network "$run" --network-alias upstream \
  -v "$work:/work:ro" "$node_image" node /work/upstream.mjs >/dev/null
docker run -d --name "$run-edge" --network "$run" -p 8080:8080 \
  -v "$work:/work:ro" -e NODE_EXTRA_CA_CERTS=/work/cert.pem \
  -e MOTIR_BASE_URL=http://contract:8000 \
  -e MOTIR_EDGE_CONTRACT_TOKEN=smoke-token \
  -e MOTIR_HOSTING_ORIGIN_SECRET_KEY=smoke-key \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  curl -s -o /dev/null http://127.0.0.1:8080/ && break
  sleep 1
done

forward="$(curl -s -H 'Host: app.example.com' 'http://127.0.0.1:8080/cart?item=1')"
echo "forward: $forward"
[ "$forward" = "upstream app.example.com secret-ok /cart?item=1" ]

unavailable="$(curl -s -o "$work/503.html" -w '%{http_code}' -H 'Host: fn.example.com' http://127.0.0.1:8080/)"
echo "aws_sigv4: $unavailable"
[ "$unavailable" = 503 ]
grep -q 'can’t be reached right now' "$work/503.html"

missing="$(curl -s -o "$work/404.html" -w '%{http_code}' -H 'Host: nobody.example.com' http://127.0.0.1:8080/)"
echo "unknown host: $missing"
[ "$missing" = 404 ]
grep -q '<meta name="robots" content="noindex, nofollow">' "$work/404.html"
grep -q 'There’s no site here' "$work/404.html"
echo "smoke passed"
