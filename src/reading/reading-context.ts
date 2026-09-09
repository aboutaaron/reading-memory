import type { Database } from '../db/connection.js';
import { extractFrequentSearchTerms, extractSearchTerms, toFtsQuery } from './search-terms.js';

export const READING_CONTEXT_LIMITS = {
  priorItems: 5,
  sourcePassages: 3,
  passageChars: 800,
  annotationsPerItem: 3,
  noteChars: 700,
  questionChars: 300,
  projectChars: 120,
  callerContextChars: 1000
} as const;

// Reserve room for each signal within the existing 64-term query bound.
const TERM_BUDGETS = { title: 8, callerContext: 8, annotations: 8, source: 40 } as const;

export type CallerReadingContext = {
  source_context?: string | null;
  ingest_reason?: string | null;
};

export type ContextAnnotation = {
  id: string;
  actor_type: 'user' | 'agent';
  actor: string;
  note: string;
  project: string | null;
  question: string | null;
  created_at: string;
};

export type PriorReadingItem = {
  item_id: string;
  title: string | null;
  summary: string;
  tags: string[];
  source_passages: string[];
  annotations: ContextAnnotation[];
};

/** Retrieval is lexical and bounded; no model or framework state is involved. */
export function buildReadingContext(db: Database, input: {
  itemId: string;
  title: string | null;
  text: string;
  readerContext?: CallerReadingContext;
  priorItemIds?: string[];
}) {
  const readerContext = {
    source_context: bounded(input.readerContext?.source_context, READING_CONTEXT_LIMITS.callerContextChars),
    ingest_reason: bounded(input.readerContext?.ingest_reason, READING_CONTEXT_LIMITS.callerContextChars),
    annotations: activeAnnotations(db, input.itemId)
  };
  const terms = [...new Set([
    ...extractSearchTerms([input.title], TERM_BUDGETS.title),
    ...extractSearchTerms([readerContext.ingest_reason, readerContext.source_context], TERM_BUDGETS.callerContext),
    ...extractSearchTerms(
      readerContext.annotations.flatMap((annotation) => [annotation.question, annotation.project, annotation.note]),
      TERM_BUDGETS.annotations
    ),
    ...extractFrequentSearchTerms(input.text, TERM_BUDGETS.source)
  ])];
  if (terms.length === 0 && !input.priorItemIds?.length) return { reader_context: readerContext, prior_items: [] as PriorReadingItem[] };

  const rows = terms.length ? db.prepare(`
    SELECT i.id AS item_id, i.title, i.extracted_text,
      coalesce((SELECT a.summary FROM analyses a WHERE a.item_id = i.id ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1), '') AS summary
    FROM item_fts
    JOIN items i ON i.id = item_fts.item_id
    WHERE item_fts MATCH ? AND i.status = 'indexed' AND i.id <> ?
    ORDER BY bm25(item_fts, 0, 5, 1, 2, 3), i.ingested_at DESC, i.id
    LIMIT ?
  `).all(toFtsQuery(terms), input.itemId, READING_CONTEXT_LIMITS.priorItems) as Array<{
    item_id: string;
    title: string | null;
    extracted_text: string;
    summary: string;
  }> : [];

  const ranks = new Map(rows.map((row, index) => [row.item_id, 1 / (61 + index)]));
  const byId = new Map(rows.map(row => [row.item_id, row]));
  for (const [index, id] of [...new Set(input.priorItemIds ?? [])].slice(0, 5).entries()) {
    const row = db.prepare(`SELECT i.id AS item_id, i.title, i.extracted_text,
      coalesce((SELECT summary FROM analyses WHERE item_id = i.id ORDER BY created_at DESC, rowid DESC LIMIT 1), '') AS summary
      FROM items i WHERE i.id = ? AND i.id <> ? AND i.status = 'indexed'`).get(id, input.itemId) as typeof rows[number] | undefined;
    if (!row) continue;
    byId.set(id, row);
    ranks.set(id, (ranks.get(id) ?? 0) + 1 / (61 + index));
  }
  const candidates = [...byId.values()].sort((a, b) => (ranks.get(b.item_id)! - ranks.get(a.item_id)!)
    || a.item_id.localeCompare(b.item_id)).slice(0, READING_CONTEXT_LIMITS.priorItems);
  const priorItems: PriorReadingItem[] = candidates.map((row) => ({
    item_id: row.item_id,
    title: bounded(row.title, 240),
    summary: row.summary.slice(0, 800),
    tags: (db.prepare('SELECT tag FROM tags WHERE item_id = ? ORDER BY confidence DESC, tag LIMIT 12')
      .all(row.item_id) as Array<{ tag: string }>).map(({ tag }) => tag.slice(0, 80)),
    source_passages: sourcePassages(row.extracted_text, terms),
    annotations: activeAnnotations(db, row.item_id)
  }));
  return { reader_context: readerContext, prior_items: priorItems };
}

function activeAnnotations(db: Database, itemId: string): ContextAnnotation[] {
  const rows = db.prepare(`
    SELECT a.id, a.actor_type, a.actor, a.note, a.project, a.question, a.created_at
    FROM reader_annotations a
    WHERE a.item_id = ? AND NOT EXISTS (
      SELECT 1 FROM reader_annotations successor WHERE successor.supersedes_annotation_id = a.id
    )
    ORDER BY a.created_at DESC, a.rowid DESC
    LIMIT ?
  `).all(itemId, READING_CONTEXT_LIMITS.annotationsPerItem) as ContextAnnotation[];
  return rows.map((row) => ({
    ...row,
    actor: row.actor.slice(0, 120),
    note: row.note.slice(0, READING_CONTEXT_LIMITS.noteChars),
    project: bounded(row.project, READING_CONTEXT_LIMITS.projectChars),
    question: bounded(row.question, READING_CONTEXT_LIMITS.questionChars)
  }));
}

/** Return verbatim slices, including relevant passages beyond a source's opening. */
function sourcePassages(text: string, terms: string[]): string[] {
  const termSet = new Set(terms);
  const candidates: Array<{ start: number; text: string; score: number }> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + READING_CONTEXT_LIMITS.passageChars);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > start + READING_CONTEXT_LIMITS.passageChars / 2) end = boundary;
    }
    const passage = text.slice(start, end);
    const matched = (passage.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [])
      .filter((term) => termSet.has(term));
    candidates.push({ start, text: passage, score: new Set(matched).size * 10 + matched.length });
    start = end;
  }
  return candidates
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, READING_CONTEXT_LIMITS.sourcePassages)
    .sort((a, b) => a.start - b.start)
    .map((candidate) => candidate.text);
}

function bounded(value: string | null | undefined, maxChars: number): string | null {
  return value == null ? null : value.slice(0, maxChars);
}
