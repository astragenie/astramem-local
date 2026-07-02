# Architecture Documentation — Read Me First

**Produced:** 2026-07-02, as the capstone of the Astra strategy + architecture review series.
**For:** the dev team. This directory + `../adr/` is the implementation-ready package.

## Reading order

1. **`../adr/ADR-001..010`** — the ten ruled decisions. Everything else derives from these.
   Read 001 (memory atom), 002 (storage), 003 (sync) first — they define the system.
2. **`target-architecture.md`** — the system both products converge toward: diagrams, module
   maps, trust/failure boundaries, the six journeys, performance targets.
3. **`architecture-review.md`** — the adversarial pass: known weaknesses (W1–W8), what was cut,
   the residual risk register (R1–R7). Read before disagreeing with an ADR — your objection may
   already be here.
4. **`migration-map.md`** — the build order. Wave 1 (trust floor) → Wave 2 (contract + launch) →
   Wave 3 (team ledger, first paid surface) → Wave 4 (moat mechanics). **Item 1a (cipher spike)
   is first — it gates security claims.**
5. **`../specs/2026-07-02-encryption-and-secret-redaction.md`** — SEC-1..10, the merged v0.4.0
   spec implementing Wave 1.

## Strategy context (why these decisions)

The full strategy series lives in the **memory repo** at `docs/research/2026-07-02-astra-*`:
grounding briefs → strategy prompt → passes 1–6 → 110-agent verification sweep → combined market
research → final verdict. The short version:

- **astramem-local is the company** (7/10 GO). Cloud = team ledger only. runner-plugin = adapter.
  AstraRunner = internal.
- Positioning: **system of record for AI-assisted engineering** — neutral, org-owned,
  audit-grade, local-first.
- Verified market facts (2026-07-02): Anthropic memory tool is client-side by design (3–0);
  OpenAI ships no managed dev memory (3–0); Zep has bitemporal parity (3–0 — temporality alone
  is not our moat); the window is open and closing.

## Constitution (the constraints every future decision must respect)

- **C1:** maintainable by 1–3 humans + AI agents. New public surface requires a new ADR.
- **C2:** two implementations (Bun/TS local, .NET cloud) unified by **contract** (atom@1,
  retrieval@1, capture@1, sync@1 + golden eval fixtures), never by shared code or rewrite.
- **C3:** the 90-day plan ships regardless; architecture arrives through it, not instead of it.
- **C4:** local-first is load-bearing — full function offline, cloud strictly additive, every
  dependency has a degradation path.
- **Refuse-to-build** (standing): marketplace, generic memory API, human-memory positioning,
  bidirectional CRDT sync, Qdrant backend, in-process third-party plugins, per-user surveillance
  analytics.
