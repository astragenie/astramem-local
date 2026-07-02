/**
 * Anthropic memory-tool backend adapter (ADR-007 Wave 4a, migration-map 4a).
 *
 * Anthropic's client-side memory tool (docs.claude.com memory-tool) expects
 * the HARNESS to execute file-like commands (view/create/str_replace/insert/
 * delete/rename) against a virtual `/memories` filesystem. This module maps
 * those commands onto astramem memories so any Claude app using the memory
 * tool can be backed by the daemon — see docs/memory-tool-adapter.md for the
 * full command-mapping table and limitations.
 *
 * Virtual filesystem shape:
 *   /memories                    -> directory listing of "<type>.md" files
 *   /memories/<type>.md          -> markdown bullet list of current valid
 *                                    memories of that type, one line per
 *                                    memory: "- [<id>] <text>"
 *   /memories/<type>.md/<id>     -> addresses a single memory (delete only)
 *
 * `<type>` must be one of the MemoryType enum values (decision, fact,
 * lesson, command, todo, note, event). For create/insert, an unrecognized
 * type slug in the path falls back to 'note' rather than erroring — the
 * model may invent filenames the harness has never seen before.
 *
 * Design rulings (binding, see dispatch prompt for Wave 4a):
 *   - create/insert: file_text/insert_text becomes ONE memory's text (no
 *     bullet parsing — parsing markdown bullets back into memories is lossy
 *     and was explicitly rejected). Redacted via redactIfEnabled, inserted
 *     via MemoryRepo.insertWithCreateEvent (mirrors POST /remember), but
 *     WITHOUT embedding metadata — embedding is not required synchronously,
 *     the memory is FTS-searchable immediately and vec-indexed on reembed.
 *   - str_replace: finds the single valid memory of that type whose text
 *     contains old_str, then supersedes it (insert new + MemoryEventRepo
 *     .supersede) rather than mutating the row in place — every memory
 *     write goes through the ADR-002 event log.
 *   - delete: whole-file (`/memories/<type>.md`) erases every current
 *     memory of that type; per-id (`/memories/<type>.md/<id>`) erases just
 *     that one. Both use MemoryEventRepo.erase (hard delete + tombstone
 *     event, ADR-006 W5) — never a soft invalidate.
 *   - rename: NOT supported v1 (a "rename" would mean changing an atom's
 *     type, which isn't modeled) — always returns an error result.
 *   - Unknown paths/commands never throw; they return { error }.
 */

import { createHash } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { MemoryType } from '../contracts/index.js';
import { MemoryRepo } from '../storage/memories.js';
import { MemoryEventRepo, MemoryNotFoundError, MemoryConflictError } from '../storage/memory-events.js';
import { redactIfEnabled } from '../redact/index.js';
import { recordRedactionEvents } from '../storage/redaction-log.js';

const MEMORY_TYPES: readonly MemoryType[] = ['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event'];

function isMemoryType(x: string): x is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(x);
}

export type MemoryToolCommandName = 'view' | 'create' | 'str_replace' | 'insert' | 'delete' | 'rename';

/**
 * Loose input shape — mirrors the fields Anthropic's memory tool sends per
 * command (see docs/memory-tool-adapter.md § command mapping). Fields not
 * relevant to a given command are simply ignored.
 */
export interface MemoryToolCommand {
  command: MemoryToolCommandName | string;
  path: string;
  view_range?: [number, number];
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  old_path?: string;
  new_path?: string;
}

export type MemoryToolResult = { content: string } | { error: string };

interface ValidMemoryRow {
  id: string;
  type: string;
  text: string;
  created_at: number;
}

type ParsedPath =
  | { kind: 'root' }
  | { kind: 'type-file'; typeSlug: string }
  | { kind: 'type-file-item'; typeSlug: string; itemId: string };

/** Parses a virtual path under /memories. Returns null for anything outside that tree. */
function parseMemoriesPath(path: string): ParsedPath | null {
  if (path === '/memories' || path === '/memories/') return { kind: 'root' };
  const m = /^\/memories\/([^/]+)\.md(?:\/(.+))?$/.exec(path);
  if (!m || !m[1]) return null;
  return m[2] ? { kind: 'type-file-item', typeSlug: m[1], itemId: m[2] } : { kind: 'type-file', typeSlug: m[1] };
}

