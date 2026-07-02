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
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Config, defaultConfig } from './config.js';

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

/**
 * defaultConfig() with config.yaml (if present and well-formed) merged over
 * it. Never throws — daemon boot must not be blocked by a bad config file.
 */
export function loadConfigFromDisk(configDir: string): Config {
  const base = defaultConfig();
  let text: string;
  try {
    text = readFileSync(join(configDir, 'config.yaml'), 'utf8');
  } catch {
    return base; // no file — defaults
  }
  try {
    return deepMerge(base, parseConfigYaml(text));
  } catch (err) {
    console.warn(`[astramem-local] WARNING: config.yaml could not be parsed (${String(err)}) — using defaults.`);
    return base;
  }
}
