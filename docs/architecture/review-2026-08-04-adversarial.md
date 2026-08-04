# Architecture Review — Adversarial Pass

> **Subject:** astramem-local v0.22.0, schema 63
> **Reviewed:** `docs/architecture/astramem-architecture-sheets.md`, cross-checked against `src/`
> **Date:** 2026-08-04
> **Brief:** argue the strongest possible case that this architecture's *shape* is wrong. Withdraw
> any charge that cannot be evidenced.
> **Companion:** [`review-2026-08-04-constructive.md`](./review-2026-08-04-constructive.md)

---

## Verdict

**4 of 7 attack lines survive with hard evidence. 3 are withdrawn — refuted by code already in the
repo.**

| # | Charge | Outcome |
|---|---|---|
| 1 | 8-stage LLM pipeline is over-engineering | **REFUTED** (narrow form survives) |
| 2 | Dual-pass default rests on an unverified number | **SURVIVES** |
| 3 | `codex-subscription` default is uncappable | **SURVIVES** |
| 4 | Single-process synchronous SQLite | **REFUTED** in strong form; narrow form survives |
| 5 | Governed-off machinery is dead code | **MOSTLY REFUTED**; sharper finding survives |
| 6 | Fusion weights are unvalidated | **REFUTED** for bonuses; **SURVIVES** for base terms |
| 7 | *(self-found)* The eval substrate is noisier than what it measures | **SURVIVES** |

### The single most dangerous structural weakness

**The shipped default provider's day-to-day quality variance (±6 F1 points, measured) is
comparable to or larger than the deltas used to justify pipeline defaults.**

Dual-pass was promoted on a +9.39-point gain that was never reproduced and was measured on a
since-rolled-back configuration. Because the default provider *is* the evaluation substrate, the
project currently cannot cleanly distinguish *"this knob helped"* from *"codex had a good day."*

Its own 2026-07-19 research log reaches that conclusion: *"config levers are exhausted… the
champion gap is variance, not a missing lever."* At least one load-bearing decision already in
production was very likely made on a noise-sized signal, and no mechanism would catch a repeat.

---

## Charge 1 — The 8-stage pipeline is over-engineering

**REFUTED.**

`docs/research/20260714-locomo-hypothesis-ledger.md:92-95` records *"Raw-transcript search is +4 to
+10"* as **DEAD** — turn-as-answer F1 measured 0.137; facts are "findable but unanswerable." Lines
143-148 record *"Swap SQLite for a faster store"* as **REJECTED, already adjudicated** — recall
latency is ~135 ms embedder + single-digit-ms SQLite; the store is 1–3% of the path that matters.

The team ran both simpler alternatives this charge proposes. Both lost decisively.

**Narrow form survives:** the volume of machinery exceeds the evidence supporting it. Gatekeeper,
atom triage and the evidence gate all ship `off`. Compaction shipped **on** and was later found to
cause typeAcc harm of −23 to −29 on the default codex path
(`docs/eval-runs/BASELINE-CONSTANTS.md:19`) — it ran a coding-agent compressor over personal
conversations unconditionally, with no size gate, until caught by *incident, not design*. One of
the eight stages shipped actively harmful before anyone measured it; three more sit built-but-unproven.

---

## Charge 2 — Dual-pass extraction doubles cost on a number that would not pass review today

**SURVIVES.**

`src/config/config.ts:1780-1789` justifies the shipped default with *"measured LoCoMo full-suite
gain 0.4610 → 0.5549."*

- `docs/eval-runs/README.md:7` states the rule: *"If a number isn't backed by a folder here, treat
  it as unverified."* **The 0.5549 figure has no archived run folder** anywhere under
  `docs/eval-runs/`.
- `README.md:14` — canonical full-suite (n=1986) state is **0.4610 baseline / 0.4840 best**, and
  the 0.4840 best came from **turning compaction off**, not from dual-pass.
- `README.md:20-24`, `BASELINE-CONSTANTS.md:31,40` — later work established **±6 F1 day-to-day
  variance** on codex; the 0.60 "champion" is **not reproducible same-recipe** (replay: 0.5346, a
  6.6-point miss).
- `docs/research/20260717-holding-state-ledger.md:15-17` — the original measurement was taken on a
  **local-qwen** configuration **since rolled back** for starving `/health`. The comment's own cost
  justification ("pass B costs nothing because extraction is local") **does not describe what
  ships**.

**Mitigation found:** a skip-gate (chunks yielding 8+ atoms skip pass B) puts the real multiplier
below a clean 2×.

