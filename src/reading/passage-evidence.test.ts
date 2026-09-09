import test from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDatabase } from '../db/connection.js';
import { LIMITS } from '../config.js';
import { normalizeAnalysis } from './flue-agent.js';
import { prepareProviderAnalysisInput, resolveProviderAnalysisOutput, type RawProviderAnalysisInput } from './passage-evidence.js';

const raw: RawProviderAnalysisInput = {
  item_id: 'current-item', title: 'Cache evidence', text: '  “Check versions,” the author says.\nOnly for mutable inputs.\n',
  reader_context: { source_context: null, ingest_reason: null, annotations: [] },
  prior_items: ['target-one', 'target-two'].map(item_id => ({
    item_id, title: null, summary: 'Summaries are not evidence.', tags: [], annotations: [],
    source_passages: ['  Check the version\nbefore reusing mutable inputs.\n']
  }))
};
const proposal = {
  summary: 'Version checks can protect cache reuse.', claims: ['Check mutable input versions.'],
  relevance: { score: 0.8, themes: [] }, recommended_action: 'save', confidence: 0.8, reason: 'Cache controls.', tags: [],
  relationships: [{ from_item_id: 'current-item', to_item_id: 'target-one', relation_type: 'supports',
    explanation: 'Both passages discuss checking versions for mutable inputs.', confidence: 0.7,
    evidence: { source_passage_id: 'current:1', target_passage_id: 'prior:1:1' } }]
};

test('passage resolution preserves source punctuation, whitespace, and newline bytes through final normalization', () => {
  const prepared = prepareProviderAnalysisInput(raw);
  const resolved = resolveProviderAnalysisOutput(proposal, prepared);
  assert.deepEqual(resolved.relationships[0]!.evidence, {
    source_quote: raw.text, target_quote: raw.prior_items[0]!.source_passages[0]
  });
  const db = openMemoryDatabase();
  try {
    const result = normalizeAnalysis(db, raw.item_id, resolved, 'test/model', { text: raw.text, priorItems: raw.prior_items });
    assert.deepEqual(result.relationships[0]!.evidence, resolved.relationships[0]!.evidence);
    // Even a resolved reference cannot pass if the actual current source changed.
    assert.deepEqual(normalizeAnalysis(db, raw.item_id, resolved, 'test/model', {
      text: 'A replacement source.', priorItems: raw.prior_items
    }).relationships, []);
  } finally { db.close(); }
});

test('unknown, cross-target, reverse, summary, annotation, and out-of-context references discard only affected edges', () => {
  const prepared = prepareProviderAnalysisInput(raw);
  const base = proposal.relationships[0]!;
  const invalid = [
    { ...base, from_item_id: 'someone-else' },
    { ...base, to_item_id: 'current-item' },
    { ...base, to_item_id: 'unsupplied' },
    { ...base, evidence: null },
    ...[
      { source_passage_id: 'current:999', target_passage_id: 'prior:1:1' },
      { source_passage_id: 'prior:1:1', target_passage_id: 'current:1' },
      { source_passage_id: 'current:1', target_passage_id: 'prior:2:1' },
      { source_passage_id: 'current:1', target_passage_id: 'prior:1:summary' },
      { source_passage_id: 'current:1', target_passage_id: 'annotation:1' },
      { source_passage_id: 'current:1', target_passage_id: 'prior:1:999' }
    ].map(evidence => ({ ...base, evidence }))
  ];
  for (const edge of invalid) {
    const resolved = resolveProviderAnalysisOutput({ ...proposal, relationships: [edge, base] }, prepared);
    assert.equal(resolved.relationships.length, 1, JSON.stringify(edge));
    assert.equal(resolved.summary, proposal.summary);
  }
  assert.throws(() => resolveProviderAnalysisOutput({ ...proposal, relationships: [{ ...base,
    evidence: { source_quote: raw.text, target_quote: raw.prior_items[0]!.source_passages[0] }
  }] }, prepared));
});

test('provider payload is bounded, deterministic, detached, and includes all bounded current source characters once', () => {
  const text = ('“Qualified claim.”\n' + 'x'.repeat(801) + '🙂\n').repeat(180);
  const input = { ...raw, text };
  const prepared = prepareProviderAnalysisInput(input);
  assert.deepEqual(prepared, prepareProviderAnalysisInput(input));
  assert.equal(prepared.source_passages.map(passage => passage.text).join(''), text.slice(0, LIMITS.maxExtractedChars));
  assert.equal(prepared.source_text_truncated, true);
  assert.ok(prepared.source_passages.every(passage => passage.text.length <= 800));
  assert.equal(new Set(prepared.source_passages.map(passage => passage.passage_id)).size, prepared.source_passages.length);
  assert.equal('text' in prepared, false);
  prepared.reader_context.source_context = 'Changed copy';
  prepared.prior_items[0]!.tags.push('changed');
  assert.equal(input.reader_context.source_context, null);
  assert.deepEqual(input.prior_items[0]!.tags, []);
  assert.throws(() => prepareProviderAnalysisInput({ ...raw, prior_items: [raw.prior_items[0]!, raw.prior_items[0]!] }));
  assert.throws(() => prepareProviderAnalysisInput({ ...raw, item_id: 'target-one' }));
});

test('legacy quote callers keep exact validation and cannot cite target summaries or unseen source text', () => {
  const db = openMemoryDatabase();
  try {
    const result = resolveProviderAnalysisOutput(proposal, prepareProviderAnalysisInput(raw));
    result.relationships[0]!.evidence!.target_quote = raw.prior_items[0]!.summary;
    assert.deepEqual(normalizeAnalysis(db, raw.item_id, result, 'custom', { text: raw.text, priorItems: raw.prior_items }).relationships, []);
  } finally { db.close(); }
});
