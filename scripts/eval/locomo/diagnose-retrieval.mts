/**
 * Retrieval diagnostic (WS2, `docs/specs/20260713-locomo-architect-design.md`
 * workstream 2) -- answers the question the single-hop headroom item needs
 * before any fix is chosen: for a question we get wrong, is the fact that
 * should answer it (a) never captured as a distinct atom at all ("not
 * in DB" -- an extraction/embedding miss), (b) captured and findable but
 * ranked below the k=10 window the real answerer sees ("rank-miss" -- a
 * fusion/ranking problem), or (c) captured and ranked fine ("rank-ok" -- a
 * wrong answer here is answerer/ambiguity, not a memory-system problem,
 * out of scope per the benchmark-integrity constraint in
 * `docs/specs/20260713-locomo-score-plan.md`)?
 *
 * These three buckets need OPPOSITE remedies (rerank/fusion tuning vs.
 * distill-side recall work vs. nothing), so guessing which one dominates
 * before measuring risks spending the single largest lever on the board
 * (single-hop is 35% of all LoCoMo questions) on the wrong fix.
 *
 * ZERO production source changes throughout this file.
 *
 * ── Pool-composition bug, fixed (review finding, more serious than a
 * caveat) ──────────────────────────────────────────────────────────────
 *
 * An earlier version of this file made ONE `/recall` call per question with
 * a high `--limit` (500) and used that single call's rank directly to decide
 * rank-ok vs rank-miss. That is NOT "the same ranking, just deeper" --
 * `search()` computes `vecK = opts.vecK ?? Math.max(limit * 4, 50)`
 * (`src/server/routes/search.ts:73`, `src/search/search.ts:387`), and vecK
 * bounds BOTH the FTS5 candidate query (`search.ts:394-401`, `LIMIT ?` is
 * vecK) and the vector search (`search.ts:428`, `vecStore.search(queryVec,
 * vecK)`). The real answerer calls `recall(..., limit: k=10)`
 * (`answer.mts:80`) -> vecK=50. A diagnostic call with `limit=500` ->
 * vecK=2000 -- a materially different, much larger candidate pool.
 *
 * Worse: `fuse.ts`'s `normalizeScores()` (`fuse.ts:87-97`) is MIN-MAX
 * normalization computed over exactly that candidate array
 * (`search.ts:633,636`) -- pool-composition-dependent by construction. The
 * same atom's normalized bm25/cosine component, and hence its fused rank,
 * changes depending on what else is in the pool with it. Finding an atom at
 * rank 6 in a vecK=2000 pool does NOT mean it would be findable, or at the
 * same relative rank, in the vecK=50 pool the real k=10 answerer actually
 * sees -- a "rank-ok"/"rank-miss" verdict from the old single-call design
 * could be measuring a different system's ranking entirely.
 *
 * Fix: TWO calls per question, each answering a DIFFERENT question:
 *
 * 1. **Production-matched pool** (`vecKMatchedLimit(productionK)`, see
 *    below) -- a `/recall` call whose `limit` is chosen so `search()`
 *    computes THE EXACT SAME vecK the real `k=<productionK>` answerer call
 *    would. There is no wire parameter for vecK itself (`SearchOpts.vecK` is
 *    a `search()`-level override, never exposed on `POST /recall`'s Zod
 *    schema) -- but `vecK = Math.max(limit*4, 50)` is FLOOR-BOUND at 50 for
 *    any `limit <= 12`, so requesting `limit=12` (instead of exactly
 *    `k=10`) gets 2 extra ranks of free headroom past the real cutoff
 *    while the candidate pool composition and normalization baseline stay
 *    byte-identical to the real path. This call decides rank-ok
 *    (rank <= productionK) vs. rank-miss (found here, rank > productionK)
 *    with a genuinely apples-to-apples measurement.
 * 2. **Wide existence pool** (`--wide-limit`, default 500, the OLD single
 *    call's role) -- consulted ONLY when call 1 finds nothing. This
 *    determines pure EXISTENCE ("is this fact captured as a distinct atom
 *    ANYWHERE, findable by ANY size pool"), which -- unlike a rank number --
 *    is pool-size-invariant: token containment either finds a matching atom
 *    somewhere or it doesn't, regardless of what else got fused around it.
 *    A match found only here is still classified `rank-miss` (retrieval-
 *    side, same opposite-remedies bucket as a confirmed miss) but carries
 *    `rank_verified: false` -- its `match_rank`/`match_overlap` are real
 *    numbers within THAT wide pool, but are NOT comparable to what the real
 *    k=<productionK> answerer would ever see, so don't read them as "would
 *    have ranked Nth" the way a `rank_verified: true` record's numbers mean
 *    exactly that.
 *
 * `vecKMatchedLimit`'s 2-rank headroom (12 vs. productionK=10) only exists
 * because `productionK <= 12` (vecK stays floor-bound at 50). For a
 * hypothetical `productionK > 12`, vecK scales linearly with limit, so the
 * ONLY limit value reproducing the exact real vecK is `productionK` itself
 * -- zero headroom, `rank-miss` becomes purely a wide-pool-fallback
 * determination in that regime. Not a concern today (real `k` defaults to
 * 10 everywhere in this harness), but don't assume headroom exists for an
 * arbitrarily large `--production-k`.
 *
 * Matching heuristic (both pools): does NOT try to map a hit back to the
 * transcript evidence turns named in `qa.evidence` (evidence identifies
 * dialog ids in the SOURCE transcript, not memory ids -- there is no such
 * mapping to recover). Instead it computes the same Porter-stemmed token
 * overlap the real F1 scorer uses (`judge/metrics.mts`'s `stemmedTokens`,
 * exported for this file rather than re-derived) between the GOLD ANSWER
 * and each hit's text, walked in rank order. The first hit whose
 * containment (fraction of gold-answer tokens present in that hit) clears
 * `--threshold` (default 0.6) is treated as "the atom that answers this
 * question." `qa.evidence` is carried through into the output record unused
 * by the classifier itself -- it's there so a human spot-checking a sample
 * of "not-in-db" verdicts can cross-reference the original transcript
 * dialog ids by hand.
 *
 * Category-agnostic (AC-3): `--category` filters which LoCoMo categories run
 * (default: 1-4, every category with a real `answer` field). Category 5
 * (adversarial) is always excluded -- adversarial questions have no `answer`,
 * only a `adversarial_answer` distractor, and the CORRECT behavior there is
 * to abstain, not retrieve, so there is no ground-truth atom to locate. This
 * means WS4 (open-domain, category 3) reuses this file for free by passing
 * `--category 3` once its full-sample rerun exists -- no separate tooling.
 *
 * Known simplification for category 1 (multi-hop): containment is computed
 * against the WHOLE gold-answer string (after the same category-3
 * semicolon-truncation `judge/metrics.mts`'s `scoreHypothesis` applies),
 * not per comma-separated answer fragment the way `multiAnswerF1` scores it.
 * A genuinely multi-hop question whose answer requires evidence merged from
 * two different memories can therefore read as "not-in-db" here even when
 * each fragment is individually retrievable. Treat multi-hop's bucketing as
 * directionally useful, not as precise as single-hop's.
 *
 * Known limitation for SHORT gold answers (review finding, fixed not just
 * disclosed): containment is deliberately recall-only (see its own doc
 * comment) so a long, correct hit sentence never gets unfairly penalized on
 * precision. But for a gold answer that stems to only 1-2 tokens (a bare
 * name, "yes"/"no", a lone date), 100% recall is nearly meaningless -- ANY
 * hit sharing that one common token, however unrelated, clears `threshold`
 * and can get silently credited as "the atom that answers this question."
 * `classify` closes this by ALSO requiring a minimum precision
 * (`--short-answer-min-precision`, default 0.12 -- see
 * `DEFAULT_SHORT_ANSWER_MIN_PRECISION`'s own doc comment for exactly why
 * 0.12 and not a rounder 0.2) whenever the gold answer is at or below
 * `SHORT_ANSWER_TOKEN_THRESHOLD` (2) tokens, which a long, mostly-unrelated
 * hit sharing one incidental word fails and a compact, genuinely-on-topic
 * atom sentence clears. Every record carries `short_answer: bool` and each
 * category's breakdown reports how many of its records were short-answer,
 * so a reviewer can spot-check that bucket specifically rather than trust
 * it silently folded into the aggregate.
 *
 * ── LLM-judge classifier, fixing #267 ───────────────────────────────────
 *
 * Issue #267: pure token containment (above) shares the exact bias of the
 * thing it measures. A hand-verified sample (WS3, n=50, deterministic
 * across all 10 conversations) found a **42% false-negative rate** in the
 * `not-in-db` bucket -- facts that WERE correctly stored, worded
 * differently from gold (`"LGBTQ+ folks"` vs gold's `"LGBTQ+ individuals"`
 * scores containment 0.5, just under the 0.6 threshold, because LoCoMo's
 * own `normalizeAnswer` -- faithfully reproduced here, see
 * `judge/metrics.mts` -- only strips "a/an/the/and", not real stopwords
 * like "of"/"their"/"for", which dilute recall on any answer phrased as a
 * full clause). The mirror-image defect also exists: WS6 hand-verified 2/50
 * `rank-ok` records as coincidental token overlap that should have been
 * `not-in-db`. Tuning the threshold cannot fix both directions at once --
 * the fix is a semantic check, not a better cutoff on the same metric.
 *
 * `--llm-judge` (opt-in; omitted reproduces the pre-#267 pure-containment
 * path byte-for-byte, exactly like every other flag in this file) replaces
 * containment as the DECISION with an LLM yes/no judge
 * (`judgeContainsFact`), while keeping containment as a cheap, LOCAL
 * candidate-shortlist step (mirrors WS3's own hand-verification method:
 * "top-3 candidates by [token] overlap, hand-verified against the real
 * text" -- see the issue-267 comment). For each pool (matched, then wide
 * fallback), the top `--judge-top-n` (default 3) hits by containment score
 * are judged in PRODUCTION RANK order (not containment order) so the first
 * judge-confirmed match is still the earliest-ranked one a real answerer
 * would see -- the first "yes" wins, exactly like `firstQualifyingHit`'s
 * "first hit clearing threshold" semantics, just with a smarter yes/no.
 *
 * This single mechanism fixes BOTH directions at once: a `not-in-db`
 * candidate the judge confirms gets promoted (fixes #267's headline false
 * negatives); a `rank-ok` candidate the judge REJECTS falls through to the
 * next candidate / next pool / `not-in-db` (fixes WS6's false positives) --
 * because every record's top containment candidate is judged regardless of
 * whether it already clears the old 0.6 threshold.
 *
 * Cost control (FEAT-482 lesson: an uncapped LLM judge loop already wedged
 * this daemon once at ~245 calls -- see CLAUDE.md's "Contradiction
 * detection ships enabled" section): a single `JudgeBudgetTracker` shared
 * across the WHOLE run enforces `--judge-max-calls` (default 1200) and
 * `--judge-wall-clock-ms` (default 900000 = 15min) hard caps. Tripping
 * either cap does not corrupt results -- remaining un-judged records fall
 * back to the exact pre-#267 pure-containment classification (flagged
 * `judge_capped: true` in their record) rather than being silently
 * mislabeled `not-in-db`. A judge call that errors or returns unparsable
 * JSON is the SAME non-fatal fallback shape as `contradiction-judge.ts`'s
 * `onFallback` -- falls back to the old containment+precision decision for
 * that one candidate (flagged via `judge_calls`/`judge_failures` in the
 * per-record accounting), never silently drops the candidate.
 *
 * `--judge-provider` defaults to `codex-subscription` (cloud, metered
 * against the operator's ChatGPT quota, does NOT contend for the local
 * GPU) -- deliberately NOT `ollama`, because this diagnostic is meant to
 * run WHILE an extraction/eval bench may already hold the GPU's single
 * execution queue (see CLAUDE.md's Ollama 8GB VRAM ceiling note). Pass
 * `--judge-provider ollama` only when the GPU is confirmed idle
 * (`curl localhost:11434/api/ps`).
 *
 * CLI: bun scripts/eval/locomo/diagnose-retrieval.mts --sample <sample.json>
 *        --daemon-url <url> --token <token>
 *        [--production-k 10] [--wide-limit 500] [--threshold 0.6]
 *        [--short-answer-min-precision 0.12]
 *        [--category 1,2,3,4] [--out diagnosis.json]
 *        [--ready <distill-wait-result.json>]
 *        [--llm-judge] [--judge-provider codex-subscription] [--judge-model <model>]
 *        [--judge-top-n 3] [--judge-max-calls 1200] [--judge-wall-clock-ms 900000]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, isAdversarial, qaId, type LoCoMoCategory, type LoCoMoQA, type LoCoMoSample } from './lib/types.js';
import { projectIdFor } from './lib/envelope.js';
import { recall, type DaemonClientOpts, type SearchHit } from '../shared/daemon-client.js';
import { stemmedTokens } from './judge/metrics.mts';
import { OllamaLLMProvider } from '../../../src/providers/llm/ollama.js';
import { CodexSubscriptionLLMProvider } from '../../../src/providers/llm/codex-subscription.js';
import type { LLMProvider } from '../../../src/contracts/llm.js';

export type Classification = 'not-in-db' | 'rank-miss' | 'rank-ok';

export interface DiagnosisRecord {
  qa_id: string;
  sample_id: string;
  category: LoCoMoCategory;
  question: string;
  /** Gold-answer string actually compared against hit text -- post the same
   *  category-3 `split(';')[0]` truncation the real scorer applies. */
  answer: string;
  /** Dialog ids the answer is grounded in (raw `qa.evidence`) -- carried
   *  through for manual spot-checking, not consumed by the classifier. */
  evidence: string[];
  classification: Classification;
  /** 1-based rank of the first hit clearing `threshold` (and, for a short
   *  gold answer, the precision floor too), or null if none did. Only
   *  directly comparable to the real production answerer's ranking when
   *  `rank_verified` is true -- see that field's doc comment. */
  match_rank: number | null;
  /** Containment fraction (gold-answer tokens found / gold-answer tokens
   *  total) achieved at `match_rank`, or null if `match_rank` is null. */
  match_overlap: number | null;
  /** True when `match_rank`/`match_overlap` were measured within a
   *  candidate pool with the SAME vecK as the real production
   *  `k=<productionK>` answerer call (see the file header's "Pool-
   *  composition bug, fixed") -- directly comparable to what the real
   *  answerer would see. False means the match was found ONLY via the wide
   *  existence-check pool after the production-matched pool came up empty:
   *  the fact demonstrably exists and is textually locatable, but this
   *  specific rank number is NOT comparable to production's fused ranking.
   *  Always true when `classification` is 'not-in-db' (there is no rank to
   *  distrust -- existence was ruled out via the wide pool either way). */
  rank_verified: boolean;
  /** True when the gold answer stems to <= SHORT_ANSWER_TOKEN_THRESHOLD
   *  tokens -- flagged so this record's classification can be spot-checked
   *  separately rather than trusted at face value in the aggregate (see the
   *  file header's "Known limitation for SHORT gold answers"). */
  short_answer: boolean;
  /** Hits actually returned by whichever pool (`total_hits`) produced this
   *  record's classification -- the production-matched pool when found
   *  there, otherwise the wide pool. */
  total_hits: number;
  /** True when the LLM judge (#267 fix) actually decided this record's
   *  classification -- false when `--llm-judge` was never passed (pure
   *  pre-#267 containment path) OR the shared judge budget was already
   *  exhausted before this record's turn (see `judge_capped`). */
  judged: boolean;
  /** Total judge calls spent on this record (both pools combined). 0 when
   *  `judged` is false. */
  judge_calls: number;
  /** Judge calls that errored or returned unparsable JSON for this record
   *  (each one individually fell back to the old containment+precision
   *  decision for that one candidate, same non-fatal shape as
   *  `contradiction-judge.ts`'s `onFallback`) -- always <= `judge_calls`. */
  judge_failures: number;
  /** True when the shared run-level judge budget (`--judge-max-calls` /
   *  `--judge-wall-clock-ms`) was already exhausted before this record could
   *  be judged, so it fell back to the exact pre-#267 pure-containment
   *  classification instead. Distinguishes "the judge looked and found
   *  nothing" from "the judge never got a turn" -- the latter should be
   *  re-run, not trusted as a judged verdict. */
  judge_capped: boolean;
}

