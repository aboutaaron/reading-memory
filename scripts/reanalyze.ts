import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.js';

type MaintenanceOptions = {
  baseUrl: string;
  token: string;
  limit: number;
  fetcher?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
  report?: (event: { item_id: string; status: 'reanalyzed' | 'failed' }) => void;
};

/** Uses the authenticated service so model configuration, deadlines and locks agree. */
export async function reanalyzeStale(options: MaintenanceOptions) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
    || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Reanalysis requires a loopback HTTP service URL');
  }
  if (!options.token) throw new Error('READING_API_TOKEN is required');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('limit must be between 1 and 100');
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headers = { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' };
  const request = async (path: string, body?: unknown) => {
    for (let attempt = 0; ; attempt += 1) {
      let retryMs = 1000 * (2 ** attempt);
      try {
        const response = await fetcher(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', headers,
          redirect: 'error', signal: AbortSignal.timeout(65_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const payload = await response.json() as { ok: boolean; data?: unknown; error?: { code?: string; retryable?: boolean; retry_after_seconds?: number } };
        if (response.ok && payload.ok) return payload.data;
        if (attempt >= 3 || ![409, 429, 502, 503, 504].includes(response.status) || payload.error?.retryable === false) {
          throw new MaintenanceError(`Service rejected maintenance request (${response.status})`);
        }
        const seconds = payload.error?.retry_after_seconds;
        if (typeof seconds === 'number' && Number.isFinite(seconds)) retryMs = Math.max(retryMs, Math.min(60_000, seconds * 1000));
      } catch (error) {
        if (error instanceof MaintenanceError || attempt >= 3) throw new MaintenanceError('Maintenance request failed');
      }
      await wait(retryMs);
    }
  };
  const result = await request(`/items?stale=true&limit=${options.limit}`) as { items?: Array<{ item_id?: unknown }> };
  if (!Array.isArray(result.items) || result.items.some((item) => typeof item.item_id !== 'string')) {
    throw new MaintenanceError('Invalid stale-item response');
  }
  const items = result.items.slice(0, options.limit);
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) await wait(6000); // ten analysis operations per minute
    const itemId = items[index]!.item_id as string;
    const requestId = randomUUID(); // retained through every retry of this item
    try {
      await request(`/items/${encodeURIComponent(itemId)}/reanalyze`, { request_id: requestId });
      completed += 1;
      options.report?.({ item_id: itemId, status: 'reanalyzed' });
    } catch {
      failed += 1;
      options.report?.({ item_id: itemId, status: 'failed' });
    }
  }
  return { selected: items.length, completed, failed };
}

class MaintenanceError extends Error {}

export function parseReanalyzeArgs(args: string[]) {
  if (args.length !== 3 || args[0] !== '--stale' || args[1] !== '--limit' || !/^\d+$/.test(args[2]!)) {
    throw new Error('Usage: npm run reanalyze -- --stale --limit N (1-100)');
  }
  const limit = Number(args[2]);
  if (limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
  return limit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const limit = parseReanalyzeArgs(process.argv.slice(2));
    const config = loadConfig();
    const host = config.host === '::1' ? '[::1]' : config.host;
    const result = await reanalyzeStale({ baseUrl: `http://${host}:${config.port}`, token: config.authToken, limit,
      report: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Maintenance failed'}\n`);
    process.exitCode = 1;
  }
}
