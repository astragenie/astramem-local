/**
 * init wizard — `astramem-local init`
 *
 * Interactive setup using @inquirer/prompts.
 * Non-TTY / CI mode: set ASTRA_MEMORY_INIT_NONINTERACTIVE=1 and supply
 * answers via env vars (see NON_INTERACTIVE_ENV below).
 *
 * Final actions:
 *  1. Write config.yaml  → defaultConfigDir()/config.yaml
 *  2. Write secrets.env  → defaultConfigDir()/secrets.env (mode 0600)
 *  3. Run migrations     → ensure DB schema at dataDir/memory.sqlite
 *  4. Run doctor checks  → print table (skip daemon-reachable check)
 *  5. Print next steps
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { defaultConfig, type Config } from '../config/config.js';
import { defaultConfigDir, defaultDataDir } from '../config/datadir.js';
import { writeConfig } from '../config/writer.js';
import { writeSecrets } from '../config/secrets.js';
import { generateToken } from './token.js';
import { storeBearer } from '../storage/keystore.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { getChecks } from '../doctor/checks.js';
import { runChecks, formatTable } from '../doctor/runner.js';
import { mkdirSync } from 'node:fs';
import { persistEnvVars } from '../config/persist-envs.js';
import { waitForHealth } from './wait-health.js';
import { installServiceFlow } from '../service/install-flow.js';
import { installMemoryPackHook } from './hook-install.js';
import { activateGitHooks } from '../service/git-hooks-activate.js';
import { defaultAuthPath as defaultCodexAuthPath, hasCodexLogin } from '../providers/llm/codex-subscription.js';

// ─── Non-interactive env var map ─────────────────────────────────────────────

const NON_INTERACTIVE_ENV = {
  vector: 'ASTRA_MEMORY_INIT_VECTOR',
  embedProvider: 'ASTRA_MEMORY_INIT_EMBED_PROVIDER',
  llmProvider: 'ASTRA_MEMORY_INIT_LLM_PROVIDER',
  dataDir: 'ASTRA_MEMORY_INIT_DATADIR',
  port: 'ASTRA_MEMORY_INIT_PORT',
  budget: 'ASTRA_MEMORY_INIT_BUDGET',
  installService: 'ASTRA_MEMORY_INIT_INSTALL_SERVICE',
  installHook: 'ASTRA_MEMORY_INIT_INSTALL_HOOK',
  openaiCompatBaseUrl: 'ASTRA_MEMORY_INIT_OPENAI_COMPAT_BASE_URL',
  openaiCompatApiKey: 'ASTRA_MEMORY_INIT_OPENAI_COMPAT_API_KEY',
  codexAuthPath: 'ASTRA_MEMORY_INIT_CODEX_AUTH_PATH',
  // Ollama on-demand overrides (interactive-only concepts otherwise — see
  // promptOllamaModelTier / promptOllamaSetup below). Non-interactive mode
  // has no "setup mode" concept (it always keeps the legacy env-driven
  // auto-pull-if-missing behavior), but the model tag and a custom base URL
  // are still useful to override for scripted/CI installs.
  ollamaModelTag: 'ASTRA_MEMORY_INIT_OLLAMA_MODEL_TAG',
  ollamaBaseUrl: 'ASTRA_MEMORY_INIT_OLLAMA_BASE_URL',
} as const;

/** LLM provider values the wizard can select for compaction/extraction. */
type LlmProviderChoice = 'ollama' | 'azure-openai' | 'openai-compatible' | 'codex-subscription';

/** Default Ollama extraction/compaction model — used when no tier is chosen.
 * Swapped from qwen3.5:4b to qwen2.5:7b (2026-07-14) — qwen3.5:4b was
 * RETIRED because it under-extracts atoms in real conversational sessions
 * (see the LoCoMo conversational-profile A/B in CLAUDE.md); a fast, VRAM-safe
 * model that finds too little is not actually a safe default. qwen2.5:7b is
 * the recommended local model instead: F1 67%/precision 99% in the
 * 2026-07-08 extraction-bench A/B (beats qwen2.5-coder:7b's F1 59%). It is
 * ~4.7 GB and fits an 8 GB VRAM card with real headroom alongside the
 * mxbai-embed-large embedder's ~0.59 GB — unlike qwen3:8b (5.76 GB
 * resident), which exceeded the ceiling, spilled layers to CPU, and poisoned
 * distill jobs via timeout (see "Ollama 8GB VRAM ceiling" in CLAUDE.md).
 * This is a safety + measured-extraction-quality case, not a
 * measured-compaction-quality case — nobody has benchmarked either model as
 * a compactor specifically; see scripts/eval/extraction-bench. */
export const DEFAULT_OLLAMA_LLM_MODEL = 'qwen2.5:7b';

/** Default Ollama embedding model (fixed — the wizard doesn't offer a tier
 * picker for embeddings, only for the extraction/compaction LLM). */
const DEFAULT_OLLAMA_EMBED_MODEL = 'mxbai-embed-large';

/**
 * Extraction/compaction model tier offered by the wizard when the LLM
 * provider is Ollama. Size + RAM figures are approximate download/footprint
 * guidance surfaced to the user before any pull happens (see
 * `confirmOllamaDownload` below) — not enforced, just informative.
 *
 * Only one curated tier as of 2026-07-14: qwen2.5:7b, restored as
 * RECOMMENDED/default (2026-07-14) after qwen3.5:4b — the brief same-day-
 * reversal pick from 2026-07-13 — proved to under-extract atoms from real
 * conversational transcripts (see DEFAULT_OLLAMA_LLM_MODEL's comment above).
 * qwen2.5:7b scores F1 67%/precision 99% in the 2026-07-08 A/B benchmark —
 * the strongest local model measured on actual atom extraction — and fits
 * this hardware class (~4.7 GB resident vs qwen3:8b's 5.76 GB, which spills
 * VRAM and poisons distill jobs). `qwen2.5-coder:7b` remains dropped (the
 * former "fastest" tier at F1 59%); `qwen2.5-coder:14b` remains dropped (20%
 * permanent-failure/poison rate, 72.7s/session in the same benchmark);
 * `llama3.1:8b` remains dropped per operator decision (~3x latency vs
 * qwen2.5:7b at comparable F1). Any of these, or another model, is still
 * reachable via the "custom" tier below.
 */
