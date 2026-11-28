#!/usr/bin/env bash
# Upload a repository's SCIP index to the code graph from its own CI
# (Story MOTIR-12262 · MOTIR-12341).
#
#   MOTIR_SCIP_UPLOAD_TOKEN=… MOTIR_CODEGRAPH_REPOSITORY_ID=… \
#   MOTIR_SCIP_COMMIT=<40 hex> MOTIR_SCIP_BRANCH=main MOTIR_SCIP_DEFAULT_BRANCH=main \
#   MOTIR_SCIP_INDEXER=scip-typescript MOTIR_SCIP_INDEX_COMMAND='npx @sourcegraph/scip-typescript index' \
#   bash scip-upload.sh
#
# The reusable workflow `.github/workflows/scip-upload.yml` runs this same file, so
# the two forms cannot drift. It needs bash, curl and jq.
#
# What it does, in order:
#   1. Decides whether this is a default-branch run. A `pull_request` event, or a
#      branch that is not the default branch, prints `skipped:` and exits 0 before
#      any indexing or request: precise facts are for the default branch only.
#   2. Checks every setting, and runs the index command in the root (without the
#      token in its environment). Anything missing or failing exits 2 before any
#      request is made.
#   3. Uploads the file ONCE, streamed from disk, to
#      <host>/v1/repositories/<repository id>/scip-uploads for the run's commit,
#      then polls that upload's state until it is ingested or refused.
#
# Every request goes to MOTIR_CODEGRAPH_UPLOAD_URL (default https://codegraph.motir.co)
# and nowhere else, so the file never passes through Motir. The token reaches curl on
# its standard input, never on its command line, and is never printed.
#
# Exit codes:
#   0  ingested, superseded by a newer upload of the same commit, or skipped
#   1  refused — by the upload route (HTTP status and error code printed) or by the
#      ingest (the upload's reason printed, such as not_default_branch)
#   2  a configuration or indexing error, before any request
#   3  still accepted or ingesting at MOTIR_SCIP_WAIT_SECONDS
#   4  the code graph unreachable (a connection failure, 429 or 503) after retries
set -uo pipefail

token="${MOTIR_SCIP_UPLOAD_TOKEN:-}"
repository_id="${MOTIR_CODEGRAPH_REPOSITORY_ID:-}"
host="${MOTIR_CODEGRAPH_UPLOAD_URL:-}"
host="${host:-https://codegraph.motir.co}"
commit="${MOTIR_SCIP_COMMIT:-}"
branch="${MOTIR_SCIP_BRANCH:-}"
default_branch="${MOTIR_SCIP_DEFAULT_BRANCH:-}"
event="${MOTIR_SCIP_EVENT:-}"
indexer="${MOTIR_SCIP_INDEXER:-}"
index_command="${MOTIR_SCIP_INDEX_COMMAND:-}"
root="${MOTIR_SCIP_ROOT:-}"
root="${root:-.}"
file="${MOTIR_SCIP_FILE:-}"
file="${file:-index.scip}"
wait_seconds="${MOTIR_SCIP_WAIT_SECONDS:-1800}"
poll_seconds="${MOTIR_SCIP_POLL_SECONDS:-10}"
retries="${MOTIR_SCIP_RETRIES:-4}"
retry_seconds="${MOTIR_SCIP_RETRY_SECONDS:-5}"

say() { printf '%s\n' "$*"; }
config_error() {
  say "error: $*"
  exit 2
}

# ── 1. Is this a default-branch run? ───────────────────────────────────────────

if [ "$event" = "pull_request" ] || [ "$event" = "pull_request_target" ]; then
  say "skipped: a ${event} run${branch:+ on branch '${branch}'} — only the default branch is uploaded"
  exit 0
fi
[ -n "$branch" ] || config_error "MOTIR_SCIP_BRANCH is not set — the run's branch is needed to tell a default-branch run"
[ -n "$default_branch" ] || config_error "MOTIR_SCIP_DEFAULT_BRANCH is not set — the repository's default branch is needed"
if [ "$branch" != "$default_branch" ]; then
  say "skipped: branch '${branch}' is not the default branch '${default_branch}' — only the default branch is uploaded"
  exit 0
fi

# ── 2. Settings, the index, the file ───────────────────────────────────────────

