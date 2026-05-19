// relay/test/auth.test.js
//
// Phase 7 — relay auth (07-09).
//
// JWT verify gate for the WSS handshake. 9 functional cases + 1 source-grep gate.
// Maps 1:1 to the plan's must-haves:
//   1. happy            — valid HS256 token resolves to {sessionId, memberId, role}.
//   2. expired          — exp in the past → null (T-07-01 replay defense).
//   3. unknown-session  — aud not in registry → null.
//   4. alg:none         — hand-built unsigned token → null (T-07-11).
//   5. RS256→HS256 swap — real RS256-signed token → null (T-07-11).
//   6. missing-header   — no Authorization header → null.
//   7. no-Bearer-prefix — header not starting with 'Bearer ' → null.
//   8. case-insensitive — reads ONLY req.headers.authorization (lowercase per Node).
//   9. role-claim       — role comes from JWT claim, never from connection order (T-07-09).
//   + source-grep gate  — relay/src/auth.ts contains `algorithms: ['HS256']` (T-07-11).
//
// Runs via Node's built-in test runner — `node --test test/auth.test.js`. Zero
// external runner deps beyond jose (already in relay/package.json).
//
// Tests import from ../dist/<module>.js because relay/tsconfig.json has
// rootDir:./src + outDir:./dist (flat output — no nested src/ in dist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SignJWT } from 'jose';
import { verifyToken } from '../dist/auth.js';
import { SessionRegistry } from '../dist/SessionRegistry.js';

// ------------------------------- helpers -------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function buildAlgNoneToken({ aud, role, sub, iss, exp }) {
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const body = b64url({
    iss,
    sub,
    aud,
    role,
    exp: exp ?? Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  });
  return `${header}.${body}.`; // empty signature segment
}

async function buildRs256Token({ aud, role, sub, iss }) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return new SignJWT({ role })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(iss)
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

