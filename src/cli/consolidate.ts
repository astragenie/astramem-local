/**
 * `astramem-local consolidate <run|proposals|accept|reject>` — operator
 * surface for the ADR-004 stage-9 consolidation pass.
 *
 *   consolidate run [--json]              trigger a pass now (also scheduled
 *                                         at boot + every 6h by the daemon)
 *   consolidate proposals [--json]        list pending merge proposals with
 *                                         both texts side by side
 *   consolidate accept <id|--all> [--json]  accept proposal(s) — merges loser
 *                                         into winner (supersede, not delete)
 *   consolidate reject <id> [--json]      reject a proposal
 *
 * Talks to the running daemon over HTTP (same env contract as search/recall):
 * ASTRA_MEMORY_URL (default http://127.0.0.1:7777), ASTRA_MEMORY_TOKEN.
 */

function getBaseUrl(): string {
  return process.env.ASTRA_MEMORY_URL ?? 'http://127.0.0.1:7777';
}

function getToken(): string {
  return process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${getToken()}`,
      ...((init?.headers as Record<string, string>) ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

interface Proposal {
  id: string;
  kind: string;
  winner_id: string;
  loser_id: string;
  similarity: number;
  status: string;
}

interface MemoryLite {
  id: string;
  type?: string;
  text?: string;
}

/** Fetch memory text for side-by-side display; tolerate lifecycle races. */
async function memoryText(id: string): Promise<string> {
  try {
    const m = (await api(`/memory/${id}`)) as MemoryLite;
    return m.text ?? '(no text)';
  } catch {
    return '(unavailable — merged or erased since)';
  }
}

export async function consolidateCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const jsonMode = rest.includes('--json') || args.includes('--json');

  switch (sub) {
    case 'run': {
      const summary = await api('/consolidation/run', { method: 'POST', body: '{}' });
      if (jsonMode) {
        console.log(JSON.stringify(summary));
      } else {
        const s = summary as { groupsScanned: number; merged: unknown[]; proposals?: unknown[] };
        console.log(`Consolidation pass: ${s.groupsScanned} group(s) scanned, ${s.merged.length} auto-merged.`);
        console.log("Review borderline pairs: astramem-local consolidate proposals");
      }
      break;
    }

    case 'proposals': {
      const { proposals } = (await api('/consolidation/proposals?status=pending')) as { proposals: Proposal[] };
      if (jsonMode) {
        console.log(JSON.stringify(proposals));
        break;
      }
      if (proposals.length === 0) {
        console.log('No pending consolidation proposals.');
        break;
      }
      console.log(`\n${proposals.length} pending proposal(s):\n`);
      for (const p of proposals) {
        const [winText, loseText] = await Promise.all([memoryText(p.winner_id), memoryText(p.loser_id)]);
        console.log(`  ${p.id}  (similarity ${p.similarity.toFixed(3)})`);
        console.log(`    keep : ${winText.slice(0, 100)}`);
        console.log(`    merge: ${loseText.slice(0, 100)}`);
        console.log('');
      }
      console.log('Accept: astramem-local consolidate accept <id>   (or --all)');
      console.log('Reject: astramem-local consolidate reject <id>');
      break;
    }

    case 'accept': {
      const all = rest.includes('--all');
      let ids: string[];
      if (all) {
        const { proposals } = (await api('/consolidation/proposals?status=pending')) as { proposals: Proposal[] };
        ids = proposals.map(p => p.id);
      } else {
        const id = rest.find(a => !a.startsWith('-'));
        if (!id) {
          console.error('consolidate accept: proposal id required (or --all)');
          process.exit(1);
        }
        ids = [id];
      }
      let accepted = 0;
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const id of ids) {
        try {
          // `all` (--all) marks each accept as bulk-resolved so memory_events
          // can distinguish it from a single manual accept — see
          // ProposalRepo.accept's `opts.bulkAccepted` (FEAT-437 residual).
          await api(`/consolidation/proposals/${id}/accept`, {
            method: 'POST',
            body: JSON.stringify(all ? { bulk: true } : {}),
          });
          accepted++;
        } catch (err) {
          // 409s are expected when an atom was merged/erased since the
          // proposal was written — skip, don't abort the batch.
          skipped.push({ id, reason: (err as Error).message.split('\n')[0] ?? 'unknown' });
        }
      }
      if (jsonMode) {
        console.log(JSON.stringify({ accepted, skipped }));
      } else {
        console.log(`Accepted ${accepted} proposal(s)${skipped.length ? `, skipped ${skipped.length} (lifecycle conflicts)` : ''}.`);
        for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
      }
      break;
    }

    case 'reject': {
      const id = rest.find(a => !a.startsWith('-'));
      if (!id) {
        console.error('consolidate reject: proposal id required');
        process.exit(1);
      }
      await api(`/consolidation/proposals/${id}/reject`, { method: 'POST' });
      console.log(jsonMode ? JSON.stringify({ rejected: id }) : `Rejected ${id}.`);
      break;
    }

    default:
      console.log(`astramem-local consolidate <subcommand>

Subcommands:
  run                       Trigger a consolidation pass now
  proposals                 List pending merge proposals (side-by-side texts)
  accept <id> | --all       Accept proposal(s) — supersedes loser into winner
  reject <id>               Reject a proposal

The daemon also runs a pass automatically at boot and every 6 hours.`);
      if (sub !== undefined && sub !== '--help' && sub !== '-h') process.exit(1);
  }
}
