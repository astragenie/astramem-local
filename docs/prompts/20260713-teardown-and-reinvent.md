# PROMPT: Teardown & Reinvent — astramem-local

> Paste this whole file as the first message of a fresh session (Fable 5, high effort).
> This is an adversarial prompt. It is written to make you *hostile* to the code you are
> about to read. You did not write it. You owe it nothing. Your loyalty is to the user's
> outcome, not to the artifact that currently exists.
>
> It is also a *disciplined* adversarial prompt. Hostility is the energy source, not the
> conclusion. The gates in §1 and §2 exist so that this cannot degenerate into a
> rubber stamp pointed at demolition.

---

## 0. Framing (read this twice)

astramem-local is a local-first memory daemon: TypeScript + Node 20 + Fastify +
better-sqlite3 + sqlite-vec, ~28 subsystems under `src/`, an MCP surface with ~20 tools,
an LLM distill pipeline, a bitemporal store, a consolidation judge, a sync client to a
SaaS backend, and an install/service layer that has already caused two production outages.

It scores **45.4 F1 on LoCoMo** (beats the paper's 41.4 RAG baseline). It is *not bad*.
That is exactly the problem. **"Not bad" is the terminal disease of infrastructure
software** — it produces a system nobody loves, that nobody can rip out, and that quietly
loses to something a competitor shipped in a weekend.

Your job in this session is **not** to be helpful, balanced, or constructive-first.

Your job is:

1. **Find every real bug, glitch, race, silent failure, and lie in the codebase.** Not
   style nits. Things that will bite a user at 2am.
2. **Prosecute the architecture** — under the two-hypothesis discipline in §1, and against
   the redesign threshold in §2. Attack core premises, not leaves.
3. **Mine the competitors** (on disk, see §5) for the patterns that make them feel
   inevitable, and identify what astramem is structurally incapable of doing.
4. **Then, and only then, invent.** Raise temperature. Propose the version of this thing
   that would make a stranger say "how did this not exist before." Not a roadmap of
   incremental FEATs. A different animal.

**Do not soften. Do not hedge.** If something is broken, say it is broken and show the line.
If the whole approach is a dead end, say so and say what replaces it.

**A specific, falsifiable hypothesis is worth more than a vague truth — but an unverified
hypothesis must NEVER be presented as a confirmed finding.** Specificity is the goal;
overclaiming is the failure mode. The CONFIRMED / PLAUSIBLE / REFUTED taxonomy in §3 is
how you get both.

---

## 1. THE TWO HYPOTHESES (this governs the whole session)

You will hold **both** of these from the first file you open until the verdict. You are
required to gather evidence **for and against each**. You may not collapse to one early.

> **H1 — LOCAL MAXIMUM.** astramem's core ontology is wrong. The primitive ("memory atom")
> loses information the product needs, and every subsystem is paying compensating costs to
> route around that loss. No amount of implementation quality fixes it. It needs an
> ontological change.
>
> **H2 — SOUND CORE, ACCUMULATED DEBT.** astramem's core architecture is right — local-first,
> SQLite, an event-sourced-ish ingest, a bitemporal store, MCP as the surface. What looks
> like architectural failure is integration debt, missing invariants, unguarded boundaries,
> and an install layer that grew scar tissue. Ruthless cutting and hardening gets it there.

Rules:

- **H2 is the incumbent and gets the benefit of the doubt.** Demolition must *defeat the
  strongest possible salvage case*, not the weakest. If you find yourself arguing against a
  weak version of H2, you are doing this wrong — steelman it first, then attack.
- Every architectural charge in Phase 4 must be scored: *does this support H1, or is it
  merely H2 debt wearing an architecture costume?* Most bugs are H2 evidence. Say so.
- The verdict in §9 must state which hypothesis won, **with the evidence that would have
  changed your mind**.

---

## 2. THE VERDICT GATE (read before you touch code)

Ontology replacement is expensive, and "rewrite it" is the laziest possible conclusion for
a model with no migration cost. So the bar is set *before* investigation, not after.

**A redesign (H1) is justified ONLY if you demonstrate at least one of:**

1. **Structural impossibility.** A key product capability is impossible, or grossly
   disproportionate in cost, under the current ontology — not "unimplemented," *unexpressible*.
2. **Triple-subsystem contagion.** The current primitive causes the *same* complexity to
   recur in **≥3 independent subsystems**. (One ugly subsystem is debt. Three paying the
   same tax is an ontology signal.)
3. **Compensating-mechanism proof.** Correctness depends on machinery that exists *only*
   because the core abstraction discards essential information. (Name the mechanism. Name
   the discarded information.)
4. **Ontology-derived competitor advantage.** A competitor demonstrates materially better
   capability at *lower* conceptual complexity, and you can show the advantage comes from
   their **ontology**, not from implementation maturity, funding, or a bigger model.
5. **Migration-cost parity.** Fixing it incrementally costs roughly what migration costs,
   *and still leaves the underlying limitation in place*.

**If none of the five clears: the answer is Design A (Sharpened Knife). Default to
salvage.** Say so plainly, and do not reach for reinvention as a consolation prize.

State explicitly, in the verdict, **which gate(s) you cleared and with what evidence** — or
that you cleared none.

---

## 3. EVIDENCE STANDARD (non-negotiable)

`file:line` proves *code exists*. It does **not** prove *the failure happens*. This is the
single most common way a review like this ends up confidently wrong — a plausible race that
a transaction boundary, constraint, or caller-level invariant three files away already
prevents.

**CONFIRMED** — requires ONE of:
- a **reproduction** (a test, a script, a curl sequence) that you actually ran and observed; or
- a **deterministic static proof** — you traced every caller and every guard on the path and
  can show no invariant prevents it; or
- **incident evidence**: an existing bug report, log, or documented outage tied to *this
  exact path* (this repo has real ones: the stale-dist outage, the keystore bearer
  overwrite, the ingest-starvation "broken distill").

**PLAUSIBLE** — a credible path exists; you could not reproduce or fully prove it. This is a
respectable outcome. Say it. Do not launder it into CONFIRMED.

**REFUTED** — you suspected it, went looking, and the code defends itself. These go in §9
("What I Was Wrong About") and they are **not** failures — they are the proof you were honest.

Apply this ruthlessly to **concurrency, bitemporal anomalies, SQLite locking, and lifecycle
races**. Those are exactly where a model invents plausible-but-impossible scenarios. If you
cannot run it or prove it, it is PLAUSIBLE. Period.

---

## 4. Ground truth — read these first

Repo: `C:\work\mega\astramemory-local`

- `CLAUDE.md` — the project's self-description. **Treat it as a suspect document.** Written
  by prior sessions defending prior decisions. Every "RESOLVED (do not re-fix)" block is a
  place someone wanted the questioning to stop. Go look anyway. *(But note: several of them
  are genuinely resolved. Confirming that is a valid, valuable output — it's H2 evidence.)*
- `src/` — 28 dirs: `distill/ recall/ search/ consolidate/ storage/ vector/ sync/ mcp/
  ingest/ capture/ service/ doctor/ entity/ proxy/ eval/ redact/ budget/ pipeline/ ...`
- `docs/research/2026-07-09-competitor-gap-analysis.md`
- `docs/research/2026-07-08-astramem-ecosystem-report.md`
- `docs/research/2026-07-08-supermemory-matrix.md`
- `docs/specs/20260713-locomo-architect-design.md` + `-review.md` + `-score-plan.md`
- `.claude/artifacts/loop/backlog/` — what the project *thinks* it should build next.
  **Is this backlog a plan, or a treadmill?**

Known-live memory (verify, do not trust):

- `qwen3:8b` returns EMPTY on distill extract → poisons the pipeline. Extraction pinned to
  `qwen2.5-coder:7b`. **Why is the pipeline able to be poisoned by a model swap at all?**
- Dominant historical failure mode: **"built, wired, never invoked."** Good code nothing
  calls. `doctor` grew canaries to detect it. *(Gate-3 candidate: is that a compensating
  mechanism for a missing invariant, or just a testing gap? Decide with evidence.)*
- Distill "broken" was ingest starvation — the capture hook shipped transcript *paths*
  deleted before the async reader got to them.
- Temporal reasoning: **12.4** on LoCoMo vs 83.0 adversarial. The system stores bitemporal
  columns and cannot answer "when."

---

## 5. DEPTH BUDGET (spend attention where it pays)

You will run out of effective attention before you run out of things to read. Spend
deliberately. **This ordering is binding.**

**Tier 1 — deep read, no budget limit:** `astramem-local` itself. This is the subject.

**Tier 2 — deep read the source, not the README** (`C:\work\mega\astramem-local-competitors-code\`):
- `graphiti/` (Zep) — **temporal knowledge graph.** Bi-temporal edges, invalidation as a
  first-class graph op. This is precisely where astramem scores 12.4. Highest-value read
  in the entire session.
- `mem0/` — the market's default answer. Extraction + the update-vs-add decision.
- `supermemory/` — the UX/DX and install-quality benchmark.

**Tier 3 — targeted read only, and only when a specific question demands it:**
- `letta/` (MemGPT) — memory as an *OS*: paging, self-editing memory. Read it to answer one
  question: *should the agent manage its own memory instead of a daemon doing it for them?*
- `cognee/` — ECL pipelines, graph+vector fusion. Read for pipeline shape only.
- `txtai/` — the minimalist counterargument. Read to answer: *how much of astramem is
  unnecessary?*

**Hard rules on spend:**
- **10 deeply verified bugs beat 40 grep-based suspicions.** A long PLAUSIBLE list is a
  cheap simulation of rigor. Do not produce one.
- **Never sacrifice Phase 8 (invention) to claim exhaustive competitor coverage.** Phase 8
  is likely the highest-value output of this session. If you are running low, cut Tier 3
  entirely and say you cut it. **Silent truncation is the one unforgivable sin here** — if
  you skipped something, name it.
- If Tier 3 goes unread, say so in the deliverable. An honest gap beats a confident bluff.

---

## 5b. Phase 0 — Establish the Baseline (DO THIS BEFORE ANYTHING ELSE)

You are about to run tests, possibly instrument code to reproduce bugs, inspect eval output,
and maybe swap models. Without a baseline, a finding cannot be cleanly tied to the initial
state — and **this repo in particular has a documented history of exactly that confusion**:
stale `dist/` artifacts producing phantom regressions, a model-config swap silently poisoning
distill, an eval profile change moving the score 23.6 → 45.4, embed-dim mismatches yielding
garbage instead of errors, and an install layer that has served the wrong build to itself.
**A "bug" that is really a dirty workspace will waste the entire session.**

Record, before touching anything:

- current **git commit + branch**, and **dirty working-tree state** (`git status --short`);
- **test suite status** — run it once, clean, and record what already fails;
- **current LoCoMo scores + the exact eval configuration** that produced them;
- **active extraction model** and **embedding model** (and confirm `dist/` is built from the
  current source — `tsc --noEmit` is *not* a build);
- **SQLite schema / migration version**;
- **Node + package-manager versions**.

Rules for the rest of the session:

- **Do not modify production code during investigation** unless a reproduction requires it.
- Any reproduction-only modification must be **isolated and explicitly identified** — and
  reverted or listed in the deliverable.
- The final report **must distinguish pre-existing failures from failures introduced by your
  own investigative instrumentation.** A red test you caused is not a finding.

---

## 6. Phase 1 — Five End-to-End Forensic Traces (DO THIS FIRST)

**Before any directory-by-directory audit.** Memory systems fail at the *transitions*
between components, not inside modules. A 28-directory sweep can miss every real bug while
feeling thorough.

Trace these five scenarios through the actual code. For each: the exact call path,
**transaction boundaries**, durable state transitions, failure boundaries, retry semantics,
and the final observable result.

1. **Fresh fact.** capture → ingest → distill → atom → store → embed → retrieve. The happy
   path. Where is it *not* atomic?
2. **Contradiction.** The user says X on Monday, not-X on Friday. Walk it. What does recall
   return on Saturday? Does *anything* in this system notice the conflict, or do both atoms
   just sit there and let the ranker pick?
3. **Temporal fact.** "X was true from January to March, false now." Store it. Query it
   `as_of` February. **This is the 12.4 score. Find out *mechanically* why it fails** —
   is it extraction, storage, or retrieval? The answer determines whether B is even needed.
4. **Crash recovery.** Kill the process after persistence but before distill/embed completes.
   What is on disk? Does it heal on restart, or is that record now a permanent zombie —
   stored, unembedded, unfindable, and counted as success?
5. **Erase.** Delete a memory. Then run consolidation, sync, and replay. Does it stay dead?
   Can it resurrect through the sync client, the idempotency replay cache, or a
   consolidation proposal that captured it before deletion?

These five traces are worth more than the entire subsystem audit. Do them first, do them
properly, and let what they reveal aim Phase 2.

---

## 7. Phase 2 — The Bug Hunt

Now fan out, aimed by what Phase 1 exposed. Hunt the classes this codebase has *already
proven* it grows:

- **Silent-drop paths.** Every `catch` that swallows, guard that drops, queue that evicts,
  `continue` that skips — with no counter incremented. (`relation_guard_drops` exists
  because this already happened once. Where else?)
- **Unreachable runtime behavior.** Build a reachability graph from **production entry
  points**: HTTP routes, MCP tools, CLI commands, startup hooks, scheduled/background jobs,
  and externally consumed package exports. Report **unreachable runtime behavior** — *not*
  merely unused exported symbols. Exported types, schemas, adapters, and test seams are
  legitimately unreferenced from those roots; flagging them is noise, and noise here is
  worse than silence.
- **The LLM boundary.** Every place a model's output is `JSON.parse`d, trusted, or fed into
  SQL/embedding without a schema gate. `qwen3:8b` returning empty should have been a *loud
  typed failure*, not a silent poisoning. Find the other model-shaped landmines.
- **Bitemporal correctness.** `as_of`, supersede, invalidate, restore. Construct the sequence
  producing a memory simultaneously live and superseded, or one that resurrects after erase.
  *(Static-proof or reproduce it. This is a favorite hallucination zone — hold the line.)*
- **Embed/dim coupling.** `DEFAULT_EMBED_DIM`, `getVecSchemaDim()`, the migration
  placeholder, `reembed-dim`. Find the path where a user gets vectors of one dim in a table
  of another and receives **garbage similarity instead of an error**.
- **SQLite concurrency.** WAL? Busy timeouts? Two daemons (the keepalive re-run race)? What
  does better-sqlite3 do under the eval-shard fan-out this repo actually runs?
- **Install/service layer.** Already caused a stale-dist outage and a keystore identity
  collision that overwrote a **production bearer token**. Assume more of that class is there.
- **Security.** Bearer compare timing, the public `/health` + `/version` surface, the proxy,
  redaction bypasses, anything writing secrets to `ingest.log`.

**Findings table — these columns, exactly:**

| Rank | Finding | Status | Severity | Confidence | Evidence (file:line) | Reproduction | User impact | Root cause | Fix class |

`Status` ∈ CONFIRMED / PLAUSIBLE / REFUTED (per §3).

`Fix class` ∈ **local patch** / **cross-cutting correction** / **data-model limitation** /
**architectural symptom** / **ontology failure**.

This column is the load-bearing one — the bridge from Phase 2 into Phase 4. A pile of
`local patch` findings is **H2 evidence**. A cluster of `ontology failure` findings hitting
three separate subsystems is **Gate-2 evidence for H1**.

**Do not skip the middle rung.** `data-model limitation` means: *the core noun is sound, but
the persistence representation cannot express what the product needs* — validity intervals,
provenance chains, contradiction edges, event causality. A schema that cannot hold a validity
interval is **not** proof that "atom" is the wrong primitive; it may be proof that the atom
needs a better table. **Escalating "the schema is insufficient" into "the ontology is wrong"
is the single most likely way this investigation reaches a false H1.** Make the case for
`ontology failure` only when a better schema demonstrably cannot rescue it.

**Depth target: 5–15 deeply verified findings. Report fewer if fewer survive adversarial
verification. Never manufacture volume to hit a quota** — a padded table is a lie about rigor.

---

## 8. Phase 3 — Competitor Ontology Mining

Per the depth budget in §5. Read the code, not the README. For each:

1. What is their **core noun**? (mem0: a Memory. letta: a context window. graphiti: an edge
   with a validity interval. astramem: … *an atom? a memory? a transcript? — is the answer
   even consistent across `src/`?* If astramem's own subsystems disagree about the core
   noun, that is a finding in itself.)
2. What does their architecture make **cheap** that astramem makes expensive?
3. What can they express that astramem **structurally cannot** — not "hasn't yet," *cannot*?
4. What did they get *wrong* that astramem got right? **Be honest — this is H2 evidence and
   you are required to hunt for it as hard as you hunt bugs.** Local-first, SQLite,
   zero-cloud-dependency, agent-native MCP surface: these are real, defensible positions
   and none of the six fully occupy them.

**The money question, and Gate 4 lives or dies here.** The **working hypothesis — not a
finding** — is that graphiti's temporal advantage comes from temporality being part of its
core **ontology**, while astramem treats temporality primarily as stored **attributes /
columns**. Trace #3 (§6) must **prove or refute this mechanically**. Is the advantage
ontological (→ Gate 4 cleared → H1), or is astramem's 12.4 primarily an **extraction**,
**query-planning**, or **retrieval** failure (→ implementation → H2, and the fix lives in
`src/distill/` or `src/recall/`)?

Do not assume the answer. **Reconcile the code-read with the trace. If they disagree, the
trace wins — it is empirical and the code-read is interpretation.**

---

## 9. Phase 4 — The Charges

Now prosecute. Candidates below — find more, and **drop any you cannot prove**. Dropping a
charge is a win, not a loss; it goes in "What I Was Wrong About."

- **The pipeline is a monolith wearing microservice clothes.** 28 dirs, one process, one
  SQLite file, config read once at boot. What is the actual seam?
- **The atom is the wrong unit.** Search, fuse, consolidate, entity-relations — all fighting
  the fact that an "atom" is a lossy flattening of a conversation. Should the primitive be an
  *event with a validity interval*? *(This is the Gate-2/Gate-3 charge. It needs the
  three-subsystem contagion proof, or it dies here.)*
- **Distill is a batch job pretending to be a system.** LLM in the hot path, no typed
  contract, no replay, no atom-level idempotence, quality determined by whichever Ollama
  model the user happened to pull.
- **Retrieval is a bag of scores.** BM25 + vector + an epsilon usefulness term, fused. Is
  fusion doing real work, or is it a knob-farm hiding the fact that nothing here *reasons*?
- **The eval is the product.** LoCoMo went 23.6 → 45.4 by changing an extraction *profile*.
  That means the score measures the **prompt**, not the system. **What is the system actually
  good at, and is that thing on any benchmark at all?**
- **The install layer is a confession.** An enormous share of this repo's total engineering
  went into *not being broken by its own deployment*: shims, pointers, releases, rollback,
  materialization, canaries. That is a tell. What architecture makes it evaporate?
- **The moat question.** If mem0 shipped local-first SQLite tomorrow, what is left?

**For each charge, mandatory structure:**
1. **The charge**, stated flatly.
2. **The evidence** — code, `file:line`, and the Phase 2 findings that ladder into it.
3. **The strongest defense the codebase would make** — steelmanned, not strawmanned. Per §1,
   H2 gets the benefit of the doubt, so write this defense as if you believed it.
4. **Your rebuttal — or your concession.** Concessions are as valuable as kills.
5. **Verdict tag: `H1 evidence` or `H2 debt`.** And which of the five §2 gates, if any, it
   clears. Most charges will be H2. That is a legitimate finding, not a failure of nerve.

---

## 10. Phase 5 — Invent (temperature UP)

Stop being a prosecutor. Be a designer with nothing to protect.

Constraints — respect these, break everything else:
- Local-first. Runs on a laptop. No mandatory cloud.
- The user is an agent (Claude Code), not a human clicking a UI.
- Must survive an amnesiac process killed at any instant.

Push past the obvious:

- **What if memory is not storage?** What if the primitive is a *belief with a provenance
  chain and a decay function*, and "retrieval" is really *reconstruction*?
- **What would this look like if the LLM were 100× cheaper?** Nothing here would be a
  pipeline. It would be a *conversation with the archive*. Design that.
- **What if the daemon had opinions?** It watches every session. It knows the user
  contradicted themselves on Tuesday. It knows a "RESOLVED (do not re-fix)" note is now a
  lie because the file changed underneath it. Right now it is a passive bucket. **A memory
  system that never volunteers anything is a filing cabinet with extra steps.**
- **What is the demo that makes someone install this in 60 seconds and never uninstall?**
  Not a feature list. One demo. Name it.
- **What can only a local-first system do?** It sees the filesystem. It sees git. It sees
  every keystroke of every session. Cloud competitors see *what you chose to send them*.
  **That asymmetry is the entire moat — is any of it being used?**
- **Kill one subsystem entirely.** Which, and what gets better?

Produce **three** designs, deliberately far apart:
- **A — The Sharpened Knife.** Same ontology, ruthlessly cut and hardened. What survives,
  what dies. *(Per §2, this is the DEFAULT if no gate cleared. Give it real effort — do not
  write it as a strawman to make C look good.)*
- **B — The Temporal Graph.** Adopt graphiti's ontology: events + validity intervals as the
  core type; retrieval becomes traversal. Cost it honestly — migration, eval, LOC, and what
  breaks.
- **C — The Heretic.** The one you would only propose at high temperature. Makes the current
  repo a footnote. Argue it seriously.

Score each: user-visible magic · temporal fix · install/ops surface · migration cost · moat
depth · **time-to-copy by a competitor**.

**Pick one. Defend the pick.** Three options and a shrug is a failed session.

---

## 11. Deliverable

Write `docs/research/20260713-teardown-and-reinvent.md`:

1. **Verdict** — 3 sentences. **H1 or H2 — name it.** Which §2 gates cleared, with what
   evidence, or explicitly none. Plus: *what evidence would have flipped you?*
2. **Five Forensic Traces** — the §6 walkthroughs, with transaction boundaries and failure
   modes. Trace #3 (temporal) gets the most space; it is the load-bearing one.
3. **Findings** — the full table, all ten columns.
4. **The Charges** — each with evidence, steelmanned defense, rebuttal/concession, and its
   `H1 evidence` / `H2 debt` tag.
5. **Competitor Deltas** — core nouns; what they express that we cannot; **what we got right
   that they didn't**.
6. **Three Designs** — A / B / C, scored.
7. **The Pick** — one design, defended, with the first three weeks of work.
8. **What I Skipped** — anything the depth budget cut. Name it. Silent truncation reads as
   "covered everything" when it wasn't.
9. **What I Was Wrong About** — every charge and finding that did not survive contact with
   the code. **If this section is empty, you were not honest in the other eight.**
   *(Keep this. It is the load-bearing integrity check of the entire protocol.)*
10. **Baseline + Instrumentation** — the §5b snapshot, plus every reproduction-only edit you
    made. Pre-existing failures vs. self-inflicted ones, separated.

---

## 12. Rules of engagement

- **Evidence or silence — for claims about the existing system.** Every factual claim about
  current behavior, architecture, bugs, reachability, or a competitor's implementation cites
  code. CONFIRMED means §3-CONFIRMED.
- **Future-design claims are hypotheses and must be labeled as such.** "A belief with
  provenance and decay produces stronger user-visible magic" is not provable from a repo that
  doesn't contain one. In Phase 5, mark each design claim as a hypothesis and state **what
  evidence or experiment would validate it** — a spike, a benchmark, an eval, a user test.
  A design section full of unfalsifiable assertions is just as worthless as an unverified
  bug table; it is simply harder to catch.
- **No consensus-seeking.** If a finding contradicts `CLAUDE.md`, `CLAUDE.md` gets updated.
- **No incrementalism in Phase 5.** "Add a FEAT for temporal reasoning" is a failure
  response. The question is whether temporal reasoning is *possible in this shape at all*.
- **Salvage is a legitimate verdict.** If H2 wins, say so loudly, with evidence, and hand
  back a devastating Design A. **A demolition prompt that always demolishes is a rubber
  stamp pointed the other way. The goal is truth, not carnage.**
- **The redesign bar is §2, not your mood at hour six.**
- Use subagents / a workflow for the fan-out (bug hunt, competitor read). Verify
  adversarially — spawn refuters whose job is to *kill* your findings; a finding that
  survives a hostile reviewer is worth ten that never met one.

Begin with §6, the five forensic traces. Do not ask permission between phases.
