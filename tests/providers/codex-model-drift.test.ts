/**
 * Codex model-drift hardening.
 *
 * 2026-07-13: a probe passed `gpt-5-mini` — a plausible-looking model that is NOT in the
 * Codex catalog — and got back:
 *
 *   HTTP 400 — {"detail":"The 'gpt-5-mini' model is not supported when using Codex with
 *               a ChatGPT account."}
 *
 * No hint of what IS supported. On the strength of that I concluded "Codex is dead" and
 * pivoted an entire benchmark arm to Azure. It was not dead. The provider's own default
 * (`gpt-5.4-mini`) works fine, and the account's real catalog was sitting in
 * `~/.codex/models_cache.json` the whole time.
 *
 * The bug was mine, but the sharp edge is the product's: an opaque upstream 400 is a
 * terrible way to learn that a hardcoded model name has drifted — and the provider's own
 * doc comment admits "OpenAI's model naming moves fast."
 *
 * So: read the catalog, and say something useful.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCodexModelCatalog,
  pickCheapestCodexModel,
  validateCodexModel,
} from '../../src/providers/llm/codex-subscription.js';

/** The real catalog shape, as found on disk 2026-07-13 (Codex CLI). */
const REAL_CATALOG = {
  models: [
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna' },
    { id: 'gpt-5.5', display_name: 'GPT-5.5' },
    { id: 'gpt-5.4', display_name: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini' },
    { id: 'codex-auto-review', display_name: 'Codex Auto Review' },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function seedCatalog(contents: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'codex-catalog-'));
  dirs.push(d);
  writeFileSync(join(d, 'models_cache.json'), JSON.stringify(contents), 'utf8');
  return join(d, 'auth.json'); // authPath — the catalog is read from its dirname
}

describe('codex model-drift hardening', () => {
  it('reads the real catalog shape off disk', () => {
    const catalog = readCodexModelCatalog(seedCatalog(REAL_CATALOG));
    expect(catalog?.map((m) => m.id)).toContain('gpt-5.4-mini');
    expect(catalog).toHaveLength(7);
  });

  it('picks the -mini (cheap tier) model', () => {
    const catalog = readCodexModelCatalog(seedCatalog(REAL_CATALOG))!;
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-5.4-mini');
  });

  it('catches the EXACT drift that cost the debugging time: gpt-5-mini is not real', () => {
    const catalog = readCodexModelCatalog(seedCatalog(REAL_CATALOG));
    const warning = validateCodexModel('gpt-5-mini', catalog);

    expect(warning).toBeTruthy();
    // The whole point: the message must NAME what the account can actually use, rather
    // than leaving someone to guess from a bare upstream 400.
    expect(warning).toContain('gpt-5.4-mini');
    expect(warning).toContain('gpt-5.5');
    expect(warning).toMatch(/suggested/i);
  });

  it('stays silent for a model that IS in the catalog', () => {
    const catalog = readCodexModelCatalog(seedCatalog(REAL_CATALOG));
    expect(validateCodexModel('gpt-5.4-mini', catalog)).toBeNull();
  });

  it('does NOT block when the catalog is missing — a stale cache must not break a working provider', () => {
    // No models_cache.json at all.
    const d = mkdtempSync(join(tmpdir(), 'codex-nocatalog-'));
    dirs.push(d);
    expect(readCodexModelCatalog(join(d, 'auth.json'))).toBeNull();
    // …and with no catalog, validation must be permissive rather than fail closed.
    expect(validateCodexModel('anything-at-all', null)).toBeNull();
  });

  it('does NOT block on a malformed catalog either', () => {
    const authPath = seedCatalog({ garbage: true });
    expect(readCodexModelCatalog(authPath)).toBeNull();
  });
});