function listValidMemoriesByType(db: DB, type: MemoryType): ValidMemoryRow[] {
  return db
    .prepare(`SELECT id, type, text, created_at FROM memories WHERE type = ? AND valid_to IS NULL ORDER BY created_at ASC`)
    .all(type) as ValidMemoryRow[];
}

function listTypesWithValidMemories(db: DB): string[] {
  const rows = db.prepare(`SELECT DISTINCT type FROM memories WHERE valid_to IS NULL ORDER BY type ASC`).all() as {
    type: string;
  }[];
  return rows.map(r => r.type);
}

function renderTypeFile(rows: ValidMemoryRow[]): string {
  return rows.map(r => `- [${r.id}] ${r.text}`).join('\n');
}

/** Applies text-editor-style view_range (1-indexed, inclusive; end === -1 means to EOF). */
function applyViewRange(content: string, range: [number, number] | undefined): MemoryToolResult {
  if (!range) return { content };
  const lines = content.split('\n');
  const [start, endRaw] = range;
  const end = endRaw === -1 ? lines.length : endRaw;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > lines.length || end < start) {
    return { error: `invalid view_range: [${start}, ${endRaw}] for a ${lines.length}-line file` };
  }
  return { content: lines.slice(start - 1, end).join('\n') };
}

function handleView(db: DB, cmd: MemoryToolCommand): MemoryToolResult {
  const parsed = parseMemoriesPath(cmd.path);
  if (!parsed) return { error: `no such file: ${cmd.path}` };

  if (parsed.kind === 'root') {
    const listing = listTypesWithValidMemories(db)
      .map(t => `${t}.md`)
      .join('\n');
    return applyViewRange(listing, cmd.view_range);
  }

  if (parsed.kind === 'type-file') {
    if (!isMemoryType(parsed.typeSlug)) return { error: `no such file: ${cmd.path}` };
    const rows = listValidMemoriesByType(db, parsed.typeSlug);
    return applyViewRange(renderTypeFile(rows), cmd.view_range);
  }

  // type-file-item: viewing a single memory by id is not part of the v1
  // contract (view is documented only for the root and whole type files).
  return { error: `view does not support a single memory id — view /memories/${parsed.typeSlug}.md instead` };
}

function handleCreateOrInsert(db: DB, config: Config, cmd: MemoryToolCommand): MemoryToolResult {
  const parsed = parseMemoriesPath(cmd.path);
  if (!parsed || parsed.kind !== 'type-file') {
    return { error: `invalid path for ${cmd.command}: ${cmd.path}` };
  }

  const rawText = cmd.command === 'create' ? cmd.file_text : cmd.insert_text;
  if (typeof rawText !== 'string' || rawText.length === 0) {
    const field = cmd.command === 'create' ? 'file_text' : 'insert_text';
    return { error: `missing ${field} for ${cmd.command}` };
  }

  const type: MemoryType = isMemoryType(parsed.typeSlug) ? parsed.typeSlug : 'note';

  // Same choke point as POST /remember (SEC-3/5): redact before persistence.
  const { text, events: redactionEvents } = redactIfEnabled(rawText, config);
  recordRedactionEvents(db, redactionEvents, null);

  const hash = createHash('sha256').update(text).digest('hex').slice(0, 32);
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  const { id } = repo.insertWithCreateEvent(
    {
      type,
      text,
      normalized_text: text.toLowerCase(),
      repo: null,
      project: null,
      branch: null,
      agent: null,
      session_id: null,
      hash,
      source_hash: null,
      importance: 0.5,
      confidence: 0.5,
      // Deliberately no embedding metadata (KF-B/Wave-4a ruling): FTS-searchable
      // immediately; vec index catches up on reembed rather than blocking here.
      embedding_provider: null,
      embedding_model: null,
      embedding_dim: null,
    },
    events,
  );

  return { content: `created memory ${id} in ${type}.md` };
}