const OLLAMA_EXTRACTION_TIERS: { value: string; label: string; size: string; ram: string; stats: string }[] = [
  { value: 'qwen2.5:7b', label: 'RECOMMENDED (default)', size: '~4.7 GB', ram: '8 GB', stats: 'F1 67%, precision 99% (extraction-bench, 2026-07-08 A/B)' },
];

/** Sentinel values for the non-model tier-picker choices (item 3/4). One of
 * them ("BYO cloud") pivots into the full cloud LLM provider choice
 * (azure-openai / openai-compatible / codex-subscription) — see
 * `gatherInteractive`'s tier-picker block below. */
const OLLAMA_TIER_BYO_CLOUD = '__byo_cloud__';
const OLLAMA_TIER_CUSTOM = '__custom__';

/** Download-size / RAM guidance for every model the wizard might pull,
 * keyed by model tag — covers the two extraction tiers plus the fixed
 * embedding model. Unrecognized (custom) tags fall back to an
 * "unknown — check `ollama show`" note in `describeOllamaModel` below. */
const OLLAMA_MODEL_INFO: Record<string, { size: string; ram: string }> = {
  ...Object.fromEntries(OLLAMA_EXTRACTION_TIERS.map((t) => [t.value, { size: t.size, ram: t.ram }])),
  [DEFAULT_OLLAMA_EMBED_MODEL]: { size: '~670 MB', ram: '8 GB' },
};

/** Test-only injection point for the hook install target (see hook-install.ts). */
const SETTINGS_PATH_ENV = 'ASTRA_MEMORY_INIT_SETTINGS_PATH';

function isNonInteractive(): boolean {
  return process.env['ASTRA_MEMORY_INIT_NONINTERACTIVE'] === '1';
}

// ─── Inquirer lazy import (skip in non-TTY to avoid ESM overhead) ─────────────

async function promptSelect(
  message: string,
  choices: { name: string; value: string }[],
  defaultValue: string
): Promise<string> {
  const { select } = await import('@inquirer/prompts');
  return select({ message, choices, default: defaultValue });
}

async function promptInput(message: string, defaultValue: string): Promise<string> {
  const { input } = await import('@inquirer/prompts');
  return input({ message, default: defaultValue });
}

async function promptPassword(message: string): Promise<string> {
  const { password } = await import('@inquirer/prompts');
  return password({ message, mask: '*' });
}

async function promptConfirm(message: string, defaultValue: boolean): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message, default: defaultValue });
}

// ─── Wizard answers ───────────────────────────────────────────────────────────

interface WizardAnswers {
  vector: 'sqlite-vec' | 'lancedb';
  embedProvider: 'ollama' | 'azure-openai';
  llmProvider: LlmProviderChoice;
  dataDir: string;
  port: number;
  budget: number;
  installService: boolean;
  // Azure-only
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiKey?: string;
  // openai-compatible-only
  openaiCompatBaseUrl?: string;
  openaiCompatApiKey?: string;
  // codex-subscription-only (EXPERIMENTAL)
  codexAuthPath?: string;
  // Ollama-only (present when llmProvider and/or embedProvider is 'ollama')
  /** Chosen extraction/compaction model tag (tier pick or custom). Only
   * asked when llmProvider === 'ollama'. Falls back to
   * DEFAULT_OLLAMA_LLM_MODEL when unset. */
  ollamaModelTag?: string;
  /** How the wizard should get Ollama ready — install/pull now, point at an
   * already-running server, or skip entirely (daemon starts degraded).
   * Interactive-only; non-interactive mode has no concept of this and keeps
   * the legacy always-attempt-pull behavior. */
  ollamaMode?: 'install' | 'url' | 'skip';
  /** Base URL of an existing Ollama server — set when ollamaMode === 'url',
   * or via the non-interactive env override. */
  ollamaBaseUrl?: string;
}

// ─── Gather answers (interactive path) ───────────────────────────────────────

