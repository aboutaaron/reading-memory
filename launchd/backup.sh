#!/bin/bash
# Wrapper invoked by the LaunchAgent backup timer. Mirrors the systemd unit
# `reading-memory-backup.service`: source the shared env file (so READING_API_DB
# and READING_API_BACKUP_DIR resolve the same way the service sees them), apply
# a small random jitter (matches the systemd timer's RandomizedDelaySec=10m),
# then exec the portable backup script.

set -euo pipefail

ENV_FILE="${READING_API_ENV_FILE:-$HOME/.reading-api/env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "reading-memory backup: env file not found at $ENV_FILE" >&2
  echo "Run 'npx github:aboutaaron/reading-memory setup --target codex'" >&2
  echo "(or another target) to generate it before loading this LaunchAgent." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

JITTER_SECS=${READING_API_BACKUP_JITTER_SECS:-600}
if [ "$JITTER_SECS" -gt 0 ]; then
  sleep $((RANDOM % JITTER_SECS))
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../scripts/backup-sqlite.sh"
