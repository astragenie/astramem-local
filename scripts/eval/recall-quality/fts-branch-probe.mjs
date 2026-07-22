/**
 * FTS AND/OR branch probe (FEAT-480 instrumentation).
 *
 * The 2nd real-store A/B on the AND-first, OR-fallback design (branch
 * feat/480-fts-or-join) FAILed the same way pure-OR did: literal-MRR
 * regressed and junk-in-top5 rose. The working hypothesis is that AND-first
 * NEVER actually engages on real queries — plain-English and literal-keyword
 * queries alike almost never contain an exact all-tokens phrase match in the
 * store, so the OR fallback fires unconditionally and the two-pass gate
 * degenerates into the same pure-OR behavior that already failed once.
 *
 * This script confirms or refutes that hypothesis directly, and produces the
 * signal-token-coverage histogram needed to size a future coverage-gate
 * threshold (e.g. "prune OR-sourced hits matching only 1 signal token").
 *
 * It does NOT change ranking behavior — read-only against whatever the
 * target daemon is already running.
 *
 * REQUIRES the target daemon to be started with ASTRA_FTS_INSTRUMENT=1 (see
 * src/search/search.ts's FTS_INSTRUMENT_ENV / SearchOpts.ftsProbeSink and
 * src/server/routes/search.ts's GET /search wiring). Without it, GET /search
 * never includes the `_ftsProbe` field and this script has nothing to
 * aggregate — it detects that case and says so rather than silently
 * printing an all-zero report.
 *
 * Usage:  node scripts/eval/recall-quality/fts-branch-probe.mjs [--limit 5] [--host http://127.0.0.1:7777]
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
 * Bearer token, read from the daemon's own secrets.env. Never logged.
 * Copied verbatim from run.mjs's loadBearer() — same daemon, same
 * convention, deliberately not re-derived.
 */
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
  return res.json();
}

const rows = [];
let sawAnyProbe = false;
let andFiredCount = 0;
let orFiredCount = 0;
const coverageHistogram = new Map(); // coverage value -> count of FTS-sourced hits

for (const c of cases) {
  for (const variant of ['plain', 'literal']) {
    const query = c[variant];
    const body = await search(query);
    const probe = body._ftsProbe;
    if (!probe) continue;
    sawAnyProbe = true;

    // The primary query's own gather entry is always index 0 — decompose/
    // rewrite sub-query entries (if those stages are enabled) would follow
    // it, but neither is enabled by default and this harness doesn't turn
    // them on, so [0] is the primary (and normally only) entry.
    const gather = probe.gather?.[0];
    if (gather) {
      if (gather.andRows > 0) andFiredCount++;
      if (gather.orFired) orFiredCount++;
    }

    const coverages = (probe.coverage ?? []).map((h) => h.coverage);
    for (const cov of coverages) {
      coverageHistogram.set(cov, (coverageHistogram.get(cov) ?? 0) + 1);
    }

    rows.push({
      id: c.id,
      variant,
      andRows: gather?.andRows ?? 0,
      orFired: gather?.orFired ?? false,
      orRows: gather?.orRows ?? 0,
      coverages,
    });
  }
}

console.log('\n=== FTS AND/OR BRANCH PROBE (FEAT-480 instrumentation) ===');
console.log(`store: ${HOST}   top-K: ${LIMIT}   queries: ${rows.length} (${cases.length} cases x plain+literal)\n`);

if (!sawAnyProbe) {
  console.log('No `_ftsProbe` field on ANY response — the target daemon is not running with');
  console.log('ASTRA_FTS_INSTRUMENT=1. Restart it with that env var set and re-run this probe.');
  console.log('(Read-only check — no queries were wasted; the daemon just has nothing to report.)\n');
  process.exit(0);
}

console.log('case                 variant   AND-rows  OR-fired  OR-rows  coverage (per FTS-sourced top-K hit)');
console.log('-'.repeat(100));
for (const r of rows) {
  console.log(
    `${r.id.padEnd(20)} ${r.variant.padEnd(9)} ${String(r.andRows).padStart(8)}  ${String(r.orFired).padEnd(8)}  ${String(r.orRows).padStart(7)}  [${r.coverages.join(', ')}]`,
  );
}
console.log('-'.repeat(100));

console.log(`\nAND pass fired (andRows > 0): ${andFiredCount}/${rows.length}`);
console.log(`OR fallback fired:            ${orFiredCount}/${rows.length}`);

console.log('\nSignal-token coverage histogram (FTS-sourced top-K hits, all queries pooled):');
const sortedCoverage = Array.from(coverageHistogram.entries()).sort((a, b) => a[0] - b[0]);
const coverageTotal = sortedCoverage.reduce((a, [, n]) => a + n, 0);
if (sortedCoverage.length === 0) {
  console.log('  (no FTS-sourced hits reached the top-K on any query)');
} else {
  for (const [coverage, count] of sortedCoverage) {
    const bar = '#'.repeat(Math.max(1, Math.round((count / coverageTotal) * 40)));
    console.log(`  coverage=${coverage}: ${String(count).padStart(3)}  ${bar}`);
  }
}

console.log('\n--- VERDICT ---');
if (andFiredCount === 0) {
  console.log('AND pass NEVER fired on any of these real queries — CONFIRMS the hypothesis:');
  console.log('  no query in this corpus has an exact all-tokens phrase match, so the two-pass');
  console.log('  gate degenerates into pure-OR behavior on every single query. AND-first as');
  console.log('  shipped provides zero protection for literal-keyword precision here.');
} else if (andFiredCount < rows.length) {
  console.log(`AND pass fired on ${andFiredCount}/${rows.length} queries — partial engagement.`);
  console.log('  The two-pass gate is doing SOME real work, but the OR fallback still covers');
  console.log(`  the other ${rows.length - andFiredCount} — compare against the junk-rate delta run.mjs`);
  console.log('  measured to see whether that residual OR exposure explains it.');
} else {
  console.log(`AND pass fired on ALL ${rows.length} queries — REFUTES the hypothesis as stated.`);
  console.log('  If literal-MRR still regressed in the A/B, the cause is elsewhere (vector leg');
  console.log('  interaction, fusion weighting) — re-check before assuming this is the root cause.');
}

if (coverageTotal > 0) {
  const coverage1 = coverageHistogram.get(1) ?? 0;
  const pct1 = ((coverage1 / coverageTotal) * 100).toFixed(0);
  console.log(`\n${pct1}% of FTS-sourced top-K hits (${coverage1}/${coverageTotal}) match only 1 signal token —`);
  console.log('  this is exactly the candidate pool a `coverage >= 2` gate would prune. Compare');
  console.log('  against the junk-in-top5 rate run.mjs measures to judge whether that gate would');
  console.log('  clean up the junk without also cutting the plain-English recovery this FEAT');
  console.log('  exists for.');
}
console.log('');
