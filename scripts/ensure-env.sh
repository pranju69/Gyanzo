#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
#  ensure-env.sh — self-heal secret env vars after sandbox resets
#
#  The cloud sandbox periodically recreates .env containing only the DB
#  bootstrap vars. That once silently disabled the verification-code
#  emails (the whole SMTP block vanished → mailer fell back to demo mode
#  and users never received their code). This script re-merges every
#  KEY=VALUE from the git-ignored .env.secrets mirror into .env — only
#  for keys that are MISSING (never overwrites values set intentionally).
#
#  Called from dev-watchdog.sh (which runs at every sandbox boot via the
#  package.json postinstall hook) and safe to run manually any time.
# ════════════════════════════════════════════════════════════════════════
set -u

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT/.env"
SECRETS_FILE="$PROJECT/.env.secrets"

# Production must never touch env files from here.
if [ -n "${VERCEL:-}" ] || [ -n "${CI:-}" ]; then
  exit 0
fi

[ -f "$SECRETS_FILE" ] || exit 0
touch "$ENV_FILE"

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
