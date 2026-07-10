# FEAT-455 Security Spike — Results

**Status:** spike complete, findings below · **Date:** 2026-07-09
**Gate:** ADR-012 (`docs/adr/ADR-012-auto-capture-security-model.md`) — this document
executes the 9-item spike checklist at the end of that ADR. Per the ADR, FEAT-455 may not
be sliced until this checklist is complete and the ADR itself moves `proposed` → `accepted`.

This spike is code/spec only — no LLM calls were made (Ollama was reserved for a concurrent
eval run per the dispatch brief). Everything below is either a runnable test against
already-shipped code, or a design document for code that does not exist yet.

---

## Checklist #1 — Hook-tap trigger mechanism confirmed, no new observation surface

**Claim to verify:** the concrete hook-tap trigger (per-turn hook vs. short-interval re-read)
adds no new observation surface beyond what today's session-end hook already reads.

**Finding: confirmed, by construction, for both candidate mechanisms.**

Today's capture path (`src/cli/capture.ts:63-114`, `runCaptureClaudeOnce`) is invoked
synchronously by the Claude Code `SubagentStop`/`session_end` hook, reads the on-disk
`.jsonl` transcript file **once**, and spools every turn found in it
(`readAndParseClaudeTranscript` → `src/capture/claude.ts:119-125`, a single `readFileSync`).
The data source is the transcript file Claude Code itself already writes — capture never
opens any file, socket, or API that isn't already part of Claude Code's own on-disk
session log.

Two mechanisms were evaluated for "denser sampling" (ADR-012 decision 1, tier 1):

1. **Per-turn hook** — invoke the same `capture claude` CLI after every `Stop`/`PostToolUse`
   event instead of only at `SubagentStop`/`session_end`. Reads the identical file via the
   identical `readAndParseClaudeTranscript` call; only the *hook registration* (which Claude
   Code lifecycle events call the CLI) changes, not what the CLI reads.
2. **Short-interval re-read** — a background poller that re-reads the same growing `.jsonl`
   file on a timer. This pattern already exists in this exact module for the Codex
   connector (`src/cli/capture.ts:127-139`, the `--watch` flag) — sibling precedent for the
   same session-directory-polling idea, applied to Claude Code's single growing transcript
   file instead of Codex's directory of session files.

Both mechanisms observe the same file today's `session_end` hook already has read access to;
neither introduces a new API surface, a new file, or a new privilege boundary. This
satisfies the checklist item structurally, not by assertion.

**Open item for the build slice (not resolved here):** which of the two mechanisms Claude
Code's actual hook surface supports for the "per-turn" option (does the plugin's hook
registration expose a granularity finer than `SubagentStop`/`Stop`?) needs one concrete check
against the `astramem-plugin` hook config at build time — this spike confirms the
observation-surface property holds under *either* answer, so it does not block acceptance,
but the build slice should not assume per-turn is available without checking.

---

## Checklist #2 — Relevance-gate taxonomy spec

**Distinctness requirement (AC-6, `src/distill/durability-gate.ts:1-11`):** this gate must
not be `durability-gate.ts`, must not reuse its taxonomy, and must not house any of its 5
reasons (`ephemeral_state`, `git_derivable`, `vacuous_negative`, `bare_todo`,
`path_fragment`). Those are a **post-distillation, formed-atom** classification; this gate
operates on **raw, pre-distillation turns**.

### Module

New file: `src/capture/relevance-gate.ts` (does not exist yet — spec only).

```ts
export type GatedRelevanceReason = 'too_short' | 'too_large' | 'duplicate_recent' | 'structural_junk';

export interface RelevanceGateOptions {
  minChars: number;        // size floor
  maxBytes: number;        // size cap, per turn
  dedupWindow: number;     // last K turns hashed per session
}

export function gateRelevance(
  turn: { role: 'user' | 'assistant'; text: string },
  recentHashes: Set<string>,     // caller-owned per-session ring buffer of the last K turn hashes
  opts: RelevanceGateOptions,
): GatedRelevanceReason | null;
```

