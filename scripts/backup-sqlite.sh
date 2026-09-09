#!/usr/bin/env bash
set -euo pipefail
umask 077

DB_PATH="${READING_API_DB:-${HOME}/.reading-api/reading.sqlite}"
BACKUP_DIR="${READING_API_BACKUP_DIR:-${HOME}/backups/reading-memory}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/reading-${STAMP}.sqlite"

node "$(dirname "$0")/backup-sqlite.mjs" "$DB_PATH" "$OUT"
find "$BACKUP_DIR" -maxdepth 1 -name 'reading-*.sqlite' -type f -mtime +30 -print -delete
echo "$OUT"
