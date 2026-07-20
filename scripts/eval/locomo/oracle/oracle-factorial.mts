/**
 * CLI entry for the oracle-factorial harness (see harness.mts's header for
 * the full design rationale). Loads one sampled conversation, resolves the
 * selected (source × answerer) grid via glob discovery, optionally mounts a
 * store daemon on an EXISTING pre-ingested `--datadir` (resume path — no
 * re-ingest), drives every cell, judges it (token-F1 always, llm-judge by
 * default), and writes `factorial.json` + `factorial.md` + a LEDGER-row
 * line to stdout.
 *
 * bun scripts/eval/locomo/oracle/oracle-factorial.mts
 *   [--dataset <path>] [--conv <sample_id>] [--k 15]
 *   [--sources a,b] [--answerers x,y]
 *   [--datadir <path>] [--out <dir>] [--limit-questions <n>]
 *   [--no-llm-judge]
 *
 * --sources/--answerers (comma-separated ids): omit either to select every
 * discovered module whose id does NOT start with `_` (harness.mts's
 * `defaultSelection`). Discovery is a glob over oracle/sources/*.mts and
 * oracle/answerers/*.mts — see harness.mts's header for the full mechanism;
 * there is no registry to edit when adding a new file.
 *
 * --datadir defaults to the most recent scored baseline's pre-ingested
 * store (`.eval-data/locomo/runs/20260720-baseline-v2/datadir/`) so a
 * retrieval-backed source has real ingested memories to query without
 * re-running ingest+distill. Only mounted (spawn-daemon resume path: same
 * datadir, a FRESH random bearer token, no ingestConversations call) when at
 * least one SELECTED source declares `needsStore: true` — gold-turn-only
 * runs (e.g. the default smoke, `_reference-noop` x `current`) never touch
 * it.
 *
 * --llm-judge is accepted for symmetry with judge.mts's flag name but is
 * effectively always-on (the v2 plan mandates reporting both F1 and
 * llm-judge on every cell, see harness.mts's header) — use --no-llm-judge
 * to opt out for a token-F1-only pass (e.g. no Azure creds available).
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadDataset, ensureDatasetDownloaded, sampleLocomo } from '../lib/dataset.js';
import type { LoCoMoSample } from '../lib/types.js';
import { resolveAzureConfig } from '../../shared/config.js';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  type DaemonHandle, type IsolatedEvalEnv,
} from '../../shared/spawn-daemon.js';
import type { DaemonClientOpts } from '../../shared/daemon-client.js';
import {
  discoverSources, discoverAnswerers, defaultSelection, runOracleFactorial,
  buildFactorialMarkdown, buildLedgerRow, type EvidenceSource, type Answerer, type CellResult,
} from './harness.mts';

const DEFAULT_DATADIR = join('.eval-data', 'locomo', 'runs', '20260720-baseline-v2', 'datadir');

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  await main();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const datasetPath = get('--dataset') ?? join('.eval-data', 'locomo', 'locomo10.json');
  const convFlag = get('--conv');
  const k = Number(get('--k') ?? '15');
  const datadir = get('--datadir') ?? DEFAULT_DATADIR;
  const outDir = get('--out') ?? join('.eval-data', 'locomo', 'oracle', new Date().toISOString().replace(/[:.]/g, '-'));
  const limitQuestionsRaw = get('--limit-questions');
  const limitQuestions = limitQuestionsRaw !== undefined ? Number(limitQuestionsRaw) : undefined;
  const llmJudge = !has('--no-llm-judge');
  // P2 retrieval overhaul (2026-07-20, WT-B): --rerank off|onnx toggles the
  // sandbox daemon's crossEncoder config via makeIsolatedEvalEnv's existing
  // additive override (spawn-daemon.ts) — no src/ change needed to A/B the
  // real in-process cross-encoder reranker against the un-reranked baseline.
  // Omitting the flag (or --rerank off) writes byte-identical config to
  // before this flag existed (defaultConfig()'s crossEncoder.enabled: false).
  const rerankFlag = get('--rerank') ?? 'off';
  if (rerankFlag !== 'off' && rerankFlag !== 'onnx') {
    console.error(`--rerank must be "off" or "onnx", got "${rerankFlag}"`);
    process.exit(1);
  }

  const sourceMap = await discoverSources();
  const answererMap = await discoverAnswerers();

  function resolveSelection<T extends { id: string }>(flagValue: string | undefined, map: Map<string, T>, label: string): string[] {
    const ids = flagValue !== undefined
      ? flagValue.split(',').map(s => s.trim()).filter(Boolean)
      : defaultSelection(map);
    for (const id of ids) {
      if (!map.has(id)) {
        console.error(`Unknown ${label} "${id}". Discovered: ${[...map.keys()].join(', ') || '(none)'}`);
        process.exit(1);
      }
    }
    return ids;
  }

  const selectedSourceIds = resolveSelection(get('--sources'), sourceMap, 'source');
  const selectedAnswererIds = resolveSelection(get('--answerers'), answererMap, 'answerer');
  if (selectedSourceIds.length === 0) {
    console.error(`No sources selected and none discovered under oracle/sources/*.mts.`);
    process.exit(1);
  }
  if (selectedAnswererIds.length === 0) {
    console.error(`No answerers selected and none discovered under oracle/answerers/*.mts.`);
    process.exit(1);
  }
  const selectedSources: EvidenceSource[] = selectedSourceIds.map(id => sourceMap.get(id)!);
  const selectedAnswerers: Answerer[] = selectedAnswererIds.map(id => answererMap.get(id)!);
  console.log(`Sources: ${selectedSourceIds.join(', ')}`);
  console.log(`Answerers: ${selectedAnswererIds.join(', ')}`);

  const { downloaded } = await ensureDatasetDownloaded(datasetPath);
  console.log(downloaded ? `Downloaded LoCoMo dataset -> ${datasetPath}` : `Using existing dataset at ${datasetPath}`);
  const dataset = loadDataset(datasetPath);
  // Default --conv: "conv-1" is docs/eval-runs' colloquial shorthand for the
  // deterministic seed=42, n=1 sample (see LEDGER.md's "conv-1, n=199" rows)
  // -- NOT a literal sample_id (the raw dataset's ids are e.g. "conv-26").
  // Resolving it the same way run.mts's sampler does keeps this default
  // aligned with the pre-ingested --datadir default (which was built from
  // that exact sample) and with every other conv-1-scale number in the
  // ledger.
  const convId = convFlag ?? sampleLocomo(dataset, { n: 1, seed: 42 })[0]!.sample_id;
  const sample = dataset.find(s => s.sample_id === convId);
  if (!sample) {
    console.error(`--conv ${convId}: not found. Available sample_ids: ${dataset.map(s => s.sample_id).join(', ')}`);
    process.exit(1);
    return;
  }
  const selectedDataset: LoCoMoSample[] = [sample];
  console.log(`Conversation: ${convId} (${sample.qa.length} QA pairs total, cat1-4 subset used by the driver).`);

  const needsStore = selectedSources.some(s => s.needsStore);
  let daemonHandle: DaemonHandle | undefined;
  let isolatedEnv: IsolatedEvalEnv | undefined;
  let daemonClient: DaemonClientOpts | undefined;

  if (needsStore) {
    if (!existsSync(datadir)) {
      console.error(
        `--datadir ${datadir} does not exist -- a selected source declares needsStore:true and needs an ` +
        `already-ingested datadir (produced by scripts/eval/locomo/run.mts). Ingest one first or pass --datadir.`,
      );
      process.exit(1);
      return;
    }
    const token = randomBytes(32).toString('hex');
    // Resume path (mirrors run.mts's runShard `resume: true` branch): a
    // FRESH isolated config sandbox (models/security overrides only —
    // never touches the operator's real config dir, see spawn-daemon.ts's
    // fail-closed isolation guard) pointed at the EXISTING datadir. No
    // ingestConversations call — the store is already populated.
    isolatedEnv = makeIsolatedEvalEnv('oracle-factorial', rerankFlag === 'onnx'
      ? { crossEncoder: { enabled: true, provider: 'onnx' } }
      : undefined);
    daemonHandle = await spawnEvalDaemon({ dataDir: datadir, token, env: isolatedEnv.env });
    await waitForHealthStatus(daemonHandle.baseUrl, ['ok'], 60_000);
    daemonClient = { baseUrl: daemonHandle.baseUrl, token };
    console.log(`Mounted store daemon on ${datadir} -> ${daemonHandle.baseUrl}`);
  } else {
    console.log('No selected source needs a store -- skipping daemon mount.');
  }

  try {
    const azureCfg = resolveAzureConfig();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'sample.json'), JSON.stringify(selectedDataset, null, 2));

    const cells: CellResult[] = await runOracleFactorial({
      dataset: selectedDataset,
      sources: selectedSources,
      answerers: selectedAnswerers,
      azureCfg,
      daemonClient,
      k,
      outDir,
      llmJudge,
      limitQuestions,
    });

    const md = buildFactorialMarkdown(cells);
    writeFileSync(join(outDir, 'factorial.md'), md);
    console.log(`\n${md}`);

    writeFileSync(
      join(outDir, 'factorial.json'),
      JSON.stringify({ generated_at: new Date().toISOString(), conv: convId, k, datadir: needsStore ? datadir : null, cells }, null, 2),
    );
    console.log(`\nfactorial.json/.md -> ${outDir}`);

    const n = cells[0]?.f1.n_total ?? 0;
    const ledgerRow = buildLedgerRow({
      name: `oracle-factorial-${convId}`,
      cells,
      n,
      extraParams: `datadir=${needsStore ? datadir : 'none'} k=${k}`,
    });
    console.log('\nLEDGER row (paste into docs/eval-runs/LEDGER.md -- this harness never appends it itself):');
    console.log(ledgerRow);
  } finally {
    if (daemonHandle) await killDaemon(daemonHandle);
    if (isolatedEnv) cleanupIsolatedEvalEnv(isolatedEnv);
  }
}
