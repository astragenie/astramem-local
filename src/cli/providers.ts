/**
 * `astramem-local providers [--json]`
 *
 * Shows the configured LLM (compaction/extraction) + embedding providers and
 * runs the same live health probes `astramem-local doctor` uses
 * (doctor/probes/llm-chat-probe.ts, doctor/probes/embed-probe.ts) — a real
 * 1-token chat call and a real embed call with dim assertion, not just
 * surface-level config echo.
 */

import { defaultConfig } from '../config/config.js';
import { runChecks, formatTable, type CheckResultWithName } from '../doctor/runner.js';
import type { Check } from '../doctor/types.js';
import { llmChatProbe } from '../doctor/probes/llm-chat-probe.js';
import { embedProbe } from '../doctor/probes/embed-probe.js';
import type { ProviderSet } from '../providers/index.js';

export async function providersCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const cfg = defaultConfig();
  const useMock = process.env.ASTRA_MEMORY_MOCK_PROVIDERS === '1';

  const configured = {
    mode: useMock ? 'mock' : 'live',
    llm_compaction: `${cfg.llm.compaction.provider}/${cfg.llm.compaction.model}`,
    llm_extraction: `${cfg.llm.extraction.provider}/${cfg.llm.extraction.model}`,
    embedding: `${cfg.embedding.provider}/${cfg.embedding.model}`,
  };

  let providers: ProviderSet | undefined;
  let buildError: string | undefined;
  if (useMock) {
    const { makeMockProviders } = await import('../pipeline/mock-providers.js');
    providers = makeMockProviders();
  } else {
    try {
      const { getProviders } = await import('../providers/index.js');
      providers = getProviders(cfg);
    } catch (err) {
      buildError = err instanceof Error ? err.message : String(err);
    }
  }

  const checks: Check[] = [];
  if (providers) {
    const p = providers;
    checks.push({
      name: `LLM chat probe (compaction: ${p.llm.compaction.name}/${p.llm.compaction.model})`,
      tier: 'full', // real, potentially metered LLM call — this CLI command's whole purpose
      run: () => llmChatProbe(p.llm.compaction),
    });
    const sameProvider =
      p.llm.compaction.name === p.llm.extraction.name && p.llm.compaction.model === p.llm.extraction.model;
    if (!sameProvider) {
      checks.push({
        name: `LLM chat probe (extraction: ${p.llm.extraction.name}/${p.llm.extraction.model})`,
        tier: 'full',
        run: () => llmChatProbe(p.llm.extraction),
      });
    }
    // Contradiction judge (2026-07-16): probe only when it is a DISTINCT
    // provider (consolidation.contradictionDetection.{provider,model}
    // override set) — the identity default is already covered by the
    // extraction probe above, and a misconfigured judge would otherwise
    // surface only when a consolidation run first fires a judge call.
    const judge = p.llm.judge;
    const judgeDistinct =
      judge !== undefined &&
      !(judge.name === p.llm.extraction.name && judge.model === p.llm.extraction.model) &&
      !(judge.name === p.llm.compaction.name && judge.model === p.llm.compaction.model);
    if (judgeDistinct) {
      checks.push({
        name: `LLM chat probe (contradiction judge: ${judge.name}/${judge.model})`,
        tier: 'full',
        run: () => llmChatProbe(judge),
      });
    }
    // Pass-B extraction override (FEAT-534): same "only probe when distinct"
    // posture as the judge check above — the identity default is already
    // covered by the extraction probe, and a silent model mix is exactly
    // the ADR-015 hazard this visibility requirement (FEAT-534 AC-4) exists
    // to close.
    const extractionPassB = p.llm.extractionPassB;
    const passBDistinct =
      extractionPassB !== undefined &&
      !(extractionPassB.name === p.llm.extraction.name && extractionPassB.model === p.llm.extraction.model);
    if (passBDistinct) {
      checks.push({
        name: `LLM chat probe (extraction pass B: ${extractionPassB.name}/${extractionPassB.model})`,
        tier: 'full',
        run: () => llmChatProbe(extractionPassB),
      });
    }
    checks.push({
      name: `Embed probe (${p.embed.name}/${p.embed.model})`,
      tier: 'full', // real embed call
      run: () => embedProbe(p.embed),
    });
  } else {
    checks.push({
      name: 'Provider construction',
      tier: 'cheap', // no I/O — reports a construction error already in hand
      run: async () => ({
        ok: false,
        message: buildError ?? 'unknown provider construction error',
        fix: 'Check config.llm / config.embedding and required env vars (e.g. AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT)',
      }),
    });
  }

  const results: CheckResultWithName[] = await runChecks(checks);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          configured,
          checks: results,
          summary: {
            ok: results.filter(r => r.ok).length,
            fail: results.filter(r => !r.ok).length,
          },
        },
        null,
        2,
      ),
    );
  } else {
    console.log('');
    console.log('  AstraMemory Providers');
    console.log('  ──────────────────────────────');
    console.log(`  Mode           : ${configured.mode}`);
    console.log(`  LLM compaction : ${configured.llm_compaction}`);
    console.log(`  LLM extraction : ${configured.llm_extraction}`);
    console.log(`  Embedding      : ${configured.embedding}`);
    console.log('');
    console.log(formatTable(results));
    const failCount = results.filter(r => !r.ok).length;
    const okCount = results.filter(r => r.ok).length;
    console.log(`\n  ${okCount} passed, ${failCount} failed\n`);
  }

  const hasFailures = results.some(r => !r.ok);
  if (hasFailures) process.exit(1);
}
