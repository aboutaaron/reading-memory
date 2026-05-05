# P2: Reading Memory operational runbook

Priority: P2
Status: implemented
Source: ce:review 2026-05-03
Plan: docs/plans/2026-05-03-feat-kazan-mini-reading-memory-plan.md

## Finding
The app plan needs enough runbook material to safely operate a stateful SQLite service on the VPS.

## Required Work
- README documents run/deploy/env/API examples.
- Document rollback steps and migration failure behavior.
- Add systemd unit and backup script to repo.
- Add health probe/watchdog path.
- Add log redaction/rotation expectations.
- Add graceful shutdown on SIGTERM.

## Acceptance Criteria
- A fresh deploy can be started, checked, backed up, restored, restarted, and rolled back from documented commands.
