/**
 * Response-side [0,1] score wire contract enforcement (FEAT-413/SLICE-411).
 *
 * fuseScores() (src/search/fuse.ts) is the only *intended* score producer
 * today, but nothing stops a future second fusion strategy, a manual score
 * override, or a stale cache read from constructing a hit whose score sits
 * outside [0,1] (or is NaN/Infinity). This module enforces the contract at
 * the JSON serialization boundary — independent of fuseScores() internal
 * math — so an out-of-contract score is clamped and logged server-side
 * instead of shipping invalid wire data that only the plugin's client-side
 * Zod schema rejects (the cedc8a9 failure mode: plugin exit 3, daemon
 * oblivious).
 */

import { childLogger } from '../../log/logger.js';

const log = childLogger({ component: 'score-contract' });

export interface ScoreContractContext {
  /** Route the score is being serialized for, e.g. 'GET /search'. */
  route: string;
  /** Id of the hit/memory the score belongs to. */
  id: string;
}

/**
 * Clamp a single score into [0,1]. Non-finite values map to a safe bound
 * (NaN -> 0, +Infinity -> 1, -Infinity -> 0). Logs a structured warning with
 * route + id context whenever the input was out of contract; in-contract
 * values pass through unchanged with no log emitted (no noise on the happy
 * path).
 */
export function clampScore(value: number, ctx: ScoreContractContext): number {
  if (Number.isNaN(value)) {
    log.warn({ route: ctx.route, id: ctx.id, value: 'NaN' }, 'score-contract: non-finite score clamped to 0');
    return 0;
  }
  if (!Number.isFinite(value)) {
    const clamped = value > 0 ? 1 : 0;
    log.warn({ route: ctx.route, id: ctx.id, value: value > 0 ? 'Infinity' : '-Infinity' }, 'score-contract: non-finite score clamped');
    return clamped;
  }
  if (value < 0) {
    log.warn({ route: ctx.route, id: ctx.id, value }, 'score-contract: score below 0 clamped to 0');
    return 0;
  }
  if (value > 1) {
    log.warn({ route: ctx.route, id: ctx.id, value }, 'score-contract: score above 1 clamped to 1');
    return 1;
  }
  return value;
}

/**
 * Clamp scores across a list of hits/memories at a response serialization
 * site. Returns the same item (same reference) when its score is already
 * in-contract, so an untouched happy-path array is bit-identical.
 */
export function clampScores<T extends { id: string; score: number }>(items: T[], route: string): T[] {
  return items.map(item => {
    const clamped = clampScore(item.score, { route, id: item.id });
    return clamped === item.score ? item : { ...item, score: clamped };
  });
}
