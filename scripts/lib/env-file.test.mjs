import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { OWNED_KEYS, mergeEnvFile, parseEnvKeys } from './env-file.mjs';

const ownedValues = Object.freeze({
  READING_MEMORY_URL: 'http://127.0.0.1:4727',
  READING_API_TOKEN: 'fresh-token-xyz',
  READING_API_HOST: '127.0.0.1',
  READING_API_PORT: '4727',
  READING_API_DATA_DIR: '/home/user/.reading-api',
  READING_API_DB: '/home/user/.reading-api/reading.sqlite',
  READING_API_FLUE_TRACE_PATH: '/home/user/.reading-api/flue-events.jsonl'
});

describe('parseEnvKeys', () => {
  it('returns an empty map for empty input', () => {
    assert.equal(Object.keys(parseEnvKeys('')).length, 0);
    assert.equal(Object.keys(parseEnvKeys(null)).length, 0);
    assert.equal(Object.keys(parseEnvKeys(undefined)).length, 0);
  });

  it('parses simple KEY=VALUE pairs', () => {
    const parsed = parseEnvKeys('FOO=bar\nBAZ=qux\n');
    assert.equal(parsed.FOO, 'bar');
    assert.equal(parsed.BAZ, 'qux');
  });

  it('ignores comments and blank lines', () => {
    const parsed = parseEnvKeys('# top\n\nFOO=bar\n# trailing\n');
    assert.deepEqual(Object.keys(parsed), ['FOO']);
  });

  it('preserves equals signs in values', () => {
    const parsed = parseEnvKeys('URL=https://x.example.com/path?key=value\n');
    assert.equal(parsed.URL, 'https://x.example.com/path?key=value');
  });
});

describe('mergeEnvFile', () => {
  it('writes the canonical block on a fresh install', () => {
    const result = mergeEnvFile('', ownedValues);
    const lines = result.split('\n');
    for (const key of OWNED_KEYS) {
      assert.ok(lines.includes(`${key}=${ownedValues[key]}`), `missing ${key}`);
    }
    assert.ok(result.endsWith('\n'), 'should end with single newline');
    assert.ok(!result.endsWith('\n\n'), 'should not double-trail newlines');
  });

  it('preserves user-added keys on re-run', () => {
    const existing = [
      'READING_MEMORY_URL=http://127.0.0.1:4727',
      'READING_API_TOKEN=existing-token',
      'READING_API_HOST=127.0.0.1',
      'READING_API_PORT=4727',
      'READING_API_DATA_DIR=/home/user/.reading-api',
      'READING_API_DB=/home/user/.reading-api/reading.sqlite',
      'READING_API_FLUE_TRACE_PATH=/home/user/.reading-api/flue-events.jsonl',
      '',
      'READING_API_FLUE_MODEL=anthropic/claude-sonnet-4-5',
      'ANTHROPIC_API_KEY=sk-test-placeholder',
      'ANTHROPIC_BASE_URL=https://your-anthropic-proxy.example.com',
      ''
    ].join('\n');

    const result = mergeEnvFile(existing, ownedValues);

    assert.ok(result.includes('READING_API_FLUE_MODEL=anthropic/claude-sonnet-4-5'));
    assert.ok(result.includes('ANTHROPIC_API_KEY=sk-test-placeholder'));
    assert.ok(result.includes('ANTHROPIC_BASE_URL=https://your-anthropic-proxy.example.com'));
    assert.ok(result.includes(`READING_API_TOKEN=${ownedValues.READING_API_TOKEN}`));
    assert.ok(!result.includes('READING_API_TOKEN=existing-token'));
  });

  it('preserves comments and blank lines verbatim', () => {
    const existing = [
      '# Reading Memory env',
      '',
      'READING_MEMORY_URL=http://127.0.0.1:4727',
      'READING_API_TOKEN=t',
      'READING_API_HOST=127.0.0.1',
      'READING_API_PORT=4727',
      'READING_API_DATA_DIR=/d',
      'READING_API_DB=/d/x.sqlite',
      'READING_API_FLUE_TRACE_PATH=/d/events.jsonl',
      '',
      '# Custom block below',
      'OPENAI_BASE_URL=https://your-openai-proxy.example.com',
      ''
    ].join('\n');

    const result = mergeEnvFile(existing, ownedValues);

    assert.ok(result.startsWith('# Reading Memory env'));
    assert.ok(result.includes('# Custom block below'));
    assert.ok(result.includes('OPENAI_BASE_URL=https://your-openai-proxy.example.com'));
  });

  it('appends owned keys missing from a partially populated file', () => {
    const existing = 'READING_API_TOKEN=keep-me\nCUSTOM=abc\n';
    const result = mergeEnvFile(existing, ownedValues);

    assert.ok(result.includes(`READING_API_TOKEN=${ownedValues.READING_API_TOKEN}`));
    assert.ok(result.includes('CUSTOM=abc'));
    for (const key of OWNED_KEYS) {
      assert.ok(result.includes(`${key}=`), `missing ${key}`);
    }
  });

  it('updates owned keys in place rather than duplicating them', () => {
    const existing = OWNED_KEYS.map((key) => `${key}=stale`).join('\n') + '\n';
    const result = mergeEnvFile(existing, ownedValues);
    for (const key of OWNED_KEYS) {
      const occurrences = result.split('\n').filter((line) => line.startsWith(`${key}=`));
      assert.equal(occurrences.length, 1, `${key} should appear exactly once`);
      assert.equal(occurrences[0], `${key}=${ownedValues[key]}`);
    }
  });

  it('throws when an owned-key value is missing', () => {
    const partial = { ...ownedValues };
    delete partial.READING_API_TOKEN;
    assert.throws(() => mergeEnvFile('', partial), /missing value for owned key/i);
  });

  it('produces a single trailing newline regardless of input shape', () => {
    for (const trailing of ['', '\n', '\n\n\n']) {
      const result = mergeEnvFile(`FOO=bar${trailing}`, ownedValues);
      assert.ok(result.endsWith('\n'));
      assert.ok(!result.endsWith('\n\n'));
    }
  });
});
