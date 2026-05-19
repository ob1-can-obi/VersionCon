// relay/src/server.ts
//
// HTTP + WSS entry point for the VersionCon relay.
//
// Surface:
//   - GET /healthz                → 200 { ok, sessions, uptime_s }
//   - everything else (HTTP)      → 404
//   - WSS upgrade on any path     → goes through verifyClient → connection
//
// Hook seams (filled in by downstream Wave 3 plans):
//   - 07-09 (auth):   verifyClient dynamically imports ./auth.js; pre-07-09 fails
//                     closed when requireAuth=true and auth.js is absent (T-07-16).
//   - 07-10 (limits): maxPayload (1 MiB) wired here; grace timer + idle reaper
//                     plug into SessionRegistry; per-IP rate limit lands in
//                     verifyClient.
//   - 07-11 (logger): every console.* call below carries a TODO(07-11) marker
//                     so the 07-11 find-and-replace pass can swap them for pino.
//
// startServer() is exported so tests, integration suites, and downstream wiring
// can spin the relay up + tear it down without process-level controls.

import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { SessionRegistry } from './SessionRegistry.js';
import { route } from './router.js';
import * as limits from './limits.js';

/**
 * Stubbed structured logger. TODO(07-11): replace with pino + redact config.
 * Logs a JSON line per event; deliberately writes NO request bodies, NO auth
 * headers, NO session secrets (T-07-17 — pre-pino log hygiene maintained
 * structurally by omitting sensitive fields, not by sanitization).
 */
function log(event: string, fields: Record<string, unknown> = {}): void {
  // TODO(07-11): swap console.log for pino with redact config.
  console.log(JSON.stringify({ event, ...fields, ts: Date.now() }));
}

export interface StartServerOptions {
  /** Bind port. `0` requests an ephemeral port (used by tests). Defaults to env PORT or 8080. */
  port?: number;
  /**
   * When true, verifyClient rejects connections unless a real ./auth.js module
   * resolves (T-07-16 — pre-07-09 fail-closed). When false, all upgrades
   * accepted — used by tests pre-07-09.
   * Defaults to true unless `RELAY_REQUIRE_AUTH === 'false'`.
   */
  requireAuth?: boolean;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
  registry: SessionRegistry;
}

