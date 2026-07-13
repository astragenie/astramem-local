---
type: handoff
created: 2026-07-13T01:15:00Z
author: lead (session 05e92741, Fable 5)
objective: FEAT-458 (LLM proxy auto-capture) is COMPLETE and merged. This hands off the open items and the lessons.
status: complete — open items are decisions, not blockers
owner: next session
---

# FEAT-458 — done. What's left, and what it taught us.

## TL;DR

All seven slices are **merged to main, locally**. Nothing is pushed. 2589 tests
pass. Capture ships **default-OFF**. The feature is **verified against real Claude
Code traffic**, not just tests.

Original estimate: 6–9 dev-days. Actual: one session. Most of that compression came
from work that already existed (the S2 relay core, FEAT-467's purge primitive,
ADR-013's design) plus parallel builders on disjoint files — not from cutting corners.

---

## What shipped

| Slice | Delivered |
|---|---|
| S1 | Bench harness, doctor row, design-gate closure artifact |
| S2 | Byte-transparent relay — AC-4: **0.34ms p50** vs a 10ms budget |
| S3 | Capture fork — header exclusion **structural**, interim security checkpoint PASS |
| S4a | 11-row failure matrix, per-request upstream timeout (config-settable) |
| S4b | Capture-live bench — **0.392 / 0.404ms p50**, ~25× under the gate |
| S4c | Capture-ON doctor WARN, disable→purge→**restore** proven against a live daemon |
| S5 | Anthropic Messages wire format + token/cache/truncation telemetry |
| S6 | `proxy_usage` → storage (migration 026, schema 25→26) |
| S7 | gzip/brotli/zstd decompression **from body bytes alone** |

## Verified live (the part that matters)

Real Claude Code session, capture ON, isolated dataDir:

- **Full exchange captured** — user + assistant, reply verbatim, decompressed from
  gzip and parsed from the Anthropic Messages wire.
- **Real telemetry**: `input=30311, output=41, cache_write=2812, cache_read=86999,
  model=claude-opus-4-8, stop_reason=end_turn`.
- **A real OAuth token transited the proxy and NEVER reached the store.** Clean on
  all seven credential patterns (`sk-ant`, `Bearer`, `x-api-key`, `authorization`,
  `oauth`, `anthropic-beta`, `sessionKey`). Not scrubbed — never present, because
  the tee is structurally handed body bytes and has no field capable of carrying a
  header. **This is the invariant. Do not trade it away.** S7 was specifically
  forbidden from reading `Content-Encoding` for exactly this reason, and found
  another way (magic-number sniffing + speculative brotli decode).

---

## OPEN ITEMS

### 1. FEAT-478 — capture can spool a question with no answer (NEEDS A DECISION)

**Filed, not fixed. Deliberately.** Found by the live test.

The relevance gate runs **per turn**; the proxy captures an **exchange**. A real
reply of `"gzip."` (5 chars) fell under the default `minChars: 8`, got gated out,
and the long user prompt survived — spooling an orphaned question. Terse answers
are high-signal and are exactly what this gate discards.

**Why I didn't just fix it:** the fix contradicts two tests other builders wrote
*deliberately* (`proxy-decompress.test.ts` and `usage-storage-e2e.test.ts` both
assert a user turn should survive alone). That is a product judgment call — is the
unit of capture the turn or the exchange? — not a bug I should unilaterally
overturn. Full evidence, both options, and ACs are in
`.claude/artifacts/loop/backlog/pending/FEAT-478.md`.

There is also a smaller, less contested sub-issue in there: dedup hashes are
recorded for turns in exchanges that are then discarded, which can silently
suppress a later identical question that *did* get answered.

### 2. Production enablement — operator's call, still gated

DEC-014 permits **development** ahead of the bake gate; it does **not** permit
enablement. That is unchanged and I did not quietly move it. Capture is
default-OFF in the shipped config (`src/config/config.ts:424`). Turning it on
requires four deliberate acts (run `proxy serve`, point a client's base URL at it,
`proxy.enabled`, `proxy.capture.enabled`) — see §"How to turn it on/off" below.

### 3. Nothing is pushed

Every merge is local to `main`. No tags, no release. That is yours.

### 4. FEAT-476 / FEAT-477 — filed, unscored

- **FEAT-476** — cost attribution: tokens → dollars → slices. The proxy now stores
  raw counts + model id; dollars must be **derived at read time** from a config
  pricing table, never persisted (a price correction must re-derive history, not
  leave a stratum priced under a stale table). Absent usage must never be counted
  as `$0`.
- **FEAT-477** — recall efficacy measured from the wire. The live daemon reports
  `served: 349, used: 0, rate: 0`, because `recall_used` only fires when an agent
  voluntarily calls `mark_memory_used`, which agents never do. That zero is
  currently **unfalsifiable** — it could be a broken thermometer or a broken
  product, and those point in opposite directions. The proxy is the only instrument
  that can tell you which. Arguably the highest-value thing this feature unlocks.

---

## How to turn it on / off (the operator asked; recording it here)

**On** requires four deliberate acts — it cannot happen by accident:
1. Run `astramem-local proxy serve --port N --upstream <url>`. **The daemon never
   starts the proxy** — it doesn't even read the proxy config block. No process, no
   proxy.
2. Point a client at it (`ANTHROPIC_BASE_URL=http://127.0.0.1:N`). Without this,
   nothing routes through.
3. `proxy.enabled: true` in config.yaml.
4. `proxy.capture.enabled: true` — a **separate** opt-in. You can run the relay with
   capture off and get a pure transparent forward.

**Off:**
- Relay: stop the process, or unset the base URL. Instant.
- Capture: `astramem-local capture proxy disable [--purge|--keep]`.
- Data: the disable flow calls the FEAT-467 purge primitive scoped to
  `capture_source='proxy'` — it removes proxy-captured atoms and **leaves
  `auto_capture`/`hook_close` rows untouched** (proven e2e). The purge opens a
  **bounded restore window** — verified reversible against a live daemon.

---

## LESSONS — read these before touching capture again

### Synthetic fixtures lie about the wire

**2743 tests passed, a hard security review passed, and four slices merged — while
the feature silently threw away half of every real conversation. Twice, for two
unrelated reasons.**

1. The fork parsed **OpenAI** chat-completions (`choices[].delta.content`). Claude
   Code speaks the **Anthropic Messages API**, which has no `choices` field at all.
2. Anthropic **gzips** responses. The tee got `1f 8b`, failed `JSON.parse`, failed
   SSE parse, returned `null`.

Both had the same signature — **silent half-success**: an envelope spools, no error
is raised, the doctor count rises, and half the data is gone. Every fixture in the
suite fed plaintext OpenAI JSON from a stub we wrote ourselves. The suite was
internally consistent and collectively wrong about reality.

Ten seconds of probing the built parser with real Anthropic bytes found what a full
day of green tests could not. **For any protocol boundary, at least one fixture must
be real captured bytes.** One live call beats a thousand green assertions.

### A validation layer that discards data is a data-loss device

**Five bugs in this one feature, all the same species — a layer reporting success
while dropping data:**

1. `spool-drain`'s zod enum **quarantined** `capture_source: 'proxy'` envelopes as
   poison after 5 retry ticks.
2. The parser **dropped every assistant reply** (wrong wire format).
3. Then dropped them again (**gzip**).
4. `CanonicalIngestSchema` is zod **default `strip` mode** — an unmodeled field is
   *silently deleted* at parse, not rejected. `proxy_usage` would have sat in the
   spool JSON looking perfectly wired and evaporated at drain.
5. **The bench itself** would have certified a PASS while measuring a capture path
   that captured nothing (its `'{}'` stub body never parsed as a chat shape, so
   `finishCapture()` returned early and the spool write never ran).

And FEAT-478 is a sixth, by a different route.

**The only reason any of these got caught:** every builder was required to prove its
test **fails without the fix** — revert the change, watch the data vanish, restore
it. A test that merely passes proves nothing here. A route-level test would have
passed with the drain-path bug fully present; only driving the real `drainIngestSpool`
discriminated.

**When adding a field to a captured envelope, the chain is: migration → zod schema →
INSERT statement → producer.** Miss any link and the data dies there, quietly.

### Operational

- **Test runner is `vitest`** (`bunx vitest run`). **`bun test` hangs silently**
  (better-sqlite3 incompat, Bun #4290) and reads as a broken branch. Fresh worktrees
  need `bun install` (no node_modules) + `bun run build` (CLI tests spawn `dist/`).
  `tsc -p tsconfig.tests.json` has ~111 pre-existing errors — **not a gate**.
- **A worktree merge reaches the live system.** The repo's `post-merge` hook rebuilds
  and *reinstalls the operator's daemon* whenever `migrations/` or `src/storage/`
  change. Merging S6 migrated the live DB 25→26. Additive and safe here, but not silent.
- **Never kill by image name.** The operator's live daemon, Ollama, sibling agents,
  and possibly a multi-hour eval share this box. PID-scoped kills only.
- **A stale branch far behind main with junk merge commits:** take the files, not the
  history. `git diff --stat main...branch` showing insertions-only ⇒ cherry-pick the
  one work commit onto fresh main. `w458s2` was 27 behind with two duplicate merges;
  the cherry-pick took 30 seconds and the problem evaporated.

---

## Key files

| What | Where |
|---|---|
| The capture fork | `src/capture/proxy.ts` |
| The relay (byte-transparent, do not add a parse step) | `src/proxy/server.ts` |
| Header-exclusion regression test — **load-bearing** | `tests/proxy/canary-header-exclusion.test.ts` |
| Structural proof the relay imports no capture code | `tests/proxy/zero-capture-imports.test.ts` |
| The security ADR | `docs/adr/ADR-013-llm-proxy-auto-capture.md` |
| Gate override (honest version) | `.claude/artifacts/loop/decisions/DEC-014.md` |
| Open bug — needs a decision | `.claude/artifacts/loop/backlog/pending/FEAT-478.md` |
| Cost attribution | `.claude/artifacts/loop/backlog/pending/FEAT-476.md` |
| Recall efficacy | `.claude/artifacts/loop/backlog/pending/FEAT-477.md` |

## Suggested next steps

1. **Decide FEAT-478** (turn vs exchange). It is shipping bad data today, behind a
   default-OFF flag.
2. Then FEAT-477 (recall efficacy) — it answers a question about the business, not
   the bill, and `served: 349 / used: 0` is currently unfalsifiable.
3. FEAT-476 (cost) after that.
4. Production enablement whenever you want it — but that is a deliberate operator
   act, and the bake gate is still the stated precondition.
