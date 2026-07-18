/**
 * Standalone daemon spawn/health helper shared by every eval harness under
 * scripts/eval/ (LongMemEval, LoCoMo, ...) — deliberately NOT importing
 * tests/smoke/helpers/daemon.ts (that's test-only code; this adapter is new
 * files under scripts/, per the task's "do not modify src/ or existing
 * tests" scope). Same technique (ephemeral port 0, parse the boot log line,
 * poll /health) as that helper, independently.
 *
 * Extracted from scripts/eval/longmemeval/lib/spawn-daemon.ts to
 * scripts/eval/shared/ (FEAT-457) so the LoCoMo harness reuses it verbatim
 * instead of forking it — every eval harness needs this exact isolation
 * fix, not a per-dataset variant.
 *
 * CRITICAL isolation requirement discovered while building the LongMemEval
 * harness (2026-07-08): the real %APPDATA%\Astramem\sync.json on this
 * machine is PAIRED to the live production SaaS tenant
 * (https://api.astramemory.com, a real tenantId). `resolveRuntimeConfig`
 * merges sync.json over config.yaml regardless of ASTRA_MEMORY_DATADIR
 * overrides — so spawning against the real config dir with only the
 * datadir swapped would have sync-shipped every synthetic eval session into
 * the user's real cloud account. This is why `makeIsolatedEvalEnv` below
 * redirects APPDATA/LOCALAPPDATA/HOME/XDG_* into a throwaway sandbox (same
 * technique as tests/smoke/helpers/daemon.ts's makeIsolatedDaemonEnv,
 * independently authored here) — a fresh config dir has no sync.json (sync
 * defaults to disabled, src/config/config.ts:198) and we explicitly force
 * `security.encryption.enabled: false` (same as that test helper) so boot
 * never touches the real OS credential store either. `defaultConfig()`
 * already points llm/embedding at the real local Ollama models
 * (qwen3:8b / mxbai-embed-large, as of the 2026-07-13 operator
 * standardization — src/config/config.ts's defaultConfig) — no config.yaml
 * overrides needed for those, so the eval daemon still exercises the real
 * provider stack.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, platform, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigDir } from '../../../src/config/datadir.js';
import { defaultConfig } from '../../../src/config/config.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Extraction/compaction model override for one isolated eval daemon.
 *  Omitting a field (or the whole `models` option) means "inherit
 *  `defaultConfig()`'s built-in model for that stage" — the FEAT-457
 *  postmortem finding this closes is that the eval harness previously had
 *  no way to pin OR RECORD which model it actually ran with, so a drift
 *  between the operator's real config.yaml (which the isolated sandbox
 *  deliberately never reads) and the code's hardcoded default was only
 *  discoverable after the fact. See `IsolatedEvalEnv.resolvedModels`. */
export interface EvalModelOverrides {
  extraction?: string;
  compaction?: string;
  /** Provider override for the extraction stage (default: whatever
   *  `defaultConfig()` hardcodes, currently 'ollama'). Additive: set this
   *  alongside `extraction` to point extraction at a non-Ollama provider
   *  (e.g. 'codex-subscription' for a BYO-ChatGPT-quota extraction config —
   *  LoCoMo 10% two-config eval, 2026-07-13). Omitting it leaves the
   *  provider at its default. */
  extractionProvider?: 'ollama' | 'azure-openai' | 'openai-compatible' | 'codex-subscription';
  /** Same as `extractionProvider`, for the compaction stage. */
  compactionProvider?: 'ollama' | 'azure-openai' | 'openai-compatible' | 'codex-subscription';
}

export interface IsolatedEvalEnv {
  root: string;
  configDir: string;
  env: Record<string, string>;
  /** The extraction/compaction models+providers this sandbox's daemon will
   *  actually boot with — the override passed in, or `defaultConfig()`'s
   *  built-in default otherwise. Callers should write this into their own
   *  run manifest rather than assuming a model string, so a published number
   *  is never silently wrong about what it measured. */
  resolvedModels: {
    extraction: string; compaction: string;
    extractionProvider: string; compactionProvider: string;
  };
}