export interface CategoryBreakdown {
  category: LoCoMoCategory | 'overall';
  name: string;
  n: number;
  not_in_db: number;
  rank_miss: number;
  rank_ok: number;
  not_in_db_pct: number;
  rank_miss_pct: number;
  rank_ok_pct: number;
  /** Count of this bucket's records where `short_answer` is true -- report
   *  separately, don't fold silently into the aggregate (review finding). */
  short_answer_n: number;
  /** Count of this bucket's records where `rank_verified` is false -- i.e.
   *  classified via the wide existence pool, not the production-matched
   *  one. Report separately for the same reason as `short_answer_n`: a
   *  category whose rank-miss count is mostly unverified is a weaker signal
   *  than one confirmed against the real candidate pool. */
  unverified_rank_n: number;
}

/** Run-level accounting for the #267 LLM-judge path -- always present, all
 *  zero/false when `--llm-judge` was never passed (unjudged run). Lets a
 *  reader tell "this bucket split is judge-verified" from "this is the old
 *  pure-containment split" without re-deriving it from every record. */
export interface JudgeSummary {
  enabled: boolean;
  total_calls: number;
  total_failures: number;
  /** Records where `judge_capped` is true -- the shared budget ran out
   *  before every record got a turn. Non-zero means the bucket split below
   *  is a MIX of judge-verified and old-containment-fallback records; see
   *  each record's own `judge_capped` flag to tell which is which. */
  capped_records: number;
}

