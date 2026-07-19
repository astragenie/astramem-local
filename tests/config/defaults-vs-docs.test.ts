/**
 * FEAT-483 SLICE-6: config-defaults-vs-docs consistency test.
 *
 * Catches the "docs say X, code defaults to Y" drift class — the exact bug
 * behind the FEAT-482 incident, where CLAUDE.md's `DEFAULT_CONTRADICTION_DETECTION`
 * governance-fallback constant (`mode: 'off'`, src/config/config.ts ~1910) was
 * misread as THE shipped default, when `defaultConfig()` actually ships
 * `contradictionDetection.mode: 'enabled'` (config.ts ~1566). A prior agent
 * session read the fallback constant, concluded contradiction detection ships
 * off, and nearly re-shipped a fix for a bug that didn't exist. See CLAUDE.md
 * "Contradiction detection ships `enabled`" for the full incident writeup.
 *
 * ## Why a curated table instead of auto-parsing doc comments
 *
 * Parsing free-form prose out of doc comments (or CLAUDE.md markdown) is
 * brittle: the moment someone rewords a sentence — even without changing the
 * underlying claim — a regex-based extractor breaks or silently stops
 * matching, which produces exactly the false-confidence-then-silent-drift
 * failure mode this test exists to prevent (a green test that no longer
 * checks anything). A hand-curated table is the opposite trade: each row is
 * verified by a human against the live source (`defaultConfig()` or a named
 * exported constant) at write time, cites exactly where the documented claim
 * lives, and is then asserted against the REAL runtime value on every test
 * run. A future PR that changes a default without touching its doc (or vice
 * versa) fails this test immediately and loudly — the failure IS the
 * enforcement, not a parser having to re-discover the claim from prose.
 *
 * A few rows (the four LLM-call sampling temperatures) are not part of the
 * `Config` type at all — they're literal `temperature: N` arguments at their
 * one call site in each stage file. Since there is no exported symbol to
 * import, those rows read the literal directly out of the source file via a
 * narrow, hand-verified regex (confirmed unique — exactly one `temperature:`
 * occurrence — in each of those three files at the time this test was
 * written; see the docSource on each row). This is still reading the actual
 * runtime source, not prose, so it carries the same enforcement guarantee as
 * the `defaultConfig()` rows.
 *
 * If you land here because this test failed: do NOT "fix" it by updating the
 * `documentedDefault` to match whatever the code now does unless you've also
 * confirmed the doc claim was updated (or the code change was deliberate and
 * the doc needs the update). Silently syncing the row without reading the
 * cited doc is exactly the failure this test guards against.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { defaultConfig } from '../../src/config/config.js';
import { NUM_CTX_FLOOR, NUM_CTX_CAP } from '../../src/providers/llm/ollama.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', 'src');

/**
 * Reads the single `temperature: <literal>` call-site argument out of a
 * source file. Throws if the file doesn't contain exactly one match, so an
 * unrelated edit that adds a second `temperature:` call site to one of these
 * files fails LOUD (ambiguous match) rather than silently picking the wrong
 * one.
 */