This is not "the number is fake" — it is real, dated, honestly cited. It is a single
non-reproduced measurement, taken under conditions that no longer match production, justifying a
default that permanently doubles metered calls to the one provider the product **cannot meter**.

### Operator addendum (2026-08-04) — why the folder is missing

The operator recalls the dual-pass run directly: **it was executed in a git worktree that was
subsequently deleted, which is why no archived folder survived.** This is corroborated rather than
merely asserted — `docs/eval-runs/README.md:14` records the 0.6002 conv-1 champion as *"run dir
deleted"* too, so lost run directories are an established pattern in this repo, not a one-off.

**This changes the charge's character but not its remedy.** The measurement was almost certainly
performed and almost certainly showed a gain; what is gone is the *evidence*, not the work. So the
correct action is **not** to revert `extractionPasses` to 1 on suspicion — that would discard a
probably-real improvement to satisfy a bookkeeping gap. The correct action is to **re-run and
archive it**, on the provider that actually ships, with a same-day single-pass control.

Two durable lessons stand regardless:

1. **An eval run inside a disposable worktree is an unarchived run.** Archiving must happen outside
   the worktree, or at minimum before teardown. Worth a harness guard, since this has now cost two
   headline numbers.
2. **The comment's cost justification is still wrong today** independent of the score: it argues
   pass B is free because extraction is local, and extraction is not local — it is
   `codex-subscription`. That sentence needs correcting whatever the re-run shows.

---

## Charge 3 — `codex-subscription` as default, with a cost cap that cannot see it

**SURVIVES. Strongest charge in the review.**

- `config.ts:1580-1581` — shipped default for both compaction and extraction.
- `config.ts:1567-1568`, `src/distill/cost-cap.ts:13-18` — hardcodes `usage.usd: 0` on every call,
  so `budget.daily_usd` (default $10) never sees its spend.
- `src/doctor/checks/budget-cap-codex-blind.ts` — the product's own doctor check names this.
- **Not hypothetical:** 2026-07-31 quota exhaustion poisoned 198 distill jobs and silently dropped
  ~875 memories until replayed on 2026-08-04.
- The provider's own source comment flags possible ToS risk to the user's OpenAI account.

The flagship default has a cost-control system that provably cannot function for that default, and
the resulting failure mode has already occurred in production. Every customer accepting the default
install inherits an unmetered, quota-cliff-prone dependency with a demonstrated silent-failure
history — defended by a "budget cap" that does not apply to the path most users will run.

---

## Charge 4 — Single-process synchronous SQLite

**REFUTED in the strong form.** KNN search (`src/vector/vec-search-{host,worker}.ts`) and embedding
(`src/providers/embed/onnx-worker*.ts`) are both genuinely offloaded to `worker_threads`. The two
heaviest compute operations are not on the HTTP thread. This was designed around.

**Narrow form survives, with three production incidents as evidence:**

