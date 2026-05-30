# Run Ledgers

Run ledgers are caller-side artifacts for Reading Memory workflows that span more than one step. They preserve operational state so a fresh agent can resume without reconstructing what happened from chat.

Use a run ledger when the workflow has external actions, multiple reading decisions, or verification steps. Newsletter triage is the first proof workflow. Morning brief assembly is the next candidate once real ledgers prove the event vocabulary.

Run ledgers are not corpus memory. They can reference Reading Memory item ids, but the corpus remains the durable store for saved reading material.

## Directory Shape

Create ledgers under `~/.reading-api/runs/<workflow>/<run_id>/` by default, or pass a different root to the helper for tests and temporary work.

Each run directory contains:

| File | Purpose |
| --- | --- |
| `run.md` | Human-readable status for handoff and resume |
| `inputs.json` | Source window, workflow name, and starting parameters |
| `events.jsonl` | Append-only operational event log |
| `outputs.json` | Final run status and completion summary |

Create a run:

```bash
npm run run-ledger -- create \
  --workflow newsletter_triage \
  --input-json '{"mailbox":"newsletters","window":"today"}'
```

Append an event:

```bash
npm run run-ledger -- append \
  --run ~/.reading-api/runs/newsletter_triage/<run_id> \
  --event-kind source_considered \
  --payload-json '{"source_id":"email_123","source_kind":"newsletter","label":"Example newsletter"}'
```

Inspect resume state:

```bash
npm run run-ledger -- status \
  --run ~/.reading-api/runs/newsletter_triage/<run_id>
```

Discover the machine-readable contract:

```bash
npm run run-ledger -- schema
```

## Event Vocabulary

The event log is append-only. Use these event names:

| Event | Use |
| --- | --- |
| `run_started` | The ledger was created |
| `source_considered` | A source entered the workflow’s decision set |
| `decision_recorded` | The agent chose read, skim, done, save, reject, defer, or another workflow decision |
| `external_action_recorded` | The agent archived, restored, marked done, labeled, or otherwise acted outside Reading Memory |
| `memory_capture_recorded` | A Reading Memory ingest completed and returned an item id |
| `verification_recorded` | A previously recorded external action was verified |
| `run_resumed` | A fresh agent resumed from the ledger |
| `run_completed` | The workflow finished and verification is complete |

Common payload fields:

| Field | Notes |
| --- | --- |
| `source_id` | Stable caller-side id, such as an email id or URL hash |
| `source_kind` | `newsletter`, `url`, `pdf`, `manual`, `brief_candidate`, or another bounded kind |
| `label` | Short human label; do not include full private content |
| `decision` | Workflow decision, for example `read`, `skim`, `done`, `save`, `reject`, or `defer` |
| `rationale` | Short reason; no raw newsletter/article text or model output |
| `action_id` | Stable id for an external action that may need verification |
| `action` | External action name, such as `archive`, `restore`, `mark_done`, or `label` |
| `item_id` | Reading Memory item id returned by `/ingest` |
| `status` | Verification or action state, such as `pending` or `verified` |

The helper rejects raw-content-like payload keys such as `body`, `text`, `html`, `content`, `raw_text`, and `model_output`. Store lightweight identity and rationale, not rejected source text.

Use the documented vocabulary exactly. Workflow-specific extensions must use `custom:<lowercase-slug>` so a fresh agent can distinguish deliberate extension from typos or drift.

## Newsletter Triage

Use a run ledger before clearing newsletters when the task has more than a couple of messages or when external actions will follow the reading decisions.

Record:

1. `source_considered` for each newsletter that enters the triage set.
2. `decision_recorded` for the reading decision: `read`, `skim`, `done`, `save`, `reject`, or `defer`.
3. `memory_capture_recorded` with `item_id` when a newsletter is ingested into Reading Memory.
4. `external_action_recorded` for archive, restore, mark done, or label changes.
5. `verification_recorded` after confirming the external action actually landed.
6. `run_completed` only after decisions and external actions are verified.

Keep low-signal and rejected newsletters bounded:

- store subject or short label only when it is not sensitive
- store source ids, dates, sender labels, and hashes when useful
- do not store full body text, unsubscribe URLs, private headers, or raw model output

Capture rows do not prove external actions completed. A run with a saved Reading Memory item can still be active if archive/restore verification is pending.

## Resume Rules

A fresh agent should run `npm run run-ledger -- status -- --run <run-dir>` or inspect `run.md`.

Resume from:

- pending external actions first, because they represent real inbox or system state
- pending decisions next
- missing completion last

If the ledger has `memory_capture_recorded` rows, use the item ids as references. Do not re-ingest the same material unless the existing capture failed or the source materially changed.

## Morning Brief Boundary

Morning brief assembly is the next proof workflow for run ledgers, but v1 does not change `/brief-guide`, `/brief-events`, or the HTTP API.

For a future morning brief ledger:

- use `source_considered` for fetched newsletter candidates and `/brief-guide` candidates
- use `decision_recorded` for included, skipped, saved-for-later, or deferred choices
- use `memory_capture_recorded` only when a source is actually ingested
- keep `/brief-events` as the resurfacing ledger for stored corpus items

Run ledgers record operational assembly state. `/brief-events` records durable brief usage for Reading Memory source selection. Do not collapse those responsibilities until two or three real run ledgers prove the event names and promotion path.
