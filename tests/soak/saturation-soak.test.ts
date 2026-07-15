/**
 * tests/soak/saturation-soak.test.ts — P2.2 saturation soak test.
 *
 * Stabilization plan reference: `.claude/artifacts/crew/handoffs/
 * 20260715T1645Z-design-memo-architect-p1-p2-stabilization-designs.md` §P2.2
 * and `.claude/artifacts/crew/handoffs/20260715T1630Z-stabilization-analysis-
 * and-plan-crash-loop-event-loop-stalls.md`. The 2026-07-15 incident this
 * guards against: Ollama embed latency climbed 62s -> 142s under load, the
 * event loop stalled 15-219s during embed-heavy jobs, /health timed out, and
 * the watchdog killed a daemon that was busy, not dead — 5 kills + 5 crashes
 * in one day. P1.2 (event-loop-lag canary), P1.3 (liveness/readiness split
 * for /health), and P1.4 (job backpressure) were built to close this. This
 * suite is the regression gate: it spawns a REAL daemon, induces the same
 * class of saturation with a deterministic mock embed delay, and asserts the
 * fixes hold under load TOGETHER — not just in their own unit tests.
 *
 * SATURATION MECHANISM — ASTRA_MOCK_EMBED_DELAY_MS:
 * `src/pipeline/mock-providers.ts`'s `MockEmbedProvider.embed()` reads this
 * env var (P2.2 addition, gated behind the pre-existing
 * ASTRA_MEMORY_MOCK_PROVIDERS=1 reachability guard — never reachable in real
 * serving) and `setTimeout`-delays before resolving. The delay is a Promise/
 * timer, never a synchronous sleep, so it simulates a saturated remote
 * provider (queued behind other requests, like Ollama was) without itself
 * blocking the event loop — the daemon's OWN code is what must stay
 * responsive, which is exactly the property this suite measures.
 *
 * TWO-WAVE DESIGN — why not just flood N identical ingests:
 * The worker's extended context wraps the embed provider in a content-hash
 * cache (FEAT-492, `src/providers/embed/cache.ts`) for distill/reembed call
 * sites — a real and correct production optimization, but it means N
 * concurrent jobs that all extract the SAME fixed atom text (the mock LLM's
 * deterministic keyword vocabulary, `mock-extraction-vocab.ts`, has only 6
 * fixed outputs) only pay the induced delay on the first occurrence of each
 * text; every later job with that same text is an instant cache hit and
 * never re-exercises the governor. A naive single-wave flood was tried
 * first and empirically confirmed this: round 1 (8 concurrent, first-ever
 * occurrence) took the full ~16s per job as expected, but the "round 2"
 * batch — same fixed atom text, already cached from round 1 — completed in
 * under a second, never demonstrating a throttled-yet-progressing round.
 * Fix: two waves, two different job kinds, both gated by the SAME governor
 * lane budget (`worker.ts`'s `laneId >= governor.laneBudget()` check applies
 * to every job kind uniformly) but only one of which feeds the EWMA:
 *   Wave 1 (EWMA seed): CONCURRENCY 'distill' jobs, all sharing the
 *   "sqlite-vec" mock-vocab keyword — `distill` IS in backpressure.ts's
 *   EMBED_HEAVY_KINDS, so all CONCURRENCY completions (each ~EMBED_DELAY_MS,
 *   genuinely uncached — embedAndIndex calls embed() unconditionally BEFORE
 *   any hash-dedup check, confirmed by reading 08-embed-index.ts) feed the
 *   EWMA and push the governor into the "slow" tier (0.5x budget).
 *   Wave 2 (throttle observed): WAVE2_COUNT 'distill-events' jobs (ADR-008
 *   pre-typed-atom capture kind — ingest.ts's `kind: 'events'`), each
 *   carrying a GLOBALLY UNIQUE text (a fresh randomUUID per event) so every
 *   one is a genuine cache miss and pays the full delay. `distill-events` is
 *   deliberately NOT in EMBED_HEAVY_KINDS (it never feeds the EWMA itself —
 *   see distill-events.ts's doc comment: no LLM stage, atoms map straight
 *   from wire events), so wave 2's own throttling is entirely attributable
 *   to wave 1's already-elevated EWMA, not to wave 2 somehow being slow on
 *   its own terms — the cleanest possible "the lane cap is real, not a
 *   self-fulfilling artifact" signal.
 * Job-creation ordering (wave 1's POSTs awaited and fully returned before
 * wave 2's POSTs fire) guarantees wave 1's jobs have the earlier
 * `created_at` and are claimed first by JobRepo.claimPending()'s oldest-first
 * ordering, so all CONCURRENCY lanes are occupied by wave 1 at t=0 and wave
 * 2 sits fully pending until wave 1 completes and the (now-lower) budget
 * opens back up.
 *
 * EMBED_DELAY_MS=16_000 was chosen algebraically against backpressure.ts's
 * real constants (EWMA_ALPHA=0.3, seed=1000ms, slowMs=5000, severeMs=20000):
 * a single 16s sample already pushes the EWMA above the 5000ms "slow" line
 * (0.3*16000+0.7*1000=5500), and the EWMA's asymptote as more same-size
 * samples land is the delay itself (16000 < severeMs=20000), so the governor
 * settles into and STAYS IN the "slow" (0.5x) tier for the whole run instead
 * of oscillating into "severe" — a deterministic, single-tier throttle
 * signal instead of a timing-sensitive one.
 *
 * Datadir is ':memory:' — serve.ts only wires the P1.5 boot-ramp ladder when
 * `dataDir !== ':memory:'`; skipping it isolates the EWMA-driven throttle
 * under test here from the unrelated 60s-per-step boot-ramp mechanism (a
 * P1.5 concern with its own coverage elsewhere, and — being a real-clock 60s
 * step — not compatible with this suite's CI-sane runtime budget).
 *
 * Expected wall clock: wave 1 ~16-18s (8 concurrent, first-time cache miss)
 * + wave 2 in 2 rounds of 4 at the throttled budget (~16-18s each) = ~50-55s
 * total, comfortably under the 120s hard cap and close to the 60s ideal.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  spawnDaemon, killDaemon, waitForHealthOk,
  makeIsolatedDaemonEnv, cleanupIsolatedDaemonEnv,
  type DaemonHandle, type IsolatedDaemonEnv,
} from '../smoke/helpers/daemon.js';

// ── Tunables (see the design note above for the algebra behind each) ───────

const CONCURRENCY = 8;
const EMBED_DELAY_MS = 16_000;
/** Wave 1: seeds the EWMA. Equal to CONCURRENCY so every lane claims one at
 *  boot and all completions land close together. */
