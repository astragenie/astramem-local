/**
 * `astramem-local consolidate <run|proposals|accept|reject>` — operator
 * surface for the ADR-004 stage-9 consolidation pass.
 *
 *   consolidate run [--json]              trigger a pass now (also scheduled
 *                                         at boot + every 6h by the daemon)
 *   consolidate proposals [--json] [--kind merge|contradiction]
 *                         [--limit N] [--offset N] [--min-confidence X]
 *                                         list pending proposals with both
 *                                         texts side by side (#171: was a
 *                                         full-table dump, ignored --limit)
 *   consolidate accept <id> [--json]      accept one proposal — merges loser
 *                                         into winner (supersede, not delete)
 *   consolidate accept --all|--kind K|--min-confidence X [--json]
 *                                         bulk accept every PENDING proposal
 *                                         matching the given filter(s) (#372)
 *   consolidate reject <id> [--json]      reject one proposal
 *   consolidate reject --all|--kind K|--min-confidence X [--json]
 *                                         bulk reject, same filter rules as
 *                                         bulk accept
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

/** `--flag value` extractor — returns the token immediately after `flag`,
 *  or undefined if `flag` isn't present. Mirrors how `--all` etc. are read
 *  below (plain array scan, no dependency pulled in for a handful of CLI
 *  flags). */
function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

/** Builds the `?status=pending&kind=&limit=&offset=&min_confidence=` query
 *  string shared by `proposals` (listing) and the `--all|--kind|--min-
 *  confidence` bulk paths of `accept`/`reject` (#372/#171) — one place that
 *  maps CLI flag names to the GET /consolidation/proposals query params. */
function buildListQuery(rest: string[], status = 'pending'): string {
  const params = new URLSearchParams({ status });
  const kind = getFlagValue(rest, '--kind');
  if (kind) params.set('kind', kind);
  const limit = getFlagValue(rest, '--limit');
  if (limit) params.set('limit', limit);
  const offset = getFlagValue(rest, '--offset');
  if (offset) params.set('offset', offset);
  const minConfidence = getFlagValue(rest, '--min-confidence');
  if (minConfidence) params.set('min_confidence', minConfidence);
  return params.toString();
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
      const { proposals, total } = (await api(`/consolidation/proposals?${buildListQuery(rest)}`)) as
        { proposals: Proposal[]; total?: number };
      if (jsonMode) {
        console.log(JSON.stringify(proposals));
        break;
      }
      if (proposals.length === 0) {
        console.log('No pending consolidation proposals.');
        break;
      }
      const ofTotal = total !== undefined && total !== proposals.length ? ` of ${total} matching` : '';
      console.log(`\n${proposals.length}${ofTotal} pending proposal(s):\n`);
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
      // #372: `--kind`/`--min-confidence` widen `--all` into a filtered bulk
      // accept (e.g. `accept --kind merge --min-confidence 0.9`) rather than
      // requiring the all-or-one choice this command used to offer.
      const bulk = rest.includes('--all') || getFlagValue(rest, '--kind') !== undefined
        || getFlagValue(rest, '--min-confidence') !== undefined;
      let ids: string[];
      if (bulk) {
        const { proposals } = (await api(`/consolidation/proposals?${buildListQuery(rest)}`)) as { proposals: Proposal[] };
        ids = proposals.map(p => p.id);
      } else {
        const id = rest.find(a => !a.startsWith('-'));
        if (!id) {
          console.error('consolidate accept: proposal id required (or --all / --kind / --min-confidence)');
          process.exit(1);
        }
        ids = [id];
      }
      let accepted = 0;
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const id of ids) {
        try {
          // Bulk accepts mark each accept as bulk-resolved so memory_events
          // can distinguish it from a single manual accept — see
          // ProposalRepo.accept's `opts.bulkAccepted` (FEAT-437 residual).
          await api(`/consolidation/proposals/${id}/accept`, {
            method: 'POST',
            body: JSON.stringify(bulk ? { bulk: true } : {}),
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
      // #372: same bulk-filter rules as `accept` above. Single-id mode keeps
      // its pre-existing `{ rejected: <id> }` JSON shape untouched — only
      // the new bulk path gets the count/skipped shape (matching `accept`).
      const bulk = rest.includes('--all') || getFlagValue(rest, '--kind') !== undefined
        || getFlagValue(rest, '--min-confidence') !== undefined;
      if (!bulk) {
        const id = rest.find(a => !a.startsWith('-'));
        if (!id) {
          console.error('consolidate reject: proposal id required (or --all / --kind / --min-confidence)');
          process.exit(1);
        }
        await api(`/consolidation/proposals/${id}/reject`, { method: 'POST' });
        console.log(jsonMode ? JSON.stringify({ rejected: id }) : `Rejected ${id}.`);
        break;
      }
      const { proposals } = (await api(`/consolidation/proposals?${buildListQuery(rest)}`)) as { proposals: Proposal[] };
      let rejected = 0;
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const p of proposals) {
        try {
          await api(`/consolidation/proposals/${p.id}/reject`, { method: 'POST' });
          rejected++;
        } catch (err) {
          skipped.push({ id: p.id, reason: (err as Error).message.split('\n')[0] ?? 'unknown' });
        }
      }
      if (jsonMode) {
        console.log(JSON.stringify({ rejected, skipped }));
      } else {
        console.log(`Rejected ${rejected} proposal(s)${skipped.length ? `, skipped ${skipped.length} (lifecycle conflicts)` : ''}.`);
        for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
      }
      break;
    }

    default:
      console.log(`astramem-local consolidate <subcommand>

Subcommands:
  run                                    Trigger a consolidation pass now
  proposals [--kind K] [--limit N] [--offset N] [--min-confidence X]
                                          List pending proposals (side-by-side texts)
  accept <id>                            Accept one proposal — supersedes loser into winner
  accept --all|--kind K|--min-confidence X
                                          Bulk accept every PENDING proposal matching the filter(s)
  reject <id>                            Reject one proposal
  reject --all|--kind K|--min-confidence X
                                          Bulk reject, same filter rules as bulk accept

The daemon also runs a pass automatically at boot and every 6 hours.`);
      if (sub !== undefined && sub !== '--help' && sub !== '-h') process.exit(1);
  }
}