export interface DiagnosisReport {
  per_category: CategoryBreakdown[];
  overall: CategoryBreakdown;
  records: DiagnosisRecord[];
  judge_summary: JudgeSummary;
}

/** Same answer-string derivation `judge/metrics.mts`'s `scoreHypothesis`
 *  applies before scoring -- category 3 (open-domain) answers look like
 *  "Likely no; though she likes reading..." and only the part before the
 *  first `;` is ever actually scored/comparable. */
export function resolveAnswerString(category: LoCoMoCategory, answer: string | number): string {
  let s = String(answer);
  if (category === 3) s = (s.split(';')[0] ?? '').trim();
  return s;
}

/** Shared multiset-overlap arithmetic behind both `containment` and
 *  `precision` below -- computes `numSame` (the same numerator
 *  `judge/metrics.mts`'s `f1Score` uses for its recall term) once per
 *  (gtTokens, hitText) pair rather than duplicating the counting loop. */
function overlapCounts(gtTokens: string[], hitText: string): { numSame: number; hitTotal: number } {
  const hitTokens = stemmedTokens(hitText);
  const hitCounts = new Map<string, number>();
  for (const t of hitTokens) hitCounts.set(t, (hitCounts.get(t) ?? 0) + 1);
  const gtCounts = new Map<string, number>();
  for (const t of gtTokens) gtCounts.set(t, (gtCounts.get(t) ?? 0) + 1);
  let numSame = 0;
  for (const [tok, gtCount] of gtCounts) numSame += Math.min(gtCount, hitCounts.get(tok) ?? 0);
  return { numSame, hitTotal: hitTokens.length };
}

