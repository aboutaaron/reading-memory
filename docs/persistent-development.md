# Persistent development runs

This is the first development-orchestration slice for [#75](https://github.com/aboutaaron/reading-memory/issues/75). It runs outside the reading service and corpus. A user approves a bounded JSON task once; a durable manager dispatches Codex implementation, acceptance tests, independent review, corrections, and a draft PR. It marks the PR ready only after the final commit passes all gates. It never merges or deploys.

## Runtime and authority

Requires Node 22.19+ with `node:sqlite`, Git, authenticated `gh`, and authenticated Codex CLI. The tested Mac uses Node 24.19, npm 11.10.1, and Codex CLI 0.162.1 with its existing ChatGPT login. No provider SDK or new API key is involved. Install the repository dependencies with `npm ci`; verify credentials with `codex login status` and `gh auth status` without printing credential files.

Hermes is the persistent wakeup/coordination host. The deterministic development manager owns the operational state machine and all GitHub writes. Coding workers only edit the approved scope; a separate Codex process reviews a detached worktree at the candidate SHA. A worker summary alone cannot establish completion.

A backlog item does not authorize a run. Assignment requires `approved: true`, a stable task ID, objective, acceptance criteria, allowed file paths, constraints, test commands, explicit push/PR authority, and finite budgets. Treat the contract like executable local configuration: its test commands and runtime paths are trusted user-approved inputs. No corpus reads, production changes, deployment, merge, or external messages are authorized by this contract.

## Assign and operate

Copy [the example contract](examples/dev-run.json), set its repository path and task-specific fields, and save it outside the checkout. Use a unique task ID for a new outcome; repeat assignment of the same unchanged contract reconciles the existing run.

```sh
node scripts/dev-run.mjs assign --contract /absolute/path/task.json
node scripts/dev-run.mjs status --run /absolute/path/run
node scripts/dev-run.mjs tick --run /absolute/path/run
node scripts/dev-run.mjs run --run /absolute/path/run
node scripts/dev-run.mjs pause --run /absolute/path/run
node scripts/dev-run.mjs resume --run /absolute/path/run
node scripts/dev-run.mjs cancel --run /absolute/path/run
```

`tick` is the bounded scheduling primitive. It reconciles recorded worker identities, Git state, and applicable GitHub state before taking the next step. A fresh process can invoke it without any prior chat. `run` repeatedly advances the same run. Pause prevents new work; cancellation stops the owned worker process group. Neither deletes worktrees or PRs.

On macOS, use a canonical temporary-directory path for this repository's existing tests: `TMPDIR=/private/tmp npm test`. The system's `/var/folders` symlink spelling triggers pre-existing path-equality and script-entrypoint assertions.

## Durable record and completion gates

The configurable root defaults to `~/.reading-api/runs`. One root has one `coordination.sqlite` operational database, separate from all reading-corpus tables. Each approved task has `development/TASK_ID/` containing the original contract, ledger inputs/events, generated status summaries, isolated implementation worktree, and private attempt artifacts. Worker artifacts include structured output, bounded execution metadata, and a private CLI log. Keep the root private.

The SQLite `transitions` table is the append-only manager history; the `runs` table is its current-state view. Attempt records preserve the once-only supervisor claim, process identity, worker session, candidate, completion, and usage. `state.json`, `development.md`, and the run-ledger `custom:dev-transition` breadcrumbs are inspectable projections. The general run-ledger reducer does not interpret development-specific phases. Read operational status through `dev-run status`.

A manager holds the root's SQLite write transaction for a bounded state transition. This serializes concurrent manager ticks without a stale lock-file takeover race; process death releases the lock. At most one worker attempt runs across that root. A detached supervisor claims a reserved attempt transactionally, so replayed manager launches cannot start a second coding worker. A missing supervisor with an uncertain child outcome becomes a blocker, not permission to start a replacement.

Status is versioned JSON (`{ok, state}`). It includes contract, task/branch/base identity, current phase and control, next action, blocker, candidate SHA, attempts, test/review/CI evidence, PR, observed tokens, and deadline. This is the notebook integration surface; no dashboard is introduced.

The progression is assignment → implementation → acceptance tests → independent review → repair if needed → draft PR → named CI checks → review ready. `control` separately records active, paused, blocked, cancelling, or cancelled. A correction invalidates old test/review evidence. Required GitHub check names are explicit in the contract; missing, skipped, neutral, failed, pending, or wrong-commit checks cannot establish success. Local and remote Git state are reconciled before publication and readiness. Closed/foreign PRs and conflicting branches block progress. There is no merge or deployed state in this slice.

## Hermes integration

The inspected local Hermes installation was commit `1fd18277267152893a8a24792b79213e7ca3f899`. `hermes gateway status` confirmed an existing launchd-supervised gateway; `hermes cron status` confirmed the scheduler. This implementation does not install or restart that gateway.

Verified capabilities in installed source and CLI help:

- `hermes cron create`, `run`, `runs`, `pause`, and `resume` provide durable scheduled execution and execution history.
- `--script` runs a file under `~/.hermes/scripts/`; `--no-agent` runs it without a model request. Empty stdout is silent.
- `--deliver local` keeps output local. A Hermes-origin job can use `origin` to route results to that conversation. Do not guess a chat ID or copy recipient metadata into a development ledger.
- Hermes terminal supports `background=true, persist_on_release=true`; its process registry checkpoints PID/start identity and can adopt surviving processes after gateway restart.
- Hermes `delegate_task` explicitly stops its subagent tree on session exit. It is unsuitable as the durability boundary for this workflow.

Codex CLI supports `exec --json --output-schema FILE --output-last-message FILE`, verified both from installed help and a live authenticated invocation. The [official repair-loop example](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex) documents separate structured review and repair invocations. The local adapter uses those interfaces and records worker session references and observed token usage.

## Boundaries and remaining work

This is a local trusted-agent workflow, not an untrusted-code sandbox or a distributed consensus service. Keep one coordination root on a local filesystem and use the installed manager for that root. A second independent root cannot coordinate ownership of the first. Keep operational artifacts private and do not paste raw worker transcripts into issues.

Exact dollar spend is unavailable through this CLI. The token budget is a post-attempt threshold: one in-flight Codex invocation can exceed the remaining tokens before usage is reported, and then no further worker may start. Worker wall time and attempt count are enforced separately. Do not describe this as a hard token or monetary ceiling. An uncertain external write is reconciled by identity and fails closed when its outcome cannot be established. Operators must inspect a durable blocker rather than deleting state to force replay.

The first live trial and deterministic crash/retry tests are distinct evidence. Three live trials are required by the broader issue; one successful interrupted trial does not close #75. Neither local synthetic tests nor this development workflow establishes private-corpus extraction or analysis quality.

## Install a Hermes wakeup for one approved run

The bridge `scripts/hermes-dev-run.mjs --run RUN_DIRECTORY` advances only that assigned run. It prints actionable blocked/paused/cancelled or review-ready state, and stays silent for unchanged notices and routine progress. Notification claims are stored in the coordination DB. They are at-most-once local stdout claims, not proof of end-user delivery: a crash between claiming and printing can lose a notice; `status` and Hermes execution history remain inspectable. Hermes owns transport retries.

Create a shell script under `~/.hermes/scripts/` with absolute paths and a PATH containing Node, npm, Codex, Git, and gh:

```sh
#!/bin/sh
export PATH=/absolute/runtime/bin:/absolute/codex/bin:/opt/homebrew/bin:/usr/bin:/bin
export TMPDIR=/private/tmp
exec /absolute/runtime/bin/node /absolute/reading-memory/scripts/hermes-dev-run.mjs --run /absolute/run/directory
```

Check `hermes cron list --all` before creating a job; reuse its ID when this run already has one. Then:

```sh
hermes cron create 'every 1m' --name reading-memory-TASK_ID \
  --script reading-memory-TASK_ID.sh --no-agent --deliver local --repeat 120
hermes cron run JOB_ID
hermes cron runs JOB_ID --limit 10
hermes cron pause JOB_ID
hermes cron resume JOB_ID
```

`--repeat 120` bounds scheduler executions separately from the run's worker/elapsed/token budgets. Pause the job when the run is complete. A paused job must be resumed before `hermes cron run` will execute it; the installed help suggested otherwise, but the live trial verified this behavior. For human-channel delivery, create/update the job from the intended Hermes conversation using its `cronjob` tool with `deliver: "origin"`. Local CLI execution does not establish that channel origin, so the trial uses local delivery and does not claim an untested message route.

Ready-to-paste instruction for Hermes:

> Operate only the Reading Memory development run at RUN_DIRECTORY using MANAGER_CHECKOUT/scripts/dev-run.mjs and scripts/hermes-dev-run.mjs. Read status and its saved approved contract first. Keep the task ID, objective, acceptance criteria, constraints, and budgets unchanged. On each wake invoke the bridge once; it reconciles existing work before taking a step. Never dispatch workers directly or recreate a PR to work around a blocker. Reuse the existing cron job for this run, or create one bounded wakeup job for it using the bridge shell script and deliver results to this conversation (`origin`). Notify me only of meaningful blockers, required decisions, cancellation, or a review-ready PR, quoting the candidate SHA and evidence. Stay quiet on routine/unchanged progress. On restart, read durable status and continue the same run; do not select work from the backlog. Respect pause/cancel, and stop scheduling after readiness or cancellation. No merge, production deployment, private-corpus changes, or other external messages are authorized.

## Small installation package

The manager itself uses Node built-ins only. To keep wakeups independent of an expendable development worktree, copy these six `.mjs` files from the reviewed commit into a stable directory outside any checkout, preserving `scripts/lib/`:

```sh
runtime="$HOME/.reading-api/dev-orchestration/runtime"
mkdir -p "$runtime/scripts/lib"
cp scripts/dev-run.mjs scripts/hermes-dev-run.mjs "$runtime/scripts/"
cp scripts/lib/dev-manager.mjs scripts/lib/dev-state.mjs \
  scripts/lib/dev-supervisor.mjs scripts/lib/run-ledger.mjs "$runtime/scripts/lib/"
node "$runtime/scripts/dev-run.mjs" status --run /absolute/run/directory
```

Point the Hermes shell launcher at this stable copy. Keep a manifest of the source commit and file hashes with the installation. Upgrade only while the run is paused and no active worker is using the old runtime; preserve the operational root. Repository dependencies are installed by the approved acceptance commands in the isolated worker checkout, not in this six-file manager package.

The [first live trial report](evidence/2026-10-11-persistent-orchestration.md) records the real interruption, worker/review sessions, PR, exact commit, tests, CI, elapsed time, observed usage, and remaining gates.
