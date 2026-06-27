# Troubleshooting

Common issues and how to fix them. Run `astra-memory doctor` first — it checks most of these
automatically and prints actionable fix hints.

---

## sqlite-vec binary not loading

**Symptom:**

```
Error: Could not load sqlite-vec extension
Error: SQLITE_ERROR: dlopen() failed: ...libsqlite-vec.so...
```

or on Windows:

```
Error: The specified module could not be found. (...sqlite_vec.dll...)
```

**Cause:** `sqlite-vec` ships native prebuilt binaries that must match your OS, CPU architecture,
and Node ABI version. A mismatch after a `node` upgrade or on an unusual arch (e.g. Linux arm64)
causes the load to fail.

**Fix 1 — Reinstall the package:**

```bash
npm install -g @astragenie/astramemory-local --force
```

This re-downloads the correct prebuilt for the current Node version.

**Fix 2 — Upgrade Node to a supported LTS:**

sqlite-vec prebuilts target Node 20 LTS and Node 22 LTS. If you are running a non-LTS version,
switch:

```bash
nvm install 22 && nvm use 22
npm install -g @astragenie/astramemory-local
```

**Fix 3 — Build from source (Linux arm64, Alpine, musl):**

```bash
npm install -g @astragenie/astramemory-local --build-from-source
```

Requires a C/C++ build toolchain (`build-essential` on Debian/Ubuntu, `base-devel` on Arch).

**Fix 4 — Windows: missing Visual C++ Redistributable:**

Download and install the latest [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).

**Verify:**

```bash
astra-memory doctor
# Expected:  ok  FTS5 + sqlite-vec loaded
```

---

## Ollama unreachable

**Symptom:**

```
astra-memory providers test ollama
  FAIL  LLM (ollama / qwen2.5-coder:7b)  error: connect ECONNREFUSED 127.0.0.1:11434
```

or doctor shows:

```
  FAIL  LLM provider responds < 5s  (ollama not reachable)
```

**Cause:** The Ollama server is not running, or it is bound to a different address.

**Fix 1 — Start Ollama:**

```bash
ollama serve
```

On macOS, Ollama usually runs as a menu-bar app. Click the Ollama icon in the menu bar or
launch it from Applications.

On Linux with systemd:

```bash
systemctl --user start ollama
systemctl --user status ollama
```

**Fix 2 — Check the port:**

```bash
curl http://127.0.0.1:11434/api/tags
```

If this returns a JSON list, Ollama is up. If it fails, try:

```bash
curl http://localhost:11434/api/tags
```

If `localhost` works but `127.0.0.1` does not, Ollama may be bound to IPv6 only. Set in your
Ollama configuration:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

and update `config.yaml`:

```yaml
ollama:
  baseUrl: http://localhost:11434
```

**Fix 3 — Pull the required model if missing:**

```bash
ollama list    # check what is installed
ollama pull qwen2.5-coder:7b
ollama pull nomic-embed-text-v2-moe
```

**Verify:**

```bash
astra-memory providers test ollama
```

---

## Budget exceeded — distillation paused

**Symptom:**

```
astra-memory queue
  5 jobs in state: paused
```

```
astra-memory doctor
  WARN  Budget exceeded ($10.03 of $10.00 today) — distillation paused
```

**Cause:** The daily Azure LLM spend cap was reached. Ingest still works (no data loss). New
transcripts are queued and will distill automatically tomorrow (UTC midnight reset).

**Options:**

1. **Wait for tomorrow.** The cap resets automatically at UTC midnight.

2. **Increase the cap** in `config.yaml`:
   ```yaml
   budget:
     daily_usd: 20
   ```
   Then restart the daemon.

3. **Override now** (logged):
   ```bash
   astra-memory budget --reset
   ```
   This clears today's spend counter. The distillation worker resumes immediately.

4. **Switch to Ollama** to eliminate Azure cost entirely:
   ```yaml
   llm:
     compaction: { provider: ollama, model: qwen2.5-coder:7b }
     extraction: { provider: ollama, model: qwen2.5-coder:7b }
   ```
   Restart the daemon; paused jobs retry automatically.

**Check current spend:**

```bash
astra-memory budget
# Today:  $9.87 / $10.00 (98%)
# Month:  $47.23
```

---

## Service fails to start (or does not persist across reboots)

**Symptom:**

```
astra-memory service status
  STOPPED (service unit not found)
```

Or the daemon starts in foreground but is gone after a reboot.