Pure function, mirrors `classifyDurability`'s shape (text in, reason-or-null out) — but the
*caller* owns per-session dedup state (an in-process `Map<sessionId, string[]>` ring buffer
in `src/cli/capture.ts`, not persisted — a daemon/CLI restart resetting the dedup window is
an acceptable cold-start cost, not a correctness bug, since dedup exists only to cut
same-tick re-spool volume, not as a durability guarantee).

### Three checks (size caps, dedup window, junk heuristics)

1. **Size caps.**
   - Floor: `minChars` (default proposal: 8) — skip a turn that trims to fewer characters
     than this (a bare "ok", "yes", emoji reaction). Companion to, and independent of,
     `durability-gate`'s `bare_todo`/word-count logic — this is a byte-count floor on raw
     text, not a semantic judgment.
   - Cap: `maxBytes` (default proposal: 65536 — 64KB per turn) — a turn larger than this is
     almost certainly a giant pasted log/dump rather than conversational content; gated here
     rather than let through to hit the spool's own oversize quarantine
     (`src/ingest/spool.ts`'s `.quarantine/` handling, sized for whole-transcript envelopes
     at a much larger ceiling — CLAUDE.md's `ingest.spoolMaxBytes` default 32MB is the
     *envelope* cap, not a per-turn cap; this is a smaller, source-side companion, not a
     duplicate of it).
2. **Dedup window.** SHA-256 (or a cheaper non-cryptographic hash — either is acceptable
   since this is a volume control, not a security boundary) of the turn's normalized text,
   checked against the last `dedupWindow` (default proposal: 20) captured-turn hashes for
   that session. A rapid-refiring hook (e.g. a per-turn trigger firing on a tool-loop that
   re-emits near-identical assistant text) does not re-spool the same content repeatedly.
3. **Junk heuristics — structural only.** Explicitly NOT the durability-gate's semantic
   taxonomy. Structural checks only: turn text that, after trim, is empty; is only
   punctuation/whitespace; or is a bare repeated-character run (e.g. `"....."`, `"ok ok ok"`).
   No keyword/regex taxonomy resembling `ephemeral_state`/`git_derivable`/etc. is permitted
   here per AC-6 — if a future need for semantic filtering emerges at this layer, that is a
   new ADR, not an extension of this gate.

### Wiring point

Called from `src/cli/capture.ts`'s `runCaptureClaudeOnce`, filtering `parsed.turns` **before**
`buildClaudeEnvelope`/`writeToSpool` — the same place the existing
`parsed.turns.length === 0` short-circuit already lives (`capture.ts:87-96`), extended to a
per-turn filter rather than only an all-turns-empty check. This keeps the gate entirely
client-side (spool-write time), matching ADR-012 §2's "gates what gets written to the ingest
spool in the first place."

### Config surface

`capture.autoCapture.relevanceGate.{minChars,maxBytes,dedupWindow}` — see checklist #7 below
for the full config block; kept fully separate from `distill.durabilityGate.*`.

---

## Checklist #3 — Secrets-pattern tests against auto-captured payload shapes

**Code delivered** (both suites run green, `bun run test`):

- `tests/security/redact-autocapture.test.ts` (10 tests) — `redactText` against auto-capture
  shapes: high-frequency same-secret bursts, partial/truncated mid-stream turns, multi-line
  env dumps, connection strings, markdown-code-fenced secrets.
- `tests/capture/claude-tool-arg-exclusion.test.ts` (3 tests) — proves `tool_use`/
  `tool_result` block content never reaches `parseClaudeTranscript`'s output turns at all
  (see checklist #8 — this is the evidence backing the non-mutation/narrower-disclosure-
  surface claim, not a redaction test per se, but placed here because it directly answers
  "does the auto-capture *shape* introduce a new leak path").

