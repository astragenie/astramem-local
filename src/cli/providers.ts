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
      run: () => llmChatProbe(p.llm.compaction),
    });
    const sameProvider =
      p.llm.compaction.name === p.llm.extraction.name && p.llm.compaction.model === p.llm.extraction.model;
    if (!sameProvider) {
      checks.push({
        name: `LLM chat probe (extraction: ${p.llm.extraction.name}/${p.llm.extraction.model})`,
        run: () => llmChatProbe(p.llm.extraction),
      });
    }
    checks.push({
      name: `Embed probe (${p.embed.name}/${p.embed.model})`,
      run: () => embedProbe(p.embed),
    });
  } else {
    checks.push({
      name: 'Provider construction',
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
