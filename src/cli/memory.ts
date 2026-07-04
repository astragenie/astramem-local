/**
 * CLI command: `astramem-local memory restore <id>` (FEAT-416)
 *
 * Thin HTTP client, same pattern as src/cli/search.ts — talks to a running
 * daemon via HTTP (ASTRA_MEMORY_URL / ASTRA_MEMORY_TOKEN).
 *
 * Lives in its own file rather than search.ts because it seeds a `memory
 * <verb> <id>` subcommand group for lifecycle operations. Note there is no
 * prior CLI convention for lifecycle ops to mirror: invalidate/supersede/
 * promote/erase are exposed via REST + MCP only, never CLI (grep confirms).
 * `restore` also can't be a bare top-level command — that name is already
 * the DB-snapshot restore (src/cli/restore.ts, W2.2) — hence `memory restore`.
 */

function getBaseUrl(): string {
  return process.env.ASTRA_MEMORY_URL ?? 'http://127.0.0.1:7777';
}

function getToken(): string {
  return process.env.ASTRA_MEMORY_TOKEN ?? 'devtok';
}

async function postRestore(id: string): Promise<{ status: number; body: unknown }> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/memory/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** `astramem-local memory restore <id>` — un-archive a memory (FEAT-416 AC-4). */
export async function cliMemoryRestore(id: string): Promise<void> {
  if (!id) {
    console.error('memory restore: id argument is required');
    process.exit(1);
  }

  const { status, body } = await postRestore(id);

  if (status === 200) {
    console.log(`Restored: ${id}`);
    return;
  }
  if (status === 404) {
    console.error(`memory restore: no such memory ${id}`);
    process.exit(1);
  }
  if (status === 409) {
    const msg = (body as { error?: string }).error ?? 'memory is not archived';
    console.error(`memory restore: ${msg}`);
    process.exit(1);
  }
  console.error(`memory restore: HTTP ${status}: ${JSON.stringify(body)}`);
  process.exit(1);
}
