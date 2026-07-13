/**
 * Recall-quality harness.
 *
 * The question this answers: when a developer asks a plain-English question that
 * one of our stored memories LITERALLY answers, does recall surface it?
 *
 * The experiment is the plain-vs-literal comparison. Every case is run twice —
 * once as a natural question, once as a bag of literal keywords from the memory
 * itself. If literal wins and plain loses, the SEMANTIC half of retrieval is not
 * contributing, and we are effectively running keyword search wearing a semantic
 * costume. That distinction decides whether to spend a week on the embedding
 * model or on the extraction pipeline — so it is worth measuring before either.
 *
 * Also measures JUNK RATE: the fraction of returned hits that are worthless
 * fragments ("$ bun run test") rather than memories. Junk does not just waste a
 * slot — it crowds a real answer out of the top-K an agent actually reads.
 *
 * Usage:  node scripts/eval/recall-quality/run.mjs [--limit 5] [--host http://127.0.0.1:7777]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const HOST = argOf('--host', 'http://127.0.0.1:7777');
const LIMIT = Number(argOf('--limit', '5'));

const { cases } = JSON.parse(readFileSync(join(HERE, 'ground-truth.json'), 'utf8'));

/**
 * Junk = a stored "memory" that carries no reusable knowledge.
 *
 * Two families, and the second is the one that fooled the first draft of this
 * harness:
 *  1. Shell fragments — "$ bun run test". Obviously worthless.
 *  2. TASK ECHOES — "deploy the changes to production", "Orchestrate the review
 *     process...". These are imperative restatements of an instruction someone
 *     gave an agent, not something learned. They are long enough to pass a naive
 *     length filter, and they RANK #1 for real knowledge questions, crowding out
 *     the lesson that actually answers them.
 */
function isJunk(text) {
  const t = String(text).trim();
  if (t.length < 25) return true;
  if (/^\$?\s*(bun|npm|pnpm|yarn|git|node|cd)\b/i.test(t) && t.length < 60) return true;
  // Task echo: starts with a bare imperative verb, i.e. an instruction, not a fact.
  if (/^(configure|run|build|create|add|update|implement|orchestrate|deploy|verify|check|ensure|use|write|fix|set up|install|address|raise)\b/i.test(t)) {
    return true;
  }
  return false;
}

function hitMatches(text, markers) {
  const t = String(text).toLowerCase();
  return markers.some((m) => t.includes(String(m).toLowerCase()));
}

/** Bearer token, read from the daemon's own secrets.env. Never logged. */
function loadBearer() {
  if (process.env.MEMORY_BEARER) return process.env.MEMORY_BEARER;
  const candidates = [
    join(process.env.APPDATA ?? '', 'Astramem', 'secrets.env'),
    join(process.env.HOME ?? '', '.config', 'astra-memory', 'secrets.env'),
  ];
  for (const p of candidates) {
    try {
      const line = readFileSync(p, 'utf8').split('\n').find((l) => l.startsWith('MEMORY_BEARER='));
      if (line) return line.slice('MEMORY_BEARER='.length).trim();
    } catch {
      /* next candidate */
    }
  }
  throw new Error('MEMORY_BEARER not found (env or secrets.env)');
}
const BEARER = loadBearer();

