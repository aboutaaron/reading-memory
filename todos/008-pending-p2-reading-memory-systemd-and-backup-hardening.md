---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, operations, systemd, backups, reading-memory]
dependencies: []
---

# Harden systemd unit and backup operations

## Problem Statement

The systemd unit uses a likely-wrong checkout path, grants runtime write access to the source tree, and backup/data file permissions plus scheduling are not enforced.

## Findings

- `systemd/reading-memory.service:7` uses `%h/kazan-workspace/reading-memory`, but this repo is `/root/.openclaw/workspace/reading-memory`.
- `systemd/reading-memory.service:20` includes the checkout in `ReadWritePaths`.
- `scripts/backup-sqlite.sh:9` creates backup dirs with default permissions.
- `scripts/backup-sqlite.mjs:19` writes backups without chmod.
- README documents a manual daily backup command but no timer/cron.

## Proposed Solutions

### Option 1: Align unit to actual path and harden permissions

**Approach:** Use the real deploy path or documented symlink, remove checkout from `ReadWritePaths`, set restrictive umask and chmod/chown for data/backups.

**Pros:** Production-safe with minimal feature changes.

**Cons:** Host-specific path needs a clear convention.

**Effort:** Medium

**Risk:** Low

### Option 2: Install from immutable release directory

**Approach:** Deploy build artifacts to a read-only release dir and keep workspace separate.

**Pros:** Cleaner operations model.

**Cons:** More deployment machinery.

**Effort:** Large

**Risk:** Medium

## Recommended Action

To be filled during triage.

## Technical Details

Affected files:
- `systemd/reading-memory.service`
- `scripts/backup-sqlite.sh`
- `scripts/backup-sqlite.mjs`
- `README.md`

## Acceptance Criteria

- [ ] Unit deploys from the documented actual path.
- [ ] Runtime cannot write source/build/package files.
- [ ] DB and backup dirs are `0700`; DB and backup files are `0600`.
- [ ] Automatic backup schedule is documented or included.
- [ ] Restore drill remains documented and tested manually before real data.

## Work Log

### 2026-05-04 - CE Review

**By:** Kazan

**Actions:**
- Consolidated security, ops, and learnings findings.

**Learnings:**
- Loopback services still need least-privilege host hardening because parser bugs become persistence risks.

