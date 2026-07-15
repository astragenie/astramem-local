/**
 * Doctor check registry.
 *
 * Other tracks add checks via register() in their own modules — they call
 * register() at module load time, before the CLI runs runChecks().
 *
 * Registry API:
 *   register(check: Check): void
 *   getChecks(): Check[]
 *
 * Example (a track adding its own check):
 *   import { register } from '../doctor/checks.js';
 *   register({ name: 'No stuck jobs', run: async () => { ... } });
 *
 * ─── Layout (2026-07-13 split) ────────────────────────────────────────────
 *
 * `src/doctor/checks.ts` used to be a single 2,167-line file holding every
 * core check plus the registry. Three parallel slices independently modified
 * it on the same day (A3's `checkSpoolQuarantine`, #215's
 * `checkEntityLinkRate`, #226's red branch on `checkMemoryHealth`) — every
 * one of them collided or was set up to collide, because appending a
 * function and appending a line to `coreChecks()`'s array is the one thing
 * every "make this observable" slice must do in the same file.
 *
 * The fix: one file per check under `src/doctor/checks/`, aggregated here.
 * Adding a new canary now means adding ONE NEW FILE (its own name, its own
 * doc comment, zero shared surface with any other check) plus a two-line
 * touch to THIS file — one import line, one array line — instead of editing
 * inside a shared function body. `src/doctor/checks/shared.ts` holds the
 * genuinely cross-cutting pieces (DoctorCheckOpts, openProductionDbReadonly,
 * the handful of shared time/threshold constants) and is the only other file
 * more than one check ever needs to touch.
 *
 * `src/doctor/checks.ts` itself is now a thin re-export shim — every import
 * site outside this directory (`cli/doctor.ts`, `cli/init.ts`, `cli/serve.ts`,
 * `doctor/schedule.ts`, and every `tests/doctor/*-check.test.ts` file) keeps
 * importing from `../doctor/checks.js` unchanged.
 *
 * Explicit import list, not auto-discovery: deliberate, not a fallback taken
 * for lack of trying. Two reasons, both hard requirements this refactor is
 * bound by:
 *
 *  1. ORDER is part of the observable behavior this refactor promises not to
 *     change (doctor's table/JSON output is ordered, and this PR's own
 *     acceptance bar is a byte-identical before/after diff). A directory scan
 *     (`readdirSync` + dynamic `import()`) orders by filesystem/OS directory
 *     listing order, which is not guaranteed to match `coreChecks()`'s
 *     original sequence and is not guaranteed stable across platforms
 *     (win32/linux/darwin all ship this codebase) or filesystems. An explicit
 *     list is the only mechanism that pins order as a readable fact instead
 *     of an incidental one.
 *  2. The checks are NOT a uniform plugin registry. Each factory function
 *     takes a different, hand-picked slice of `DoctorCheckOpts` (some need
 *     `dataDir` + `encryptionEnabled`, some need a raw boolean, some need
 *     none at all), and several are only pushed CONDITIONALLY (LLM/embed
 *     probes only when providers are supplied, backup-recency only when
 *     `backupsDir` is set, provider-specific supplementary checks only for
 *     matching `instanceof` branches). A directory-scan-and-auto-register
 *     pattern fits "every module exports one self-contained thing, register
 *     it" — it does not fit "build one ordered, conditionally-assembled
 *     array from options", which is what `coreChecks()` has always done and
 *     must keep doing to stay behavior-preserving.
 *
 * The residual cost is real and worth naming: two authors adding a check in
 * the same PR window can still collide on this file's import block and array
 * — but the collision is now a few single-line insertions (which git/rebase
 * resolves trivially, usually without even a manual conflict) instead of two
 * edits landing inside the same shared function body. That is the actual
 * problem this split solves; it does not (and cannot, while preserving
 * deterministic order over a non-uniform factory list) make this file
 * uncontended.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Check, CheckResult } from '../types.js';
import { OpenAICompatibleLLMProvider } from '../../providers/llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from '../../providers/llm/codex-subscription.js';
import { defaultConfig } from '../../config/config.js';
import type { DoctorCheckOpts } from './shared.js';

import { checkDatadirWritable } from './datadir-writable.js';
import { checkSqliteWritable } from './sqlite-writable.js';
import { checkSqliteVec } from './sqlite-vec.js';
import { checkFts5 } from './fts5.js';
import { checkDaemonReachable } from './daemon-reachable.js';
import { checkDiskFree } from './disk-free.js';
import { checkServiceUnit } from './service-unit.js';
import { checkServicePointer } from './service-pointer.js';
import { checkCrashLoop } from './crash-loop.js';
export { crashLoopStreakLength, CRASH_LOOP_THRESHOLD } from './crash-loop.js';
import { checkSchemaDrift } from './schema-drift.js';
import { checkBudget } from './budget.js';
import { checkBudgetCapCodexBlind } from './budget-cap-codex-blind.js';
import { checkConfigDirDivergence } from './config-dir-divergence.js';
import { checkRedaction } from './redaction.js';
import { checkEncryption } from './encryption.js';
import { checkBearerLocation } from './bearer-location.js';
import { checkSyncTokenLocation } from './sync-token-location.js';
import { checkSyncExperimentalGate } from './sync-experimental-gate.js';
import { checkUsefulness } from './usefulness.js';
import { checkUsefulnessFeedbackLoop } from './usefulness-feedback-loop.js';
import { checkMemoryHealth } from './memory-health.js';
import { checkDurabilityGateMode } from './durability-gate-mode.js';
import { checkExtractProfile } from './extract-profile.js';
import { checkDistillCostCap } from './distill-cost-cap.js';
import { checkEntityRelations } from './entity-relations.js';
import { checkEvidenceProvenance } from './evidence-provenance.js';
import { checkTranscriptSessionProvenance } from './transcript-session-provenance.js';
import { checkExtractionYield } from './extraction-yield.js';
import { checkEntityNameQuality } from './entity-name-quality.js';
import { checkAtomValidityExtraction } from './atom-validity-extraction.js';
import { checkEntityLinkRate } from './entity-link-rate.js';
import { checkVecIndex } from './vec-index.js';
import { checkConsolidationJudgeTelemetry } from './consolidation-judge.js';
import { checkAutoCapture } from './auto-capture.js';
import { checkProxyCapture } from './proxy-capture.js';
import { checkProxyCaptureReminder } from './proxy-capture-reminder.js';
import { checkMeetingCaptionsReminder } from './meeting-captions-reminder.js';
import { checkSpeakerAttributionRate } from './speaker-attribution-rate.js';
import { checkDevNoAuth } from './dev-no-auth.js';
import { checkSpoolQuarantine } from './spool-quarantine.js';
import { checkLLMChat } from './llm-chat.js';
import { checkEmbed } from './embed.js';
import { checkOnnxEmbedHealth } from './onnx-embed.js';
import { checkEmbedCacheHitRate } from './embed-cache.js';
import { checkOpenAICompatibleReachable, checkCodexAuth } from './provider-supplementary.js';
import { checkPluginCoexistence } from './plugin-coexistence.js';
import { checkPathShadow } from './path-shadow.js';
import { checkBackupRecency } from './backup-recency.js';
import { checkMemorySentinel } from './memory-sentinel.js';
import { checkMigrationSelfHeal } from './migration-self-heal.js';
import { checkHandlerRunLog } from './handler-run-log.js';
import { checkRetention } from './retention.js';
import { checkAudioAddon } from './audio-addon.js';
import { checkModelFitCanary } from './model-fit.js';

export type { Check, CheckResult };
export { openProductionDbReadonly, type DoctorCheckOpts } from './shared.js';

// ─── Registry ────────────────────────────────────────────────────────────────

const _registry: Check[] = [];

/**
 * Register an additional doctor check. Called by other tracks to extend the
 * doctor command without modifying this file.
 *
 * @param check - A Check object with `name` and `run()`.
 */
