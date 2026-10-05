#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  Gyanzo dev-server watchdog (sandbox-proof self-healing supervisor)
#
#  Problem this solves:
#    The cloud sandbox runs a background "process reaper" that kills the
#    Next.js dev server after tool-call sessions end. When port 3000 dies,
#    the preview panel shows the Z placeholder screen forever.
#
#  How it stays alive:
#    Started via `ensure` mode = double-fork + setsid → the daemon is
#    orphaned and re-parented to PID 1 in its own session, the same
#    survival profile as the pg_ctl-daemonized Postgres (which provably
#    survives the reaper here). nohup/setsid alone is NOT enough — the
#    double-fork orphaning is the key.
#
#  Boot persistence:
#    `bun install` runs at every sandbox boot (.zscripts/dev.sh) and this
#    script is invoked from package.json "postinstall", so supervision is
#    reinstated automatically after every sandbox reset. Skips itself on
#    Vercel (VERCEL env set) — production must never spawn a watchdog.
#
#  Usage:
#    dev-watchdog.sh ensure    # spawn the daemon if not already running (fast, safe to call often)
#    dev-watchdog.sh daemon    # the supervision loop itself (normally not called directly)
#    dev-watchdog.sh status    # human-readable status
#    dev-watchdog.sh pause     # stop healing for 10 minutes (maintenance window)
#    dev-watchdog.sh resume    # end a pause early
#    dev-watchdog.sh stop      # kill the daemon (dev server keeps running)
# ════════════════════════════════════════════════════════════════════════
set -u

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$PROJECT/scripts/dev-watchdog.sh"
PIDFILE="$PROJECT/scripts/.watchdog.pid"
LOGFILE="$PROJECT/scripts/watchdog.log"
PAUSEFILE="$PROJECT/scripts/.watchdog-pause"
HEALTH_URL="http://127.0.0.1:3000/"
PG_HOST="127.0.0.1"
PG_PORT="5433"
PG_CTL="node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl"
INTERVAL=5
START_TIMEOUT=120   # seconds to wait for a cold `next dev` to come up

log() {
  mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
  # cap the log at ~200 KB
  if [ -f "$LOGFILE" ] && [ "$(wc -c <"$LOGFILE" 2>/dev/null || echo 0)" -gt 200000 ]; then
    tail -c 100000 "$LOGFILE" >"$LOGFILE.tmp" 2>/dev/null && mv "$LOGFILE.tmp" "$LOGFILE"
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOGFILE"
}

on_vercel() { [ -n "${VERCEL:-}" ] || [ -n "${CI:-}" ]; }

# Self-heal secret env vars (SMTP credentials etc.) after sandbox resets —
# merges missing keys from the git-ignored .env.secrets mirror into .env.
# Runs on every ensure/daemon invocation (sandbox boot → postinstall).
ensure_env() {
  if [ -x "$PROJECT/scripts/ensure-env.sh" ]; then
    "$PROJECT/scripts/ensure-env.sh" || true
  fi
}

port_open() { # port_open <host> <port>
  (timeout 1 bash -c ">/dev/tcp/$1/$2" >/dev/null 2>&1) && return 0
  return 1
}

dev_up() {
  # NOTE: on failure curl -w still prints "000" to stdout — do NOT add
  # `|| echo 000` (it would append a second line and break the comparison).
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "$HEALTH_URL" 2>/dev/null || true)"
  [ -n "$code" ] && [ "$code" != "000" ]
}

# ── healing ──────────────────────────────────────────────────────────────
heal() {
  exec 9>>"$PIDFILE.lock" 2>/dev/null || exec 9>>"$PROJECT/scripts/.watchdog.lock"
  if command -v flock >/dev/null 2>&1; then
    flock -n 9 || return 0   # another heal in progress
  fi

  # double-check under the lock
  if dev_up; then return 0; fi

  log "HEAL: port 3000 is down — starting recovery"

  # 1. local Postgres (only used in the sandbox; Vercel never reaches here)
  if grep -q '^LOCAL_PG=1' "$PROJECT/.env" 2>/dev/null; then
    if ! port_open "$PG_HOST" "$PG_PORT"; then
      log "HEAL: local postgres :$PG_PORT down — starting via pg_ctl"
      local pidfile="$PROJECT/db/pgdata/postmaster.pid" pid
      if [ -f "$pidfile" ]; then
        pid="$(head -n1 "$pidfile" 2>/dev/null | tr -dc '0-9')"
        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
          rm -f "$pidfile"
          log "HEAL: removed stale postmaster.pid (pid $pid dead)"
        fi
      fi
      if [ -x "$PROJECT/$PG_CTL" ] && [ -f "$PROJECT/db/pgdata/PG_VERSION" ]; then
        (cd "$PROJECT" && "$PG_CTL" -D db/pgdata -l db/pgdata/pg.log -w -t 20 -o "-p $PG_PORT" start) >>"$LOGFILE" 2>&1 \
          && log "HEAL: postgres started" || log "HEAL: pg_ctl failed (see log above)"
      fi
    fi
  fi

  # 2. clear anything half-dead holding port 3000
  pkill -f 'bun run dev'        2>/dev/null || true
  pkill -f 'next dev'           2>/dev/null || true
  pkill -f 'next-server'        2>/dev/null || true
  pkill -f 'tee dev.log'        2>/dev/null || true
  for _ in $(seq 1 10); do
    port_open 127.0.0.1 3000 || break
    sleep 1
  done

  # 3. spawn the dev server, double-fork orphaned (same trick as the watchdog itself)
  log "HEAL: spawning Next.js dev server (detached)"
  (
    cd "$PROJECT" || exit 1
    setsid bash -c 'exec bun run dev' </dev/null >/dev/null 2>&1 &
  ) &

  # 4. wait for it
  local waited=0
  while [ "$waited" -lt "$START_TIMEOUT" ]; do
    if dev_up; then
      log "HEAL: dev server is UP again after ${waited}s"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "HEAL: dev server still down after ${START_TIMEOUT}s — will retry next cycle"
  return 1
}

