# Approved Slices — Untitled Claude Code plugin

Slices listed here may be implemented. Pick the highest-priority non-completed slice each run.

Rules:
- Every approved slice must have acceptance criteria mapping
- Every approved slice must have defined done conditions
- Slice is complete only when all "Done When" criteria are met with evidence (see `../01-loop-control/EVIDENCE_RULES.md`)
- Future slices must go through: `slices/pending/` → Reviewer A + B → here

**State machine**: Pending → Reviewed → Approved → In Progress → Completed / Blocked

---

_No approved slices yet. Add slices below as the product needs grow. When the list
is empty but `product-backlog.md` has unmet requirements, the Cross-Slice
Continuation HARD RULE in `CLAUDE.md` requires the agent to derive the next slice
into `../slices/pending/` first._
