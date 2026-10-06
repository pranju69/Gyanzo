#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  ensure-env.sh — self-heal secret env vars after sandbox resets
#
#  The cloud sandbox periodically recreates .env containing only the DB
#  bootstrap vars. That once silently disabled the verification-code
#  emails (the whole SMTP block vanished → mailer fell back to demo mode
#  and users never received their code). This script re-merges every
#  KEY=VALUE from the secrets mirror into .env — only for keys that are
#  MISSING (never overwrites values set intentionally).
#
#  Secrets sources, in order (first one that exists wins):
#    1. $PROJECT/.env.secrets          — git-ignored in-project mirror
#    2. ~/.config/gyanzo/env.secrets   — OUT-OF-PROJECT backup. Deep
#      sandbox resets restore the project dir to its git-tracked state,
#      which DELETES the in-project mirror too (it is git-ignored). The
#      copy under ~/.config lives outside the project and survives those.
#    3. git show HEAD:.env             — ULTIMATE fallback. The real .env
#      is now TRACKED in the (private) GitHub repo, so even when BOTH
#      mirrors are gone (3rd deep reset wiped ~/.config too) the full
#      production credentials come back from git history.
#
#  Additionally, when the in-project mirror is missing but the backup
#  exists, the backup is copied back so future resets keep healing even
#  without this fallback logic. After every successful heal, the
#  out-of-project backups are RE-SEEDED from the healed files so the
#  next reset always has a source.
#
#  Called from dev-watchdog.sh (which runs at every sandbox boot via the
#  package.json postinstall hook) and safe to run manually any time.
# ════════════════════════════════════════════════════════════════════════
set -u

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
SECRETS_FILE="$PROJECT/.env.secrets"
LOCAL_FILE="$PROJECT/.env.local"
BACKUP_FILE="${HOME}/.config/gyanzo/env.secrets"
BACKUP_LOCAL_FILE="${HOME}/.config/gyanzo/env.local"

# Production must never touch env files from here.
if [ -n "${VERCEL:-}" ] || [ -n "${CI:-}" ]; then
  exit 0
fi

# ── ULTIMATE FALLBACK: rebuild .env from git ──────────────────────────────
# The sandbox injects a placeholder .env containing only a legacy SQLite
# `file:` DATABASE_URL. If the current .env looks like that placeholder
# (no SMTP block ⇒ not the real thing) or is missing, and the git repo is
# present, restore the committed production .env wholesale. .env is tracked
# in the private GitHub repo precisely so this recovery is always possible.
env_is_placeholder() {
  # Placeholder = missing/empty file, OR the sandbox-injected legacy
  # SQLite `file:` DATABASE_URL combined with no SMTP block (the real
  # committed .env always carries the SMTP section).
  [ -s "$ENV_FILE" ] || return 0
  if grep -qs '^DATABASE_URL=file:' "$ENV_FILE" && ! grep -qs '^SMTP_HOST=' "$ENV_FILE"; then
    return 0
  fi
  return 1
}
if env_is_placeholder; then
  if git -C "$PROJECT" cat-file -e HEAD:.env 2>/dev/null; then
    git -C "$PROJECT" show HEAD:.env >"$ENV_FILE"
    echo "[ensure-env] .env rebuilt from git HEAD (sandbox placeholder detected)"
  fi
fi

# Self-restore the in-project mirror from the out-of-project backup.
if [ ! -s "$SECRETS_FILE" ] && [ -s "$BACKUP_FILE" ]; then
  mkdir -p "$(dirname "$SECRETS_FILE")"
  cp "$BACKUP_FILE" "$SECRETS_FILE"
  echo "[ensure-env] .env.secrets restored from ~/.config/gyanzo backup"
fi

# Restore the sandbox-only .env.local overrides (gitignored → wiped by
# deep resets). Without it the sandbox would run against the production
# Supabase DATABASE_URL committed in .env — polluting prod with dev data.
if [ ! -s "$LOCAL_FILE" ]; then
  if [ -s "$BACKUP_LOCAL_FILE" ]; then
    cp "$BACKUP_LOCAL_FILE" "$LOCAL_FILE"
    echo "[ensure-env] .env.local restored from ~/.config/gyanzo backup"
  else
    # Both mirrors gone (deep reset wiped ~/.config too) — recreate the
    # deterministic sandbox isolation values from the embedded heredoc.
    cat >"$LOCAL_FILE" <<'EOF'
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/gyanzo
DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5433/gyanzo
LOCAL_PG=1
NEXT_PUBLIC_DISABLE_SOCKET=
EOF
    echo "[ensure-env] .env.local recreated from embedded sandbox defaults"
  fi
