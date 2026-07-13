# ADR-015: The Loud Failure Invariant

> **Citation policy — read this before chasing any line number in this document.**
>
> Every `file:line` here was resolved against the investigation baseline **`d645e80`**. `main` has
> moved since, and parts of the tree are under active edit. **Anchor on the SYMBOL NAME, not the
> line number.** The line is a hint; the symbol is the claim.
>
> This is not a hypothetical. **During the writing of this ADR, `src/config/config.ts` grew from
> 785 to 896 lines.** Three independent agents — each verifying honestly against source — reported
> the contradiction-detection default at line **555**, then **715**, then **623**. Each was correct
> at the moment they looked. The file moved underneath all of them.
>
> It went one step further, and this is the part worth keeping: **the lead agent then "corrected" a
> writer's accurate `623` back to a stale `555`** — citing a snapshot of a file that no longer
> existed. The writer **refused the instruction, re-read the source, and pushed back.** It was
> right. A stale correction is indistinguishable from a live one to everyone downstream, and it
> arrives with *more* authority than the thing it overrides.
>
> That is the same lesson as this ADR, applied to prose: **a citation that silently rots is
> indistinguishable from a citation that was always wrong.** The reader cannot tell, and will trust
> it either way — precisely the class of failure this document exists to outlaw. The document
> caught its own author violating its own thesis in its own footnotes.
>
> **Cite the symbol. Line numbers are a convenience, not evidence.**

**Status:** Accepted
**Date:** 2026-07-13 · **Confidence:** High (grounded in code-verified findings from a 6-agent
adversarial teardown, cross-checked against source directly, not trusted from citation alone)
**Context:** A 6-agent adversarial teardown (`docs/research/20260713-teardown-and-reinvent.md`)
set out to test whether astramem's core architecture — the atom primitive, the bitemporal schema
— was structurally wrong. It wasn't: zero of five redesign gates cleared (§2 of that report), and
four of the investigation's five original charges were refuted or downgraded on direct evidence.
One charge survived and hardened into the most important finding in the report (§5, Charge 2):
**"success and silent failure are the same observable state."** This ADR names that finding as a
binding invariant so it stops being institutional folklore and starts being something a reviewer
can cite. It supersedes nothing; it generalizes a precedent this repo already set twice by hand
(migrations 029 and 030) without ever writing the rule down.

## Decision

### 1. The invariant

> **Success and silent failure must never be the same observable state.**

Stated as a requirement on any code path that can produce a zero, an empty result, or a no-op:

> **That path MUST be able to distinguish a REAL zero from a BROKEN zero — and that distinction
> MUST be readable without a human present.**

"Readable without a human present" is load-bearing. A signal that only becomes visible when
someone thinks to run a command is not a signal for the purposes of this invariant — it's a
manual procedure with a green paint job. See §2's third instance below for the case that proves
the distinction matters.

### 2. The evidence — the same missing signal, five times

**The headline instance.** A distill job whose extraction model returns a well-formed
`{"atoms":[]}` completes successfully. The extraction prompt itself instructs this —
`"Empty is valid: if the chunk truly contains nothing durable... output \"atoms\": []"`
(`src/distill/prompts/extract.ts:668-670`) — so this is also correct behavior in the legitimate
case. `extractChunk` returns the zero-atom result without error (the analogous short-circuit at
`src/distill/stages/05-extract.ts:102-104` returns `atoms: []` for empty input the same way), the
Zod gate validates the shape, and the worker calls `repo.complete(job.id)`
(`src/pipeline/worker.ts:179`) — a normal, green, zero-yield job. The `poisonDistillSessions`
counter (`src/server/queries/memory-health.ts:97,191`) cannot catch this: it increments only on
job *failure*, and this job never fails. No table in the schema persists an atoms-per-transcript
or zero-yield rate. **A wrong model pull, a bad quantization, a silently truncated context
window, or a config typo that corrupts the prompt is 100% indistinguishable from "this transcript
genuinely had nothing worth remembering."** A totally broken extraction pipeline looks exactly
like a quiet week.

**The check that computes the signal but cannot report it.** `checkMemoryHealth`
(`src/doctor/checks.ts:657-694`) computes `poisonDistillSessions`, interpolates it into a message
string, and has exactly one return path: every branch — including the catch block at line 690 —
returns `{ ok: true }`. A 100% poison rate still reports "memory health: OK." The computation
exists; the ability to fail does not.

**The alarm that never rings because nothing pulls the cord.** `src/cli/serve.ts` has no import
of `doctor/runner.ts` (verified: zero matches). All three real callers of `runChecks` are manual
— `cli/doctor.ts:68`, `cli/init.ts:848`, `cli/providers.ts:74`. Every canary this repo has ever
built to detect "built, wired, never invoked" is itself only invoked when a human remembers to
run it. This is the invariant's own failure mode, recursively applied to the tooling meant to
catch it.