const WAVE1_COUNT = CONCURRENCY;
/** Wave 2: throttle-observed. 2x the expected post-wave-1 budget
 *  (round(CONCURRENCY*0.5)=4) so draining takes >=2 rounds — one round alone
 *  could be "we just happened to claim <8" rather than "capped while more
 *  work was available and idle lanes existed to run it". */
const WAVE2_COUNT = CONCURRENCY; // = 8, expect 2 rounds of 4 once throttled
const RUN_ID = randomUUID().slice(0, 8);
const TOKEN = `soak-tok-${RUN_ID}`;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

/** /health is polled aggressively (the watchdog's own liveness target) —
 *  cheap by design per P1.3 (in-memory snapshot + O(1) histogram read), so a
 *  tight interval here is itself part of what's under test: the endpoint
 *  must tolerate being hit often while the daemon is saturated. */
const HEALTH_POLL_INTERVAL_MS = 200;
/** /health/full recomputes the DB-backed queue block live (P1.3 doc: "always
 *  fresh") — polled less often so the test's own forensic reads don't become
 *  a second load source on top of the induced saturation. */
const QUEUE_POLL_INTERVAL_MS = 1_000;
/** Generous drain ceiling: ~55s expected (see design note), roughly doubled
 *  for CI jitter headroom while staying well under the 120s hard cap. */
