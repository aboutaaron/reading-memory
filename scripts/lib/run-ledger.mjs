import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const RUN_LEDGER_EVENTS = [
  'run_started',
  'source_considered',
  'decision_recorded',
  'external_action_recorded',
  'memory_capture_recorded',
  'verification_recorded',
  'run_resumed',
  'run_completed'
];

const REQUIRED_EVENT_FIELDS = {
  run_started: [],
  source_considered: ['source_id'],
  decision_recorded: ['source_id', 'decision'],
  external_action_recorded: ['action'],
  memory_capture_recorded: ['item_id'],
  verification_recorded: ['action_id'],
  run_resumed: [],
  run_completed: []
};

const RAW_CONTENT_KEYS = new Set([
  'body',
  'content',
  'email_body',
  'html',
  'model_output',
  'raw_content',
  'raw_email',
  'raw_model_output',
  'raw_text',
  'source_text',
  'text',
  'transcript'
]);

export function defaultRunRoot() {
  return join(process.env.READING_API_DATA_DIR ?? join(homedir(), '.reading-api'), 'runs');
}

export async function createRunLedger({
  root = defaultRunRoot(),
  workflow,
  runId = generateRunId(workflow),
  inputs = {},
  now = new Date()
}) {
  assertWorkflow(workflow);
  assertRunId(runId);
  assertPlainRecord(inputs, 'inputs');
  assertNoRawContent(inputs, ['inputs']);
  const runDir = join(root, workflow, runId);
  if (existsSync(runDir)) {
    throw new Error(`Run ledger already exists: ${runDir}`);
  }
  await mkdir(runDir, { recursive: true, mode: 0o700 });

  const inputDocument = {
    run_id: runId,
    workflow,
    created_at: now.toISOString(),
    inputs
  };
  const outputDocument = {
    run_id: runId,
    workflow,
    status: 'active',
    completed_at: null,
    summary: null
  };

  await atomicWriteJson(join(runDir, 'inputs.json'), inputDocument);
  await atomicWriteJson(join(runDir, 'outputs.json'), outputDocument);
  await writeFile(join(runDir, 'events.jsonl'), '', { flag: 'wx', mode: 0o600 });
  await appendRunEvent({ runDir, kind: 'run_started', payload: { inputs }, now });
  return { run_dir: runDir, run_id: runId, workflow };
}

