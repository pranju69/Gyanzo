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
#
#  Additionally, when the in-project mirror is missing but the backup
#  exists, the backup is copied back so future resets keep healing even
#  without this fallback logic.
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

# Self-restore the in-project mirror from the out-of-project backup.
if [ ! -s "$SECRETS_FILE" ] && [ -s "$BACKUP_FILE" ]; then
  mkdir -p "$(dirname "$SECRETS_FILE")"
  cp "$BACKUP_FILE" "$SECRETS_FILE"
  echo "[ensure-env] .env.secrets restored from ~/.config/gyanzo backup"
fi

# Restore the sandbox-only .env.local overrides (gitignored → wiped by
# deep resets). Without it the sandbox would run against the production
# Supabase DATABASE_URL committed in .env — polluting prod with dev data.
if [ ! -s "$LOCAL_FILE" ] && [ -s "$BACKUP_LOCAL_FILE" ]; then
  cp "$BACKUP_LOCAL_FILE" "$LOCAL_FILE"
  echo "[ensure-env] .env.local restored from ~/.config/gyanzo backup"
fi

[ -f "$SECRETS_FILE" ] || exit 0
touch "$ENV_FILE"

# The sandbox-injected legacy SQLite `file:` DATABASE_URL is invalid for
# the postgres-provider schema — it silently breaks `prisma db push` and
# every CLI path (runtime heals itself, the CLI does not). Replace it
# with the real DATABASE_URL from the secrets mirror when one exists.
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
exit 0
