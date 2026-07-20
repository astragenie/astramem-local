/**
 * `gold-atoms` — runs the REAL distill EXTRACTOR (05-extract.ts's `extract()`)
 * over ONLY the gold turns cited by a question's `qa.evidence[]`, and returns
 * the resulting atoms as evidence. Needs no pre-ingested store (`needsStore:
 * false`) — extraction happens directly, in-process, per question.
 *
 * WHAT THIS ISOLATES (see harness.mts's header for the full factorial
 * rationale): `gold-turns` (a sibling source, perfect raw evidence verbatim)
 * vs `gold-atoms` (this file, perfect evidence THROUGH the extractor) isolates
 * how much the EXTRACTION stage itself throws away — holding retrieval and
 * evidence-sufficiency constant (both sources see the exact same gold turns),
 * the only variable is "raw text" vs "extracted atoms".
 *
 * ── Provider resolved: codex-subscription / gpt-5.4-mini ──────────────────
 *
 * Matches `docs/eval-runs/BASELINE-CONSTANTS.md`'s "default LLM:
 * codex-subscription / gpt-5.4-mini (both stages)" — the same extractor
 * `scripts/eval/locomo/run.mts` uses for every scored LEDGER.md run. Reusing
 * the SAME provider (not a cheaper/local stand-in) is deliberate: a different
 * extractor here would confound "what does extraction throw away" with "what
 * does a WEAKER extractor throw away", defeating the whole point of this
 * factorial cell (per this repo's dispatch note). Override the model via
 * `ASTRA_LOCOMO_EXTRACT_MODEL` (mirrors `oracle/answerers/current.mts`'s
 * `ASTRA_LOCOMO_ANSWER_*` env-knob convention) if the catalog drifts.
 *
 * `extractProfile: 'conversational'` — LoCoMo is personal/conversational
 * transcript data, not engineering sessions; this is the profile
 * `BASELINE-CONSTANTS.md`'s champion/service-day numbers were measured under
 * (`resolveExtractionPrompt` picks `EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL`
 * by default for this profile, same as the real run.mts path, and still
 * honors `ASTRA_EXTRACT_PROMPT=conv-liberal` if the caller sets it — that env
 * read lives inside `extractChunk` itself, nothing extra needed here).
 *
 * ── Deviations from the real pipeline's extraction path (documented,
 *    deliberate) ─────────────────────────────────────────────────────────
 *
 * 1. NO 04-compact stage. Real ingest compacts each chunk before extraction;
 *    this source extracts directly off the (cleaned) gold-turn text. Running
 *    compaction here would blend "what compaction throws away" into this
 *    cell's number, defeating the "isolate extraction only" purpose stated
 *    above — `docs/eval-runs/BASELINE-CONSTANTS.md` also already runs the
 *    real benchmark's codex configs with `compaction: never`, so skipping it
 *    here is consistent with the tuned baseline, not a divergence from it.
 * 2. NO 06-reduce / 07-memory-normalize / temporal `groundAtomDates`. Those
 *    stages dedup across a WHOLE session's chunks and run a SECOND LLM call
 *    to resolve relative dates in already-extracted atom text — genuine
 *    pipeline stages, but downstream of "the extractor" this rung measures.
 *    Atoms are returned exactly as `extract()` yields them.
 * 3. Single-anchor date grounding. Real ingest is one call per SESSION (one
 *    `capturedAtMs` anchor each). Gold turns for one question can span
 *    MULTIPLE sessions (cat-1 multi-hop) with different dates — this source
 *    threads the MOST RECENT matched session's date as the `extractChunk`
 *    "Observation date" anchor (mirrors what a real single-session call would
 *    see for that session), and additionally inlines a `[Date: YYYY-MM-DD]`
 *    marker before each session's own turn block in the assembled transcript
 *    so an earlier-session turn is never silently mis-dated to the anchor.
 * 4. No chunking (03-chunk). A gold-evidence assembly is always small
 *    (a handful of turns) — sent as ONE chunk to `extract()`, never split.
 *
 * Turn formatting mirrors `scripts/eval/locomo/lib/envelope.ts`'s
 * `buildIngestEnvelope` exactly (role derived from `speaker_a`/`speaker_b`,
 * speaker NAME baked into the turn text, image turns get the `[shares
 * <blip_caption>]` suffix) — the same real-ingest turn shape is then run
 * through `flattenTranscriptContent` (`src/distill/flatten-turns.ts`), the
 * ACTUAL function `distillHandler` calls on every real ingest, rather than a
 * bespoke reimplementation of its `role: text` joining.
 *
 * A question whose gold evidence resolves to zero matched turns, or whose
 * extraction genuinely yields zero atoms, returns `[]` — a real oracle
 * result (see harness.mts's `EvidenceSource` doc comment), never an error.
 * An LLM-call failure (network, auth, transient parse failure) is retried
 * once, then logged and treated the same way: this is a long factorial run
 * over ~every cat1-4 question, and one flaky cell must not crash the whole
 * invocation — `BudgetExceeded` is the one exception, since that signals a
 * real operational problem the caller needs to see, not a per-question
 * evidence outcome.
 *
 * `EvidenceSource.id` MUST equal the filename stem — this file's id is
 * `gold-atoms`, matching `gold-atoms.mts`.
 */
