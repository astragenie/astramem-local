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
            "command": "curl -s -m 2 -X POST http://127.0.0.1:7777/recall/pack -H \"Authorization: Bearer $ASTRAMEM_TOKEN\" -H \"Content-Type: application/json\" -d \"{\\\"repo\\\": \\\"$(basename \\\"$PWD\\\")\\\"}\" | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const p=JSON.parse(d).pack;if(p)console.log(p)}catch{}})\"",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Notes:
- `ASTRAMEM_TOKEN` — the daemon bearer token from `astramem-local init`.
- 2s curl cap + 3s hook timeout: the hard latency ceiling. Failure = silence.
- Windows: replace the command with the PowerShell equivalent:
  `powershell -NoProfile -Command "try { $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7777/recall/pack -Headers @{Authorization=\"Bearer $env:ASTRAMEM_TOKEN\"} -ContentType application/json -Body (@{repo=(Split-Path -Leaf (Get-Location))} | ConvertTo-Json) -TimeoutSec 2; if ($r.pack) { $r.pack } } catch {}"`

## Roadmap

Auto-install via `astramem-local init` lands with the launch wave (the
`recallPack.enabled` config flag gates the wizard offer).
