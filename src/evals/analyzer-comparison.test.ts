import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonManifestSchema, compareAnalyzers, type ComparisonManifest } from './analyzer-comparison.js';
import { parseComparisonArgs, runComparisonCli } from '../../scripts/compare-analyzers.js';

function fixture(): ComparisonManifest {
  return { version: 1, cases: [{ case_id: 'support-control', cohort: 'synthetic',
    input: { item_id: 'current', title: 'Synthetic trial', text: 'The controlled trial found that queues reduced failures.',
      reader_context: { source_context: null, ingest_reason: null, annotations: [] },
      prior_items: [{ item_id: 'prior', title: 'Synthetic baseline', summary: 'A proposal for queues.', tags: [],
        source_passages: ['Queues may reduce failures in this workload.'], annotations: [] }] },
    expected_edges: [{ to_item_id: 'prior', relation_type: 'supports' }] }] };
}
function output(target = 'prior:1:1') {
  return { summary: 'Trial results.', claims: ['Queues reduced failures.'], relevance: { score: 0.5, themes: [] },
    recommended_action: 'save', confidence: 0.5, reason: 'Controlled result.', tags: [], relationships: [{
      from_item_id: 'current', to_item_id: 'prior', relation_type: 'supports', explanation: 'Trial tests the proposed mechanism.',
      confidence: 0.7, evidence: { source_passage_id: 'current:1', target_passage_id: target }
    }] };
}
const models: [string, string] = ['openai/synthetic-a', 'openai/synthetic-b'];

test('default dry run requires no credentials and never invokes the provider', async () => {
  const result = await compareAnalyzers(fixture(), { models, timeoutMs: 1000, env: {},
    request: async () => { throw new Error('Provider must not be called'); } });
  assert.equal(result.dry_run, true);
  assert.equal(result.completed_calls, 0);
  assert.equal(result.planned_calls, 2);
  assert.equal(result.input_sha256.length, 1);
});

test('frozen comparison preserves the retained-source truncation flag in both model inputs', async () => {
  const manifest = fixture();
  manifest.cases[0]!.input.source_text_truncated = true;
  const inputs: unknown[] = [];
  await compareAnalyzers(manifest, { models, apply: true, timeoutMs: 1000, env: { OPENAI_API_KEY: 'key' },
    request: async (_model, input) => { inputs.push(structuredClone(input)); return output(); } });
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], inputs[1]);
  assert.equal((inputs[0] as { source_text_truncated: boolean }).source_text_truncated, true);
  assert.equal(ComparisonManifestSchema.safeParse(fixture()).success, true);
});

