import { createHash } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