/** Multiset containment: fraction of `gtTokens` (with repetition) found in
 *  `hitTokens` -- we want "does this hit CONTAIN the answer," not a
 *  symmetric F1 against the hit's full text (which is usually a whole
 *  memory sentence, much longer than the terse gold answer, and would be
 *  unfairly penalized on precision alone). This is deliberately recall-only;
 *  see `precision` below and the file header's "Known limitation for SHORT
 *  gold answers" for why recall alone is not sufficient on its own for very
 *  short answers. */
export function containment(gtTokens: string[], hitText: string): number {
  if (gtTokens.length === 0) return 0;
  const { numSame } = overlapCounts(gtTokens, hitText);
  return numSame / gtTokens.length;
}

/** Precision half of the overlap: fraction of the HIT's OWN tokens that are
 *  accounted for by the gold answer. Unused for normal-length gold answers
 *  (containment/recall alone is the right measure there -- see its doc
 *  comment) but used by `classify`/`firstQualifyingHit` as an ADDITIONAL
 *  guard for short (<= `SHORT_ANSWER_TOKEN_THRESHOLD`) gold answers, where
 *  100% recall of a single common token proves almost nothing about whether
 *  a hit is actually on-topic. */
export function precision(gtTokens: string[], hitText: string): number {
  const { numSame, hitTotal } = overlapCounts(gtTokens, hitText);
  return hitTotal === 0 ? 0 : numSame / hitTotal;
}

const DEFAULT_CATEGORIES: LoCoMoCategory[] = [1, 2, 3, 4];

/** A gold answer stemming to this many tokens or fewer is "short" -- see the
 *  file header's "Known limitation for SHORT gold answers." 2 was chosen
 *  because containment's discrete fractional steps for n<=2 (0, 0.5, 1.0)
 *  already collapse to "all-or-nothing" at the default 0.6 threshold, which
 *  is exactly the case where a single shared token can look like a "full"
 *  match despite being weak evidence. */
export const SHORT_ANSWER_TOKEN_THRESHOLD = 2;
/** Default floor for `precision()` on a short gold answer -- the shared
 *  token(s) must be at least this fraction of the HIT's own tokens.
 *
 *  0.12, not a rounder-looking 0.2 -- an earlier draft of this guard used
 *  0.2 and a live smoke test caught it rejecting a GENUINE match: a
 *  single-token date answer ("2023-05-14" stems to one token, the hyphens
 *  are stripped as punctuation with no replacement) inside a realistic
 *  6-token compact atom sentence ("Caroline attended a support group on
 *  2023-05-14" -> ["carolin","attend","support","group","on","20230514"])
 *  scores precision 1/6 ≈ 0.167 -- comfortably a real match, but below 0.2.
 *  0.12 passes that case while still failing the long-unrelated-sentence
 *  case this guard exists for (a 13-token sentence sharing one incidental
 *  token scores 1/13 ≈ 0.077). Still not derived from a full real-data
 *  distribution -- a same-day starting point informed by one concrete
 *  measured example, adjustable via --short-answer-min-precision; revisit
 *  once Wave 2's real run gives real atom-length statistics. */
export const DEFAULT_SHORT_ANSWER_MIN_PRECISION = 0.12;
/** Default production `k` to match -- answer.mts's own default recall limit
 *  (`answer.mts:68`, `run.mts`'s `--k` default 10). Drives BOTH
 *  `vecKMatchedLimit` and the rank-ok/rank-miss boundary itself. */
export const DEFAULT_PRODUCTION_K = 10;
/** Default wide existence-check pool size -- the OLD single-call design's
 *  `--limit`. Only used as a fallback when the production-matched pool
 *  finds nothing (see the file header). CLAUDE.md: ~10 atoms/session, so a
 *  20-35 session conversation tops out around 200-350 atoms -- 500 always
 *  covers the whole project. */
export const DEFAULT_WIDE_LIMIT = 500;

/**
 * The `limit` value that maximizes visibility while keeping `search()`'s
 * internal `vecK = Math.max(limit*4, 50)` IDENTICAL to what the real
 * production `k=productionK` answerer call computes -- see the file
 * header's "Pool-composition bug, fixed" for the full rationale.
 *
 * When `productionK <= 12`, vecK is floor-bound at 50 regardless of the
 * exact limit (since `12*4=48 < 50`), so requesting up to 12 gets 2 extra
 * ranks of headroom past the real cutoff for free, at the exact same vecK.
 * When `productionK > 12`, vecK scales linearly with limit -- the only
 * limit reproducing the exact real vecK is `productionK` itself (zero
 * headroom).
 */
export function vecKMatchedLimit(productionK: number): number {
  const productionVecK = Math.max(productionK * 4, 50);
  return productionVecK === 50 ? 12 : productionK;
}

/** Walk `hits` (already in rank order) and return the first (1-based rank,
 *  containment) whose containment clears `threshold` AND -- for a short
 *  gold answer -- whose precision clears `shortAnswerMinPrecision`. Pure
 *  existence/position primitive: no notion of "ok" vs. "miss" here, since
 *  that judgment depends on which POOL these hits came from (see the file
 *  header) -- that's the caller's job, not this function's. */
