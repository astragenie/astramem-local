#!/usr/bin/env bun
/**
 * FEAT-485 — evidence-population rate measurement.
 *
 * Measures how often the real extraction stage (src/distill/stages/05-extract.ts,
 * same prompt/schema as production) actually fills in the atom `evidence` field,
 * against the real `qwen3:8b` Ollama model (the current production default —
 * see CLAUDE.md), split by extraction profile (engineering / conversational) and
 * by atom type. Reuses `runDirectPipeline` (lib/pipeline-direct.ts) — the exact
 * same stage functions distillHandler calls in production, minus stage 8
 * (embed+index, not needed to measure a field on the pre-persist atom).
 *
 * Deliberately NOT the Azure judge path — this measures a structural property
 * of the model's raw output (did it fill in one optional JSON field?), not
 * extraction quality, so no LLM-judge call or Azure spend is needed.
 *
 * Usage:
 *   bun scripts/eval/extraction-bench/measure-evidence.mts
 *   bun scripts/eval/extraction-bench/measure-evidence.mts --model qwen3:8b --limit 15
 */
import { loadFixtures, FIXTURES_DIR } from './lib/fixtures.js';
import { runDirectPipeline } from './lib/pipeline-direct.js';
import { OllamaLLMProvider } from '../../../src/providers/llm/ollama.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVERSATIONAL_FIXTURES_DIR = join(HERE, 'fixtures-conversational');

function argVal(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const MODEL = argVal('--model', 'qwen3:8b');
const LIMIT = Number(argVal('--limit', '0')) || undefined; // 0/absent = all fixtures

interface ProfileTally {
  profile: string;
  totalAtoms: number;
  withEvidence: number;
  /** lesson/decision only — the types FEAT-485 proposes making evidence required for. */
  richTypeAtoms: number;
  richTypeWithEvidence: number;
  byType: Record<string, { total: number; withEvidence: number }>;
  fixturesRun: number;
  wallMsTotal: number;
}

function bump(t: ProfileTally, type: string, hasEvidence: boolean) {
  t.totalAtoms++;
  if (hasEvidence) t.withEvidence++;
  if (type === 'lesson' || type === 'decision') {
    t.richTypeAtoms++;
    if (hasEvidence) t.richTypeWithEvidence++;
  }
  const bucket = (t.byType[type] ??= { total: 0, withEvidence: 0 });
  bucket.total++;
  if (hasEvidence) bucket.withEvidence++;
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

async function runProfile(
  profile: 'engineering' | 'conversational',
  fixturesDir: string,
): Promise<ProfileTally> {
  const fixtures = loadFixtures(fixturesDir).slice(0, LIMIT ?? Infinity);
  const tally: ProfileTally = {
    profile,
    totalAtoms: 0,
    withEvidence: 0,
    richTypeAtoms: 0,
    richTypeWithEvidence: 0,
    byType: {},
    fixturesRun: 0,
    wallMsTotal: 0,
  };

  // Same production default for both roles per CLAUDE.md ("qwen3:8b becomes
  // the default Ollama LLM") — isolates "does the extraction PROMPT/model
  // combo fill evidence" as the one variable, matching how the real daemon
  // runs today (compaction and extraction both default to the same model).
  const llmCompaction = new OllamaLLMProvider({ model: MODEL });
  const llmExtraction = new OllamaLLMProvider({ model: MODEL });

  for (const fixture of fixtures) {
    process.stderr.write(`[${profile}] ${fixture.id} ... `);
    const t0 = Date.now();
    try {
      const result = await runDirectPipeline(fixture.turns, {
        llmCompaction,
        llmExtraction,
        extractProfile: profile,
      });
      const ms = Date.now() - t0;
      tally.wallMsTotal += ms;
      tally.fixturesRun++;
      for (const atom of result.atoms) {
        bump(tally, atom.type, typeof atom.evidence === 'string' && atom.evidence.trim().length > 0);
      }
      process.stderr.write(`${result.atoms.length} atoms, ${ms}ms\n`);
    } catch (err) {
      process.stderr.write(`FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return tally;
}

function report(tally: ProfileTally): string {
  const lines: string[] = [];
  lines.push(`## Profile: ${tally.profile} (model=${MODEL})`);
  lines.push(`Fixtures run: ${tally.fixturesRun}, total atoms: ${tally.totalAtoms}, wall time: ${(tally.wallMsTotal / 1000).toFixed(1)}s`);
  lines.push(`Overall evidence population: ${tally.withEvidence}/${tally.totalAtoms} (${pct(tally.withEvidence, tally.totalAtoms)})`);
  lines.push(`lesson+decision evidence population: ${tally.richTypeWithEvidence}/${tally.richTypeAtoms} (${pct(tally.richTypeWithEvidence, tally.richTypeAtoms)})`);
  lines.push('By type:');
  for (const [type, b] of Object.entries(tally.byType).sort()) {
    lines.push(`  ${type}: ${b.withEvidence}/${b.total} (${pct(b.withEvidence, b.total)})`);
  }
  return lines.join('\n');
}

async function main() {
  console.log(`FEAT-485 evidence-population measurement — model=${MODEL}, limit=${LIMIT ?? 'all'}`);
  console.log(`Engineering fixtures dir: ${FIXTURES_DIR}`);
  console.log(`Conversational fixtures dir: ${CONVERSATIONAL_FIXTURES_DIR}\n`);

  const engineering = await runProfile('engineering', FIXTURES_DIR);
  const conversational = await runProfile('conversational', CONVERSATIONAL_FIXTURES_DIR);

  console.log('\n' + report(engineering));
  console.log('\n' + report(conversational));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
