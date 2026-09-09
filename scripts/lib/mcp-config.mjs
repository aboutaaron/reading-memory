import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnvKeys } from './env-file.mjs';

export function loadMcpConfig(envFile, env = process.env) {
  const path = envFile ?? env.READING_MEMORY_ENV_FILE ?? join(homedir(), '.reading-api', 'env');
  let saved;
  try { saved = parseEnvKeys(existsSync(path) ? readFileSync(path, 'utf8') : ''); }
  catch { throw new Error('Could not read the Reading Memory env file'); }
  return {
    url: env.READING_MEMORY_URL ?? saved.READING_MEMORY_URL ?? 'http://127.0.0.1:4727',
    token: env.READING_API_TOKEN ?? saved.READING_API_TOKEN ?? ''
  };
}
