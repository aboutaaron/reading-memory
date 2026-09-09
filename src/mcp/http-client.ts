import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type ReadingHttpConfig = { url: string; token: string };

/** Pin localhost to its loopback address instead of trusting DNS resolution. */
export function loopbackServiceUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('READING_MEMORY_URL must be a loopback HTTP URL'); }
  if (!['http:', 'https:'].includes(url.protocol)
    || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('READING_MEMORY_URL must be a loopback HTTP origin without credentials, path, query, or fragment');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

export class ReadingHttpClient {
  private readonly url: string;
  private readonly token: string;

  constructor(config: ReadingHttpConfig) {
    this.url = loopbackServiceUrl(config.url);
    if (!config.token || /[\r\n]/.test(config.token)) throw new Error('READING_API_TOKEN must be configured');
    this.token = config.token;
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
    try {
      const { status, payload } = await this.send(method, path, body);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || typeof (payload as Record<string, unknown>).ok !== 'boolean') {
        return failure('INVALID_RESPONSE', 'Reading Memory returned an invalid API response');
      }
      return {
        isError: status < 200 || status >= 300 || !(payload as Record<string, unknown>).ok,
        payload: this.redact(payload) as Record<string, unknown>
      };
    } catch {
      // Network/JSON errors can contain URLs or server text. Do not relay them.
      return failure('SERVICE_UNAVAILABLE', 'Reading Memory could not complete the request. Check the local service and configuration.');
    }
  }

  private send(method: string, path: string, body: unknown): Promise<{ status: number; payload: unknown }> {
    const url = new URL(`${this.url}${path}`);
    return new Promise((resolve, reject) => {
      // A fresh direct agent bypasses NODE_USE_ENV_PROXY/global agents. Even an
      // environment configured for a provider proxy must keep this token local.
      // Native HTTP also never follows redirects; reject those explicitly.
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method, agent: false, signal: AbortSignal.timeout(65_000),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }
      }, async (response) => {
        try {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.destroy();
            reject(new Error('Redirect refused'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            const buffer = Buffer.from(chunk);
            size += buffer.length;
            if (size > 20 * 1024 * 1024) throw new Error('Response exceeds limit');
            chunks.push(buffer);
          }
          resolve({ status, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  private redact(value: unknown): unknown {
    if (typeof value === 'string') return value.split(this.token).join('[REDACTED]');
    if (Array.isArray(value)) return value.map((entry) => this.redact(entry));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key.split(this.token).join('[REDACTED]'), this.redact(entry)
      ]));
    }
    return value;
  }
}

export function failure(code: string, message: string) {
  return { isError: true, payload: { ok: false, request_id: null, data: null, error: { code, message } } };
}