async function gatherInteractive(): Promise<WizardAnswers> {
  console.log('\nAstraMemory Local — setup wizard\n');

  const vector = (await promptSelect(
    'Vector store:',
    [
      { name: 'sqlite-vec (recommended)', value: 'sqlite-vec' },
      { name: 'lancedb (not yet implemented)', value: 'lancedb' },
    ],
    'sqlite-vec'
  )) as 'sqlite-vec' | 'lancedb';

  const embedProvider = (await promptSelect(
    'Embedding provider:',
    [
      { name: 'ollama (local, free)', value: 'ollama' },
      { name: 'azure-openai (cloud, ~$0)', value: 'azure-openai' },
    ],
    'ollama'
  )) as 'ollama' | 'azure-openai';

  // codex-subscription is only offered when a Codex CLI login is already
  // present — there is nothing useful to configure otherwise, and offering
  // it unconditionally would just lead every user into a `codex login` dead
  // end before they've even heard of the Codex CLI.
  const codexAuthPath = defaultCodexAuthPath();
  const codexLoginDetected = existsSync(codexAuthPath);

  // Shared cloud-provider choice list — also reused below by the
  // extraction-model tier picker's "BYO cloud" pivot, so that pivot lands on
  // the same full provider set (azure-openai / openai-compatible /
  // codex-subscription) rather than hard-coding azure-openai.
  const cloudLlmChoices: { name: string; value: string }[] = [
    { name: 'azure-openai (gpt-4.1)', value: 'azure-openai' },
    { name: 'openai-compatible (OpenAI API, Groq, vLLM, ...)', value: 'openai-compatible' },
  ];
  if (codexLoginDetected) {
    cloudLlmChoices.push({
      name: 'Use your ChatGPT/Codex login (experimental — uses your ChatGPT subscription quota)',
      value: 'codex-subscription',
    });
  }

  // Mutable: the extraction-model tier picker below offers a "BYO cloud"
  // option that pivots this from 'ollama' to whichever cloud provider the
  // user then picks (see promptOllamaModelTier / OLLAMA_TIER_BYO_CLOUD).
  //
  // v0.18.0: codex-subscription is the DEFAULT LLM provider selection —
  // local-ollama qwen defaults have repeatedly broken in production (empty
  // output under thinking mode, VRAM spill; see CLAUDE.md "qwen3:8b breaks
  // distill extract" / "Ollama 8GB VRAM ceiling"). codex-subscription is
  // only ever offered as a *choice* when a Codex CLI login is already
  // detected (see cloudLlmChoices above), so it can only be the pre-
  // highlighted default when it's actually selectable — fall back to
  // ollama as the default pick otherwise. ollama and the other cloud
  // providers remain fully selectable regardless of the default.
  let llmProvider = (await promptSelect(
    'LLM provider:',
    [{ name: 'ollama (qwen2.5:7b)', value: 'ollama' }, ...cloudLlmChoices],
    codexLoginDetected ? 'codex-subscription' : 'ollama'
  )) as LlmProviderChoice;

  const dataDir = await promptInput('Data directory:', defaultDataDir());
  const portStr = await promptInput('Daemon port:', '7777');
  const budgetStr = await promptInput('Daily LLM budget cap (USD):', '10');
  const installService = await promptConfirm('Install as OS service?', true);

  const answers: WizardAnswers = {
    vector,
    embedProvider,
    llmProvider,
    dataDir,
    port: parseInt(portStr, 10) || 7777,
    budget: parseFloat(budgetStr) || 10,
    installService,
  };

  // Extraction/compaction model tier — only when the LLM stages are on
  // Ollama. One of the choices is "BYO cloud", which pivots llmProvider into
  // the same full cloud-provider choice offered above (azure-openai /
  // openai-compatible / codex-subscription) instead of picking a local
  // model tag — handled before the Azure-prompt block below so a pivot here
  // still gets its credentials gathered in the normal place.
  if (llmProvider === 'ollama') {
    const tierChoice = await promptOllamaModelTier();
    if (tierChoice === OLLAMA_TIER_BYO_CLOUD) {
      llmProvider = (await promptSelect('Cloud LLM provider:', cloudLlmChoices, 'azure-openai')) as LlmProviderChoice;
      answers.llmProvider = llmProvider;
    } else {
      answers.ollamaModelTag = tierChoice;
    }
  }

  // Azure-specific prompts — gathered whenever azure ends up needed for
  // either stage, including a BYO-cloud pivot from the tier picker above.
  if (embedProvider === 'azure-openai' || llmProvider === 'azure-openai') {
    answers.azureEndpoint = await promptInput(
      'Azure OpenAI endpoint (https://your-resource.openai.azure.com):',
      ''
    );
    answers.azureDeployment = await promptInput(
      'Azure OpenAI deployment name:',
      ''
    );
    answers.azureApiKey = await promptPassword('Azure OpenAI API key:');
  }

  // openai-compatible-specific prompts
  if (llmProvider === 'openai-compatible') {
    answers.openaiCompatBaseUrl = await promptInput(
      'OpenAI-compatible base URL (e.g. https://api.openai.com/v1, http://localhost:8000/v1):',
      'https://api.openai.com/v1'
    );
    answers.openaiCompatApiKey = await promptPassword(
      'API key (leave blank if the endpoint needs none, e.g. local vLLM):'
    );
  }

  // codex-subscription: no further prompts needed — auth.json is already
  // present (that's why this choice was offered). Just surface the
  // experimental/ToS warning up front so it isn't buried in a log line.
  if (llmProvider === 'codex-subscription') {
    console.log(
      '\n  codex-subscription is EXPERIMENTAL: extraction/compaction traffic will transit your\n' +
        '  ChatGPT subscription via an unofficial endpoint and may carry ToS risk for your OpenAI\n' +
        '  account. See docs/providers.md before relying on this in production.\n'
    );
    answers.codexAuthPath = codexAuthPath;
  }

  // Ollama is now ON-DEMAND, not hard-required: whenever either provider
  // selection (post-pivot) implies Ollama, ask how the user wants to get it
  // ready rather than silently assuming a local install/pull is wanted.
  if (llmProvider === 'ollama' || embedProvider === 'ollama') {
    const setup = await promptOllamaSetup();
    answers.ollamaMode = setup.mode;
    answers.ollamaBaseUrl = setup.baseUrl;
  }

  return answers;
}

/**
 * Extraction/compaction model tier picker (item 2; single curated tier as of
 * 2026-07-13 — see OLLAMA_EXTRACTION_TIERS's comment) — offered only when the
 * LLM provider is Ollama. Three choices: the one curated local tier, a "BYO
 * cloud" pivot to the existing cloud provider option (best type-accuracy, no
 * local resource cost), and a free-text custom tag. Returns either a model
 * tag or OLLAMA_TIER_BYO_CLOUD.
 */
