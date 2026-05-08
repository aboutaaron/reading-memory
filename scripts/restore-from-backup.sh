#!/usr/bin/env bash
# Restore the Reading Memory SQLite database from a backup.
#
# Usage:
#   scripts/restore-from-backup.sh [<backup-file>]
#
# Without arguments, restores from the newest *.sqlite under
# READING_API_BACKUP_DIR (defaults to ~/backups/reading-memory).
#
# Behaviour:
#   1. Source ~/.reading-api/env if present so READING_API_DB and
#      READING_API_BACKUP_DIR resolve the same way the service sees them.
#   2. Detect the runner — systemd user unit, launchd LaunchAgent, or
#      neither — and stop the service if it's running.
#   3. Take a timestamped safety copy of the live db before overwriting.
#   4. Copy the chosen backup over READING_API_DB.
#   5. Run PRAGMA integrity_check on the restored db; abort and roll back
#      to the safety copy if it doesn't return "ok".
#   6. Restart the service via the same runner that stopped it.
#
# Idempotent: safe to re-run, safe if the service isn't running, safe if
# no backups exist (exits non-zero with a clear message).

set -euo pipefail

ENV_FILE="${READING_API_ENV_FILE:-$HOME/.reading-api/env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DB_PATH="${READING_API_DB:-${HOME}/.reading-api/reading.sqlite}"
BACKUP_DIR="${READING_API_BACKUP_DIR:-${HOME}/backups/reading-memory}"

BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  if [ ! -d "$BACKUP_DIR" ]; then
    echo "restore: backup dir not found: $BACKUP_DIR" >&2
    exit 1
  fi
  BACKUP=$(ls -t "$BACKUP_DIR"/reading-*.sqlite 2>/dev/null | head -1 || true)
  if [ -z "$BACKUP" ]; then
    echo "restore: no backups found in $BACKUP_DIR" >&2
    exit 1
  fi
  echo "Selected newest backup: $BACKUP"
fi

if [ ! -f "$BACKUP" ]; then
  echo "restore: backup file not found: $BACKUP" >&2
  exit 1
fi

# Detect the active runner. Each branch sets RUNNER and the start/stop
# hooks; an empty RUNNER means we'll skip service-control steps.
RUNNER=""
if command -v launchctl >/dev/null 2>&1 \
   && launchctl print "gui/$(id -u)/com.aboutaaron.reading-memory" >/dev/null 2>&1; then
  RUNNER="launchd"
elif command -v systemctl >/dev/null 2>&1 \
     && systemctl --user is-enabled reading-memory.service >/dev/null 2>&1; then
  RUNNER="systemd"
fi

wait_for_launchd_unload() {
  # `launchctl bootout` returns immediately but unloads asynchronously; if
  # we bootstrap again before the bundle is fully released we get
  # "Input/output error". Poll until launchctl print no longer recognises
  # the agent (up to ~10s).
  local target="gui/$(id -u)/com.aboutaaron.reading-memory"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! launchctl print "$target" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "restore: timed out waiting for LaunchAgent to unload" >&2
  return 1
}

stop_service() {
  case "$RUNNER" in
    launchd)
      echo "Stopping LaunchAgent (com.aboutaaron.reading-memory)..."
      launchctl bootout "gui/$(id -u)/com.aboutaaron.reading-memory" 2>/dev/null || true
      wait_for_launchd_unload
      ;;
    systemd)
      echo "Stopping systemd user service (reading-memory.service)..."
      systemctl --user stop reading-memory.service
      ;;
    *)
      echo "No active service runner detected; skipping stop."
      ;;
  esac
}

# WAL-mode SQLite spreads state across the .sqlite + .sqlite-wal +
# .sqlite-shm triple. When we drop a fresh file in over the live db, the
# old sidecars become inconsistent with the new contents and SQLite
# reports the result as "malformed" on the next open. Always clear the
# sidecars when the .sqlite file is being replaced; SQLite recreates them
# as needed when the new db is opened.
clear_sidecars() {
  rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
}

start_service() {
  case "$RUNNER" in
    launchd)
      local plist="$HOME/Library/LaunchAgents/com.aboutaaron.reading-memory.plist"
      if [ -f "$plist" ]; then
        echo "Starting LaunchAgent..."
        launchctl bootstrap "gui/$(id -u)" "$plist"
      else
        echo "restore: plist not found at $plist; start the service manually." >&2
      fi
      ;;
    systemd)
      echo "Starting systemd user service..."
      systemctl --user start reading-memory.service
      ;;
    *)
      echo "No active service runner detected; restore left the service stopped."
      ;;
  esac
}

# Use Node's built-in sqlite for the integrity check so we don't depend
# on the sqlite3 CLI being installed.
verify_db() {
  local target="$1"
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    db.close();
    const result = row && Object.values(row)[0];
    if (result !== 'ok') {
      console.error('integrity_check failed:', JSON.stringify(row));
      process.exit(1);
    }
    console.log('integrity_check: ok');
  " "$target"
}

stop_service

SAFETY=""
if [ -f "$DB_PATH" ]; then
  SAFETY="${DB_PATH}.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$DB_PATH" "$SAFETY"
  echo "Safety copy: $SAFETY"
fi

clear_sidecars
cp "$BACKUP" "$DB_PATH"
echo "Restored $BACKUP -> $DB_PATH"

if ! verify_db "$DB_PATH"; then
  echo "restore: integrity_check failed on the restored db." >&2
  if [ -n "$SAFETY" ]; then
    echo "Rolling back to safety copy: $SAFETY" >&2
    clear_sidecars
    cp "$SAFETY" "$DB_PATH"
  fi
  start_service
  exit 1
fi

start_service

echo "Restore complete."
if [ -n "$SAFETY" ]; then
  echo "Pre-restore copy preserved at: $SAFETY"
  echo "Delete it once you're sure the restored db is good."
fi
