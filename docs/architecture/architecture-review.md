# Architecture Review — Adversarial Pass + Simplification Pass

**Date:** 2026-07-02 · **Scope:** ADR-001..010 + target-architecture.md, attacked once, then
simplified once (bounded per the architecture brief).

---

## Adversarial pass — weaknesses found, honestly

**W1. The cipher spike is load-bearing and unresolved. [HIGH]**
ADR-002 rests on `better-sqlite3-multiple-ciphers` coexisting with the `sqlite-vec` extension on
three OSes. If it fails, the fallback (app-level column encryption) leaves FTS5 indexes and
embeddings unencrypted-at-rest — materially weaker than the marketing will want to claim.
*Mitigation:* spike is migration-map item #1a, before any public security claims; README security
copy is gated on the spike outcome (ADR-009 consequence).

**W2. `recall_used` heuristic is the weakest link in the moat story. [MED-HIGH]**
ADR-010's implicit-use detection (served content referenced in a later turn) will be noisy:
paraphrase misses, coincidental overlap false-positives. If the seed metric is noisy, the seed
*story* is attackable. *Mitigation:* lead with the explicit signal (MCP feedback field) in
adapter UX; report explicit and implicit rates separately; never blend them in investor material.

**W3. Same-atom concurrent supersession across devices is under-specified. [MED]**
ADR-003 claims conflicts are "impossible by construction," which is true for the *log* but the
*ledger view* must still pick a current-truth when two devices supersede one atom divergently.
Last-writer-by-valid_to with full audit is ruled, but the UX for surfacing "two teammates
corrected this differently" is undesigned. *Accepted for v1* (team sizes 2–20; frequency low);
flagged for the team-recall design (v2).

**W4. Consolidation (stage 9) can silently degrade trust. [MED]**
Merging near-duplicates rewrites the atom set users have seen. Propose-only contradiction
handling is ruled (ADR-004), but merges are auto. *Fix adopted:* merges also produce
`derived_from` lineage AND keep originals as superseded (never destructive) — cheap because
bitemporal.

**W5. Replay/re-distillation vs erasure interplay. [MED]**
ADR-004 replay depends on retained transcripts; ADR-006 erasure deletes them. An erase followed
by a replay must not resurrect erased atoms. *Fix adopted:* tombstones are replay-filters —
pipeline consults tombstone list before emitting; add fixture to CI.

**W6. Solo-maintenance surface count is still high. [MED]**
Even after cuts: daemon (10 modules) + cloud (6) + contracts package + 2–4 adapters + memory-tool
adapter. That is the *irreducible* set for the strategy, but W6 is the standing argument against
every future "small" addition. *Standing rule:* new surface requires an ADR.

**W7. Azure/Azure-OpenAI residency coupling (cloud). [LOW-MED]**
Operator constraint keeps Azure; embeddings via Azure OpenAI limit EU-residency claims later.
The Ollama path proves the alternative exists; defer until a deal demands it (Pass 4 ruling).

**W8. Event log growth. [LOW]**
Usefulness events (ADR-010) will dominate volume. *Fix adopted:* usefulness events are
compactable (aggregate after N days into per-atom counters) — exempt from the never-delete ethos
since they are telemetry, not memory.

## Simplification pass — what was cut or narrowed

1. **gRPC** — cut (no consumer). Was in the master prompt's list; rejected in ADR-007.
2. **In-process plugin execution/sandboxing** — cut from v1; connectors are out-of-process HTTP
   clients, extractors are allowlisted. Removes the hardest security surface entirely.
3. **Bidirectional sync / cross-device pull** — cut from v1 (ADR-003); team recall v2 is
   read-only federation, not sync.
4. **Event-sourcing projection framework** — narrowed to an embedded log + same-transaction
   materialization (ADR-002). No replay infrastructure until a consumer exists.
5. **Marketplace, generic REST platform, SSO-v1, billing automation** — absent by ruling
   (ADR-006/007, strategy refuse-to-build).
6. **Graph/KG layer** — absent; entities stay as fields + side tables (ADR-001). Re-derivable
   later from atoms if ever needed.
7. **Local reranker** — deferred (ADR-005); the eval harness decides if/when it pays rent.
8. **Per-subject crypto-shredding** — deferred to v2 with an explicit accepted-risk note and a
   trigger condition (regulated-vertical deal) (ADR-006).

## Residual risk register

| # | Risk | Sev | Trigger/owner |
|---|---|---|---|
| R1 | cipher × sqlite-vec spike fails | High | Migration item #1a; fallback ruled |
| R2 | Anthropic ships managed team memory pre-launch | High | External; speed is the only mitigation |
| R3 | Usefulness metric too noisy for seed story | Med | W2 mitigations; explicit-signal UX priority |
| R4 | Redaction false-positives degrade distill quality | Med | Fixture suite gates detector changes (SEC spec AC) |
| R5 | Divergent supersession UX (multi-device) | Med | v2 team-recall design |
| R6 | TEI on shared CI box fails during first pilot | Med | Move before pilot (ADR-006 consequence) |
| R7 | Erasure-in-backups window (≤30d) unacceptable to a buyer | Low-Med | Crypto-shredding v2 trigger |

## Verdict

No architectural flaw found that blocks the migration map. The two genuinely open items (R1
spike, W2 metric design) are both scheduled before their dependents. The architecture holds the
line the strategy demanded: smallest possible permanent surface, every component paying rent,
optionality preserved through the event log and the contracts package rather than through
speculative frameworks.