async function buildHs256Token({ aud, role, sub, iss, secret, exp }) {
  const builder = new SignJWT({ role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(iss)
    .setSubject(sub)
    .setAudience(aud)
    .setIssuedAt()
    .setJti(crypto.randomUUID());
  if (exp !== undefined) builder.setExpirationTime(exp);
  else builder.setExpirationTime('1h');
  return builder.sign(secret);
}

function makeReq(headers) {
  return { headers };
}

function fakeSocket() {
  return { send: () => {}, readyState: 1, close: () => {} };
}

function freshRegistry(sessionId, secret, _hostMemberId) {
  // 07-08's SessionRegistry.register(sessionId, hostSocket, verifySecret) — three
  // positional args. hostSocket is a placeholder for auth tests; verifyToken
  // never touches it (it only reads session.verifySecret).
  const reg = new SessionRegistry();
  reg.register(sessionId, fakeSocket(), secret);
  return reg;
}

// ------------------------------- cases ---------------------------------

test('happy: valid HS256 token resolves to {sessionId, memberId, role}', async () => {
  const sessionId = 'vc-happy';
  const secret = new Uint8Array(crypto.randomBytes(32));
  const reg = freshRegistry(sessionId, secret, 'host-1');
  const token = await buildHs256Token({
    aud: sessionId, role: 'host', sub: 'host-1', iss: 'host-1', secret,
  });
  const req = makeReq({ authorization: `Bearer ${token}` });
  const result = await verifyToken(req, reg);
  assert.equal(result?.sessionId, sessionId);
  assert.equal(result?.memberId, 'host-1');
  assert.equal(result?.role, 'host');
});

test('rejects expired token (returns null)', async () => {
  const sessionId = 'vc-expired';
  const secret = new Uint8Array(crypto.randomBytes(32));
  const reg = freshRegistry(sessionId, secret, 'host-1');
  const token = await buildHs256Token({
    aud: sessionId, role: 'host', sub: 'host-1', iss: 'host-1', secret,
    exp: Math.floor(Date.now() / 1000) - 3600, // 1h in the past
  });
  const req = makeReq({ authorization: `Bearer ${token}` });
  const result = await verifyToken(req, reg);
  assert.equal(result, null);
});

test('rejects token with unknown-session aud (returns null)', async () => {
  const reg = freshRegistry('vc-known', new Uint8Array(crypto.randomBytes(32)), 'host-1');
  const otherSecret = new Uint8Array(crypto.randomBytes(32));
  const token = await buildHs256Token({
    aud: 'vc-other', role: 'host', sub: 'host-1', iss: 'host-1', secret: otherSecret,
  });
  const req = makeReq({ authorization: `Bearer ${token}` });
  const result = await verifyToken(req, reg);
  assert.equal(result, null);
});

test('rejects alg:none token (T-07-11 algorithm-confusion)', async () => {
  const sessionId = 'vc-algnone';
  const reg = freshRegistry(sessionId, new Uint8Array(crypto.randomBytes(32)), 'host-1');
  const token = buildAlgNoneToken({ aud: sessionId, role: 'host', sub: 'host-1', iss: 'host-1' });
  const req = makeReq({ authorization: `Bearer ${token}` });
  const result = await verifyToken(req, reg);
  assert.equal(result, null);
});

test('rejects RS256-signed token (T-07-11 RS256→HS256 swap)', async () => {
  const sessionId = 'vc-rs256';
  const reg = freshRegistry(sessionId, new Uint8Array(crypto.randomBytes(32)), 'host-1');
  const token = await buildRs256Token({ aud: sessionId, role: 'host', sub: 'host-1', iss: 'host-1' });
  const req = makeReq({ authorization: `Bearer ${token}` });
  const result = await verifyToken(req, reg);
  assert.equal(result, null);
});

test('rejects request with no Authorization header (returns null)', async () => {
  const reg = freshRegistry('vc-x', new Uint8Array(crypto.randomBytes(32)), 'host-1');
  const req = makeReq({});
  const result = await verifyToken(req, reg);
  assert.equal(result, null);
});

test('rejects request whose Authorization header does not start with Bearer (returns null)', async () => {
  const reg = freshRegistry('vc-x', new Uint8Array(crypto.randomBytes(32)), 'host-1');
  const req = makeReq({ authorization: 'NotBearer xyz' });
  const result = await verifyToken(req, reg);
  assert.equal(result, null);
});

test('reads only lowercase authorization key (Pitfall 5 — Node lowercases inbound headers)', async () => {
  const sessionId = 'vc-case';
  const secret = new Uint8Array(crypto.randomBytes(32));
  const reg = freshRegistry(sessionId, secret, 'host-1');
  const token = await buildHs256Token({
    aud: sessionId, role: 'host', sub: 'host-1', iss: 'host-1', secret,
  });

  // (a) lowercase key works (this is the path real Node IncomingMessage takes):
  const reqLower = makeReq({ authorization: `Bearer ${token}` });
  const okLower = await verifyToken(reqLower, reg);
  assert.equal(okLower?.role, 'host');

  // (b) capital-A-only key returns null (Node never populates this key on real traffic;
  //     test ensures our code path doesn't accidentally read from it):
  const reqUpper = makeReq({ Authorization: `Bearer ${token}` });
  const okUpper = await verifyToken(reqUpper, reg);
  assert.equal(
    okUpper,
    null,
    'verifyToken must read req.headers.authorization (lowercase) — Node normalizes inbound headers',
  );
});

test('role claim is respected verbatim — never inferred from connection order (T-07-09 preserves Phase 4.1 first-authenticated-wins-host BAN)', async () => {
  const sessionId = 'vc-roles';
  const secret = new Uint8Array(crypto.randomBytes(32));
  const reg = freshRegistry(sessionId, secret, 'host-1');

  const hostToken = await buildHs256Token({
    aud: sessionId, role: 'host', sub: 'host-1', iss: 'host-1', secret,
  });
  const memberToken = await buildHs256Token({
    aud: sessionId, role: 'member', sub: 'm-2', iss: 'host-1', secret,
  });

  const hostResult = await verifyToken(makeReq({ authorization: `Bearer ${hostToken}` }), reg);
  const memberResult = await verifyToken(makeReq({ authorization: `Bearer ${memberToken}` }), reg);

  assert.equal(hostResult?.role, 'host');
  assert.equal(memberResult?.role, 'member');
  // Same sessionId both times — role MUST come from the claim, never from order.
});

test("source-grep gate: algorithms: ['HS256'] literal is present in relay/src/auth.ts (T-07-11)", () => {
  const authPath = path.resolve(process.cwd(), 'src/auth.ts');
  const src = fs.readFileSync(authPath, 'utf-8');
  assert.match(
    src,
    /algorithms:\s*\['HS256'\]/,
    "T-07-11 algorithm-confusion defense regressed — algorithms: ['HS256'] literal missing from auth.ts",
  );
});