command -v curl > /dev/null 2>&1 || config_error "curl is not installed"
command -v jq > /dev/null 2>&1 || config_error "jq is not installed"
[ -n "$token" ] || config_error "MOTIR_SCIP_UPLOAD_TOKEN is not set — mint an upload credential in Motir's Repositories room"
[ -n "$repository_id" ] || config_error "MOTIR_CODEGRAPH_REPOSITORY_ID is not set"
[[ "$repository_id" =~ ^[A-Za-z0-9_-]+$ ]] || config_error "MOTIR_CODEGRAPH_REPOSITORY_ID is not a repository id"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || config_error "MOTIR_SCIP_COMMIT must be the run's full commit, 40 lowercase hex"
[ -n "$indexer" ] || config_error "MOTIR_SCIP_INDEXER is not set — name the indexer, such as scip-typescript"
[[ "$indexer" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || config_error "MOTIR_SCIP_INDEXER '${indexer}' is not an indexer name"
host="${host%/}"
# https only; plain http only to this machine, for a local code graph.
[[ "$host" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ || "$host" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?$ ]] \
  || config_error "MOTIR_CODEGRAPH_UPLOAD_URL '${host}' must be an https:// host with no path"
for n in "$wait_seconds" "$poll_seconds" "$retries" "$retry_seconds"; do
  [[ "$n" =~ ^[0-9]+$ ]] || config_error "the wait, poll and retry settings must be whole seconds"
done
[ -d "$root" ] || config_error "the root '${root}' is not a directory"

if [ -n "$index_command" ]; then
  say "indexing: ${indexer} in ${root}"
  if ! (cd "$root" && env -u MOTIR_SCIP_UPLOAD_TOKEN bash -c "$index_command"); then
    config_error "the index command failed — nothing was uploaded"
  fi
fi
path="${root%/}/${file}"
[ -f "$path" ] || config_error "the SCIP file '${path}' does not exist"
[ -s "$path" ] || config_error "the SCIP file '${path}' is empty"

# ── 3. The upload and the poll ─────────────────────────────────────────────────

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
body="$work/body"

# One request, retried only on what is retryable. Sets `status` (000 when the
# connection failed) and leaves the answer in $body. Returns 4 once retries run out.
request() {
  local attempt=0 wait="$retry_seconds"
  while :; do
    status="$(
      printf 'header = "Authorization: Bearer %s"\n' "$token" \
        | curl --silent --show-error --config - --output "$body" --write-out '%{http_code}' \
          --connect-timeout 30 --max-time 3600 "$@" 2> "$work/curl-error"
    )" || status="${status:-000}"
    case "$status" in
      000 | 429 | 503) ;;
      *) return 0 ;;
    esac
    if [ "$attempt" -ge "$retries" ]; then return 4; fi
    attempt=$((attempt + 1))
    say "retrying: the code graph answered ${status/#000/no connection} — attempt ${attempt} of ${retries} in ${wait}s"
    sleep "$wait"
    wait=$((wait * 2))
  done
}

unreachable() {
  say "unreachable: the code graph at ${host} could not be reached (last answer: ${status/#000/no connection}) — re-run the job"
  exit 4
}

# A refusal of the request itself: its HTTP status, error code and message.
refused_request() {
  local code message
  code="$(jq -r '.error.code // .code // "unknown"' "$body" 2> /dev/null || echo unknown)"
  message="$(jq -r '.error.message // .message // .detail // ""' "$body" 2> /dev/null || true)"
  code="${code:-unknown}"
  say "refused: $1 answered HTTP ${status} ${code}${message:+: ${message}}"
  exit 1
}

field() { jq -r --arg f "$1" '.[$f] // empty | tostring' "$body" 2> /dev/null; }

upload_url="${host}/v1/repositories/${repository_id}/scip-uploads"
query="commit=${commit}&indexer=$(jq -rn --arg v "$indexer" '$v|@uri')&root=$(jq -rn --arg v "$root" '$v|@uri')"

say "uploading: $(wc -c < "$path" | tr -d ' ') bytes for ${commit} (${indexer}, root ${root})"
request -X POST -H 'Content-Type: application/octet-stream' --upload-file "$path" \
  "${upload_url}?${query}" || unreachable
[ "$status" = "202" ] || refused_request "the upload"
upload_id="$(field uploadId)"
state="$(field state)"
[ -n "$upload_id" ] || { say "refused: the upload answered 202 with no upload id"; exit 1; }
say "uploaded: upload ${upload_id} is ${state:-accepted}"

deadline=$((SECONDS + wait_seconds))
while :; do
  case "$state" in
    ingested)
      say "ingested: upload ${upload_id} is ingested for ${commit}"
      exit 0
      ;;
    superseded)
      say "superseded: upload ${upload_id} was replaced by a newer upload of the same commit, indexer and root — that one counts"
      exit 0
      ;;
    refused)
      say "refused: upload ${upload_id} was refused: $(field reason)"
      exit 1
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    say "timeout: upload ${upload_id} is still ${state:-accepted} after ${wait_seconds}s — its ingest may still finish"
    exit 3
  fi
  sleep "$poll_seconds"
  request "${upload_url}/${upload_id}" || unreachable
  [ "$status" = "200" ] || refused_request "the state read"
  state="$(field state)"
done
