import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type TraceEvent = {
  trace_id?: string;
  item_id?: string;
  requested_session_id?: string;
  ts?: string;
  event?: string;
  flue_type?: string;
  title_chars?: number | null;
  title_sha256?: string | null;
  model?: string;
  duration_ms?: number;
  recommended_action?: string;
  confidence?: number;
  relevance_score?: number;
  themes?: string[];
  error_kind?: string;
  error_message_chars?: number;
  error_message_sha256?: string;
};

const args = process.argv.slice(2);
const latest = numberArg('--latest') ?? 10;
const json = args.includes('--json');
const path = stringArg('--path') ?? process.env.READING_API_FLUE_TRACE_PATH ?? join(
  process.env.READING_API_DATA_DIR ?? join(homedir(), '.reading-api'),
  'flue-events.jsonl'
);

const content = await readFile(path, 'utf8').catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Could not read trace file at ${path}: ${message}`);
});

const events = content
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line, index) => parseLine(line, index + 1));

const traces = groupByTrace(events).slice(-latest);

if (json) {
  console.log(JSON.stringify(traces, null, 2));
} else {
  for (const trace of traces) {
    printTrace(trace);
  }
}

function groupByTrace(events: TraceEvent[]) {
  const map = new Map<string, TraceEvent[]>();
  for (const event of events) {
    const id = event.trace_id ?? 'unknown';
    const bucket = map.get(id) ?? [];
    bucket.push(event);
    map.set(id, bucket);
  }

  return [...map.entries()].map(([traceId, traceEvents]) => ({
    traceId,
    itemId: traceEvents[0]?.item_id,
    sessionId: traceEvents[0]?.requested_session_id,
    startedAt: traceEvents[0]?.ts,
    events: traceEvents
  }));
}

function printTrace(trace: ReturnType<typeof groupByTrace>[number]) {
  const start = trace.events.find((event) => event.event === 'analysis_start');
  const success = trace.events.find((event) => event.event === 'analysis_success');
  const error = trace.events.find((event) => event.event === 'analysis_error');
  const flueEvents = trace.events.filter((event) => event.event === 'flue_event');

  console.log(`\nTrace ${trace.traceId}`);
  console.log(`  item: ${trace.itemId ?? '(unknown)'}`);
  console.log(`  session: ${trace.sessionId ?? '(unknown)'}`);
  console.log(`  started: ${trace.startedAt ?? '(unknown)'}`);
  if (start?.title_sha256) console.log(`  title: ${start.title_chars ?? '?'} chars, ${start.title_sha256}`);
  if (start?.model) console.log(`  model: ${start.model}`);
  console.log(`  flue events: ${flueEvents.map((event) => event.flue_type).join(', ') || '(none)'}`);

  if (success) {
    console.log(`  status: success in ${success.duration_ms}ms`);
    console.log(`  action: ${success.recommended_action}, confidence ${fmt(success.confidence)}, relevance ${fmt(success.relevance_score)}`);
    console.log(`  themes: ${success.themes?.join(', ') || '(none)'}`);
  } else if (error) {
    console.log(`  status: error in ${error.duration_ms}ms`);
    console.log(`  error: ${error.error_kind ?? '(unknown)'} (${error.error_message_chars ?? '?'} chars, ${error.error_message_sha256 ?? 'no hash'})`);
  } else {
    console.log('  status: incomplete');
  }
}

function parseLine(line: string, lineNumber: number) {
  try {
    return JSON.parse(line) as TraceEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON on trace line ${lineNumber}: ${message}`);
  }
}

function numberArg(name: string) {
  const value = stringArg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function stringArg(name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fmt(value: number | undefined) {
  return value === undefined ? '?' : value.toFixed(2);
}