**The probe that tests a different shape than production.** `llmChatProbe`
(`src/doctor/probes/llm-chat-probe.ts:19-22`) calls `provider.chat([...], { maxTokens: 1,
temperature: 0 })` — it never passes `json: true`, so it never exercises `format: json`, the
exact request shape that caused the qwen3 thinking-mode empty-body incident
(`src/distill/stages/05-extract.ts` extraction call sets `json: true`; the probe does not). A
green doctor row is not evidence that extraction will work — it's evidence that a *simplified*
request works.

**The judge that conflates infrastructure failure with a real answer.** `judgeContradiction`
(`src/consolidate/contradiction-judge.ts`) defines `FALLBACK_VERDICT = { verdict: 'unrelated',
confidence: 0 }` at line 66 and returns it from both the unparsable-response branch and the
caught-exception branch (lines 92-95, 97-103). A network hiccup, a timeout, and a genuine
semantic judgment that two atoms are unrelated all produce the identical verdict object. The
caller (`consolidate.ts:551`) then silently skips the pair — costing a legitimate merge with no
counter distinguishing "the judge looked and said no" from "the judge never got to look."

**The generalized form: telemetry tables nobody reads.** Four tables ship with zero writers in
this repo's history: `messages`, `artifacts`, `provider_state` (all day-one, `001-init.sql`, never
written by anything in the repo's history) and `evidence_guard_drops` (migration 030, in-flight,
legitimate). `provider_state` is the sharpest case — it has no writer, but the dashboard reads it
directly (`src/server/queries/dashboard.ts:243-247`, `queryProviders`): a live query pointed at a
table nothing has ever populated. Not dead code — an always-empty widget shipping to users. The
lesson generalizes past distill: **a telemetry table with no writer is silent-by-construction; a
telemetry table with no reader is silent-by-omission.** Both violate this invariant.

**The near miss this ADR does not count as an instance.** `contradiction-judge`'s `FALLBACK_VERDICT`
row above is real, but a related early finding — "contradiction detection ships off by default"
— was independently promoted to CONFIRMED, written into a remediation plan, and then caught and
retracted before a build started (`docs/specs/20260713-teardown-remediation-plan.md` §2.5). The
citation — `DEFAULT_CONTRADICTION_DETECTION` in `config.ts` — was a real symbol; it just wasn't
the code that runs. That constant is a **governance fallback**, applied only when an override
fails validation. The shipped default is `defaultConfig()`, which sets
`contradictionDetection.mode: 'enabled'`. That failure —
`file:line` proving code *exists* without proving it's on the *live* path — is exactly the
discipline gap this ADR's rule 3 (below) exists to close in the other direction: a probe or check
must exercise the production shape, not a shape that merely compiles.

### 3. The binding rules

1. **A guard that drops something increments a counter.** The `*_guard_drops` pattern
   (`relation_guard_drops`, migration 029; `evidence_guard_drops`, migration 030) is the reference
   implementation — reason/count/session_id/created_at, written at the guard site, read by a
   doctor check. **Generalize this pattern; do not reinvent it per subsystem.** Migration 029's
   own header states its purpose precisely: distinguishing "the model never emits X" (0 rows, 0
   drops) from "the model emits X but the guard drops every one" (0 rows, drops > 0) — two
   observably-identical-from-the-output-table failure modes that only the drop counter can tell
   apart.
2. **A health check that computes a signal must be able to return `ok: false` on it.** A check
   that cannot fail is not a check — it's a status message with a fixed value. `checkMemoryHealth`
   is the counterexample to fix, not the pattern to follow.
3. **A probe must exercise the production request shape, not a simplified one.** If the code path
   being verified passes `json: true`, times out at N seconds, or retries M times, the probe does
   too — a probe that only shares a function name with production code proves nothing about
   production code.
4. **An infrastructure failure must never be collapsed into a valid domain value.** "Unrelated,"
   "empty," and "none" are semantic answers a model can genuinely give. A timeout, a parse
   failure, and a thrown exception are not semantic answers — they are the absence of one, and
   must be a distinguishable state, not a default value that happens to look like one.
5. **Anything that ships a telemetry table ships its reader in the same PR.** No fifth orphan
   table. `evidence_guard_drops` (migration 030) is the one currently in-flight instance of this
   rule not yet fully closed — it is a legitimate build-in-progress, not a violation, but it is
   the bar every future instance of this pattern must clear before merge.

### 4. Consequences — named honestly

- **More counters, more tables, more doctor rows — and alarm fatigue is a real risk.**
  Thresholds must be tuned, not assumed. A single zero-yield job is normal (some transcripts
  genuinely have nothing durable in them); a rolling *rate* crossing a floor is the signal, not
  any individual zero. Reuse the gating this repo already has for exactly this shape —
  `MEANINGFUL_USAGE_THRESHOLD` (`src/doctor/checks.ts:483`, currently `20`) — rather than
  inventing a new floor per check. Evaluate a rate only once there is enough volume for a zero to
  mean something.