function firstQualifyingHit(
  hits: SearchHit[],
  gtTokens: string[],
  threshold: number,
  shortAnswerMinPrecision: number,
): { rank: number; overlap: number } | null {
  const isShort = gtTokens.length <= SHORT_ANSWER_TOKEN_THRESHOLD;
  for (let i = 0; i < hits.length; i++) {
    const overlap = containment(gtTokens, hits[i]!.text);
    if (overlap < threshold) continue;
    // Short-answer guard (review finding): recall alone is too easy to
    // satisfy by coincidence for a 1-2 token answer -- also require the
    // shared token(s) to be a non-trivial share of THIS hit's own tokens
    // before accepting it as the answering hit. Keep scanning subsequent
    // hits rather than giving up on the first threshold-clearing-but-
    // precision-failing one.
    if (isShort && precision(gtTokens, hits[i]!.text) < shortAnswerMinPrecision) continue;
    return { rank: i + 1, overlap };
  }
  return null;
}

// ── LLM-judge classifier (#267 fix) ─────────────────────────────────────

/** Stable marker so a mock/test LLMProvider can route judge calls to a
 *  dedicated branch, mirroring `contradiction-judge.ts`'s
 *  `CONTRADICTION_JUDGE_MARKER` pattern. */
export const RETRIEVAL_JUDGE_MARKER = 'astramem-retrieval-diagnostic-judge-v1';

const RetrievalJudgeSchema = z.object({ match: z.boolean() });

const JUDGE_SYSTEM_PROMPT = `${RETRIEVAL_JUDGE_MARKER}. You are checking whether a stored memory
statement already contains the fact a reference answer states -- even if worded completely
differently (synonyms, paraphrase, a different sentence structure all still count as a match).
Respond with a single JSON object: {"match": true|false}.
match=true only if the stored memory asserts the SAME fact as the reference answer, in the
context of the question asked. match=false if the stored memory is about a different fact, a
different entity, or only shares incidental words with no real semantic overlap.`;

/** Default top-N containment-ranked candidates judged per pool -- mirrors
 *  WS3's own hand-verification method (see the file header). Bounds the
 *  judge to at most `judgeTopN` calls per pool per record regardless of
 *  pool size (12 or 500), so the wide pool's larger size never translates
 *  into materially more judge calls. */
export const DEFAULT_JUDGE_TOP_N = 3;
/** Default run-level judge call cap (FEAT-482 lesson -- see file header). */
export const DEFAULT_JUDGE_MAX_CALLS = 1200;
/** Default run-level judge wall-clock cap, ms (15 minutes). */
export const DEFAULT_JUDGE_WALL_CLOCK_MS = 900_000;

/** Shared, run-level (not per-record) budget -- construct exactly ONCE per
 *  `diagnoseRetrieval` call and pass it through every record so the caps
 *  apply to the WHOLE run, not per-question. */
export class JudgeBudgetTracker {
  calls = 0;
  private readonly startedAt = Date.now();
  constructor(private readonly maxCalls: number, private readonly maxWallClockMs: number) {}
  tripped(): boolean {
    return this.calls >= this.maxCalls || (Date.now() - this.startedAt) >= this.maxWallClockMs;
  }
  spend(): void { this.calls++; }
}

/** Single yes/no judge call. Never throws -- a thrown/rejected `chat()` or
 *  unparsable JSON response returns `ok: false` (same non-fatal shape as
 *  `contradiction-judge.ts`'s `onFallback`) so the caller can fall back to
 *  the old containment+precision decision for that one candidate instead of
 *  silently dropping it or silently miscounting it as a confirmed "no". */
export async function judgeContainsFact(
  llm: LLMProvider,
  question: string,
  goldAnswer: string,
  hitText: string,
): Promise<{ match: boolean; ok: boolean }> {
  try {
    const result = await llm.chat(
      [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        { role: 'user', content: `Question: ${question}\nReference answer: ${goldAnswer}\nStored memory: ${hitText}` },
      ],
      { temperature: 0, json: true },
    );
    const parsed = RetrievalJudgeSchema.safeParse(JSON.parse(result.text));
    return parsed.success ? { match: parsed.data.match, ok: true } : { match: false, ok: false };
  } catch {
    return { match: false, ok: false };
  }
}

export interface JudgeMatchResult {
  found: { rank: number; overlap: number } | null;
  judgeCalls: number;
  judgeFailures: number;
  /** True iff the shared budget was already tripped before this pool's
   *  candidates could be judged at all -- caller should fall back to the
   *  plain `firstQualifyingHit` result for this pool rather than trust
   *  `found: null` as a judged verdict. */
  capped: boolean;
}

/** Judge-augmented version of `firstQualifyingHit`: containment ranks ALL
 *  hits (cheap, local, unchanged), the top `topN` by containment score are
 *  then judged in PRODUCTION RANK order (not containment order) so the
 *  first judge-confirmed candidate is still the earliest-ranked one a real
 *  answerer would see -- see the file header for the full rationale. Every
 *  record's top candidate is judged even when it already clears the old
 *  0.6 threshold, which is what lets this fix WS6's false positives (a
 *  coincidental-overlap candidate the judge rejects falls through) and not
 *  just #267's false negatives (a low-overlap candidate the judge accepts
 *  gets promoted) with one mechanism. */