### Confirmed: stage-0 redaction holds for the auto-capture shapes tested

- High-frequency re-capture of the same secret across a 5-turn burst redacts consistently
  (same `hash8` every time — the existing determinism guarantee holds at the new frequency).
- A full secret landing intact inside a short/partial turn is redacted normally.
- A labeled truncated token (`token=<16-of-38-chars>`) is still caught — by the
  `generic_credential` fallback (the label does the work), even though the vendor-specific
  `github_token` pattern requires the full ≥20-char suffix and does not match the fragment
  on its own.
- An *unlabeled* truncated fragment is still caught by the entropy detector, **provided** the
  fragment is ≥ 20 characters (`MIN_TOKEN_LENGTH`, `src/redact/entropy.ts:10`).
- Multi-line `.env`-shaped dumps: every labeled credential line redacted, non-secret lines
  (`NODE_ENV=production`, `PORT=7777`) untouched.
- A SCREAMING_SNAKE_CASE-labeled value (`OPENAI_API_KEY=sk-proj-...`) with real randomness
  is rescued by the entropy fallback even though the labeled `generic_credential` detector
  misses it (see gap below) — confirmed for two different value shapes, not assumed.
- Secrets inside markdown code fences are unaffected by the fence syntax.

### Confirmed gaps (honest findings, not glossed over)

