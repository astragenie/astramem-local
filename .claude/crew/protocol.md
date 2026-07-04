# Crew Agent Protocol

This document captures the shape of the structured communication artifacts agents leave behind
so the next agent or session can resume without rediscovery.

## Run Brief

Created at the start of a substantial run. Captures:

- title, goal, mode
- in-scope and out-of-scope summary
- first bounded work chunk
- whether tests were added or updated as part of this run
- next responsible step

## Handoff

Created whenever ownership changes or a teammate hands work back. Captures:

- objective and owner
- allowed scope and forbidden scope
- deliverable and changed files or evidence
- confidence level and open risks
- suggested next handoff

## Review Result

Created immediately when independent review materially completes. Captures:

- artifact or change reviewed
- standards applied (repo standards, language standards, configured review skills)
- decision: passed, failed, or skipped with a reason
- findings, risks, and required follow-ups
- whether tests were added or updated alongside the change

## Validation Plan And Validation Result

A validation plan describes the scenario, the environment, and the evidence to collect.
A validation result records what actually happened:

- scenario exercised
- evidence gathered (logs, screenshots, telemetry)
- decision: passed, failed, or skipped with a reason
- residual risk and the next responsible step

## Deployment Result

Created when an environment transition produces meaningful evidence. Captures:

- target environment (dev or prod)
- resource or service identity (URL, image, revision)
- decision: passed, failed, or skipped with a reason
- log or telemetry pointer for the change
- post-deploy validation status and the next responsible step

## Final Synthesis

Created at the end of a substantial run. Captures:

- what changed and why
- what was reviewed, validated, and deployed
- residual risk and the next recommended step
- whether tests were added or updated as part of this run

