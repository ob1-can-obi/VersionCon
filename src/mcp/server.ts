// src/mcp/server.ts
//
// Phase 8 — MCP HTTP/SSE bootstrap (Express + StreamableHTTPServerTransport).
//
// Net-new shape (no in-repo analog per PATTERNS.md "No Analog Found").
// Source: RESEARCH §A.2 (canonical SDK example simpleStreamableHttp.ts v1.x)
// adapted with the deviations from PATTERNS.md "src/mcp/server.ts":
//   1. Listen 0 + literal '127.0.0.1' (NEVER 'localhost') — Pitfall 2, N-08-08
//   2. enableDnsRebindingProtection: true + allowedHosts — CVE-2025-66414, N-08-09
//   3. Inject `log` instead of console.* — N-08-04
//   4. Body limit 1 MiB (T-08-03 partial mitigation)
//   5. Stateful sessions keyed by mcp-session-id header (RESEARCH §A.2)
//
// Out of scope here (lands later):
//   - Consent + mcp.json writer (08-05)
//   - Tool/resource registration (08-06/07/08 — they amend buildServer.ts)
//   - extension.ts wiring (08-09)
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// N-08-08 — IPv4 literal. NEVER 'localhost' (Node 17+ resolves to IPv6 '::1'
// when DNS lookup is mixed-family — Pitfall 2). NEVER bind to all-interfaces
// (would expose the server to the LAN).
const BIND_HOST = '127.0.0.1';
const HTTP_PATH = '/mcp';
const BODY_LIMIT = '1mb'; // T-08-03 partial DoS mitigation

export interface McpServerHandle {
  /** Kernel-assigned port (or the explicit port if opts.port > 0). */
  port: number;
  /** Full URL clients use: http://127.0.0.1:<port>/mcp */
  url: string;
  /** Drains active transports + closes the HTTP server. Idempotent-safe. */
  close: () => Promise<void>;
}

export interface StartMcpServerOpts {
  /** Factory called once per new MCP session to construct a fresh McpServer. */
  buildServer: () => McpServer;
  /** Optional log sink. Default: no-op. NEVER use console.* — N-08-04 gate. */
  log?: (line: string) => void;
  /**
   * Bind port. 0 (default) requests an ephemeral kernel-assigned port
   * (RESEARCH §C.1/C.2). `versioncon.mcp.port` setting > 0 overrides via
   * lifecycle.ts.
   */
  port?: number;
}

export async function startMcpServer(
  opts: StartMcpServerOpts,
): Promise<McpServerHandle> {
  const log = opts.log ?? ((): void => {});
  const requestedPort = opts.port ?? 0;

  // Per-session transports map (keyed by mcp-session-id header). Sessions
  // are created on initialize POST; subsequent GET/DELETE/POST find their
  // transport here. Cleaned up on transport.onclose.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const app = express();
  app.use(express.json({ limit: BODY_LIMIT }));

  // Bind FIRST so we can compute the port-bearing allowedHosts entries
  // before constructing any transport. allowedHosts must contain the literal
  // `127.0.0.1:<port>` and `localhost:<port>` strings the SDK compares
  // against the incoming Host header.
  const httpServer: http.Server = await new Promise<http.Server>(
    (resolve, reject) => {
      const s = app.listen(requestedPort, BIND_HOST, () => resolve(s));
      s.once('error', reject);
    },
  );
  const addr = httpServer.address() as AddressInfo | string | null;
  if (!addr || typeof addr === 'string') {
    httpServer.close();
    throw new Error('MCP HTTP server failed to bind (no AddressInfo)');
  }
  const port = addr.port;
  const url = `http://${BIND_HOST}:${port}${HTTP_PATH}`;

  // POST handler — new sessions go through the isInitializeRequest path.
  const postHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: (): string => randomUUID(),
        // N-08-09 — CVE-2025-66414 mitigation. REQUIRED for localhost HTTP
        // servers. Without this a malicious website can DNS-rebind a domain
        // it controls to 127.0.0.1 and POST to our server from the browser.
        enableDnsRebindingProtection: true,
        allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
        onsessioninitialized: (sid: string): void => {
          transports[sid] = transport;
          log(`[mcp] session opened sid=${sid.slice(0, 8)}...`);
        },
      });
      transport.onclose = (): void => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
          log(`[mcp] session closed sid=${sid.slice(0, 8)}...`);
        }
      };
      const server = opts.buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID' },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  };

  app.post(HTTP_PATH, postHandler);
  app.get(HTTP_PATH, async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !transports[sid]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sid].handleRequest(req, res);
  });
  app.delete(HTTP_PATH, async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !transports[sid]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sid].handleRequest(req, res);
  });

  log(`[mcp] listening on ${url}`);

  const handle: McpServerHandle = {
    port,
    url,
    close: async (): Promise<void> => {
      for (const sid of Object.keys(transports)) {
        try {
          await transports[sid].close();
        } catch (err) {
          log(
            `[mcp] close transport ${sid.slice(0, 8)} failed: ${String(
              (err as Error)?.message ?? err,
            )}`,
          );
        }
        delete transports[sid];
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      log(`[mcp] stopped (port was ${port})`);
    },
  };
  return handle;
}
