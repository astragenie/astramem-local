# Claude Code hook — proactive memory pack

Injects the repo's memory pack at session start. The daemon decides what the
agent should already know: decisions, lessons, facts — token-budgeted.

Degrades silently: daemon down → empty output, session never blocked.

## Install (manual, v1)

Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (global):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -m 2 -X POST http://127.0.0.1:7777/recall/pack -H \"Authorization: Bearer $MEMORY_BEARER\" -H \"Content-Type: application/json\" -d \"{\\\"repo\\\": \\\"$(basename \\\"$PWD\\\")\\\"}\" | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const p=JSON.parse(d).pack;if(p)console.log(p)}catch{}})\"",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Notes:
- `MEMORY_BEARER` — the daemon bearer token, exported to your shell by `astramem-local init` (same variable the `.mcp.json` wiring uses).
- 2s curl cap + 3s hook timeout: the hard latency ceiling. Failure = silence.
- Windows: replace the command with the PowerShell equivalent:
  `powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7777/recall/pack -Headers @{Authorization=\"Bearer $env:MEMORY_BEARER\"} -ContentType application/json -Body (@{repo=(Split-Path -Leaf (Get-Location))} | ConvertTo-Json) -TimeoutSec 2; if ($r.pack) { $r.pack } } catch {}"`

## Auto-install

`astramem-local init` now offers to install this hook for you (interactive
prompt after the token/provider setup steps; defaults to declined in non-TTY
runs). It writes into `~/.claude/settings.json`, preserving any existing
content and other hooks. Re-running init is idempotent — it detects an
already-installed astramem hook (by the `/recall/pack` marker in the command
string) and skips re-inserting it. Pass `--no-hook` to `init` to skip the
offer entirely. See `src/cli/hook-install.ts`.