async function promptOllamaModelTier(): Promise<string> {
  const choices = [
    ...OLLAMA_EXTRACTION_TIERS.map((t) => ({
      name: `${t.value} — ${t.label} (${t.size} download, ${t.ram} RAM recommended; ${t.stats})`,
      value: t.value,
    })),
    { name: 'BYO cloud (azure-openai — best type-accuracy, no local resource cost)', value: OLLAMA_TIER_BYO_CLOUD },
    { name: 'custom (enter your own Ollama model tag)', value: OLLAMA_TIER_CUSTOM },
  ];
  // Recommended tier (DEFAULT_OLLAMA_LLM_MODEL) is the pre-highlighted
  // choice — fixed here to match the actual curated tier value (was stale
  // "llama3.1:8b", a value not present in `choices` since that tier was
  // dropped, found while doing this sweep; harmless with @inquirer/prompts,
  // which falls back to the first choice, but worth not leaving in place).
  const choice = await promptSelect('Extraction model (Ollama):', choices, DEFAULT_OLLAMA_LLM_MODEL);
  if (choice === OLLAMA_TIER_CUSTOM) {
    return promptInput('Custom Ollama model tag:', DEFAULT_OLLAMA_LLM_MODEL);
  }
  return choice;
}

/** Ollama on-demand setup picker (item 1) — three paths: install/pull now,
 * point at an already-running server, or skip (daemon starts degraded). */
async function promptOllamaSetup(): Promise<{ mode: 'install' | 'url' | 'skip'; baseUrl?: string }> {
  const mode = (await promptSelect(
    'Ollama setup:',
    [
      { name: 'Install/pull the required model(s) now', value: 'install' },
      { name: 'Point at an existing Ollama server (already running elsewhere)', value: 'url' },
      { name: 'Skip for now — daemon starts degraded until Ollama is available', value: 'skip' },
    ],
    'install'
  )) as 'install' | 'url' | 'skip';

  if (mode === 'url') {
    const baseUrl = await promptInput('Ollama base URL:', 'http://127.0.0.1:11434');
    return { mode, baseUrl };
  }
  return { mode };
}

/** Per-OS Ollama install guidance — shown when the wizard needs to prompt
 * about a missing `ollama` binary (checkOllama) instead of burying it in a
 * console.warn the user might not notice. */
function ollamaInstallGuidance(): string {
  switch (process.platform) {
    case 'darwin':
      return '  macOS: brew install ollama   (or download from https://ollama.com)';
    case 'linux':
      return '  Linux: curl -fsSL https://ollama.com/install.sh | sh';
    case 'win32':
      return '  Windows: download OllamaSetup.exe from https://ollama.com/download/windows';
    default:
      return '  Install from https://ollama.com';
  }
}

/** Describes size/RAM guidance for a single model tag, falling back to an
 * "unknown — custom tag" note for anything outside the curated tiers. */
function describeOllamaModel(model: string): string {
  const info = OLLAMA_MODEL_INFO[model];
  return info
    ? `    - ${model}  (${info.size} download, ~${info.ram} RAM recommended)`
    : `    - ${model}  (size unknown — custom tag; check \`ollama show ${model}\` once installed)`;
}

/** Pre-pull notice + confirmation for the "install/pull now" Ollama-setup
 * path (item 1): shows per-model download size and the "first run may take
 * 10-30 min" warning BEFORE any network activity, then asks to proceed. */
async function confirmOllamaDownload(models: string[]): Promise<boolean> {
  console.log('\n  Ollama will download the following model(s):\n');
  for (const m of models) console.log(describeOllamaModel(m));
  console.log('\n  First run may take 10-30 min depending on connection speed and model size.\n');
  return promptConfirm('Proceed with download now?', true);
}

// ─── Gather answers (non-interactive / test path) ─────────────────────────────

function gatherNonInteractive(): WizardAnswers {
  const vector = (process.env[NON_INTERACTIVE_ENV.vector] ?? 'sqlite-vec') as 'sqlite-vec' | 'lancedb';
  const embedProvider = (process.env[NON_INTERACTIVE_ENV.embedProvider] ?? 'ollama') as 'ollama' | 'azure-openai';
  // v0.18.0: shipped default flipped to codex-subscription (see
  // gatherInteractive's llmProvider prompt comment for rationale) — the
  // non-TTY path has no "codex login detected" concept to gate on, so it
  // always writes the new default unless the caller overrides via env.
  const llmProvider = (process.env[NON_INTERACTIVE_ENV.llmProvider] ?? 'codex-subscription') as LlmProviderChoice;
  const dataDir = process.env[NON_INTERACTIVE_ENV.dataDir] ?? defaultDataDir();
  const port = parseInt(process.env[NON_INTERACTIVE_ENV.port] ?? '7777', 10) || 7777;
  const budget = parseFloat(process.env[NON_INTERACTIVE_ENV.budget] ?? '10') || 10;
  const installService = (process.env[NON_INTERACTIVE_ENV.installService] ?? 'false') === 'true';
  const openaiCompatBaseUrl = process.env[NON_INTERACTIVE_ENV.openaiCompatBaseUrl];
  const openaiCompatApiKey = process.env[NON_INTERACTIVE_ENV.openaiCompatApiKey];
  const codexAuthPath = process.env[NON_INTERACTIVE_ENV.codexAuthPath];
  const ollamaModelTag = process.env[NON_INTERACTIVE_ENV.ollamaModelTag];
  const ollamaBaseUrl = process.env[NON_INTERACTIVE_ENV.ollamaBaseUrl];

  // First-run guard: unlike gatherInteractive (which only ever offers
  // codex-subscription as a choice when codexLoginDetected is true, see
  // above), this non-TTY path has no such gate — it always resolves
  // llmProvider to the shipped codex-subscription default regardless of
  // whether `codex login` has ever run. Writing that config silently would
  // reproduce the exact "every distill call throws, poison-rate canary
  // stays quiet below MEANINGFUL_USAGE_THRESHOLD" footgun this guard exists
  // to close (see architect review answer 6). This warns but does not
  // block or rewrite the choice — a scripted/CI install may intentionally
  // provision a login that arrives later.
  if (llmProvider === 'codex-subscription' && !hasCodexLogin(codexAuthPath)) {
    console.warn(
      `\n  WARNING: codex-subscription selected but no Codex CLI login found at ` +
      `${codexAuthPath ?? defaultCodexAuthPath()}.\n` +
      '  Every extraction/compaction call will fail until you run `codex login`.\n' +
      `  Alternative: set ${NON_INTERACTIVE_ENV.llmProvider}=ollama before init to use the ` +
      `local Ollama default (${DEFAULT_OLLAMA_LLM_MODEL}) instead.\n`,
    );
  }

  return {
    vector, embedProvider, llmProvider, dataDir, port, budget, installService,
    openaiCompatBaseUrl, openaiCompatApiKey, codexAuthPath,
    ollamaModelTag, ollamaBaseUrl,
  };
}

