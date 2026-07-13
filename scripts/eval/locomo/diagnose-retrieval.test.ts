import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  resolveAnswerString, containment, precision, classify, computeBreakdown, vecKMatchedLimit,
  diagnoseRetrieval, type DiagnosisRecord,
} from './diagnose-retrieval.mts';
import { stemmedTokens } from './judge/metrics.mts';
import type { SearchHit } from '../shared/daemon-client.js';
import type { LoCoMoSample } from './lib/types.js';

function hit(text: string): SearchHit {
  return { id: 'x', type: 'fact', text, score: 0.5, source: 'fused' };
}

// `containment`'s real contract takes ALREADY-STEMMED gold-answer tokens
// (production always calls it with `stemmedTokens(answerStr)`, never raw
// words) -- building test fixtures the same way avoids hand-guessing what
// the Porter stemmer + article-stripping does to a given word (e.g.
// "Caroline" -> "carolin", standalone "a" -> stripped entirely as an
// article, so it can never appear as a stemmed token at all).
const gt = (s: string): string[] => stemmedTokens(s);

describe('resolveAnswerString', () => {
  it('passes non-category-3 answers through unchanged, coercing numbers', () => {
    expect(resolveAnswerString(4, '10 years ago')).toBe('10 years ago');
    expect(resolveAnswerString(2, 2022)).toBe('2022');
  });

  it('truncates category 3 (open-domain) answers at the first semicolon', () => {
    expect(resolveAnswerString(3, 'Likely no; though she likes reading fiction'))
      .toBe('Likely no');
  });

  it('trims whitespace around the truncated category-3 segment', () => {
    expect(resolveAnswerString(3, '  Yes   ; because of X')).toBe('Yes');
  });

  it('handles a category-3 answer with no semicolon at all', () => {
    expect(resolveAnswerString(3, 'Yes')).toBe('Yes');
  });
});

describe('containment', () => {
  it('is 1.0 when every gold-answer token appears in the hit text', () => {
    expect(containment(gt('Caroline attended support group'), 'Caroline attended a support group yesterday.')).toBe(1);
  });

  it('is a fraction when only some gold-answer tokens appear', () => {
    // gt stems to ["carolin","attend","support","group"] (4 tokens) -- only
    // "carolin" is present in the hit.
    expect(containment(gt('Caroline attended support group'), 'Caroline likes hiking.')).toBeCloseTo(0.25, 5);
  });

  it('is 0 when no gold-answer tokens appear', () => {
    expect(containment(gt('Caroline attended support group'), 'Melanie painted a sunset over a lake.')).toBe(0);
  });

  it('does not double-count a repeated gold token beyond its own count (multiset, not set)', () => {
    // gold "group group" (2 tokens, same stem) against a hit containing
    // "group" once -> numSame = min(2 gtCount, 1 hitCount) = 1 -> 1/2, not 1.
    expect(containment(gt('group group'), 'a support group meeting')).toBeCloseTo(0.5, 5);
  });
});

describe('precision', () => {
  it('is the fraction of the HIT tokens accounted for by the gold answer', () => {
    // hit stems to ["carolin","attend","support","group","yesterdai"] (5
    // tokens); gt "carolin" is 1 of them.
    expect(precision(gt('Caroline'), 'Caroline attended support group yesterday')).toBeCloseTo(0.2, 5);
  });

  it('is 1.0 when the gold answer accounts for every hit token', () => {
    expect(precision(gt('support group'), 'support group')).toBe(1);
  });

  it('is 0 when the hit has zero stemmed tokens (e.g. an empty/degenerate hit text)', () => {
    expect(precision(gt('Caroline'), '')).toBe(0);
  });
});

