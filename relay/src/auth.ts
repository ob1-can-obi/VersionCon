// relay/src/auth.ts
//
// Phase 7 — relay JWT verify gate (plan 07-09).
//
// Sole responsibility: validate the WSS upgrade request's Authorization header
// against a per-session HS256 secret. Returns the verified claims on success or
// null on any failure path — NEVER throws (the verifyClient consumer in
// server.ts treats null as "reject 401").
//
// Two-step verify (CONTEXT D-07 + RESEARCH §Pattern 2):
//   1. decodeJwt extracts `aud` WITHOUT a signature check so we can route the
//      token to the right per-session verifySecret. Any tamper of aud at this
//      stage can only misroute to a different secret — the subsequent jwtVerify
//      then fails because that secret won't validate the token's HMAC.
//   2. jwtVerify runs full signature + algorithm + audience + exp validation
//      with `algorithms: ['HS256']` non-optional (T-07-11 algorithm-confusion
//      defense). audience is pinned to the same aud extracted in step 1, so
//      cross-session replay attempts fail at the audience check.
//
// Logger discipline (CONTEXT D-11, T-07-03/04): failure log lines are STRICTLY
// `{event:'auth-fail', sessionId, reason}` — never the bearer, never the raw
// token, never the secret, never the Authorization header value. 07-11's pino
// `redact` config is a second line of defense; this file's contract is to
// never log the unsafe values in the first place.
//
// Role discipline (T-07-09): role is sourced exclusively from `payload.role`.
// There is NO codepath that infers role from connection order, registration
// time, or any other side-channel — preserves Phase 4.1's BAN on the
// "first-authenticated-wins-host" anti-pattern in cloud mode.
//
// Host-side-secret locality (T-07-05): this file contains ZERO references to
// the host-side join-secret identifiers. The shared secret used at session
// join stays in the extension's AuthHandler and never reaches the relay —
// preserving the future L3 key-derivation seam per CONTEXT D-07 line 124-127.
// An extension-side source-grep test under src/test/suite/ enforces this
// invariant across every .ts file under relay/src/ on every CI run.

import type { IncomingMessage } from 'node:http';
import { decodeJwt, jwtVerify } from 'jose';
import type { SessionRegistry } from './SessionRegistry.js';
import { logger } from './logger.js';

export type TokenInfo = {
  sessionId: string;
  memberId: string;
  role: 'host' | 'member';
};

type AuthFailReason =
  | 'malformed'
  | 'expired'
  | 'wrong-alg'
  | 'unknown-session'
  | 'malformed-aud';

// Review MD-02: shape gate on the unverified aud claim before it reaches a
// log line. The aud is read via decodeJwt (no signature check), so an
// unauthenticated attacker controls it. Without this gate they could inject
// control characters or arbitrary bytes into the log stream, poison ops
// search, or inflate log volume with sentinel session ids. Real session
// ids match `vc-[a-z0-9-]{1,64}` (see WizardPanel — `vc-` prefix + random
// hex/uuid). The regex is intentionally permissive within those bounds.
const SESSION_ID_SHAPE = /^vc-[a-z0-9-]{1,64}$/;

function logFail(sessionId: string | undefined, reason: AuthFailReason): void {
  // Logger discipline (CONTEXT D-11, T-07-03/04): only {event, sessionId, reason}.
  // NEVER the bearer, NEVER the secret, NEVER the Authorization header value.
  // 07-11 swap: console.error → logger.warn — field shape unchanged. The redact
  // config in logger.ts is a second line of defense; this function's contract
  // is to never log the unsafe values in the first place.
  logger.warn({ event: 'auth-fail', sessionId, reason });
}

export async function verifyToken(
  req: IncomingMessage,
  registry: SessionRegistry,
): Promise<TokenInfo | null> {
  // Step 1: lowercase header access only (RESEARCH §Pitfall 5 — Node lowercases
  // inbound headers on the IncomingMessage interface). Any code path reading
  // req.headers['Authorization'] would return undefined on real traffic.
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    logFail(undefined, 'malformed');
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (token.length === 0) {
    logFail(undefined, 'malformed');
    return null;
  }

  // Step 2: pre-decode (no signature check) to extract aud — needed BEFORE the
  // per-session verifySecret lookup. A tampered aud here can only misroute the
  // lookup; the subsequent jwtVerify still fails on signature mismatch.
  let unverifiedAud: string;
  try {
    const unverified = decodeJwt(token);
    if (typeof unverified.aud !== 'string') {
      logFail(undefined, 'malformed');
      return null;
    }
    unverifiedAud = unverified.aud;
  } catch {
    logFail(undefined, 'malformed');
    return null;
  }

  // Review MD-02: defense-in-depth shape gate. Reject + log WITHOUT echoing
  // the attacker-controlled aud string when it does not match the canonical
  // session-id shape. This prevents the attacker from steering arbitrary
  // bytes (control characters, log-injection payloads, sentinel strings)
  // into the relay's log stream via auth-fail emissions.
  if (!SESSION_ID_SHAPE.test(unverifiedAud)) {
    logFail(undefined, 'malformed-aud');
    return null;
  }

  // Step 3: look up the session's verifySecret by aud.
  const session = registry.getSession(unverifiedAud);
  if (!session) {
    logFail(unverifiedAud, 'unknown-session');
    return null;
  }

  // Step 4: full verify — algorithms locked to HS256 (T-07-11), audience pinned
  // to the same aud, 30s clock tolerance per RESEARCH §Pattern 3 (mirrors
  // TokenService.verify in 07-03).
  try {
    const { payload } = await jwtVerify(token, session.verifySecret, {
      algorithms: ['HS256'],
      audience: unverifiedAud,
      clockTolerance: '30s',
    });

    // Defense-in-depth post-condition (mirrors TokenService.verify in 07-03):
    // role must be one of {'host', 'member'}. jose's jwtVerify does NOT validate
    // custom claims like role — a compromised issuer minting role:'admin' would
    // otherwise slip through.
    const role = payload.role;
    if (role !== 'host' && role !== 'member') {
      logFail(unverifiedAud, 'malformed');
      return null;
    }
    if (typeof payload.sub !== 'string') {
      logFail(unverifiedAud, 'malformed');
      return null;
    }

    return {
      sessionId: unverifiedAud,
      memberId: payload.sub,
      role,
    };
  } catch (err) {
    // jose's JWTExpired carries code === 'ERR_JWT_EXPIRED'; everything else
    // (algorithm mismatch, signature failure, audience mismatch, claim validation)
    // is bucketed as 'wrong-alg' for log brevity. The redact path in 07-11 stays
    // simple by keeping the reason vocabulary small and stable.
    const reason: AuthFailReason =
      (err as { code?: string })?.code === 'ERR_JWT_EXPIRED' ? 'expired' : 'wrong-alg';
    logFail(unverifiedAud, reason);
    return null;
  }
}