- `holding-state-ledger.md:18` — consolidation's candidate-selection KNN ran synchronously on the
  main thread and wedged `/health` for 15+ minutes (#370). Reverted to a full-scan fallback as a
  stopgap, not fixed architecturally.
- The event-loop saturation triad: a `thread-stream` `Atomics.wait` freeze, unbounded `/health`
  table scans amplified by the watchdog itself, and the sync consolidation KNN.
- `holding-state-ledger.md:21` — `ASTRA_SKIP_CONSOLIDATE=1` remains a dormant kill switch for an
  unbounded synchronous setup phase that can freeze boot on a large corpus.

**The real finding:** the discipline that refutes the strong charge — *offload the heavy stuff* —
**is not enforced anywhere.** No lint rule, fitness function or gate stops a new feature wiring a
synchronous full-table or vector scan into a request-reachable path. This mistake class has
recurred at least three times and was caught by production incident every time, never by review.

---

## Charge 5 — Governed-off machinery is "built, wired, never invoked"

**MOSTLY REFUTED.** `docs/adr/ADR-014-local-fusion-governance.md` + `applyFusionGovernance`
(`config.ts:1836-1868`) is a real, *automatically enforced* mechanism: any configured `eta`/`theta`
> 0 is forced back to 0 at config-load time unless `src/eval/eval-evidence.ts` records a passing
ADR-005 harness delta for that specific term. This is the deliberate antidote to the very failure
mode the charge invokes, named after the incident that created it.

**A sharper finding survives — an evidence-bar inversion.**

`BASELINE-CONSTANTS.md:23` records `atomTriage` measured with a **positive, zero-cost** delta
(recall 80.1, typeAcc +9) — and it still sits `off`, "pending ship decision."

Meanwhile `extractionPasses: 2`, which **doubles metered cost**, shipped as default on a single
later-undermined measurement.

**The bar for shipping is inversely correlated with cost.** The free win waits for a decision; the
expensive one already shipped.

---

## Charge 6 — Fusion weights are unvalidated constants

**REFUTED for the bonus terms** (ζ, η, θ — genuinely gated, see Charge 5).

**SURVIVES for the base terms.** ADR-014 declares α, β, γ, δ *"required, structural"* and
**exempt** from the eval-evidence rule it imposes on everything else. Even ε (usefulness, 0.1)
ships by convention — it counts as "evidenced" only because standing eval runs happen to exercise
it, not because 0.1 was compared against 0.05 or 0.2.

So the two heaviest weights in the entire formula — BM25 (0.4) and cosine (0.4), **80% of total
ranking weight** — have never been through an ablation, and are policy-exempted from the exact
discipline the project built and automatically enforces for every smaller term.

The project can prove its *bonus* terms are inert-until-evidenced. It cannot say the same about the
terms doing 80% of the work.

---

## Charge 7 *(self-found)* — The evaluation substrate is noisier than the thing being tuned

**SURVIVES. This is the one that matters.**

- `docs/eval-runs/README.md:20-24` — same-recipe replay scored 0.5346 vs champion 0.6002, a −6.6
  point gap attributed to *"codex service quality moves ±6 pts between days"*, not a missing lever.
- `BASELINE-CONSTANTS.md:33-40` — the 2026-07-19 board shows every subsequent config lever
  (chunk size ×3, sweeper v1/v2) **REJECTED**; differences fell inside noise.
- `README.md:26-31` — the project's own conclusion: *"Config levers are exhausted… the champion gap
  is variance, not a missing lever."*

This connects Charges 2 and 3: a decision that doubles metered cost by default was made against an
evaluation substrate whose day-to-day noise is the same order as the claimed gain, using a provider
whose spend cannot be capped.

Every future "this knob helped" claim is untrustworthy until the eval substrate is stabilised
(multi-day medians, or a non-variance-prone provider for eval) or day-variance is explicitly
subtracted. **No mechanism currently enforces that before a knob becomes a shipped default — which
is exactly how Charge 2 happened.**

---

## Confidence calibration

| Claim | Confidence | What would change it |
|---|---|---|
| C2 — dual-pass default unverified | High | An archived `docs/eval-runs/<date>-dual-pass-full-suite/` reproducing ≥0.55 on n=1986 with a same-day single-pass control |
| C3 — budget cap blind to default provider | High | `usage.usd` no longer hardcoded 0, or a call-count/quota cap that actually gates codex |
| C4 narrow — offload discipline unenforced | High | A CI rule failing the build on new synchronous DB scans reachable from handlers |
| C6 — base weights unablated | Medium-High | An archived α/β ablation against retrieval-eval floors |
| C1 narrow — stage count vs evidence | Medium | A ship decision on gatekeeper / atomTriage / evidenceGate |

---

## Withdrawn charges

Stated explicitly, because withdrawing what cannot be evidenced is the point:

- **"Needs a simpler index, not an LLM pipeline."** Withdrawn — the team tested and killed both the
  raw-transcript and faster-store alternatives with real data.
- **"No async offload exists; everything blocks the HTTP thread."** Withdrawn in strong form — KNN
  and embedding are genuinely offloaded.
- **"The governed-off bonus terms are reckless dead code."** Withdrawn — ADR-014's
  `applyFusionGovernance` is an automatically enforced evidence gate, the opposite of the pattern
  it superficially resembles.

---

## Recommendation

Do not treat this architecture as broadly unsound. The core retrieval and storage shape is
defensible, and the team has real discipline in places — ADR-014's fusion governance is genuinely
good engineering.

Two concrete defaults need revisiting before this ships wider:

1. **`extractionPasses: 2`** — either get a same-day, canonically archived full-suite reproduction
   on the actually-shipped provider, or drop back to 1 pending one.
2. **`codex-subscription` as *default*** (not as an option) — either a real cost cap
   (call-count/wall-clock, which `contradictionDetection` already proves is possible) enforced
   before first run, or a non-quota-cliff provider out of the box.

Everything else is track-and-monitor, not block.
