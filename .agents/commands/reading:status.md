---
name: reading:status
description: Health-check the local Reading Memory service. Verify the env vars are set, the service on http://127.0.0.1:4727 is reachable, the database is OK, and the disk has headroom. Use when ingest or query is failing, on the first session of the day, or any time you need to confirm Reading Memory is configured before relying on it.
---

# Reading Memory Status

Read-only health check for the Reading Memory service. Does not ingest, query, or modify state.

## Procedure

1. **Confirm env vars.** If either is missing, the service isn't configured for this session.
   - `READING_MEMORY_URL` (typically `http://127.0.0.1:4727`)
   - `READING_API_TOKEN`

   If missing, surface this and stop:
   > Reading Memory not configured. Run `npx github:aboutaaron/reading-memory setup --target claude-code` to install the bundled skill and generate `~/.reading-api/env`, then `source ~/.reading-api/env` (or load the env into your Claude Code settings).

2. **Hit the health endpoint.** `GET $READING_MEMORY_URL/health` is unauthenticated.

   ```bash
   curl -fsS --max-time 3 "$READING_MEMORY_URL/health"
   ```

   Expected response shape:

   ```json
   {
     "ok": true,
     "data": {
       "status": "ok",
       "ready": true,
       "db": "ok",
       "disk": { "free_bytes": 12345678, "warn": false }
     }
   }
   ```

3. **Report a one-line status to the user.** Match the shape:

   - All green → `Reading Memory: up · db ok · disk ok`
   - Disk warning → `Reading Memory: up · db ok · disk warn (cleanup advised)`
   - `ready: false` → `Reading Memory: degraded · not ready (status: <data.status>)`
   - Connection refused / timeout → `Reading Memory: down · service not running. Start with \`npm start\` in the reading-memory checkout (or via systemd: \`systemctl --user start reading-memory.service\`).`
   - HTTP error other than connection refused → `Reading Memory: error · HTTP <status>`

4. **Do not** call `/ingest`, `/query`, `/brief-guide`, `/items/*`, or `/activity` from this command. Status is read-only.
