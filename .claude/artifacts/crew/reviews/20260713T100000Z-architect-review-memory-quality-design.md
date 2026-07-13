---
type: review
created: 2026-07-13T10:00:00Z
author: architect-reviewer (independent, session e08b8f83 fan-out)
subject: docs/superpowers/specs/2026-07-13-memory-quality-design.md
verdict: approve-with-changes
---

# Architecture review — memory-quality design (BYO frontier extraction + rich prompts + entity relations)

## Verdict: **approve-with-changes**

The core bet (D1: run extraction on whatever LLM the user already configured,
rather than building a new tail-call path or over-investing in local-7B
quality) is sound and cheap — it reuses provider plumbing that already exists
and is wizard-selectable. D6 correctly keeps the shipped default local-first.
But the design has one real process gap (coordination ownership on
`extract.ts` is asserted, not mechanized — three efforts are already circling
this file) and one real technical gap (the proof phase and the codex-subscription
default both under-specify failure/variance handling in ways this exact
codebase has already been bitten by). Neither requires redesign; both should be
closed before a builder opens `extract.ts`.

---

## 1. Decision soundness

**D1 (BYO frontier, not local-only, not tail-call) — sound, no changes needed.**
All four providers (`ollama`, `azure-openai`, `openai-compatible`,
`codex-subscription`) are already implemented and wizard-selectable
(`src/cli/init.ts:61`, `:213-223`); this design adds zero new provider
abstraction, just a config axis on top of infrastructure that exists and is
tested. The killed "tail-call distillation" alternative is correctly abandoned
— nothing in the repo suggests it was ever load-bearing.