const DRAIN_TIMEOUT_MS = 100_000;
/** P1.2's doctor RED threshold (event-loop-lag.ts / design memo §2) — the
 *  number a human had to hand-measure with curl during the incident. This
 *  suite asserts the daemon never even approaches it while saturated. */
const EVENT_LOOP_ALARM_MS = 1_000;
/** Liveness latency budget (P2.2 spec) for GET /health while saturated. */
const HEALTH_P95_BUDGET_MS = 500;
/** Wave 1's peak running count should land close to CONCURRENCY (allows
 *  slight timing slack — not every lane's claim is guaranteed to land in the
 *  exact same 1s queue-poll bucket). */
const EARLY_ROUND_MIN_RUNNING = Math.ceil(CONCURRENCY * 0.75); // 6 of 8
/** After the EWMA trips to the "slow" tier, budget = round(CONCURRENCY*0.5)
 *  = 4. Assert wave 2's peak-while-pending stays meaningfully below full
 *  concurrency — the throttle signal — with slack for the exact sampling
 *  instant. */
const LATE_ROUND_MAX_RUNNING = Math.ceil(CONCURRENCY * 0.75) - 1; // 5 of 8

interface HealthBody {
  ok?: boolean;
  status?: string;
  event_loop?: { p99Ms: number; meanMs: number; maxMs: number; windowStartedAt: number };
}

interface HealthFullBody extends HealthBody {
  queue?: Record<string, number>;
}

let isolated: IsolatedDaemonEnv;
let daemon: DaemonHandle | null = null;

afterAll(async () => {
  if (daemon) await killDaemon(daemon, 'SIGKILL', 5_000);
  if (isolated) cleanupIsolatedDaemonEnv(isolated);
});

