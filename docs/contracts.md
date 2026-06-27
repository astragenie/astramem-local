# Frozen contracts (Wave 1 → Wave 2-4 anchor)

Wave 2 parallel tracks build against these. Changes require PR review.

- `src/contracts/llm.ts` — LLMProvider, ChatMsg, ChatOpts, ChatResult, ChatUsage, LLMHealth
- `src/contracts/embed.ts` — EmbedProvider, EmbedHealth
- `src/contracts/vector.ts` — VectorStore, VecFilter, VecHit
- `src/contracts/memory.ts` — Memory, MemoryType
- `src/contracts/job.ts` — Job, JobKind, JobState

Schema is frozen at migration `001-init`. New columns/tables = new migration file.
