# ADR-006: Cloud Boundary — team ledger + control plane; erasure ruling

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High (Medium on erasure legal fit — validate with counsel before enterprise deals)
**Context:** Strategy verdict: cloud = team ledger amplifying local, NOT a generic memory API.
Enterprise pass (Pass 4) flags the collision between bitemporal never-delete and GDPR erasure as
a design-now decision. RLS is planned but unbuilt.

## Decision

**Cloud scope = exactly two planes, nothing else:**

- **Data plane (the ledger):** Postgres/pgvector, bitemporal (existing FEAT-214 model),
  event-ingest from ADR-003, workspace-scoped recall API, **RLS as the primary isolation
  mechanism** (EF filters demoted to defense-in-depth). No public generic memory API in v1;
  the API surface is: sync ingest, workspace recall, admin.
- **Control plane:** identity (workspaces, orgs, memberships, device tokens), retention policies,
  audit log (access + admin actions — the product that *is* an audit record must itself be
  exemplary here), usage metering (billing later).

**Erasure ruling (the bitemporal-vs-GDPR collision):** dual-path —
1. **Supersession (default):** never-delete, full chain, the product's value proposition.
2. **Legal erasure (the priced exception):** `erase_request` event → hard-delete of atom rows +
   embeddings + FTS entries on cloud AND (propagated) local, replaced by a **tombstone** event
   (`erased`, no content, reason code) so the audit chain shows *that* something was erased
   without retaining *what*. Backups: erasure completes when backup retention (≤30 days) rolls
   over — documented as the erasure SLA. **Crypto-shredding (per-subject keys) is deferred to
   v2** — recorded as accepted risk; becomes mandatory before regulated-vertical deals.

**Deliberately out of scope for cloud v1:** SSO/SAML + SCIM (enterprise wave, post-traction),
billing automation (metering only), marketplace (refused), model-serving of any kind, write-back
sync (ADR-003).

## Options considered

1. **Ledger + control plane only (chosen).** Matches the verdict; every added surface is
   solo-founder maintenance debt (C1).
2. **Full memory SaaS (API-first, self-serve for any app).** Rejected: the 2/10 product (final
   verdict); competes with free platform memory on their terms.
3. **Erasure alternatives:** logical-delete-only (rejected — not legally sufficient for GDPR
   erasure); immediate crypto-shredding v1 (rejected — per-subject key infrastructure is heavy
   against C1/C3; tombstone + hard-delete + backup-rollover covers the beachhead ICP).

## Consequences & migration

- Cloud work order: RLS migration → sync-ingest endpoint (ADR-003) → workspace recall → audit
  log → retention/erasure jobs. Auth for v1 = workspace device tokens (Clerk/SSO deferred).
- Azure stays (operator constraint); get the TEI embedder off the shared CI box before the first
  team pilot (it is the anti-SLA).
- Local must implement the erase-propagation handler (delete + tombstone) — erasure is a
  cross-product contract, not a cloud feature.