async function search(query) {
  const url = `${HOST}/search?q=${encodeURIComponent(query)}&limit=${LIMIT}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${BEARER}` } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${query}`);
  const body = await res.json();
  const hits = body.hits ?? body.results ?? (Array.isArray(body) ? body : []);
  return hits.map((h) => ({ text: h.text ?? h.content ?? '', score: h.score ?? null, type: h.type ?? '?' }));
}

/** rank of the first correct hit (1-based), or 0 if absent from top-K */
function rankOfFirstCorrect(hits, markers) {
  for (let i = 0; i < hits.length; i++) {
    if (hitMatches(hits[i].text, markers)) return i + 1;
  }
  return 0;
}

const rows = [];
let junkTotal = 0;
let hitsTotal = 0;

for (const c of cases) {
  const plainHits = await search(c.plain);
  const literalHits = await search(c.literal);

  const plainRank = rankOfFirstCorrect(plainHits, c.markers);
  const literalRank = rankOfFirstCorrect(literalHits, c.markers);

  const junk = plainHits.filter((h) => isJunk(h.text)).length;
  junkTotal += junk;
  hitsTotal += plainHits.length;

  rows.push({
    id: c.id,
    plainRank,
    literalRank,
    junkInPlain: junk,
    topPlain: (plainHits[0]?.text ?? '(nothing)').replace(/\s+/g, ' ').slice(0, 62),
  });
}

const found = (r) => r > 0;
const plainFound = rows.filter((r) => found(r.plainRank));
const literalFound = rows.filter((r) => found(r.literalRank));
const mrr = (sel) => rows.reduce((a, r) => a + (found(sel(r)) ? 1 / sel(r) : 0), 0) / rows.length;

console.log('\n=== RECALL QUALITY — plain-English question vs literal keywords ===');
console.log(`store: ${HOST}   top-K: ${LIMIT}   cases: ${rows.length}\n`);
console.log('case                 plain   literal   junk-in-top5   top plain hit');
console.log('-'.repeat(100));
for (const r of rows) {
  const p = r.plainRank ? `#${r.plainRank}   ` : 'MISS ';
  const l = r.literalRank ? `#${r.literalRank}   ` : 'MISS ';
  console.log(
    `${r.id.padEnd(20)} ${p}   ${l}     ${String(r.junkInPlain).padStart(2)}/${LIMIT}          ${r.topPlain}`,
  );
}
console.log('-'.repeat(100));
console.log(`\nplain-English   found in top-${LIMIT}: ${plainFound.length}/${rows.length}   MRR ${mrr((r) => r.plainRank).toFixed(3)}`);
console.log(`literal-keyword found in top-${LIMIT}: ${literalFound.length}/${rows.length}   MRR ${mrr((r) => r.literalRank).toFixed(3)}`);
console.log(`junk rate in plain-English results: ${junkTotal}/${hitsTotal} (${((junkTotal / hitsTotal) * 100).toFixed(0)}%)`);

// MRR, not found-count, is the honest measure: a correct answer buried at #5 is
// one an agent will not read. A found-count of 7/10 can hide a store where the
// right memory is technically present but always outranked by noise.
const plainMrr = mrr((r) => r.plainRank);
const literalMrr = mrr((r) => r.literalRank);
const mrrGap = literalMrr - plainMrr;
const junkPct = (junkTotal / hitsTotal) * 100;

console.log('\n--- VERDICT ---');
if (mrrGap >= 0.15) {
  console.log(`SEMANTIC RETRIEVAL IS UNDERPERFORMING.`);
  console.log(`  Asking in plain English ranks the right answer at MRR ${plainMrr.toFixed(3)}.`);
  console.log(`  Asking with literal keywords ranks it at MRR ${literalMrr.toFixed(3)} (+${(mrrGap * 100).toFixed(0)}%).`);
  console.log(`  ${rows.filter((r) => !r.plainRank && r.literalRank).length} case(s) are INVISIBLE to a natural question but rank #1 on keywords.`);
  console.log('  => An agent that asks a normal question does not reliably get the memory that');
  console.log('     answers it. This is a retrieval problem, not a storage problem.');
} else if (plainMrr < 0.5) {
  console.log('Recall is weak for BOTH query styles — suspect the memories themselves,');
  console.log('or that noise is crowding them out. See the junk rate.');
} else {
  console.log('Plain-English recall is holding up. Retrieval is not the main bottleneck.');
}

if (junkPct > 20) {
  console.log(`\nEXTRACTION IS PRODUCING JUNK: ${junkPct.toFixed(0)}% of returned hits carry no reusable knowledge.`);
  console.log('  Two kinds: shell fragments ("$ bun run test") and TASK ECHOES ("deploy the');
  console.log('  changes to production") — imperative restatements of instructions given to an');
  console.log('  agent, not things learned. They rank #1 for real questions and crowd out the');
  console.log('  lesson that actually answers them.');
  console.log('  => Filter these at extraction time. A memory should be a CLAIM, not a TASK.');
}
console.log('');
