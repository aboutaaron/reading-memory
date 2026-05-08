#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { mergeEnvFile, parseEnvKeys } from './lib/env-file.mjs';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);

function usage() {
  console.log(`Reading Memory

Usage:
  reading-memory setup --target codex
  reading-memory setup --target openclaw
  reading-memory setup --target claude-code
  reading-memory setup --target env

Options:
  --target <codex|openclaw|claude-code|env>
                                Install target. Default: codex.
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
  const skillRoots = {
    codex: join(codexHome, 'skills', 'use-reading-memory'),
    openclaw: join(homedir(), '.openclaw', 'skills', 'use-reading-memory'),
    'claude-code': join(homedir(), '.claude', 'skills', 'use-reading-memory')
  };
  const skillRoot = skillRoots[target];
  const destination = join(skillRoot, 'SKILL.md');

  ensureDir(skillRoot, dryRun);
  if (dryRun) {
    console.log(`would copy skill: ${source} -> ${destination}`);
    return destination;
  }

  writeFileSync(destination, readFileSync(source, 'utf8'));
  return destination;
}

function copyCommands(target, dryRun) {
  // Slash commands are a Claude Code primitive (markdown files under
  // ~/.claude/commands/<name>.md → /<name>). Codex and OpenClaw don't have an
  // equivalent surface, so we install commands only for the claude-code target.
  if (target !== 'claude-code') return [];

  const sourceDir = join(root, '.agents', 'commands');
  if (!existsSync(sourceDir)) return [];

  const destDir = join(homedir(), '.claude', 'commands');
  ensureDir(destDir, dryRun);

  const installed = [];
  for (const name of readdirSync(sourceDir)) {
    if (!name.endsWith('.md')) continue;
    const source = join(sourceDir, name);
    const destination = join(destDir, name);
    if (dryRun) {
      console.log(`would copy command: ${source} -> ${destination}`);
    } else {
      writeFileSync(destination, readFileSync(source, 'utf8'));
    }
    installed.push(destination);
  }
  return installed;
}

function readEnvFile(envFile) {
  if (!existsSync(envFile)) return '';
  return readFileSync(envFile, 'utf8');
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
  if (!['codex', 'openclaw', 'claude-code', 'env'].includes(target)) {
    throw new Error(`Unsupported target: ${target}`);
  }

  const dryRun = hasFlag('--dry-run');
  const url = readOption('--url', 'http://127.0.0.1:4727');
  const envFile = resolve(expandHome(readOption('--env-file', '~/.reading-api/env')));
  const dataDir = dirname(envFile);

  const existingContent = readEnvFile(envFile);
  const existingKeys = parseEnvKeys(existingContent);
  // Treat an empty `READING_API_TOKEN=` as missing — keeping it would write a
  // blank token back to disk, and `requireAuth` rejects every request when the
  // configured token is empty (503). Generate a fresh UUID instead.
  const token = readOption('--token', existingKeys.READING_API_TOKEN || randomUUID());

  const ownedValues = {
    READING_MEMORY_URL: url,
    READING_API_TOKEN: token,
    READING_API_HOST: '127.0.0.1',
    READING_API_PORT: new URL(url).port || '4727',
    READING_API_DATA_DIR: dataDir,
    READING_API_DB: join(dataDir, 'reading.sqlite'),
    READING_API_FLUE_TRACE_PATH: join(dataDir, 'flue-events.jsonl')
  };

  const env = mergeEnvFile(existingContent, ownedValues);

  writePrivateFile(envFile, env, dryRun);
  const skillPath = target === 'env' ? null : copySkill(target, dryRun);
  const commandPaths = copyCommands(target, dryRun);

  console.log(`Reading Memory setup ${dryRun ? 'checked' : 'complete'}.

Env:
  ${envFile}
${skillPath ? `
Skill:
  ${skillPath}` : ''}${commandPaths.length > 0 ? `

Commands:
${commandPaths.map((path) => `  ${path}`).join('\n')}` : ''}

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