describe('classify', () => {
  const answerTokens = gt('Caroline attended support group');

  it('classifies not-in-db when no hit clears the threshold at any rank', () => {
    const hits = [hit('totally unrelated text'), hit('also unrelated')];
    const result = classify(hits, answerTokens, 0.6, 10);
    expect(result).toEqual({ classification: 'not-in-db', match_rank: null, match_overlap: null });
  });

  it('classifies rank-ok when the first qualifying hit is within the rank boundary', () => {
    const hits = [hit('Caroline attended a support group.')];
    const result = classify(hits, answerTokens, 0.6, 10);
    expect(result.classification).toBe('rank-ok');
    expect(result.match_rank).toBe(1);
    expect(result.match_overlap).toBe(1);
  });

  it('classifies rank-miss when the first qualifying hit is beyond the rank boundary', () => {
    const noise = Array.from({ length: 10 }, () => hit('irrelevant filler text'));
    const hits = [...noise, hit('Caroline attended a support group.')];
    const result = classify(hits, answerTokens, 0.6, 10);
    expect(result.classification).toBe('rank-miss');
    expect(result.match_rank).toBe(11);
  });

  it('takes the FIRST hit clearing the threshold, not the best-scoring one', () => {
    const hits = [hit('Caroline went to a support group.'), hit('Caroline attended a support group meeting today.')];
    const result = classify(hits, answerTokens, 0.6, 10);
    expect(result.match_rank).toBe(1);
  });

  it('respects a custom threshold — a hit that would pass at a low threshold fails at a high one', () => {
    // Only "carolin" (1/4 tokens) present -> overlap 0.25.
    const hits = [hit('Caroline was there.')];
    expect(classify(hits, answerTokens, 0.2, 10).classification).not.toBe('not-in-db');
    expect(classify(hits, answerTokens, 0.9, 10).classification).toBe('not-in-db');
  });

  describe('short-answer precision guard (review finding)', () => {
    // A 1-token gold answer ("Caroline") clears containment's 0.6 threshold
    // at 100% recall against ANY hit that merely mentions Caroline, even one
    // that is otherwise entirely unrelated to the question. Without the
    // precision guard this would be a false positive.
    const shortAnswer = gt('Caroline'); // 1 token -> <= SHORT_ANSWER_TOKEN_THRESHOLD

    it('rejects a long, mostly-unrelated hit that only shares the one short-answer token', () => {
      const hits = [hit('Caroline mentioned she really loves going for long walks in the park on weekends')];
      // Recall alone (no guard) would call this a match -- with the default
      // precision floor (0.2) it correctly falls through to not-in-db.
      const result = classify(hits, shortAnswer, 0.6, 10);
      expect(result.classification).toBe('not-in-db');
    });

    it('accepts a compact, genuinely on-topic hit sharing the same short answer', () => {
      const hits = [hit('Caroline support group')]; // 3 tokens, 1/3 = 0.33 precision, clears 0.2
      const result = classify(hits, shortAnswer, 0.6, 10);
      expect(result.classification).toBe('rank-ok');
      expect(result.match_rank).toBe(1);
    });

    it('keeps scanning past a threshold-clearing-but-low-precision hit to find a later good one', () => {
      const hits = [
        hit('Caroline mentioned she really loves going for long walks in the park on weekends'), // fails precision
        hit('Caroline support group'), // passes
      ];
      const result = classify(hits, shortAnswer, 0.6, 10);
      expect(result.classification).toBe('rank-ok');
      expect(result.match_rank).toBe(2);
    });

    it('does not apply the precision floor to a normal-length (> threshold) gold answer', () => {
      // answerTokens is 4 tokens -- long enough that the guard never
      // engages, even though this hit's own precision would be low.
      const hits = [hit('Caroline attended a support group as part of a much longer sentence about her whole week')];
      const result = classify(hits, answerTokens, 0.6, 10);
      expect(result.classification).not.toBe('not-in-db');
    });

    it('a custom --short-answer-min-precision changes the boundary', () => {
      const hits = [hit('Caroline mentioned she really loves going for long walks in the park on weekends')];
      // This hit's precision is 1/13 ≈ 0.077 -- passes a floor set below that.
      expect(classify(hits, shortAnswer, 0.6, 10, 0.05).classification).not.toBe('not-in-db');
      expect(classify(hits, shortAnswer, 0.6, 10, 0.2).classification).toBe('not-in-db');
    });
  });
});

