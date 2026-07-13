/**
 * Falsification experiment for the P1-causes-P2 hypothesis.
 *
 * The remediation plan assumed junk atoms may be CAUSING weak semantic recall,
 * and sequenced all retrieval work behind extraction work on that basis. That is
 * exactly the kind of assumption that deserves to be attacked before two days are
 * spent on it.
 *
 * This runs the real recall harness, then re-scores it with junk atoms removed —
 * using the SHIPPED classifier (`classifyDurability`, FEAT-441), not a
 * reimplementation. `distill.durabilityGate` currently defaults to 'off'
 * (config.ts:411), so this simulates what the store would look like had it been
 * on all along, without touching a single row.
 *
 * If plain-English MRR jumps sharply once junk is excluded -> P1 causes P2, and
 * flipping one config flag is most of the fix.
 * If it barely moves -> the semantic weakness is INDEPENDENT, and the plan's
 * sequencing is wrong.
 */
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyDurability } from '../../../dist/distill/durability-gate.js';

// STALE-DIST GUARD. This script imports the compiled classifier from dist/, not
// src/. If dist/ predates a change to the taxonomy, this silently measures the OLD
// classifier and hands back a confidently wrong verdict — which is exactly what
// happened: a reviewer re-ran this, got the PREVIOUS (already-refuted) +0.5pt
// result, and only found the truth after rebuilding by hand. An instrument that
// quietly tests a stale artifact is worse than no instrument.
{
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const src = join(root, 'src', 'distill', 'durability-gate.ts');
  const built = join(root, 'dist', 'distill', 'durability-gate.js');
  const srcAt = statSync(src).mtimeMs;
  const builtAt = statSync(built).mtimeMs;
  if (builtAt < srcAt) {
    console.error('\nREFUSING TO RUN — dist/ is STALE.\n');
    console.error(`  src/distill/durability-gate.ts  modified ${new Date(srcAt).toISOString()}`);
    console.error(`  dist/distill/durability-gate.js  built   ${new Date(builtAt).toISOString()}`);
    console.error('\nThis script would have measured the OLD classifier and reported it as fact.');
    console.error('Run `bun run build` first.\n');
    process.exit(1);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = 'http://127.0.0.1:7777';
const LIMIT = 5;
const { cases } = JSON.parse(readFileSync(join(HERE, 'ground-truth.json'), 'utf8'));

function loadBearer() {
  const p = join(process.env.APPDATA ?? '', 'Astramem', 'secrets.env');
  const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('MEMORY_BEARER='));
  if (!line) throw new Error('MEMORY_BEARER not found');
  return line.slice('MEMORY_BEARER='.length).trim();
}
const BEARER = loadBearer();

/** Ask for a deep page so that, after removing junk, we still have 5 real hits
 *  to rank against. Removing junk from a top-5 without backfilling would flatter
 *  the result by shrinking the list rather than promoting real answers. */
async function search(query, limit) {
  const res = await fetch(`${HOST}/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${BEARER}` },
  });
  if (!res.ok) throw new Error(`${res.status} for ${query}`);
  const body = await res.json();
  return (body.hits ?? []).map((h) => ({ text: h.text ?? '', type: h.type ?? '?' }));
}

const matches = (text, markers) => markers.some((m) => String(text).toLowerCase().includes(String(m).toLowerCase()));
const rankIn = (hits, markers) => {
  for (let i = 0; i < hits.length; i++) if (matches(hits[i].text, markers)) return i + 1;
  return 0;
};

const rows = [];
let gatedTotal = 0;
let seenTotal = 0;

for (const c of cases) {
  // Deep page, then take top-5 twice: once raw, once with gated atoms removed
  // and real hits promoted up to fill the gap.
  const deep = await search(c.plain, 25);
  const raw = deep.slice(0, LIMIT);

  const kept = deep.filter((h) => classifyDurability(h.text) === null);
  const filtered = kept.slice(0, LIMIT);

  const gatedHere = deep.slice(0, LIMIT).filter((h) => classifyDurability(h.text) !== null).length;
  gatedTotal += gatedHere;
  seenTotal += raw.length;

  rows.push({
    id: c.id,
    rawRank: rankIn(raw, c.markers),
    gatedRank: rankIn(filtered, c.markers),
    gatedOutOfTop5: gatedHere,
  });
}

const mrr = (sel) => rows.reduce((a, r) => a + (sel(r) > 0 ? 1 / sel(r) : 0), 0) / rows.length;
const found = (sel) => rows.filter((r) => sel(r) > 0).length;

const rawMrr = mrr((r) => r.rawRank);
const gatedMrr = mrr((r) => r.gatedRank);

console.log('\n=== FALSIFICATION: does removing junk fix semantic recall? ===');
console.log('Junk classified by the SHIPPED gate (FEAT-441, currently durabilityGate: off)\n');
console.log('case                 today   junk-removed   gated-from-top5');
console.log('-'.repeat(70));
for (const r of rows) {
  const a = r.rawRank ? `#${r.rawRank}  ` : 'MISS ';
  const b = r.gatedRank ? `#${r.gatedRank}  ` : 'MISS ';
  console.log(`${r.id.padEnd(20)} ${a}    ${b}          ${r.gatedOutOfTop5}/${LIMIT}`);
}
console.log('-'.repeat(70));
console.log(`\ntoday          : MRR ${rawMrr.toFixed(3)}   found ${found((r) => r.rawRank)}/${rows.length}`);
console.log(`junk removed   : MRR ${gatedMrr.toFixed(3)}   found ${found((r) => r.gatedRank)}/${rows.length}`);
console.log(`gate would remove ${gatedTotal}/${seenTotal} (${((gatedTotal / seenTotal) * 100).toFixed(0)}%) of today's top-5 hits`);

const delta = gatedMrr - rawMrr;
console.log('\n--- VERDICT ---');
if (delta >= 0.15) {
  console.log(`P1 CAUSES P2 — SUPPORTED. Removing junk lifts MRR by +${(delta * 100).toFixed(0)}pts.`);
  console.log('The plan\'s sequencing is right: fix extraction first. And most of the fix is');
  console.log('flipping distill.durabilityGate from "off" to "strict" — a config flag, not a project.');
} else if (delta > 0.03) {
  console.log(`PARTIAL. Removing junk lifts MRR by +${(delta * 100).toFixed(0)}pts — real, but not the whole story.`);
  console.log('Semantic retrieval has an INDEPENDENT weakness. Both must be fixed; do not stop after Phase 1.');
} else {
  console.log(`P1 CAUSES P2 — REFUTED. Removing junk moves MRR by only ${(delta * 100).toFixed(1)}pts.`);
  console.log('The semantic weakness is independent of junk. The plan\'s sequencing is WRONG —');
  console.log('retrieval needs fixing on its own merits, not as a follow-on.');
}
console.log('');