export async function appendRunEvent({ runDir, kind, payload = {}, now = new Date() }) {
  assertEventKind(kind);
  assertPlainRecord(payload, 'payload');
  assertEventPayload(kind, payload);
  assertNoRawContent(payload);
  await assertLedgerFilesSafe(runDir);
  const inputs = await readJson(join(runDir, 'inputs.json'));
  const event = {
    id: `evt_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
    ts: now.toISOString(),
    kind,
    workflow: inputs.workflow,
    run_id: inputs.run_id,
    payload
  };
  await writeFile(join(runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a', mode: 0o600 });

  if (kind === 'run_completed') {
    const outputs = await readJson(join(runDir, 'outputs.json'));
    await atomicWriteJson(join(runDir, 'outputs.json'), {
      ...outputs,
      status: 'completed',
      completed_at: event.ts,
      summary: payload.summary ?? outputs.summary ?? null
    });
  }

  const state = await deriveRunState(runDir);
  await refreshRunMarkdown(runDir, state);
  return event;
}

export async function deriveRunState(runDir) {
  await assertLedgerFilesSafe(runDir);
  const inputs = await readJson(join(runDir, 'inputs.json'));
  const outputs = await readJson(join(runDir, 'outputs.json'));
  const events = await readEvents(join(runDir, 'events.jsonl'));
  const sources = new Map();
  const externalActions = new Map();
  const verifiedActionIds = new Set();
  const capturedItemIds = [];
  let completedAt = outputs.completed_at ?? null;
  let completionSummary = outputs.summary ?? null;

  for (const event of events) {
    const payload = event.payload ?? {};
    const sourceId = stringValue(payload.source_id);

    if (event.kind === 'source_considered' && sourceId) {
      const source = ensureSource(sources, sourceId);
      source.considered = true;
      source.label = stringValue(payload.label) ?? source.label;
      source.source_kind = stringValue(payload.source_kind) ?? source.source_kind;
      source.last_event_at = event.ts;
    }

    if (event.kind === 'decision_recorded' && sourceId) {
      const source = ensureSource(sources, sourceId);
      source.decision = stringValue(payload.decision) ?? 'unknown';
      source.rationale = stringValue(payload.rationale) ?? null;
      source.last_event_at = event.ts;
    }

    if (event.kind === 'memory_capture_recorded') {
      const itemId = stringValue(payload.item_id);
      if (itemId) capturedItemIds.push(itemId);
      if (sourceId) {
        const source = ensureSource(sources, sourceId);
        source.item_id = itemId ?? source.item_id;
        source.last_event_at = event.ts;
      }
    }

    if (event.kind === 'external_action_recorded') {
      const actionId = stringValue(payload.action_id) ?? event.id;
      externalActions.set(actionId, {
        action_id: actionId,
        source_id: sourceId ?? null,
        action: stringValue(payload.action) ?? 'unknown',
        status: stringValue(payload.status) ?? 'pending',
        recorded_at: event.ts
      });
    }

    if (event.kind === 'verification_recorded') {
      const actionId = stringValue(payload.action_id);
      if (actionId) verifiedActionIds.add(actionId);
    }

    if (event.kind === 'run_completed') {
      completedAt = event.ts;
      completionSummary = stringValue(payload.summary) ?? completionSummary;
    }
  }

  for (const actionId of verifiedActionIds) {
    const action = externalActions.get(actionId);
    if (action) action.status = 'verified';
  }

  const sourceList = [...sources.values()].sort((a, b) => a.source_id.localeCompare(b.source_id));
  const pendingDecisions = sourceList.filter((source) => source.considered && !source.decision);
  const completedDecisions = sourceList.filter((source) => Boolean(source.decision));
  const pendingExternalActions = [...externalActions.values()].filter((action) => action.status !== 'verified');
  const hasCompletionEvent = completedAt !== null;
  const completed = hasCompletionEvent && pendingDecisions.length === 0 && pendingExternalActions.length === 0;

  return {
    run_dir: runDir,
    run_id: inputs.run_id,
    workflow: inputs.workflow,
    status: completed ? 'completed' : 'active',
    created_at: inputs.created_at,
    completed_at: completedAt,
    summary: completionSummary,
    event_count: events.length,
    sources: sourceList,
    completed_decisions: completedDecisions,
    pending_decisions: pendingDecisions,
    external_actions: [...externalActions.values()],
    pending_external_actions: pendingExternalActions,
    captured_item_ids: [...new Set(capturedItemIds)],
    next_step: nextStep({ completed, pendingDecisions, pendingExternalActions, outputs })
  };
}

export async function refreshRunMarkdown(runDir, state = null) {
  await assertLedgerFilesSafe(runDir, { requireRunMarkdown: false });
  const resolved = state ?? await deriveRunState(runDir);
  const lines = [
    `# ${resolved.workflow} Run ${resolved.run_id}`,
    '',
    `- Status: ${resolved.status}`,
    `- Created: ${resolved.created_at}`,
    `- Events: ${resolved.event_count}`,
    `- Completed decisions: ${resolved.completed_decisions.length}`,
    `- Pending decisions: ${resolved.pending_decisions.length}`,
    `- Pending external actions: ${resolved.pending_external_actions.length}`,
    `- Captured Reading Memory items: ${resolved.captured_item_ids.length ? resolved.captured_item_ids.join(', ') : 'none'}`,
    `- Next step: ${resolved.next_step}`,
    '',
    '## Pending Decisions',
    ...listLines(resolved.pending_decisions.map((source) => `${source.source_id}${source.label ? ` — ${source.label}` : ''}`)),
    '',
    '## Pending External Actions',
    ...listLines(resolved.pending_external_actions.map((action) => `${action.action_id}: ${action.action}${action.source_id ? ` (${action.source_id})` : ''}`)),
    '',
    '## Recent Sources',
    ...listLines(resolved.sources.slice(-10).map((source) => {
      const decision = source.decision ?? 'pending';
      return `${source.source_id}: ${decision}${source.item_id ? ` -> ${source.item_id}` : ''}`;
    })),
    ''
  ];
  await writeFile(join(runDir, 'run.md'), `${lines.join('\n')}`, { mode: 0o600 });
}

