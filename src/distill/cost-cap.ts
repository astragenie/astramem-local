/**
 * Opt-in cost cap for stage 4 (compact) + stage 5 (extract) LLM calls,
 * counted TOGETHER as one per-JOB budget (`config.distill.costCap`).
 *
 * Mirrors `consolidation.contradictionDetection`'s `maxPerRun`/
 * `maxWallClockMs` shape (see `src/consolidate/consolidate.ts`'s
 * `runConsolidation` for the precedent this reuses) — same call-count +
 * wall-clock guard, same graceful degrade-on-cap posture, for the same
 * underlying reason:
 *
 * `src/budget/tracker.ts`'s `BudgetTracker`/`BudgetExceeded` already exists
 * as a DOLLAR cap on distill's compact()/extract() calls and stays in place
 * unchanged (it prices Ollama/Azure correctly). But codex-subscription — the
 * default compaction+extraction provider — is metered by ChatGPT
 * subscription quota, not per-token, and hardcodes `usage.usd: 0` on every
 * response (see `contradiction-judge.ts`'s doc comment for the identical
 * blind spot that motivated the contradiction judge's own count/wall-clock
 * cap, and `doctor`'s "Budget cap vs codex-subscription" check, which
 * already flags this exact gap for distill). A dollar cap compared against
 * an always-0 estimate can never trip — this module is the SEPARATE guard
 * for that blind spot, not a replacement for BudgetTracker.
 *
 * SHIPPED DISABLED FOR BETA (`config.distill.costCap.enabled: false`,
 * `defaultConfig()`): a pure no-op when disabled — `shouldStop()` always
 * returns `false`, `recordCall()` is a no-op, no wall-clock timer is
 * observably started (the field is written but never read). BYO-subscription
 * operators own their own quota; a default-on hard pause on the two hottest
 * LLM paths in the pipeline would be friction, not safety, for the common
 * case. Opt in per-operator via config.yaml.
 */

import type { Config } from '../config/config.js';

export interface DistillCostCapConfig {
  enabled: boolean;
  maxCallsPerJob?: number;
  maxWallClockMs?: number;
}

export interface DistillCostCapState {
  /** Total compact()+extract() LLM calls actually dispatched this job (0
   *  whenever the cap is disabled — this counter simply isn't kept). */
  callsExecuted: number;
  /** True when `maxCallsPerJob` was reached before every chunk was
   *  processed — lets a caller distinguish "ran to completion" from "cap
   *  stopped it early", the same distinction
   *  `ConsolidateSummary.contradictionCapReached` draws. */
  capReached: boolean;
  /** True when `maxWallClockMs` elapsed before every chunk was processed —
   *  separate from `capReached` for the same reason
   *  `contradictionWallClockCapReached` is separate from
   *  `contradictionCapReached`: a slow/rate-limited provider can blow the
   *  wall-clock budget long before the call-count cap is hit. */
  wallClockCapReached: boolean;
}

/**
 * Resolve `config.distill.costCap` into a normalized, always-present shape.
 * `undefined` (an older/partial config object, or a caller that never set
 * the field) resolves to `{ enabled: false }` — the same disabled-by-default
 * posture `defaultConfig()` ships, never a hard failure.
 */
export function resolveDistillCostCap(config: Config): DistillCostCapConfig {
  const raw = config.distill?.costCap;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return { enabled: false };
  return { enabled: true, maxCallsPerJob: raw.maxCallsPerJob, maxWallClockMs: raw.maxWallClockMs };
}

/**
 * Per-job tracker instance — construct ONE per `runPipeline()` call and
 * thread it into both `compact()` and `extract()` (see pipeline.ts) so the
 * two stages share a single call-count/wall-clock budget, matching
 * `maxCallsPerJob`'s "compact()+extract() combined" semantics.
 *
 * `shouldStop()` is checked by `compactChunk`/`extractChunk` BEFORE making
 * their LLM call; when it returns true, the chunk's call is skipped entirely
 * (no `provider.chat()` invocation) and the chunk falls through to the
 * pipeline's existing "nothing to add" posture — compact() passes the raw
 * chunk through unchanged (the same path an empty compact result already
 * takes), extract() contributes zero atoms for that chunk (the same "fewer
 * atoms is not an error" tolerance the rest of this pipeline already has,
 * see `Config['distill']['compaction']`'s doc comment). The job still
 * completes; it is never failed or paused by this cap, unlike
 * `BudgetExceeded`.
 */
export class DistillCostCapTracker {
  private callsThisJob = 0;
  private readonly startedAt = Date.now();
  private capReached = false;
  private wallClockCapReached = false;
  private loggedTrip = false;

  constructor(
    private readonly cap: DistillCostCapConfig,
    private readonly log: (message: string) => void = (m) => console.warn(m),
  ) {}

  /** True when the caller should skip its next LLM call. Always false when
   *  the cap is disabled. */
  shouldStop(): boolean {
    if (!this.cap.enabled) return false;
    if (typeof this.cap.maxCallsPerJob === 'number' && this.callsThisJob >= this.cap.maxCallsPerJob) {
      this.capReached = true;
      this.logTripOnce('call-count', `${this.callsThisJob}/${this.cap.maxCallsPerJob} calls`);
      return true;
    }
    if (typeof this.cap.maxWallClockMs === 'number') {
      const elapsed = Date.now() - this.startedAt;
      if (elapsed >= this.cap.maxWallClockMs) {
        this.wallClockCapReached = true;
        this.logTripOnce('wall-clock', `${elapsed}ms/${this.cap.maxWallClockMs}ms`);
        return true;
      }
    }
    return false;
  }

  /** Record one LLM call actually dispatched. No-op when the cap is
   *  disabled (matches the byte-identical-when-disabled contract — no
   *  counter is even kept). */
  recordCall(): void {
    if (!this.cap.enabled) return;
    this.callsThisJob++;
  }

  state(): DistillCostCapState {
    return {
      callsExecuted: this.callsThisJob,
      capReached: this.capReached,
      wallClockCapReached: this.wallClockCapReached,
    };
  }

  private logTripOnce(kind: 'call-count' | 'wall-clock', detail: string): void {
    if (this.loggedTrip) return;
    this.loggedTrip = true;
    this.log(
      `[distill-cost-cap] ${kind} cap reached (${detail}) — skipping further compact()/extract() LLM ` +
      `calls for this job; remaining chunks fall through unprocessed (this is not a job failure).`,
    );
  }
}