/** Cross-encoder rerank override for one isolated eval daemon (LoCoMo WS2,
 *  `docs/specs/20260713-locomo-architect-design.md` workstream 2's "rerank
 *  flip experiment"). `src/search/rerank.ts` already ships a complete,
 *  tested, OFF-by-default cross-encoder stage (`defaultConfig().crossEncoder
 *  = { enabled: false, provider: 'mock', ... }`) — this lets an eval harness
 *  flip it on for one isolated daemon via config only, with zero src/ edits
 *  and zero changes to rerank.ts's own logic. Omitting this option (or the
 *  whole `crossEncoder` field) writes byte-identical config.yaml to before
 *  this option existed — every existing call site is unaffected. */
export interface EvalCrossEncoderOverride {
  enabled: boolean;
  /** Default 'mock' (the deterministic Jaccard stand-in, no network/model —
   *  see rerank.ts's header) if omitted. */
  provider?: 'mock' | 'http';
}

/** Same override-or-default resolution `makeIsolatedEvalEnv` applies,
 *  exposed standalone so a caller can record the resolved model names in a
 *  run manifest even when no shard's `makeIsolatedEvalEnv` call ended up
 *  succeeding (e.g. every shard failed before boot) — the manifest should
 *  still be able to say what the run WOULD have used. */
export function resolveEvalModels(models?: EvalModelOverrides): {
  extraction: string; compaction: string;
  extractionProvider: string; compactionProvider: string;
} {
  const base = defaultConfig();
  return {
    extraction: models?.extraction ?? base.llm.extraction.model,
    compaction: models?.compaction ?? base.llm.compaction.model,
    extractionProvider: models?.extractionProvider ?? base.llm.extraction.provider,
    compactionProvider: models?.compactionProvider ?? base.llm.compaction.provider,
  };
}

function withEnvOverrides<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Build a throwaway config/home sandbox for one eval run — never touches
 *  the real %APPDATA%\Astramem (sync pairing) or the real OS credential
 *  store. Caller merges the returned `env` into SpawnDaemonOpts.env.
 *
 *  `opts.models` is additive: omit it (or any field) and this writes the
 *  exact same config.yaml as before — every existing call site (LongMemEval
 *  included) is byte-for-byte unaffected. Pass it to pin the isolated
 *  daemon's extraction/compaction model/provider instead of silently
 *  inheriting whatever `defaultConfig()` currently hardcodes.
 *
 *  `opts.crossEncoder` is the same kind of additive override — see
 *  `EvalCrossEncoderOverride`'s doc comment above.
 *
 *  `opts.extractProfile` (FEAT-479, additive): pins `distill.extractProfile`
 *  ('engineering' default | 'conversational') for this sandbox's daemon.
 *  Omitting it leaves the shipped default ('engineering') untouched — a
 *  LoCoMo/conversational-data eval run should pass 'conversational'
 *  explicitly rather than relying on any inherited default (2026-07-13 10%
 *  two-config rerun: the first LoCoMo run silently used the engineering
 *  profile against conversational data and starved extraction to ~0.5
 *  atoms/session). */
/**
 * Resolve the machine's real ONNX embed-model cache so an isolated eval daemon
 * loads it OFFLINE, matching prod (ADR-018). Returns null when absent — callers
 * then leave embedding at the bare default. Override via ASTRA_EVAL_ONNX_CACHE;
 * seed a fresh box with `node dist/cli/index.js model fetch`. See the cacheDir
 * block in makeIsolatedEvalEnv for the full rationale.
 */
export function resolveEvalOnnxCacheDir(): string | null {
  const override = process.env['ASTRA_EVAL_ONNX_CACHE'];
  if (override) return existsSync(override) ? override : null;
  const dir = platform() === 'win32'
    ? join(process.env['LOCALAPPDATA'] ?? '', 'Astramem', 'models', 'onnx')
    : join(homedir(), '.local', 'share', 'astra-memory', 'models', 'onnx');
  return existsSync(dir) ? dir : null;
}

