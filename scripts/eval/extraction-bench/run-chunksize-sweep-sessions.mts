/**
 * #273 (WS7) — chunk-size sweep against REAL LoCoMo sessions, cloud-only
 * (codex-subscription for both compaction and extraction — zero GPU/Ollama
 * load, so this can run alongside the concurrent 3-arm Ollama extraction
 * bench without contending for the 8GB card).
 *
 * Unlike run-bench.mts (which is under concurrent use by another workstream
 * tonight and is NOT touched by this script), this is a standalone sibling
 * script: it reuses lib/pipeline-direct.ts's runDirectPipeline (already
 * threaded to honor config.distill.maxChunkChars, see 03-chunk.ts's
 * resolveMaxChunkChars) and the real LoCoMo envelope builder
 * (scripts/eval/locomo/lib/envelope.ts's buildIngestEnvelope) so turns are
 * built EXACTLY the way production ingestion builds them — role: 'user'/
 * 'assistant' with the named speaker prefixed onto the turn text.
 *
 * IMPORTANT CAVEAT discovered while building this: issue #273's own
 * flagship reproduction (conv-26 session_10 / conv-44 session_18, "3122
 * chars / 24 turns, ONE chunk") does NOT reproduce through the real
 * production pipeline — both sessions split into 2 chunks once turns are
 * wrapped in the canonical envelope's role:'user'/'assistant' fields (which
 * DOES match TURN_BOUNDARY_RE, unlike a raw "Caroline: ...\nMelanie: ..."
 * join). This script still tests both flagship sessions (the two named
 * facts are genuinely useful anchors) AND a spread of sessions verified to
 * be genuinely single-chunk at maxChunkChars=3200 in PRODUCTION format
 * (found via a zero-LLM-cost scan of the real chunk() function) — the
 * latter set is the one that actually reflects production risk.
 *
 * Usage:
 *   bun scripts/eval/extraction-bench/run-chunksize-sweep-sessions.mts \
 *     --sizes 3200,2400,1600,1200,800 --model gpt-5.4-mini
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexSubscriptionLLMProvider } from '../../../src/providers/llm/codex-subscription.js';
import { defaultConfig, type Config } from '../../../src/config/config.js';
import { runDirectPipeline } from './lib/pipeline-direct.js';
import { buildIngestEnvelope } from '../locomo/lib/envelope.js';
import type { LoCoMoSample } from '../locomo/lib/types.js';

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const sizes = (get('--sizes') ?? '3200,2400,1600,1200,800').split(',').map(s => Number(s.trim()));
const model = get('--model') ?? 'gpt-5.4-mini';
const outDir = get('--out-dir') ?? join(import.meta.dirname, 'results', `chunksize-sessions-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

const DATASET_PATH = join(import.meta.dirname, '../../..', '.eval-data/locomo/locomo10.json');
const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as LoCoMoSample[];

function getSample(sampleId: string): LoCoMoSample {
  const s = dataset.find(d => d.sample_id === sampleId);
  if (!s) throw new Error(`sample ${sampleId} not found in dataset`);
  return s;
}

// Session selection: the two flagship sessions from issue #273's narrative
// (kept for continuity + known-fact keyword checks below), plus a spread of
// sessions verified genuinely single-chunk at 3200 in PRODUCTION format
// (via scratch/scan-sessions.mts's zero-cost scan against the real chunk()
// function) — different conversations, a range of turn counts.
const SESSIONS: Array<{ sampleId: string; session: number; label: string }> = [
  { sampleId: 'conv-26', session: 10, label: 'conv-26/s10 (flagship: beach-frequency, meteor-shower)' },
  { sampleId: 'conv-44', session: 18, label: 'conv-44/s18 (flagship: dog-bed quote, hiking sunset)' },
  { sampleId: 'conv-47', session: 22, label: 'conv-47/s22 (19 turns, 3196c, genuinely 1 chunk @3200)' },
  { sampleId: 'conv-30', session: 13, label: 'conv-30/s13 (23 turns, 3122c, genuinely 1 chunk @3200)' },
  { sampleId: 'conv-48', session: 20, label: 'conv-48/s20 (26 turns, 3114c, genuinely 1 chunk @3200)' },
  { sampleId: 'conv-43', session: 2, label: 'conv-43/s2 (19 turns, 3080c, genuinely 1 chunk @3200)' },
];

// Known-fact keyword checks for the two flagship sessions — cheap
// (substring match against extracted atom text, no extra LLM calls) recall
// signal for the specific facts issue #273 named as lost.
const KNOWN_FACTS: Record<string, Array<{ label: string; keywords: string[] }>> = {
  'conv-26-10': [
    { label: 'beach-frequency ("once or twice a year")', keywords: ['once or twice a year', 'once a year', 'twice a year'] },
    { label: 'meteor-shower awe ("tiny", "awe of the universe")', keywords: ['tiny', 'awe of the universe', 'meteor shower'] },
  ],
  'conv-44-18': [
    { label: 'dog-bed quote ("Super cozy and comfy")', keywords: ['cozy and comfy', 'super cozy'] },
    { label: 'hiking sunset photo', keywords: ['hike', 'hiking', 'sunset'] },
    { label: 'daily self-care habit', keywords: ['self-care', 'self care'] },
  ],
};

interface SweepRow {
  sampleId: string;
  session: number;
  label: string;
  maxChunkChars: number;
  chunksProcessed: number;
  atomCount: number;
  wallMs: number;
  usageUsd: number;
  atoms: Array<{ type: string; text: string }>;
  factHits: Record<string, boolean>;
}

async function main() {
  const llmCompaction = new CodexSubscriptionLLMProvider({ model });
  const llmExtraction = new CodexSubscriptionLLMProvider({ model });

  const activeSessions = has('--smoke') ? SESSIONS.slice(0, 1) : SESSIONS;
  const activeSizes = has('--smoke') ? [sizes[0] as number] : sizes;

  const rows: SweepRow[] = [];

  for (const size of activeSizes) {
    console.log(`\n=== maxChunkChars=${size} ===`);
    const config: Config = { ...defaultConfig(), distill: { ...defaultConfig().distill, maxChunkChars: size } };

    for (const sess of activeSessions) {
      const sample = getSample(sess.sampleId);
      const envelope = buildIngestEnvelope(sample, sess.session);
      const turns = envelope.turns as Array<{ role: 'user' | 'assistant'; text: string }>;

      process.stdout.write(`  ${sess.label}... `);
      const t0 = Date.now();
      try {
        const result = await runDirectPipeline(turns, { llmCompaction, llmExtraction, config });
        const atoms = result.atoms.map(a => ({ type: a.type, text: a.text }));
        const factKey = `${sess.sampleId}-${sess.session}`;
        const facts = KNOWN_FACTS[factKey] ?? [];
        const factHits: Record<string, boolean> = {};
        for (const f of facts) {
          const hit = atoms.some(a => f.keywords.some(kw => a.text.toLowerCase().includes(kw.toLowerCase())));
          factHits[f.label] = hit;
        }
        rows.push({
          sampleId: sess.sampleId, session: sess.session, label: sess.label,
          maxChunkChars: size, chunksProcessed: result.chunksProcessed,
          atomCount: atoms.length, wallMs: result.wallMs, usageUsd: result.usageUsd,
          atoms, factHits,
        });
        const factSummary = facts.length ? ` [facts: ${facts.map(f => `${factHits[f.label] ? 'HIT' : 'MISS'}`).join(',')}]` : '';
        console.log(`${atoms.length} atoms, ${result.chunksProcessed} chunks, ${result.wallMs}ms${factSummary}`);
      } catch (err) {
        console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        rows.push({
          sampleId: sess.sampleId, session: sess.session, label: sess.label,
          maxChunkChars: size, chunksProcessed: 0, atomCount: 0, wallMs: Date.now() - t0, usageUsd: 0,
          atoms: [], factHits: {},
        });
      }
    }
  }

  writeFileSync(join(outDir, 'results.json'), JSON.stringify(rows, null, 2));

  // Markdown summary.
  const lines: string[] = [];
  lines.push('# #273 chunk-size sweep — real LoCoMo sessions (codex-subscription)', '');
  lines.push(`Model: ${model} (compaction + extraction, both cloud). Sizes: ${sizes.join(', ')}.`, '');
  lines.push('| Session | maxChunkChars | chunks | atoms | wallMs | facts recovered |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const factCells = Object.entries(r.factHits).map(([k, v]) => `${v ? '✅' : '❌'} ${k}`).join('; ');
    lines.push(`| ${r.sampleId}/s${r.session} | ${r.maxChunkChars} | ${r.chunksProcessed} | ${r.atomCount} | ${r.wallMs} | ${factCells || '—'} |`);
  }

  lines.push('', '## Per-session yield curve (atoms vs. maxChunkChars)', '');
  const bySession = new Map<string, SweepRow[]>();
  for (const r of rows) {
    const key = `${r.sampleId}/s${r.session}`;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(r);
  }
  for (const [key, sessRows] of bySession) {
    sessRows.sort((a, b) => b.maxChunkChars - a.maxChunkChars);
    lines.push(`**${key}**: ${sessRows.map(r => `${r.maxChunkChars}→${r.atomCount}atoms/${r.chunksProcessed}chunks`).join('  |  ')}`);
  }

  const totalCalls = rows.reduce((s, r) => s + r.chunksProcessed * 2, 0); // compact + extract per chunk
  const totalUsd = rows.reduce((s, r) => s + r.usageUsd, 0);
  lines.push('', `## Cost`, '', `Total extraction runs: ${rows.length}. Total chunk-level LLM calls (compact+extract): ~${totalCalls}. Total usageUsd reported: $${totalUsd.toFixed(4)} (codex-subscription — quota-metered, not per-token billed the same way; usageUsd may read 0).`);

  writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
  console.log(`\nWrote ${join(outDir, 'results.json')} and report.md`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