test('paired replay shares prepared input, counts rejected references, and separates label agreement', async () => {
  const inputs: unknown[] = [];
  const result = await compareAnalyzers(fixture(), { models, apply: true, timeoutMs: 1000,
    env: { OPENAI_API_KEY: 'synthetic-secret' }, request: async (model, input, options) => {
      inputs.push(structuredClone(input));
      options.onResponse({ provider: 'openai', input_tokens: 10, output_tokens: 20, output_chars: 100 });
      return output(model.id.endsWith('a') ? 'prior:1:1' : 'prior:2:1');
    } });
  assert.deepEqual(inputs[0], inputs[1]);
  const first = result.results[0]!;
  const second = result.results[1]!;
  assert.equal(first.status, 'completed');
  assert.ok('accepted_edges' in first);
  assert.equal(first.accepted_edges, 1);
  assert.equal(first.exact_quote_pairs, 1);
  assert.equal(first.edge_recall, 1);
  assert.equal(first.missing_expected_edges, 0);
  assert.equal(first.analysis.relationships[0]?.evidence?.source_quote, fixture().cases[0]!.input.text);
  assert.ok('rejected_reference_edges' in second);
  assert.equal(second.rejected_reference_edges, 1);
  assert.equal(second.accepted_edges, 0);
  assert.equal(second.edge_recall, 0);
  assert.equal(second.missing_expected_edges, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('family label coverage deduplicates target aliases and excludes current-family corroboration', async () => {
  const manifest = fixture();
  const item = manifest.cases[0]!;
  item.input.prior_items.push({ ...structuredClone(item.input.prior_items[0]!), item_id: 'alias' },
    { ...structuredClone(item.input.prior_items[0]!), item_id: 'current-alias' });
  item.expected_edges!.push({ to_item_id: 'alias', relation_type: 'supports' },
    { to_item_id: 'current-alias', relation_type: 'duplicates_angle' });
  item.source_families = { current: 'current-family', prior: 'independent-family', alias: 'independent-family',
    'current-alias': 'current-family' };
  const result = await compareAnalyzers(manifest, { models, apply: true, timeoutMs: 1000,
    env: { OPENAI_API_KEY: 'key' }, request: async () => {
      const value = output();
      value.relationships.push({ ...structuredClone(value.relationships[0]!), to_item_id: 'current-alias',
        relation_type: 'duplicates_angle', evidence: { source_passage_id: 'current:1', target_passage_id: 'prior:3:1' } });
      return value;
    } });
  const row = result.results[0]!;
  assert.ok('source_family_label_agreement' in row);
  assert.equal(row.missing_expected_edges, 1);
  assert.deepEqual(row.source_family_label_agreement, {
    unique_expected_target_families: 2, unique_predicted_target_families: 2, unique_matched_target_families: 2,
    missing_expected_target_families: 0, target_family_recall: 1,
    unique_expected_independent_target_families: 1, unique_predicted_independent_target_families: 1,
    unique_matched_independent_target_families: 1, missing_expected_independent_target_families: 0,
    independent_target_family_recall: 1
  });
});

test('family agreement stays unknown for incomplete maps and wrong relation types do not match families', async () => {
  const manifest = fixture();
  manifest.cases[0]!.source_families = { current: 'current-family' };
  const complete = structuredClone(manifest.cases[0]!);
  complete.case_id = 'complete-family-map';
  complete.source_families!.prior = 'independent-family';
  manifest.cases.push(complete);
  const result = await compareAnalyzers(manifest, { models, apply: true, timeoutMs: 1000,
    env: { OPENAI_API_KEY: 'key' }, request: async () => {
      const value = output(); value.relationships[0]!.relation_type = 'related'; return value;
    } });
  const incomplete = result.results[0]!;
  assert.ok('source_family_label_agreement' in incomplete);
  assert.equal(incomplete.source_family_label_agreement, null);
  const row = result.results.find(row => row.case_id === 'complete-family-map')!;
  assert.ok('source_family_label_agreement' in row);
  assert.equal(row.source_family_label_agreement?.unique_predicted_target_families, 1);
  assert.equal(row.source_family_label_agreement?.unique_matched_target_families, 0);
  assert.equal(row.source_family_label_agreement?.missing_expected_independent_target_families, 1);
  assert.equal(row.source_family_label_agreement?.independent_target_family_recall, 0);
});

test('labelled no-edge and unlabelled cases are distinct; failures never expose provider errors', async () => {
  const manifest = fixture();
  manifest.cases[0]!.expected_edges = [];
  const unlabelled = structuredClone(manifest.cases[0]!);
  unlabelled.case_id = 'unlabelled-control';
  unlabelled.expected_edges = null;
  manifest.cases.push(unlabelled);
  const result = await compareAnalyzers(manifest, { models, apply: true, timeoutMs: 1000,
    env: { OPENAI_API_KEY: 'key' }, request: async model => {
      if (model.id.endsWith('b')) throw new Error('PRIVATE_PROVIDER_BODY');
      return output();
    } });
  assert.ok('false_positive_edges' in result.results[0]!);
  assert.equal(result.results[0]!.false_positive_edges, 1);
  assert.equal(result.failed_calls, 2);
  assert.equal(result.results[0]!.usage, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PROVIDER_BODY'), false);
  const unlabelledResult = result.results.find(row => row.case_id === 'unlabelled-control' && row.status === 'completed')!;
  assert.ok('expected_edge_matches' in unlabelledResult);
  assert.equal(unlabelledResult.expected_edge_matches, null);
  assert.equal(unlabelledResult.false_positive_edges, null);
});

test('apply writes complete private report while terminal summary and input remain content-free/read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'analyzer-private-output-'));
  try {
    const input = join(dir, 'input.json');
    const outputPath = join(dir, 'report.json');
    const inputText = JSON.stringify(fixture());
    writeFileSync(input, inputText, { mode: 0o600 });
    const summary = await runComparisonCli(['--input', input, '--model-a', models[0], '--model-b', models[1],
      '--apply', '--output', outputPath], { env: { OPENAI_API_KEY: 'private-test-key' }, request: async () => output() });
    assert.equal(summary.completed_calls, 2);
    assert.equal(summary.output_written, true);
    assert.equal(JSON.stringify(summary).includes('Trial'), false);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(readFileSync(input, 'utf8'), inputText);
    const reportText = readFileSync(outputPath, 'utf8');
    assert.equal(reportText.includes('private-test-key'), false);
    assert.equal(JSON.parse(reportText).results.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bounded deadline aborts a hung provider and records failure', async () => {
  let aborts = 0;
  const result = await compareAnalyzers(fixture(), { models, apply: true, timeoutMs: 1000,
    env: { OPENAI_API_KEY: 'key' }, request: async (_model, _input, options) => new Promise((_, reject) => {
      options.signal!.addEventListener('abort', () => { aborts += 1; reject(new Error('Aborted')); });
    }) });
  assert.equal(aborts, 2);
  assert.equal(result.failed_calls, 2);
  assert.ok(result.results.every(row => row.status === 'timeout'));
});

test('manifest rejects duplicate or unavailable expected targets and oversized batches', () => {
  const manifest = fixture();
  manifest.cases[0]!.expected_edges![0]!.to_item_id = 'invented';
  assert.equal(ComparisonManifestSchema.safeParse(manifest).success, false);
  assert.equal(ComparisonManifestSchema.safeParse({ version: 1, cases: Array(26).fill(fixture().cases[0]) }).success, false);
});

test('CLI defaults dry, rejects ambiguous flags and refuses overwrite before credentials or provider access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'analyzer-comparison-'));
  try {
    const input = join(dir, 'input.json');
    const outputPath = join(dir, 'report.json');
    writeFileSync(input, JSON.stringify(fixture()), { mode: 0o600 });
    const args = ['--input', input, '--model-a', models[0], '--model-b', models[1]];
    assert.equal(parseComparisonArgs(args).apply, false);
    assert.throws(() => parseComparisonArgs([...args, '--apply', '--dry-run']));
    assert.throws(() => parseComparisonArgs([...args, '--model-a', models[0]]));
    assert.equal((await runComparisonCli(args)).output_written, false);
    writeFileSync(outputPath, 'retain', { mode: 0o600 });
    await assert.rejects(runComparisonCli([...args, '--apply', '--output', outputPath]));
    assert.equal(readFileSync(outputPath, 'utf8'), 'retain');
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
