/**
 * GET /dashboard/api — API reference page (FEAT-410 follow-up).
 *
 * Swagger-lite, deliberately: a hand-maintained route table with method,
 * path, auth, and a one-line description. GET endpoints are plain links
 * (the dashboard cookie authenticates them, so clicking IS the test);
 * mutating endpoints show a copy-pasteable curl with a $MEMORY_BEARER
 * placeholder. No OpenAPI spec, no JS, no external assets — a full
 * Swagger UI would be overengineering for a single-operator local daemon.
 *
 * Auth + esc() duplicated locally by design (see
 * dashboard-consolidation-html.ts for the rationale).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'astramem_dash';

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Endpoint {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  auth: boolean;
  desc: string;
  /** For GET: querystring appended to the try-link. For POST: example JSON body. */
  example?: string;
}

// Hand-maintained — matches src/server/app.ts registrations. Update when
// routes change (cheap; the alternative is runtime route introspection,
// which buys little for a table this size).
const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/health', auth: false, desc: 'Daemon health: status (starting|ok|degraded), subsystem detail' },
  { method: 'GET', path: '/version', auth: false, desc: 'Daemon version + wire versions + schema version' },
  { method: 'GET', path: '/search', auth: true, desc: 'Hybrid search (FTS+vector fusion). Filters: entity, type, repo, project, agent, since, as_of. project/agent accept a comma list (OR)', example: '?query=sqlite&project=runner-plugin&agent=crew:reviewer' },
  { method: 'GET', path: '/memory/:id', auth: true, desc: 'Fetch one memory by id' },
  { method: 'GET', path: '/memory/:id/history', auth: true, desc: 'Bitemporal version history of a memory' },
  { method: 'GET', path: '/memory/:id/why', auth: true, desc: 'Provenance: why this memory exists (source transcript, extraction)' },
  { method: 'GET', path: '/entities', auth: true, desc: 'List entities' },
  { method: 'GET', path: '/entities/:id/memories', auth: true, desc: 'Memories linked to an entity' },
  { method: 'GET', path: '/sessions/:id/digest', auth: true, desc: 'Session digest' },
  { method: 'GET', path: '/consolidation/proposals', auth: true, desc: 'List consolidation proposals (?status=pending|accepted|rejected)', example: '?status=pending' },
  { method: 'POST', path: '/ingest/transcript', auth: true, desc: 'Ingest a transcript (canonical v1.0 or legacy v0.0 envelope); idempotent via Idempotency-Key header', example: '{"event":"transcript","session_id":"s1","turns":[{"role":"user","text":"hello"}],"wire_version":"v1.0"}' },
  { method: 'POST', path: '/remember', auth: true, desc: 'Store a memory directly. metadata.project / metadata.agent persist on the atom (recallable via filters)', example: '{"text":"Port 7777 is the default","type":"fact","metadata":{"project":"runner-plugin","agent":"crew:reviewer"}}' },
  { method: 'POST', path: '/recall', auth: true, desc: 'Recall memories for a query context. Optional filters: {type[],repo,project,agent,since,as_of,entity}. project/agent are string or string[] (OR). Omit filters = unscoped', example: '{"query":"default port","filters":{"project":"runner-plugin","agent":"crew:reviewer"}}' },
  { method: 'POST', path: '/recall/pack', auth: true, desc: 'Recall as a packed context block', example: '{"query":"default port"}' },
  { method: 'POST', path: '/memory/:id/used', auth: true, desc: 'Mark memory used (usefulness signal feeds ranking epsilon)' },
  { method: 'POST', path: '/memory/:id/promote', auth: true, desc: 'Promote memory importance' },
  { method: 'POST', path: '/memory/:id/invalidate', auth: true, desc: 'Invalidate (soft-close validity interval)' },
  { method: 'POST', path: '/memory/:id/supersede', auth: true, desc: 'Supersede with a corrected memory', example: '{"text":"corrected fact"}' },
  { method: 'POST', path: '/memory/:id/unsupersede', auth: true, desc: 'Reverse a supersede — un-hides the loser (FEAT-442); the merge winner is untouched' },
  { method: 'DELETE', path: '/memory/:id', auth: true, desc: 'Erase a memory' },
  { method: 'POST', path: '/consolidation/run', auth: true, desc: 'Run consolidation pass now (optional merge_threshold, propose_threshold)', example: '{}' },
  { method: 'POST', path: '/consolidation/proposals/:id/accept', auth: true, desc: 'Accept a merge proposal' },
  { method: 'POST', path: '/consolidation/proposals/:id/reject', auth: true, desc: 'Reject a merge proposal' },
  { method: 'POST', path: '/mcp', auth: true, desc: 'MCP endpoint (JSON-RPC)' },
  { method: 'POST', path: '/memory-tool', auth: true, desc: 'Anthropic memory-tool wire endpoint' },
];