import { Database as BunSqliteDatabase } from 'bun:sqlite';
import type { DB } from '../../../../../src/storage/db.js';
import type { LLMProvider } from '../../../../../src/contracts/index.js';
import { CodexSubscriptionLLMProvider } from '../../../../../src/providers/llm/codex-subscription.js';
import { BudgetTracker, BudgetExceeded } from '../../../../../src/budget/tracker.js';
import { extract, type Atom, type ExtractProfile } from '../../../../../src/distill/stages/05-extract.js';
import { cleanup } from '../../../../../src/distill/stages/01-cleanup.js';
import { flattenTranscriptContent } from '../../../../../src/distill/flatten-turns.js';
import type { EvidenceSource, EvidenceContext, QA } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import type { LoCoMoSample } from '../../lib/types.js';
import { sessionNumbers } from '../../lib/types.js';
import { parseLocomoDateTime } from '../../lib/dates.js';

// ── Provider / budget (module-level singletons — one extractor instance,
// one throwaway in-memory budget ledger, shared across every question this
// process answers) ──────────────────────────────────────────────────────

const EXTRACT_MODEL = process.env.ASTRA_LOCOMO_EXTRACT_MODEL ?? 'gpt-5.4-mini';
const EXTRACT_PROFILE: ExtractProfile = 'conversational';
// Generous — codex-subscription is quota-metered (usage.usd reads ~0 per
// call), not per-token billed the same way; this cap exists as a structural
// safety net, not a real spend limit. Mirrors pipeline-direct.ts's identical
// rationale for its own capUsd default.
const EXTRACT_CAP_USD = 50;
const MAX_EXTRACT_ATTEMPTS = 2;
const DEBUG = process.env.ASTRA_GOLD_ATOMS_DEBUG === '1';

let providerSingleton: LLMProvider | undefined;
function getProvider(): LLMProvider {
  if (!providerSingleton) providerSingleton = new CodexSubscriptionLLMProvider({ model: EXTRACT_MODEL });
  return providerSingleton;
}

/** Throwaway in-memory budget ledger — see
 *  scripts/eval/extraction-bench/lib/pipeline-direct.ts's `makeBudgetDb` for
 *  the full "why bun:sqlite, not better-sqlite3" rationale (this whole eval
 *  toolchain runs under `bun`, and `better-sqlite3`/multiple-ciphers is not
 *  supported there). Duplicated here rather than imported since that helper
 *  is module-private to pipeline-direct.ts. */
let budgetSingleton: BudgetTracker | undefined;
function getBudgetTracker(): BudgetTracker {
  if (!budgetSingleton) {
    const db = new BunSqliteDatabase(':memory:');
    db.exec(`CREATE TABLE budget_spend (day TEXT PRIMARY KEY, usd_total REAL NOT NULL, calls INTEGER NOT NULL)`);
    budgetSingleton = new BudgetTracker(db as unknown as DB);
  }
  return budgetSingleton;
}

// ── dia_id -> gold-turn -> transcript assembly (no LLM — unit-verifiable) ──

export interface AssembledTranscript {
  /** Empty string when no evidence dia_id matched any turn in the
   *  conversation — a degenerate-but-valid case (data mismatch or a
   *  genuinely evidence-free question), handled by the caller as zero hits. */
  text: string;
  /** ISO calendar date (`YYYY-MM-DD`) of the MOST RECENT session that
   *  contributed a matched turn — see this file's header, deviation #3.
   *  `undefined` only if no turn matched at all. */
  sessionDateIso?: string;
}

/**
 * Resolves `qa.evidence[]` (e.g. `["D1:3", "D1:7"]`) to the actual
 * `LoCoMoTurn`s across the WHOLE conversation (evidence can span sessions —
 * cat-1 multi-hop), grouped by session in ascending session-number order,
 * and assembles them into one small transcript using the real ingest turn
 * shape (`lib/envelope.ts`'s `buildIngestEnvelope` convention) run through
 * the real `flattenTranscriptContent` — see this file's header for the full
 * rationale. Exported (not just used internally) so it can be exercised
 * without any LLM/network dependency.
 */