**Fix 1 — (Re-)install the service:**

```bash
astra-memory service install
astra-memory service status
```

**Fix 2 — Linux (systemd): enable the user service to survive logout:**

```bash
loginctl enable-linger $USER
systemctl --user enable astra-memoryd
systemctl --user start astra-memoryd
systemctl --user status astra-memoryd
```

**Fix 3 — macOS (launchd): load the plist manually:**

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.astragenie.astra-memoryd.plist
launchctl print gui/$UID/com.astragenie.astra-memoryd
```

If the plist is missing, re-run `astra-memory service install`.

**Fix 4 — Windows (Task Scheduler): the task was deleted:**

```powershell
schtasks /query /tn "AstraMemoryD"
# If not found:
astra-memory service install
```

**Fix 5 — Node not found in service PATH:**

The service inherits a minimal PATH. If `node` is installed via `nvm` or similar, the service
may not find it. Fix by setting the full path in the unit:

```bash
# Find the node binary
which node
# /home/user/.nvm/versions/node/v22.0.0/bin/node

# Reinstall, passing the node path
ASTRA_MEMORY_NODE_PATH=$(which node) astra-memory service install
```

**Check logs:**

```bash
# Linux
journalctl --user -u astra-memoryd -n 50

# macOS
cat ~/Library/Logs/astra-memoryd/stderr.log

# Windows
Get-EventLog -LogName Application -Source AstraMemoryD -Newest 20
```

---

## Daemon is running but plugin hooks are not reaching it

**Symptom:** `astra-memory doctor` shows the daemon reachable, but no new jobs appear after
Claude Code sessions.

**Fix 1 — Check MEMORY_API_URL:**

```bash
echo $MEMORY_API_URL
# Expected: http://127.0.0.1:7777
```

If empty or pointing at SaaS, set it in your shell rc and restart Claude Code.

**Fix 2 — Check MEMORY_BEARER:**

```bash
echo $MEMORY_BEARER
# Should be a 64-character hex string
```

If empty, run:

```bash
export MEMORY_BEARER=$(astra-memory token print)
```

Add this to your shell rc and restart Claude Code.

**Fix 3 — Test the endpoint directly:**

```bash
curl -v -X POST http://127.0.0.1:7777/ingest/transcript \
  -H "Authorization: Bearer $(astra-memory token print)" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"debug-1","source":"PreCompact","content":"test"}'
```

Expected: `{"ok":true}`. A `401` means wrong token; a `ECONNREFUSED` means daemon is down.

**Fix 4 — Enable hook debug output:**

```bash
export ASTRAMEMORY_HOOK_DEBUG=1
```

Then trigger a PreCompact. Look for a line like:

```
[astramemory-hook] script=pre-compact-capture ... url=http://127.0.0.1:7777 outcome=ok
```

---

## "Memory provider mismatch" warning from doctor

**Symptom:**

```
  WARN  Embedding mismatch: stored memories use nomic-embed-text-v1, config uses nomic-embed-text-v2-moe
        Distillation blocked until rebuild --reembed completes
```

**Cause:** The embedding model was changed in `config.yaml` but the existing vector index was
built with a different model. Mixing vectors from different models produces meaningless cosine
distances.

**Fix:**

```bash
astra-memory rebuild --reembed
# Runs as background job; watch progress:
astra-memory queue
```

Keyword search (FTS5) and existing memories remain readable during reindex. Vector search is
disabled until completion. Depending on the number of stored memories, reindex may take several
minutes to hours.

---

## High memory or CPU usage

**Symptom:** `node` process using unexpected RAM or CPU.

**Cause:** sqlite-vec ANN search is CPU-bound. Heavy embed batching or large transcript ingests
can spike.

**Fix 1 — Reduce batch size** (not yet configurable in v0.1.0 — file an issue).

**Fix 2 — Monitor the queue:**

```bash
astra-memory queue
```

If there are hundreds of `pending` jobs, the worker is under load. They drain sequentially;
typical throughput is 2-5 distill jobs per minute with Ollama.

**Fix 3 — Increase Ollama GPU offload** to reduce CPU pressure:

```bash
OLLAMA_GPU_LAYERS=35 ollama serve
```

---

## Getting more help

- Run `astra-memory doctor --json` and include the output in any bug report.
- Check the daemon log: see "Check logs" above for your OS.
- File issues at [github.com/astragenie/astramemory-local](https://github.com/astragenie/astramemory-local).
