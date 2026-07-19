# Task Handoff: windowless-daemon slice 6 — scope mismatch, needs builder dispatch

- Created: 2026-07-19T18:56:07.924Z
- From: deployer
- To: dispatcher
- Objective: Declined to implement: this is multi-file src/service feature work (VBS wrapper + task-xml + install-flow + unit tests), which is builder scope, not release-engineer scope.
- Allowed Scope:
  - Was asked to implement windowless win32 scheduled-task launch (shim.ts
  - task-xml.ts/schtasks.ts
  - install-flow.ts
  - watchdog/backup wrappers
  - vitest unit tests) on feat/windowless-daemon in astramem-local.
- Forbidden Scope: -
- Deliverable: No code changes made. Escalation badge + deployment-check artifact recorded explaining the scope mismatch and the exact re-dispatch target.
- Changed Files:
  - none changed
- Confidence: low
- Risks: Slice 6 remains unimplemented. The user explicitly reserved the reinstall + live window-gone verification step for themselves after review — that IS legitimate future release-engineer work, but only once a builder has produced and a reviewer has passed the actual code change.
- Suggested Next Handoff: Dispatch crew:fullstack-dev (or crew:backend-dev) with the original task prompt verbatim as a builder slice on feat/windowless-daemon. After it lands, route to crew:reviewer. Re-engage release-engineer only for the reinstall + live verification step once review passes — do not ask release-engineer to author the shim/task-xml/install-flow code itself.

