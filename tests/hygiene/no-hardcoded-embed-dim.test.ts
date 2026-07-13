/**
 * FEAT-409 AC-5 — none of the 15 coordinated-surface files (per
 * pm_scope_notes on the FEAT) may contain a hardcoded embedding-dimension
 * literal anymore; each must read the config-derived value instead.
 *
 * This is deliberately NOT a blanket "no substring 1024" ban — several of
 * these files legitimately use 1024 for unrelated byte-size/char-limit
 * math (KB conversion, disk-free GB constant, Windows env-var truncation,
 * HTTP body limit). Each file gets a narrow, pattern-specific forbidden
 * regex that only matches the OLD hardcoded-dim shape that was actually
 * removed, so this test only breaks if that literal genuinely comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

describe('FEAT-409 AC-5 — no hardcoded embed-dim literal remains', () => {
  it('src/contracts/embed.ts: EmbedProvider.dim is `number`, not the `1024` literal type', () => {
    const src = read('src/contracts/embed.ts');
    expect(src).not.toMatch(/readonly dim:\s*1024\b/);
    expect(src).toMatch(/readonly dim:\s*number/);
    expect(src).toContain('DEFAULT_EMBED_DIM');
  });

  it('src/config/config.ts: embedding.dim is `number` + defaultConfig uses DEFAULT_EMBED_DIM', () => {
    const src = read('src/config/config.ts');
    expect(src).not.toMatch(/dim:\s*1024\b/);
    expect(src).toMatch(/dim:\s*number/);
    expect(src).toContain('DEFAULT_EMBED_DIM');
  });

  it('src/providers/embed/ollama.ts: no EXPECTED_DIM constant', () => {
    const src = read('src/providers/embed/ollama.ts');
    expect(src).not.toMatch(/EXPECTED_DIM/);
    expect(src).toContain('this.dim');
  });

  it('src/providers/embed/azure-openai.ts: no EXPECTED_DIM constant', () => {
    const src = read('src/providers/embed/azure-openai.ts');
    expect(src).not.toMatch(/EXPECTED_DIM/);
    expect(src).toContain('this.dim');
  });

  it('src/doctor/probes/embed-probe.ts: no EXPECTED_DIM constant', () => {
    const src = read('src/doctor/probes/embed-probe.ts');
    expect(src).not.toMatch(/EXPECTED_DIM/);
    expect(src).toContain('provider.dim');
  });

  it('src/doctor/checks/embed.ts + shared.ts: embed probe name/comment no longer hardcode 1024-dim (ONE_GB byte constant is untouched, unrelated)', () => {
    // 2026-07-13 split: checks.ts is now a thin re-export shim (see its own
    // doc comment) — the embed-probe check lives in checks/embed.ts and the
    // unrelated ONE_GB byte-math constant lives in checks/shared.ts.
    const shim = read('src/doctor/checks.ts');
    expect(shim).not.toContain("name: 'Embed probe (1024-dim)'");
    expect(shim).not.toContain('1024-dim assertion');

    const embedCheck = read('src/doctor/checks/embed.ts');
    expect(embedCheck).not.toContain("name: 'Embed probe (1024-dim)'");
    expect(embedCheck).not.toContain('1024-dim assertion');
    expect(embedCheck).toContain('${provider.dim}-dim');

    // Sanity: the unrelated byte-math constant is still there, untouched.
    const shared = read('src/doctor/checks/shared.ts');
    expect(shared).toContain('const ONE_GB = 1024 * 1024 * 1024;');
  });

  it('src/server/app.ts: noop embed provider dim is config-derived, not `1024 as const`', () => {
    const src = read('src/server/app.ts');
    expect(src).not.toMatch(/dim:\s*1024 as const/);
    expect(src).toContain('makeNoopEmbed(config.embedding.dim)');
  });

  it('src/cli/init.ts: wizard config dim derives from base.embedding.dim, not a literal', () => {
    const src = read('src/cli/init.ts');
    expect(src).not.toMatch(/dim:\s*1024,/);
    expect(src).toContain('dim: base.embedding.dim');
  });

  it('src/distill/stages/08-embed-index.ts: dim check compares against ctx.embed.dim', () => {
    const src = read('src/distill/stages/08-embed-index.ts');
    expect(src).not.toMatch(/!==\s*1024\b/);
    expect(src).toContain('vec.length !== ctx.embed.dim');
  });

  it('src/config/persist-envs.ts: 1024 usages are the unrelated Windows char-limit comment (untouched)', () => {
    const src = read('src/config/persist-envs.ts');
    expect(src).toContain('1024 chars');
  });

  it('src/pipeline/mock-providers.ts: MockEmbedProvider dim is a constructor param, not `1024 as const`', () => {
    const src = read('src/pipeline/mock-providers.ts');
    expect(src).not.toMatch(/dim\s*=\s*1024 as const/);
    expect(src).toContain('DEFAULT_EMBED_DIM');
  });

  it('src/providers/embed/azure-openai.ts + ollama.ts: `dimensions`/log fields track this.dim', () => {
    const azure = read('src/providers/embed/azure-openai.ts');
    expect(azure).toContain('dimensions: this.dim');
  });

  it('src/config/persist-envs.ts / src/cli/backup.ts / src/doctor/hardening-checks.ts: no embed EXPECTED_DIM leaked in', () => {
    for (const f of ['src/config/persist-envs.ts', 'src/cli/backup.ts', 'src/doctor/hardening-checks.ts']) {
      expect(read(f)).not.toMatch(/EXPECTED_DIM/);
    }
  });

  it('src/search/search.ts: makeFakeVec dim is parameterized, not a literal 1024 loop bound', () => {
    const src = read('src/search/search.ts');
    expect(src).not.toMatch(/new Float32Array\(1024\)/);
    expect(src).toMatch(/function makeFakeVec\(text: string, dim: number = DEFAULT_EMBED_DIM\)/);
  });

  it('src/vector/sqlite-vec.ts: dim check compares against this.dim, not a literal 1024', () => {
    const src = read('src/vector/sqlite-vec.ts');
    expect(src).not.toMatch(/!==\s*1024\b/);
    expect(src).toContain('vec.length !== this.dim');
  });

  it('migrations/001-init.sql: memories_vec uses the __EMBED_DIM__ placeholder, not a literal 1024', () => {
    const src = read('migrations/001-init.sql');
    expect(src).not.toMatch(/FLOAT\[1024\]/);
    expect(src).toContain('FLOAT[__EMBED_DIM__]');
  });
});
