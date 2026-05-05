#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${READING_API_DB:-${HOME}/.reading-api/reading.sqlite}"
BACKUP_DIR="${READING_API_BACKUP_DIR:-${HOME}/backups/reading-api}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/reading-${STAMP}.sqlite"

mkdir -p "$BACKUP_DIR"
node "$(dirname "$0")/backup-sqlite.mjs" "$DB_PATH" "$OUT"
find "$BACKUP_DIR" -name 'reading-*.sqlite' -type f -mtime +30 -print -delete
echo "$OUT"
