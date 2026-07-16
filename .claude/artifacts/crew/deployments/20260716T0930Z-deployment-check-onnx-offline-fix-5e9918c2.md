# Deployment check — ONNX offline-load fix (release 0.19.0-beta.0+5e9918c2)

- **Date:** 2026-07-16 ~09:30Z
- **Deployer:** Claude (interactive session, user-directed "fix embedder to unblock")
- **Incident:** prod embed down since first restart of 2026-07-16 — `/health` `degraded`, `embed.ok:false`, 12 failed attempts, `onnx: onnx worker failed to load model: Cannot read properties of undefined (reading 'tokenizer_class')` — with a complete, byte-identical 323MB model cache on disk in BOTH retained releases.

## Root cause (two stacked, one environmental trigger)

1. **Library bug:** `@huggingface/transformers` 4.2.0 `loadTokenizer` → `get_tokenizer_files()` HEADs the HF hub on every repo-id `from_pretrained`, passing empty options (ignores pinned revision + `local_files_only`); its cache key derives from `main` while pinned-SHA downloads cache under the SHA path → lookup can never hit → warm cache still requires live hub.
2. **Cache location bug:** library default cache lives inside the release dir's `node_modules` → release rotation (keep-newest-2) silently discards it.
3. **Trigger:** node.exe TLS to huggingface.co hangs after TCP connect on this box (curl 200 to same host; npmjs via node fine) — local TLS filtering of node specifically. Recovered intermittently during the session; daemon must not depend on it either way.

## Fix chain (all MERGED to main)

- **#363** `951d5ebf` — `resolveLocalSnapshotDir()`: complete cached snapshot loaded by DIRECTORY path (bypasses hub entirely); stable cache default `<dataDir>/models/onnx` (ADR-018 S2).
- **#364** `c1245ba7` — stranded KNN-offload review follow-ups (cherry-pick 6b2e1c31 off session/beta-stabilization-waves).
- **#365** `70b53988` — stranded P2.2 soak-test branch.
- **#366** `5e9918c2` — review follow-ups: modelPath exclusivity (incomplete → throw, never fall back), honest throw message, `resolveOnnxCacheDir` extracted + unit-tested.
- Independent review of #363: 0 critical / 3 medium — all 3 addressed in #366.

## Evidence

- `reinstall` output: release `0.19.0-beta.0+5e9918c2` materialized, daemon healthy, pruned `69e34284`.
- `/health` post-deploy: `status: ok`, `embed: { ok: true, attempts: 1, last_error: null }`, worker alive.
- `daemon.live.log`: `onnx: loading model from local snapshot (offline)` with `snapshot_dir: %LOCALAPPDATA%\Astramem\models\onnx\mixedbread-ai\mxbai-embed-large-v1\b33106f...` — **zero-network load path confirmed in prod**.
- Offline proof: directory-path load verified on this box while node→HF was hard-down (tokenizer 146ms, model 1s, 1024-dim).

## Residuals

- Upstream issue against transformers.js (`get_tokenizer_files` ignores `local_files_only`/revision) — not yet filed.
- No fallback embed provider when configured one is down (gap noted in briefing, separate FEAT).
- Box-level: identify what filters node.exe TLS to huggingface.co (firewall/AV) — outside repo.
