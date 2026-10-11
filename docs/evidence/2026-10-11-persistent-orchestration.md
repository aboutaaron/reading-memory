# Persistent orchestration: first live trial

This report separates the real development run from deterministic fixture tests. It supports [issue #75](https://github.com/aboutaaron/reading-memory/issues/75), which remains open: this is one live trial, not the three trials requested by the broader issue.

## Real task and runtime

The approved task was to prevent failed run-ledger verification from clearing a pending external action. It changes caller-side tooling and regression tests only. The open backlog and PRs were checked first: no open PRs existed; #70 and #72 had outstanding private-data quality gates, which were outside this task's authority.

- Run/task ID: `ledger-verification-live-20261011`.
- Frozen base: `d82fef2005b8c016fb090934a6b5379d76e1bbda`.
- Branch: `codex/dev-ledger-verification-live-20261011`.
- Candidate: `40b662c3b6d2b89747b0c99d82326dcae5c1aa6c`.
- Result: [PR #76](https://github.com/aboutaaron/reading-memory/pull/76), review ready at 16:26:04 PDT after all six required CI checks passed.
- Local runtime: macOS, Node 24.19, npm 11.10.1, Codex CLI 0.162.1 authenticated through ChatGPT.
- Hermes gateway was already supervised by launchd. Its native scheduler ran the approved run's bridge, with local output and no model request per scheduler tick.
- Hermes job: `3a1fd0bc3cc3`; direct recovery execution: `13833ab50d09430c8ad3654ad53288d0`. Subsequent scheduler executions were recorded by `hermes cron runs`.

No production service or private reading corpus was read or changed. Neither PR was merged or deployed. No new work was selected automatically.

## Deliberate interruption and fresh-process recovery

The run was assigned at 16:16:50 PDT on October 11, 2026. Its implementation supervisor began at 16:17:09. At **16:17:29 PDT**, the trial harness verified the running worker, then killed manager PID `17171` with **SIGKILL**. Worker supervisor PID `17217` remained alive.

Hermes invoked the bridge in a fresh process at 16:17:36. Status reconciliation preserved the original contract and attempt `ledger-verification-live-20261011-001-implement`; the attempt count remained **one** and the same worker PID remained alive. The manager did not reconstruct context from a conversation or launch another implementation worker.

The worker completed at 16:19:10. Hermes collected and committed its scoped changes, then dispatched acceptance tests and a separate reviewer. The user supplied no additional instructions or worker messages after the initial assignment. The implementing agent provisioned the run/scheduler and exercised controls; the durable manager supplied all task packets and moved results between workers.

Actual pause/status/tick/resume commands were also exercised while the publication attempt had finished: pause held the run at four attempts, a paused tick created no action, and resume reconciled the existing PR rather than recreating it.

## Final-candidate evidence

| Gate | Evidence at `40b662c3b6d2b89747b0c99d82326dcae5c1aa6c` |
| --- | --- |
| Implementation | Codex session `01a12d41-7eae-7651-bd5a-4d4541724467`, attempt `001-implement` |
| Acceptance tests | Manager-owned attempt `002-test`: `npm ci`, `TMPDIR=/private/tmp npm test` (**486/486**), `npm run build`; all successful |
| Independent review | Separate Codex session `01a12d45-3f2d-7720-8b14-75c339f88939`, attempt `003-review`; exact candidate, `approved: true`, no actionable findings |
| CI | [GitHub Actions run](https://github.com/aboutaaron/reading-memory/actions/runs/38184115483), all six required Node 22/24/26 × umask 022/077 checks passed |

Worker self-reports were not used as test gates. The implementation worker's sandbox could not run parts of the full service suite, and the read-only reviewer could not create temporary test files. The manager's separate acceptance process ran the complete suite successfully; the reviewer reported its independent inspection and in-memory checks separately.

There were no live review findings to repair in this small task. The orchestration implementation itself received independent findings about process cleanup, publication ownership, late CI/head drift, pause races, crash reconciliation, and exact-file scope handling; these were corrected with regressions before its final review. The automatic review-repair loop is exercised by the simulated workflow below, not claimed as a live correction cycle.

Observed coding-worker usage was **610,053 input-plus-output tokens**, including cached input, across the implementation and reviewer. CLI dollar cost was unavailable. One implementation and one independent review were launched; no coding retries or duplicate PR creation occurred. The run reached review readiness in **554 seconds (9 minutes 14 seconds)**, across five attempts: implementation, tests, review, publication, and readiness. The Hermes wakeup job was paused after completion. Wall time and final completion state are preserved in the private run history.

## Simulated reliability evidence

`scripts/dev-run.test.mjs` uses real Git repositories, SQLite transactions, subprocesses, and process termination, with explicitly simulated coding and GitHub adapters. It covers:

- SIGKILL of an active manager, fresh CLI recovery, and once-only worker launch.
- Concurrent managers, pause-before-claim, pause/drain/resume, and cancellation.
- Review rejection → repair → new candidate → new tests and independent review.
- Ambiguous PR-create responses without duplicate creation.
- Missing/skipped/failed CI, local or remote commit drift, and changes immediately before marking a PR ready.
- Crashes after a commit or review-worktree creation, and rebuilding current state from append-only history.
- Real worker deadline termination, malformed worker results, uncertain process identity, and exhausted budgets.
- Remote branch ownership collisions, approved exact new-file scope, and rename source/destination scope enforcement.

These establish orchestration contracts, not model quality, remote deployment, production-corpus recovery, or end-to-end chat delivery.

## Handoff and remaining gates

See [the operating guide](../persistent-development.md) for the versioned contract, exact CLI forms, six-file runtime package, and ready-to-paste Hermes instruction. The tested local installation and private evidence remain under `~/.reading-api/dev-orchestration/`; no secrets or worker transcripts were copied into this repository.

Remaining broader work: two more bounded live trials, a live task that actually requires the automatic review-correction cycle, and verification of delivery from the user's intended Hermes conversation via `origin`. The native scheduler's local execution is verified; an external conversation route was not guessed or claimed.
