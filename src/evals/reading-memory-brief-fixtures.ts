import { fixture, type ReadingMemoryEvalFixture } from './reading-memory-fixtures.js';

export type BriefEvalFixture = {
  id: string;
  items: ReadingMemoryEvalFixture[];
  events?: Array<{
    item: string;
    date: string;
    kind: 'included' | 'skipped' | 'resurfaced';
    resurfaceAfter?: string;
  }>;
  focus?: string[];
  expected: string[];
  forbidden?: string[];
  due?: string[];
  repeats?: string[];
  first?: string;
  rationale?: { item: string; includes: string };
};

const highConfidenceSkips = Array.from({ length: 8 }, (_, i) => fixture({
  id: `confident-skip-${i}`, action: 'skip', confidence: 0.99, relevance: 0.1
}));
const consumedItems = Array.from({ length: 30 }, (_, i) => fixture({
  id: `already-included-${i}`, confidence: 0.99
}));

export const readingMemoryBriefFixtures: BriefEvalFixture[] = [
  {
    id: 'brief-action-before-confidence',
    items: [...highConfidenceSkips,
      fixture({ id: 'important-brief', confidence: 0.65, relevance: 0.95,
        reason: 'This directly answers the open synthetic evaluation question.' }),
      fixture({ id: 'useful-save', action: 'save', confidence: 0.98, relevance: 0.99 })],
    expected: ['important-brief', 'useful-save'], forbidden: highConfidenceSkips.map((item) => item.id),
    first: 'important-brief',
    rationale: { item: 'important-brief', includes: 'This directly answers the open synthetic evaluation question.' }
  },
  {
    id: 'brief-relevance-before-confidence',
    items: [fixture({ id: 'relevant', relevance: 0.95, confidence: 0.6 }),
      fixture({ id: 'less-relevant', relevance: 0.3, confidence: 0.99 })],
    expected: ['relevant', 'less-relevant'], first: 'relevant'
  },
  {
    id: 'brief-filter-before-limit',
    items: [...consumedItems, fixture({ id: 'eligible-after-thirty', confidence: 0.6 })],
    events: consumedItems.map((item) => ({ item: item.id, date: '2026-09-09', kind: 'included' })),
    expected: ['eligible-after-thirty'], forbidden: consumedItems.map((item) => item.id),
    repeats: consumedItems.map((item) => item.id)
  },
  {
    id: 'brief-old-due-overrides-model-skip',
    items: [fixture({ id: 'old-due', ingestedAt: '2026-08-01T08:00:00.000Z', action: 'skip' }),
      fixture({ id: 'new-brief', confidence: 0.99, relevance: 0.99 })],
    events: [{ item: 'old-due', date: '2026-08-01', kind: 'skipped', resurfaceAfter: '2026-09-09' }],
    expected: ['old-due', 'new-brief'], due: ['old-due'], first: 'old-due'
  },
  {
    id: 'brief-future-boundaries',
    items: [fixture({ id: 'deferred' }),
      fixture({ id: 'future-ingest', ingestedAt: '2026-09-10T00:00:00.000Z' }),
      fixture({ id: 'future-event' })],
    events: [
      { item: 'deferred', date: '2026-09-09', kind: 'skipped', resurfaceAfter: '2026-09-10' },
      { item: 'future-event', date: '2026-09-10', kind: 'included' }
    ],
    expected: ['future-event'], forbidden: ['deferred', 'future-ingest']
  },
  {
    id: 'brief-included-and-resurfaced-do-not-repeat',
    items: [fixture({ id: 'included' }), fixture({ id: 'resurfaced' }), fixture({ id: 'fresh' })],
    events: [
      { item: 'included', date: '2026-09-09', kind: 'included' },
      { item: 'resurfaced', date: '2026-09-08', kind: 'skipped', resurfaceAfter: '2026-09-09' },
      { item: 'resurfaced', date: '2026-09-09', kind: 'resurfaced' }
    ],
    expected: ['fresh'], forbidden: ['included', 'resurfaced'], repeats: ['included', 'resurfaced']
  },
  {
    id: 'brief-history-keeps-and-replaces-schedules',
    items: [fixture({ id: 'kept-schedule', ingestedAt: '2026-08-01T08:00:00.000Z' }),
      fixture({ id: 'replaced-schedule', ingestedAt: '2026-08-01T08:00:00.000Z' })],
    events: [
      { item: 'kept-schedule', date: '2026-08-01', kind: 'skipped', resurfaceAfter: '2026-09-09' },
      { item: 'kept-schedule', date: '2026-09-08', kind: 'skipped' },
      { item: 'replaced-schedule', date: '2026-08-01', kind: 'skipped', resurfaceAfter: '2026-09-09' },
      { item: 'replaced-schedule', date: '2026-09-08', kind: 'skipped', resurfaceAfter: '2026-09-10' }
    ],
    expected: ['kept-schedule'], forbidden: ['replaced-schedule'], due: ['kept-schedule']
  },
  {
    id: 'brief-focus-excludes-unrelated-due',
    items: [fixture({ id: 'focused', themes: ['evaluation'] }),
      fixture({ id: 'unrelated-due', themes: ['cooking'], ingestedAt: '2026-08-01T08:00:00.000Z' })],
    events: [{ item: 'unrelated-due', date: '2026-08-01', kind: 'skipped', resurfaceAfter: '2026-09-09' }],
    focus: ['evaluation'], expected: ['focused'], forbidden: ['unrelated-due']
  }
];
