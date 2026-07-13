# Adversarial Review — Teardown Remediation Plan

*2026-07-13 · Reviewer: crew:reviewer (adversarial mode) · Target: `docs/specs/20260713-teardown-remediation-plan.md` · Source: `docs/research/20260713-teardown-and-reinvent.md` (verdict H2, zero of five redesign gates cleared)*

**Verdict: NEEDS_FIX** — one defect (below, #1) is severe enough to block Track 2.5 as written; the rest are real but fixable without re-scoping the plan. The plan's overall shape (three tracks, salvage-not-reinvent, Track 3 as a hedged spike) is sound and should not be thrown out.

---

## Defect #1 (severe): Track 2.5 recommends something that already happened, already caused a real incident, and is already live — the plan doesn't know

**Confirmed by reading `src/config/config.ts` directly against current HEAD (`d645e80`, the exact commit both the research doc and the plan cite as baseline).**

The plan's 2.5 and the research doc's finding #9 both cite `config.ts:715-716` as evidence that `contradictionDetection.mode` ships `'off'` by default, and both frame flipping it to `'enabled'` as a forward-looking, hedged recommendation ("measure embedding geometry before flipping the default" — plan's open question #5).

`config.ts:715-716` is `DEFAULT_CONTRADICTION_DETECTION`, a **governance fallback constant** used only by `applyContradictionDetectionGovernance` when an override is missing or invalid. It is not the shipped default. The actual shipped default — `defaultConfig()` at `config.ts:478`, the function that returns what every fresh install actually gets — sets `contradictionDetection: { mode: 'enabled', ... }` at `config.ts:555-556`. This is not stale or WIP: it's on HEAD, and the comment block at `config.ts:532-569` documents *why*:

- The flag was flipped `'off' → 'enabled'` the same day as this investigation (FEAT-482).
- The flip shipped with no call-count/wall-clock guard on the judge. It fired **~245 sequential LLM calls against a metered endpoint (codex-subscription, billed against the operator's personal ChatGPT quota)** and wedged the daemon's sole worker lane for **10+ minutes**.
- A dollar-cap guard was tried first and reverted (commit `0b6b3f8`, second-most-recent commit on `main`) because every shipped provider hardcodes `usage.usd: 0` — a budget check that can never trip.
- The real fix — `maxPerRun` + `maxWallClockMs` — is already in place (`contradiction-judge.ts:1-21`, `config.ts:556,568`).
- The operator has separately set `mode: 'off'` in their own live `config.yaml` as an immediate stopgap (`config.ts:551-553`), independent of the shipped default.

Confirmed via `git log --all --grep="FEAT-482"`: `330f2e6`/`b25714a` "cap the contradiction judge's LLM spend and duration (FEAT-482)", `27eaa5d` "Daemon hardening: bound the judge, diagnose the failures (ingest, sync, consolidate) (#180)", `0b6b3f8` "drop the dollar budget cap on the judge... (#184)" — all real, all merged, all on `main` before this plan was written.

**What this means for the plan, concretely:**

1. Track 2.5's premise is false as written — the default is not "off," it's "enabled, with guards, after an incident." A builder picking up 2.5 verbatim would be confused about what there is left to do, or worse, would re-flip an already-flipped flag and could re-trigger config drift with the operator's local override.
2. The risk the plan asks to measure before flipping — "does auto-merge pick the wrong fact via embedding geometry" — is real but was *not* the risk that actually fired. The realized incident was an unbounded-cost/duration failure, a completely different failure class than the one the plan's open question #5 asks the architect to resolve. The plan is steering review attention at the wrong risk for this item.
3. This is a research-doc-inherited error, not a plan-only one — the research doc's own finding #9 makes the identical mistake, and since the research doc states its baseline is the exact same commit, the discrepancy isn't a timing race, it's a wrong-constant citation that the plan copied forward without independently checking `config.ts` at the point of turning finding → task.

**Fix required before a builder touches 2.5:** rewrite 2.5 to state the actual current state (`enabled`, with `maxPerRun`/`maxWallClockMs` guards, operator-overridden to `off` locally), verify whether the FEAT-482 guards are sufficient going forward, and separately evaluate the still-unmeasured auto-merge/embedding-geometry risk on its own merits — don't conflate "should this be on" (already decided, already shipped, already survived one incident) with "is the auto-merge threshold trustworthy" (still open).

---

## Defect #2 (moderate-high): sequencing logic is internally inconsistent, and even the narrower version overclaims the dependency

The Framing section states "Track 1 (safety + observability) ... gates the rest" — implying all five Track 1 items (1.1–1.5) block both Track 2 and Track 3. But Track 2's own header narrows this to "**Depends on:** Track 1.1" only. These two statements aren't the same claim. If a builder or reviewer takes the Framing section at face value, Track 2 — explicitly time-sensitive, with an unsafe claim already circulating externally — gets serialized behind 1.4 (a security-boundary change to the proxy hot path, flagged by the plan itself as needing its own review) and 1.5 (a destructive migration), neither of which has anything to do with trusting a LoCoMo rerun.

Even the narrower claim overclaims: what 2.2 (the full-sample rerun) actually needs is confidence that *this specific rerun* wasn't corrupted by silent zero-yield extraction — that's satisfiable with a one-off atoms-per-transcript check during the rerun (a log line or ad-hoc query), not the full productionized 1.1 (persistent rolling zero-yield rate table + doctor alarm wiring). The plan bundles the lightweight thing Track 2 actually needs with the heavyweight thing Track 1 wants to build, and lets the second borrow the first's urgency to justify itself.

**Recommendation:** split 1.1 into (a) a same-day, throwaway "verify this rerun's atoms-per-transcript distribution isn't suspiciously flat" check that unblocks 2.2 immediately, and (b) the persistent telemetry system described in the plan, which can land on its own schedule without gating the time-sensitive benchmark work. State plainly in the plan which of Track 1's five items Track 2 actually needs (arguably: none, if (a) above is done as a standalone half-day task) versus which are just good to land soon.

---

## Defect #3 (moderate): severity inversion between 1.1 and 1.2 is a real prioritization risk, not just a resolved-because-same-slice detail

The plan calls 1.1 "highest leverage in the entire report" and lists it first; 1.2 is the research doc's own "highest-severity bug" and is listed second. The asymmetry in what's actually at stake:

- 1.2 (PID-reuse kill) has a **documented, already-occurred production incident** in this exact repo (`CLAUDE.md`'s own "Do NOT kill processes machine-wide" section cites a taskkill-by-image-name event that destroyed a 40-minute LongMemEval run — a different code path, same failure class the research doc found live in `instance-lock.ts:124-154`). It fires on a live 3-minute watchdog timer, unpatched, right now, on a box that also runs the prod daemon, Ollama, and sibling agents.
- 1.1 (zero-yield telemetry) addresses Case B, for which the research doc cites **no documented incident** — only Case A (qwen3, a different, partially-visible failure mode) has one.

Grouping both into "one slice" mitigates the practical risk (both land together), but the plan's own prose ordering and "highest leverage in the entire report" framing sets reviewer and builder attention on the visibility gap first. If the slice gets split under the very time pressure Track 2 creates (a plausible outcome, since the plan explicitly says Track 2 is time-sensitive and Track 1 nominally gates it), the currently-active kill hazard is the one that should not wait. Recommend the plan state explicitly: if Track 1 must be split, 1.2 ships first, alone if necessary.

---

## Defect #4 (moderate): three CONFIRMED findings and one PLAUSIBLE finding were dropped between the research doc and the plan, and one drop contradicts the research doc's own recommendation

The research doc's own §8 "THE PICK" (its author's synthesis, not just the raw findings table) explicitly bundles finding #8 into "Week 2": *"Add the `knownPairs` membership guard (#8)."* The plan's Track 1/2 item list has no mention of tag-hygiene, `knownPairs`, or provenance-column validation anywhere. This isn't a case of the plan reasonably triaging a PLAUSIBLE finding out — the research author already decided to include it, and the plan silently dropped it in translation. Given the finding's actual content — an LLM writes **unvalidated** repo/project names into `memories.repo`/`memories.project`, columns that recall filters and sync's tenant-scoping vocabulary **trust** (`tag-hygiene/tier2-infer.ts:32-36`, write site `backfill.ts:131-135`) — this is a data-integrity/cross-tenant-trust concern adjacent to the same "guard exists in one sibling subsystem but not its twin" pattern the report calls the codebase's dominant disease. It belongs in Track 1 or 2, not nowhere.

Also absent, and should at minimum be named as explicitly deferred with a reason:
- **Finding #11** (judge fallback conflation — transport/parse errors collapse into the same "unrelated" verdict as a genuine semantic judgment, silently costing a legitimate merge with no counter). Directly adjacent to 2.5/contradiction detection, which the plan does touch — a natural companion fix, currently unmentioned.
- **Finding #12** (stale consolidation-proposal ghost rows, INNER JOIN silently drops erased-atom references from the staleness sweep). Low severity, cheap, same "migration hygiene" spirit as 1.5 — could ride along.
- **The `materializeRelease` self-heal hazard** (PLAUSIBLE — if the recomputed release id matches the currently-serving one but content differs, `rmSync` can target the live daemon's own loaded directory, a Windows file-lock hard-fail exactly when self-healing is needed, `release.ts:339-400`). This is directly adjacent to Track 1.2, which already touches the reinstall/kill path — the plan is already in that code region and doesn't mention it.

None of these are individually plan-breaking. But three CONFIRMED-or-recommended items and one adjacent PLAUSIBLE hazard disappearing without a stated reason, in a plan whose own organizing principle is "the disease is guards that exist in one place and not its sibling," is a real gap. At minimum the plan should list them as explicitly deferred (with why), not silently absent.

---

## Defect #5 (moderate): Track 2's own "expect a loss" scenario has no plan attached to it

2.2 says "Expect the honest full-sample overall to land below 45.4. Plan the messaging for that now, not after" — and then does not plan the messaging. There's no branch for "the full-sample number comes in below the paper's 41.4 RAG baseline" — a real, non-remote possibility given the 45.4 came from a 10%, one-conversation sample and the plan itself expects regression. If that happens, 2.6's "positioning asset" framing (CI-gated eval floors, judge-gullibility audit, 6.4% corrupted ground truth) becomes the *entire* external story instead of a supporting one, and that's a materially different messaging posture than what 2.6 currently describes. The plan identifies its own worst case and then doesn't act on it — worth one paragraph naming what gets said if the number is genuinely worse than the competitor baseline it currently claims to beat.

---

## Defect #6 (minor-moderate): unaddressed risks within the plan's own named tracks

- **1.2's acceptance criterion is asymmetric.** It specifies the mismatch case (stale lock with wrong start-time → never signaled) but not the match case (legitimate holder with correct start-time → still signaled normally, i.e., the hang-watchdog still actually works). A subtly wrong start-time comparison (clock-source mismatch between how the lock file stores it and how the OS reports it on a fresh read, e.g. second- vs. millisecond-precision, or timezone handling on Windows `wmic`/`Get-Process.StartTime`) could make the check **always** report a mismatch, silently converting "refuse to kill a mismatched process" into "refuse to kill anything, ever" — quietly neutering the SLICE-2 hang-watchdog the plan doesn't mention testing against. Add a self-consistency acceptance test: a lock file written by the current process, re-read immediately, must still match.
- **1.4's acceptance criterion only covers the narrower fix.** If the architect picks redact-on-quarantine (explicitly flagged as the "smaller, safer" option), the plan's stated acceptance ("a quarantined file containing a synthetic secret has that secret scrubbed") passes cleanly while the larger surface the plan itself names — plaintext-at-rest in the *healthy* spool path — remains completely unaddressed and untracked. No follow-up FEAT is proposed for that branch.
- **1.5's safety net is git-archaeology, not runtime verification.** "Nothing has ever written [these tables] in the repo's history" is evidence from source control, not a guarantee about any given live database (a customer instance, an older code path, a manual insert). The migration as scoped has no proposed pre-drop assertion (e.g., abort or back up if row count > 0) — cheap to add, not currently required by the plan's acceptance criteria.
- **2.3's backfill ambiguity.** Adding atom-level `valid_at`/`invalid_at` going forward leaves existing atoms with no value in the new fields. The plan doesn't say how `as_of` filtering or the contradiction/merge logic (2.5, already live and already touchy per Defect #1) should treat NULL-vs-set validity on a mixed-cohort store. Worth one sentence of scope: new-writes-only vs. backfill-required.

---

## What's genuinely sound and shouldn't be second-guessed

- Design A / "salvage, don't reinvent" is the correct read of the Verdict Gate (0/5 cleared) and the plan doesn't smuggle a redesign back in.
- Track 3 is appropriately hedged — explicit "HYPOTHESIS, not a commitment," a single numeric kill criterion (~300ms), and the plan already names the proxy-listener question as something that "could kill it on paper before anyone writes code." That's the right posture for an idea this exciting to propose; the only refinement worth making is sequencing the *proxy* question (answerable by reading code, cheap) before spending the cold-start-benchmarking effort, since it's the more likely of the two to be a fast "no."
- 2.1 ("stop quoting 45.4 externally, today, costs nothing") is correctly unblocked by nothing and should ship immediately regardless of how the rest of this review lands.
- 1.2's chosen fail-safe direction (refuse-to-kill over kill-wrong-thing) is the right call given the repo's own incident history, and the plan states this reasoning explicitly rather than asserting it.

---

## Ranked defect summary

1. **Track 2.5 is factually wrong about current state** — recommends flipping a flag that's already flipped, already caused a real (not hypothetical) incident, already got patched, and is currently overridden locally by the operator. Rewrite before any builder touches it. *(severe)*
2. **Sequencing rationale is internally inconsistent** (Framing says all of Track 1 gates the rest; Track 2's header says only 1.1) and even the narrow version overclaims what a one-off benchmark rerun needs from a persistent telemetry system. *(moderate-high)*
3. **1.1 vs 1.2 priority framing inverts urgency** — the report's own highest-severity, already-occurred-once, currently-live kill hazard (1.2) reads as secondary to an observability gap (1.1) with no documented incident yet. *(moderate)*
4. **Findings #8, #11, #12, and the `materializeRelease` hazard dropped without explanation** — #8 in particular was in the research doc's own recommended plan and disappeared in translation. *(moderate)*
5. **No messaging plan for the scenario the plan itself calls likely** (full-sample score lands below the competitor baseline it currently claims to beat). *(moderate)*
6. **Acceptance criteria gaps in 1.2, 1.4, 1.5, 2.3** that could let each item pass review while leaving its stated larger risk unaddressed. *(minor-moderate, itemized fixes above)*

**Verdict: NEEDS_FIX.** Defect #1 alone should block a builder from starting 2.5 as currently worded. Defects #2–#6 don't require re-scoping the plan's overall shape, but should be resolved (or explicitly accepted with reasoning) before build starts, since several of them are exactly the "guard on one code path but not its sibling" pattern the plan's own organizing principle warns about — applied to the plan's own construction.