- **A cost trap, named explicitly: `llmChatProbe` makes a real LLM call.** "Just run doctor on a
  tight interval" is a self-DoS, and on a metered endpoint it is the FEAT-482 incident class —
  contradiction detection shipping `enabled` without a call-count/wall-clock guard fired roughly
  245 sequential LLM calls against a metered endpoint and wedged the sole worker lane for over ten
  minutes. **Cheap DB checks get a frequent cadence. LLM-probe checks piggyback on the existing
  24-hour cleanup tick** — no new tight interval for anything that makes a network call to an
  LLM provider.
- **This invariant does not mean fail-fast.** Degraded-start is a deliberate, separate design
  choice for this daemon (port binds immediately, embed probe retries in background, `/health`
  reports `starting|ok|degraded`). Nothing here argues for reversing that. **The requirement is
  visibility, not death.** A red doctor row must be readable at `/health` without shelling in; it
  must never itself decide to kill the process.

## Options considered

1. **Write this ADR now, generalize the guard-drop pattern, require reader-with-writer on every
   telemetry table (chosen).** Turns a war story into a rule a reviewer can cite by name instead
   of re-deriving from memory on every PR.
2. **Leave it as tribal knowledge and keep fixing instances ad hoc.** Rejected — this is the
   status quo, and it is precisely how the same fix got built twice (migrations 029 and 030)
   without either author generalizing it for the next subsystem. The disease recurs because
   nothing forces the next author to notice the shape is familiar.
3. **Fail-closed whenever a zero-yield or empty result appears, instead of just making it
   visible.** Rejected — conflates two different problems. Degraded operation under a broken
   model or an empty transcript is often the *correct* behavior in the moment; the invariant this
   ADR states is about whether that state is *observable*, not about whether the daemon should
   refuse to continue. Fail-closed-on-zero would also directly contradict the daemon's own
   deliberate degraded-start posture and would turn "the model briefly quantized badly" into an
   outage instead of an alarm.
4. **A single centralized "anomaly service" that all subsystems report into, built now.**
   Rejected as this ADR's scope — the reference pattern (`*_guard_drops` + a doctor check) already
   exists, is tested, and is cheap to replicate per subsystem. Building a shared service before a
   second or third replication of the pattern exists to generalize *from* would be solving an
   integration problem that doesn't exist yet at the cost of delaying the visibility fixes that do
   matter now (see Track 1, referenced below).

## Consequences & migration

- **No code changes from this ADR itself.** This document is the naming and generalization of a
  rule; the enacting build work is tracked separately as Track 1 of
  `docs/specs/20260713-teardown-remediation-plan.md` (zero-yield telemetry, `checkMemoryHealth`'s
  `ok: false` branch, doctor's automatic scheduling from `serve.ts`, the `llmChatProbe` shape fix,
  the contradiction-judge fallback counter, and the three-dead-table cleanup).
- **Any future PR that adds a table meant to detect a failure mode must add its doctor reader in
  the same PR** (rule 5). A reviewer citing this ADR is sufficient grounds to block a table-only
  PR pending its reader.
- **Any future PR that adds a health check must show the `ok: false` branch is reachable** — by
  test, not by inspection. A check whose only observed return value in its test suite is
  `ok: true` should be treated as unverified against this ADR, not merely unlucky in its fixtures.
- **Any future PR that adds an LLM-backed probe must state, in the PR description, what
  production request shape it claims to verify** and confirm the probe call sites match it
  (`json`, `format`, timeout, retry count) — rule 3, made concrete enough to review against.
- Cross-reference: this ADR's evidence-gate posture (don't ship a signal without proof it can
  fail) mirrors ADR-014's eval-evidence rule (don't ship a nonzero fusion weight without a passing
  harness run) — both are instances of "a mechanism that looks correct is not evidence it has ever
  been exercised in its failing state."

## References

- `docs/research/20260713-teardown-and-reinvent.md` — the teardown; §4 finding #5b (headline
  instance), #2 (`checkMemoryHealth`), #3 (doctor never runs), #7 (`llmChatProbe` shape), #11
  (judge fallback conflation), #10 (four zero-writer tables); §5 Charge 2 (the sustained charge
  this ADR institutionalizes); §9 item 13 (the retracted false finding and its lesson: `file:line`
  proves code exists, not that it runs).
- `docs/specs/20260713-teardown-remediation-plan.md` — Track 1 ("Safety + the Missing Invariant"),
  the build plan enacting this ADR's rules; its own framing states the same invariant this ADR
  formalizes.
- `migrations/029-relation-guard-drops.sql`, `migrations/030-evidence-guard-drops.sql` — the
  ad-hoc precedent this ADR generalizes; both mirror `redaction_log` (`005-security.sql`) and each
  other field-for-field, evidence the pattern was already recognized as reusable before it was
  named.
- `src/doctor/checks.ts:483` (`MEANINGFUL_USAGE_THRESHOLD`) — the existing false-positive-rate
  gating this ADR's rate-not-single-zero guidance reuses rather than reinventing.
- ADR-014 (Local Fusion-Model Governance) — sibling instance of "a mechanism existing is not the
  same as a mechanism being evidenced," applied to fusion weights rather than failure visibility.
