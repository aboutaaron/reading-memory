#!/bin/bash
# Wrapper invoked by the LaunchAgent. launchd does not have an
# EnvironmentFile= equivalent (systemd does), so we source ~/.reading-api/env
# here before invoking `npm start`. Mirrors the systemd unit's
# `EnvironmentFile=%h/.reading-api/env` directive.

set -euo pipefail

ENV_FILE="${READING_API_ENV_FILE:-$HOME/.reading-api/env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "reading-memory launchd: env file not found at $ENV_FILE" >&2
  echo "Run 'npx github:aboutaaron/reading-memory setup --target claude-code'" >&2
  echo "(or another target) to generate it before loading this LaunchAgent." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

exec npm start
