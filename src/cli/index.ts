#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from './serve.js';
import { cliSearch, cliRecall, cliRemember, cliEntitiesList, cliEntitiesShow } from './search.js';
import { serviceCommand } from './service.js';
import { doctorCommand } from './doctor.js';
import { budgetCommand } from './budget.js';
import { init } from './init.js';
import { tokenCommand } from './token.js';
import { backupCommand } from './backup.js';
import { queueCommand } from './queue.js';
import { rebuildCommand } from './rebuild.js';
import { retagCommand } from './retag.js';
import { providersCommand } from './providers.js';
import { captureCommand } from './capture.js';
import { pairCommand } from './pair.js';
import { syncCommand } from './sync.js';
import { reinstallCommand } from './reinstall.js';
import { reembedDimCommand } from './reembed-dim.js';
import { entityBackfillCommand } from './entity-backfill.js';
import { entityPurgeJunkCommand } from './entity-purge.js';
import { repoIdentityBackfillCommand } from './repo-identity-backfill.js';
import { backfillTypesCommand } from './backfill-types.js';
import { cliMemoryRestore } from './memory.js';
import { memoryHealthCommand } from './memory-health.js';
import { mcpStdio } from './mcp-stdio.js';
import { mcpInstallCommand } from './mcp-install.js';
import { demoCommand } from './demo.js';
import { proxyCommand } from './proxy.js';
import { ingestAudioCommand } from './audio.js';
import { configCommand } from './config.js';
import { installCliCrashHandlers } from './crash-handlers.js';
import { parseArg } from './arg-parse.js';

const PKG_VERSION: string = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

// The resolved path of the entry module actually executing this process —
// printed alongside PKG_VERSION on `--version` so a shadowed install
// (issue #308: a stale PATH entry resolving to an old binary with no hint
// a newer install exists elsewhere) is visible at a glance instead of
// silently running whichever binary the shell found first.
const ENTRY_PATH: string = fileURLToPath(import.meta.url);

