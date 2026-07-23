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
import {
  type Config,
  defaultConfig,
  applyFusionGovernance,
  applyQueryRewriteGovernance,
  applyNormalizationGovernance,
  applyDurabilityGateGovernance,
  applyExtractProfileGovernance,
  applyMultiHopGovernance,
  applyRetentionGovernance,
  applyCandidateSelectionGovernance,
  applyContradictionDetectionGovernance,
  applyExtractionPassBGovernance,
  applyAtomTriageGovernance,
  applyGatekeeperGovernance,
  applyDupJudgeGovernance,
  applyTypeHintsGovernance,
  applyProviderAwareDistillDefaults,
} from './config.js';

type PlainObject = Record<string, unknown>;

/** Unescape a double-quoted YAML/JSON-style scalar body (quotes already
 * stripped): `\"` -> `"`, `\\` -> `\`, any other `\X` -> `X` (minimal — this
 * loader only needs to round-trip what `yamlScalar`/`JSON.stringify` emit,
 * not the full YAML double-quote escape grammar). */
function unescapeDoubleQuoted(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[++i];
    } else {
      out += s[i];
    }
  }
  return out;
}

/** Split a flow-sequence's inner text (between `[` and `]`) into entries on
 * top-level commas, honoring single/double-quote state so a comma or `#`
 * inside a quoted entry is content, not a delimiter (FEAT-465, AC-2) —
 * the array-entry counterpart of `stripComment`'s quote-tracking below.
 *
 * FEAT-465 review fix (HIGH regression): a `'`/`"` only OPENS a quoted entry
 * when it is the first non-whitespace character of that entry (right after
 * the start of `inner` or a top-level `,`) — never at an arbitrary
 * apostrophe mid-entry. An earlier version treated any bare `'` as a
 * quote-open unconditionally, so an unquoted entry containing a literal
 * apostrophe (e.g. `don't`) would falsely "open a string" and swallow the
 * rest of the array (comma, closing `]`, everything) as if still inside
 * quotes — matching YAML's own grammar, where a quote only starts a scalar
 * at that scalar's first character. */
function splitFlowSequenceEntries(inner: string): string[] {
  const entries: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let atEntryStart = true;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") { current += inner[++i]; } else { inSingle = false; atEntryStart = false; }
      }
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === '\\' && i + 1 < inner.length) { current += inner[++i]; }
      else if (ch === '"') { inDouble = false; atEntryStart = false; }
      continue;
    }
    if (/\s/.test(ch)) { current += ch; continue; } // leading/inner whitespace never ends entry-start eligibility
    if (atEntryStart && ch === "'") { inSingle = true; current += ch; continue; }
    if (atEntryStart && ch === '"') { inDouble = true; current += ch; continue; }
    if (ch === ',') { entries.push(current); current = ''; atEntryStart = true; continue; }
    atEntryStart = false;
    current += ch;
  }
  if (current.trim() !== '') entries.push(current);
  return entries.map((e) => e.trim());
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return undefined;
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('"') && v.endsWith('"')) return unescapeDoubleQuoted(v.slice(1, -1));
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // FEAT-461: flow-style array (writer.ts emits string[] fields, e.g.
  // security.redaction.customPatterns, as a JSON array literal — valid YAML
  // flow-sequence syntax for the string case, so a plain JSON.parse round-
  // trips it). FEAT-465: a hand-edited array with single-quoted entries
  // (or a mix of quote styles) isn't valid JSON, so it falls back to a
  // quote-aware manual split + recursive parseScalar per entry rather than
  // degrading to an opaque string — that fallback is what preserves entry
  // count for a `#`-bearing quoted entry (AC-2).
  if (v.startsWith('[') && v.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not valid JSON (e.g. single-quoted entries) — fall through to the
      // manual quote-aware split below rather than throwing
    }
    return splitFlowSequenceEntries(v.slice(1, -1)).map((entry) => parseScalar(entry));
  }
  return v;
}