1. **Truncation below the entropy floor.** A secret fragment shorter than 20 characters, with
   no adjacent `key=`/`token=`/etc. label, passes through completely unredacted — neither the
   vendor pattern (too short) nor the entropy detector (`MIN_TOKEN_LENGTH` floor) catches it.
   This is a real, denser-sampling-relevant gap: a mechanism reading mid-stream (checklist #1)
   is more likely to observe a secret token before it has fully rendered than today's
   session-end-only capture ever was.
2. **`\b` word-boundary miss on compound SCREAMING_SNAKE_CASE labels.** The
   `generic_credential` detector's leading `\b` does not match between two word characters
   (`_` is a word character in JS regex), so `INTERNAL_SECRET=`, `OPENAI_API_KEY=`,
   `DB_PASSWORD=` etc. never match the labeled detector — only the entropy fallback can
   rescue these, and only when it does (see #3 below). This is a pre-existing property of
   `src/redact/detectors.ts:74-80`, not something auto-capture introduces, but auto-capture's
   env-dump-shaped fixtures make it more likely to matter in practice.
3. **Value-dependent rescue.** `INTERNAL_SECRET=abc123` is not redacted by anything —
   confirmed by direct measurement, not assumed: its Shannon entropy is 3.97 bits/char,
   just under the 4.0 default threshold. `DB_PASSWORD=letmein123456` and
   `SERVICE_PWD=abc123456` (same compound-label shape) ARE rescued by entropy at 4.30–4.40
   bits/char. The residual gap is specifically "compound-labeled + moderate-entropy value",
   not the whole shape.

**Recommendation, not implemented in this spike (out of scope — this is a coverage report,
not a redaction-engine change):** none of these three gaps are new problems auto-capture
creates from nothing — they are pre-existing stage-0 properties that auto-capture's higher
frequency and partial-turn shapes make more likely to be exercised. ADR-012 §3 sets the ship
gate as "confirm stage-0 redaction coverage holds under the new shape and frequency," which
this suite does — coverage holds for the large majority of realistic shapes, with three
narrow, now-documented exceptions a future stage-0 hardening pass can target explicitly
(tracked as a follow-up, not a blocker — see GO/NO-GO below).

---

## Checklist #4 — Provenance tagging spec

**Requirement (ADR-012 decision 4):** "Auto-captured envelopes need a provenance tag ...
distinguishable from manual hook captures — required by decision 4 (WARN counts, purge
scoping)."

**Finding:** no such tag exists today. `memories.agent` (wire-mapped to `tool` —
`src/contracts/atom-wire.ts:27,68`) already distinguishes *which client* captured something
(e.g. `'claude-code'`), but not *which capture path* within that client did — both today's
`session_end`/`subagent_stop` hook and the future denser auto-capture trigger would set
`agent: 'claude-code'` identically. A dedicated field is required, confirming ADR-012 §4's
premise (this is not already solved by an existing column).

### Proposed schema (additive, new migration)

```sql
ALTER TABLE memories ADD COLUMN capture_source TEXT;
CREATE INDEX idx_memories_capture_source ON memories(capture_source) WHERE capture_source IS NOT NULL;
```

- `NULL` (default) — every existing row, and every future row from a write path that isn't
  auto-capture (`/remember`, manual hook capture, Codex capture, distill pipeline). Byte-
  identical to today for all non-auto-capture paths — no existing INSERT statement changes.
- `'auto_capture'` — the only value the new tier ever writes.

Partial index (`WHERE capture_source IS NOT NULL`) keeps the doctor count query (checklist
#6) and the purge-scoping query (checklist #5) cheap without indexing the entire table for a
column that is `NULL` on every pre-FEAT-455 row.

**Not reused:** `evidence` (`contracts/memory.ts:85`) is semantically a citation/extraction
field already populated by the distill pipeline (`src/distill/stages/08-embed-index.ts:174`,
`mem.evidence`) — repurposing it for provenance would collide with real content on any atom
that goes through normal distillation. (The purge-flow test in checklist #5 below uses
`evidence` as a throwaway stand-in *only* because it is otherwise unused in that test's
synthetic fixtures — this is a test-scaffolding convenience, not a recommendation; the real
implementation must use the dedicated column above.)

### Propagation path

`ClaudeCaptureEnvelope` (`src/capture/claude.ts:47-62`) gains an additive optional field:

```ts
capture_source?: 'auto_capture'; // present only when built by the new denser-sampling trigger
```

Set only by the new trigger path's envelope builder (a variant of `buildClaudeEnvelope`, or a
new parameter on it); today's `session_end`/`subagent_stop` call path never sets it, so
existing captures are entirely unaffected. `POST /ingest/transcript`'s canonical-envelope
handler threads it through to `InsertInput.capture_source` → the new column, alongside the
existing `evidence`/`source_hash` propagation already in that function.

---

## Checklist #5 — Purge-flow validation (disable → purge, end to end)

**Code delivered**, `tests/storage/auto-capture-purge.test.ts` (7 tests, all green):

- Erase path (`erase_memory`/`DELETE /memory/:id`, backed by
  `MemoryEventRepo.erase()`): scoped erasure hits **only** the atoms matching the
  provenance predicate, leaves manually-captured atoms completely untouched; tombstone
  (`erase_request` event) survives the row for each erased atom; `isErasedHash()` correctly
  blocks re-distillation resurrection for erased atoms and correctly does NOT block it for
  the untouched manual atom; a byte-scan confirms the row and its FTS entry are gone, not
  just hidden.
- Empty-scope purge (auto-capture was enabled but nothing was ever captured) is a safe no-op.
- Re-erasing an already-erased id throws `MemoryNotFoundError` rather than silently
  double-tombstoning — a real disable-flow handler must treat that as "already done" per-id,
  not fail the whole batch on one already-processed id (a batch loop needs a try/catch per
  id, not one try/catch around the whole loop).
- Invalidate path (`invalidate_memory`, the softer alternative the tool description itself
  recommends): memory kept, `valid_to` set, text still physically present.
- "Decline the purge entirely" (toggle off, keep everything) requires **no** lifecycle call
  at all — the auto-captured memories simply remain valid and queryable, matching ADR-012's
  "offered, not forced."

Since the real `capture_source` column (checklist #4) doesn't exist yet, the scoping query in
these tests stands in with a marker value written into the otherwise-unused `evidence` field
of synthetic test fixtures (documented in the test file's header) — swapping the WHERE
predicate for the real column, once it lands, is the only change a real disable-flow handler
needs; `erase()`/`invalidate()` themselves require zero auto-capture-specific code, which is
the point being validated here.

### Finding: invalidate() has no reversal primitive

Unlike `archive()`/`restore()` and `supersede()`/`unsupersede()`, `invalidate()`
(`src/storage/memory-events.ts:162-184`) has **no** corresponding "un-invalidate." Calling
`restore()` on an invalidated (not archived) memory throws `MemoryConflictError('... is not
archived')` — confirmed by test, not assumed (`restore()`'s precondition is specifically
`archived === 1`, `memory-events.ts:317`). A disable-flow UX that wants "soft purge, changed
my mind, bring it back" would need either (a) a new reversal primitive, or (b) to call
`archive()` instead of `invalidate()` up front and trade away `invalidate()`'s distinct
semantics (and its `memory_corrected` usefulness signal, which `archive()` deliberately does
NOT emit — see `archive()`'s doc comment). **Flagged as a build-slice gap, not fixed here** —
in scope for FEAT-455's implementation, not this spike.

---

## Checklist #6 — Doctor WARN row: spec (not implemented)

**Dependency:** this check needs both the config field (checklist #7) and the
`capture_source` column (checklist #4) to exist before it can report anything real — neither
has landed. Implementing a doctor check now would mean either (a) also landing those two
prerequisites in this spike (scope creep well past "spike," touching `config.ts`'s
`defaultConfig()`/loader and a schema migration), or (b) a stub check that can't actually
count anything, which would misrepresent the feature as further along than it is. Spec only.

### Proposed check (mirrors `checkServicePointer`'s pattern, `src/doctor/checks.ts:798-843`)

```ts
function checkAutoCapture(dataDir: string, autoCaptureEnabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'Auto-capture',
    async run(): Promise<CheckResult> {
      if (!autoCaptureEnabled) {
        return { ok: true, message: 'auto-capture: off (default)' };
      }
      const count = countAutoCapturedMemories(dataDir, encryptionEnabled); // COUNT(*) WHERE capture_source = 'auto_capture' AND valid_to IS NULL
      return {
        ok: true,
        message: `auto-capture is ON — ${count} auto-captured ${count === 1 ? 'memory' : 'memories'} currently stored`,
      };
    },
  };
}
```

**Deliberate deviation from the literal "mirror the dev-pinned WARN row" instruction:**
`checkServicePointer`'s dev-pinned row returns `ok: false` because dev-pinning is *always* an
unintended, fixable misconfiguration (FEAT-438's stale-dist footgun) — `ok: false` earns its
prominence. Auto-capture being ON is a **deliberate, disclosed, opt-in** user choice (ADR-012
decision 4's whole point); reporting it as `ok: false` would read as "something is wrong" to
a user who turned it on intentionally, which is the wrong signal. This spec recommends
`ok: true` with a message that still surfaces the state and count prominently in every
`doctor` run (visibility, per `checkDurabilityGateMode`'s existing informational-row
precedent, `checks.ts:936-946`, which is the closer analog for "opt-in mode, not a
misconfiguration") rather than following the dev-pinned check's error-signaling pattern
verbatim. Flagging this explicitly as a judgment call for the build slice to confirm with
product/UX, not a silent substitution.

---

## Checklist #7 — Config/wizard field spec

### `config.yaml` schema addition

```ts
/** Automatic memory capture (FEAT-455, ADR-012). Default OFF — enabling requires an
 *  explicit opt-in disclosed by the init wizard (never flipped on by an upgrade or a
 *  default-config write). v1 = hook-tap only (ADR-012 decision 1); MCP-tap/LLM-proxy
 *  are out of scope and have no config surface here. */
capture: {
  autoCapture: {
    enabled: boolean; // default false
    relevanceGate: {
      minChars: number;    // default 8   — see checklist #2
      maxBytes: number;    // default 65536 (64KB) — see checklist #2
      dedupWindow: number; // default 20  — see checklist #2
    };
  };
};
```

`defaultConfig()` (`src/config/config.ts:299+`) sets `capture.autoCapture.enabled: false` —
byte-identical to pre-FEAT-455 behavior when unset, matching every other opt-in flag in this
file (`distill.durabilityGate: 'off'`, `consolidation.autoAcceptThreshold: null`, etc.).

### `init` wizard prompt

Uses the existing `promptConfirm(message, defaultValue)` helper (`src/cli/init.ts:141-142`,
wraps `@inquirer/prompts`' `confirm`), same pattern as `confirmOllamaDownload`
(`init.ts:388+`) and the missing-binary prompt (`init.ts:453`) — both already default to
`false`/no for anything consequential. Proposed copy, asked only in interactive/TTY mode
(never defaulted-yes in a non-interactive `init --yes` run):

> "Astramem can automatically capture more of your session traffic (not just at session
> end) to form memories with less manual effort. This observes your session transcripts more
> frequently than today's default capture. Turn on auto-capture? [y/N]"

`promptConfirm(message, false)` — default **No**, matching decision 4's "never enabled
implicitly." A non-interactive `init` (CI, scripted install) never sees this prompt and gets
the `false` default, same as every other interactive-only wizard question in this file.

---

## Checklist #8 — Non-mutation write-up

**Claim (ADR-012 decision 5):** hook-tap is structurally incapable of mutating in-flight
traffic — a property of the mechanism, not a promise layered on top.

**Evidence, by file citation, not assertion:**

- `src/capture/claude.ts:119-125` (`readAndParseClaudeTranscript`) performs exactly one
  filesystem operation against the transcript path: `readFileSync(filePath, 'utf8')`. No
  `writeFileSync`, `truncateSync`, `renameSync`, or any mutating `fs` call anywhere in this
  module touches the *source* transcript path — the only write in the entire capture call
  chain is `writeToSpool` (`src/ingest/spool.ts:31-45`), which writes to a completely
  different path (`ingest-spool/<key>.json`, tmp-file + atomic rename) that has no relation
  to the transcript file's own path.
- `src/cli/capture.ts:63-114` (`runCaptureClaudeOnce`, the hook's actual entry point): reads
  the transcript via the above, builds an envelope in memory, writes the envelope to the
  spool. It never reopens, seeks into, or otherwise touches the transcript file a second
  time.
- The hook fires **after** Claude Code has already finished writing the line(s) it reads
  (`SubagentStop`/`session_end` today; per checklist #1, a denser-sampling trigger reads the
  same already-written file, just more often) — there is no code path in this connector that
  could intercept, buffer, or alter a request/response before Claude Code itself persists it.

**Additional evidence — narrower disclosure surface than a live tap could have "by
accident":** `tests/capture/claude-tool-arg-exclusion.test.ts` (checklist #3) proves
`parseClaudeTranscript`'s `extractText()` (`claude.ts:64-79`) filters to `type: 'text'`
content blocks only — a `tool_use`/`tool_result` block's `input`/`content` (file contents, DB
rows, credentials passed to a tool — exactly the ADR-012 decision-1 Tier-2 concern) never
reaches the parsed turns, confirmed for three shapes (secret in `tool_use.input` alone,
secret in a nested `tool_result.content` array, and a mixed turn with real text alongside a
secret-bearing `tool_use`). This is not a filter that could silently regress into leaking
tool args — there is no code path that walks into a `tool_use`/`tool_result` block's payload
at all, so a tool-arg secret is absent from the envelope by construction, before redaction
(checklist #3) is ever reached.

**Conclusion:** the "reads a file after the fact, never intercepts a live request" property
holds for the *current* codebase by inspection, not by test (there is nothing to "test" about
the absence of a write call other than reading the code — which is what this section is). Any
future Tier 2/3 mechanism (ADR-012 decisions 1's MCP-tap/LLM-proxy) starts from zero on this
property, exactly as the ADR already states, and would need its own equivalent evidence.

---

## Checklist #9 — Security/privacy sign-off (closing ADR-012 `proposed` → `accepted`)

**Not something this spike can complete itself** — per ADR-012's own framing, this is a
human/reviewer sign-off gate, not a code or spec deliverable. This document's findings
(checklist #1-8) are the INPUT to that sign-off, not a substitute for it. Recorded here as
**PENDING** — the ADR's status line remains `proposed` until a reviewer with security/privacy
sign-off authority explicitly accepts it, informed by this document.

---

## PASS/FAIL summary

| # | Checklist item | Result | Artifact |
|---|---|---|---|
| 1 | Hook-tap trigger mechanism confirmed, no new observation surface | **PASS** | this doc, §1 |
| 2 | Relevance-gate taxonomy spec, zero overlap with durability-gate | **PASS** (spec) | this doc, §2 |
| 3 | Secrets-pattern tests against auto-capture shapes | **PASS with 3 documented gaps** | `tests/security/redact-autocapture.test.ts`, `tests/capture/claude-tool-arg-exclusion.test.ts` |
| 4 | Provenance tag spec, purge/count-scoping-sufficient | **PASS** (spec) | this doc, §4 |
| 5 | Disable → purge flow validated end to end | **PASS with 1 documented gap** (no invalidate() reversal) | `tests/storage/auto-capture-purge.test.ts` |
| 6 | Doctor WARN row | **PASS** (spec only — blocked on #4/#7 landing first) | this doc, §6 |
| 7 | Config/wizard opt-in fields | **PASS** (spec) | this doc, §7 |
| 8 | Non-mutation structural argument | **PASS** | this doc, §8, backed by test evidence in §3 |
| 9 | Security/privacy sign-off | **PENDING — not a spike deliverable** | human gate |

All new code (`tests/security/redact-autocapture.test.ts`,
`tests/capture/claude-tool-arg-exclusion.test.ts`,
`tests/storage/auto-capture-purge.test.ts`) is green: `bun run build` clean, `bun run test`
2134 passed / 6 skipped / 0 failed among files touched by this spike (one unrelated,
pre-existing flaky timeout in `tests/scripts/post-merge-rebuild.test.ts` was confirmed to
pass in isolation — not caused by this change).

## GO/NO-GO recommendation

**GO on opening the FEAT-455 build slice(s), conditioned on:**

1. Checklist #9 (human security/privacy sign-off) closing ADR-012 to `accepted` — the actual
   gate this spike exists to feed, not something code can satisfy.
2. The build slice(s) implementing checklist #4 (provenance column) and #7 (config field)
   BEFORE #6 (doctor row), since #6 is spec-blocked on both landing first (§6 above).
3. The three redaction gaps in checklist #3 and the one lifecycle gap in checklist #5 are
   carried forward as tracked follow-ups (not silently dropped) — none are severe enough to
   block the build (all are narrow, and two of the three redaction gaps are pre-existing
   stage-0 properties auto-capture merely makes more likely to be exercised, not new holes it
   creates), but a reviewer should see them named explicitly rather than discover them later.
4. The open item under checklist #1 (confirm which trigger granularity the Claude Code hook
   surface actually supports) gets one concrete check at build time before committing to a
   specific per-turn-vs-interval implementation.

**No new blockers were discovered** beyond what ADR-012 already anticipated (its own
"Confidence: Low on relevance-gate tuning" caveat) — the relevance-gate taxonomy in §2 is,
per the ADR's own honesty, untested against real capture volume and should be treated as a
first cut subject to tuning once real auto-capture traffic exists, not a validated design.