// ─── Conditional provider checks ─────────────────────────────────────────────

/**
 * Query the local Ollama daemon and report whether `model` is present.
 * Shared by the initial detection pass and the post-pull re-validation
 * so there is a single source of truth for "is this model here".
 */
async function isOllamaModelPresent(model: string): Promise<boolean> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.json() as { models?: { name: string }[] };
    const names = (body.models ?? []).map((m: { name: string }) => m.name);
    return names.some((n: string) => n === model || n.startsWith(model + ':'));
  } finally {
    clearTimeout(tid);
  }
}

/**
 * @param llmModel undefined when the LLM provider isn't actually Ollama —
 *   only pass a value for the slot(s) assigned to the ollama provider, so a
 *   mixed setup (e.g. llmProvider=azure-openai, embedProvider=ollama) never
 *   ends up trying to `ollama pull gpt-4.1`.
 * @param confirmMissingBinary injection point for the missing-binary prompt
 *   (default: a real inquirer confirm) — lets tests exercise both the
 *   "user declines, init aborts" and "user continues, degraded" branches
 *   without invoking a live TTY prompt.
 */
export async function checkOllama(
  llmModel: string | undefined,
  embedModel: string | undefined,
  nonInteractive: boolean,
  confirmMissingBinary: (message: string) => Promise<boolean> = (msg) => promptConfirm(msg, false),
): Promise<void> {
  if (nonInteractive) return; // skip live HTTP in test mode

  // Check ollama binary. Previously this silently warned and "sailed on" —
  // now it's an explicit prompt (with per-OS install guidance) so a missing
  // Ollama install is a deliberate choice, not a buried warn the user might
  // scroll past. Degraded start is still the fallback if they choose to
  // continue — same /health degraded behavior as any other missing provider.
  let ollamaFound = false;
  try {
    // `ollama --version` is a lightweight CLI query, not the PowerShell
    // cold-start class — 10s is generous. The timeout exists so a hung
    // binary can't block init forever with zero signal (previously
    // unbounded). stdio 'ignore' means a timeout and a genuine
    // "not installed" both throw with no captured output, so the two are
    // distinguished below via err.signal, not by message content.
    execSync('ollama --version', { stdio: 'ignore', timeout: 10_000 });
    ollamaFound = true;
  } catch (err) {
    // execSync sets `.signal` (e.g. 'SIGTERM') when its own timeout kills
    // the child — that is an infrastructure failure (Ollama is installed
    // but wedged), not the domain fact "not installed" (ENOENT / non-zero
    // exit, no signal). Collapsing the two into one message would be
    // exactly the ADR-015 failure this init flow exists to avoid.
    const timedOut = (err as { signal?: string | null }).signal != null;
    if (timedOut) {
      console.log(
        `\n  'ollama --version' did not respond within 10s — Ollama may be installed but hung/unresponsive, ` +
        `not necessarily missing.\n${ollamaInstallGuidance()}\n`,
      );
    } else {
      console.log(`\n  Ollama is not installed, but is required for the selected provider.\n${ollamaInstallGuidance()}\n`);
    }
    const proceed = await confirmMissingBinary(
      'Continue without it? (the daemon will start degraded until Ollama is installed and reachable)'
    );
    if (!proceed) {
      throw new Error(
        (timedOut
          ? "Could not verify Ollama is installed — 'ollama --version' timed out.\n"
          : 'Ollama is not installed.\n') +
          `${ollamaInstallGuidance()}\n` +
          '  Install it and re-run `astramem-local init`, or choose a different provider.'
      );
    }
    console.log('  · Continuing without Ollama — daemon will start degraded until Ollama is installed.\n');
    return;
  }

  if (!ollamaFound) return;

  // Check models present — auto-pull anything missing so the daemon
  // doesn't fail later at embed/LLM preflight with a 404 "model not found".
  // Callers pass undefined for whichever slot (llm/embed) isn't actually
  // assigned to the ollama provider — only check the ones that are.
  const modelsToCheck = [...new Set([llmModel, embedModel].filter((m): m is string => Boolean(m)))];
  for (const model of modelsToCheck) {
    let found: boolean;
    try {
      found = await isOllamaModelPresent(model);
    } catch {
      console.warn(`\n  Warning: Could not reach Ollama at :11434. Is it running?\n`);
      continue;
    }

    if (found) {
      console.log(`  ✓ Ollama model '${model}' present`);
      continue;
    }

    console.log(`\n  Model '${model}' not found locally.`);
    console.log(`  Pulling ${model} (required)...`);
    try {
      // Deliberately unbounded: this is a multi-GB network download, not the
      // cold-shell-startup class this file's other timeouts guard against —
      // a fixed timeout here would abort legitimate slow pulls, not catch a
      // hang. stdio 'inherit' streams ollama's own progress straight to the
      // terminal, so a stalled pull is visible to the user, not silent.
      execFileSync('ollama', ['pull', model], { stdio: 'inherit' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to pull Ollama model '${model}': ${msg}\n  Run manually: ollama pull ${model}`
      );
    }

    let pulled: boolean;
    try {
      pulled = await isOllamaModelPresent(model);
    } catch {
      pulled = false;
    }
    if (!pulled) {
      throw new Error(
        `Ollama model '${model}' still not found after pull.\n  Run manually: ollama pull ${model}`
      );
    }
    console.log(`  ✓ Ollama model '${model}' pulled successfully`);
  }
}

async function checkAzure(endpoint: string, deployment: string, apiKey: string, nonInteractive: boolean): Promise<void> {
  if (nonInteractive) return; // skip live HTTP in test mode
  if (!endpoint || !deployment || !apiKey) {
    console.warn('  Warning: Azure credentials incomplete — skipping connectivity check.');
    return;
  }

  try {
    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    clearTimeout(tid);
    if (res.ok || res.status === 400) {
      // 400 can mean bad request but creds are valid
      console.log('  ✓ Azure OpenAI endpoint reachable');
    } else {
      console.warn(`  Warning: Azure endpoint returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`  Warning: Could not reach Azure endpoint: ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Build config from answers ────────────────────────────────────────────────

/** Default model per LLM provider choice — mirrors the equivalent switch in
 * the `init()` flow's Ollama-model-check block below. */
function defaultLlmModelFor(provider: LlmProviderChoice): string {
  switch (provider) {
    case 'azure-openai': return 'gpt-4.1';
    case 'openai-compatible': return 'gpt-4o-mini';
    case 'codex-subscription': return 'gpt-5.4-mini'; // see providers/llm/codex-subscription.ts DEFAULT_MODEL
    case 'ollama': default: return DEFAULT_OLLAMA_LLM_MODEL;
  }
}

function buildConfig(answers: WizardAnswers): Config {
  const base = defaultConfig();

  // Ollama picks up the user's tier choice (or the default tier); every
  // other provider (azure-openai / openai-compatible / codex-subscription)
  // uses its fixed per-provider default model.
  const llmModel = answers.llmProvider === 'ollama'
    ? (answers.ollamaModelTag ?? DEFAULT_OLLAMA_LLM_MODEL)
    : defaultLlmModelFor(answers.llmProvider);
  const embedModel = answers.embedProvider === 'azure-openai' ? 'text-embedding-3-small' : DEFAULT_OLLAMA_EMBED_MODEL;

  return {
    ...base,
    port: answers.port,
    dataDir: answers.dataDir,
    llm: {
      compaction: { provider: answers.llmProvider, model: llmModel },
      extraction: { provider: answers.llmProvider, model: llmModel },
    },
    embedding: {
      provider: answers.embedProvider,
      model: embedModel,
      // FEAT-409: derived from base.embedding.dim (DEFAULT_EMBED_DIM) —
      // the wizard doesn't yet expose a dim override, so this stays the
      // default until a future non-default-dim onboarding flow is added.
      dim: base.embedding.dim,
    },
    vector: { store: answers.vector === 'lancedb' ? 'sqlite-vec' : answers.vector },
    budget: { daily_usd: answers.budget },
    ollama: {
      ...base.ollama,
      baseUrl: answers.ollamaBaseUrl ?? base.ollama.baseUrl,
    },
    azure: {
      ...base.azure,
      endpoint: answers.azureEndpoint,
      deployment: answers.azureDeployment,
    },
    openaiCompatible: {
      ...base.openaiCompatible,
      baseUrl: answers.openaiCompatBaseUrl,
    },
    codexSubscription: {
      ...base.codexSubscription,
      authPath: answers.codexAuthPath,
    },
  };
}

// ─── SessionStart memory-pack hook offer ──────────────────────────────────────

/**
 * Decide whether to install the SessionStart memory-pack hook (KF-B
 * follow-up, docs/hooks/memory-pack.md). Offered after the token/provider
 * setup steps so the daemon port + bearer are already settled.
 *
 * - `--no-hook` on the CLI, or non-interactive mode without the
 *   `ASTRA_MEMORY_INIT_INSTALL_HOOK=true` override → skip silently (no
 *   prompt, no console output).
 * - Interactive TTY → confirm prompt, default NO.
 */
async function promptHookInstall(nonInteractive: boolean, noHookFlag: boolean): Promise<boolean> {
  if (nonInteractive) {
    return process.env[NON_INTERACTIVE_ENV.installHook] === 'true';
  }
  if (noHookFlag) return false;
  return promptConfirm(
    'Install the SessionStart memory-pack hook? (auto-injects a repo-scoped memory pack into new Claude Code sessions)',
    false
  );
}

// ─── Auto-capture opt-in (FEAT-455 / ADR-012 decision 4) ──────────────────────

/**
 * Decide whether to enable `capture.autoCapture.enabled` (ADR-012 decision
 * 4). Non-interactive mode NEVER sees this prompt and gets the `false`
 * default, same as every other interactive-only wizard question in this
 * file — a scripted/CI `init` must never silently opt in to auto-capture.
 */
async function promptAutoCaptureOptIn(nonInteractive: boolean): Promise<boolean> {
  if (nonInteractive) return false;
  return promptConfirm(
    'Astramem can automatically capture more of your session traffic (not just at session end) ' +
    'to form memories with less manual effort. This observes your session transcripts more ' +
    'frequently than today\'s default capture. Turn on auto-capture?',
    false,
  );
}

// ─── Main wizard flow ─────────────────────────────────────────────────────────

export async function init(argv: string[] = []): Promise<void> {
  const nonInteractive = isNonInteractive();
  const noHookFlag = argv.includes('--no-hook');

  // 0. Activate the git post-merge hook (FEAT-439 residual) — best-effort,
  // silent no-op for npm-installed users (no .git/scripts/git-hooks at the
  // resolved repo root). Independent of every other step below, so it runs
  // first and can never be skipped by an early return further down.
  try {
    const hookActivation = activateGitHooks();
    if (!nonInteractive) {
      if (hookActivation.status === 'set') {
        console.log('  ✓ git post-merge hook activated (core.hooksPath=scripts/git-hooks)');
      } else if (hookActivation.status === 'overwrote') {
        console.log(`  ⚠ replaced existing core.hooksPath (was: ${hookActivation.previousValue}) with scripts/git-hooks`);
      } else if (hookActivation.status === 'error') {
        console.log(`  ⚠ could not activate git post-merge hook: ${hookActivation.message}`);
      }
      // 'already-set' and 'not-a-git-checkout' are silent — nothing changed.
    }
  } catch {
    /* never fail init over this */
  }

  // 1. Gather answers
  const answers = nonInteractive ? gatherNonInteractive() : await gatherInteractive();

  // 2. lancedb fallback
  if (answers.vector === 'lancedb') {
    console.log('\n  lancedb v1 not yet shipped — falling back to sqlite-vec.\n');
    answers.vector = 'sqlite-vec';
  }

  // 3. Provider checks
  // Only check/pull the models actually assigned to the ollama provider —
  // with 4 possible llmProvider values now (previously 2), computing
  // llmModel unconditionally here would try to `ollama pull` a non-Ollama
  // model name (e.g. 'gpt-4.1' or 'gpt-5.4-mini') whenever
  // embedProvider=ollama but llmProvider is something else, aborting init.
  //
  // Ollama is also ON-DEMAND, not hard-required (item 1): route through
  // whichever of the three setup paths the user picked interactively
  // (install now / point at an existing URL / skip — daemon starts
  // degraded). Non-interactive mode has no "setup mode" concept and keeps
  // the legacy always-attempt-pull-if-missing behavior unchanged.
  if (answers.llmProvider === 'ollama' || answers.embedProvider === 'ollama') {
    const llmModel = answers.llmProvider === 'ollama' ? (answers.ollamaModelTag ?? DEFAULT_OLLAMA_LLM_MODEL) : undefined;
    const embedModel = answers.embedProvider === 'ollama' ? DEFAULT_OLLAMA_EMBED_MODEL : undefined;
    const models = [llmModel, embedModel].filter((m): m is string => Boolean(m));

    if (nonInteractive) {
      await checkOllama(llmModel, embedModel, nonInteractive);
    } else if (answers.ollamaMode === 'skip') {
      console.log('\n  Skipping Ollama setup — daemon will start degraded until Ollama is reachable.');
      console.log('  Run `astramem-local doctor` after installing Ollama, or pull manually:');
      for (const m of models) console.log(`    ollama pull ${m}`);
      console.log('');
    } else if (answers.ollamaMode === 'url') {
      console.log(`\n  Using existing Ollama server at ${answers.ollamaBaseUrl} — skipping local install/pull checks.\n`);
    } else {
      // 'install' (also the default if ollamaMode is somehow unset)
      const proceed = await confirmOllamaDownload(models);
      if (proceed) {
        await checkOllama(llmModel, embedModel, nonInteractive);
      } else {
        console.log('\n  Skipping model pull — daemon will start degraded until Ollama models are available.\n');
      }
    }
  }

  if (answers.azureApiKey || answers.azureEndpoint) {
    await checkAzure(
      answers.azureEndpoint ?? '',
      answers.azureDeployment ?? '',
      answers.azureApiKey ?? '',
      nonInteractive
    );
  }

  // 4. Build config
  const cfg = buildConfig(answers);

  // 5. Write config.yaml
  const configDir = defaultConfigDir();
  const configPath = join(configDir, 'config.yaml');
  writeConfig(cfg, configPath);
  if (!nonInteractive) console.log(`\n  ✓ config.yaml written to ${configPath}`);

  // 6. Generate bearer + store it. SEC-10 + FEAT-466 review fix-round:
  //    store in the OS credential store (scoped identity only — init does
  //    NOT write-through the legacy identity; that write-through is
  //    reserved for token.ts's rotateToken(), since a sandboxed/test init
  //    touching the legacy identity is the exact mechanism that caused the
  //    original 2026-07-10 incident this FEAT closes). secrets.env ALWAYS
  //    gets MEMORY_BEARER= regardless of whether the OS-store write also
  //    succeeded — secrets.env is unconditionally authoritative for the
  //    bearer now (see keystore.ts's bearer-section header).
  const secretsPath = join(configDir, 'secrets.env');
  const bearer = generateToken();
  const { stored } = storeBearer(bearer, configDir);
  writeSecrets(
    {
      bearer,
      azureKey: answers.azureApiKey,
      azureEndpoint: answers.azureEndpoint,
      azureDeployment: answers.azureDeployment,
      openaiCompatApiKey: answers.openaiCompatApiKey,
      openaiCompatApiKeyEnv: cfg.openaiCompatible.apiKeyEnv,
    },
    secretsPath
  );
  if (!nonInteractive) {
    console.log(
      stored
        ? `  ✓ bearer token stored in OS credential store (and secrets.env, kept authoritative)`
        : `  ✓ secrets.env written to ${secretsPath} (mode 0600, bearer fallback — OS credential store unavailable)`
    );
  }

  // 6b. Offer to install the SessionStart memory-pack hook (KF-B follow-up).
  const installHook = await promptHookInstall(nonInteractive, noHookFlag);
  if (installHook) {
    const hookResult = installMemoryPackHook({
      port: answers.port,
      settingsPath: process.env[SETTINGS_PATH_ENV],
    });
    cfg.recallPack.enabled = true;
    writeConfig(cfg, configPath); // persist the flag flip — config.yaml now round-trips recallPack
    if (!nonInteractive) {
      if (hookResult.outcome === 'installed') {
        console.log(`  ✓ SessionStart memory-pack hook installed → ${hookResult.settingsPath}`);
      } else {
        console.log(`  · SessionStart memory-pack hook already installed → ${hookResult.settingsPath} (skipped)`);
      }
      console.log(`    recallPack.enabled=true persisted to config.yaml`);
    }
  }

  // 6c. Offer the auto-capture opt-in (FEAT-455 / ADR-012 decision 4).
  // Default OFF, explicit disclosure prompt, never enabled implicitly —
  // interactive TTY only, same as the hook-install prompt above.
  const enableAutoCapture = await promptAutoCaptureOptIn(nonInteractive);
  if (enableAutoCapture) {
    cfg.capture.autoCapture.enabled = true;
    writeConfig(cfg, configPath); // persist the flag flip — config.yaml now round-trips capture.autoCapture
    if (!nonInteractive) {
      console.log(`  ✓ auto-capture enabled — capture.autoCapture.enabled=true persisted to config.yaml`);
    }
  }

  // 7. Run migrations — this is the fresh-DB creation path, so
  // cfg.embedding.dim (FEAT-409) is what actually bakes into memories_vec.
  const dbPath = join(answers.dataDir, 'memory.sqlite');
  mkdirSync(answers.dataDir, { recursive: true });
  const db = openDb(dbPath);
  migrate(db, cfg.embedding.dim);
  db.close();
  if (!nonInteractive) console.log(`  ✓ DB migrations applied at ${dbPath}`);

  // 8. Run doctor (skip daemon-reachable check — daemon not yet started)
  //    We pass a dummy port that won't be running, then filter out the
  //    daemon check to avoid noisy failure during init.
  const allChecks = getChecks({
    dataDir: answers.dataDir,
    port: answers.port,
    dailyBudgetUsd: answers.budget,
    autoCaptureEnabled: cfg.capture.autoCapture.enabled,
  });
  const checksToRun = allChecks.filter(c => !c.name.startsWith('Daemon reachable'));
  const results = await runChecks(checksToRun);
  if (!nonInteractive) {
    console.log('\nDoctor:\n');
    console.log(formatTable(results));
    console.log('');
  }

  // 9. Persist env vars so the plugin sees them in future shells
  const apiUrl = `http://127.0.0.1:${answers.port}`;
  if (!nonInteractive) {
    const persistResult = await persistEnvVars({
      MEMORY_BEARER: bearer,
      MEMORY_API_URL: apiUrl,
    });
    if (persistResult.ok) {
      console.log(`  ✓ env vars persisted (${persistResult.target})`);
    } else {
      console.log(`  ⚠ could not persist env vars: ${persistResult.message}`);
    }
  }
  // Always echo the export lines so users (and CI tests) can pick them up.
  console.log('');
  console.log(`  export MEMORY_BEARER=${bearer}`);
  console.log(`  export MEMORY_API_URL=${apiUrl}`);

  // 10. Install + start service if requested. Works in non-interactive mode
  // too (ASTRA_MEMORY_INIT_INSTALL_SERVICE=true) — previously the block was
  // gated on interactivity, so there was no scriptable install path at all.
  let serviceStarted = false;
  if (answers.installService) {
    try {
      // Single shared install path (shim + XML task on Windows) — same code
      // that `service install` and `reinstall` use.
      const { result, adapter } = await installServiceFlow(answers.port);
      console.log(`  · installing OS service (${adapter.platform})...`);
      if (result.kind === 'task') {
        console.log(`  · starting service...`);
        await adapter.start();
        console.log(`  ✓ service installed and started`);
        serviceStarted = true;
      } else {
        console.log(`  ⚠ scheduler registration failed — Startup shortcut installed at ${result.path}`);
        console.log(`    The daemon will start at next logon; 'service start/stop' will not work.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠ service install failed: ${msg}`);
      console.log(`    Retry manually: astramem-local reinstall`);
    }
  }

  // 11. Verify daemon health if we started one
  if (serviceStarted) {
    const up = await waitForHealth(answers.port, 5_000);
    if (up) {
      console.log(`  ✓ daemon healthy at ${apiUrl}`);
    } else {
      console.log(`  ⚠ daemon did not respond to /health within 5s — check 'astramem-local service status'`);
    }
  }

  // 12. Print final next steps
  console.log('');
  console.log('✓ AstraMemory Local initialized.');
  console.log('');
  if (!serviceStarted && !nonInteractive) {
    console.log('Start the daemon:');
    console.log('');
    if (answers.installService) {
      console.log('  astramem-local service install && astramem-local service start');
    } else {
      console.log('  astramem-local serve');
    }
    console.log('');
  }
  console.log('Open a new shell so env vars take effect, then verify:');
  console.log('');
  console.log('  astramem-local doctor');
  console.log('  astramem-local remember "test memory" --type fact');
  console.log('  astramem-local search "test"');
  console.log('');
}