**D4 (option (a): rich lesson/decision, atomic fact/command) — right call, but
§3.2 doesn't say how the prompt enforces it. [MEDIUM]**
The current extraction prompt (`src/distill/prompts/extract.ts:71-82` and
`:189-200`) picks a *type* by content shape (command → todo → event → decision
→ lesson → fact → note), independent of length. D4 needs the type-conditioned
length target to be an explicit instruction in the merged prompt text ("if this
is a `decision`/`lesson`, prefer the 300-800-char claim+rationale+consequence
shape; if it's a `fact`/`command`, stay atomic and single-valued because it
must be cleanly supersedable") — not just a design-doc bullet that the builder
has to reverse-engineer from D4's prose. §3.2's "richness rules" bullet talks
about self-containedness/pronouns/dates but never states the type-conditioning
rule itself. Recommend adding this as a literal instruction line in the merged
prompt spec so the few-shot examples for `fact`/`command` types visibly stay
short while `lesson`/`decision` examples visibly go long — "the examples are
the spec" (§3.2's own words) cuts both ways: if only rich examples are shown,
the model will generalize richness to every type, including `fact`.

**D5 (proxy injection parked) — correct, no changes.** FEAT-458 capture is
shipped and orthogonal to extraction-prompt quality; injecting per-request
context is a distinct, larger-risk surface (ADR-013's own STRIDE table) that
doesn't need to gate this work. Confirmed via
`.claude/artifacts/crew/handoffs/20260712T220000Z-feat458-proxy-parallel-session-plan.md`
and DEC-014 — the proxy bake gates *production enablement*, not this design.

## 2. Coordination risk — the real blocking finding

**[HIGH] Three efforts already target `src/distill/prompts/extract.ts`, and
none of the three governing documents names a single owning FEAT id or a
recorded decision — only prose intent.**

- Master-plan W5 (`.claude/artifacts/crew/handoffs/20260713T090000Z-memory-quality-master-plan.md`
  §3 W5, §4) — richer shape, same file, "under adversarial review."
- Conversational-extraction-profile plan
  (`.claude/artifacts/loop/plans/20260713-conversational-extraction-profile-plan.md`
  S2) — liberal extraction axis, same file.
- FEAT-481 (`.claude/artifacts/loop/backlog/pending/FEAT-481.md`) — relation
  triples emitted "by the same extraction call," same file, currently
  unscored/pending.
- **FEAT-479** (`.claude/artifacts/loop/backlog/pending/FEAT-479.md`) already
  exists, is unscored/pending, and its own COLLISIONS section (item 2) already
  names the conversational-profile plan as a same-file collision and says
  "sequence or merge them — do not land independently." This design doc's
  §3.2 "merged extraction FEAT" is describing FEAT-479's scope, expanded — but
  never says so. As written, a triage pass could legitimately open a *fifth*
  ticket for "the merged extraction FEAT," which would recreate the exact
  collision FEAT-479 itself warns against.

§3.2's closing line ("Coordination: ... merge, do not land twice. Same file,
one owner.") is a stated intent with no mechanism: no FEAT id is named as
canonical, no decision-log entry exists, no `crew:claim-files` record exists.
Given this repo's own constitution ("two agents need the same file → stop and
re-scope") and that this is now three-going-on-four concurrent claims on one
file, prose sequencing in a plan doc is not enough.

**Recommendation before any builder is dispatched:**
1. Record a decision (next `DEC-0xx`) naming exactly one canonical FEAT id —
   reuse **FEAT-479** (it already exists, is already scoped around this exact
   problem, and already anticipated the collision) rather than opening a new
   one. Expand its scope/ACs to absorb the profile axis (D3) and note FEAT-481
   as a dependent, not a co-owner, of the prompt file.
2. Name one owning session/builder. Everyone else's slices reference FEAT-479
   as `depends_on` and land after it, not concurrently with it.
3. Where possible, keep FEAT-481's *triple-emission* logic and
   `entity_relations` migration (next free number is `027` — `026-proxy-usage.sql`
   is the latest on main, so no numeric collision today, but confirm at build
   time given the pace of concurrent FEATs) in files it alone owns, touching
   `extract.ts` only for the additive triples field in the shared schema, not
   the prose/shape instructions.

## 3. codex-subscription as operator default (D2)

The provider code (`src/providers/llm/codex-subscription.ts`) is unusually
well-hardened for an "EXPERIMENTAL" surface: live-verified SSE parsing,
atomic auth-file rewrite, 401→refresh→retry-once, and a
`TransientError`/`DeterministicError` split that routes correctly into the
existing distill retry-then-poison convention. The wizard already gates the
option behind a detected `codex login` (`init.ts:203-223`) and the class
constructor logs a loud warning every time. D2 (operator-only default, D6
keeps Ollama as ship-default) is an acceptable scope for the operator's own
box.

Two gaps worth closing:

**[HIGH] The SSE parser can return a silently-empty completion with no thrown
error — the same failure shape that already poisoned distill once with
qwen3:8b.** `parseSseResponse` (codex-subscription.ts:119-160) returns
`{ text: '', ... }` with no error if the expected event shapes aren't found
(e.g. OpenAI changes the SSE event schema, or a proxy/CDN mangles the body).
`chat()` returns this as a *successful* `ChatResult` with `text: ''`. This is
structurally the same shape as the recorded `qwen3:8b` extract-empty bug (this
repo's own memory: qwen3:8b returns empty on extract, poisoning distill,
fixed by pinning a different model — the failure mode was "success with empty
output," not a thrown error). Recommend a gate: when `opts.json === true` and
the parsed text is empty, throw a `TransientError` (parse/shape failure,
retry-then-poison-if-persistent) rather than returning an empty success —
this is a cheap, local fix and directly guards the operator's default distill
path against silent endpoint drift, which the provider's own doc comments
already flag as a real risk ("can break without notice if OpenAI changes the
endpoint").

**[MEDIUM] The daily LLM budget cap is a silent no-op under codex-subscription.**
The wizard collects a "Daily LLM budget cap (USD)" (`init.ts:236`), but
`codex-subscription.ts:477-479` always reports `usage.usd: 0` ("subscription
quota has no per-token USD price"). That's the right number to report (it's
true), but it means the operator-facing budget-cap feature silently does
nothing for the provider this design makes the operator's own default — there
is no daemon-side signal of approaching ChatGPT-quota exhaustion until calls
start 429ing mid-distill. §5's failure-mode bullet ("retry then poison; spool
preserves content") covers the crash path but not the "operator has zero
visibility into remaining quota" gap. Recommend either: doctor WARN copy
stating budget caps don't apply under this provider (cheap, honest), or
tracking a raw call/429 count as a proxy signal — not required for v1, but
should be an explicit doctor line rather than an unstated gap.

## 4. Proof phase (§3.4)

Inadequate as specified, for reasons the parallel master-plan's own W7 already
established in this exact codebase and which §3.4 cites but doesn't actually
apply:

- **Sample size**: "~10 real transcripts" is the same order of magnitude as
  the ground-truth set W7 says must grow to 40-60 because 10 was too biased
  ("current set is biased toward tonight's proxy work"). §3.4 doesn't say the
  10 transcripts are disjoint from that bias concern.
- **Variance**: master-plan W7 documents a sibling eval in this repo
  (FEAT-450) that was noise-dominated (±14 F1 on *identical* configs). §3.4
  runs each of the 4 configs exactly once. A single point estimate per config,
  after that documented lesson, risks re-making the same mistake the master
  plan is actively correcting elsewhere in the same design effort.
- **Blinding**: "operator eyeball vs Claude-authored MEMORY.md" is unblinded —
  the operator knows which config produced which output going in, which is a
  confirmation-bias risk on exactly the axis (subjective richness/quality)
  the eyeball judge is supposed to be independently checking.
- **Cost is invisible as a decision input**: D2 picks between `gpt-5.5` and
  `gpt-5.4-mini` for the A/B, but §3.4's proof phase only measures quality
  (MRR, eyeball). The actual decision being made — is the quality delta worth
  the $ and latency delta over qwen — has no cost/latency column in the
  proof-phase output, even though `codex-subscription`'s own doc comments
  already establish `gpt-5.4-mini` was chosen elsewhere as "the cheap-tier
  pick," implying cost already matters to this team.

**Recommendation**: expand to ≥2 runs per config (cheap — it's the eval loop,
not a fresh distill of the whole store), report a range not a point estimate
per W7's own new convention, blind the eyeball pass (hide config labels until
after judging), and add a cost/latency column per config to the proof-phase
report so the "which is the recommended default" decision is made on the same
evidence the design already uses elsewhere for provider tiering.

## 5. Open questions §7 — answered

**Q1 — should the wizard recommend BYO-cloud when a key/login is detected?**
No — don't flip the *default*. D6's brand promise (Ollama-first, honest
trade-off stated plainly) is worth keeping, and a silent default-flip based on
login detection would contradict "wizard/docs state the quality trade
plainly" (§3.1) by picking for the user instead of informing them. Do change
the *presentation*: when a Codex login is detected, move the BYO-cloud choice
higher in the tier picker and label it something like "recommended if you
have a ChatGPT/Codex login — noticeably richer memories" rather than a
flat, equal-weight menu entry (current `init.ts:218-223` treats it as one more
item in a list). Nudge via ordering/labeling, not by changing the selected
default.

**Q2 — fallback provider chain: v1 or later?** Later. The current
failure mode (retry-then-poison, spool preserves content, doctor probes
surface the break) already degrades without data loss — it delays extraction,
it doesn't lose it. A fallback chain adds real config-schema and
health-check-ordering complexity for a problem that's already non-catastrophic
and, per D2, only affects the operator's own opted-in box. Revisit only if
operational experience shows poisoning is actually happening at a rate that
matters.

**Q3 — FEAT-481 confidence field: float 0-1, or drop?** Keep the field in the
schema (additive, cheap, no regret either way) but don't let it drive
filtering or edge-supersession decisions in v1 retrieval — the design's own
words ("models are poorly calibrated") argue against treating it as a
precision signal today. Store it for future calibration work / debugging
visibility; the `entity_graph` MCP tool (§3.3) shouldn't sort or gate on it
until there's evidence it's meaningful.

**Q4 — does the conversational profile change redaction posture? Yes, and
this design doesn't resolve it. [MEDIUM]** `src/redact/index.ts` is explicitly
scoped to *secrets* (PEM blocks, vendor key patterns, high-entropy strings,
numeric secrets — SEC-3..6/SEC-9) — there is no detector class for personal-but-
not-secret content (health conditions, relationship details, named third
parties who never consented to being in a durable store). The conversational
profile's entire premise, borrowed directly from mem0's research
("pets, hobbies, childhood memories, funny anecdotes... often the MOST
valuable"), is optimizing *for* extracting exactly this class of content. That
is a materially different exposure than the engineering profile's worst case
(a leaked API key, which redaction already catches). This design should
explicitly decide — not silently inherit — whether conversational-profile
ingest gets a stricter default (e.g., a documented "sensitive personal content
is not redacted, only credentials are" disclosure line, matching the honesty
standard §3.1 already sets for the cloud-vs-local trade) rather than leaving
the profile axis to imply parity with the engineering profile's much narrower
threat model.

## 6. What's missing entirely

- **AC-0 traceability.** FEAT-479's own AC-0 (test whether long memories
  retrieve before designing around the "keep memories short" rule) was
  answered — favorably — by the master plan (§2: "Long memories retrieve at
  #1... up to ~700 chars tested") but this design doc never cites that result
  as the reason D3/D4 can skip the summary-embedding fallback design FEAT-479
  itself specified as the alternative branch. A reader of only this design
  doc can't tell AC-0 was ever run. Cite it explicitly.
- **CLAUDE.md's memory-shape rule.** Master-plan W4/AC-8 requires the "write
  memories SHORT" rule in `CLAUDE.md` be corrected (not silently rewritten —
  proposed as wording for operator sign-off). This design doc's scope (§3, §4)
  never mentions who does that or when, even though D3/D4 make the rule
  obsolete by definition. If this design supersedes W5, does it also inherit
  W4? State it.
- **Cross-repo wire impact of longer memories.** CLAUDE.md's own hard
  constraint is wire-compatibility with `astramem-plugin` and the SaaS
  backend. A 10x length increase in emitted memory text is schema-legal
  (`text.max(500)` in `AtomSchema` is unchanged by this design — worth noting
  the design's 300-800-char target already exceeds the existing 500-char
  schema cap on `atoms[].text`, which needs either a schema bump or a
  correction to the target range) but may not be UI-legal on the consumer
  side (plugin/SaaS preview truncation, notification copy) if those surfaces
  assumed today's ~68-char reality. Worth a one-line check before the proof
  phase, not a blocker to starting it.
- **Test/fixture drift.** No mention of updating any existing unit tests that
  assert today's terse few-shot output shape or exact prompt text — worth a
  scope line so the merged-extraction builder doesn't discover it mid-slice.

## Summary of severities

| Sev | Finding |
|---|---|
| HIGH | §2 — no mechanized single-owner claim on `extract.ts` across 3-4 concurrent efforts; record a DEC naming FEAT-479 as canonical before dispatch |
| HIGH | §3 — codex-subscription SSE parser can silently return empty-success text; same failure shape as the recorded qwen3:8b empty-extract bug; add a non-empty-response invariant |
| MEDIUM | §1 D4 — type-conditioned richness (rich lesson/decision, atomic fact/command) isn't stated as an explicit prompt instruction, only as design-doc prose |
| MEDIUM | §3 — daily budget cap is a silent no-op under codex-subscription; needs a doctor WARN or documented gap |
| MEDIUM | §5 Q4 — conversational profile's exposure to non-secret personal content has no redaction-posture decision |
| MEDIUM | §6 — 300-800-char target already exceeds `AtomSchema.text.max(500)`; needs a schema-cap correction or a smaller target |
| LOW | §4 — proof phase needs ≥2 runs/config, blind judging, and a cost/latency column, per the master plan's own W7 lesson from FEAT-450 |
| LOW | §6 — AC-0 resolution, CLAUDE.md W4 ownership, and cross-repo consumer truncation assumptions should be cited/scoped explicitly |
