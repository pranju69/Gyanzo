#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  bootstrap-local-pg.sh — idempotent local Postgres bring-up (sandbox only)
#
#  Handles ALL failure modes seen after sandbox deep resets:
#    1. Postgres not running, data dir intact          → pg_ctl start
#    2. Data dir (db/pgdata) physically deleted        → initdb → start
#    3. `gyanzo` database missing (fresh cluster)      → CREATE DATABASE
#    4. Schema missing (fresh database)                → prisma db push
#    5. Stale postmaster.pid from a killed process     → removed automatically
#
#  Exit codes: 0 = Postgres reachable and schema present, 1 = failure.
#  Called by dev-watchdog.sh (boot + heal). Safe to run repeatedly.
# ════════════════════════════════════════════════════════════════════════
set -u

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="$PROJECT/node_modules/@embedded-postgres/linux-x64/native/bin"
PG_CTL="$PG_BIN/pg_ctl"
INITDB="$PG_BIN/initdb"
PGDATA="$PROJECT/db/pgdata"
PG_HOST="127.0.0.1"
PG_PORT="5433"
PG_URL="postgres://postgres:postgres@$PG_HOST:$PG_PORT"

log() { echo "[bootstrap-pg $(date '+%H:%M:%S')] $*"; }

on_vercel() { [ -n "${VERCEL:-}" ] || [ -n "${CI:-}" ]; }
on_vercel && exit 0

port_open() { (timeout 1 bash -c ">/dev/tcp/$1/$2" >/dev/null 2>&1) && return 0; return 1; }

# Nothing to do if the app is not configured for local Postgres.
local_pg_expected() {
  grep -qs '^LOCAL_PG=1' "$PROJECT/.env" "$PROJECT/.env.local" 2>/dev/null
}

if ! local_pg_expected; then
  # Not an error — sandbox may legitimately run against another DB.
  exit 0
fi

if port_open "$PG_HOST" "$PG_PORT"; then
  log "postgres already running on :$PG_PORT"
else
  [ -x "$PG_CTL" ] || { log "FATAL: pg_ctl not found at $PG_CTL"; exit 1; }

  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    log "data dir missing — running initdb"
    mkdir -p "$PROJECT/db"
    rm -rf "$PGDATA"
    "$INITDB" -D "$PGDATA" -U postgres -A trust -E UTF8 >/dev/null 2>&1 || {
      log "FATAL: initdb failed"; exit 1;
    }
  fi

  # A hard kill can leave a stale pid file that blocks startup.
  if [ -f "$PGDATA/postmaster.pid" ]; then
    pid="$(head -n1 "$PGDATA/postmaster.pid" 2>/dev/null | tr -dc '0-9')"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PGDATA/postmaster.pid"
      log "removed stale postmaster.pid (pid $pid dead)"
    fi
  fi

  log "starting postgres on :$PG_PORT"
  "$PG_CTL" -D "$PGDATA" -l "$PGDATA/pg.log" -w -t 30 -o "-p $PG_PORT" start >/dev/null 2>&1 || {
    log "FATAL: pg_ctl start failed (see db/pgdata/pg.log)"; exit 1;
  }
  log "postgres started"
fi

# Ensure the `gyanzo` database exists (embedded distro ships no psql/createdb
# — Bun's built-in SQL client is the supported path).
created_db=0
if ! port_open "$PG_HOST" "$PG_PORT"; then
  log "FATAL: postgres not reachable after start"; exit 1
fi
if ! bun -e "import { SQL } from 'bun'; const s = new SQL('$PG_URL/postgres');
const rows = await s\`SELECT 1 FROM pg_database WHERE datname = 'gyanzo'\`;
if (rows.length === 0) { await s\`CREATE DATABASE gyanzo\`; console.log('CREATED'); }
await s.close();" 2>/dev/null | grep -q CREATED; then
  log "database gyanzo already exists (or check inconclusive)"
else
  created_db=1
  log "database gyanzo created"
fi

# Ensure the Prisma schema exists. Cheap canary: the `User` table.
schema_ok="$(bun -e "import { SQL } from 'bun'; const s = new SQL('$PG_URL/gyanzo');
const r = await s\`SELECT to_regclass('public.\\\"User\\\"') AS t\`; console.log(r[0]?.t ? 'OK' : 'MISSING'); await s.close();" 2>/dev/null || echo MISSING)"
if [ "$schema_ok" != "OK" ] || [ "$created_db" = "1" ]; then
  log "schema missing or fresh database — running prisma db push"
  (cd "$PROJECT" &&
    set -a
    [ -f .env.local ] && . ./.env.local
    set +a
    export DATABASE_URL="$PG_URL/gyanzo"
    export DIRECT_URL="$PG_URL/gyanzo"
    bunx prisma db push --accept-data-loss --skip-generate >/dev/null 2>&1
  ) || { log "FATAL: prisma db push failed"; exit 1; }
  log "schema pushed"
fi

# Final sanity check.
port_open "$PG_HOST" "$PG_PORT" || { log "FATAL: postgres not listening"; exit 1; }
log "OK — postgres up on :$PG_PORT with schema"
exit 0