fi

# Restore critical tracked source files that deep resets have been known
# to physically delete (e.g. src/app/api/pdfs/upload/route.ts was wiped
# and the deletion auto-committed, silently breaking production PDF
# uploads). Each file under ~/.config/gyanzo/files/<project-relative-path>
# is copied back when missing from the working tree.
CRITICAL_DIR="${HOME}/.config/gyanzo/files"
if [ -d "$CRITICAL_DIR" ]; then
  find "$CRITICAL_DIR" -type f | while IFS= read -r f; do
    rel="${f#"$CRITICAL_DIR"/}"
    if [ ! -s "$PROJECT/$rel" ]; then
      mkdir -p "$(dirname "$PROJECT/$rel")"
      cp "$f" "$PROJECT/$rel"
      echo "[ensure-env] restored critical file: $rel"
    fi
  done
fi

# The sandbox-injected legacy SQLite `file:` DATABASE_URL is invalid for
# the postgres-provider schema — it silently breaks `prisma db push` and
# every CLI path (runtime heals itself, the CLI does not). Replace it
# with the real DATABASE_URL from the secrets mirror when one exists.
if [ -f "$SECRETS_FILE" ]; then
  secrets_db_url="$(grep -m1 '^DATABASE_URL=' "$SECRETS_FILE" | cut -d= -f2-)"
  if [ -n "$secrets_db_url" ] && grep -q '^DATABASE_URL=file:' "$ENV_FILE"; then
    grep -v '^DATABASE_URL=' "$ENV_FILE" >"$ENV_FILE.tmp" || true
    printf 'DATABASE_URL=%s\n' "$secrets_db_url" >>"$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    echo "[ensure-env] replaced legacy file: DATABASE_URL with the local Postgres URL"
  fi

  merged=0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    [ -n "$key" ] || continue
    if ! grep -q "^${key}=" "$ENV_FILE"; then
      printf '\n# restored by scripts/ensure-env.sh (missing after sandbox reset)\n%s\n' "$line" >>"$ENV_FILE"
      merged=$((merged + 1))
    fi
  done <"$SECRETS_FILE"

  if [ "$merged" -gt 0 ]; then
    echo "[ensure-env] restored $merged missing env key(s) from .env.secrets"
  fi
fi

# ── Restore DELETED tracked source files from git ────────────────────────
# Deep resets have twice physically deleted tracked files (most notably
# src/app/api/pdfs/upload/route.ts). Since the whole tree is now tracked
# in the private repo, git itself is the authoritative backup: restore
# any tracked file whose working-tree copy vanished. Never touches files
# with local modifications.
if git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  deleted="$(git -C "$PROJECT" status --porcelain 2>/dev/null | awk '$1=="D" && $2 !~ /->/ {print $2}')"
  if [ -n "$deleted" ]; then
    echo "$deleted" | while IFS= read -r f; do
      git -C "$PROJECT" checkout -- "$f" 2>/dev/null &&
        echo "[ensure-env] restored deleted tracked file from git: $f"
    done
  fi
fi

# ── Re-seed the out-of-project backups from the healed files ─────────────
# After every successful heal, refresh ~/.config/gyanzo so the NEXT deep
# reset always finds a source — even one that wipes the whole project.
BACKUP_DIR="${HOME}/.config/gyanzo"
if [ -s "$ENV_FILE" ]; then
  mkdir -p "$BACKUP_DIR" 2>/dev/null || true
  cp "$ENV_FILE" "$BACKUP_DIR/env.secrets" 2>/dev/null || true
  [ -s "$LOCAL_FILE" ] && cp "$LOCAL_FILE" "$BACKUP_DIR/env.local" 2>/dev/null || true
  [ -s "$SECRETS_FILE" ] || cp "$ENV_FILE" "$SECRETS_FILE" 2>/dev/null || true
fi

exit 0
