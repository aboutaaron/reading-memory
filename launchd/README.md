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

## Backup timer

A second LaunchAgent runs `scripts/backup-sqlite.sh` daily, mirroring the `systemd/reading-memory-backup.timer` unit. The wrapper at `launchd/backup.sh` sources `~/.reading-api/env`, applies a random jitter (matches `RandomizedDelaySec=10m`), then `exec`s the same portable backup script the systemd timer uses.

### Install the backup timer

```bash
INSTALL_DIR="$(pwd)"  # from inside the reading-memory checkout
sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__PATH__|/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin|g" \
  launchd/com.aboutaaron.reading-memory-backup.plist \
  > ~/Library/LaunchAgents/com.aboutaaron.reading-memory-backup.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aboutaaron.reading-memory-backup.plist
```

The default schedule is `Hour=3, Minute=20` — matches the systemd timer numerically. Note the semantic differences:

- **Time zone.** `StartCalendarInterval` fires in the system's **local time**. The systemd unit uses UTC. Adjust the plist if you want the same wall-clock fire time across both deployments.
- **Catch-up after sleep.** macOS `launchd` fires missed calendar intervals at the next wake (built-in since 10.10). No `Persistent=true` toggle is required.
- **Jitter.** `StartCalendarInterval` has no built-in `RandomizedDelaySec` equivalent, so the wrapper sleeps for `RANDOM % $READING_API_BACKUP_JITTER_SECS` seconds (default 600) before invoking the backup script. Set `READING_API_BACKUP_JITTER_SECS=0` in `~/.reading-api/env` to disable.

### Trigger a one-off backup

```bash
launchctl kickstart -k gui/$(id -u)/com.aboutaaron.reading-memory-backup
```

That runs the timer body now (the same script the daily schedule fires) so you can confirm the backup lands in `~/backups/reading-memory/` before relying on the schedule.

### Backup logs

- `stdout` → `~/.reading-api/launchd-backup-stdout.log`
- `stderr` → `~/.reading-api/launchd-backup-stderr.log`

### Remove the backup timer

```bash
launchctl bootout gui/$(id -u)/com.aboutaaron.reading-memory-backup
rm ~/Library/LaunchAgents/com.aboutaaron.reading-memory-backup.plist
```

The data files (`~/.reading-api/reading.sqlite`, `~/backups/reading-memory/*.sqlite`) are intentionally left in place. Delete them by hand if you actually want to reset the corpus.