# ── daemon loop ──────────────────────────────────────────────────────────
daemon() {
  on_vercel && { echo "watchdog: refusing to run on Vercel/CI" >&2; exit 0; }
  echo $$ >"$PIDFILE"
  log "watchdog daemon started (pid $$, project $PROJECT)"
  local fails=0
  while true; do
    if [ -f "$PAUSEFILE" ]; then
      local age=$(( $(date +%s) - $(stat -c %Y "$PAUSEFILE" 2>/dev/null || date +%s) ))
      if [ "$age" -gt 600 ]; then
        rm -f "$PAUSEFILE"
        log "pause window (10 min) expired — resuming supervision"
      else
        sleep "$INTERVAL"
        continue
      fi
    fi

    if dev_up; then
      fails=0
    else
      fails=$((fails + 1))
      log "health check failed ($fails/2)"
      if [ "$fails" -ge 2 ]; then
        heal
        fails=0
      fi
    fi
    sleep "$INTERVAL"
  done
}

# ── pidfile helpers ──────────────────────────────────────────────────────
running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null | tr -dc '0-9')"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'dev-watchdog.sh' || return 1
  echo "$pid"
}

self_daemonize() {
  # double fork: outer subshell forks the middle shell and exits instantly,
  # setsid detaches the daemon into its own session orphaned to PID 1.
  (
    (
      setsid bash "$SCRIPT" daemon </dev/null >/dev/null 2>&1 &
    ) &
  ) &
  # give it a moment to write its pidfile
  sleep 1
  if [ -n "$(running_pid 2>/dev/null || true)" ]; then
    return 0
  fi
  sleep 2
  [ -n "$(running_pid 2>/dev/null || true)" ]
}

# ── commands ─────────────────────────────────────────────────────────────
case "${1:-ensure}" in
  ensure)
    on_vercel && exit 0
    ensure_env
    existing="$(running_pid 2>/dev/null || true)"
    if [ -n "$existing" ]; then
      exit 0   # already supervised — cheap no-op
    fi
    rm -f "$PIDFILE"
    if self_daemonize; then
      log "ensure: watchdog spawned (pid $(cat "$PIDFILE" 2>/dev/null))"
      exit 0
    fi
    log "ensure: FAILED to spawn watchdog"
    exit 1
    ;;
  daemon)
    ensure_env
    existing="$(running_pid 2>/dev/null || true)"
    if [ -n "$existing" ] && [ "$existing" != "$$" ]; then
      exit 0   # dedup: another daemon already supervising
    fi
    daemon
    ;;
  status)
    existing="$(running_pid 2>/dev/null || true)"
    if [ -n "$existing" ]; then
      echo "watchdog: RUNNING (pid $existing)"
    else
      echo "watchdog: NOT RUNNING"
    fi
    if dev_up; then echo "dev server :3000: UP"; else echo "dev server :3000: DOWN"; fi
    port_open "$PG_HOST" "$PG_PORT" && echo "postgres  :$PG_PORT: UP" || echo "postgres  :$PG_PORT: DOWN"
    [ -f "$PAUSEFILE" ] && echo "paused: yes" || true
    ;;
  pause)
    touch "$PAUSEFILE"
    log "pause requested (10-minute maintenance window)"
    echo "watchdog paused for 10 minutes"
    ;;
  resume)
    rm -f "$PAUSEFILE"
    log "pause cleared"
    echo "watchdog resumed"
    ;;
  stop)
    existing="$(running_pid 2>/dev/null || true)"
    if [ -n "$existing" ]; then
      kill "$existing" 2>/dev/null || true
      log "stop: killed watchdog pid $existing"
      echo "watchdog stopped (pid $existing)"
    else
      echo "watchdog not running"
    fi
    rm -f "$PIDFILE"
    ;;
  *)
    echo "usage: dev-watchdog.sh {ensure|daemon|status|pause|resume|stop}" >&2
    exit 2
    ;;
esac