// See crash-handlers.ts for why this is a global-scope call to an imported
// function rather than inline logic here.
installCliCrashHandlers();

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'serve': {
      const port = parseArg(rest, '--port');
      await serve({
        port: port ? Number(port) : undefined,
        strictPreflight: rest.includes('--strict-preflight'),
      });
      break;
    }

    case 'search': {
      // astramem-local search "query" [--type TYPE] [--repo REPO] [--project P] [--agent A] [--agent-mode filter|boost] [--since 7d] [--as-of DATE] [--entity NAME] [--limit N]
      const query = rest.find(a => !a.startsWith('-')) ?? '';
      await cliSearch(query, {
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo'),
        project: parseArg(rest, '--project'),
        agent: parseArg(rest, '--agent'),
        agentMode: parseArg(rest, '--agent-mode'),
        since: parseArg(rest, '--since'),
        limit: parseArg(rest, '--limit'),
        asOf: parseArg(rest, '--as-of'),
        entity: parseArg(rest, '--entity')
      });
      break;
    }

    case 'recall': {
      // astramem-local recall "question" [--k N] [--type TYPE] [--repo REPO] [--project P] [--agent A] [--agent-mode filter|boost] [--as-of DATE] [--entity NAME]
      const question = rest.find(a => !a.startsWith('-')) ?? '';
      await cliRecall(question, {
        k: parseArg(rest, '--k'),
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo'),
        project: parseArg(rest, '--project'),
        agent: parseArg(rest, '--agent'),
        agentMode: parseArg(rest, '--agent-mode'),
        asOf: parseArg(rest, '--as-of'),
        entity: parseArg(rest, '--entity')
      });
      break;
    }

    case 'entities': {
      // astramem-local entities list [query] [--limit N]
      // astramem-local entities show <id>
      const [sub, ...subRest] = rest;
      if (sub === 'show') {
        const id = subRest.find(a => !a.startsWith('-')) ?? '';
        await cliEntitiesShow(id);
      } else {
        // Default to `list` when the sub-command is omitted or explicitly "list".
        const listRest = sub === 'list' ? subRest : rest;
        const query = listRest.find(a => !a.startsWith('-')) ?? '';
        await cliEntitiesList(query, { limit: parseArg(listRest, '--limit') });
      }
      break;
    }

    case 'remember': {
      // astramem-local remember "text" [--type TYPE] [--repo REPO] [--project P] [--agent A]
      const text = rest.find(a => !a.startsWith('-')) ?? '';
      if (!text) {
        console.error('remember: text argument is required');
        process.exit(1);
      }
      await cliRemember(text, {
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo'),
        project: parseArg(rest, '--project'),
        agent: parseArg(rest, '--agent')
      });
      break;
    }

    case 'service': {
      // astramem-local service install|uninstall|start|stop|status [--port N]
      await serviceCommand(rest);
      break;
    }

    case 'doctor': {
      // astramem-local doctor [--json] [--port N]
      await doctorCommand(rest);
      break;
    }

    case 'budget': {
      // astramem-local budget [--reset]
      await budgetCommand(rest);
      break;
    }

    case 'init':
      // astramem-local init [--no-hook]
      await init(rest);
      break;

    case 'token':
      await tokenCommand(rest);
      break;

    case 'backup': {
      // astramem-local backup [--out PATH] [--keep N] [--json]
      await backupCommand(rest);
      break;
    }

    case 'queue': {
      // astramem-local queue [--json] [--limit N]
      // astramem-local queue purge --poison [--json] [--dump-dir PATH]
      await queueCommand(rest);
      break;
    }

    case 'rebuild': {
      // astramem-local rebuild [--repo REPO] [--project PROJECT] [--limit N] [--dry-run] [--json]
      await rebuildCommand(rest);
      break;
    }

    case 'reembed-dim': {
      // astramem-local reembed-dim --dim N [--yes] [--batch-size N] [--json]
      await reembedDimCommand(rest);
      break;
    }

    case 'retag': {
      // astramem-local retag [--dry-run] [--limit N] [--tier2] [--no-tier2] [--confidence N] [--json]
      await retagCommand(rest);
      break;
    }

    case 'entity-backfill': {
      // astramem-local entity-backfill [--dry-run] [--limit N] [--json]
      await entityBackfillCommand(rest);
      break;
    }

    case 'entity-purge-junk': {
      // astramem-local entity-purge-junk [--yes] [--json]
      // Preview is the DEFAULT; --yes is required to delete.
      entityPurgeJunkCommand(rest);
      break;
    }

    case 'repo-identity-backfill': {
      // astramem-local repo-identity-backfill [--yes] [--limit N] [--pattern REGEX] [--json]
      // FEAT-484 (issue #177): re-stamp memories mis-tagged repo='agent-<hash>'
      // (or another ephemeral worktree-basename shape — DEFAULT_BAD_REPO_PATTERN).
      // Preview is the DEFAULT; --yes is required to mutate.
      repoIdentityBackfillCommand(rest);
      break;
    }

    case 'backfill-types': {
      // astramem-local backfill-types [--apply] [--batch-size N] [--limit N] [--reset] [--json]
      // FEAT-552 sub-scope B: retroactive zero-LLM re-typing via the
      // deterministic type-hint rules (src/distill/type-hints.ts).
      // Dry-run (preview) is the DEFAULT; --apply mutates + logs audit events.
      await backfillTypesCommand(rest);
      break;
    }

    case 'providers': {
      // astramem-local providers [--json]
      await providersCommand(rest);
      break;
    }

    case 'capture': {
      // astramem-local capture codex [--sessions-dir D] [--dry-run] [--json] [--watch [sec]]
      // astramem-local capture claude <transcript-path> [--event subagent_stop|session_end] [--json]
      await captureCommand(rest);
      break;
    }

    case 'pair': {
      // astramem-local pair <claim-code> --url <cloud-url>
      await pairCommand(rest);
      break;
    }

    case 'sync': {
      // astramem-local sync pull|watermark [--json]
      await syncCommand(rest);
      break;
    }

    case 'reinstall': {
      // astramem-local reinstall [--json] — idempotent stop→install→start→verify
      await reinstallCommand(rest);
      break;
    }

    case 'restore': {
      // astramem-local restore <snapshot> [--no-restart]
      const { restoreCommand } = await import('./restore.js');
      await restoreCommand(rest);
      break;
    }

    case 'memory': {
      // astramem-local memory restore <id> — un-archive a memory (FEAT-416)
      // astramem-local memory health [--json] [--deep] — per-store health report (FEAT-444)
      const [sub, ...subRest] = rest;
      if (sub === 'restore') {
        const id = subRest.find(a => !a.startsWith('-')) ?? '';
        await cliMemoryRestore(id);
      } else if (sub === 'health') {
        await memoryHealthCommand(subRest);
      } else {
        console.error(`memory: unknown subcommand "${sub ?? ''}" (expected: restore <id> | health)`);
        process.exit(1);
      }
      break;
    }

    case 'consolidate': {
      // astramem-local consolidate run|proposals|accept|reject
      const { consolidateCommand } = await import('./consolidate.js');
      await consolidateCommand(rest);
      break;
    }

    case 'model': {
      // astramem-local model fetch|status [--model L] [--dtype D] [--dest DIR] [--print-urls] [--force]
      // Pre-seed the ONNX embed snapshot cache for offline/air-gapped installs (#363 follow-up).
      const { modelCommand } = await import('./model.js');
      await modelCommand(rest);
      break;
    }

    case 'mcp-stdio': {
      // astramem-local mcp-stdio — MCP server over stdio transport (test-enabling
      // infrastructure; the daemon's POST /mcp is the supported production surface)
      await mcpStdio();
      break;
    }

    case 'mcp': {
      // astramem-local mcp install --client claude|claude-code|cursor|windsurf|vscode [--url URL] [--dry-run]
      const [sub, ...subRest] = rest;
      if (sub === 'install') {
        await mcpInstallCommand(subRest);
      } else {
        console.error(`mcp: unknown subcommand "${sub ?? ''}" (expected: install)`);
        process.exit(1);
      }
      break;
    }

    case 'proxy': {
      // astramem-local proxy serve --port N --upstream <url> [--host H]
      await proxyCommand(rest);
      break;
    }

    case 'ingest-audio': {
      // astramem-local ingest-audio <file> [--session-id ID]
      await ingestAudioCommand(rest);
      break;
    }

    case 'config': {
      // astramem-local config upgrade-model [--yes] [--json]
      await configCommand(rest);
      break;
    }

    case 'demo': {
      // astramem-local demo — 30s zero-dependency trial: in-memory daemon,
      // mock embed/LLM providers (no Ollama), seeded example memories, one
      // sample recall, then keeps serving in the foreground until Ctrl+C
      await demoCommand(rest);
      break;
    }

    case '--version':
    case '-v':
      // Version stays the leading token so existing exact/startsWith
      // consumers (src/service/release.ts's materializeRelease boot-verify)
      // keep working unmodified-in-spirit; the path is appended for human
      // diagnosis of PATH-shadowing installs (issue #308).
      console.log(`${PKG_VERSION} (${ENTRY_PATH})`);
      break;

    case undefined:
    case '--help':
    case '-h':
      console.log(`astramem-local <command>

Commands:
  serve [--port N] [--strict-preflight]  Start daemon (foreground). Default boot is
                                         degraded-start: the port binds immediately and
                                         the embed probe retries in the background
                                         (/health reports starting|ok|degraded);
                                         --strict-preflight restores fail-fast exit 1.
  service install|uninstall|start|stop|status|repair [--port N]
                                         Manage OS service (systemd/launchd/schtasks)
  reinstall [--json]                     Idempotent service repair: materialize release ->
                                         stop -> install (stable shim + task) -> start ->
                                         verify health + version. Run after every upgrade.
                                         Keeps the newest 2 releases (older ones pruned).
  reinstall --rollback [--json]          Repoint at the previous release (no materialize,
                                         no schtasks re-registration). Fails loudly if
                                         there is no older release to roll back to.
  reinstall --dev [--json]               Escape hatch: pin the service at the checkout's
                                         own dist/ (mutable, pre-FEAT-438 behavior) instead
                                         of an immutable release. Prints a loud warning.
                                         Run plain 'reinstall' afterward to re-pin.
  doctor [--json] [--port N]             Run health checks
  search "query" [--type TYPE] [--repo REPO] [--project P] [--agent A] [--agent-mode filter|boost]
                 [--since 7d|24h] [--as-of DATE] [--entity NAME] [--limit N]
  recall "question" [--k N] [--type TYPE] [--repo REPO] [--project P] [--agent A] [--agent-mode filter|boost] [--as-of DATE] [--entity NAME]
                                         --as-of: ISO-8601 date-time — point-in-time
                                         (bitemporal) recall, FEAT-401
                                         --entity: filter to memories linked to
                                         this entity (FEAT-402, exact then
                                         substring match on the normalized name)
                                         --project: filter to memories whose
                                         provenance.project matches (FEAT-423,
                                         exact match; omit = all projects)
                                         --agent: filter to memories whose
                                         provenance agent matches (FEAT-423,
                                         exact match; omit = all agents)
                                         --agent-mode: 'filter' (default) hard-excludes
                                         non-matching agents; 'boost' (FEAT-426) keeps
                                         them but ranks agent-matches higher (requires
                                         search.eta > 0 in config)
  remember "text" [--type TYPE] [--repo REPO] [--project P] [--agent A]
  entities list [query] [--limit N]      Autocomplete known entities (FEAT-402)
  entities show <id>                     List every memory linked to entity <id>
  budget [--reset]                       Show today + month LLM spend vs cap
  backup [--out PATH] [--keep N] [--json] [--no-verify]
                                         Snapshot DB (verified by default); prune old
  restore <snapshot> [--no-restart]      Verified restore: stop daemon, swap DB in
                                         (previous DB kept as .pre-restore.bak),
                                         migrate, restart service
  memory restore <id>                    Un-archive a memory previously archived
                                         by the W4.4 TTL policy (FEAT-416)
  memory health [--json] [--deep]        Per-store health report: totals by
                                         type/scope, staleness distribution,
                                         usefulness coverage, correction rate,
                                         poison-distill session count
                                         (FEAT-444). --deep additionally runs
                                         a bounded near-duplicate estimate +
                                         junk heuristic (CLI-only; never run
                                         by doctor's default pass or /health)
  init [--no-hook]                       Interactive setup wizard (--no-hook skips the
                                         SessionStart memory-pack hook offer)
  token rotate                           Issue new local Bearer token
  queue [--json] [--limit N]             Show job-queue state counts + recent failures
  consolidate run|proposals|accept|reject
                                         Near-duplicate memory consolidation (also
                                         auto-scheduled: boot + every 6h)
  model fetch|status [--model L] [--dtype D] [--dest DIR] [--print-urls] [--force]
                                         Pre-seed / inspect the ONNX embed snapshot
                                         cache so first boot works fully offline
                                         (--print-urls emits a curl recipe for boxes
                                         where node's TLS is filtered or air-gapped)
  rebuild [--repo R] [--project P] [--limit N] [--dry-run] [--json]
                                         Queue reembed jobs for existing memories
                                         (same dim, model/provider swap)
  reembed-dim --dim N [--yes] [--batch-size N] [--json]
                                         Resumable dim-change migration (FEAT-409):
                                         recreates memories_vec at dim N + re-embeds
                                         all memories. Back up first — see
                                         docs/embed-dim-migration.md
  retag [--dry-run] [--limit N] [--tier2|--no-tier2] [--confidence N] [--json]
                                         Backfill repo/project tags on untagged
                                         memories (tier-1 session metadata,
                                         tier-2 opt-in prompt-assisted,
                                         confidence-gated at 0.7 by default)
  entity-backfill [--dry-run] [--limit N] [--json]
                                         Extract + link entities (FEAT-402) for
                                         memories that predate distill-time entity
                                         extraction; never re-distills memory text
  entity-purge-junk [--yes] [--json]     Delete junk entity rows written before the
                                         write-path guard existed (issue #207). Uses the
                                         SAME rule as the guard and the doctor canary.
                                         PREVIEWS by default — --yes to actually delete.
                                         Never deletes a MEMORY, only entity rows.
  repo-identity-backfill [--yes] [--limit N] [--pattern REGEX] [--json]
                                         Re-stamp memories mis-tagged repo='agent-<hash>'
                                         or another ephemeral worktree-basename shape
                                         (FEAT-484, issue #177 — worktree-basename
                                         provenance bug) via git-aware re-resolution.
                                         --pattern overrides the built-in bad-shape
                                         regex for a shape not covered by default.
                                         Never guesses: unresolvable rows are left
                                         untouched. PREVIEWS by default — --yes to apply.
  backfill-types [--apply] [--batch-size N] [--limit N] [--reset] [--json]
                                         Retroactively re-type existing memories via the
                                         deterministic type-hint rules (FEAT-552, zero
                                         LLM calls) — same rules 07-memory-normalize
                                         applies going forward. Resumable (checkpoint
                                         file); never touches text/embeddings/hash.
                                         DRY-RUN by default — --apply to mutate.
  config upgrade-model [--yes] [--json]  Detect a config-pinned Ollama LLM model that is
                                         known-bad or no longer fits local VRAM (issue #279,
                                         see doctor's "Model fit canary") and print the exact
                                         recommended config.yaml edit. PREVIEW by default —
                                         --yes required to actually write config.yaml.
  providers [--json]                     Show configured providers + live health probes
  capture codex [--sessions-dir D] [--dry-run] [--json] [--watch [sec]]
                                         Ingest new Codex CLI sessions (ADR-008);
                                         --watch polls (default 60s)
  capture claude <transcript-path> [--event subagent_stop|session_end] [--json]
                                         Capture a Claude Code transcript's CONTENT
                                         at invocation time into the durable ingest
                                         spool (FEAT-449); daemon drains it async
  pair <claim-code> --url <cloud-url>    Pair with AstraMemory cloud (claim code
                                         from dashboard); enables sync shipper
  sync pull [--json]                     Pull + merge events from the cloud since
                                         the last watermark (ADR-011 conflict
                                         resolve on touched atoms)
  sync watermark [--json]                Show the current persisted pull cursor
  mcp install --client claude|claude-code|cursor|windsurf|vscode
              [--url URL] [--dry-run]    Write (or update) that client's MCP config
                                         to point at this daemon's POST /mcp with a
                                         Bearer token. claude/claude-code/cursor are
                                         written directly (idempotent, backs up the
                                         existing file to .bak first); windsurf/vscode
                                         print manual instructions. --dry-run prints
                                         the would-be file contents only.
  proxy serve --port N --upstream <url> [--host H]
                                         OpenAI-compatible /v1/chat/completions
                                         byte-transparent proxy (FEAT-458 S2,
                                         ADR-013). Loopback-only bind; refuses a
                                         non-loopback --host outright. Zero
                                         capture in this slice — pure passthrough.
  ingest-audio <file> [--session-id ID]  Transcribe a local audio file on-device
                                         (FEAT-489 Slice A) and feed it through
                                         the existing distill pipeline. Requires
                                         audio.mode != 'off' in config.yaml
                                         (default off — ADR-017 third-party
                                         consent gate) and the optional
                                         astramem-audio add-on installed.
  demo                                    30-second zero-dependency trial: in-memory
                                         daemon, mock embed/LLM providers (no Ollama
                                         required), seeds a few example memories, runs
                                         one sample recall, then keeps serving in the
                                         foreground until Ctrl+C. Nothing is persisted.

Environment:
  ASTRA_MEMORY_URL       Daemon base URL (default: http://127.0.0.1:7777)
  ASTRA_MEMORY_TOKEN     Bearer token (default: devtok)
  ASTRA_MEMORY_DATADIR   Data directory (overrides config)`);
      break;

    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
