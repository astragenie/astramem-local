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
  type CodexCatalogEntry,
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

  it('picks the -luna model over -mini when both are present in the catalog (2026-11-05: -luna is the current cheap-tier naming, preferred ahead of the legacy -mini)', () => {
    const catalog = readCodexModelCatalog(seedCatalog(REAL_CATALOG))!;
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-5.6-luna');
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

/**
 * 2026-11-05: `gpt-5.4-mini` itself was retired by OpenAI from
 * ChatGPT-account Codex (~Sept 2026) — every distill job failed with
 * `HTTP 400 "The 'gpt-5.4-mini' model is not supported when using Codex
 * with a ChatGPT account"` until config was hand-switched to `gpt-6-luna`.
 * This is the real live `~/.codex/models_cache.json` shape as of that date
 * (objects keyed by `slug`, carrying `visibility`) — no `-mini` slug exists
 * in it at all; the cheap tier moved to `-luna`.
 */
const CATALOG_2026_11_05 = {
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', description: 'Latest workhorse' },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', description: 'Frontier' },
    { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1-Terra', visibility: 'list' },
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' },
    {
      slug: 'gpt-reserve',
      display_name: 'GPT-Reserve',
      visibility: 'hidden',
      description: 'Fast and affordable agentic coding',
    },
    {
      slug: 'gpt-6-luna',
      display_name: 'GPT-6-Luna',
      visibility: 'list',
      description: 'Fast and affordable model for easier tasks',
    },
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' },
    { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hidden' },
  ],
};

describe('pickCheapestCodexModel ordering (2026-11-05 catalog, FEAT: gpt-5.4-mini retirement)', () => {
  it('picks gpt-6-luna from the real 2026-11-05 catalog — never a hidden entry', () => {
    const authPath = seedCatalog(CATALOG_2026_11_05);
    const catalog = readCodexModelCatalog(authPath)!;
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-6-luna');
  });

  it('prefers -luna over -mini when both are present', () => {
    const catalog: CodexCatalogEntry[] = [
      { id: 'gpt-6-sol', visibility: 'list' },
      { id: 'gpt-5.4-mini', visibility: 'list' },
      { id: 'gpt-6-luna', visibility: 'list' },
    ];
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-6-luna');
  });

  it('falls back to -mini when no -luna entry exists (older/cached catalog)', () => {
    const catalog: CodexCatalogEntry[] = [
      { id: 'gpt-5.5' },
      { id: 'gpt-5.4-mini' },
      { id: 'codex-auto-review', visibility: 'hidden' },
    ];
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-5.4-mini');
  });

  it('falls back to -nano when neither -luna nor -mini exists', () => {
    const catalog: CodexCatalogEntry[] = [
      { id: 'gpt-6-astra', visibility: 'list' },
      { id: 'gpt-6-nano', visibility: 'list' },
    ];
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-6-nano');
  });

  it('falls back to the first visibility:list entry when nothing matches luna/mini/nano', () => {
    const catalog: CodexCatalogEntry[] = [
      { id: 'codex-auto-review', visibility: 'hidden' },
      { id: 'gpt-6-astra', visibility: 'list' },
      { id: 'gpt-6-sol', visibility: 'list' },
    ];
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-6-astra');
  });

  it('never suggests a hidden entry, even when its id contains -mini/-luna/-nano', () => {
    const catalog: CodexCatalogEntry[] = [
      { id: 'gpt-reserve-mini', visibility: 'hidden' }, // would match '-mini' if not filtered
      { id: 'gpt-6-sol', visibility: 'list' },
    ];
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-6-sol');
  });

  it('falls back to the first entry when the catalog carries no visibility info at all', () => {
    const catalog: CodexCatalogEntry[] = [{ id: 'gpt-5.5' }, { id: 'gpt-5.4' }];
    expect(pickCheapestCodexModel(catalog)).toBe('gpt-5.5');
  });

  it('validateCodexModel suggests gpt-6-luna for a retired gpt-5.4-mini against the real 2026-11-05 catalog', () => {
    const authPath = seedCatalog(CATALOG_2026_11_05);
    const catalog = readCodexModelCatalog(authPath);
    const warning = validateCodexModel('gpt-5.4-mini', catalog);

    expect(warning).toBeTruthy();
    expect(warning).toContain("model 'gpt-5.4-mini' is NOT in this account's Codex catalog");
    expect(warning).toContain('suggested (cheap tier): gpt-6-luna');
    // The suggestion must never be a hidden model.
    expect(warning).not.toMatch(/suggested \(cheap tier\): gpt-reserve/);
    expect(warning).not.toMatch(/suggested \(cheap tier\): codex-auto-review/);
  });
});
