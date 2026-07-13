/**
 * SLICE-436 AC-14 — recall MRR guard.
 *
 * "Given the new engineering-rich prompt lands, When
 * scripts/eval/recall-quality/run.mjs runs, Then plain-English MRR stays at
 * or above the post-RECALL-S1 baseline" — the guard that stops richer
 * memories from becoming unfindable ones.
 *
 * run.mjs itself only ever talks to a LIVE daemon's /search endpoint against
 * whatever is already stored there — it has no fixture-seeding of its own.
 * The real post-RECALL-S1 baseline (MRR 0.637, "S1 only (prefix, merged)",
 * .claude/artifacts/crew/handoffs/20260713T090000Z-memory-quality-master-plan.md
 * §1) was measured against the operator's real 13,350-memory production
 * store — which this harness must never touch (prod datadir/port 7777 are
 * explicitly off-limits). Instead, this script builds a bounded, ISOLATED
 * proxy store: it spins its own sandboxed daemon (makeIsolatedEvalEnv, same
 * technique as lib/daemon-runner.ts) pinned at the exact config that was
 * live when 0.637 was measured (llm.compaction/extraction = ollama
 * qwen2.5-coder:7b, engineering profile, NO ASTRA_EXTRACT_PROMPT override —
 * so extraction runs under the new v3 prompt this AC is gating), re-ingests
 * a short synthetic session per ground-truth.json case built from that
 * case's own `known_memory` field (the fact recall-quality's ground truth
 * says a real memory already states), waits for real distillation, and then
 * runs the REAL run.mjs against this isolated daemon exactly as an operator
 * would run it against their own store.
 *
 * This is an honest, disclosed proxy for the real 13k-memory store, not a
 * replacement measurement of it — see the proof-phase report's caveats
 * section for the full methodology note.
 *
 * Usage: bun scripts/eval/recall-quality/run-mrr-guard.mts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
} from '../shared/spawn-daemon.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// Post-RECALL-S1 baseline, "S1 only (prefix, merged)" — the real, merged
// measurement against the live 13,350-memory store, NOT the earlier crude
// "prefix injected into query text" experiment (0.642) which pre-dated the
// real implementation and deliberately handicapped BM25 as part of the
// experiment. Source: .claude/artifacts/crew/handoffs/
// 20260713T090000Z-memory-quality-master-plan.md §1 CORRECTION table.
const BASELINE_MRR = 0.637;

interface GroundTruthCase {
  id: string;
  plain: string;
  literal: string;
  markers: string[];
  known_memory: string;
}

const { cases } = JSON.parse(readFileSync(join(HERE, 'ground-truth.json'), 'utf8')) as { cases: GroundTruthCase[] };

/** One short, plausible 2-turn session per ground-truth case, built to
 * naturally lead an extractor to the case's own `known_memory` fact. */
function sessionTurnsFor(c: GroundTruthCase): Array<{ role: 'user' | 'assistant'; text: string }> {
  return [
    { role: 'user', text: `Quick question — ${c.plain}?` },
    { role: 'assistant', text: `${c.known_memory}.` },
  ];
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function main(): Promise<void> {
  console.log('SLICE-436 AC-14 — recall MRR guard (isolated proxy store, v3 prompt, no override)\n');

  const isolated = makeIsolatedEvalEnv('mrr-guard');
  const configYaml = [
    'security:',
    '  encryption:',
    '    enabled: false',
    'llm:',
    '  compaction:',
    "    provider: ollama",
    "    model: 'qwen2.5-coder:7b'",
    '  extraction:',
    '    provider: ollama',
    "    model: 'qwen2.5-coder:7b'",
    'budget:',
    '  daily_usd: 50',
    '',
  ].join('\n');
  writeFileSync(join(isolated.configDir, 'config.yaml'), configYaml, 'utf8');

  const dataDir = join(isolated.root, 'datadir');
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('hex');

  // Deliberately no ASTRA_EXTRACT_PROMPT in isolated.env — defaults to v3
  // (resolveExtractionPrompt's fallthrough), which is exactly the prompt
  // this guard exists to gate.
  delete process.env.ASTRA_EXTRACT_PROMPT;

  let daemon: Awaited<ReturnType<typeof spawnEvalDaemon>> | undefined;
  try {
    daemon = await spawnEvalDaemon({ dataDir, token, env: isolated.env });
    await waitForHealthStatus(daemon.baseUrl, ['ok'], 90_000);
    console.log(`daemon up at ${daemon.baseUrl}`);

    for (const c of cases) {
      const sessionId = `mrr-guard-${c.id}`;
      const envelope = {
        event: 'session_end' as const,
        session_id: sessionId,
        project_id: 'recall-quality-mrr-guard',
        agent_type: 'proof-phase',
        captured_at: new Date().toISOString(),
        turns: sessionTurnsFor(c),
        client_scrub_applied: false,
        client_scrub_hits: 0,
        client_version: 'run-mrr-guard/0.1',
        client_scrub_version: 'none',
        wire_version: 'v1.0',
      };
      const res = await fetch(`${daemon.baseUrl}/ingest/transcript`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'idempotency-key': randomUUID() },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) throw new Error(`ingest failed for ${c.id}: HTTP ${res.status} — ${await res.text()}`);
      console.log(`  ingested ${c.id}`);
    }

    // Poll every session's digest until ready/partial (or a bounded overall
    // timeout) — same convention as lib/daemon-runner.ts.
    const deadline = Date.now() + 3 * 60_000;
    const pending = new Set(cases.map(c => `mrr-guard-${c.id}`));
    while (pending.size > 0 && Date.now() < deadline) {
      for (const sessionId of [...pending]) {
        const dRes = await fetch(`${daemon.baseUrl}/sessions/${encodeURIComponent(sessionId)}/digest`, { headers: authHeaders(token) });
        if (dRes.ok) {
          const body = (await dRes.json()) as { status?: string };
          if (body.status === 'ready' || body.status === 'partial') pending.delete(sessionId);
        }
      }
      if (pending.size > 0) await sleep(1000);
    }
    if (pending.size > 0) {
      console.log(`WARNING: ${pending.size} session(s) never reached ready/partial before timeout: ${[...pending].join(', ')}`);
    }

    // Run the REAL run.mjs against this isolated daemon.
    const mrrOut = execFileSync(
      'node',
      [join(REPO_ROOT, 'scripts', 'eval', 'recall-quality', 'run.mjs'), '--host', daemon.baseUrl, '--limit', '5'],
      { encoding: 'utf8', env: { ...process.env, MEMORY_BEARER: token } },
    );
    console.log(mrrOut);

    const m = /plain-English\s+found in top-\d+:\s*\d+\/\d+\s+MRR\s+([\d.]+)/.exec(mrrOut);
    if (!m) throw new Error('could not parse plain-English MRR from run.mjs output');
    const mrr = Number(m[1]);

    console.log(`\n=== AC-14 VERDICT ===`);
    console.log(`  measured MRR (isolated proxy store, v3 prompt): ${mrr.toFixed(3)}`);
    console.log(`  post-RECALL-S1 baseline (real store, S1 merged): ${BASELINE_MRR.toFixed(3)}`);
    console.log(`  ${mrr >= BASELINE_MRR ? 'PASS' : 'FAIL'} — ${mrr >= BASELINE_MRR ? 'at or above' : 'BELOW'} baseline`);
  } finally {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 5_000);
    cleanupIsolatedEvalEnv(isolated);
  }
}

await main();
