import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ComparisonManifestSchema, compareAnalyzers, validateModels, type ComparisonOptions } from '../src/evals/analyzer-comparison.js';
import { privateDirectory } from '../src/filesystem/private-files.js';

export function parseComparisonArgs(args: string[]) {
  const values = new Map<string, string>();
  let apply = false;
  let modeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--apply' || arg === '--dry-run') {
      if (modeSeen) throw new Error('Choose only one execution mode.');
      modeSeen = true; apply = arg === '--apply'; continue;
    }
    if (!['--input', '--output', '--model-a', '--model-b', '--timeout-ms'].includes(arg)
      || values.has(arg) || !args[index + 1] || args[index + 1]!.startsWith('--')) {
      throw new Error('Invalid comparison arguments. See docs/ANALYZER-COMPARISON.md.');
    }
    values.set(arg, args[++index]!);
  }
  const models = [values.get('--model-a') ?? '', values.get('--model-b') ?? ''];
  validateModels(models);
  const input = values.get('--input');
  const output = values.get('--output');
  if (!input || (apply && !output)) throw new Error('An input manifest is required; --apply also requires a new output path.');
  const timeoutValue = values.get('--timeout-ms') ?? '55000';
  if (!/^\d+$/.test(timeoutValue)) throw new Error('Invalid timeout.');
  const timeoutMs = Number(timeoutValue);
  if (timeoutMs < 1000 || timeoutMs > 55_000) throw new Error('Timeout must be between 1000 and 55000 milliseconds.');
  return { input: resolve(input), output: output ? resolve(output) : null, models, timeoutMs, apply };
}

export async function runComparisonCli(args: string[], dependencies: Pick<ComparisonOptions, 'env' | 'request'> = {}) {
  const options = parseComparisonArgs(args);
  // Bound reads before JSON parsing and refuse symlink/FIFO inputs. No database access.
  const inputFd = openSync(options.input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let manifest;
  try {
    const stat = fstatSync(inputFd);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('Expected a regular manifest of at most 5 MiB.');
    manifest = ComparisonManifestSchema.parse(JSON.parse(readFileSync(inputFd, 'utf8')));
  } finally { closeSync(inputFd); }
  let outputFd: number | undefined;
  try {
    // Reserve an exclusive 0600 destination before any paid calls. Never overwrite fixtures or results.
    if (options.apply) {
      const parent = privateDirectory(dirname(options.output!));
      outputFd = openSync(join(parent, basename(options.output!)), constants.O_WRONLY | constants.O_CREAT
        | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    const report = await compareAnalyzers(manifest, { ...options, ...dependencies });
    if (outputFd !== undefined) writeFileSync(outputFd, `${JSON.stringify(report, null, 2)}\n`);
    // Reports contain private outputs; terminal output is strictly content-free.
    return { dry_run: report.dry_run, cases: report.cases, planned_calls: report.planned_calls,
      completed_calls: report.completed_calls, failed_calls: report.failed_calls,
      output_written: outputFd !== undefined };
  } finally { if (outputFd !== undefined) closeSync(outputFd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runComparisonCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.failed_calls > 0) process.exitCode = 1;
  } catch {
    // Provider errors, validation errors and file paths can contain private text.
    process.stderr.write('Analyzer comparison failed. Check arguments, private manifest, credentials and output path; see docs/ANALYZER-COMPARISON.md.\n');
    process.exitCode = 1;
  }
}
