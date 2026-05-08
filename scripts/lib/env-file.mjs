// Helpers for reading and merging the Reading Memory env file.
//
// `setup` owns a fixed set of keys (URL, token, host, port, paths). Any other
// keys in the env file — provider base-URL overrides, custom Flue model
// pinning, anything a user added by hand — must survive a re-run.

export const OWNED_KEYS = Object.freeze([
  'READING_MEMORY_URL',
  'READING_API_TOKEN',
  'READING_API_HOST',
  'READING_API_PORT',
  'READING_API_DATA_DIR',
  'READING_API_DB',
  'READING_API_FLUE_TRACE_PATH'
]);

const KEY_PATTERN = /^([A-Z_][A-Z0-9_]*)=(.*)$/;

export function parseEnvKeys(content) {
  const map = Object.create(null);
  if (!content) return map;
  for (const line of content.split('\n')) {
    const match = line.match(KEY_PATTERN);
    if (match) map[match[1]] = match[2];
  }
  return map;
}

// Produce env-file content that updates owned keys to the provided values
// while preserving every other line — including user-added keys, comments,
// and blank lines — exactly as written. Owned keys not yet present are
// appended (separated from existing content by a blank line) so a fresh
// install matches the original layout.
export function mergeEnvFile(existingContent, ownedValues) {
  for (const key of OWNED_KEYS) {
    if (!(key in ownedValues)) {
      throw new Error(`mergeEnvFile: missing value for owned key ${key}`);
    }
  }

  const lines = existingContent ? existingContent.split('\n') : [];
  const seenOwned = new Set();
  const out = [];

  for (const line of lines) {
    const match = line.match(KEY_PATTERN);
    if (match && OWNED_KEYS.includes(match[1])) {
      const key = match[1];
      out.push(`${key}=${ownedValues[key]}`);
      seenOwned.add(key);
    } else {
      out.push(line);
    }
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();

  const missing = OWNED_KEYS.filter((key) => !seenOwned.has(key));
  if (missing.length > 0) {
    if (out.length > 0) out.push('');
    for (const key of missing) {
      out.push(`${key}=${ownedValues[key]}`);
    }
  }

  return `${out.join('\n')}\n`;
}