export function makeIsolatedEvalEnv(
  prefix: string,
  opts?: { models?: EvalModelOverrides; crossEncoder?: EvalCrossEncoderOverride; extractProfile?: 'engineering' | 'conversational'; extractionPasses?: 1 | 2; compactionMode?: 'auto' | 'always' | 'never'; extractionPassB?: { provider: string; model: string } },
): IsolatedEvalEnv {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const appDataRoot = join(root, 'appdata');
  const localAppDataRoot = join(root, 'localappdata');
  mkdirSync(appDataRoot, { recursive: true });
  mkdirSync(localAppDataRoot, { recursive: true });

  const dirEnvOverrides: Record<string, string> = {
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    HOME: appDataRoot,
    XDG_CONFIG_HOME: appDataRoot,
    XDG_DATA_HOME: localAppDataRoot,
  };

  const configDir = withEnvOverrides(dirEnvOverrides, defaultConfigDir);
  mkdirSync(configDir, { recursive: true });

  const resolved = resolveEvalModels(opts?.models);

  const configLines = ['security:', '  encryption:', '    enabled: false'];

  // ONNX embed (ADR-018): since 2026-07-15 defaultConfig().embedding.provider is
  // 'onnx' (in-process ONNX Runtime). This sandbox has a FRESH dataDir, so its own
  // ONNX cache is empty and transformers.js can't fetch offline (HF blocked) — the
  // embedder then fails, which for retrieval-scoring harnesses (LoCoMo/LongMemEval)
  // silently breaks recall, not just a boot probe. Point onnxEmbed.cacheDir at the
  // machine's real (prod) cache so the model loads offline exactly like prod.
  // Override with ASTRA_EVAL_ONNX_CACHE; when no cache exists the block is omitted
  // (embed left at the bare default) — seed a fresh box with `model fetch`.
  const onnxCacheDir = resolveEvalOnnxCacheDir();
  if (onnxCacheDir) {
    configLines.push('embedding:', '  provider: onnx', 'onnxEmbed:', `  cacheDir: '${onnxCacheDir.replace(/\\/g, '/')}'`);
  }

  const m = opts?.models;
  if (m?.extraction !== undefined || m?.compaction !== undefined || m?.extractionProvider !== undefined || m?.compactionProvider !== undefined) {
    configLines.push('llm:');
    if (m.compaction !== undefined || m.compactionProvider !== undefined) {
      configLines.push('  compaction:');
      if (m.compactionProvider !== undefined) configLines.push(`    provider: ${m.compactionProvider}`);
      if (m.compaction !== undefined) configLines.push(`    model: ${m.compaction}`);
    }
    if (m.extraction !== undefined || m.extractionProvider !== undefined) {
      configLines.push('  extraction:');
      if (m.extractionProvider !== undefined) configLines.push(`    provider: ${m.extractionProvider}`);
      if (m.extraction !== undefined) configLines.push(`    model: ${m.extraction}`);
    }
  }
  if (opts?.crossEncoder !== undefined) {
    configLines.push('crossEncoder:', `  enabled: ${opts.crossEncoder.enabled}`, `  provider: ${opts.crossEncoder.provider ?? 'mock'}`);
  }
  if (opts?.extractProfile !== undefined || opts?.extractionPasses !== undefined || opts?.compactionMode !== undefined || opts?.extractionPassB !== undefined) {
    configLines.push('distill:');
    if (opts.extractProfile !== undefined) configLines.push(`  extractProfile: ${opts.extractProfile}`);
    if (opts.extractionPasses !== undefined) configLines.push(`  extractionPasses: ${opts.extractionPasses}`);
    // `compaction: never` = raw-turn passthrough, no compaction LLM call (the
    // stage that can summarize away facts extraction needs). auto|always|never
    // per Config['distill']['compaction'].
    if (opts.compactionMode !== undefined) configLines.push(`  compaction: ${opts.compactionMode}`);
    // FEAT-534 mixed-provider dual-pass (2026-07-17 A/B lever): route the
    // specifics-sweeper Pass B to a different provider/model than Pass A —
    // measured 2026-07-17 (5-fixture bench): codex-A + phi4-mini-B scored
    // 85/85/85 junk 12, the best balanced config of the sweep.
    if (opts.extractionPassB !== undefined) {
      configLines.push('  extractionPassB:', `    provider: ${opts.extractionPassB.provider}`, `    model: '${opts.extractionPassB.model}'`);
    }
  }
  writeFileSync(join(configDir, 'config.yaml'), configLines.join('\n') + '\n', 'utf8');

  return { root, configDir, env: dirEnvOverrides, resolvedModels: resolved };
}