export function register(check: Check): void {
  _registry.push(check);
}

/**
 * Returns all currently registered checks (core + any added via register()).
 * The CLI doctor command passes this to runChecks().
 */
export function getChecks(
  opts: DoctorCheckOpts = {}
): Check[] {
  return [...coreChecks(opts), ..._registry];
}

// ─── Core check list builder ──────────────────────────────────────────────────

function coreChecks(opts: DoctorCheckOpts): Check[] {
  const port = opts.port ?? 7777;
  const dataDir = opts.dataDir ?? join(tmpdir(), 'astramem');
  const dailyBudgetUsd = opts.dailyBudgetUsd ?? 10;

  const encryptionEnabled = opts.encryptionEnabled ?? true;

  const checks: Check[] = [
    checkDatadirWritable(dataDir),
    checkSqliteWritable(dataDir, encryptionEnabled),
    checkSqliteVec(),
    checkFts5(),
    checkDaemonReachable(port),
    checkDiskFree(dataDir),
    checkServiceUnit(opts.serviceUnitPath),
    checkServicePointer(opts.servicePointerPath, opts.releasesRoot),
    checkCrashLoop(dataDir),
    checkSchemaDrift(dataDir, encryptionEnabled, opts.servicePointerPath, opts.releasesRoot),
    checkBudget(dataDir, dailyBudgetUsd, encryptionEnabled),
    checkBudgetCapCodexBlind(dailyBudgetUsd, opts.codexSubscriptionInUse ?? false),
    checkConfigDirDivergence(),
    checkPathShadow(),
    checkRedaction(
      dataDir, opts.redactionEnabled ?? true, encryptionEnabled,
      // FEAT-498: same enablement signals checkProxyCapture/checkAutoCapture
      // read below — computed once here so "what counts as active capture"
      // has one definition.
      (opts.autoCaptureEnabled ?? false) || ((opts.proxyEnabled ?? false) && (opts.proxyCaptureEnabled ?? false)),
    ),
    checkEncryption(dataDir, encryptionEnabled),
    checkBearerLocation(),
    checkSyncTokenLocation(),
    checkSyncExperimentalGate(opts.syncEnabled ?? false, opts.syncExperimental ?? false),
    checkUsefulness(dataDir, encryptionEnabled),
    checkUsefulnessFeedbackLoop(dataDir, encryptionEnabled),
    checkMemoryHealth(dataDir, encryptionEnabled),
    checkDurabilityGateMode(opts.durabilityGateMode ?? 'off'),
    checkExtractProfile(opts.extractProfile ?? 'engineering'),
    checkDistillCostCap(opts.distillCostCap),
    checkEntityRelations(dataDir, opts.extractProfile ?? 'engineering', encryptionEnabled),
    checkEvidenceProvenance(dataDir, encryptionEnabled),
    checkSpeakerAttributionRate(dataDir, encryptionEnabled),
    checkTranscriptSessionProvenance(dataDir, encryptionEnabled),
    checkExtractionYield(dataDir, encryptionEnabled),
    checkEntityNameQuality(dataDir, encryptionEnabled),
    checkAtomValidityExtraction(dataDir, encryptionEnabled),
    checkEntityLinkRate(dataDir, encryptionEnabled),
    checkVecIndex(dataDir, encryptionEnabled),
    checkConsolidationJudgeTelemetry(dataDir, encryptionEnabled),
    checkAutoCapture(dataDir, opts.autoCaptureEnabled ?? false, encryptionEnabled),
    checkProxyCapture(
      dataDir,
      opts.proxyEnabled ?? false,
      opts.proxyExperimental ?? false,
      opts.proxyCaptureEnabled ?? false,
      encryptionEnabled,
    ),
    checkProxyCaptureReminder(opts.proxyEnabled ?? false, opts.proxyCaptureEnabled ?? false),
    checkMeetingCaptionsReminder(opts.meetingCaptionsEnabled ?? false),
    checkDevNoAuth(opts.devNoAuthActive ?? false),
    checkSpoolQuarantine(dataDir),
    checkEmbedCacheHitRate(dataDir, encryptionEnabled),
    checkMemorySentinel(),
    checkMigrationSelfHeal(dataDir, encryptionEnabled),
    checkHandlerRunLog(dataDir, encryptionEnabled),
    checkRetention(dataDir, opts.retentionConfig ?? defaultConfig().retention),
    checkAudioAddon(opts.audioMode ?? 'off', opts.audioDisclosureAcknowledged ?? false),
    // Issue #279: `reinstall` never rewrites an existing operator's pinned
    // llm.compaction/extraction.model, so a bad pin (qwen3:8b — doesn't fit
    // an 8 GB VRAM card) survives every upgrade forever. See model-fit.ts's
    // module doc comment.
    checkModelFitCanary(opts.llmConfig ?? defaultConfig().llm, { ollamaBaseUrl: opts.ollamaBaseUrl }),
  ];

  // LLM chat probes — real 1-token call, replaces surface-only /api/tags checks.
  // Run extraction separately only when it uses a different provider/model.
  if (opts.llmProviders) {
    const { compaction, extraction } = opts.llmProviders;
    checks.push(checkLLMChat(compaction, 'compaction'));
    const sameProvider =
      compaction.name === extraction.name && compaction.model === extraction.model;
    if (!sameProvider) {
      checks.push(checkLLMChat(extraction, 'extraction'));
    }

    // Provider-specific supplementary checks (openai-compatible reachability,
    // codex-subscription auth.json presence/expiry) — additive to, not a
    // replacement for, the generic chat probe above.
    for (const [provider, label] of (
      sameProvider ? [[compaction, 'compaction'] as const] : [[compaction, 'compaction'] as const, [extraction, 'extraction'] as const]
    )) {
      if (provider instanceof OpenAICompatibleLLMProvider) {
        checks.push(checkOpenAICompatibleReachable(provider, label));
      }
      if (provider instanceof CodexSubscriptionLLMProvider) {
        checks.push(checkCodexAuth(provider, label));
      }
    }
  }

  // Embed probe — real embed call + config-derived dim assertion (FEAT-409).
  if (opts.embedProvider) {
    checks.push(checkEmbed(opts.embedProvider));

    // ADR-018 SLICE-2: additive, onnx-specific supplementary check — only
    // when the configured embed provider IS onnx (see onnx-embed.ts's doc
    // comment for why 'full' tier and why this doesn't duplicate checkEmbed
    // above). Gated on `.name === 'onnx'` rather than `instanceof
    // OnnxEmbedProvider` (ADR-019 Decision 2(d)): buildEmbedProvider now
    // returns OnnxWorkerHostProvider — a worker_thread-backed proxy, not an
    // OnnxEmbedProvider instance — for `provider: 'onnx'`. Both classes set
    // `readonly name = 'onnx'`, so this keeps the gate correct regardless of
    // which concrete EmbedProvider implementation is behind the interface.
    if (opts.embedProvider.name === 'onnx') {
      checks.push(checkOnnxEmbedHealth(opts.embedProvider));
    }
  }

  // Plugin coexistence — warn if MEMORY_API_URL or .mcp.json points elsewhere.
  checks.push(checkPluginCoexistence(port));

  // Backup recency — optional; only added when caller supplies a backupsDir.
  if (opts.backupsDir) {
    checks.push(checkBackupRecency(opts.backupsDir));
  }

  return checks;
}