const startedAt = Date.now();
// 07-10: reaper runs every minute scanning for sessions whose lastActivity is older than
// limits.getIdleReapInterval() (default 30 min).
const REAPER_TICK_MS = 60_000;

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const requestedPort = opts.port ?? parseInt(process.env.PORT ?? '8080', 10);
  const requireAuth = opts.requireAuth ?? (process.env.RELAY_REQUIRE_AUTH !== 'false');
  const registry = new SessionRegistry();

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        sessions: registry.activeSessionCount(),
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: limits.getMaxPayloadBytes(),
    perMessageDeflate: false,
    verifyClient: (info, cb) => {
      // 07-10 cheaper-check-first invariant: rate limit (synchronous Map lookup)
      // runs BEFORE the async auth path (jose.jwtVerify Promise). Reject events
      // log via the inline `log()` shim so 07-11's find-and-replace pass can
      // swap them to pino with a single grep. T-07-06 mitigation.
      const ip = info.req.socket.remoteAddress ?? 'unknown';
      if (!limits.checkConnection(ip)) {
        // TODO(07-11): swap console.log (in log()) for pino — already structured.
        log('rate-limit', { ip });
        cb(false, 429, 'Too Many Requests');
        return;
      }
      // SEAM for 07-09: once auth.ts is present, this stub delegates to
      // authMod.verifyToken(info.req.headers['authorization']) and stashes
      // verified claims onto info.req for the 'connection' handler.
      //
      // Pre-07-09 stub behavior:
      //   - requireAuth === false (tests):       accept all connections.
      //   - requireAuth === true + auth.js OK:   reject with 503 (auth pending wiring).
      //   - requireAuth === true + no auth.js:   reject with 503 (auth not configured).
      // The conservative "reject when requireAuth=true" stance pins T-07-16:
      // a deploy of this skeleton without 07-09 cannot accept connections.
      if (!requireAuth) {
        cb(true);
        return;
      }
      // Use a then/catch chain rather than an async verifyClient — older ws
      // versions don't await the callback so we drive resolution explicitly.
      // The auth module is resolved through a string-variable so the compiler
      // does not require ./auth.js to exist at build time — 07-09 ships it.
      const authModulePath: string = './auth.js';
      import(authModulePath)
        .then((authMod: unknown) => {
          const verifyTokenFn = (authMod as { verifyToken?: unknown } | null)?.verifyToken;
          if (typeof verifyTokenFn !== 'function') {
            log('auth-not-wired', { remote: info.req.socket.remoteAddress ?? 'unknown' });
            cb(false, 503, 'Relay auth not configured');
            return;
          }
          // Once 07-09 ships verifyToken, this branch will call it and accept.
          // For 07-08 alone we conservatively reject to surface misconfiguration.
          cb(false, 503, 'Relay auth pending (07-09)');
        })
        .catch(() => {
          log('auth-not-wired', { remote: info.req.socket.remoteAddress ?? 'unknown' });
          cb(false, 503, 'Relay auth not configured');
        });
    },
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    log('ws-connected', { remote });

    ws.on('message', (raw) => {
      // Extract sessionId from the envelope WITHOUT inspecting the envelope body.
      // The relay parses the JSON just enough to learn sessionId; router.ts then
      // forwards the ORIGINAL raw buffer verbatim (byte-pass-through invariant).
      let sessionId: string | undefined;
      try {
        const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf-8');
        const obj = JSON.parse(text) as { sessionId?: unknown };
        if (typeof obj.sessionId === 'string') {
          sessionId = obj.sessionId;
        }
      } catch {
        // Malformed JSON — silently drop (T-07-13). 07-10 may add per-IP abuse counters.
        return;
      }
      if (!sessionId) return;

      // Forward the ORIGINAL raw buffer — never a re-serialized object.
      route(registry, sessionId, ws, raw as Buffer);
    });

    ws.on('close', (code, reason) => {
      log('ws-closed', { remote, code, reason: reason.toString().slice(0, 64) });
      // TODO(07-09): once auth stashes sessionId onto req from verified claims,
      // call `registry.detach(sessionId, ws)` here. Pre-07-09, server.ts has no
      // sessionId context per-connection so detach is a no-op (the registry's
      // detach() seam is exercised by Task 2 tests; wiring lands in 07-09).
    });

    ws.on('error', (err) => {
      log('ws-error', { remote, err: err.message });
    });
  });

  // 07-10 idle reaper — sweeps stale sessions every REAPER_TICK_MS. T-07-07
  // (idle resource exhaustion) mitigation. .unref() so the timer never blocks
  // graceful shutdown in tests or under SIGTERM (T-07-17).
  const reaper = setInterval(() => {
    const now = Date.now();
    const cutoff = limits.getIdleReapInterval();
    for (const session of registry.allSessions()) {
      if (now - session.lastActivity > cutoff) {
        // TODO(07-11): swap console.log (in log()) for pino.
        log('idle-reap', { sessionId: session.sessionId });
        registry.closeSession(session.sessionId, 'idle');
      }
    }
  }, REAPER_TICK_MS);
  reaper.unref();

  return new Promise<RunningServer>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, () => {
      const addr = httpServer.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
      log('listen', { port: actualPort });
      resolve({
        port: actualPort,
        registry,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(reaper);
            registry.closeAll('shutdown');
            wss.close(() => {
              httpServer.close(() => res());
            });
          }),
      });
    });
  });
}

// Allow `node dist/server.js` to start the relay directly when run as the main
// module. The import.meta.url check is the ESM equivalent of `require.main === module`.
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  startServer().catch((err) => {
    // TODO(07-11): structured logger.
    console.error(JSON.stringify({ event: 'fatal', err: (err as Error).message }));
    process.exit(1);
  });
}
