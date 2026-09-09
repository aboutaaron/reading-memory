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
#   4. Atomically replace READING_API_DB with a private copy of the backup.
#   5. Run PRAGMA integrity_check on the restored db; abort and roll back
#      to the private safety copy if it doesn't return "ok".
#   6. Restart the service via the same runner that stopped it.
#
# Idempotent: safe to re-run, safe if the service isn't running, safe if
# no backups exist (exits non-zero with a clear message).

set -euo pipefail
umask 077

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
#
# We test for *installation* (the plist file or a unit known to systemd's
# user manager), not the *current loaded/enabled state* — `is-enabled` and
# `launchctl print` both miss valid states like `disabled`, `linked`, or
# bootout'd, which would leave RUNNER empty for a user who really is on
# that runner and expects the script to handle their service.
RUNNER=""
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/com.aboutaaron.reading-memory.plist"
if [ -f "$LAUNCHD_PLIST" ] && command -v launchctl >/dev/null 2>&1; then
  RUNNER="launchd"
elif command -v systemctl >/dev/null 2>&1 \
     && systemctl --user cat reading-memory.service >/dev/null 2>&1; then
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

start_service() {
  case "$RUNNER" in
    launchd)
      echo "Starting LaunchAgent..."
      launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
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

stop_service

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if node "$SCRIPT_DIR/restore-sqlite.mjs" "$BACKUP" "$DB_PATH"; then
  start_service
  echo "Restore complete. Keep the private safety snapshot until the restored database is verified."
else
  status=$?
  if [ "$status" -eq 2 ]; then
    echo "restore: recovery requires manual attention; service left stopped." >&2
  else
    start_service
  fi
  exit "$status"
fi
