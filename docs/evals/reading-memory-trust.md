# Reading Memory Trust Eval

Reading Memory uses a small canary eval before changing model routing, query ranking, brief-guide logic, or source-dedupe behavior.

The checked-in eval fixtures are synthetic. They preserve expected behaviors and item identities without storing private article or email text.

Optional production snapshot fixtures may be generated for local regression checks, but they must be sanitized before storage:

- no raw article, newsletter, PDF, or email body text
- no bearer tokens, email recipients, unsubscribe URLs, or private headers
- bounded summaries, tags, source identity, and expected item ids only
- never required for CI

Run:

```bash
npm run eval:reading
```

The command emits JSONL records with fixture id, check name, pass/fail, and details. Critical fixture failures block model/ranking changes until investigated.

## Run-Ledger Resume Canary

Run ledgers have a separate resume canary because they test workflow state, not corpus quality.

The synthetic fixture at `scripts/fixtures/newsletter-triage-run.jsonl` models an interrupted newsletter triage run:

- fetched newsletter sources were considered
- reading decisions were recorded
- one Reading Memory capture returned an item id
- an archive action remains pending verification

The resume tests assert that a fresh agent can derive completed decisions, pending external actions, captured item ids, and the next recovery step without touching a real inbox or mutating Reading Memory.

Run:

```bash
node --test --import tsx scripts/run-ledger-resume.test.mjs
```

This canary complements `npm run eval:reading`. It should stay synthetic and must not include raw newsletter bodies, private headers, bearer tokens, unsubscribe URLs, or live mailbox identifiers.

Morning brief assembly is the next proof workflow for this pattern, but `/brief-guide` and `/brief-events` remain the service-backed source-selection surfaces until two or three real run ledgers prove the event names should move into SQLite-backed run events.