function handleStrReplace(db: DB, config: Config, cmd: MemoryToolCommand): MemoryToolResult {
  const parsed = parseMemoriesPath(cmd.path);
  if (!parsed || parsed.kind !== 'type-file') {
    return { error: `invalid path for str_replace: ${cmd.path}` };
  }
  if (!isMemoryType(parsed.typeSlug)) return { error: `no such file: ${cmd.path}` };
  if (typeof cmd.old_str !== 'string' || cmd.old_str.length === 0) return { error: 'missing old_str' };
  if (typeof cmd.new_str !== 'string') return { error: 'missing new_str' };

  const type = parsed.typeSlug;
  const rows = listValidMemoriesByType(db, type);
  const matches = rows.filter(r => r.text.includes(cmd.old_str as string));
  if (matches.length === 0) return { error: `old_str not found in ${cmd.path}` };
  if (matches.length > 1) {
    return { error: `old_str matches ${matches.length} memories in ${cmd.path} — must match exactly one` };
  }

  const old = matches[0] as ValidMemoryRow;
  const occurrences = old.text.split(cmd.old_str as string).length - 1;
  if (occurrences !== 1) {
    return { error: `old_str must occur exactly once within the matched memory (found ${occurrences})` };
  }
  const replacedText = old.text.replace(cmd.old_str as string, cmd.new_str as string);

  const { text, events: redactionEvents } = redactIfEnabled(replacedText, config);
  recordRedactionEvents(db, redactionEvents, null);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 32);

  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);
  const { id: newId } = repo.insertWithCreateEvent(
    {
      type,
      text,
      normalized_text: text.toLowerCase(),
      repo: null,
      project: null,
      branch: null,
      agent: null,
      session_id: null,
      hash,
      source_hash: null,
      importance: 0.5,
      confidence: 0.5,
      embedding_provider: null,
      embedding_model: null,
      embedding_dim: null,
    },
    events,
  );

  if (newId !== old.id) {
    try {
      events.supersede(old.id, newId);
    } catch (err) {
      if (err instanceof MemoryNotFoundError || err instanceof MemoryConflictError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  return { content: `superseded memory ${old.id} with ${newId} in ${type}.md` };
}

function handleDelete(db: DB, cmd: MemoryToolCommand): MemoryToolResult {
  const parsed = parseMemoriesPath(cmd.path);
  if (!parsed) return { error: `no such file: ${cmd.path}` };
  const events = new MemoryEventRepo(db);

  if (parsed.kind === 'type-file-item') {
    if (!isMemoryType(parsed.typeSlug)) return { error: `no such file: ${cmd.path}` };
    const memory = new MemoryRepo(db).get(parsed.itemId);
    if (!memory || memory.type !== parsed.typeSlug || memory.valid_to !== null) {
      return { error: `no such memory: ${cmd.path}` };
    }
    try {
      events.erase(parsed.itemId);
    } catch (err) {
      if (err instanceof MemoryNotFoundError) return { error: err.message };
      throw err;
    }
    return { content: `erased memory ${parsed.itemId}` };
  }

  if (parsed.kind === 'type-file') {
    if (!isMemoryType(parsed.typeSlug)) return { error: `no such file: ${cmd.path}` };
    const rows = listValidMemoriesByType(db, parsed.typeSlug);
    for (const row of rows) {
      events.erase(row.id);
    }
    return { content: `erased ${rows.length} memories from ${parsed.typeSlug}.md` };
  }

  return { error: `cannot delete: ${cmd.path}` };
}

function handleRename(): MemoryToolResult {
  return {
    error:
      'rename is not supported by the memory-tool adapter (v1) — a rename would mean changing a memory\'s type, ' +
      'which is not modeled; delete and re-create under the new type instead',
  };
}

/**
 * Maps one Anthropic memory-tool command onto astramem memories. Never
 * throws — every failure path (bad path, unknown command, storage error)
 * comes back as { error } so the caller can relay it straight into a
 * tool_result without its own try/catch.
 */
export function handleMemoryToolCommand(db: DB, config: Config, cmd: MemoryToolCommand): MemoryToolResult {
  try {
    switch (cmd.command) {
      case 'view':
        return handleView(db, cmd);
      case 'create':
      case 'insert':
        return handleCreateOrInsert(db, config, cmd);
      case 'str_replace':
        return handleStrReplace(db, config, cmd);
      case 'delete':
        return handleDelete(db, cmd);
      case 'rename':
        return handleRename();
      default:
        return { error: `unknown command: ${String(cmd.command)}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
