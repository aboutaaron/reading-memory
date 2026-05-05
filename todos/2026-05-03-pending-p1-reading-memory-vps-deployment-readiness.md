# P1: Reading Memory VPS deployment readiness

Priority: P1
Status: code-complete-host-ops-remaining
Source: ce:review 2026-05-03
Plan: docs/plans/2026-05-03-feat-kazan-mini-reading-memory-plan.md

## Finding
V1 must deploy on the same VPS as OpenClaw, loopback-only, but the host needs readiness work before storing real reading-corpus data.

## Required Work
- Bind Reading Memory to `127.0.0.1` only.
- Add systemd user service with restart policy and resource limits.
- Confirm firewall deny-by-default posture with SSH allowed.
- Reclaim disk to at least 15GB free before production use.
- Store DB outside git checkout.
- Add daily SQLite backup and test restore.
- Add `/health` readiness with DB and disk checks.

## Acceptance Criteria
- OpenClaw can make authenticated localhost call.
- Service is not reachable publicly.
- Backup and restore succeed once.
- Health fails/not-ready on DB or disk danger.