export async function readEvents(eventsPath) {
  const text = await readFile(eventsPath, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL at ${eventsPath}:${index + 1}: ${message}`);
      }
    });
}

export function assertEventKind(kind) {
  if (!RUN_LEDGER_EVENTS.includes(kind)) {
    throw new Error(`Unknown run-ledger event kind: ${kind}`);
  }
}

export function assertEventPayload(kind, payload) {
  const required = REQUIRED_EVENT_FIELDS[kind] ?? [];
  const missing = required.filter((field) => !stringValue(payload[field]));
  if (missing.length > 0) {
    throw new Error(`${kind} requires payload field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }
}

export function assertNoRawContent(value, path = []) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoRawContent(item, [...path, String(index)]);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 2000) {
      throw new Error(`Run ledger payload field is too long: ${path.join('.') || 'value'}`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (RAW_CONTENT_KEYS.has(normalized)) {
      throw new Error(`Run ledger payload includes raw-content-like field: ${[...path, key].join('.')}`);
    }
    if (typeof child === 'string' && child.length > 2000) {
      throw new Error(`Run ledger payload field is too long: ${[...path, key].join('.')}`);
    }
    assertNoRawContent(child, [...path, key]);
  }
}

function generateRunId(workflow) {
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, '').slice(0, 15);
  return `${workflow}-${stamp}-${randomUUID().slice(0, 8)}`;
}

function assertWorkflow(workflow) {
  if (!workflow || !/^[a-z][a-z0-9_-]{1,63}$/.test(workflow)) {
    throw new Error('workflow must be 2-64 lowercase letters, numbers, underscores, or hyphens');
  }
}

function assertRunId(runId) {
  if (!runId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error('run_id must be 1-128 path-safe letters, numbers, dots, underscores, or hyphens');
  }
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a JSON object`);
  }
}

async function assertLedgerFilesSafe(runDir, { requireRunMarkdown = true } = {}) {
  const files = ['inputs.json', 'outputs.json', 'events.jsonl'];
  if (requireRunMarkdown) files.push('run.md');
  for (const file of files) {
    await assertRegularFile(join(runDir, file));
  }
}

async function assertRegularFile(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Run ledger path must be a regular file: ${path}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicWriteJson(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function ensureSource(sources, sourceId) {
  const existing = sources.get(sourceId);
  if (existing) return existing;
  const source = {
    source_id: sourceId,
    considered: false,
    decision: null,
    rationale: null,
    item_id: null,
    label: null,
    source_kind: null,
    last_event_at: null
  };
  sources.set(sourceId, source);
  return source;
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nextStep({ completed, pendingDecisions, pendingExternalActions, outputs }) {
  if (completed) return 'done';
  if (pendingExternalActions.length > 0) return 'verify external actions';
  if (pendingDecisions.length > 0) return 'record pending decisions';
  if (outputs.status !== 'completed') return 'record completion';
  return 'inspect ledger';
}

function listLines(values) {
  return values.length ? values.map((value) => `- ${value}`) : ['- none'];
}

export function resolveRunDir(value) {
  if (!value) throw new Error('--run is required');
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function displayRunName(runDir) {
  return basename(runDir);
}
