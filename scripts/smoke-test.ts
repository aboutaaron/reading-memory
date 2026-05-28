const base = process.env.READING_API_BASE_URL ?? 'http://127.0.0.1:4727';
const token = process.env.READING_API_TOKEN;

if (!token) {
  throw new Error('READING_API_TOKEN is required for smoke test');
}

async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {})
    }
  });
  const body = await res.json() as { ok?: boolean; data?: any };
  if (!res.ok || body.ok === false) {
    throw new Error(`${path} failed: ${JSON.stringify(body)}`);
  }
  return body;
}

await fetch(`${base}/health`).then(async (res) => {
  const body = await res.json() as { data?: { ready?: boolean } };
  if (!res.ok || body.data?.ready !== true) throw new Error(`/health not ready: ${JSON.stringify(body)}`);
});

await request('/capabilities');
const ingest = await request('/ingest', {
  method: 'POST',
  body: JSON.stringify({
    request_id: crypto.randomUUID(),
    source_type: 'text',
    source: {
      text: 'Smoke test: agent memory, analytics agents, and durable evaluation should be indexed.',
      title: 'Reading Memory smoke test'
    },
    source_context: 'smoke_test',
    ingest_reason: 'deployment_validation'
  })
});

await request('/query', {
  method: 'POST',
  body: JSON.stringify({
    request_id: crypto.randomUUID(),
    query: 'agent memory durable evaluation',
    top_k: 5
  })
});

const guide = await request('/brief-guide', {
  method: 'POST',
  body: JSON.stringify({
    request_id: crypto.randomUUID(),
    brief_date: new Date().toISOString().slice(0, 10),
    lookback_hours: 168,
    focus: ['agent-memory', 'analytics-agents', 'evaluation']
  })
});

await request(`/items/${ingest.data.item_id}`);
const activity = await request('/activity');
console.log(JSON.stringify({
  ok: true,
  item_id: ingest.data.item_id,
  brief_candidates: guide.data.candidates.length,
  activity_rows: activity.data.length
}));
