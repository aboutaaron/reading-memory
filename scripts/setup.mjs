#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);

function usage() {
  console.log(`Reading Memory

Usage:
  reading-memory setup --target codex
  reading-memory setup --target openclaw
  reading-memory setup --target env

Options:
  --target <codex|openclaw|env>  Install target. Default: codex.
  --url <url>                    Service URL. Default: http://127.0.0.1:4727.
  --env-file <path>              Env file path. Default: ~/.reading-api/env.
  --token <token>                Existing bearer token. Default: generated.
  --dry-run                      Print actions without writing files.
`);
}

function readOption(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name) {
  return args.includes(name);
}

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function ensureDir(path, dryRun) {
  if (dryRun) {
    console.log(`would create directory: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

function writePrivateFile(path, content, dryRun) {
  ensureDir(dirname(path), dryRun);
  if (dryRun) {
    console.log(`would write file: ${path}`);
    return;
  }
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function copySkill(target, dryRun) {
  const source = join(root, '.agents', 'skills', 'use-reading-memory', 'SKILL.md');
  if (!existsSync(source)) {
    throw new Error(`Bundled skill not found at ${source}`);
  }

  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const skillRoot = target === 'openclaw'
    ? join(homedir(), '.openclaw', 'skills', 'use-reading-memory')
    : join(codexHome, 'skills', 'use-reading-memory');
  const destination = join(skillRoot, 'SKILL.md');

  ensureDir(skillRoot, dryRun);
  if (dryRun) {
    console.log(`would copy skill: ${source} -> ${destination}`);
    return destination;
  }

  writeFileSync(destination, readFileSync(source, 'utf8'));
  return destination;
}

function existingToken(envFile) {
  if (!existsSync(envFile)) return null;
  const match = readFileSync(envFile, 'utf8').match(/^READING_API_TOKEN=(.+)$/m);
  return match?.[1] ?? null;
}

function setup() {
  if (args.length === 0 || hasFlag('--help') || hasFlag('-h')) {
    usage();
    return;
  }

  const command = args[0];
  if (command !== 'setup') {
    throw new Error(`Unknown command: ${command}`);
  }

  const target = readOption('--target', 'codex');
  if (!['codex', 'openclaw', 'env'].includes(target)) {
    throw new Error(`Unsupported target: ${target}`);
  }

  const dryRun = hasFlag('--dry-run');
  const url = readOption('--url', 'http://127.0.0.1:4727');
  const envFile = resolve(expandHome(readOption('--env-file', '~/.reading-api/env')));
  const dataDir = dirname(envFile);
  const token = readOption('--token', existingToken(envFile) ?? randomUUID());

  const env = [
    `READING_MEMORY_URL=${url}`,
    `READING_API_TOKEN=${token}`,
    'READING_API_HOST=127.0.0.1',
    `READING_API_PORT=${new URL(url).port || '4727'}`,
    `READING_API_DATA_DIR=${dataDir}`,
    `READING_API_DB=${join(dataDir, 'reading.sqlite')}`,
    `READING_API_FLUE_TRACE_PATH=${join(dataDir, 'flue-events.jsonl')}`,
    ''
  ].join('\n');

  writePrivateFile(envFile, env, dryRun);
  const skillPath = target === 'env' ? null : copySkill(target, dryRun);

  console.log(`Reading Memory setup ${dryRun ? 'checked' : 'complete'}.

Env:
  ${envFile}
${skillPath ? `
Skill:
  ${skillPath}` : ''}

Agent environment:
  source ${envFile}

Service:
  Start Reading Memory with the same env file loaded before your agent calls it.
`);
}

try {
  setup();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