export function assembleGoldTranscript(sample: LoCoMoSample, evidenceIds: readonly string[]): AssembledTranscript {
  const evidenceSet = new Set(evidenceIds);
  const speakerA = sample.conversation.speaker_a;
  const blocks: string[] = [];
  let sessionDateIso: string | undefined;

  for (const n of sessionNumbers(sample.conversation)) {
    const turns = sample.conversation[`session_${n}`];
    const dateTimeRaw = sample.conversation[`session_${n}_date_time`];
    if (turns === undefined) continue;

    const matched = turns.filter(t => evidenceSet.has(t.dia_id));
    if (matched.length === 0) continue;

    const dateIso = dateTimeRaw !== undefined ? parseLocomoDateTime(dateTimeRaw).slice(0, 10) : undefined;
    if (dateIso) sessionDateIso = dateIso; // sessions are visited ascending -> last write is the most recent

    // Same role-derivation + speaker-name-in-text convention buildIngestEnvelope
    // uses for the real LoCoMo ingest path (lib/envelope.ts) -- kept identical
    // so this source sees exactly the text shape a real ingested session
    // would produce, then run through the SAME flattenTranscriptContent()
    // distillHandler calls on every real ingest (src/distill/flatten-turns.ts)
    // rather than a bespoke reimplementation of its `role: text` joining.
    const turnsForFlatten = matched.map(t => ({
      role: t.speaker === speakerA ? 'user' : 'assistant',
      text: t.blip_caption ? `${t.speaker}: ${t.text} [shares ${t.blip_caption}]` : `${t.speaker}: ${t.text}`,
    }));
    const flattened = flattenTranscriptContent(JSON.stringify(turnsForFlatten));
    blocks.push(dateIso ? `[Date: ${dateIso}]\n${flattened}` : flattened);
  }

  if (blocks.length === 0) return { text: '' };
  return { text: cleanup(blocks.join('\n\n')), sessionDateIso };
}

// ── Extraction (LLM — retried, never throws for a stochastic failure) ─────

async function extractAtomsForTranscript(text: string, sessionDateIso: string | undefined, logLabel: string): Promise<Atom[]> {
  if (DEBUG) {
    console.error(`[gold-atoms] assembled transcript for ${logLabel} (sessionDateIso=${sessionDateIso ?? 'none'}):\n${text}`);
  }
  const budget = getBudgetTracker();

  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
    try {
      const results = await extract(
        [{ index: 0, text }],
        getProvider(),
        budget,
        EXTRACT_CAP_USD,
        EXTRACT_PROFILE,
        1,
        undefined,
        sessionDateIso,
      );
      return results.flatMap(r => r.atoms);
    } catch (err) {
      // BudgetExceeded is a real operational problem (cap misconfigured, or
      // genuinely exhausted) -- never swallow it as "this question has zero
      // evidence", unlike a stochastic parse failure below.
      if (err instanceof BudgetExceeded) throw err;
      console.warn(
        `[gold-atoms] extraction attempt ${attempt}/${MAX_EXTRACT_ATTEMPTS} failed for ${logLabel}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.warn(
    `[gold-atoms] extraction exhausted ${MAX_EXTRACT_ATTEMPTS} attempt(s) for ${logLabel} -- ` +
    `treating as zero atoms (a real oracle result for this question, not a crash of the run).`,
  );
  return [];
}

// ── EvidenceSource ──────────────────────────────────────────────────────

/** Memoized by `${sampleId}::${sorted evidence dia_ids}` so questions that
 *  cite the exact same gold turns (common when several questions are
 *  grounded in the same session excerpt) extract once, not once per
 *  question -- both a cost saving and a determinism guard (repeat calls to a
 *  stochastic extractor would otherwise vary). Caches the in-flight PROMISE,
 *  not just the resolved value, so concurrent callers (the harness runs
 *  cells at concurrency=8 by default) dedupe the actual LLM call too. */
const extractionCache = new Map<string, Promise<Atom[]>>();

async function hitsFor(qa: QA, sampleId: string, ctx: EvidenceContext): Promise<SearchHit[]> {
  if (qa.evidence.length === 0) return [];

  const sample = ctx.dataset.find(s => s.sample_id === sampleId);
  if (!sample) throw new Error(`gold-atoms: sample "${sampleId}" not found in ctx.dataset`);

  const cacheKey = `${sampleId}::${[...qa.evidence].sort().join(',')}`;

  let pending = extractionCache.get(cacheKey);
  if (!pending) {
    pending = (async (): Promise<Atom[]> => {
      const { text, sessionDateIso } = assembleGoldTranscript(sample, qa.evidence);
      if (!text.trim()) return []; // evidence dia_ids resolved to nothing -- degenerate but valid
      return extractAtomsForTranscript(text, sessionDateIso, cacheKey);
    })();
    extractionCache.set(cacheKey, pending);
  }

  const atoms = await pending;
  return atoms.map((atom, i) => ({
    id: `gold-atoms:${cacheKey}:${i}`,
    type: atom.type,
    text: atom.text,
    score: 1,
    source: 'gold-atoms',
  }));
}

const goldAtoms: EvidenceSource = {
  id: 'gold-atoms',
  needsStore: false,
  hitsFor,
};

export default goldAtoms;
