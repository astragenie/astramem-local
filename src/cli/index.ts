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
import { cliMemoryRestore } from './memory.js';
import { mcpStdio } from './mcp-stdio.js';

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

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

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
      // astramem-local search "query" [--type TYPE] [--repo REPO] [--project P] [--agent A] [--since 7d] [--as-of DATE] [--entity NAME] [--limit N]
      const query = rest.find(a => !a.startsWith('-')) ?? '';
      await cliSearch(query, {
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo'),
        project: parseArg(rest, '--project'),
        agent: parseArg(rest, '--agent'),
        since: parseArg(rest, '--since'),
        limit: parseArg(rest, '--limit'),
        asOf: parseArg(rest, '--as-of'),
        entity: parseArg(rest, '--entity')
      });
      break;
    }

    case 'recall': {
      // astramem-local recall "question" [--k N] [--type TYPE] [--repo REPO] [--project P] [--agent A] [--as-of DATE] [--entity NAME]
      const question = rest.find(a => !a.startsWith('-')) ?? '';
      await cliRecall(question, {
        k: parseArg(rest, '--k'),
        type: parseArg(rest, '--type'),
        repo: parseArg(rest, '--repo'),
        project: parseArg(rest, '--project'),
        agent: parseArg(rest, '--agent'),
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

    case 'providers': {
      // astramem-local providers [--json]
      await providersCommand(rest);
      break;
    }

    case 'capture': {
      // astramem-local capture codex [--sessions-dir D] [--dry-run] [--json] [--watch [sec]]
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
      const [sub, ...subRest] = rest;
      if (sub === 'restore') {
        const id = subRest.find(a => !a.startsWith('-')) ?? '';
        await cliMemoryRestore(id);
      } else {
        console.error(`memory: unknown subcommand "${sub ?? ''}" (expected: restore <id>)`);
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

    case 'mcp-stdio': {
      // astramem-local mcp-stdio — MCP server over stdio transport (test-enabling
      // infrastructure; the daemon's POST /mcp is the supported production surface)
      await mcpStdio();
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
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
  reinstall [--json]                     Idempotent service repair: stop -> install
                                         (stable shim + task) -> start -> verify
                                         health + version. Run after every upgrade.
  doctor [--json] [--port N]             Run health checks
  search "query" [--type TYPE] [--repo REPO] [--project P] [--agent A]
                 [--since 7d|24h] [--as-of DATE] [--entity NAME] [--limit N]
  recall "question" [--k N] [--type TYPE] [--repo REPO] [--project P] [--agent A] [--as-of DATE] [--entity NAME]
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
  init [--no-hook]                       Interactive setup wizard (--no-hook skips the
                                         SessionStart memory-pack hook offer)
  token rotate                           Issue new local Bearer token
  queue [--json] [--limit N]             Show job-queue state counts + recent failures
  consolidate run|proposals|accept|reject
                                         Near-duplicate memory consolidation (also
                                         auto-scheduled: boot + every 6h)
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
  providers [--json]                     Show configured providers + live health probes
  capture codex [--sessions-dir D] [--dry-run] [--json] [--watch [sec]]
                                         Ingest new Codex CLI sessions (ADR-008);
                                         --watch polls (default 60s)
  pair <claim-code> --url <cloud-url>    Pair with AstraMemory cloud (claim code
                                         from dashboard); enables sync shipper
  sync pull [--json]                     Pull + merge events from the cloud since
                                         the last watermark (ADR-011 conflict
                                         resolve on touched atoms)
  sync watermark [--json]                Show the current persisted pull cursor

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
