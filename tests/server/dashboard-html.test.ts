import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../../src/server/routes/dashboard-html.js';
import { defaultConfig } from '../../src/config/config.js';
import type { DashboardData, DashboardHealth } from '../../src/server/queries/dashboard.js';

// FEAT-410 SLICE-410-4: Mission Control rewrite of renderDashboard.
// Codes against the ACTUAL DashboardData/DashboardHealth DTOs exported by
// queries/dashboard.ts (SLICE-410-1), not the design-doc mockup's literal
// field names/shapes.

function baseData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    memoryCounts: [],
    recentMemories: [],
    jobStates: [],
    jobStatesByKind: [],
    hourlyThroughput: [],
    todaySpend: null,
    mtdSpend: 0,
    mtdCalls: 0,
    usefulness: { served: 0, used: 0, rate: null },
    consolidation: { count: 0, oldest: null },
    recentFailedJobs: [],
    entityLinkage: { entityCount: 0, unlinkedMemoryCount: 0 },
    health: null,
    ...overrides,
  };
}

function healthyHealth(): DashboardHealth {
  return {
    status: 'ok',
    uptimeSeconds: 120,
    embed: { ok: true, lastOkAt: Date.now(), lastError: null, attempts: 1 },
    worker: { alive: true, lastTickAt: Date.now() - 3000, lastTickAgoMs: 3000 },
    diskFreeBytes: 42 * 1024 * 1024 * 1024,
  };
}

function degradedHealth(overrides: Partial<DashboardHealth> = {}): DashboardHealth {
  return {
    status: 'degraded',
    uptimeSeconds: 120,
    embed: { ok: false, lastOkAt: null, lastError: 'ollama unreachable', attempts: 3 },
    worker: { alive: true, lastTickAt: Date.now() - 3000, lastTickAgoMs: 3000 },
    diskFreeBytes: 42 * 1024 * 1024 * 1024,
    ...overrides,
  };
}

const config = defaultConfig();

