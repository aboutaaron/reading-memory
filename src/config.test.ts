import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

test('derives dataDir from explicit READING_API_DB when data dir is unset', () => {
  const config = loadConfig({
    READING_API_DB: '/tmp/reading-api-smoke.sqlite',
    READING_API_TOKEN: 'secret'
  } as NodeJS.ProcessEnv);

  assert.equal(config.dbPath, '/tmp/reading-api-smoke.sqlite');
  assert.equal(config.dataDir, '/tmp');
  assert.equal(config.flueTracePath, '/tmp/flue-events.jsonl');
  assert.equal(config.flueModel, 'openai/gpt-5.6-luna');
});

test('keeps model selection provider-configurable', () => {
  const config = loadConfig({
    READING_API_TOKEN: 'secret',
    READING_API_FLUE_MODEL: 'test-provider/test-model'
  } as NodeJS.ProcessEnv);

  assert.equal(config.flueModel, 'test-provider/test-model');
});

test('rejects non-loopback bind hosts', () => {
  assert.throws(
    () => loadConfig({
      READING_API_HOST: '0.0.0.0',
      READING_API_TOKEN: 'secret'
    } as NodeJS.ProcessEnv),
    /loopback-only/
  );
});

test('allows disabling local Flue trace logging', () => {
  const config = loadConfig({
    READING_API_DATA_DIR: '/tmp/reading-api',
    READING_API_TOKEN: 'secret',
    READING_API_FLUE_TRACE_PATH: 'off'
  } as NodeJS.ProcessEnv);

  assert.equal(config.flueTracePath, null);
});

test('defaults backupDir under home when env is unset', () => {
  const config = loadConfig({
    READING_API_TOKEN: 'secret'
  } as NodeJS.ProcessEnv);

  assert.ok(config.backupDir.endsWith('/backups/reading-memory'), config.backupDir);
});

test('honors READING_API_BACKUP_DIR override', () => {
  const config = loadConfig({
    READING_API_TOKEN: 'secret',
    READING_API_BACKUP_DIR: '/var/lib/reading-backups'
  } as NodeJS.ProcessEnv);

  assert.equal(config.backupDir, '/var/lib/reading-backups');
});
