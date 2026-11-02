#!/usr/bin/env bash
#
# THE SANDBOX'S DEBUGGING DATABASE (MOTIR-6204) — `motir-sandbox-postgres`.
#
# The image ships an initialised Postgres 18 cluster with pgvector, collated
# C.UTF-8, owned by the runtime user. This is how you drive it.
#
#   motir-sandbox-postgres start     start it (idempotent; prints the URL)
#   motir-sandbox-postgres stop      stop it
#   motir-sandbox-postgres status    is it accepting connections?
#   motir-sandbox-postgres reset     drop + recreate the database, extension and all
#   motir-sandbox-postgres psql …    a psql shell (or one-off) on the database
#
# ── WHY THIS IS A COMMAND AND NOT THE ENTRYPOINT ────────────────────────────
# Every devcontainer recipe sets `"overrideCommand": true`, which replaces the
# image's ENTRYPOINT as well as its CMD — so work put in the entrypoint does not
# run on the VS Code route at all (the same fact MOTIR-4956 was filed for). A
# database that starts on one of the two documented routes and silently not on
# the other is worse than one you start by name. It is also not free: a
# `motir auto` run that never touches a database should not pay for a postmaster.
#
# ── WHAT THIS DATABASE IS, AND IS NOT ───────────────────────────────────────
# It is for running the FEW tests around a failure you are debugging. It is NOT
# CI parity and NOT sized for a full suite: `fsync` is off and the cluster is
# thrown away with the container. CI remains the authority on a suite-wide
# number — see the sandbox README.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/18/bin}"
PGDATA="${PGDATA:-/var/lib/motir-postgres}"
PGUSER_NAME='prodect'
PGDATABASE_NAME='prodect'
URL="postgresql://prodect:prodect@localhost:5432/prodect"

die() {
    echo "motir-sandbox-postgres: $*" >&2
    exit 1
}

# The cluster is baked into the image owned by uid 1000. A container run as some
# other user cannot start it, and the failure that produces ("could not open
# file") says nothing about the cause — so say it here instead.
#
# Checked per COMMAND rather than at load: `--help` has to answer on an image
# that ships no cluster at all, which is exactly where somebody is most likely
# to be asking it.
require_cluster() {
    [ -d "$PGDATA" ] || die "no cluster at $PGDATA — this image did not ship one."
    [ -w "$PGDATA" ] || die "$PGDATA is not writable by $(id -un) (uid $(id -u)).
The cluster is owned by the image's \`node\` user; run the container as that
user, or without a --user override."
}

running() { "$PG_BIN/pg_isready" --quiet --host=localhost --port=5432; }

start() {
    if running; then
        echo "already running — $URL"
        return 0
    fi
    # A container that was killed rather than stopped leaves a postmaster.pid
    # behind, and `pg_ctl start` then refuses with a message about a process id
    # that belongs to nothing. There is no other postmaster in a container, so
    # the stale file is unambiguous — remove it rather than making the reader
    # diagnose a lock left by a process that died with the last `docker stop`.
    if [ -f "$PGDATA/postmaster.pid" ]; then
        pid="$(head -n 1 "$PGDATA/postmaster.pid" 2>/dev/null || true)"
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "removing a stale postmaster.pid (pid $pid is not running)"
            rm -f "$PGDATA/postmaster.pid"
        fi
    fi
    "$PG_BIN/pg_ctl" -D "$PGDATA" -w -l "$PGDATA/postmaster.log" start
    echo "$URL"
}

stop() {
    running || { echo 'not running'; return 0; }
    "$PG_BIN/pg_ctl" -D "$PGDATA" -w stop
}

status() {
    if running; then
        echo "accepting connections — $URL"
    else
        echo 'not running — `motir-sandbox-postgres start`'
        return 1
    fi
}

# A debugging database gets dirtied: a half-applied migration, a test that died
# mid-transaction, a seed run twice. This is the cheap way back — the DATABASE is
# recreated, not the cluster, so the C.UTF-8 collation the cluster was
# initialised with (and which the ordering tests depend on) is preserved by
# construction rather than by remembering a flag.
reset() {
    running || start >/dev/null
    "$PG_BIN/dropdb" --username="$PGUSER_NAME" --host=localhost --if-exists "$PGDATABASE_NAME"
    "$PG_BIN/createdb" --username="$PGUSER_NAME" --host=localhost "$PGDATABASE_NAME"
    "$PG_BIN/psql" --username="$PGUSER_NAME" --host=localhost --dbname="$PGDATABASE_NAME" \
        --quiet -c 'CREATE EXTENSION IF NOT EXISTS vector'
    echo "reset — $URL"
}

case "${1:-}" in
    start) require_cluster; start ;;
    stop) require_cluster; stop ;;
    restart) require_cluster; stop; start ;;
    status) require_cluster; status ;;
    reset) require_cluster; reset ;;
    psql)
        shift
        require_cluster
        running || start >/dev/null
        exec "$PG_BIN/psql" --username="$PGUSER_NAME" --host=localhost --dbname="$PGDATABASE_NAME" "$@"
        ;;
    url) echo "$URL" ;;
    ''|-h|--help|help)
        sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
        ;;
    *) die "unknown command '$1' — try --help" ;;
esac