/**
 * Strip a trailing `#` comment from one physical config.yaml line, honoring
 * quote state (FEAT-465). The original `/(^|\s)#.*$/` regex was quote-unaware,
 * so any scalar whose value contained a whitespace-preceded `#` was silently
 * truncated at that point — including inside a `[...]` flow-sequence entry
 * (SLICE-420 review repro: `customPatterns: ["hash #tag no leading space"]`
 * corrupted to the string `["hash`).
 *
 * FEAT-465 review fix (HIGH regression): a `'`/`"` only OPENS quote state at
 * a position where a scalar VALUE may legally start — right after the
 * `key:` separator, or right after a top-level `[`/`,` inside a flow
 * sequence — never at an arbitrary quote character mid-value. The first
 * version of this function treated ANY bare `'` as a quote-open, so an
 * unquoted value containing a literal apostrophe (a contraction like
 * `don't`, a name like `O'Brien`) left the scanner incorrectly believing it
 * was still inside a quoted string, silently swallowing a real trailing `#`
 * comment into the value — a regression vs. the old regex, which had no
 * quote-tracking at all and so never mishandled this case. The key portion
 * of the line (before the separating `:`) never legitimately contains a
 * quote or a `#` in this dialect, so it's scanned without any quote
 * awareness, same as the original regex.
 */
function stripComment(rawLine: string): string {
  const colonIdx = rawLine.indexOf(':');
  const valueStart = colonIdx === -1 ? rawLine.length : colonIdx + 1;

  // Dumb (quote-unaware) scan for the key prefix, or the WHOLE line when
  // there's no colon at all (e.g. a standalone `# header comment` line).
  for (let i = 0; i < valueStart; i++) {
    if (rawLine[i] === '#' && (i === 0 || /\s/.test(rawLine[i - 1] as string))) {
      return rawLine.slice(0, i);
    }
  }
  if (colonIdx === -1) return rawLine;

  let i = valueStart;
  let atValueStart = true; // true only where a NEW scalar may legally begin
  let inSingle = false;
  let inDouble = false;
  let bracketDepth = 0;

  while (i < rawLine.length) {
    const ch = rawLine[i] as string;

    if (inSingle) {
      // YAML escapes an embedded quote inside a single-quoted scalar by
      // doubling it (''); a doubled quote stays inside the string.
      if (ch === "'") {
        if (rawLine[i + 1] === "'") { i += 2; continue; }
        inSingle = false; atValueStart = false; i++; continue;
      }
      i++; continue;
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < rawLine.length) { i += 2; continue; }
      if (ch === '"') { inDouble = false; atValueStart = false; }
      i++; continue;
    }

    if (/\s/.test(ch)) { i++; continue; } // leading/inter-token whitespace never ends value-start eligibility
    if (atValueStart && ch === "'") { inSingle = true; i++; continue; }
    if (atValueStart && ch === '"') { inDouble = true; i++; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(rawLine[i - 1] as string))) {
      return rawLine.slice(0, i);
    }
    // A `[` opens a flow sequence (entries may quote-open right after it or
    // after a top-level `,`); `,` is only a new entry boundary while inside
    // one — an unbracketed comma in a hand-edited unquoted scalar must NOT
    // re-arm quote-opening for whatever follows it.
    if (ch === '[') { bracketDepth++; atValueStart = true; i++; continue; }
    if (ch === ']') { bracketDepth = Math.max(0, bracketDepth - 1); atValueStart = false; i++; continue; }
    if (ch === ',' && bracketDepth > 0) { atValueStart = true; i++; continue; }

    atValueStart = false;
    i++;
  }
  return rawLine;
}

