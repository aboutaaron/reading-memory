# Reading Memory — macOS LaunchAgent

The macOS counterpart to [`../systemd/`](../systemd/). Use this on macOS to keep the Reading Memory service running across logins, with auto-restart on crash, without leaving a terminal window open.

## What's here

- **`com.aboutaaron.reading-memory.plist`** — `LaunchAgent` definition. Template with `__HOME__`, `__INSTALL_DIR__`, and `__PATH__` placeholders.
- **`start.sh`** — wrapper script invoked by `launchd`. Sources `~/.reading-api/env` (since `launchd` has no `EnvironmentFile=` equivalent), then `exec`s `npm start`.

## Install

1. **Generate the env file** (if you haven't already):

   ```bash
   npx github:aboutaaron/reading-memory setup --target claude-code
   ```

   This writes `~/.reading-api/env` with your bearer token and config.

2. **Render the plist with your paths** and copy to `~/Library/LaunchAgents/`:

   ```bash
   INSTALL_DIR="$(pwd)"  # from inside the reading-memory checkout
   sed \
     -e "s|__HOME__|$HOME|g" \
     -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
     -e "s|__PATH__|/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin|g" \
     launchd/com.aboutaaron.reading-memory.plist \
     > ~/Library/LaunchAgents/com.aboutaaron.reading-memory.plist
   ```

   Adjust `__PATH__` if your `node`/`npm` live elsewhere (Intel Macs typically use `/usr/local/bin`).

3. **Load it:**

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aboutaaron.reading-memory.plist
   ```

   The service starts immediately and re-starts on every login.

4. **Verify:**

   ```bash
   curl -fsS http://127.0.0.1:4727/health | jq .
   ```

   Or, from a Claude Code session: `/reading:status`.

## Logs

- `stdout` → `~/.reading-api/launchd-stdout.log`
- `stderr` → `~/.reading-api/launchd-stderr.log`

Tail them with `tail -f ~/.reading-api/launchd-*.log`.

## Restart / disable / remove

```bash
# Restart (e.g. after pulling new code + npm run build)
launchctl kickstart -k gui/$(id -u)/com.aboutaaron.reading-memory

# Stop and unload (removes from runtime, plist file stays on disk)
launchctl bootout gui/$(id -u)/com.aboutaaron.reading-memory

# Permanently uninstall
launchctl bootout gui/$(id -u)/com.aboutaaron.reading-memory
rm ~/Library/LaunchAgents/com.aboutaaron.reading-memory.plist
```

## Why a wrapper script

`launchd` plists can declare `EnvironmentVariables`, but only with literal values — there is no `EnvironmentFile=` like systemd. Since the bearer token (and any per-provider `<PROVIDER>_BASE_URL` overrides — see the root README) live in `~/.reading-api/env`, baking them into the plist would duplicate them and create a sync hazard if `setup` is re-run. The wrapper script sources the env file at process start and `exec`s `npm start`, keeping the plist content static and the env file authoritative.

## Crash policy

`KeepAlive.Crashed = true`, `SuccessfulExit = false`. The service restarts only on crash; a clean exit (e.g., from `launchctl bootout`) does not retrigger. `ThrottleInterval = 10` prevents spin loops if the service exits immediately at startup.

## Backup timer (not yet bundled)

The `systemd/` directory ships a `reading-memory-backup.timer` that triggers a daily SQLite backup. The `launchd` equivalent (a separate plist with `StartCalendarInterval`) is a future contribution; for now run `scripts/backup-sqlite.sh` from cron or by hand.