export function cleanupIsolatedEvalEnv(isolated: IsolatedEvalEnv): void {
  rmSync(isolated.root, { recursive: true, force: true });
}

const SERVING_LINE_RE = /astramem-local serving on [^\s:]+:(\d+)/;

export interface DaemonHandle {
  proc: ChildProcess;
  /** Groundwork for FEAT-462 slice B (AC-3, PID/port manifest) — not yet
   *  written anywhere, just exposed here since `proc.pid` was otherwise
   *  unreachable outside this module. `undefined` only if the spawn itself
   *  failed to produce a process (mirrors ChildProcess.pid's own type). */
  pid: number | undefined;
  port: number;
  token: string;
  baseUrl: string;
  stdout(): string;
  stderr(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null };
}

export interface SpawnDaemonOpts {
  dataDir: string;
  token: string;
  port?: number;
  /** Extra env merged over process.env (e.g. ASTRA_MEMORY_PORT if a fixed
   *  port is ever needed — default is ephemeral `--port 0`). */
  env?: Record<string, string>;
  /** Test-only escape hatch: override the args passed to `node` (default:
   *  the real astramemory-local daemon, `dist/cli/index.js serve --port
   *  <port>`). Lets resume/kill-resilience tests (FEAT-462 AC-5) point
   *  spawnEvalDaemon at a fake/stub daemon fixture while reusing the same
   *  boot-log-parsing, health-poll, and kill machinery the real harnesses
   *  use — never set by run-smoke.mts / run.mts themselves. */
  command?: string[];

  /** ESCAPE HATCH — do not use without reading `assertIsolatedFromRealConfig` below.
   *
   *  When true, the spawned daemon is allowed to inherit the operator's REAL config
   *  dir: their `sync.json` (cloud URL + tenant credentials), their credential-store
   *  scope, everything. It can start the real sync shipper against their live tenant.
   *
   *  This exists so the guard is bypassable *deliberately and visibly*, never by
   *  forgetting a call. If you find yourself reaching for it in a harness, you almost
   *  certainly want `makeIsolatedEvalEnv()` instead. */
  allowRealConfigDir?: boolean;
}

