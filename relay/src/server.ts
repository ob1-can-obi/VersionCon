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
//   - 07-11 (logger): all console.* calls migrated to pino via ./logger.js;
//                     redact config strips bearer/payload/code/secret keys at
//                     the library boundary (T-07-03 + T-07-04 + T-07-05-aux).
//
// startServer() is exported so tests, integration suites, and downstream wiring
// can spin the relay up + tear it down without process-level controls.

import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeJwt, jwtVerify } from 'jose';
import { SessionRegistry } from './SessionRegistry.js';
import { route } from './router.js';
import * as limits from './limits.js';
import { logger } from './logger.js';
import { verifyToken } from './auth.js';

// Review Phase 7 VERIFICATION BLOCKER 1 — host bootstrap chicken-and-egg.
//
// `verifyToken` (07-09) requires `registry.getSession(aud)` to succeed. But
// the very first host connection establishes that session — there is no
// session for `verifyToken` to look up. Resolving the chicken-and-egg:
//
//   verifyClient decodes the JWT WITHOUT signature verification to extract
//   role + aud + sub. For host-role on a NEW session, accept the connection
//   with "pending" claims; the first-frame carve-out then verifies the JWT
//   signature against the session-register payload's verifySecret BEFORE
//   calling registry.register(). For member-role OR host-re-register
//   (session already exists), full `verifyToken` runs at verifyClient time.
//
// The unverified decode is safe to accept because:
//   - shape-check (SESSION_ID_SHAPE + role in {host,member}) keeps log
//     injection and crazy values out
//   - the only state the unverified claims grant is "open WSS socket"; no
//     registry writes happen until first-frame
//   - first-frame carve-out runs jose.jwtVerify with `algorithms:['HS256']`
//     and the freshly-extracted verifySecret BEFORE registry.register, so a
//     forged JWT cannot register a session
const SESSION_ID_SHAPE = /^vc-[a-z0-9-]{1,64}$/;
type PendingHostBootstrapClaims = {
  role: 'host';
  aud: string;
  sub: string;
  _pendingHostBootstrap: true;
  _rawJwt: string;
};
type VerifiedClaims = { role: 'host' | 'member'; aud: string; sub: string };
type AnyClaims = VerifiedClaims | PendingHostBootstrapClaims;