function curlFor(e: Endpoint): string {
  const body = e.method === 'POST' && e.example ? ` -H "content-type: application/json" -d '${e.example}'` : '';
  const method = e.method === 'GET' ? '' : ` -X ${e.method}`;
  const auth = e.auth ? ' -H "Authorization: Bearer $MEMORY_BEARER"' : '';
  return `curl${method}${auth}${body} http://127.0.0.1:7777${e.path}`;
}

function renderRow(e: Endpoint): string {
  const isTryableGet = e.method === 'GET' && !e.path.includes(':');
  const pathCell = isTryableGet
    ? `<a href="${esc(e.path + (e.example ?? ''))}">${esc(e.path)}</a>`
    : esc(e.path);
  return `
    <tr>
      <td><span class="m ${e.method.toLowerCase()}">${e.method}</span></td>
      <td>${pathCell}</td>
      <td>${e.auth ? 'Bearer' : 'public'}</td>
      <td>${esc(e.desc)}</td>
    </tr>
    <tr class="curl"><td></td><td colspan="3"><code>${esc(curlFor(e))}</code></td></tr>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:monospace;font-size:13px;line-height:1.5;padding:16px}
h1{font-size:18px;color:#fff;margin-bottom:12px}
nav{display:flex;gap:16px;margin:8px 0 16px;padding-bottom:8px;border-bottom:1px solid #333;font-size:12px}
nav a{color:#888;text-decoration:none}
nav a:hover{color:#3a7bd5}
nav .active{color:#fff;font-weight:bold}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #2a2a2a;padding:4px 8px;text-align:left;vertical-align:top}
th{color:#aaa;text-transform:uppercase;font-size:11px;letter-spacing:.05em}
td a{color:#3a7bd5;text-decoration:none}
.m{font-weight:bold}
.m.get{color:#2ecc71}
.m.post{color:#e6a23c}
.m.delete{color:#e74c3c}
.curl td{border-bottom:1px solid #333;padding-top:0}
.curl code{color:#777;font-size:11px;word-break:break-all}
.note{color:#888;margin-bottom:12px}
`;

function renderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — API</title>
<style>${CSS}</style>
</head>
<body>
<h1>API reference</h1>
<nav><a href="/dashboard">Mission Control</a> <a href="/dashboard/jobs">Jobs</a> <a href="/dashboard/consolidation">Consolidation</a> <a href="/dashboard/search">Search</a> <span class="active">API</span></nav>
<p class="note">GET rows without path params are clickable — your dashboard cookie authenticates them, so clicking is the test. For everything else copy the curl ($MEMORY_BEARER is in %APPDATA%\\Astramem\\secrets.env).</p>
<table>
  <thead><tr><th>method</th><th>path</th><th>auth</th><th>description</th></tr></thead>
  <tbody>${ENDPOINTS.map(renderRow).join('')}</tbody>
</table>
</body>
</html>`;
}

export function dashboardApiRoute(token: string) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/api', async (req, reply) => {
      const authHeader = req.headers.authorization;
      const bearerOk = authHeader === `Bearer ${token}`;
      const cookieOk = readCookie(req, COOKIE_NAME) === token;

      if (!bearerOk && !cookieOk) {
        return reply
          .code(401)
          .header('content-type', 'text/plain; charset=utf-8')
          .send('401 Unauthorized');
      }

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(renderPage());
    });
  };
}
