#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${READING_API_HOST:-127.0.0.1}"
DATA_DIR="${READING_API_DATA_DIR:-${ROOT}/.tmp/reading-memory}"
DB_PATH="${READING_API_DB:-${DATA_DIR}/reading.sqlite}"
LOG_PATH="${DATA_DIR}/server.log"
PID_PATH="${DATA_DIR}/server.pid"
TOKEN_PATH="${DATA_DIR}/token"

if [ -n "${READING_API_PORT:-}" ]; then
  PORT="$READING_API_PORT"
else
  PORT="$(node - <<'NODE'
const net = require('node:net');

(async () => {
  async function available(port) {
    return await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
  }

  for (let port = 4727; port < 4777; port += 1) {
    if (await available(port)) {
      console.log(port);
      process.exit(0);
    }
  }

  console.error('No open local port found between 4727 and 4776.');
  process.exit(1);
})();
NODE
)"
fi

BASE_URL="http://${HOST}:${PORT}"

if [ -n "${READING_API_TOKEN:-}" ]; then
  TOKEN="$READING_API_TOKEN"
elif [ -f "$TOKEN_PATH" ]; then
  TOKEN="$(cat "$TOKEN_PATH")"
else
  TOKEN="$(node -e "console.log(crypto.randomUUID())")"
fi

if [ -n "${READING_API_FLUE_MODEL:-}" ]; then
  MODEL="$READING_API_FLUE_MODEL"
elif [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  MODEL="anthropic/claude-sonnet-4-5"
else
  MODEL="openai/gpt-5.5"
fi

if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  cat >&2 <<'EOF'
Reading Memory needs a model provider key for Flue analysis.

Run one of:
  OPENAI_API_KEY=... npm --silent run try
  ANTHROPIC_API_KEY=... READING_API_FLUE_MODEL=anthropic/claude-sonnet-4-5 npm --silent run try
EOF
  exit 1
fi

node -e "
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Reading Memory requires Node >=22.13. Current: ' + process.versions.node);
  process.exit(1);
}
"

mkdir -p "$DATA_DIR"
printf '%s' "$TOKEN" > "$TOKEN_PATH"
chmod 600 "$TOKEN_PATH"

if [ ! -d node_modules ]; then
  npm ci
fi

if [ -f "$PID_PATH" ] && kill -0 "$(cat "$PID_PATH")" 2>/dev/null; then
  echo "Reading Memory is already running at ${BASE_URL}"
else
  READING_API_HOST="$HOST" \
  READING_API_PORT="$PORT" \
  READING_API_TOKEN="$TOKEN" \
  READING_API_DB="$DB_PATH" \
  READING_API_DATA_DIR="$DATA_DIR" \
  READING_API_FLUE_MODEL="$MODEL" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  npm run dev >"$LOG_PATH" 2>&1 &
  echo "$!" > "$PID_PATH"
fi

for _ in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
  echo "Reading Memory did not become healthy. Log:" >&2
  tail -n 80 "$LOG_PATH" >&2 || true
  exit 1
fi

READING_API_BASE_URL="$BASE_URL" READING_API_TOKEN="$TOKEN" npm run --silent smoke >/tmp/reading-memory-smoke.json

cat <<EOF
Reading Memory is running.

URL:
  ${BASE_URL}

Token:
  ${TOKEN}

Smoke test:
  $(cat /tmp/reading-memory-smoke.json)

Use these in your agent:
  READING_MEMORY_URL=${BASE_URL}
  READING_API_TOKEN=${TOKEN}

Install the bundled Codex skill:
  mkdir -p "\${CODEX_HOME:-\$HOME/.codex}/skills/use-reading-memory"
  cp .agents/skills/use-reading-memory/SKILL.md "\${CODEX_HOME:-\$HOME/.codex}/skills/use-reading-memory/SKILL.md"

Logs:
  ${LOG_PATH}

Stop:
  kill $(cat "$PID_PATH")
EOF