async function waitForBoundPort(
  getStdout: () => string,
  getStderr: () => string,
  getExitInfo: () => { code: number | null; signal: NodeJS.Signals | null },
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = SERVING_LINE_RE.exec(getStdout());
    if (m) return Number(m[1]);
    const { code, signal } = getExitInfo();
    if (code !== null || signal !== null) {
      throw new Error(
        `eval daemon exited before printing its bound port (code=${code} signal=${signal})\n` +
        `stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
      );
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the eval daemon to print its bound port\nstdout:\n${getStdout()}\nstderr:\n${getStderr()}`);
}

/**
 * FAIL-CLOSED ISOLATION GUARD (added 2026-07-13 after a live incident).
 *
 * `spawnEvalDaemon` spreads `...process.env` into the child. `makeIsolatedEvalEnv`
 * produces the APPDATA/HOME/XDG overrides that stop the child reading the operator's
 * REAL config dir. **They were two separate opt-ins with nothing pairing them.**
 *
 * What happened: an agent called `spawnEvalDaemon` without `makeIsolatedEvalEnv`. The
 * child inherited the real `APPDATA`, read the real `sync.json`
 * (`enabled: true, url: https://api.astramemory.com`, a real tenantId), and may have
 * started the sync shipper against the operator's live cloud tenant. Impact turned out
 * to be low — but it was low by luck, not by design, and it was unprovable after the
 * fact because the process died with its logs.
 *
 * A harness that can silently reach production credentials when you forget one call is
 * not a harness, it is a trap. So: this now REFUSES to start unless the child's config
 * dir is provably NOT the operator's. Forgetting is no longer possible; you now have to
 * opt in to danger explicitly, in writing.
 */
function assertIsolatedFromRealConfig(opts: SpawnDaemonOpts): void {
  // Only the REAL daemon reads the operator's config dir. A `command` override that
  // points at a stub fixture (e.g. __fixtures__/fake-eval-daemon.mjs) implements just
  // enough of the wire surface to be health-checked and never touches config.yaml,
  // sync.json, or the credential store — so it carries none of the risk this guard
  // exists for, and blocking it would be a false positive that trains people to reach
  // for the escape hatch. Guard the real binary; leave the stubs alone.
  const spawnsRealDaemon =
    opts.command === undefined || opts.command.some((a) => a.includes('cli/index.js'));
  if (!spawnsRealDaemon) return;

  if (opts.allowRealConfigDir === true) {
    // Explicit, documented, and loud. The caller has accepted that this child can read
    // real credentials and start the real sync shipper.
    console.warn(
      '[spawn-daemon] WARNING: allowRealConfigDir=true — this daemon will read the ' +
      "operator's REAL config dir, including sync.json and its cloud credentials.",
    );
    return;
  }

  const childEnv = { ...process.env, ...opts.env } as Record<string, string | undefined>;
  const realHome = process.env.APPDATA ?? process.env.HOME ?? process.env.XDG_CONFIG_HOME;
  const childHome = childEnv.APPDATA ?? childEnv.HOME ?? childEnv.XDG_CONFIG_HOME;

  const isolated =
    childEnv.ASTRA_MEMORY_ISOLATED === '1' ||
    (realHome !== undefined && childHome !== undefined && childHome !== realHome);

  if (!isolated) {
    throw new Error(
      'spawnEvalDaemon REFUSED to start: the child would inherit the real config dir.\n' +
      `  real config dir  : ${realHome}\n` +
      `  child config dir : ${childHome}  <-- same, so the child would read the operator's\n` +
      "                     sync.json (cloud URL + tenant credentials) and could start the\n" +
      '                     sync shipper against their live tenant.\n\n' +
      'Fix: call makeIsolatedEvalEnv() and pass its dirEnvOverrides via opts.env.\n' +
      '  const iso = makeIsolatedEvalEnv("my-eval");\n' +
      '  await spawnEvalDaemon({ ...opts, env: { ...iso.dirEnvOverrides } });\n\n' +
      'Or set ASTRA_MEMORY_ISOLATED=1 in opts.env (serve.ts\'s own second guard).\n' +
      'If you REALLY mean to read the real config, pass allowRealConfigDir: true.',
    );
  }
}

export async function spawnEvalDaemon(opts: SpawnDaemonOpts): Promise<DaemonHandle> {
  assertIsolatedFromRealConfig(opts);

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const proc = spawn(
    // Deliberately literal 'node', NOT process.execPath: this harness itself
    // runs under `bun` (per repo idiom for one-off scripts), but the daemon
    // must run under real Node — CLAUDE.md's hard warning against
    // `astramem-local` shadowing applies equally here, and Bun's own SQLite
    // layer cannot open the daemon's better-sqlite3-multiple-ciphers file
    // (`'better-sqlite3' is not yet supported in Bun` — verified live
    // 2026-07-08 when this was `process.execPath` and resolved to bun.exe).
    'node',
    opts.command ?? ['dist/cli/index.js', 'serve', '--port', String(opts.port ?? 0)],
    {
      cwd: REPO_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        ASTRA_MEMORY_DATADIR: opts.dataDir,
        ASTRA_MEMORY_TOKEN: opts.token,
        ...opts.env,
      },
      stdio: 'pipe',
    },
  );
  proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
  proc.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });

  const actualPort = await waitForBoundPort(() => stdout, () => stderr, () => ({ code: exitCode, signal: exitSignal }));

  return {
    proc,
    pid: proc.pid,
    port: actualPort,
    token: opts.token,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    stdout: () => stdout,
    stderr: () => stderr,
    exitInfo: () => ({ code: exitCode, signal: exitSignal }),
  };
}

export async function waitForHealthStatus(
  baseUrl: string,
  wantStatuses: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        last = body;
        if (body.status && wantStatuses.includes(body.status)) return body.status;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for /health status in [${wantStatuses.join(', ')}] — last observed: ${JSON.stringify(last)}`);
}

export async function killDaemon(handle: DaemonHandle, signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 5_000): Promise<void> {
  const { code, signal: exitSignal } = handle.exitInfo();
  if (handle.proc.killed || code !== null || exitSignal !== null) return;
  try {
    handle.proc.kill(signal);
  } catch {
    return;
  }
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, timeoutMs);
    handle.proc.on('exit', () => { clearTimeout(t); resolve(); });
  });
}
