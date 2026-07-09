/**
 * loadConfigFromDisk — read <configDir>/config.yaml (written by `init` /
 * writer.ts) and merge it over defaultConfig(). Until now the file was
 * write-only: init produced it but the daemon booted from defaults, so user
 * edits were silently ignored.
 *
 * The parser handles exactly the subset writer.ts emits — nested maps of
 * scalars (string/number/boolean, single-quoted strings), '#' comments,
 * blank lines. No lists, no multi-line strings, no anchors; if the file
 * grows past that, swap in a real YAML package (see writer.ts header).
 * Unknown keys are ignored; a malformed file logs a warning and falls back
 * to defaults rather than blocking daemon boot.
 *
 * FEAT-433: config is read exactly once per process (there is no live
 * reload — see resolve-runtime.ts). writer.ts's own writes are fully
 * torn-proof (tmp+rename), so the remaining race is an EXTERNAL, non-atomic
 * hand-edit (e.g. an editor that truncates-then-writes) whose save happens
 * to land mid-boot. Two guarded shapes:
 *   - fully empty/whitespace read → `readConfigFileWithRetry` retries
 *     briefly, then WARNs and falls back to defaults.
 *   - non-empty read that parses to zero keys (cut off before any complete
 *     `key: value` line landed) → WARNs and falls back to defaults.
 * A partial hand-edit that lands mid-write AFTER at least one complete
 * top-level line — losing some keys but not all — is NOT distinguishable
 * from an intentionally minimal config (e.g. a file containing only
 * `port: 7001`) and is applied without a warning, same as always. Stop the
 * service before hand-editing config.yaml to avoid that narrow window.
 *
 * FEAT-428: the exported `loadConfigFromDisk` is the single choke point for
 * fusion-model governance on the real boot path (serve.ts →
 * resolveRuntimeConfig → here). Every return value — defaults, a partial
 * merge, or a full merge — is funneled through `applyFusionGovernance`
 * (src/config/config.ts) before it reaches the caller, so a hand-edited
 * config.yaml with an over-ceiling weight or an unvalidated `eta > 0` is
 * clamped/reset exactly like an in-process `loadConfig()` override would be.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, defaultConfig, applyFusionGovernance, applyDurabilityGateGovernance } from './config.js';

type PlainObject = Record<string, unknown>;

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return undefined;
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Parse the writer.ts YAML subset into a nested plain object. */
export function parseConfigYaml(text: string): PlainObject {
  const root: PlainObject = {};
  // Stack of (indent level → object) for nesting; root is indent -1.
  const stack: Array<{ indent: number; obj: PlainObject }> = [{ indent: -1, obj: root }];

  for (const rawLine of text.split('\n')) {
    const withoutComment = rawLine.replace(/(^|\s)#.*$/, '');
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const line = withoutComment.trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue; // not a key line — ignore rather than throw

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1);

    while (stack.length > 1 && indent <= (stack[stack.length - 1] as { indent: number }).indent) {
      stack.pop();
    }
    const parent = (stack[stack.length - 1] as { obj: PlainObject }).obj;

    if (rest.trim() === '') {
      const child: PlainObject = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      const value = parseScalar(rest);
      if (value !== undefined) parent[key] = value;
    }
  }

  return root;
}

/** Deep-merge `overrides` into `base`, only following keys base already has structure for. */
function deepMerge<T>(base: T, overrides: PlainObject): T {
  const out = { ...(base as PlainObject) };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = out[key];
    if (
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      existing !== null && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing, value as PlainObject);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

/** Synchronous sleep for the bounded torn-read retry — boot is synchronous
 *  at this point (before app.listen), so there's no event loop to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read config.yaml, retrying a couple of times a few ms apart if it reads
 * back empty. `configToYaml`/`writeConfig` never emit an empty file, so an
 * existing file that reads back blank is almost certainly a torn read
 * racing a concurrent write, not an intentionally-empty config — riding out
 * a ~20ms window costs nothing on the happy path (returns after the first
 * read) and beats silently discarding the user's config.
 *
 * `reader` is an injectable seam for tests; production always uses the real
 * `readFileSync`.
 */
function readConfigFileWithRetry(
  path: string,
  reader: (p: string) => string = (p) => readFileSync(p, 'utf8'),
  attempts = 3,
  delayMs = 10,
): string {
  let text = '';
  for (let i = 0; i < attempts; i++) {
    text = reader(path);
    if (text.trim() !== '') return text;
    if (i < attempts - 1) sleepSync(delayMs);
  }
  return text; // still empty after retries — caller decides how to handle it
}

/**
 * defaultConfig() with config.yaml (if present and well-formed) merged over
 * it, then run through `applyFusionGovernance` (FEAT-428) so every real
 * boot read gets a governed `search` block — a single choke point, rather
 * than relying on every future caller to remember to apply it. Never
 * throws — daemon boot must not be blocked by a bad config file.
 */
export function loadConfigFromDisk(configDir: string, reader?: (path: string) => string): Config {
  const cfg = loadConfigFromDiskRaw(configDir, reader);
  return {
    ...cfg,
    search: applyFusionGovernance(cfg.search),
    distill: applyDurabilityGateGovernance(cfg.distill),
  };
}

/** Un-governed disk load — every return path funnels through the exported
 * `loadConfigFromDisk` wrapper above, which is the single place governance
 * is applied. Do not call this directly outside that wrapper. */
function loadConfigFromDiskRaw(configDir: string, reader?: (path: string) => string): Config {
  const base = defaultConfig();
  const path = join(configDir, 'config.yaml');
  let text: string;
  try {
    text = readConfigFileWithRetry(path, reader);
  } catch {
    return base; // no file (or unreadable) — defaults
  }

  if (text.trim() === '') {
    console.warn(
      `[astramem-local] WARNING: config.yaml at ${path} exists but read back empty after retrying — ` +
      'likely a torn read racing a concurrent write (e.g. an editor save landing mid-boot). ' +
      'Using defaults for this boot; restart once the write has finished to pick up your config.',
    );
    return base;
  }

  try {
    const parsed = parseConfigYaml(text);
    if (Object.keys(parsed).length === 0) {
      // Non-empty text (already checked above) that yielded zero parseable
      // key: value lines. parseConfigYaml never throws — it silently skips
      // lines it can't parse — so this is the one case that case would
      // otherwise merge silently: a write truncated before any complete
      // top-level line landed (e.g. cut off mid-header or mid-first-key).
      // A file with at least one real key (including an intentionally
      // minimal hand-edit like just `port: 7001`) does NOT hit this path —
      // only the all-or-nothing torn case does, so this can't misfire on a
      // legitimate partial config.
      console.warn(
        `[astramem-local] WARNING: config.yaml at ${path} is non-empty but no valid keys were parsed — ` +
        'this looks like a truncated or corrupt write (e.g. an edit cut off mid-line). ' +
        'Using defaults for this boot; check the file and restart to pick up your config.',
      );
    }
    return deepMerge(base, parsed);
  } catch (err) {
    console.warn(`[astramem-local] WARNING: config.yaml could not be parsed (${String(err)}) — using defaults.`);
    return base;
  }
}
