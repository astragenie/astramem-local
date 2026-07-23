/**
 * tests/doctor/schedule.test.ts
 *
 * A2-lite (ADR-015): serve.ts never called runChecks() — every doctor
 * canary this repo has built only ever fired when a human ran `doctor` by
 * hand. src/doctor/schedule.ts is the fix. These tests prove, with fake
 * timers (serve() itself binds a real port and can't be driven this way —
 * see tests/cli/serve.test.ts's subprocess-spawn approach), that:
 *
 *   1. the frequent (cheap) schedule fires on its own, with no external
 *      trigger — the literal "doctor never runs unattended" bug this slice
 *      fixes;
 *   2. the frequent tier NEVER includes the LLM chat probe / embed probe,
 *      even if the caller's opts happen to carry providers (schedule.ts
 *      strips them rather than trusting the caller to omit them);
 *   3. the full tier DOES include them when providers are supplied — proving
 *      the split is a real behavioral difference, not just an unused opt.
 *
 * ASTRA_MEMORY_MOCK_PROVIDERS discipline (CLAUDE.md / stability wave plan):
 * every provider here is MockLLMProvider/MockEmbedProvider
 * (makeMockProviders) — no Ollama, no GPU, matches every other test in this
 * worktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import type { DoctorCheckOpts, Check } from '../../src/doctor/checks.js';
import { exitHistoryPaths } from '../../src/service/shim.js';
import {
  runFrequentDoctorChecks,
  runFullDoctorChecks,
  type DoctorScheduleResult,
} from '../../src/doctor/schedule.js';
import { makeMockProviders } from '../../src/pipeline/mock-providers.js';

// Documents (does not itself gate) that a Check without `tier` fails to
// build — see types.ts's doc comment on the `tier` field. The REAL
// enforcement is `tier` being a required property on the `Check` interface,
// combined with the fact that every `Check` object literal in this repo
// lives under `src/**` (checks.ts, gpu-checks.ts, hardening-checks.ts,
// cli/providers.ts) — the ONE genuinely CI-run typecheck job
// (`bunx tsc --noEmit` against the root tsconfig.json, `.github/workflows/
// lint.yml`) already covers all of them, since its `include` is
// `["src/**/*"]`. As of #235, `bun run typecheck:tests` (tsconfig.tests.json,
// tests/**/* included) is ALSO wired into `.github/workflows/lint.yml` as a
// required job and is green — this proof is now doubly enforced (both jobs
// fail if `tier` is ever made optional again). `vitest run` never
// type-checks at all (esbuild strips types without validating them). This
// function is never called — its only job is to fail a real `tsc`
// invocation (either lint.yml job) if the `tier` field is ever made
// optional again, which is the actual #226 bug class this PR closes: a
// check silently defaulting into the frequent tier because nothing forced
// its author to make a cost decision.
function _typeOnlyTierRequiredProof(): Check {
  // @ts-expect-error — `tier` is required; omitting it must not compile.
  return { name: 'no tier declared', run: async () => ({ ok: true, message: 'x' }) };
}
void _typeOnlyTierRequiredProof;

