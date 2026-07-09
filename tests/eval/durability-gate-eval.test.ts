// FEAT-441 AC-3 — ADR-005 eval regression floor (gate configured on) +
// junk-pollution fixture proving gated recall@10 beats ungated recall@10.
//
// The eval harness (src/eval/harness.ts's seedEvalCorpus) inserts corpus
// atoms directly via MemoryRepo.insert — it does not route through the
// distill pipeline's embedAndIndex stage 8, so turning
// distill.durabilityGate on in config has no wiring to exercise inside the
// harness itself (same as the existing LLM compact/extract stages, which
// the harness also never touches). The first describe block below proves
// that explicitly: configuring the gate on does not move the existing
// corpus.json/queries.json regression-floor numbers by even a bit, because
// there is nothing for it to intercept.
//
// The second describe block is the actual gate-effectiveness evidence: it
// seeds contracts/fixtures/eval/corpus-junk-pollution.json twice — once
// as-is ("ungated") and once pre-filtered through classifyDurability
// ("gated", simulating what distill.durabilityGate: strict would have
// stopped at persist time) — and shows recall@10 strictly improves.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';
import { classifyDurability } from '../../src/distill/durability-gate.js';
import {
  runRetrievalEval,
  type EvalCorpus,
  type EvalQuerySet,
} from '../../src/eval/harness.js';

const fixturesDir = join(__dirname, '..', '..', 'contracts', 'fixtures', 'eval');

const baseCorpus = JSON.parse(readFileSync(join(fixturesDir, 'corpus.json'), 'utf8')) as EvalCorpus;
const baseQuerySet = JSON.parse(readFileSync(join(fixturesDir, 'queries.json'), 'utf8')) as EvalQuerySet;

const junkCorpus = JSON.parse(readFileSync(join(fixturesDir, 'corpus-junk-pollution.json'), 'utf8')) as EvalCorpus;
const junkQuerySet = JSON.parse(readFileSync(join(fixturesDir, 'queries-junk-pollution.json'), 'utf8')) as EvalQuerySet;

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake-eval',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake-eval', dim: 1024 as const }),
};

describe('AC-3: ADR-005 regression floor holds with distill.durabilityGate: strict configured', () => {
  it('recall@10 / NDCG@10 on the existing corpus are unchanged by the gate config (harness does not route through the persist-time gate)', async () => {
    const db: DB = openDb(':memory:');
    migrate(db);
    const cfgWithGate = { ...defaultConfig(), distill: { durabilityGate: 'strict' as const } };
    const report = await runRetrievalEval(db, fakeEmbed, cfgWithGate.search, baseCorpus, baseQuerySet);

    expect(report.meanRecall).toBeGreaterThanOrEqual(0.9);
    expect(report.meanNdcg).toBeGreaterThanOrEqual(0.7);
  });

  it('is byte-identical to the gate-off baseline (same weights either way — the gate is a persist-time filter, not a ranking input)', async () => {
    const dbOff = openDb(':memory:');
    migrate(dbOff);
    const reportOff = await runRetrievalEval(dbOff, fakeEmbed, defaultConfig().search, baseCorpus, baseQuerySet);

    const dbStrict = openDb(':memory:');
    migrate(dbStrict);
    const cfgWithGate = { ...defaultConfig(), distill: { durabilityGate: 'strict' as const } };
    const reportStrict = await runRetrievalEval(dbStrict, fakeEmbed, cfgWithGate.search, baseCorpus, baseQuerySet);

    expect(reportStrict.meanRecall).toBe(reportOff.meanRecall);
    expect(reportStrict.meanNdcg).toBe(reportOff.meanNdcg);
  });
});

describe('AC-3: junk-pollution fixture — gated recall@10 strictly beats ungated recall@10', () => {
  it('every junk atom in the fixture is classified as ephemeral_state (fixture sanity check)', () => {
    const junkAtoms = junkCorpus.atoms.filter(a => a.id !== '20000000-0000-4000-8000-000000000001');
    expect(junkAtoms.length).toBeGreaterThanOrEqual(10);
    for (const atom of junkAtoms) {
      expect(classifyDurability(atom.text), atom.text).toBe('ephemeral_state');
    }
    // The one durable atom must NOT be gated — it's the fixture's signal.
    const durable = junkCorpus.atoms.find(a => a.id === '20000000-0000-4000-8000-000000000001');
    if (!durable) throw new Error('fixture missing the durable-atom sentinel id 20000000-0000-4000-8000-000000000001');
    expect(classifyDurability(durable.text)).toBeNull();
  });

  it('ungated: the durable atom is buried below rank 10 by lexically-dominant junk (recall@10 == 0)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const report = await runRetrievalEval(db, fakeEmbed, defaultConfig().search, junkCorpus, junkQuerySet);
    const jq1 = report.perQuery.find(r => r.id === 'jq1');
    expect(jq1?.recall).toBe(0);
  });

  it('gated: pre-filtering the same corpus through classifyDurability (simulating distill.durabilityGate: strict at persist time) yields recall@10 == 1', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const gatedCorpus: EvalCorpus = {
      atoms: junkCorpus.atoms.filter(a => classifyDurability(a.text) === null),
    };
    const report = await runRetrievalEval(db, fakeEmbed, defaultConfig().search, gatedCorpus, junkQuerySet);
    const jq1 = report.perQuery.find(r => r.id === 'jq1');
    expect(jq1?.recall).toBe(1);
  });

  it('gated recall@10 is strictly greater than ungated recall@10 on the identical query/corpus content (AC-3)', async () => {
    const dbUngated = openDb(':memory:');
    migrate(dbUngated);
    const ungatedReport = await runRetrievalEval(dbUngated, fakeEmbed, defaultConfig().search, junkCorpus, junkQuerySet);

    const dbGated = openDb(':memory:');
    migrate(dbGated);
    const gatedCorpus: EvalCorpus = {
      atoms: junkCorpus.atoms.filter(a => classifyDurability(a.text) === null),
    };
    const gatedReport = await runRetrievalEval(dbGated, fakeEmbed, defaultConfig().search, gatedCorpus, junkQuerySet);

    const ungatedResult = ungatedReport.perQuery.find(r => r.id === 'jq1');
    const gatedResult = gatedReport.perQuery.find(r => r.id === 'jq1');
    if (!ungatedResult || !gatedResult) throw new Error('jq1 missing from perQuery results');
    expect(ungatedResult.recall).not.toBeNull();
    expect(gatedResult.recall).not.toBeNull();
    expect(gatedResult.recall as number).toBeGreaterThan(ungatedResult.recall as number);
  });
});