describe('vecKMatchedLimit (pool-composition fix)', () => {
  it('gives 2-rank headroom past productionK when vecK is floor-bound at 50 (productionK <= 12)', () => {
    // search.ts: vecK = Math.max(limit*4, 50) -- for any limit <= 12,
    // 12*4=48 < 50, so vecK stays pinned at 50 regardless of the exact
    // limit within that range. 12 is the largest such limit.
    expect(vecKMatchedLimit(10)).toBe(12);
    expect(vecKMatchedLimit(1)).toBe(12);
    expect(vecKMatchedLimit(12)).toBe(12);
  });

  it('gives zero headroom once productionK > 12 (vecK scales linearly, no floor to hide behind)', () => {
    expect(vecKMatchedLimit(13)).toBe(13);
    expect(vecKMatchedLimit(20)).toBe(20);
  });
});

describe('diagnoseRetrieval two-pool orchestration (review fix: pool-composition bug)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sampleWithOneQuestion(question: string, answer: string, category: 1 | 2 | 3 | 4 = 4): LoCoMoSample {
    return {
      sample_id: 'conv-x',
      // Only sample_id/qa are read by diagnoseRetrieval -- conversation
      // content is irrelevant here, loosely typed to satisfy LoCoMoSample.
      conversation: { speaker_a: 'A', speaker_b: 'B' } as LoCoMoSample['conversation'],
      qa: [{ question, answer, evidence: [], category }],
    };
  }

  /** Fakes the daemon's POST /recall: returns `textsByLimit[requestedLimit]`
   *  (or []) as hit texts, in order -- lets a test control exactly what
   *  each of the two `recall()` calls diagnoseRetrieval makes would see. */
  function stubRecallByLimit(textsByLimit: Record<number, string[]>): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { limit: number };
      const texts = textsByLimit[body.limit] ?? [];
      const hits = texts.map((text, i) => ({ id: `h${i}`, type: 'fact', text, score: 0.5, source: 'fused' }));
      return new Response(JSON.stringify({ hits }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('classifies rank-ok from the production-matched pool alone, never touching the wide pool', async () => {
    // productionK=10 -> matchedLimit=12 (vecKMatchedLimit). Only that call
    // is stubbed -- if diagnoseRetrieval fell back to the wide pool anyway,
    // stubRecallByLimit would return [] for the unstubbed limit and the
    // test would (correctly) fail as not-in-db instead.
    const fetchMock = stubRecallByLimit({ 12: ['Caroline attended a support group'] });
    const sample = sampleWithOneQuestion('q', 'Caroline attended a support group');
    const report = await diagnoseRetrieval({ baseUrl: 'http://x', token: 't' }, [sample], { productionK: 10 });

    expect(report.records).toHaveLength(1);
    expect(report.records[0]!.classification).toBe('rank-ok');
    expect(report.records[0]!.match_rank).toBe(1);
    expect(report.records[0]!.rank_verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // wide pool never called
  });

  it('classifies rank-miss (rank_verified: true) when found in the matched pool beyond productionK', async () => {
    const noise = Array.from({ length: 10 }, (_, i) => `filler ${i}`);
    const fetchMock = stubRecallByLimit({ 12: [...noise, 'Caroline attended a support group'] });
    const sample = sampleWithOneQuestion('q', 'Caroline attended a support group');
    const report = await diagnoseRetrieval({ baseUrl: 'http://x', token: 't' }, [sample], { productionK: 10 });

    expect(report.records[0]!.classification).toBe('rank-miss');
    expect(report.records[0]!.match_rank).toBe(11);
    expect(report.records[0]!.rank_verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // found in the matched pool, no wide-pool fallback needed
  });

  it('falls back to the wide pool and classifies rank-miss with rank_verified:false when found ONLY there', async () => {
    const fetchMock = stubRecallByLimit({
      12: ['totally unrelated filler'],
      500: ['totally unrelated filler', 'Caroline attended a support group'],
    });
    const sample = sampleWithOneQuestion('q', 'Caroline attended a support group');
    const report = await diagnoseRetrieval({ baseUrl: 'http://x', token: 't' }, [sample], { productionK: 10 });

    expect(report.records[0]!.classification).toBe('rank-miss');
    expect(report.records[0]!.match_rank).toBe(2); // real rank within the WIDE pool -- not comparable to production
    expect(report.records[0]!.rank_verified).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // matched pool first, then wide-pool fallback
  });

  it('classifies not-in-db (rank_verified: true) when absent from both pools', async () => {
    const fetchMock = stubRecallByLimit({ 12: ['unrelated'], 500: ['still unrelated'] });
    const sample = sampleWithOneQuestion('q', 'Caroline attended a support group');
    const report = await diagnoseRetrieval({ baseUrl: 'http://x', token: 't' }, [sample], { productionK: 10 });

    expect(report.records[0]!.classification).toBe('not-in-db');
    expect(report.records[0]!.match_rank).toBeNull();
    expect(report.records[0]!.rank_verified).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses --production-k to pick the matched-pool limit (mirrors vecKMatchedLimit)', async () => {
    // productionK=20 -> vecKMatchedLimit(20)=20 (no headroom, > 12 regime).
    const fetchMock = stubRecallByLimit({ 20: ['Caroline attended a support group'] });
    const sample = sampleWithOneQuestion('q', 'Caroline attended a support group');
    const report = await diagnoseRetrieval({ baseUrl: 'http://x', token: 't' }, [sample], { productionK: 20 });

    expect(report.records[0]!.classification).toBe('rank-ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('computeBreakdown', () => {
  function record(category: 1 | 2 | 3 | 4, classification: DiagnosisRecord['classification'], shortAnswer = false, rankVerified = true): DiagnosisRecord {
    return {
      qa_id: 'x#0', sample_id: 'x', category, question: 'q', answer: 'a', evidence: [],
      classification, match_rank: classification === 'rank-ok' ? 1 : classification === 'rank-miss' ? 11 : null,
      match_overlap: classification === 'not-in-db' ? null : 0.8, rank_verified: rankVerified,
      short_answer: shortAnswer, total_hits: 20,
    };
  }

  it('splits per-category and overall counts/percentages correctly', () => {
    const records: DiagnosisRecord[] = [
      record(4, 'not-in-db'), record(4, 'rank-miss'), record(4, 'rank-ok'), record(4, 'rank-ok'),
      record(2, 'rank-ok'),
    ];
    const { per_category, overall } = computeBreakdown(records);

    const singleHop = per_category.find(c => c.category === 4)!;
    expect(singleHop.n).toBe(4);
    expect(singleHop.not_in_db).toBe(1);
    expect(singleHop.rank_miss).toBe(1);
    expect(singleHop.rank_ok).toBe(2);
    expect(singleHop.rank_ok_pct).toBeCloseTo(50, 5);

    const temporal = per_category.find(c => c.category === 2)!;
    expect(temporal.n).toBe(1);
    expect(temporal.rank_ok).toBe(1);

    expect(overall.n).toBe(5);
    expect(overall.rank_ok).toBe(3);
  });

  it('omits a category entirely from per_category when it has zero records', () => {
    const { per_category } = computeBreakdown([record(4, 'rank-ok')]);
    expect(per_category.map(c => c.category)).toEqual([4]);
  });

  it('produces NaN percentages (not a divide-by-zero throw) for zero total records', () => {
    const { overall } = computeBreakdown([]);
    expect(overall.n).toBe(0);
    expect(Number.isNaN(overall.not_in_db_pct)).toBe(true);
  });

  it('counts short_answer records separately without excluding them from the main counts', () => {
    const records: DiagnosisRecord[] = [
      record(4, 'rank-ok', true), record(4, 'rank-ok', false), record(4, 'not-in-db', true),
    ];
    const { overall } = computeBreakdown(records);
    expect(overall.n).toBe(3);
    expect(overall.rank_ok).toBe(2);
    expect(overall.short_answer_n).toBe(2);
  });

  it('counts unverified-rank records separately (review fix: pool-composition bug)', () => {
    const records: DiagnosisRecord[] = [
      record(4, 'rank-miss', false, true), // verified against the production-matched pool
      record(4, 'rank-miss', false, false), // only found via the wide existence-pool fallback
      record(4, 'rank-ok'), // rank-ok is always rank_verified: true
    ];
    const { overall } = computeBreakdown(records);
    expect(overall.n).toBe(3);
    expect(overall.rank_miss).toBe(2);
    expect(overall.unverified_rank_n).toBe(1);
  });
});