describe('P2.2 saturation soak test', () => {
  it(
    'holds /health latency + event-loop lag low and throttles-not-stalls the worker under induced embed saturation',
    async () => {
      // ── Setup: isolated sandbox + concurrency=8 config + mock embed delay ──
      isolated = makeIsolatedDaemonEnv('astramem-soak');
      writeFileSync(
        join(isolated.configDir, 'config.yaml'),
        'security:\n  encryption:\n    enabled: false\npipeline:\n  concurrency: 8\n',
        'utf8',
      );

      daemon = await spawnDaemon({
        port: 0,
        token: TOKEN,
        env: {
          ...isolated.env,
          // :memory: skips serve.ts's boot-ramp wiring — see design note.
          ASTRA_MEMORY_DATADIR: ':memory:',
          ASTRA_MOCK_EMBED_DELAY_MS: String(EMBED_DELAY_MS),
        },
      });
      daemon.proc.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(`[soak-daemon] ${chunk.toString()}`);
      });
      await waitForHealthOk(daemon.baseUrl);
      expect(daemon.exitInfo().code, `daemon exited early — stderr:\n${daemon.stderr()}`).toBeNull();

      const baseUrl = daemon.baseUrl;

      // ── Wave 1: WAVE1_COUNT distill jobs, all sharing the same fixed
      // mock-vocab keyword ("sqlite-vec") — feeds the EWMA, each genuinely
      // delayed (embedAndIndex calls embed() before any dedup check). ──
      const wave1 = await Promise.all(
        Array.from({ length: WAVE1_COUNT }, (_, i) => {
          const envelope = {
            event: 'pre_compact',
            session_id: `soak-wave1-${RUN_ID}-${i}`,
            project_id: 'astramemory-local-soak',
            agent_type: 'claude-code',
            cwd: 'C:/work/mega/astramemory-local',
            captured_at: new Date().toISOString(),
            kind: 'transcript',
            turns: [
              { role: 'user', text: `Let's use sqlite-vec for storage (soak wave1 job ${i}).`, ts: new Date().toISOString() },
            ],
            tool: 'claude-code',
            client_scrub_applied: true,
            client_scrub_hits: 0,
            client_version: '0.6.0',
            client_scrub_version: '1.2.0',
            wire_version: 'v1.0',
          };
          return fetch(`${baseUrl}/ingest/transcript`, {
            method: 'POST',
            headers: { ...AUTH, 'idempotency-key': `soak-wave1-${RUN_ID}-${i}` },
            body: JSON.stringify(envelope),
          });
        }),
      );
      for (const res of wave1) expect(res.status).toBe(200);

      // ── Wave 2: WAVE2_COUNT distill-events jobs, each carrying a globally
      // unique event text — guaranteed cache miss, throttle-observed round.
      // Fired AFTER wave 1 is fully acknowledged so wave 1's jobs have the
      // earlier created_at and are claimed first (oldest-first claim). ──
      const wave2 = await Promise.all(
        Array.from({ length: WAVE2_COUNT }, (_, i) => {
          const envelope = {
            event: 'pre_compact',
            session_id: `soak-wave2-${RUN_ID}-${i}`,
            project_id: 'astramemory-local-soak',
            agent_type: 'claude-code',
            cwd: 'C:/work/mega/astramemory-local',
            captured_at: new Date().toISOString(),
            kind: 'events',
            events: [
              {
                type: 'note' as const,
                text: `soak wave2 unique payload ${RUN_ID}-${i}-${randomUUID()}`,
              },
            ],
            tool: 'claude-code',
            client_scrub_applied: true,
            client_scrub_hits: 0,
            client_version: '0.6.0',
            client_scrub_version: '1.2.0',
            wire_version: 'v1.0',
          };
          return fetch(`${baseUrl}/ingest/transcript`, {
            method: 'POST',
            headers: { ...AUTH, 'idempotency-key': `soak-wave2-${RUN_ID}-${i}` },
            body: JSON.stringify(envelope),
          });
        }),
      );
      for (const res of wave2) expect(res.status).toBe(200);

      const totalJobs = WAVE1_COUNT + WAVE2_COUNT;

      // ── Drain: poll /health (latency + event-loop lag) and /health/full
      // (queue running/pending/completed) until the queue is empty ──
      const healthLatenciesMs: number[] = [];
      const eventLoopP99Samples: number[] = [];
      interface QueueSample { tMs: number; pending: number; running: number; completed: number }
      const queueSamples: QueueSample[] = [];

      const drainStart = Date.now();
      let lastQueuePollAt = 0;
      let drained = false;

      while (Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
        const t0 = Date.now();
        const healthRes = await fetch(`${baseUrl}/health`);
        const latencyMs = Date.now() - t0;
        healthLatenciesMs.push(latencyMs);
        expect(healthRes.status).toBe(200);
        const healthBody = (await healthRes.json()) as HealthBody;
        if (healthBody.event_loop) eventLoopP99Samples.push(healthBody.event_loop.p99Ms);

        const now = Date.now();
        if (now - lastQueuePollAt >= QUEUE_POLL_INTERVAL_MS) {
          lastQueuePollAt = now;
          const fullRes = await fetch(`${baseUrl}/health/full`, { headers: AUTH });
          expect(fullRes.status).toBe(200);
          const fullBody = (await fullRes.json()) as HealthFullBody;
          const queue = fullBody.queue ?? {};
          const pending = queue['pending'] ?? 0;
          const running = queue['running'] ?? 0;
          const completed = queue['completed'] ?? 0;
          queueSamples.push({ tMs: now - drainStart, pending, running, completed });
          if (pending === 0 && running === 0) {
            drained = true;
            break;
          }
        }
        await sleep(HEALTH_POLL_INTERVAL_MS);
      }

      // ── Assertion 1: the queue actually drained (throttled means SLOWER,
      // never stopped) — a timeout here means the governor stalled the queue. ──
      expect(
        drained,
        `queue did not drain within ${DRAIN_TIMEOUT_MS}ms — last samples: ${JSON.stringify(queueSamples.slice(-5))}`,
      ).toBe(true);
      const lastSample = queueSamples[queueSamples.length - 1]!;
      expect(lastSample.completed).toBe(totalJobs);

      // ── Assertion 2: /health (liveness endpoint) stayed fast throughout —
      // the exact property that failed during the 2026-07-15 incident (a
      // healthy-but-busy daemon got killed because /health itself queued
      // behind DB contention / event-loop stalls). ──
      const sortedLatencies = [...healthLatenciesMs].sort((a, b) => a - b);
      const p95Index = Math.min(sortedLatencies.length - 1, Math.ceil(0.95 * sortedLatencies.length) - 1);
      const p95LatencyMs = sortedLatencies[p95Index]!;
      expect(
        p95LatencyMs,
        `/health p95 latency ${p95LatencyMs}ms over ${sortedLatencies.length} samples exceeded the ${HEALTH_P95_BUDGET_MS}ms budget`,
      ).toBeLessThan(HEALTH_P95_BUDGET_MS);

      // ── Assertion 3: event-loop lag (P1.2) never approached the doctor RED
      // alarm threshold while embed-heavy jobs were saturating the mock
      // provider — this is the number a human had to hand-curl during the
      // incident; it must now be visible AND low. ──
      expect(eventLoopP99Samples.length).toBeGreaterThan(0);
      const maxEventLoopP99 = Math.max(...eventLoopP99Samples);
      expect(
        maxEventLoopP99,
        `event_loop.p99Ms peaked at ${maxEventLoopP99}ms — at/above the ${EVENT_LOOP_ALARM_MS}ms doctor RED alarm`,
      ).toBeLessThan(EVENT_LOOP_ALARM_MS);

      // ── Assertion 4: the governor actually throttled (P1.4) — wave 1's
      // peak running count should be near full concurrency; a LATER sample
      // (while wave 2 jobs are still pending) should show a running count
      // capped meaningfully below full concurrency despite idle lanes
      // existing to claim more — proof the cap is the EWMA budget, not job
      // scarcity. ──
      const earlyPeakRunning = Math.max(...queueSamples.slice(0, 3).map(s => s.running), 0);
      expect(
        earlyPeakRunning,
        `expected wave 1 near full concurrency (>= ${EARLY_ROUND_MIN_RUNNING}); observed peak ${earlyPeakRunning}. samples: ${JSON.stringify(queueSamples)}`,
      ).toBeGreaterThanOrEqual(EARLY_ROUND_MIN_RUNNING);

      // "Throttled" specifically means idle lane capacity (running below full
      // concurrency) coexisting with available work (pending > 0) — a sample
      // where running === CONCURRENCY and pending > 0 (wave 1's own peak,
      // where wave 2 is simply queued behind a fully-busy worker) is NOT
      // throttling evidence, it is ordinary full-concurrency saturation.
      const throttledSamples = queueSamples.filter(s => s.pending > 0 && s.running > 0 && s.running < CONCURRENCY);
      expect(
        throttledSamples.length,
        `expected at least one sample with jobs both pending and running (a throttled-but-progressing round); samples: ${JSON.stringify(queueSamples)}`,
      ).toBeGreaterThan(0);
      const latePeakRunningWhilePending = Math.max(...throttledSamples.map(s => s.running));
      expect(
        latePeakRunningWhilePending,
        `expected a throttled round's running count to stay below ${LATE_ROUND_MAX_RUNNING} while jobs were still pending ` +
        `(proves the cap is the governor's EWMA budget, not job scarcity); observed ${latePeakRunningWhilePending}. ` +
        `samples: ${JSON.stringify(queueSamples)}`,
      ).toBeLessThanOrEqual(LATE_ROUND_MAX_RUNNING);

      // ── Assertion 5: no job failed/poisoned — the induced delay is pure
      // latency, never an error, so nothing should have hit the retry/poison
      // path (which would indicate the delay knob or handler mishandled it). ──
      const finalFullRes = await fetch(`${baseUrl}/health/full`, { headers: AUTH });
      const finalFullBody = (await finalFullRes.json()) as HealthFullBody;
      const finalQueue = finalFullBody.queue ?? {};
      expect(finalQueue['failed'] ?? 0).toBe(0);
      expect(finalQueue['poison'] ?? 0).toBe(0);
    },
    120_000,
  );
});