/** Parse the writer.ts YAML subset into a nested plain object. */
export function parseConfigYaml(text: string): PlainObject {
  const root: PlainObject = {};
  // Stack of (indent level → object) for nesting; root is indent -1.
  const stack: Array<{ indent: number; obj: PlainObject }> = [{ indent: -1, obj: root }];

  for (const rawLine of text.split('\n')) {
    const withoutComment = stripComment(rawLine);
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
    // FEAT-550: applyQueryRewriteGovernance composed here too, not just in
    // loadConfig() — see the 2026-07-16 review note a few lines below on why
    // this real boot path needs its OWN governance composition rather than
    // relying on loadConfig()'s (which has zero production callers).
    // Score-phase Track I: applyNormalizationGovernance added the same way,
    // on the same real boot path AND in loadConfig() (config.ts) — same
    // "wired into BOTH real paths" bar as every other governance function in
    // this composition.
    search: applyNormalizationGovernance(applyQueryRewriteGovernance(applyFusionGovernance(cfg.search))),
    // FEAT-534: extractionPassB provider governance added here — this IS the
    // real boot path (the 2026-07-16 review comment below explains why that
    // matters: loadConfig() has zero production callers). Note
    // applyExtractionPassesGovernance itself is still NOT wired into this
    // chain (a pre-existing gap predating this slice; out of scope here).
    // FEAT-533: applyAtomTriageGovernance added the same way, on the same
    // real boot path — each governance function in this composition only
    // ever touches its own field, so nesting order is safe (see
    // applyExtractProfileGovernance's doc comment).
    // FEAT-548: applyGatekeeperGovernance added the same way, on the same
    // real boot path AND in loadConfig() (config.ts) — the 550/549 reviewers'
    // bar for a new distill.<tier> governance function is BOTH real
    // composition points, not just this one.
    // FEAT-552: applyTypeHintsGovernance added the same way, on the same
    // real boot path AND in loadConfig() — same "both composition points"
    // bar. Outermost in the chain (order is safe regardless — each
    // governance function only ever touches its own field).
    distill: applyTypeHintsGovernance(applyGatekeeperGovernance(applyAtomTriageGovernance(
      applyExtractionPassBGovernance(applyExtractProfileGovernance(applyDurabilityGateGovernance(cfg.distill))),
    ))),
    multiHop: applyMultiHopGovernance(cfg.multiHop),
    retention: applyRetentionGovernance(cfg.retention),
    // 2026-07-16 review 🔴: these two ran only inside loadConfig(), which has
    // ZERO production callers — the real boot path (resolveRuntimeConfig →
    // loadConfigFromDisk → getProviders) got NO consolidation governance at
    // all. Harmless for `mode` (runConsolidation re-guards at runtime via
    // resolveContradictionDetection) but fatal for the judge provider
    // override: an out-of-union `contradictionDetection.provider` typo would
    // reach buildLLMProvider's throwing Azure fall-through DURING BOOT,
    // before any runtime guard exists.
    // FEAT-549: applyDupJudgeGovernance added the same way, on the same real
    // boot path — same reasoning as the review note above (an out-of-union
    // `dupJudge.provider` typo must not reach buildLLMProvider's throwing
    // Azure fall-through DURING BOOT either).
    consolidation: applyDupJudgeGovernance(applyCandidateSelectionGovernance(
      applyContradictionDetectionGovernance(cfg.consolidation),
    )),
  };
}

/** Un-governed disk load — every return path funnels through the exported
 * `loadConfigFromDisk` wrapper above, which is the single place governance
 * is applied. Do not call this directly outside that wrapper. */
function loadConfigFromDiskRaw(configDir: string, reader?: (path: string) => string): Config {
  // Provider-aware defaults (2026-07-19): the no-file / torn-read paths pass
  // undefined (no disk override), so the shipped default provider
  // (codex-subscription) gets its codex-optimized distill defaults too.
  const base = applyProviderAwareDistillDefaults(defaultConfig(), defaultConfig().llm.extraction.provider);
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
    // Re-derive the provider-aware base against what the DISK actually says
    // the extraction provider is: an explicit `llm.extraction.provider` on
    // disk (e.g. ollama) must get the NEUTRAL small-model defaults, not the
    // codex-optimized ones the shipped default provider implies — and vice
    // versa. Explicit distill keys on disk still win via deepMerge.
    const diskProvider = ((parsed as { llm?: { extraction?: { provider?: unknown } } }).llm?.extraction?.provider);
    const providerAwareBase = applyProviderAwareDistillDefaults(
      defaultConfig(),
      typeof diskProvider === 'string' ? diskProvider : defaultConfig().llm.extraction.provider,
    );
    return deepMerge(providerAwareBase, parsed);
  } catch (err) {
    console.warn(`[astramem-local] WARNING: config.yaml could not be parsed (${String(err)}) — using defaults.`);
    return base;
  }
}