async function firstQualifyingHitByJudge(
  hits: SearchHit[],
  question: string,
  goldAnswer: string,
  gtTokens: string[],
  threshold: number,
  shortAnswerMinPrecision: number,
  llm: LLMProvider,
  budget: JudgeBudgetTracker,
  topN: number,
): Promise<JudgeMatchResult> {
  if (budget.tripped()) return { found: null, judgeCalls: 0, judgeFailures: 0, capped: true };

  const scored = hits.map((h, i) => ({ rank: i + 1, overlap: containment(gtTokens, h.text), hit: h }));
  const candidates = [...scored]
    .sort((a, b) => b.overlap - a.overlap || a.rank - b.rank)
    .slice(0, topN)
    .sort((a, b) => a.rank - b.rank); // judge in production rank order among the shortlist

  let judgeCalls = 0;
  let judgeFailures = 0;
  const isShort = gtTokens.length <= SHORT_ANSWER_TOKEN_THRESHOLD;

  for (const c of candidates) {
    if (budget.tripped()) return { found: null, judgeCalls, judgeFailures, capped: true };
    budget.spend();
    judgeCalls++;
    const { match, ok } = await judgeContainsFact(llm, question, goldAnswer, c.hit.text);
    if (!ok) {
      judgeFailures++;
      // Judge call itself failed -- fall back to the old containment+
      // precision decision for THIS candidate only, rather than silently
      // discarding it (same non-fatal-fallback spirit as
      // contradiction-judge.ts, applied per-candidate here).
      const passesOld = c.overlap >= threshold && (!isShort || precision(gtTokens, c.hit.text) >= shortAnswerMinPrecision);
      if (passesOld) return { found: { rank: c.rank, overlap: c.overlap }, judgeCalls, judgeFailures, capped: false };
      continue;
    }
    if (match) return { found: { rank: c.rank, overlap: c.overlap }, judgeCalls, judgeFailures, capped: false };
  }
  return { found: null, judgeCalls, judgeFailures, capped: false };
}

/** Builds the real (network-calling) judge provider for the CLI, per
 *  `--judge-provider`/`--judge-model`. Defaults to `codex-subscription`
 *  (cloud, does not contend the local GPU) -- see the file header for why
 *  `ollama` is opt-in, not the default, for this specific script. */
export function buildJudgeProvider(providerName: 'codex-subscription' | 'ollama', model?: string): LLMProvider {
  if (providerName === 'ollama') return new OllamaLLMProvider(model ? { model } : {});
  return new CodexSubscriptionLLMProvider(model ? { model } : {});
}

/** Single-pool rank-ok/rank-miss/not-in-db boundary decision, exported for
 *  direct unit testing (diagnose-retrieval.test.ts) without having to mock
 *  a daemon HTTP response. `diagnoseRetrieval` does NOT call this directly
 *  for its real two-pool logic (see `firstQualifyingHit` + the inline
 *  orchestration below) -- it's the single-pool primitive `classify` used
 *  to be, kept for test coverage and for any future caller that only has
 *  one candidate pool to judge against. */
export function classify(
  hits: SearchHit[],
  gtTokens: string[],
  threshold: number,
  rankBoundary: number,
  shortAnswerMinPrecision: number = DEFAULT_SHORT_ANSWER_MIN_PRECISION,
): Pick<DiagnosisRecord, 'classification' | 'match_rank' | 'match_overlap'> {
  const found = firstQualifyingHit(hits, gtTokens, threshold, shortAnswerMinPrecision);
  if (!found) return { classification: 'not-in-db', match_rank: null, match_overlap: null };
  return {
    classification: found.rank <= rankBoundary ? 'rank-ok' : 'rank-miss',
    match_rank: found.rank,
    match_overlap: found.overlap,
  };
}

export interface DiagnoseOpts {
  /** The real answerer's k to match production's candidate pool composition
   *  against -- default DEFAULT_PRODUCTION_K (10). Drives BOTH the
   *  production-matched call's limit (`vecKMatchedLimit`) and the rank-ok/
   *  rank-miss boundary itself (rank <= productionK = rank-ok). Pass the
   *  SAME `k` the real run used for its answerer call (run.mts already
   *  threads this through). */
  productionK?: number;
  /** Wide existence-check pool size (default DEFAULT_WIDE_LIMIT) -- used
   *  ONLY to confirm an atom exists somewhere in the project when it's not
   *  found within the production-matched pool; NEVER used to determine
   *  rank-ok/rank-miss (see the file header's "Pool-composition bug,
   *  fixed"). */
  wideLimit?: number;
  threshold?: number;
  /** Minimum precision (hit tokens accounted for by the gold answer) a hit
   *  must ALSO clear when the gold answer is short (see
   *  SHORT_ANSWER_TOKEN_THRESHOLD) -- default DEFAULT_SHORT_ANSWER_MIN_PRECISION. */
  shortAnswerMinPrecision?: number;
  categories?: LoCoMoCategory[];
  /** Mirrors answer.mts's --ready: skip QA for conversations that never
   *  finished distilling within the run's timeout instead of misreading an
   *  empty/partial recall as "not-in-db". */
  readySampleIds?: Set<string>;
  /** #267 fix: when supplied, every record's classification is decided by
   *  `firstQualifyingHitByJudge` instead of plain `firstQualifyingHit` --
   *  see the file header. Omit to reproduce the exact pre-#267
   *  pure-containment behavior byte-for-byte (existing callers, tests, and
   *  CI are unaffected unless they opt in). */
  llm?: LLMProvider;
  judgeTopN?: number;
  judgeMaxCalls?: number;
  judgeWallClockMs?: number;
}

