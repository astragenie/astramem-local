# ADR-009: Privacy & Scope Model — personal by default, promoted by choice

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High
**Context:** The product captures every agent session — structurally the most sensitive exhaust
on a developer's machine. Strategy Pass 4 §3: EU works-council / employee-monitoring optics can
veto org rollouts; "private by default, promoted by choice" must be a product primitive, not a
policy PDF. SEC-1..10 (merged) covers encryption + redaction; this ADR covers the model above it.

## Decision

1. **Scope is a first-class atom field** (ADR-001): `personal | team | org`. Default: `personal`.
2. **Promotion is an explicit event** (`promote_scope`, ADR-002 log): user action (CLI/MCP
   `promote_memory`) or a user-authored policy rule (e.g. "atoms of type `lesson` in repo X →
   team"). Promotion is auditable, revocable-forward (demotion stops future sync; already-shipped
   atoms follow erasure, ADR-006).
3. **Sync respects scope** (ADR-003): only `team`/`org` atoms leave the machine. Personal atoms
   are unreachable by the employer by construction — this is the works-council answer.
4. **Aggregation floor:** cloud analytics operate at team+ scope only; no per-user activity
   surfaces (no "what did engineer X ask the AI" view — refuse to build it, it is a rollout veto
   and a values statement).
5. **Threat model (v1):**

| Threat | Mitigation |
|---|---|
| Local DB file theft | Encryption at rest (SEC-1/2, ADR-002) |
| Secrets in transcripts | Stage-0 redaction pre-persist, pre-egress (SEC-3..5) |
| Bearer/device token theft | OS credential store (SEC-10, ADR-003); loopback-only bind |
| Malicious capture input | Redaction + no execution of captured content; capture API is data-only |
| Cloud breach | RLS (ADR-006) + personal atoms never present + field-level encryption of `text` at rest |
| Malicious plugin/extractor | No third-party in-process code v1 (ADR-007); allowlisted registry |
| Employer overreach | Scope model + aggregation floor (this ADR) |

## Options considered

1. **Scope-on-atom + explicit promotion (chosen).** Simple, auditable, sellable to both the
   developer ("your employer can't see personal") and the org ("team knowledge compounds").
2. **Workspace-level all-or-nothing sharing.** Rejected: forces the surveillance question at
   install time; kills the individual wedge.
3. **Consent-per-session prompts.** Rejected: friction that kills capture rates; scope+promotion
   achieves consent at the right granularity (the memory, not the session).

## Consequences & migration

- Atom v3 migration sets `scope=personal` on all existing atoms (conservative default).
- Marketing copy constraint: never claim privacy features not yet shipped (the series' original
  sin — plaintext SQLite behind a privacy pitch). The README security section updates in the same
  PR as the code, always.
- Promotion UX is the team-tier conversion moment — instrument it (ADR-010).
