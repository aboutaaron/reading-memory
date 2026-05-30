---
date: 2026-05-30
topic: combine-harvester-run-ledger
---

# Combine Harvester Run Ledger

## Summary

Add a hybrid run-ledger pattern for Reading Memory workflows. V1 uses caller-side files so agents can resume reading work immediately, while defining a stable event vocabulary that can later move into service-backed run storage.

---

## Problem Frame

Reading Memory already preserves durable reading items and brief usage outcomes. What it does not preserve well is the operational path that led to those outcomes.

Newsletter triage exposed the gap clearly: the agent fetched items, summarized them, marked some Done, restored one, captured some in Reading Memory, and verified inbox state. The corpus, Gmail state, temporary JSON, and chat transcript each held part of the truth, but no single artifact described the run well enough for a fresh agent to resume it without reconstructing context.

The combine-harvester pattern should make long-running reading workflows resumable, auditable, and inspectable without turning Reading Memory into a human task app.

---

## Key Decisions

- **Hybrid first version.** Start with file-backed run ledgers, but define event semantics carefully enough that they can be promoted into SQLite/API-backed run events later.
- **Newsletter triage as the first proof workflow.** It has immediate user-visible value, real state transitions, and enough risk to prove whether a fresh agent can resume correctly.
- **Morning brief as the second proof workflow.** It is strategically important and already has `/brief-guide` and `/brief-events`, but should follow after the ledger shape survives one lower-risk manual workflow.
- **Run events stay distinct from brief events.** Brief events are corpus facts with resurfacing semantics; run events are operational facts about how work progressed.
- **MCP is out of scope.** A future MCP adapter may expose stable run semantics, but the run-ledger product shape should stand without it.

---

## Actors

- A1. Aaron: asks for reading/newsletter work and wants confidence that the agent can resume, audit, and explain what happened.
- A2. Calling agent: performs reading workflows, records run state, resumes from prior state, and reports outcomes.
- A3. Reading Memory service: stores corpus items, analyses, relationships, brief events, activity logs, and later may store run events.
- A4. Future planning/implementation agent: consumes this document to plan the smallest useful version without inventing scope.

---

## Key Flows

- F1. Newsletter triage run
  - **Trigger:** Aaron asks to clear newsletters or decide what to read/skim/mark Done.
  - **Actors:** A1, A2
  - **Steps:** The agent creates a run ledger, records fetch inputs, records each considered item, records read/skim/done decisions, records archive/restore actions, records Reading Memory captures, verifies final inbox state, and writes the next recovery step.
  - **Outcome:** A fresh agent can inspect the run ledger and know what was done, what remains, and what should not be repeated.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R8

- F2. Resume interrupted run
  - **Trigger:** A session compacts, crashes, pauses, or another agent takes over.
  - **Actors:** A2
  - **Steps:** The agent finds the latest relevant run ledger, reads the current phase and next step, checks any verification state before acting, and appends a resume event before continuing.
  - **Outcome:** Work continues from durable state instead of from memory, chat reconstruction, or guesswork.
  - **Covered by:** R1, R2, R3, R7, R9

- F3. Morning brief second proof
  - **Trigger:** The run-ledger pattern has survived newsletter triage and Aaron wants to try it on morning brief assembly.
  - **Actors:** A1, A2, A3
  - **Steps:** The agent records candidate consideration, inclusion/skips, Reading Memory item links, and final delivery/brief-event references using the same event vocabulary where possible.
  - **Outcome:** Morning brief decisions become resumable and auditable without replacing `/brief-events`.
  - **Covered by:** R3, R4, R5, R10, R11

---

## Requirements

**Run Ledger Shape**

- R1. The system must define a run ledger for multi-step Reading Memory workflows, including goal, workflow type, input scope, current phase, decisions, verification, and next recovery step.
- R2. The first version must be usable without new Reading Memory service endpoints.
- R3. The run ledger must include an append-friendly event stream so agents can add progress without rewriting prior history.
- R4. The event vocabulary must be workflow-neutral enough to cover newsletter triage first and morning brief assembly second.

**Newsletter Triage Proof**

- R5. Newsletter triage must record each considered newsletter with lightweight source identity, decision, rationale, and relevant action state.
- R6. Archive, restore, and verification actions must be recorded distinctly from reading decisions.
- R7. A fresh agent must be able to resume a newsletter triage run from the ledger and avoid duplicating captures, re-archiving unintended items, or losing the intended read queue.

**Reading Memory Integration**

- R8. When an item is ingested into Reading Memory, the ledger must record the returned item id and capture outcome.
- R9. When an item is not ingested, the ledger must record a short non-capture reason without storing full rejected content by default.
- R10. Morning brief use must be able to link run decisions to existing brief-guide and brief-event concepts without replacing them.
- R11. The ledger vocabulary must preserve the distinction between operational run state and durable corpus facts.

**Promotion Path**

- R12. The file-backed v1 must leave a clean path to future SQLite/API-backed run storage.
- R13. The v1 should identify stable event names through real use before requiring a schema migration.
- R14. The design must support a future resume eval that simulates interruption and verifies correct continuation.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R5, R6, R8.** Given a newsletter triage run considers fourteen items, when the run completes, the ledger shows each item considered, the decision made, any Done/restore action, any Reading Memory item id, and final verification.
- AE2. **Covers R7, R9.** Given a session pauses after summaries but before archive actions, when a fresh agent resumes, it can identify which items were only summarized, which were already ingested, and which actions remain pending.
- AE3. **Covers R10, R11.** Given the pattern is later applied to morning brief assembly, when an item is included in a brief, the run ledger can reference the operational decision while `/brief-events` remains the durable resurfacing record.
- AE4. **Covers R12, R13, R14.** Given two or three manual run ledgers exist, when planning a service-backed version, event names and promotion candidates are based on observed usage rather than speculation.

---

## Success Criteria

- A newsletter triage run can be resumed by a fresh agent without reconstructing state from chat.
- The run ledger makes it clear what was read, skimmed, marked Done, restored, captured, skipped, and verified.
- The v1 pattern does not require a Reading Memory migration or endpoint change.
- The event vocabulary is stable enough to try on morning brief assembly next.
- Planning can produce an implementation plan without inventing product behavior, scope boundaries, or success criteria.

---

## Scope Boundaries

- No MCP adapter in this brainstorm.
- No human-facing UI.
- No replacement for `/brief-events`.
- No service-backed run endpoint in v1 unless planning finds file-backed ledgers cannot satisfy resumability.
- No full rejected-content archive by default.
- No attempt to instrument every possible agent action automatically.

---

## Dependencies / Assumptions

- Reading Memory remains a loopback backend service, with OpenClaw/Codex-style agents owning user interaction.
- Calling agents can write local run artifacts during reading workflows.
- Newsletter triage remains the first proof workflow; morning brief follows after the first proof is useful.
- Existing observability work around consideration events is adjacent and should inform vocabulary, but this brainstorm is specifically about resumable run state.

---

## Outstanding Questions

### Deferred To Planning

- [Affects R1-R4] What exact file convention should v1 use for the run ledger?
- [Affects R3-R6] What minimum event vocabulary is enough for newsletter triage without overfitting to Gmail?
- [Affects R7, R14] How should the resume eval simulate interruption without touching real inbox state?
- [Affects R10-R11] How should morning brief run events reference `/brief-events` without duplicating their semantics?
