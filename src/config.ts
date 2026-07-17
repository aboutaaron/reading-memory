import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const LIMITS = {
  maxSyncResponseSeconds: 60,
  idempotencyTtlSeconds: 7 * 24 * 60 * 60,
  maxTextChars: 100_000,
  maxUrlBytes: 5 * 1024 * 1024,
  maxPdfBytes: 10 * 1024 * 1024,
  maxPdfPages: 50,
  maxExtractedChars: 100_000,
  maxRedirects: 5,
  maxBodyBytes: 10 * 1024 * 1024,
  minDiskFreeBytes: 1 * 1024 * 1024 * 1024,
  warnDiskFreeBytes: 15 * 1024 * 1024 * 1024,
  staleBackupSeconds: 25 * 60 * 60,
  relationshipsPerItem: 3,
  relationshipMinConfidence: 0.7
} as const;

export type AppConfig = {
  host: string;
  port: number;
  dbPath: string;
  authToken: string;
  dataDir: string;
  backupDir: string;
  flueModel: string;
  flueTracePath: string | null;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const defaultDataDir = join(homedir(), '.reading-api');
  const dbPath = env.READING_API_DB ?? join(env.READING_API_DATA_DIR ?? defaultDataDir, 'reading.sqlite');
  const dataDir = env.READING_API_DATA_DIR ?? dirname(dbPath);
  const host = env.READING_API_HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`READING_API_HOST must be loopback-only; got ${host}`);
  }
  return {
    host,
    port: Number(env.READING_API_PORT ?? 4727),
    dbPath,
    authToken: env.READING_API_TOKEN ?? '',
    dataDir,
    backupDir: env.READING_API_BACKUP_DIR ?? join(homedir(), 'backups', 'reading-memory'),
    flueModel: env.READING_API_FLUE_MODEL ?? 'openai/gpt-5.6-luna',
    flueTracePath: env.READING_API_FLUE_TRACE_PATH === 'off'
      ? null
      : env.READING_API_FLUE_TRACE_PATH ?? join(dataDir, 'flue-events.jsonl')
  };
}

export const TEST_DB_PATH = join(tmpdir(), `reading-api-${process.pid}.sqlite`);