export async function diagnoseRetrieval(
  client: DaemonClientOpts,
  samples: LoCoMoSample[],
  opts: DiagnoseOpts = {},
): Promise<DiagnosisReport> {
  const productionK = opts.productionK ?? DEFAULT_PRODUCTION_K;
  const wideLimit = opts.wideLimit ?? DEFAULT_WIDE_LIMIT;
  const threshold = opts.threshold ?? 0.6;
  const shortAnswerMinPrecision = opts.shortAnswerMinPrecision ?? DEFAULT_SHORT_ANSWER_MIN_PRECISION;
  const categories = new Set(opts.categories ?? DEFAULT_CATEGORIES);
  const matchedLimit = vecKMatchedLimit(productionK);
  const records: DiagnosisRecord[] = [];

  // #267 fix: ONE budget tracker shared across the entire run (not
  // per-record) -- see the file header's "Cost control" paragraph. Absent
  // when opts.llm is not supplied (pure pre-#267 path, zero judge calls
  // possible so a tracker would be dead weight).
  const judgeTopN = opts.judgeTopN ?? DEFAULT_JUDGE_TOP_N;
  const budget = opts.llm
    ? new JudgeBudgetTracker(opts.judgeMaxCalls ?? DEFAULT_JUDGE_MAX_CALLS, opts.judgeWallClockMs ?? DEFAULT_JUDGE_WALL_CLOCK_MS)
    : undefined;

  for (const sample of samples) {
    if (opts.readySampleIds !== undefined && !opts.readySampleIds.has(sample.sample_id)) continue;
    const project = projectIdFor(sample.sample_id);
    for (let i = 0; i < sample.qa.length; i++) {
      const qa: LoCoMoQA = sample.qa[i]!;
      if (isAdversarial(qa.category) || !categories.has(qa.category) || qa.answer === undefined) continue;

      const answerStr = resolveAnswerString(qa.category, qa.answer);
      const gtTokens = stemmedTokens(answerStr);
      if (gtTokens.length === 0) {
        console.warn(`${qaId(sample.sample_id, i)}: gold answer "${answerStr}" stems to zero tokens -- skipping.`);
        continue;
      }

      let judge_calls = 0;
      let judge_failures = 0;
      let judge_capped = false;

      // Call 1: production-matched pool (same vecK as the real k=productionK
      // answerer call). Decides rank-ok/rank-miss with a genuinely
      // apples-to-apples measurement -- see the file header.
      const matchedHits = await recall(client, { text: qa.question, limit: matchedLimit, filters: { project } });
      let matchedFound: { rank: number; overlap: number } | null;
      if (opts.llm && budget) {
        const r = await firstQualifyingHitByJudge(matchedHits, qa.question, answerStr, gtTokens, threshold, shortAnswerMinPrecision, opts.llm, budget, judgeTopN);
        matchedFound = r.found;
        judge_calls += r.judgeCalls;
        judge_failures += r.judgeFailures;
        judge_capped = judge_capped || r.capped;
        // Budget exhausted before this pool was judged at all -- fall back
        // to the plain pre-#267 decision for this pool rather than trust an
        // un-judged `found: null` as a real verdict.
        if (r.capped) matchedFound = firstQualifyingHit(matchedHits, gtTokens, threshold, shortAnswerMinPrecision);
      } else {
        matchedFound = firstQualifyingHit(matchedHits, gtTokens, threshold, shortAnswerMinPrecision);
      }

      let classification: Classification;
      let match_rank: number | null;
      let match_overlap: number | null;
      let rank_verified: boolean;
      let total_hits: number;

      if (matchedFound) {
        classification = matchedFound.rank <= productionK ? 'rank-ok' : 'rank-miss';
        match_rank = matchedFound.rank;
        match_overlap = matchedFound.overlap;
        rank_verified = true;
        total_hits = matchedHits.length;
      } else {
        // Call 2 (fallback only): wide existence pool. Pool-size-invariant
        // existence check -- token containment either finds a matching atom
        // somewhere or it doesn't, regardless of what else is fused around
        // it. A match here is STILL 'rank-miss' (retrieval-side, same
        // opposite-remedies bucket), but rank_verified: false flags that
        // its match_rank is exploratory, not comparable to production.
        const wideHits = await recall(client, { text: qa.question, limit: wideLimit, filters: { project } });
        let wideFound: { rank: number; overlap: number } | null;
        if (opts.llm && budget) {
          const r = await firstQualifyingHitByJudge(wideHits, qa.question, answerStr, gtTokens, threshold, shortAnswerMinPrecision, opts.llm, budget, judgeTopN);
          wideFound = r.found;
          judge_calls += r.judgeCalls;
          judge_failures += r.judgeFailures;
          judge_capped = judge_capped || r.capped;
          if (r.capped) wideFound = firstQualifyingHit(wideHits, gtTokens, threshold, shortAnswerMinPrecision);
        } else {
          wideFound = firstQualifyingHit(wideHits, gtTokens, threshold, shortAnswerMinPrecision);
        }
        total_hits = wideHits.length;
        if (wideFound) {
          classification = 'rank-miss';
          match_rank = wideFound.rank;
          match_overlap = wideFound.overlap;
          rank_verified = false;
        } else {
          classification = 'not-in-db';
          match_rank = null;
          match_overlap = null;
          rank_verified = true; // nothing to distrust -- existence was genuinely ruled out
        }
      }

      records.push({
        qa_id: qaId(sample.sample_id, i),
        sample_id: sample.sample_id,
        category: qa.category,
        question: qa.question,
        answer: answerStr,
        evidence: qa.evidence,
        classification,
        match_rank,
        match_overlap,
        rank_verified,
        short_answer: gtTokens.length <= SHORT_ANSWER_TOKEN_THRESHOLD,
        total_hits,
        judged: opts.llm !== undefined && !judge_capped,
        judge_calls,
        judge_failures,
        judge_capped,
      });
    }
  }

  const judge_summary: JudgeSummary = {
    enabled: opts.llm !== undefined,
    total_calls: budget?.calls ?? 0,
    total_failures: records.reduce((n, r) => n + r.judge_failures, 0),
    capped_records: records.filter(r => r.judge_capped).length,
  };

  return { records, ...computeBreakdown(records), judge_summary };
}

function pct(n: number, total: number): number {
  return total === 0 ? NaN : (n / total) * 100;
}

function breakdownFor(category: LoCoMoCategory | 'overall', name: string, records: DiagnosisRecord[]): CategoryBreakdown {
  const notInDb = records.filter(r => r.classification === 'not-in-db').length;
  const rankMiss = records.filter(r => r.classification === 'rank-miss').length;
  const rankOk = records.filter(r => r.classification === 'rank-ok').length;
  const n = records.length;
  return {
    category, name, n,
    not_in_db: notInDb, rank_miss: rankMiss, rank_ok: rankOk,
    not_in_db_pct: pct(notInDb, n), rank_miss_pct: pct(rankMiss, n), rank_ok_pct: pct(rankOk, n),
    short_answer_n: records.filter(r => r.short_answer).length,
    unverified_rank_n: records.filter(r => !r.rank_verified).length,
  };
}

export function computeBreakdown(records: DiagnosisRecord[]): { per_category: CategoryBreakdown[]; overall: CategoryBreakdown } {
  const perCategory: CategoryBreakdown[] = [];
  for (const c of LOCOMO_CATEGORIES) {
    if (isAdversarial(c)) continue;
    const catRecords = records.filter(r => r.category === c);
    if (catRecords.length === 0) continue;
    perCategory.push(breakdownFor(c, CATEGORY_NAMES[c], catRecords));
  }
  return { per_category: perCategory, overall: breakdownFor('overall', 'overall', records) };
}

