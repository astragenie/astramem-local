# The 3-minute demo script

A scripted walkthrough for showing `astramem-local` to someone who has never seen it —
investors, a new hire, a skeptical engineer. Four beats, ~45 seconds each. Every command below
was actually run against the real `astramem-local@0.22.1` build (the version currently published
on npm) while writing this doc — outputs are pasted verbatim, not reconstructed.

Run it from a terminal with Node.js >= 20 and no other setup. The repo is public as of
2026-08-06, so none of this needs an npm token, a GitHub PAT, or org membership — anyone can
follow along on their own machine in real time.

---

## Beat 1 (0:00–0:45) — "Watch it work, no install ceremony"

```bash
npm install -g astramem-local
astramem-local demo
```

`npm install -g` pulls 244 packages and takes about **40 seconds** on a typical connection
(measured: 43s cold, no local cache). Then `demo` itself is near-instant — it boots an
in-memory daemon, seeds 5 example memories through a deterministic mock embed/LLM path (no
Ollama, no API key, nothing written to disk), and runs one real hybrid-search recall against
them. Measured end-to-end from process start to the recall finishing: **~220ms.**

Expected output (real transcript, request-log lines from Fastify's Pino logger elided for
readability — they print alongside this in the actual terminal):

```
astramem-local demo — starting an in-memory daemon (no Ollama required)...
astramem-local serving on 127.0.0.1:53976
daemon up at http://127.0.0.1:53976 (in-memory — nothing persisted to disk)

seeding 5 example memories...
  + [preference] The user prefers dark mode across all UI themes.
  + [fact] This project targets Node 20 with TypeScript strict mode enabled.
  + [decision] Decision: ship the daemon as a local-first service, no cloud dependency required.
  + [lesson] Lesson: always run the embed dimension preflight before accepting traffic.
  + [todo] TODO: write the onboarding wizard so init is a single command.

sample recall: "What does the user prefer for UI theme?"
  1. [0.657] The user prefers dark mode across all UI themes.
  2. [0.545] Decision: ship the daemon as a local-first service, no cloud dependency required.
  3. [0.323] TODO: write the onboarding wizard so init is a single command.

astramem-local demo is running at http://127.0.0.1:53976 — in-memory only, nothing was written to disk.
Press Ctrl+C to stop.

next: astramem-local init   (install a real daemon with persistent storage)
```

**The line to say out loud:** "That recall just ranked five candidate memories by hybrid
search — BM25 plus vector similarity plus importance plus freshness — and put the dark-mode
preference first, with zero network calls after the npm install." Ctrl+C to stop; nothing was
persisted, so there's nothing to clean up.

---

## Beat 2 (0:45–1:45) — "It's not a toy — it's wire-compatible with production"

The demo above ran in an isolated in-memory mode. The real story is that the exact same
protocol this daemon speaks is what the hosted SaaS backend speaks, and the plugin doesn't know
or care which one it's talking to:

```bash
export MEMORY_API_URL=http://127.0.0.1:7777    # was: https://api.astramemory.com
export MEMORY_BEARER=$(astramem-local token print)
```

Restart Claude Code and every plugin hook — `PreCompact`, `SessionEnd`, `SubagentStop` — now
posts to your laptop instead of the cloud. No plugin code changes, no config file edits beyond
the environment. The shared contract lives in one file both sides import:
[`contracts/wire.ts`](../contracts/wire.ts) — the wire version string, the capture-envelope
schema, the same regex the SaaS backend's C# controller enforces byte-for-byte. Both the legacy
plugin envelope (v0.1.x) and the current SaaS-canonical envelope (v0.2.0+) are accepted on
`/ingest/transcript`, so there's no coordinated-upgrade requirement between the plugin and the
daemon.

**The line to say out loud:** "This isn't a local-only side project bolted onto the product —
it's the same wire contract, versioned and tested against the real plugin repo on every PR. Local
and cloud are two backends behind one interface."

---

## Beat 3 (1:45–2:30) — "We measure this like a lab, not a pitch deck"

Point at [`docs/eval-runs/LEDGER.md`](eval-runs/LEDGER.md) — one row per scored evaluation run
against LoCoMo (a published long-context memory benchmark), going back to the first run on
2026-07-13. Two honest numbers anchor it:

| Scale | Metric | Stable / service-day |
|---|---|---|
| conv-1 sample (n=199, 10% of the suite) | overall F1 | **0.5430** |
| full suite (n=1986) | overall F1 | **0.4840** |

**The line to say out loud:** "We don't just publish the best run we ever got — read down that
ledger and you'll find entries marked `REFUTES`, `WASH`, and `day-variance PROVEN` sitting right
next to the wins. A 2026-07-18 run hit 0.6002 and we *kept the replication that knocked it back
down* in the same table instead of quietly dropping it. That's the standard the retrieval
pipeline ships against." This is the credibility beat, not the biggest-number beat — a technical
audience will trust the honesty more than the headline.

---

## Beat 4 (2:30–3:00) — "And it's enforced on every change, not just at release time"

Close on the CI posture, not a slide:

- **`Test`** runs on every push and PR to `main` — the same suite that produced 415 files /
  ~5,700 passing tests when this doc was written.
- **`Cross-Repo Roundtrip`** checks out the real `astramem-plugin` repo on every PR and exercises
  capture → ingest → distill → recall end-to-end, so a daemon change that breaks the plugin's
  actual usage pattern fails CI before merge — not after a customer hits it.
- **`nightly-live`** runs daily at 09:17 UTC against live providers (not mocks), and
  **`install-smoke`** runs weekly to catch a broken npm publish before a user does.

**The line to say out loud:** "Every one of those checks ran automatically before this branch
could merge — including the wire-compat contract you just saw in beat 2." Then stop talking.

---

## If something breaks mid-demo

- **`demo` hangs or shows no output:** confirm Node >= 20 (`node --version`); the mock
  embed/LLM path has no external dependency, so a hang almost always means an old Node or a
  corrupted global npm install — `npm uninstall -g astramem-local && npm install -g
  astramem-local` clears it.
- **Port already in use:** the demo picks an ephemeral port automatically (`53976` above was
  randomly assigned) — a collision is astronomically unlikely, but Ctrl+C any stray daemon from
  a previous run first.
- **Audience asks "does this work offline":** yes — beat 1 has no network calls after the
  initial `npm install`; that's worth demonstrating by disconnecting Wi-Fi before Ctrl+C if the
  room is skeptical.
