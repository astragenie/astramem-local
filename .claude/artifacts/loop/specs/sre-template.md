---
id: SPEC-NNN
type: sre
title: SRE constraint / target
status: draft
priority: null
target_release: null
created: YYYY-MM-DD
updated: YYYY-MM-DD
owner: null
derived_features: []
---
# SPEC-NNN: SRE constraint / target

## Scope

Which service(s) or surface(s) this applies to.

## SLO / target

The measurable reliability target. E.g.:

- 99.9% availability over a rolling 30-day window
- p99 latency ≤ 500ms for `/v1/search`
- error rate ≤ 0.1% per 5-minute window

## Error budget policy

How budget consumption affects shipping cadence and on-call posture.

## Required signals

- which metric(s) feed the SLO
- where they're emitted from (OTel attribute names, log fields)
- which dashboard / alert links to keep in sync

## Alert posture

- alerting on burn rate (fast burn / slow burn windows)
- runbook link template

## Out of scope

- bullet 1
