/**
 * Fastify route: POST /mcp
 *
 * Implements the MCP Streamable HTTP transport (JSON-RPC 2.0 over HTTP).
 * Each request gets its own stateless transport instance — no session ID.
 * Auth is enforced by the app-level preHandler (Bearer token) before this
 * route handler runs, so we do not repeat auth logic here.
 *
 * Spec: https://modelcontextprotocol.io/specification/2024-11-05/basic/transports
 */

import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { DB } from '../../storage/db.js';
import type { EmbedProvider } from '../../contracts/index.js';
import { type Config, defaultConfig } from '../../config/config.js';
import { buildMcpServer } from '../../mcp/server.js';

export function mcpRoute(db: DB, embed: EmbedProvider, config: Config = defaultConfig()) {
  return async (app: FastifyInstance) => {
    app.post('/mcp', async (req, reply) => {
      // One McpServer + transport per request (stateless mode).
      const mcpServer = buildMcpServer({ db, embed, config });

      const transport = new StreamableHTTPServerTransport({
        // Stateless: no session ID
        sessionIdGenerator: undefined,
      });

      // Connect server to transport.
      await mcpServer.connect(transport);

      // Pass req.body (already parsed by Fastify's default JSON parser) as
      // parsedBody so the SDK does not attempt to re-read the stream.
      // The SDK writes the response directly to reply.raw and ends it.
      await transport.handleRequest(req.raw, reply.raw, req.body);

      // Prevent Fastify from attempting to send a second response.
      reply.hijack();

      // Cleanup transport resources.
      await transport.close();
    });
  };
}
