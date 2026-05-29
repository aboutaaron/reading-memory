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
