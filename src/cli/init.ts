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
import { execSync } from 'node:child_process';
import { defaultConfig, type Config } from '../config/config.js';
import { defaultConfigDir, defaultDataDir } from '../config/datadir.js';
import { writeConfig } from '../config/writer.js';
import { writeSecrets } from '../config/secrets.js';
import { generateToken } from './token.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { getChecks } from '../doctor/checks.js';
import { runChecks, formatTable } from '../doctor/runner.js';
import { mkdirSync } from 'node:fs';
import { persistEnvVars } from '../config/persist-envs.js';
import { waitForHealth } from './wait-health.js';
import { getServiceAdapter } from '../service/index.js';

// ─── Non-interactive env var map ─────────────────────────────────────────────

const NON_INTERACTIVE_ENV = {
  vector: 'ASTRA_MEMORY_INIT_VECTOR',
  embedProvider: 'ASTRA_MEMORY_INIT_EMBED_PROVIDER',
  llmProvider: 'ASTRA_MEMORY_INIT_LLM_PROVIDER',
  dataDir: 'ASTRA_MEMORY_INIT_DATADIR',
  port: 'ASTRA_MEMORY_INIT_PORT',
  budget: 'ASTRA_MEMORY_INIT_BUDGET',
  installService: 'ASTRA_MEMORY_INIT_INSTALL_SERVICE',
} as const;

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
  llmProvider: 'ollama' | 'azure-openai';
  dataDir: string;
  port: number;
  budget: number;
  installService: boolean;
  // Azure-only
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiKey?: string;
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

  const llmProvider = (await promptSelect(
    'LLM provider:',
    [
      { name: 'ollama (qwen2.5-coder:7b)', value: 'ollama' },
      { name: 'azure-openai (gpt-4.1)', value: 'azure-openai' },
    ],
    'ollama'
  )) as 'ollama' | 'azure-openai';

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

  // Azure-specific prompts
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

  return answers;
}

// ─── Gather answers (non-interactive / test path) ─────────────────────────────

function gatherNonInteractive(): WizardAnswers {
  const vector = (process.env[NON_INTERACTIVE_ENV.vector] ?? 'sqlite-vec') as 'sqlite-vec' | 'lancedb';
  const embedProvider = (process.env[NON_INTERACTIVE_ENV.embedProvider] ?? 'ollama') as 'ollama' | 'azure-openai';
  const llmProvider = (process.env[NON_INTERACTIVE_ENV.llmProvider] ?? 'ollama') as 'ollama' | 'azure-openai';
  const dataDir = process.env[NON_INTERACTIVE_ENV.dataDir] ?? defaultDataDir();
  const port = parseInt(process.env[NON_INTERACTIVE_ENV.port] ?? '7777', 10) || 7777;
  const budget = parseFloat(process.env[NON_INTERACTIVE_ENV.budget] ?? '10') || 10;
  const installService = (process.env[NON_INTERACTIVE_ENV.installService] ?? 'false') === 'true';

  return { vector, embedProvider, llmProvider, dataDir, port, budget, installService };
}

// ─── Conditional provider checks ─────────────────────────────────────────────

async function checkOllama(llmModel: string, embedModel: string, nonInteractive: boolean): Promise<void> {
  if (nonInteractive) return; // skip live HTTP in test mode

  // Check ollama binary
  let ollamaFound = false;
  try {
    execSync('ollama --version', { stdio: 'ignore' });
    ollamaFound = true;
  } catch {
    console.warn('\n  Warning: `ollama` binary not found. Install from https://ollama.com\n');
    return;
  }

  if (!ollamaFound) return;

  // Check models present
  const modelsToCheck = [...new Set([llmModel, embedModel])];
  for (const model of modelsToCheck) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: controller.signal });
      clearTimeout(tid);
      if (res.ok) {
        const body = await res.json() as { models?: { name: string }[] };
        const names = (body.models ?? []).map((m: { name: string }) => m.name);
        const found = names.some((n: string) => n === model || n.startsWith(model + ':'));
        if (!found) {
          console.log(`\n  Model '${model}' not found locally.`);
          console.log(`  Run: ollama pull ${model}\n`);
        } else {
          console.log(`  ✓ Ollama model '${model}' present`);
        }
      }
    } catch {
      console.warn(`\n  Warning: Could not reach Ollama at :11434. Is it running?\n`);
    }
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