function readSoleTemperatureLiteral(relPathFromSrc: string): number {
  const text = readFileSync(join(SRC_ROOT, relPathFromSrc), 'utf8');
  const matches = [...text.matchAll(/temperature:\s*(-?\d+(?:\.\d+)?)/g)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one 'temperature:' call site in ${relPathFromSrc}, found ${matches.length} — ` +
        'update readSoleTemperatureLiteral or the docSource row to disambiguate.',
    );
  }
  return Number(matches[0]![1]);
}

interface DriftCase {
  configPath: string;
  documentedDefault: unknown;
  actualDefault: unknown;
  docSource: string;
}

describe('config defaults vs docs consistency (FEAT-483 SLICE-6)', () => {
  const cfg = defaultConfig();

  const cases: DriftCase[] = [
    // --- The incident key itself (FEAT-482) ---
    {
      configPath: 'consolidation.contradictionDetection.mode',
      documentedDefault: 'enabled',
      actualDefault: cfg.consolidation.contradictionDetection.mode,
      docSource:
        "CLAUDE.md 'Contradiction detection ships `enabled`' + config.ts ~1566 doc comment. " +
        "Do NOT confuse with DEFAULT_CONTRADICTION_DETECTION (config.ts ~1910, mode: 'off') — " +
        'that is a governance-fallback constant used only when a config override is missing/invalid, not the shipped default.',
    },
    {
      configPath: 'consolidation.contradictionDetection.maxPerRun',
      documentedDefault: 200,
      actualDefault: cfg.consolidation.contradictionDetection.maxPerRun,
      docSource: "CLAUDE.md 'the live guards are maxPerRun: 200 + maxWallClockMs: 300_000' + config.ts ~1567.",
    },
    {
      configPath: 'consolidation.contradictionDetection.maxWallClockMs',
      documentedDefault: 300_000,
      actualDefault: cfg.consolidation.contradictionDetection.maxWallClockMs,
      docSource: 'CLAUDE.md same paragraph as above + config.ts ~1579 doc comment (5 minutes wall-clock guard).',
    },

    // --- Consolidation / candidate selection (P2.1 stabilization) ---
    {
      configPath: 'consolidation.candidateSelection',
      documentedDefault: 'full',
      actualDefault: cfg.consolidation.candidateSelection,
      docSource:
        "config.ts ~1589 doc comment: \"'full' stays the shipped default — BYTE-IDENTICAL to pre-P2.1 behavior\"; " +
        'confirmed current in docs/research/20260719-doctor-red-triage-0.20.md (knn promotion explicitly soak-gated, deferred to 0.21).',
    },
    {
      configPath: 'consolidation.knnK',
      documentedDefault: 30,
      actualDefault: cfg.consolidation.knnK,
      docSource: "config.ts ~1591 doc comment: \"knnK=30 ... are the P2.1 design's own defaults.\"",
    },
    {
      configPath: 'consolidation.maxCandidatePairsPerRun',
      documentedDefault: null,
      actualDefault: cfg.consolidation.maxCandidatePairsPerRun,
      docSource: 'docs/research/20260719-doctor-red-triage-0.20.md: "maxCandidatePairsPerRun ships null/unbounded".',
    },
    {
      configPath: 'consolidation.autoAcceptThreshold',
      documentedDefault: null,
      actualDefault: cfg.consolidation.autoAcceptThreshold,
      docSource:
        'config.ts ~1541 doc comment: autoAcceptThreshold stays NULL deliberately — no cosine-similarity threshold ' +
        'safely separates a true paraphrase from a one-word-different false merge.',
    },
    {
      configPath: 'consolidation.dupJudge.mode',
      documentedDefault: 'off',
      actualDefault: cfg.consolidation.dupJudge.mode,
      docSource: "config.ts ~1581 doc comment: \"'off' is the shipped default (BYTE-IDENTICAL to pre-FEAT-549 behavior)\".",
    },

    // --- Distill pipeline gates ---
    {
      configPath: 'distill.atomTriage.mode',
      documentedDefault: 'off',
      actualDefault: cfg.distill.atomTriage.mode,
      docSource: "config.ts ~1636 doc comment: FEAT-533 — 'off' shipped default, BYTE-IDENTICAL to pre-FEAT-533 behavior.",
    },
    {
      configPath: 'distill.atomTriage.maxPerRun',
      documentedDefault: 200,
      actualDefault: cfg.distill.atomTriage.maxPerRun,
      docSource: 'config.ts ~1585 doc comment: mirrors contradictionDetection\'s own numeric defaults (maxPerRun=200).',
    },
    {
      configPath: 'distill.atomTriage.maxWallClockMs',
      documentedDefault: 300_000,
      actualDefault: cfg.distill.atomTriage.maxWallClockMs,
      docSource: 'config.ts ~1585 doc comment: mirrors contradictionDetection\'s own numeric defaults (maxWallClockMs=300_000).',
    },
    {
      configPath: 'distill.gatekeeper.mode',
      documentedDefault: 'off',
      actualDefault: cfg.distill.gatekeeper.mode,
      docSource: "config.ts ~1642 doc comment: FEAT-548 — 'off' shipped default, BYTE-IDENTICAL to pre-FEAT-548 behavior.",
    },
    {
      configPath: 'distill.extractionPasses',
      documentedDefault: 2,
      actualDefault: cfg.distill.extractionPasses,
      docSource:
        'config.ts ~1621 doc comment: "extractionPasses: 2 — dual-pass is now the shipped default (2026-07-15, ' +
        'measured LoCoMo full-suite gain 0.4610 -> 0.5549)".',
    },
    {
      configPath: 'distill.durabilityGate',
      documentedDefault: 'lenient',
      actualDefault: cfg.distill.durabilityGate,
      docSource: "config.ts ~1601 doc comment: \"'lenient', not 'off'\" — FEAT-441 gate, eval-backed since 2026-07-13.",
    },
    {
      configPath: 'distill.typeHints',
      documentedDefault: 'on',
      actualDefault: cfg.distill.typeHints,
      docSource:
        'config.ts ~1631 doc comment: FEAT-552 sub-scope B — "\'on\' — shipped default (deterministic, zero-LLM, ' +
        'gold-set-tested, reversible)"; the one distill.* tier that ships on rather than off.',
    },

    // --- Sync (cloud shipper) ---
    {
      configPath: 'sync.batchSize',
      documentedDefault: 25,
      actualDefault: cfg.sync.batchSize,
      docSource:
        "config.ts ~1502 doc comment + commit c7aa6fe \"fix(sync): ship batch default 50 -> 25 — stay under the " +
        'cloud\'s 60s request abort\"; confirmed current in docs/research/20260717-holding-state-ledger.md.',
    },

    // --- Embedding / LLM provider defaults ---
    {
      configPath: 'embedding.provider',
      documentedDefault: 'onnx',
      actualDefault: cfg.embedding.provider,
      docSource: 'config.ts ~1453 doc comment: ADR-018 S4 (2026-07-15) — default flipped ollama -> onnx.',
    },
    {
      configPath: 'llm.compaction.provider',
      documentedDefault: 'codex-subscription',
      actualDefault: cfg.llm.compaction.provider,
      docSource: 'config.ts ~1418 doc comment: v0.18.0 — shipped default switched from local-ollama qwen to codex-subscription.',
    },
    {
      configPath: 'llm.compaction.model',
      documentedDefault: 'gpt-5.4-mini',
      actualDefault: cfg.llm.compaction.model,
      docSource: 'config.ts ~1418 doc comment, same paragraph — codex-subscription DEFAULT_MODEL cheap tier.',
    },

    // --- num_ctx sizing (CLAUDE.md "LLM sampling: num_ctx and temperature") ---
    {
      configPath: 'ollama.ts NUM_CTX_FLOOR (exported constant)',
      documentedDefault: 4096,
      actualDefault: NUM_CTX_FLOOR,
      docSource: "CLAUDE.md: \"floor 4096 — Ollama's observed per-model default; never shrink below it.\"",
    },
    {
      configPath: 'ollama.ts NUM_CTX_CAP (exported constant)',
      documentedDefault: 16384,
      actualDefault: NUM_CTX_CAP,
      docSource: 'CLAUDE.md: "cap 16384 (NUM_CTX_CAP) — VRAM guard... Raise this only with a VRAM measurement."',
    },

    // --- Sampling temperatures (CLAUDE.md table, per-stage literal call sites) ---
    {
      configPath: 'src/distill/stages/04-compact.ts sole `temperature:` call-site literal',
      documentedDefault: 0.1,
      actualDefault: readSoleTemperatureLiteral('distill/stages/04-compact.ts'),
      docSource: 'CLAUDE.md sampling table: "04-compact | 0.1 | src/distill/stages/04-compact.ts".',
    },
    {
      configPath: 'src/entity/extract-entities.ts sole `temperature:` call-site literal',
      documentedDefault: 0.1,
      actualDefault: readSoleTemperatureLiteral('entity/extract-entities.ts'),
      docSource: 'CLAUDE.md sampling table: "entity extraction | 0.1 | src/entity/extract-entities.ts:76".',
    },
    {
      configPath: 'src/consolidate/contradiction-judge.ts sole `temperature:` call-site literal',
      documentedDefault: 0,
      actualDefault: readSoleTemperatureLiteral('consolidate/contradiction-judge.ts'),
      docSource: 'CLAUDE.md sampling table: "contradiction judge | 0 | src/consolidate/contradiction-judge.ts:89".',
    },
  ];

  it.each(cases)(
    '$configPath: documented default matches the live runtime default ($docSource)',
    ({ documentedDefault, actualDefault }) => {
      expect(actualDefault).toEqual(documentedDefault);
    },
  );

  // 05-extract's EXTRACT_TEMPERATURE is env-overridable (ASTRA_EXTRACT_TEMP), so it can't
  // be a plain imported-constant row above — the import would freeze whatever the process
  // env happened to be at module-load time, which could be a leftover value from an
  // unrelated test or CI job. Reset modules and clear the env var so this exercises the
  // documented NO-OVERRIDE default path specifically.
  describe('src/distill/stages/05-extract.ts EXTRACT_TEMPERATURE (env-overridable, no-override case)', () => {
    const envKey = 'ASTRA_EXTRACT_TEMP';
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[envKey];
      delete process.env[envKey];
    });

    afterEach(() => {
      if (saved !== undefined) process.env[envKey] = saved;
      else delete process.env[envKey];
    });

    it('defaults to 0.1 when ASTRA_EXTRACT_TEMP is unset — matches CLAUDE.md sampling table', async () => {
      // EXTRACT_TEMPERATURE is computed once at module load via an IIFE, and this module
      // is very likely already cached from an earlier import elsewhere in the suite. Use
      // a cache-busting dynamic import query so this test observes a fresh evaluation
      // against the env we just cleared, not a stale cached module.
      const modPath: string = '../../src/distill/stages/05-extract.js?defaults-vs-docs-test';
      const mod: { EXTRACT_TEMPERATURE: number } = await import(modPath);
      expect(mod.EXTRACT_TEMPERATURE).toBe(0.1);
    });
  });
});