export interface StartServerOptions {
  /** Bind port. `0` requests an ephemeral port (used by tests). Defaults to env PORT or 8080. */
  port?: number;
  /**
   * When true, verifyClient rejects connections unless a real ./auth.js module
   * resolves (T-07-16 — pre-07-09 fail-closed). When false, all upgrades
   * accepted — used by tests pre-07-09.
   *
   * Phase 7 Plan 07-05b — TEST-ONLY value `'test'`: verifyClient reads
   * synthetic JWT claims from `x-test-role`, `x-test-aud`, `x-test-sub`
   * request headers and stashes them on `info.req.claims`. This mode is
   * used by `relay/test/hostRegister.test.js` to exercise the first-frame
   * session-register carve-out without needing a real JWT signing path.
   * Production callers MUST set `requireAuth: true` (or omit to use the
   * default).
   *
   * Defaults to true unless `RELAY_REQUIRE_AUTH === 'false'`.
   */
  requireAuth?: boolean | 'test';
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
  // Review HI-06: eager production guard for the `requireAuth: 'test'` seam.
  // The branch reads synthetic JWT claims from request headers and bypasses
  // the verifyToken path entirely — it must NEVER be reachable in production.
  // Throwing here (before bind) fails the deploy loudly rather than silently
  // accepting test-mode in a prod container.
  if (requireAuth === 'test' && process.env.NODE_ENV === 'production') {
    throw new Error(
      "startServer: requireAuth='test' is forbidden when NODE_ENV='production'",
    );
  }
  const registry = new SessionRegistry();

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        sessions: registry.activeSessionCount(),
        uptime_s: Math.floor((Date.now() - startedAt) / 1000),
      });
      // Bug #3 fix (UAT-3b discovery): VS Code webviews enforce CORS on fetch().
      // Without Access-Control-Allow-Origin the wizard's Test Connection probe
      // (src/ui/webview/wizard/wizard.js — fetch '<relay>/healthz') succeeds at
      // the network layer but the browser blocks JS from reading the response,
      // surfacing as a generic 'Cannot reach relay' error. '*' is correct here
      // because /healthz is a read-only liveness/session-count probe with no
      // authentication, no cookies, and no sensitive data — and the wizard
      // must work for any user-supplied relay origin (Fly, AWS, Hetzner, DO).
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      });
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
        // 07-10 emits {event:'rate-limit', ip} — preserved verbatim through the
        // 07-11 logger swap. The redact config has no path matching `ip`, so
        // the source IP remains visible (operational signal).
        logger.warn({ event: 'rate-limit', ip });
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
      if (requireAuth === false) {
        cb(true);
        return;
      }
      // Phase 7 Plan 07-05b — test-only seam. `requireAuth: 'test'` reads
      // synthetic JWT claims from x-test-* headers and stashes them on
      // info.req so the connection handler's first-frame carve-out can run
      // without a real JWT verify path. Tests use this to exercise the
      // session-register branches in isolation.
      //
      // Review HI-06 hardening: test-mode is fenced behind NODE_ENV !== 'production'.
      // At process load time we asserted that `requireAuth: 'test'` is not
      // reachable when NODE_ENV === 'production' (see assertion above
      // `wss = new WebSocketServer`). If somehow this branch is reached in
      // production despite that gate, we close fail-safe (401) and log.
      if (requireAuth === 'test') {
        if (process.env.NODE_ENV === 'production') {
          logger.error({ event: 'test-mode-blocked-in-production', ip });
          cb(false, 401, 'test-mode-blocked-in-production');
          return;
        }
        const headers = info.req.headers;
        const role = headers['x-test-role'];
        const aud = headers['x-test-aud'];
        const sub = headers['x-test-sub'];
        if (
          (role === 'host' || role === 'member') &&
          typeof aud === 'string' &&
          typeof sub === 'string'
        ) {
          (info.req as unknown as { claims: { role: string; aud: string; sub: string } })
            .claims = { role, aud, sub };
          cb(true);
          return;
        }
        cb(false, 401, 'missing-test-claims');
        return;
      }
      // Phase 7 VERIFICATION BLOCKER 1 hotfix — production auth gate.
      //
      // Decode the bearer token without verifying its signature to extract
      // role + aud + sub. The decode is a SHAPE check only; the real trust
      // boundary is either (a) jwtVerify in `verifyToken` (member, or host
      // re-register), or (b) jwtVerify in the first-frame carve-out
      // (host bootstrap — see ws.on('message') below).
      const authHeader = info.req.headers.authorization;
      if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
        logger.warn({ event: 'auth-fail', reason: 'missing-bearer', ip });
        cb(false, 401, 'unauthorized');
        return;
      }
      const rawJwt = authHeader.slice('Bearer '.length).trim();
      if (rawJwt.length === 0) {
        logger.warn({ event: 'auth-fail', reason: 'empty-bearer', ip });
        cb(false, 401, 'unauthorized');
        return;
      }
      let unverifiedRole: 'host' | 'member';
      let unverifiedAud: string;
      let unverifiedSub: string;
      try {
        const decoded = decodeJwt(rawJwt);
        if (decoded.role !== 'host' && decoded.role !== 'member') {
          logger.warn({ event: 'auth-fail', reason: 'bad-role-shape', ip });
          cb(false, 401, 'unauthorized');
          return;
        }
        if (typeof decoded.aud !== 'string' || !SESSION_ID_SHAPE.test(decoded.aud)) {
          logger.warn({ event: 'auth-fail', reason: 'bad-aud-shape', ip });
          cb(false, 401, 'unauthorized');
          return;
        }
        if (typeof decoded.sub !== 'string' || decoded.sub.length === 0) {
          logger.warn({ event: 'auth-fail', reason: 'bad-sub-shape', ip });
          cb(false, 401, 'unauthorized');
          return;
        }
        unverifiedRole = decoded.role;
        unverifiedAud = decoded.aud;
        unverifiedSub = decoded.sub;
      } catch {
        logger.warn({ event: 'auth-fail', reason: 'malformed-jwt', ip });
        cb(false, 401, 'unauthorized');
        return;
      }

      // Host bootstrap path: session does not yet exist. Accept the
      // connection with PENDING claims; first-frame carve-out re-verifies
      // the JWT signature against the verifySecret from the session-register
      // payload BEFORE calling registry.register. This is the only path
      // that bypasses verifyToken — it is fenced by:
      //   (a) role must literally === 'host' (from decoded JWT claim, NOT
      //       from connection order — T-07-09 preserved);
      //   (b) no session may exist for the unverified aud (otherwise this
      //       is a host re-register attempt; fall through to verifyToken);
      //   (c) the first-frame handler MUST jwtVerify before registry write.
      const existingSession = registry.getSession(unverifiedAud);
      if (unverifiedRole === 'host' && !existingSession) {
        const pending: PendingHostBootstrapClaims = {
          role: 'host',
          aud: unverifiedAud,
          sub: unverifiedSub,
          _pendingHostBootstrap: true,
          _rawJwt: rawJwt,
        };
        (info.req as unknown as { claims: AnyClaims }).claims = pending;
        cb(true);
        return;
      }

      // Member path OR host re-register: session exists, verifyToken can
      // perform full signature + algorithm + audience + exp validation.
      verifyToken(info.req, registry)
        .then((tokenInfo) => {
          if (tokenInfo === null) {
            // verifyToken already logged the specific reason inside auth.ts.
            cb(false, 401, 'unauthorized');
            return;
          }
          const verified: VerifiedClaims = {
            role: tokenInfo.role,
            aud: tokenInfo.sessionId,
            sub: tokenInfo.memberId,
          };
          (info.req as unknown as { claims: AnyClaims }).claims = verified;
          cb(true);
        })
        .catch((err) => {
          // verifyToken is documented to never throw. Defense-in-depth:
          // close fail-safe if jose's internals surprise us.
          logger.error({ event: 'auth-internal-error', ip, errType: (err as Error).name });
          cb(false, 401, 'unauthorized');
        });
    },
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const claims = (req as unknown as { claims?: AnyClaims }).claims;
    logger.info({ event: 'connection-open', ip });

    // Phase 7 Plan 07-05b — first-frame carve-out. This is the ONE place in
    // the relay's wire-handling code that reads `envelope.payload` fields
    // (named exception to T-07-02 byte-pass-through). The carve-out is
    // restricted to:
    //   (a) the FIRST frame of every WSS connection;
    //   (b) host-role JWTs only (role from claims, NEVER from connection
    //       order — T-07-09);
    //   (c) the `sessionId` and `verifySecret` fields ONLY.
    // Member-role sockets attempting session-register are forcibly closed
    // with WSS code 4400. The router.ts source-grep gate still passes
    // (no `.payload` reads in router.ts).
    //
    // Review HI-01 — second named carve-out: member→host annotation. The
    // relay rewrites `envelope.payload.memberId = claims.sub` on every
    // member→host frame so the host-side CloudHostTransport demultiplexer
    // can route inbound frames to the right VirtualConnection. The
    // alternative (joiner supplies its own memberId) is unworkable because
    // the joiner does not know its server-assigned sub until after auth-
    // response — and even then we'd have to validate `payload.memberId ===
    // claims.sub` to prevent spoofing. Annotating at the relay is the
    // 07-05b plan's documented intent (§threat-model T-07-mid). The
    // annotation is restricted to:
    //   (a) MEMBER→HOST direction ONLY (host→member fan-out remains
    //       byte-pass-through verbatim — host-issued frames already carry
    //       their own memberId field where needed);
    //   (b) the `memberId` field ONLY (no other payload field is read or
    //       mutated by the relay);
    //   (c) member-role sockets only (host-role frames are never annotated).
    // If the joiner client already supplies `payload.memberId`, we validate
    // it matches `claims.sub` and reject mismatches with close 4400 — this
    // closes the spoof window (HI-01 follow-up).
    let firstFrameHandled = false;
    // VERIFICATION BLOCKER 1 hotfix — host bootstrap defers the JWT signature
    // verify to first-frame time. The first-frame branch is now async (jose's
    // jwtVerify is a Promise). `firstFrameSettled` flips to true AFTER the
    // async work resolves; any messages that arrive during the verify window
    // are queued in `pendingFrames` and drained in order on settle. Subsequent
    // frames check `firstFrameSettled` and buffer if needed.
    let firstFrameSettled = false;
    const pendingFrames: (Buffer | string)[] = [];
    let attachedSessionId: string | undefined;
    // Review HI-01: track role on the outer connection scope so subsequent
    // frames know whether to apply the member→host memberId annotation. Set
    // once on the first frame (from the verified claims.role).
    let attachedRole: 'host' | 'member' | undefined;
    // Cached `sub` for subsequent member-frame annotation. Avoids passing the
    // discriminated AnyClaims through to handleSubsequentFrame.
    let memberSubForAnnotation: string | undefined;

    /**
     * Review HI-01: member→host annotation helper. Parses the envelope,
     * sets `payload.memberId = claims.sub` (or validates a pre-existing one),
     * and returns the re-serialized buffer. Returns null on:
     *   - malformed JSON
     *   - non-object payload
     *   - payload.memberId already present AND not equal to claims.sub
     *     (spoof attempt — caller closes 4400)
     *
     * This is the second named exception to T-07-02 byte-pass-through.
     * router.ts continues to be byte-pass-through; the annotation happens
     * BEFORE the buffer enters route(), preserving the router.ts invariant.
     */
    const annotateMemberFrame = (
      raw: Buffer | string,
      memberSub: string,
    ): Buffer | null => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        const obj = JSON.parse(text) as {
          payload?: Record<string, unknown>;
          [k: string]: unknown;
        };
        if (
          !obj ||
          typeof obj !== 'object' ||
          !obj.payload ||
          typeof obj.payload !== 'object' ||
          Array.isArray(obj.payload)
        ) {
          return null;
        }
        const existing = obj.payload.memberId;
        if (typeof existing === 'string' && existing.length > 0 && existing !== memberSub) {
          // Spoof attempt — joiner tried to forge a memberId that is not
          // their own JWT sub. Reject by signaling null to the caller.
          return null;
        }
        obj.payload.memberId = memberSub;
        return Buffer.from(JSON.stringify(obj), 'utf-8');
      } catch {
        return null;
      }
    };

    /**
     * First-frame handler. Async because host bootstrap may need to
     * jwtVerify against the session-register payload's verifySecret BEFORE
     * registry.register is called. Returns when first-frame processing is
     * fully settled (registry state may have been written). Any frames
     * received during the async window are queued in `pendingFrames` by the
     * outer ws.on('message') and drained after this resolves.
     */
    const handleFirstFrame = async (raw: Buffer | string): Promise<void> => {
      try {
        const text =
          typeof raw === 'string' ? raw : (raw as Buffer).toString('utf-8');
        const env = JSON.parse(text) as {
          sessionId?: unknown;
          payload?: { type?: unknown; sessionId?: unknown; verifySecret?: unknown };
        };

        // No claims attached? verifyClient should have rejected, but defense
        // in depth: close hard if we got this far without claims.
        if (!claims) {
          ws.close(4401, 'no-claims');
          return;
        }

        // Review HI-01: capture role at first-frame so subsequent-frame
        // logic can apply the member→host annotation without re-reading
        // claims (defense-in-depth — claims is already trusted via the
        // verifyClient gate).
        attachedRole = claims.role === 'host' ? 'host' : 'member';
        if (claims.role === 'member') {
          memberSubForAnnotation = claims.sub;
        }

        if (claims.role === 'host') {
          // T-07-02-exception: read envelope.payload.type / .sessionId / .verifySecret
          // ONLY in this branch. Comment block per the plan's documented
          // carve-out — the router.ts invariant is preserved.
          if (env?.payload?.type !== 'session-register') {
            ws.close(4400, 'host-first-frame-must-be-session-register');
            return;
          }
          const payloadSid = env.payload.sessionId;
          if (typeof payloadSid !== 'string' || payloadSid !== claims.aud) {
            ws.close(4400, 'session-register-aud-mismatch');
            return;
          }
          const verifySecretB64 = env.payload.verifySecret;
          if (typeof verifySecretB64 !== 'string') {
            ws.close(4400, 'session-register-missing-verify-secret');
            return;
          }
          const verifySecret = Buffer.from(verifySecretB64, 'base64');
          if (verifySecret.length !== 32) {
            ws.close(4400, 'session-register-verify-secret-wrong-length');
            return;
          }

          // VERIFICATION BLOCKER 1 hotfix: for host BOOTSTRAP (no session
          // existed at verifyClient time), the JWT signature has NOT been
          // verified yet. Run jwtVerify against the verifySecret extracted
          // from the session-register payload BEFORE writing to the
          // registry. Without this, a forged JWT could register a session
          // with attacker-controlled verifySecret. The check is fenced to
          // the `_pendingHostBootstrap` branch — host re-register (existing
          // session) went through verifyToken in verifyClient and reaches
          // here with verified claims.
          if ((claims as PendingHostBootstrapClaims)._pendingHostBootstrap) {
            const rawJwt = (claims as PendingHostBootstrapClaims)._rawJwt;
            try {
              await jwtVerify(rawJwt, new Uint8Array(verifySecret), {
                algorithms: ['HS256'],
                audience: claims.aud,
                clockTolerance: '30s',
              });
            } catch {
              logger.warn({
                event: 'host-bootstrap-signature-fail',
                sessionId: claims.aud,
              });
              ws.close(4401, 'host-bootstrap-signature-fail');
              return;
            }
          }

          // Review HI-05: pass claims.sub as hostMemberId so the registry
          // can bind host identity on first register and reject re-attach
          // attempts whose JWT sub doesn't match.
          const registerResult = registry.register(
            claims.aud,
            ws,
            new Uint8Array(verifySecret),
            claims.sub,
          );
          if (!registerResult.ok) {
            // Review HI-04 + HI-05: differentiated close codes per reason.
            if (registerResult.reason === 'host-identity-mismatch') {
              logger.warn({
                event: 'host-identity-mismatch',
                sessionId: claims.aud,
              });
              ws.close(4403, 'host-identity-mismatch');
            } else {
              ws.close(4429, 'session-cap-reached');
            }
            return;
          }
          attachedSessionId = claims.aud;
          // session-register frame is CONSUMED. Do NOT forward to router.
          return;
        }

        // Member role — session-register is forbidden as a first frame.
        if (env?.payload?.type === 'session-register') {
          ws.close(4400, 'members-cannot-register-sessions');
          return;
        }

        // Member role + non-register first frame — attach + route normally.
        const sid = env?.sessionId;
        if (typeof sid !== 'string' || sid !== claims.aud) {
          ws.close(4400, 'session-id-aud-mismatch');
          return;
        }
        // Review HI-04: differentiated close codes per reject reason.
        const attached = registry.attachMember(sid, claims.sub, ws);
        if (!attached.ok) {
          if (attached.reason === 'unknown-session') {
            ws.close(4404, 'session-not-found');
          } else if (attached.reason === 'grace-active') {
            ws.close(4503, 'grace-period-active');
          } else {
            // member-cap
            ws.close(4429, 'member-cap-reached');
          }
          return;
        }
        attachedSessionId = sid;
        // Review HI-01: annotate the first member frame with
        // payload.memberId = claims.sub before forwarding to route().
        // router.ts remains byte-pass-through — the annotation happens
        // at this carve-out layer in server.ts.
        const annotated = annotateMemberFrame(raw as Buffer, claims.sub);
        if (annotated === null) {
          ws.close(4400, 'malformed-or-spoofed-member-frame');
          return;
        }
        route(registry, sid, ws, annotated);
        return;
      } catch {
        ws.close(4400, 'malformed-first-frame');
        return;
      }
    };

    /**
     * Subsequent-frame handler. DO NOT inspect payload — just learn
     * sessionId from the envelope (existing 07-08 behavior). Then forward
     * verbatim, with HI-01 member→host annotation applied to member frames.
     */
    const handleSubsequentFrame = (raw: Buffer | string): void => {
      let sessionId: string | undefined;
      try {
        const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf-8');
        const obj = JSON.parse(text) as { sessionId?: unknown };
        if (typeof obj.sessionId === 'string') {
          sessionId = obj.sessionId;
        }
      } catch {
        return;
      }
      if (!sessionId) return;
      // Review MD-06: enforce envelope.sessionId === attachedSessionId on every
      // post-attach frame. The attach-time aud check already pins the socket
      // to one session id, so a frame addressed to a different session is
      // either a defective client or a malicious attempt to probe the relay.
      // Close 4400 with a discriminator reason so the client surface can
      // distinguish this from session-cap (4429), unknown-session (4404), or
      // grace-active (4503) cases.
      if (attachedSessionId !== undefined && sessionId !== attachedSessionId) {
        ws.close(4400, 'session-id-mismatch-post-attach');
        return;
      }
      // Review HI-01: member→host annotation on every subsequent member
      // frame. Host frames are forwarded verbatim (byte-pass-through is
      // preserved for host→member fan-out — the host already addresses
      // its outbound unicasts via envelope.target, no payload mutation
      // required).
      if (attachedRole === 'member' && memberSubForAnnotation !== undefined) {
        const annotated = annotateMemberFrame(raw as Buffer, memberSubForAnnotation);
        if (annotated === null) {
          ws.close(4400, 'malformed-or-spoofed-member-frame');
          return;
        }
        route(registry, sessionId, ws, annotated);
        return;
      }
      route(registry, sessionId, ws, raw as Buffer);
    };

    ws.on('message', (raw) => {
      if (!firstFrameHandled) {
        firstFrameHandled = true;
        // First-frame may be async (host bootstrap JWT verify). Queue any
        // subsequent frames that arrive during the verify window and drain
        // them after settle. The void-cast plus .finally suppresses the
        // promise-misuse lint since handleFirstFrame is documented to never
        // throw — defense-in-depth catch closes 4400 if it somehow does.
        void handleFirstFrame(raw as Buffer | string)
          .catch(() => {
            ws.close(4400, 'malformed-first-frame');
          })
          .finally(() => {
            firstFrameSettled = true;
            // Drain in FIFO order — frames were captured during the async
            // window. If the connection was closed during first-frame
            // handling (auth failure etc.), the ws.send() inside route()
            // becomes a no-op on the (now-closed) socket; defensive but
            // harmless.
            while (pendingFrames.length > 0) {
              const queued = pendingFrames.shift();
              if (queued !== undefined) {
                try {
                  handleSubsequentFrame(queued);
                } catch {
                  // Subsequent-frame handling failures don't kill the
                  // session — just drop the offending frame.
                }
              }
            }
          });
        return;
      }
      if (!firstFrameSettled) {
        // First frame's async work hasn't resolved yet. Buffer this frame
        // for in-order processing once first-frame settles. Bound the queue
        // to prevent unbounded memory growth from a misbehaving client; the
        // host bootstrap window is sub-100ms so a small cap suffices.
        if (pendingFrames.length >= 64) {
          ws.close(4400, 'too-many-frames-before-first-settles');
          return;
        }
        pendingFrames.push(raw as Buffer | string);
        return;
      }
      handleSubsequentFrame(raw as Buffer | string);
    });

    ws.on('close', (code, reason) => {
      logger.info({
        event: 'connection-close',
        ip,
        code,
        reason: reason.toString().slice(0, 64),
      });
      if (attachedSessionId) {
        registry.detach(attachedSessionId, ws);
      }
    });

    ws.on('error', (err) => {
      // T-07-04-aux: only emit error type, NEVER err.message or err.stack —
      // some ws/jose error messages echo client-controlled data (e.g., the
      // raw header bytes) which would leak into Fly.io's log stream. The
      // error type (e.g., 'Error', 'RangeError') is enough operational signal.
      logger.warn({ event: 'ws-error', ip, errType: err.name });
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
        // 07-10 emits {event:'idle-reap', sessionId} — preserved verbatim
        // through the 07-11 logger swap. sessionId is the routing key and is
        // intentionally NOT in the redact set (operational signal).
        logger.info({ event: 'idle-reap', sessionId: session.sessionId });
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
      logger.info({ event: 'listen', port: actualPort });
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
    // Fatal-startup path: bind failure, port conflict, etc. Log err.name (the
    // error TYPE) only — NEVER err.message or err.stack (T-07-04-aux). The
    // operator gets enough signal to debug from the error class without risk
    // of leaking address/port details or client-controlled bytes from a stack
    // frame. Use logger.fatal so the level shows pino's "fatal" label.
    logger.fatal({ event: 'startup-error', errType: (err as Error).name });
    process.exit(1);
  });
}