function buildConfig(answers: WizardAnswers): Config {
  const base = defaultConfig();

  const llmModel = answers.llmProvider === 'azure-openai' ? 'gpt-4.1' : 'qwen2.5-coder:7b';
  const embedModel = answers.embedProvider === 'azure-openai' ? 'text-embedding-3-small' : 'mxbai-embed-large';

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
      dim: 1024,
    },
    vector: { store: answers.vector === 'lancedb' ? 'sqlite-vec' : answers.vector },
    budget: { daily_usd: answers.budget },
    azure: {
      ...base.azure,
      endpoint: answers.azureEndpoint,
      deployment: answers.azureDeployment,
    },
  };
}

// ─── Main wizard flow ─────────────────────────────────────────────────────────

export async function init(): Promise<void> {
  const nonInteractive = isNonInteractive();

  // 1. Gather answers
  const answers = nonInteractive ? gatherNonInteractive() : await gatherInteractive();

  // 2. lancedb fallback
  if (answers.vector === 'lancedb') {
    console.log('\n  lancedb v1 not yet shipped — falling back to sqlite-vec.\n');
    answers.vector = 'sqlite-vec';
  }

  // 3. Provider checks
  if (answers.llmProvider === 'ollama' || answers.embedProvider === 'ollama') {
    const llmModel = answers.llmProvider === 'azure-openai' ? 'gpt-4.1' : 'qwen2.5-coder:7b';
    const embedModel = answers.embedProvider === 'azure-openai' ? 'text-embedding-3-small' : 'mxbai-embed-large';
    await checkOllama(llmModel, embedModel, nonInteractive);
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

  // 6. Generate + write secrets.env
  const secretsPath = join(configDir, 'secrets.env');
  const bearer = generateToken();
  writeSecrets(
    {
      bearer,
      azureKey: answers.azureApiKey,
      azureEndpoint: answers.azureEndpoint,
      azureDeployment: answers.azureDeployment,
    },
    secretsPath
  );
  if (!nonInteractive) console.log(`  ✓ secrets.env written to ${secretsPath} (mode 0600)`);

  // 7. Run migrations
  const dbPath = join(answers.dataDir, 'memory.sqlite');
  mkdirSync(answers.dataDir, { recursive: true });
  const db = openDb(dbPath);
  migrate(db);
  db.close();
  if (!nonInteractive) console.log(`  ✓ DB migrations applied at ${dbPath}`);

  // 8. Run doctor (skip daemon-reachable check — daemon not yet started)
  //    We pass a dummy port that won't be running, then filter out the
  //    daemon check to avoid noisy failure during init.
  const allChecks = getChecks({ dataDir: answers.dataDir, port: answers.port, dailyBudgetUsd: answers.budget });
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

  // 10. Install + start service if requested
  let serviceStarted = false;
  if (answers.installService && !nonInteractive) {
    try {
      const adapter = getServiceAdapter();
      const execPath = resolveCliExecPathForService();
      console.log(`  · installing OS service (${adapter.platform})...`);
      await adapter.install(execPath, answers.port);
      console.log(`  · starting service...`);
      await adapter.start();
      console.log(`  ✓ service installed and started`);
      serviceStarted = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠ service install failed: ${msg}`);
      console.log(`    Retry manually: astramem-local service install && astramem-local service start`);
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

/**
 * Resolve absolute path to dist/cli/index.js for the service unit's exec command.
 * Mirrors the helper in src/cli/service.ts but kept local to avoid circular imports
 * from init.ts -> cli/service.ts -> service/index.ts.
 */
function resolveCliExecPathForService(): string {
  const nodeBin = process.execPath;
  const thisFile = new URL(import.meta.url).pathname;
  const normalized = thisFile.replace(/^\/([A-Za-z]:)/, '$1');
  const indexJs = normalized.replace(/init\.(js|ts)$/, 'index.js');
  return `"${nodeBin}" "${indexJs}"`;
}