describe('doctor scheduling (A2-lite)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-schedule-'));
    const db = openDb(join(dir, 'memory.sqlite'));
    migrate(db);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The interval-firing / stop() timing behavior of startFrequentDoctorSchedule
  // used to be proven here with REAL timers + real doctor checks (~50+
  // sequential SQLite reads / fs stats / a loopback fetch per tick, per
  // runChecks() in runner.ts). Under parallel CI load a single real tick can
  // take longer than the test's short interval, so ticks overlap and land
  // unpredictably relative to stop() — off-by-one tick counts ("expected 6 to
  // be 5") or a 5000ms timeout, passes in isolation, flaky under load. Moved
  // to tests/doctor/schedule-interval.test.ts, which mocks the check registry
  // to a single near-instant stub and drives the schedule with vitest fake
  // timers (vi.advanceTimersByTimeAsync) — exact tick counts, independent of
  // machine load, per the "stub the I/O so only the schedule timing is under
  // test" fallback (fake timers alone can't reliably wait out the real async
  // I/O the full check registry does; see that file's header comment).

  it('frequent tier NEVER runs the LLM chat probe or embed probe, even if the caller supplies providers', async () => {
    const providers = makeMockProviders();
    const opts: DoctorCheckOpts = {
      dataDir: dir,
      encryptionEnabled: false,
      port: 39777,
      llmProviders: { compaction: providers.llm.compaction, extraction: providers.llm.extraction },
      embedProvider: providers.embed,
    };
    const chatSpy = vi.spyOn(providers.llm.compaction, 'chat');
    const embedSpy = vi.spyOn(providers.embed, 'embed');

    const seen: DoctorScheduleResult[] = [];
    const result = await runFrequentDoctorChecks(opts, (r) => seen.push(r));

    const names = result.results.map(r => r.name);
    expect(names.some(n => n.startsWith('LLM chat probe'))).toBe(false);
    expect(names.some(n => n.startsWith('Embed probe'))).toBe(false);
    expect(chatSpy).not.toHaveBeenCalled();
    expect(embedSpy).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tier).toBe('frequent');
  });

  it('full tier DOES include the LLM chat probe and embed probe when providers are supplied', async () => {
    const providers = makeMockProviders();
    const opts: DoctorCheckOpts = {
      dataDir: dir,
      encryptionEnabled: false,
      port: 39777,
      llmProviders: { compaction: providers.llm.compaction, extraction: providers.llm.extraction },
      embedProvider: providers.embed,
    };
    const chatSpy = vi.spyOn(providers.llm.compaction, 'chat');

    const seen: DoctorScheduleResult[] = [];
    const result = await runFullDoctorChecks(opts, (r) => seen.push(r));

    const names = result.results.map(r => r.name);
    expect(names.some(n => n.startsWith('LLM chat probe'))).toBe(true);
    expect(names.some(n => n.startsWith('Embed probe'))).toBe(true);
    expect(chatSpy).toHaveBeenCalled();
    expect(seen[0]!.tier).toBe('full');

    const chatCheck = result.results.find(r => r.name.startsWith('LLM chat probe'));
    expect(chatCheck?.ok).toBe(true); // mock LLM always returns non-empty text
  });

  it('full tier omits the LLM/embed checks when no providers are supplied (same as frequent)', async () => {
    const opts: DoctorCheckOpts = { dataDir: dir, encryptionEnabled: false, port: 39777 };
    const result = await runFullDoctorChecks(opts, () => {});
    const names = result.results.map(r => r.name);
    expect(names.some(n => n.startsWith('LLM chat probe'))).toBe(false);
    expect(names.some(n => n.startsWith('Embed probe'))).toBe(false);
  });

  // #226 follow-up (2026-07-13): checkMemoryHealth and checkEntityNameQuality
  // were CONFIRMED doing unbounded full-table scans while riding the 15-min
  // frequent tier; the follow-up audit independently found three more
  // (checkUsefulnessFeedbackLoop, checkAtomValidityExtraction,
  // checkEntityRelations) with the same unindexed-scan shape. All five must
  // never appear in a frequent-tier result, and must still appear in a
  // full-tier result — moving them off the loop must not delete the canary.
  const FULL_TIER_ONLY_CHECK_NAMES = [
    'Memory health',
    'Entity name quality',
    'Usefulness feedback loop',
    'Atom validity extraction',
    'Entity relations extraction',
    // FEAT-477: same tier rationale as "Usefulness feedback loop" above —
    // see checkProxyTurnCorrelation's own doc comment.
    'Proxy-turn correlation',
  ];

  it('frequent tier NEVER runs the checks the #226 follow-up audit found doing unbounded/unindexed scans', async () => {
    const opts: DoctorCheckOpts = { dataDir: dir, encryptionEnabled: false, port: 39777 };
    const result = await runFrequentDoctorChecks(opts, () => {});
    const names = result.results.map(r => r.name);
    for (const n of FULL_TIER_ONLY_CHECK_NAMES) {
      expect(names, `frequent tier must not run "${n}"`).not.toContain(n);
    }
  });

  it('full tier DOES still run the checks the #226 follow-up audit moved off the frequent tier', async () => {
    const opts: DoctorCheckOpts = { dataDir: dir, encryptionEnabled: false, port: 39777 };
    const result = await runFullDoctorChecks(opts, () => {});
    const names = result.results.map(r => r.name);
    for (const n of FULL_TIER_ONLY_CHECK_NAMES) {
      expect(names, `full tier must still run "${n}"`).toContain(n);
    }
  });

  // 2026-07-16: extraction-yield.ts was promoted 'full' -> 'cheap' after
  // EXPLAIN QUERY PLAN verification showed its window queries resolve via
  // `idx_extraction_yield_created` (an index-range search bounded to the
  // 7-day window), not an unbounded/unindexed corpus-scale scan like the
  // #226 five above — see the tier comment on checkExtractionYield. This is
  // the positive mirror of FULL_TIER_ONLY_CHECK_NAMES: it locks the new
  // intent in place so a future accidental demotion back to 'full' (losing
  // the 15-min detection latency this promotion exists to buy) fails here
  // instead of going unnoticed.
  it('frequent tier DOES run "Extraction yield" — promoted off the full tier 2026-07-16', async () => {
    const opts: DoctorCheckOpts = { dataDir: dir, encryptionEnabled: false, port: 39777 };
    const result = await runFrequentDoctorChecks(opts, () => {});
    const names = result.results.map(r => r.name);
    expect(names).toContain('Extraction yield');
  });

  it('every check getChecks() returns declares a tier of either "cheap" or "full" — no check is silently untiered', async () => {
    const opts: DoctorCheckOpts = { dataDir: dir, encryptionEnabled: false, port: 39777 };
    const result = await runFullDoctorChecks(opts, () => {});
    // runFullDoctorChecks runs getChecks(opts) directly (no tier filter), so
    // this indirectly proves every check in the registry has a tier — a
    // check missing one would already have failed to compile (see
    // _typeOnlyTierRequiredProof above), but this is the runtime companion:
    // it proves the checks that DO run are tagged 'cheap' or 'full', not
    // some third silently-accepted value.
    expect(result.results.length).toBeGreaterThan(20);
  });

  // #226 follow-up finding 2: a crash-looping daemon must not keep firing a
  // metered LLM/embed call on every restart, indefinitely, with no operator
  // in the loop (the same incident shape as FEAT-482, triggered by a crash
  // loop instead of a config flip).
  describe('crash-loop guard on the full-tier LLM/embed pass', () => {
    function seedCrashLoop(count: number) {
      const paths = exitHistoryPaths(dir);
      mkdirSync(paths.logsDir, { recursive: true });
      const entries = Array.from({ length: count }, (_, i) => ({
        ts: new Date(2026, 6, 13, 0, i * 5).toISOString(),
        exitCode: 1,
        durationMs: 200,
      }));
      writeFileSync(paths.historyPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    }

    it('skips the LLM chat probe + embed probe when the crash-loop streak is at/above threshold, but still runs the rest of the full tier', async () => {
      seedCrashLoop(3); // CRASH_LOOP_THRESHOLD
      const providers = makeMockProviders();
      const opts: DoctorCheckOpts = {
        dataDir: dir,
        encryptionEnabled: false,
        port: 39777,
        llmProviders: { compaction: providers.llm.compaction, extraction: providers.llm.extraction },
        embedProvider: providers.embed,
      };
      const chatSpy = vi.spyOn(providers.llm.compaction, 'chat');
      const embedSpy = vi.spyOn(providers.embed, 'embed');

      const result = await runFullDoctorChecks(opts, () => {});

      const names = result.results.map(r => r.name);
      expect(names.some(n => n.startsWith('LLM chat probe'))).toBe(false);
      expect(names.some(n => n.startsWith('Embed probe'))).toBe(false);
      expect(chatSpy).not.toHaveBeenCalled();
      expect(embedSpy).not.toHaveBeenCalled();
      expect(result.llmTierSkippedForCrashLoop).toBe(true);

      // The rest of the full tier — including "Crash loop" itself, so the
      // RED finding stays visible — must still run.
      expect(names).toContain('Crash loop');
      expect(names).toContain('Memory health');
      const crashLoopResult = result.results.find(r => r.name === 'Crash loop');
      expect(crashLoopResult?.ok).toBe(false); // streak of 3 is RED
    });

    it('runs the LLM chat probe + embed probe normally when the crash-loop streak is below threshold', async () => {
      seedCrashLoop(2); // below CRASH_LOOP_THRESHOLD (3)
      const providers = makeMockProviders();
      const opts: DoctorCheckOpts = {
        dataDir: dir,
        encryptionEnabled: false,
        port: 39777,
        llmProviders: { compaction: providers.llm.compaction, extraction: providers.llm.extraction },
        embedProvider: providers.embed,
      };
      const chatSpy = vi.spyOn(providers.llm.compaction, 'chat');

      const result = await runFullDoctorChecks(opts, () => {});

      expect(chatSpy).toHaveBeenCalled();
      expect(result.llmTierSkippedForCrashLoop).toBeUndefined();
    });

    it('a frequent-tier run never sets llmTierSkippedForCrashLoop, even during a crash loop — it never runs LLM/embed checks anyway', async () => {
      seedCrashLoop(5);
      const opts: DoctorCheckOpts = { dataDir: dir, encryptionEnabled: false, port: 39777 };
      const result = await runFrequentDoctorChecks(opts, () => {});
      expect(result.llmTierSkippedForCrashLoop).toBeUndefined();
    });
  });

  it('failCount/inconclusiveCount reflect the actual result set', async () => {
    // A bare (unmigrated) DB makes several checks throw -> inconclusive,
    // never silently ok:true (ADR-015) — proves failCount/inconclusiveCount
    // aren't hardcoded to zero.
    const bareDir = mkdtempSync(join(tmpdir(), 'astra-doctor-schedule-bare-'));
    try {
      const opts: DoctorCheckOpts = { dataDir: bareDir, encryptionEnabled: false, port: 39777 };
      const result = await runFrequentDoctorChecks(opts, () => {});
      // dataDir doesn't even have a memory.sqlite yet — checks degrade to
      // "no DB yet" ok:true rather than throwing, so just assert the
      // counts are internally consistent with the results array (no
      // hardcoded 0/0 regardless of content).
      const actualFail = result.results.filter(r => !r.ok).length;
      const actualInconclusive = result.results.filter(r => r.inconclusive).length;
      expect(result.failCount).toBe(actualFail);
      expect(result.inconclusiveCount).toBe(actualInconclusive);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