export function printBreakdown(report: Pick<DiagnosisReport, 'per_category' | 'overall' | 'judge_summary'>): void {
  console.log('\nRetrieval diagnosis (not-in-db / rank-miss / rank-ok):');
  const row = (b: CategoryBreakdown): string => {
    const flags: string[] = [];
    // Review findings: report short-answer AND unverified-rank records
    // separately rather than fold them silently into the aggregate -- a
    // category whose numbers lean heavily on either bucket is worth
    // spot-checking by hand (filter diagnosis.json's records on
    // `short_answer: true` / `rank_verified: false`).
    if (b.short_answer_n > 0) flags.push(`${b.short_answer_n} short-answer`);
    if (b.unverified_rank_n > 0) flags.push(`${b.unverified_rank_n} unverified-rank`);
    return `\t${String(b.category).padEnd(8)} ${b.name.padEnd(12)} n=${String(b.n).padEnd(4)} ` +
      `not-in-db=${b.not_in_db} (${b.not_in_db_pct.toFixed(0)}%)  ` +
      `rank-miss=${b.rank_miss} (${b.rank_miss_pct.toFixed(0)}%)  ` +
      `rank-ok=${b.rank_ok} (${b.rank_ok_pct.toFixed(0)}%)` +
      (flags.length > 0 ? `  [${flags.join(', ')}]` : '');
  };
  for (const b of report.per_category) console.log(row(b));
  console.log(row(report.overall));
  const js = report.judge_summary;
  if (js.enabled) {
    console.log(
      `\n#267 LLM-judge: ${js.total_calls} calls, ${js.total_failures} failures (fell back to containment per-candidate)` +
      (js.capped_records > 0
        ? `, ${js.capped_records} record(s) hit the shared budget cap and fell back to pure containment -- re-run with a higher --judge-max-calls/--judge-wall-clock-ms for a fully judged split.`
        : ', budget cap never tripped -- every record above was judge-verified.'),
    );
  } else {
    console.log('\n#267 LLM-judge: not used (pass --llm-judge) -- the split above is pure token containment, known to have a ~42% false-negative rate in the not-in-db bucket (see issue #267).');
  }
}

export function writeDiagnosisReport(report: DiagnosisReport, path: string): void {
  writeFileSync(path, JSON.stringify(report, null, 2));
}

// ── CLI entry ────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const samplePath = get('--sample');
  const daemonUrl = get('--daemon-url');
  const token = get('--token');
  const productionK = Number(get('--production-k') ?? String(DEFAULT_PRODUCTION_K));
  const wideLimit = Number(get('--wide-limit') ?? String(DEFAULT_WIDE_LIMIT));
  const threshold = Number(get('--threshold') ?? '0.6');
  const shortAnswerMinPrecision = Number(get('--short-answer-min-precision') ?? String(DEFAULT_SHORT_ANSWER_MIN_PRECISION));
  const categoryArg = get('--category');
  const categories = categoryArg
    ? categoryArg.split(',').map(s => Number(s.trim()) as LoCoMoCategory)
    : undefined;
  const outPath = get('--out') ?? 'diagnosis.json';
  const readyPath = get('--ready');
  const useLlmJudge = args.includes('--llm-judge');
  const judgeProvider = (get('--judge-provider') ?? 'codex-subscription') as 'codex-subscription' | 'ollama';
  const judgeModel = get('--judge-model');
  const judgeTopN = Number(get('--judge-top-n') ?? String(DEFAULT_JUDGE_TOP_N));
  const judgeMaxCalls = Number(get('--judge-max-calls') ?? String(DEFAULT_JUDGE_MAX_CALLS));
  const judgeWallClockMs = Number(get('--judge-wall-clock-ms') ?? String(DEFAULT_JUDGE_WALL_CLOCK_MS));

  if (!samplePath || !daemonUrl || !token) {
    console.error('Usage: bun diagnose-retrieval.mts --sample <path> --daemon-url <url> --token <token> [--production-k 10] [--wide-limit 500] [--threshold 0.6] [--short-answer-min-precision 0.12] [--category 1,2,3,4] [--out diagnosis.json] [--ready <distill-wait-result.json>] [--llm-judge] [--judge-provider codex-subscription] [--judge-model <model>] [--judge-top-n 3] [--judge-max-calls 1200] [--judge-wall-clock-ms 900000]');
    process.exit(1);
  }

  const samples = JSON.parse(readFileSync(samplePath, 'utf8')) as LoCoMoSample[];
  let readySampleIds: Set<string> | undefined;
  if (readyPath) {
    const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as { ready_sample_ids: string[] };
    readySampleIds = new Set(ready.ready_sample_ids);
  }

  const totalQa = samples.reduce((n, s) => n + s.qa.filter(q => !isAdversarial(q.category) && (categories ?? DEFAULT_CATEGORIES).includes(q.category)).length, 0);
  console.log(`Diagnosing ${totalQa} QA pairs across ${samples.length} conversation(s) (production-k=${productionK} -> matched-limit=${vecKMatchedLimit(productionK)}, wide-limit=${wideLimit}, threshold=${threshold}, short-answer-min-precision=${shortAnswerMinPrecision})...`);
  if (useLlmJudge) {
    console.log(`#267 LLM-judge ENABLED: provider=${judgeProvider}${judgeModel ? ` model=${judgeModel}` : ''}, top-n=${judgeTopN}, max-calls=${judgeMaxCalls}, wall-clock-ms=${judgeWallClockMs}`);
  }
  const llm = useLlmJudge ? buildJudgeProvider(judgeProvider, judgeModel) : undefined;

  const report = await diagnoseRetrieval({ baseUrl: daemonUrl, token }, samples, {
    productionK, wideLimit, threshold, shortAnswerMinPrecision, categories, readySampleIds,
    llm, judgeTopN, judgeMaxCalls, judgeWallClockMs,
  });
  writeDiagnosisReport(report, outPath);
  printBreakdown(report);
  console.log(`\nFull per-question detail -> ${outPath}`);
}
