# Backlog

Per-feature markdown files in a four-state directory machine:

| Dir | Meaning |
|---|---|
| `pending/` | Just dropped. No priority / category / target_release yet. Triage will fill these. |
| `triaged/` | Triage complete. Priority + category + target_release assigned. Ready to be slotted into a slice. |
| `in-progress/` | A slice has been derived; engineering work is underway. |
| `done/` | Slice completed and shipped (or about to ship). |

Each feature file follows the pattern `FEAT-NNN.md` (zero-padded id) with YAML
frontmatter and a markdown body. See `feature-template.md` for the canonical
shape.

## Adding a feature

Three ways:

1. `/runner:backlog add "title"` — plugin creates a well-formed file in
   `pending/` with the next available `FEAT-NNN`.
2. Manually create `pending/FEAT-NNN.md` matching the template. Plugin picks it
   up on the next listing.
3. From an external producer (Telegram bot, web form, email parser, etc.) —
   any writer that drops a markdown file in `pending/` works.

## State transitions (plugin commands)

- `/runner:backlog triage` — moves all `pending/*` → `triaged/`,
  filling in priority / category / target_release via heuristic.
- `/runner:backlog promote --id FEAT-NNN` — moves a triaged feature →
  `in-progress/` and creates a linked slice in `.claude/artifacts/loop/ai-loop/slices/pending/`.
- When the slice closes, plugin moves the feature → `done/`.

## Linkage

- Each `FEAT-NNN.md` may have `derived_from: SPEC-NNN` in frontmatter, pointing
  back to the parent spec.
- Each `FEAT-NNN.md` has `slices: [SLICE-NN, ...]` listing the engineering
  slices implementing it.
- Release planner (`/runner:release plan`) filters by
  `target_release`.

## Don't hand-edit during triage

If you set priority/category/target_release manually before triage runs, the
heuristic respects your values. Once triage moves a file to `triaged/`,
edit frontmatter directly to revise.
