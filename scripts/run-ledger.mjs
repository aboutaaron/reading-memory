#!/usr/bin/env node
import {
  appendRunEvent,
  createRunLedger,
  defaultRunRoot,
  deriveRunState,
  RUN_LEDGER_SCHEMA,
  resolveRunDir
} from './lib/run-ledger.mjs';

const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'create') {
    const workflow = stringArg('--workflow') ?? 'newsletter_triage';
    const root = stringArg('--root') ?? defaultRunRoot();
    const runId = stringArg('--run-id') ?? undefined;
    const inputs = jsonArg('--input-json') ?? {};
    const result = await createRunLedger({ root, workflow, runId, inputs });
    console.log(JSON.stringify({ ok: true, ...result }));
  } else if (command === 'append') {
    const runDir = resolveRunDir(stringArg('--run'));
    const kind = stringArg('--event-kind');
    if (!kind) throw new Error('--event-kind is required');
    const payload = jsonArg('--payload-json') ?? {};
    const event = await appendRunEvent({ runDir, kind, payload });
    console.log(JSON.stringify({ ok: true, event }));
  } else if (command === 'status') {
    const runDir = resolveRunDir(stringArg('--run'));
    const state = await deriveRunState(runDir);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ ok: true, state }, null, 2));
    } else {
      printStatus(state);
    }
  } else if (command === 'schema') {
    console.log(JSON.stringify({ ok: true, schema: RUN_LEDGER_SCHEMA }, null, 2));
  } else {
    throw new Error('Usage: run-ledger <create|append|status|schema> [options]');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

function stringArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function jsonArg(name) {
  const value = stringArg(name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must be valid JSON: ${message}`);
  }
}

function printStatus(state) {
  console.log(`Run: ${state.run_id}`);
  console.log(`Workflow: ${state.workflow}`);
  console.log(`Status: ${state.status}`);
  console.log(`Events: ${state.event_count}`);
  console.log(`Completed decisions: ${state.completed_decisions.length}`);
  console.log(`Pending decisions: ${state.pending_decisions.length}`);
  console.log(`Pending external actions: ${state.pending_external_actions.length}`);
  console.log(`Captured items: ${state.captured_item_ids.join(', ') || 'none'}`);
  console.log(`Next step: ${state.next_step}`);
}
