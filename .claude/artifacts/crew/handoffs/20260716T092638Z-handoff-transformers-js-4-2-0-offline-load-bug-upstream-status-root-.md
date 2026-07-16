# Task Handoff: transformers.js 4.2.0 offline-load bug: upstream status, root cause confirmation, escape hatches

- Created: 2026-07-16T09:26:38.692Z
- From: researcher
- To: dispatcher
- Objective: Confirmed in code (installed 4.2.0 AND current main branch) that get_tokenizer_files always calls get_file_metadata with empty options, ignoring caller revision/local_files_only; no upstream issue exists for this exact bug, but an open unmerged PR (#1717) reworks the env-threading and would likely fix it; our directory-path workaround is structurally correct and durable.
- Allowed Scope:
  - Read-only web + repo research: verify huggingface/transformers.js 4.2.0 offline/from_pretrained bug against installed node_modules source
  - GitHub issues/PRs
  - main branch source
  - and npm release history. No code changes made.
- Forbidden Scope: -
- Deliverable: Findings doc (below) covering: (1) no existing upstream issue matches this exact defect; (2) bug reproduced verified-in-code on both installed 4.2.0 and live main branch (unfixed); (3) escape-hatch analysis for allowRemoteModels/local_files_only/localModelPath — none reliably prevent the crash for repo-id-based loads; (4) one relevant open PR (#1717, unmerged) that reworks env threading; (5) recommendation to keep directory-path workaround as durable, and draft issue title + minimal repro for whoever files upstream.
- Changed Files:
  - node_modules/@huggingface/transformers/src/utils/model_registry/get_tokenizer_files.js
  - node_modules/@huggingface/transformers/src/utils/model_registry/get_file_metadata.js
  - node_modules/@huggingface/transformers/src/utils/hub.js
  - node_modules/@huggingface/transformers/src/tokenization_utils.js
  - node_modules/@huggingface/transformers/src/env.js
  - node_modules/@huggingface/transformers/src/utils/hub/utils.js
- Confidence: high
- Risks: Could not fetch github.com/huggingface/transformers.js/issues web UI directly (gh CLI search API used instead, which does full-text search but may miss issues using different terminology, e.g. non-English reports or issues without 'bug' label); did not exhaustively read all 258 open issues, only targeted searches; PR #1717's actual fix-completeness for this specific empty-options call site was not verified line-by-line (it is unmerged and large, described from its PR body, not diffed against get_tokenizer_files.js directly).
- Suggested Next Handoff: Hand this doc to whoever can file upstream (user cannot). Optionally: verify PR #1717 diff directly touches get_tokenizer_files.js/get_file_metadata.js before citing it as 'the fix' in the upstream issue body — currently only PR description was read, not the diff.

