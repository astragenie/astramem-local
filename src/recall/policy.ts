/**
 * Injection-policy v1 (Wave 4d, ADR-005/ADR-010) — the heuristic
 * "when-to-recall" layer. This is deliberately a THIN layer above pack
 * selection, not part of search: the store answers "what matches",
 * the policy answers "should anything be injected at all, and how much".
 *
 * v1 heuristics (no ML — instrumented via usefulness events so it can
 * become learned later):
 *   1. Task-type gating — trivial/smalltalk or very short prompts get no
 *      injection unless they explicitly reference memory ("remember",
 *      "last time", "we decided", ...).
 *   2. Confidence threshold — only memories whose selection score clears
 *      `minScore` are injected; a pack of weak matches is worse than none.
 *   3. Token-budget-aware top-k — the longer the prompt already is, the
 *      smaller the injection budget ("long context kills retrieval").
 *
 * Every injected memory is recorded as a recall_served usefulness event
 * (ADR-010) so served-but-never-used patterns can tune this layer.
 */

import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import { selectPack, renderPack, DEFAULT_BUDGET_TOKENS, type PackMemory } from './pack.js';
import { recordRecallServed } from '../storage/usefulness.js';

export interface PolicyDecision {
  inject: boolean;
  /** Machine-readable reason — stable strings, used in tests + telemetry. */
  reason:
    | 'injected'
    | 'no-eligible-memories'
    | 'prompt-too-short'
    | 'smalltalk'
    | 'below-min-score'
    | 'policy-disabled';
  memories: PackMemory[];
  pack: string;
  budget_tokens: number;
}

export interface PolicyInput {
  repo: string;
  prompt: string;
  /** Requested budget; the policy may shrink it, never grow it. */
  budgetTokens?: number;
  now?: number;
}

/** Prompts that explicitly ask for memory always get injection. */
const MEMORY_REFERENCE_RE =
  /\b(remember|recall|last time|previously|we decided|as before|earlier session|what did (i|we))\b/i;

/** Cheap smalltalk/greeting classifier — gate, don't inject. */
const SMALLTALK_RE =
  /^\s*(hi|hey|hello|thanks?|thank you|ok(ay)?|yes|no|cool|nice|lol|good (morning|evening|night)|how are you)\s*[!.?]*\s*$/i;

/** Prompt sizes at which the injection budget starts shrinking / bottoms out. */
const PROMPT_SHRINK_START_CHARS = 4_000;
const PROMPT_SHRINK_FLOOR_TOKENS = 300;

export function shrinkBudgetForPrompt(baseBudget: number, promptChars: number): number {
  if (promptChars <= PROMPT_SHRINK_START_CHARS) return baseBudget;
  // Linear decay: every additional 4k chars halves the remaining headroom.
  const over = promptChars - PROMPT_SHRINK_START_CHARS;
  const factor = Math.max(0, 1 - over / 16_000);
  return Math.max(PROMPT_SHRINK_FLOOR_TOKENS, Math.round(baseBudget * factor));
}

export function decideInjection(db: DB, config: Config, input: PolicyInput): PolicyDecision {
  const policyCfg = config.recallPack.policy;
  const baseBudget = input.budgetTokens ?? config.recallPack.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

  if (!policyCfg.enabled) {
    // Policy off = legacy behavior: always inject whatever the pack selects.
    const memories = selectPack(db, { repo: input.repo, budgetTokens: baseBudget, now: input.now });
    record(db, input, memories);
    return {
      inject: memories.length > 0,
      reason: memories.length > 0 ? 'injected' : 'no-eligible-memories',
      memories,
      pack: renderPack(memories),
      budget_tokens: baseBudget,
    };
  }

  const prompt = input.prompt ?? '';
  const referencesMemory = MEMORY_REFERENCE_RE.test(prompt);

  // 1. Task-type gating (memory references override every gate).
  //    Smalltalk first — a greeting is smalltalk regardless of its length.
  if (!referencesMemory) {
    if (SMALLTALK_RE.test(prompt)) {
      return skip('smalltalk', baseBudget);
    }
    if (prompt.trim().length < policyCfg.minPromptChars) {
      return skip('prompt-too-short', baseBudget);
    }
  }

  // 3. Token-budget-aware top-k.
  const budget = shrinkBudgetForPrompt(baseBudget, prompt.length);

  const candidates = selectPack(db, { repo: input.repo, budgetTokens: budget, now: input.now });
  if (candidates.length === 0) return skip('no-eligible-memories', budget);

  // 2. Confidence threshold on the selection score.
  const confident = candidates.filter(m => m.score >= policyCfg.minScore);
  if (confident.length === 0) return skip('below-min-score', budget);

  record(db, input, confident);
  return {
    inject: true,
    reason: 'injected',
    memories: confident,
    pack: renderPack(confident),
    budget_tokens: budget,
  };

  function skip(reason: PolicyDecision['reason'], budgetTokens: number): PolicyDecision {
    return { inject: false, reason, memories: [], pack: '', budget_tokens: budgetTokens };
  }
}

function record(db: DB, input: PolicyInput, memories: PackMemory[]): void {
  if (memories.length === 0) return;
  recordRecallServed(db, {
    query: `pack:${input.repo}`,
    atomIds: memories.map(m => m.id),
    scores: memories.map(m => m.score),
    surface: 'rest',
    mode: 'pack-policy',
  });
}