describe('renderDashboard — Mission Control (FEAT-410 SLICE-410-4)', () => {
  // AC-1
  it('AC-1: healthy HealthState shows an OK banner naming each subsystem individually', () => {
    const html = renderDashboard(baseData({ health: healthyHealth() }), config);
    expect(html).toContain('DAEMON OK');
    expect(html.toLowerCase()).toContain('embed:ok');
    expect(html.toLowerCase()).toContain('worker:alive');
    expect(html.toLowerCase()).toContain('disk:');
  });

  // AC-2
  it('AC-2: embed.ok=false renders a DEGRADED banner naming the failing subsystem, page still renders fully', () => {
    const html = renderDashboard(baseData({ health: degradedHealth() }), config);
    expect(html).toContain('DAEMON DEGRADED');
    expect(html).toContain('embed');
    expect(html).toContain('</html>');
  });

  it('AC-2: worker.alive=false renders DEGRADED even when embed.ok=true', () => {
    const health = healthyHealth();
    health.worker = { alive: false, lastTickAt: null, lastTickAgoMs: null };
    const html = renderDashboard(baseData({ health }), config);
    expect(html).toContain('DAEMON DEGRADED');
    expect(html).toContain('worker');
    expect(html.toLowerCase()).toContain('worker:dead');
  });

  it('does not crash and reports UNKNOWN when health is null (bare test apps)', () => {
    const html = renderDashboard(baseData({ health: null }), config);
    expect(html).toContain('DAEMON UNKNOWN');
    expect(html).toContain('</html>');
  });

  // AC-3
  it('AC-3: zero pending proposals renders an explicit "0" state, not blank or NaN', () => {
    const html = renderDashboard(baseData({ consolidation: { count: 0, oldest: null } }), config);
    expect(html).toContain('0 pending proposals');
    expect(html).not.toContain('NaN');
  });

  it('AC-3: zero failed/poison jobs renders explicit "0" counts, not blank or NaN', () => {
    const html = renderDashboard(baseData({ jobStates: [] }), config);
    expect(html).not.toContain('NaN');
    // JOBS strip must show explicit zeros for all four states even when
    // the GROUP BY query returned no rows for any of them.
    const jobsSection = html.slice(html.indexOf('<h3>Jobs</h3>'), html.indexOf('<h3>Consolidation</h3>'));
    expect(jobsSection).toContain('>0<');
  });

  // AC-4
  it('AC-4: pipeline row shows per-stage pending/running counts from jobStatesByKind', () => {
    const html = renderDashboard(baseData({
      jobStatesByKind: [
        { kind: 'distill', state: 'pending', count: 3 },
        { kind: 'distill', state: 'running', count: 1 },
        { kind: 'reembed', state: 'poison', count: 1 },
      ],
    }), config);
    expect(html).toContain('3p / 1r');
  });

  it('AC-4: entity-link stage shows linked/unlinked memory counts, not a job-kind count', () => {
    const html = renderDashboard(baseData({
      entityLinkage: { entityCount: 248, unlinkedMemoryCount: 2 },
    }), config);
    expect(html).toContain('248 ent');
    expect(html).toContain('2 unlinked');
  });

  // AC-5
  it('AC-5: demoted sections do not appear in their old form', () => {
    const html = renderDashboard(baseData({
      memoryCounts: [{ type: 'fact', count: 10 }],
      recentMemories: Array.from({ length: 25 }, (_, i) => ({
        id: `m${i}`, type: 'fact', text: `memory ${i}`, importance: 0.5, confidence: 0.5,
        session_id: null, created_at: Date.now() - i * 1000,
      })),
    }), config);
    // Old headers must be gone.
    expect(html.toLowerCase()).not.toContain('memory counts by type');
    expect(html.toLowerCase()).not.toContain('recent captures (last 25)');
    // Budget is a single collapsed tile, not Today/MTD 4-decimal side-by-side.
    expect(html).not.toMatch(/\$\d+\.\d{4}/);
    expect(html.toLowerCase()).not.toContain('mtd');
  });

  it('AC-5: recent-activity feed merges failures and memories, capped well under 25 rows', () => {
    const html = renderDashboard(baseData({
      recentFailedJobs: [
        { id: 'j1', kind: 'distill', state: 'poison', last_error: 'ollama embed timeout', updated_at: Date.now() },
      ],
      recentMemories: Array.from({ length: 25 }, (_, i) => ({
        id: `m${i}`, type: 'fact', text: `memory ${i}`, importance: 0.5, confidence: 0.5,
        session_id: null, created_at: Date.now() - i * 1000,
      })),
    }), config);
    expect(html).toContain('ollama embed timeout');
    const rowMatches = html.match(/<tr>/g) ?? [];
    // 1 header <tr> + up to 15 body rows in the feed table; well under the
    // old 25-row recent-captures table.
    expect(rowMatches.length).toBeLessThan(20);
  });

  // AC-6 (regression guard — this slice must not touch auth)
  it('AC-6: does not render any auth-bearing content (rendering-only concern)', () => {
    const html = renderDashboard(baseData(), config);
    expect(html.toLowerCase()).not.toContain('bearer');
    expect(html.toLowerCase()).not.toContain('astramem_dash');
  });

  it('stays zero-JS except the one deliberate copy-to-clipboard script, no external assets, keeps <meta refresh>', () => {
    const html = renderDashboard(baseData(), config);
    // Exactly one inline <script> — the copy-to-clipboard exception — not
    // scattered inline onclick handlers or a second script block.
    const scriptMatches = html.match(/<script[\s>]/g) ?? [];
    expect(scriptMatches.length).toBe(1);
    expect(html).toContain('navigator.clipboard.writeText');
    // No external script src, no CDN, no eval — the exception stays a tiny
    // self-contained block.
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toContain('eval(');
    expect(html).not.toMatch(/onclick=/i);
    // 30s, not 5s: the page cold-renders in ~7.9s on a real store, so a 5s
    // refresh reloaded BEFORE the previous render finished — stacking synchronous
    // better-sqlite3 queries and starving /health. See dashboard-html.ts.
    expect(html).toContain('<meta http-equiv="refresh" content="30">');
    expect(html).not.toMatch(/https?:\/\//);
  });

  // Operator request: INFO column truncation gave no way to read or copy the
  // full memory/error text (screenshot in the originating handoff).
  describe('expandable INFO cell (full text + copy)', () => {
    it('renders the full, untruncated memory text in the DOM even though the visible summary is still short', () => {
      const longText = 'A review was sent to team-lead with a PASS summary for `.claude/artifacts/crew/reviews/some-long-review-file-name-that-would-normally-be-truncated.md` and other details that go on for a while.';
      const html = renderDashboard(baseData({
        recentMemories: [{
          id: 'm1', type: 'fact', text: longText, importance: 0.5, confidence: 0.5,
          session_id: null, created_at: Date.now(),
        }],
      }), config);
      // Full text appears verbatim (HTML-escaped) inside a <pre>, not just
      // the truncated preview.
      expect(html).toContain('<pre class="full-text">');
      expect(html).toContain(longText);
      expect(html).toContain('<details>');
      expect(html).toContain('<summary class="trunc">');
    });

    it('escapes <, &, ", and backticks in memory text in both the preview and the full text', () => {
      const nasty = 'a <script>alert("x")</script> & `backtick` "quoted" text';
      const html = renderDashboard(baseData({
        recentMemories: [{
          id: 'm1', type: 'fact', text: nasty, importance: 0.5, confidence: 0.5,
          session_id: null, created_at: Date.now(),
        }],
      }), config);
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&quot;quoted&quot;');
      // Backticks need no HTML escaping to be safe (they're not HTML-special),
      // but the raw nasty payload must never appear as an executable <script>
      // tag distinct from the one fixed copy-to-clipboard block.
      expect(html).toContain('`backtick`');
      const scriptTags = html.match(/<script[\s>]/g) ?? [];
      expect(scriptTags.length).toBe(1);
      expect(html).not.toContain('<script>alert("x")</script>');
    });

    it('escapes <, &, ", and backticks in job error text the same way', () => {
      const nasty = 'timeout on <tag> & "quoted" `backtick`';
      const html = renderDashboard(baseData({
        recentFailedJobs: [
          { id: 'j1', kind: 'distill', state: 'poison', last_error: nasty, updated_at: Date.now() },
        ],
      }), config);
      expect(html).toContain('&lt;tag&gt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&quot;quoted&quot;');
      expect(html).toContain('`backtick`');
    });

    it('renders one copy button per expandable row, each reading its sibling <pre> rather than an embedded JS string', () => {
      const html = renderDashboard(baseData({
        recentMemories: [
          { id: 'm1', type: 'fact', text: 'first memory text', importance: 0.5, confidence: 0.5, session_id: null, created_at: Date.now() },
          { id: 'm2', type: 'fact', text: 'second memory text', importance: 0.5, confidence: 0.5, session_id: null, created_at: Date.now() - 1000 },
        ],
      }), config);
      const copyButtons = html.match(/class="copy-btn"/g) ?? [];
      expect(copyButtons.length).toBe(2);
      // Neither memory's text is templated into the script block itself —
      // the button reads DOM content at click time instead.
      const scriptBody = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
      expect(scriptBody).not.toContain('first memory text');
      expect(scriptBody).not.toContain('second memory text');
      expect(scriptBody).toContain('previousElementSibling');
    });

    it('the INFO column is wider than before (readability requirement)', () => {
      const html = renderDashboard(baseData(), config);
      expect(html).toMatch(/\.trunc\{max-width:460px/);
    });
  });

  // Pagination — PER_PAGE=15, in-memory slice over the already-fetched
  // recentFailedJobs + recentMemories rows (no new SQL). Task 2 already
  // sized the page at 15 rows; this just lets an operator page beyond it.
  describe('recent-activity feed pagination (?page=)', () => {
    function manyMemories(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        id: `m${i}`, type: 'fact', text: `memory ${i}`, importance: 0.5, confidence: 0.5,
        session_id: null, created_at: Date.now() - i * 1000,
      }));
    }

    it('page 1 (default, no rawPage arg) shows the newest 15; page 2 shows the rest', () => {
      const data = baseData({ recentMemories: manyMemories(20) });
      const page1 = renderDashboard(data, config);
      const page2 = renderDashboard(data, config, '2');

      expect(page1).toContain('memory 0');
      expect(page1).toContain('memory 14');
      expect(page1).not.toContain('memory 15');

      expect(page2).toContain('memory 15');
      expect(page2).toContain('memory 19');
      expect(page2).not.toContain('memory 0');
    });

    it('renders the "page N/M — showing X–Y of Z" caption and a next link', () => {
      const data = baseData({ recentMemories: manyMemories(20) });
      const html = renderDashboard(data, config, '1');
      expect(html).toContain('page 1/2');
      expect(html).toContain('of 20');
      expect(html).toContain('href="/dashboard?page=2"');
      expect(html).not.toContain('href="/dashboard?page=0"');
    });

    it('next is omitted (inert) on the last page; prev links back', () => {
      const data = baseData({ recentMemories: manyMemories(20) });
      const html = renderDashboard(data, config, '2');
      expect(html).toContain('page 2/2');
      expect(html).toContain('href="/dashboard?page=1"');
      expect(html).not.toContain('href="/dashboard?page=3"');
    });

    it('an out-of-range page clamps to the last valid page', () => {
      const data = baseData({ recentMemories: manyMemories(20) });
      const html = renderDashboard(data, config, '999');
      expect(html).toContain('memory 19');
      expect(html).toContain('page 2/2');
    });

    it('keeps the bare <meta refresh content="30"> unconditionally — same-URL reload preserves ?page= without echoing it into the tag', () => {
      const data = baseData({ recentMemories: manyMemories(20) });
      const html = renderDashboard(data, config, '2');
      expect(html).toContain('<meta http-equiv="refresh" content="30">');
    });
  });

  it('renders the Mission Control nav tab row', () => {
    const html = renderDashboard(baseData(), config);
    expect(html).toContain('Mission Control');
    expect(html).toContain('/dashboard/jobs');
    expect(html).toContain('/dashboard/consolidation');
    expect(html).toContain('/dashboard/search');
  });

  // Migration 040: provider_state (zero writers, ever) is dropped and the
  // strip that used to read it is repointed at config.embedding + the live
  // HealthState.embed data instead of being deleted outright.
  describe('Embedding strip (migration 040 repoint)', () => {
    it('renders provider/model/dim from config — never blank, unlike the old provider_state-backed widget', () => {
      const html = renderDashboard(baseData({ health: null }), config);
      expect(html).toContain('<h3>Embedding</h3>');
      expect(html).toContain('ollama/mxbai-embed-large');
      expect(html).toContain('1024-dim');
      // The old "no providers registered" empty state must be gone entirely
      // — the panel always has something true to show now.
      expect(html).not.toContain('no providers registered');
      expect(html).not.toContain('Providers / Storage');
    });

    it('shows OK when health.embed.ok is true', () => {
      const html = renderDashboard(baseData({ health: healthyHealth() }), config);
      const section = html.slice(html.indexOf('<h3>Embedding</h3>'), html.indexOf('</section>', html.indexOf('<h3>Embedding</h3>')));
      expect(section).toContain('<span class="ok">OK</span>');
    });

    it('shows FAIL with the truncated error when health.embed.ok is false', () => {
      const html = renderDashboard(baseData({
        health: degradedHealth({ embed: { ok: false, lastOkAt: null, lastError: 'ollama unreachable', attempts: 3 } }),
      }), config);
      const section = html.slice(html.indexOf('<h3>Embedding</h3>'), html.indexOf('</section>', html.indexOf('<h3>Embedding</h3>')));
      expect(section).toContain('FAIL');
      expect(section).toContain('ollama unreachable');
    });

    it('shows a starting/muted state, not OK or FAIL, when health is null (bare test apps) or embed.ok is null', () => {
      const html = renderDashboard(baseData({ health: null }), config);
      const section = html.slice(html.indexOf('<h3>Embedding</h3>'), html.indexOf('</section>', html.indexOf('<h3>Embedding</h3>')));
      expect(section).toContain('starting');
      expect(section).not.toContain('class="ok"');
      expect(section).not.toContain('class="err"');
    });

    it('layout stays coherent — the strips row still renders exactly 3 strip divs, no orphaned/collapsed grid cell', () => {
      const html = renderDashboard(baseData({ health: healthyHealth() }), config);
      const stripsSection = html.slice(html.indexOf('class="strips"'), html.indexOf('class="strips2"'));
      const stripDivs = stripsSection.match(/<div class="strip">/g) ?? [];
      expect(stripDivs.length).toBe(3);
    });
  });
});
