import * as assert from 'assert';
import * as crypto from 'crypto';
import { SignJWT } from 'jose';
import { TokenService, type TokenClaims } from '../../auth/TokenService.js';

// -----------------------------------------------------------------------------
// Phase 7 Plan 07-03 — TokenService (jose-backed HS256 JWT)
//
// Eight cases covering the locked claim schema (CONTEXT D-07) and the two
// STRIDE threats this module mitigates (T-07-01 forgery / replay,
// T-07-11 algorithm confusion):
//
//   1. happy path — issue+verify roundtrip resolves with all six claims.
//   2. expired — exp enforcement (T-07-01 short-exp replay defense).
//   3. wrong audience — cross-session replay defense (T-07-cross-session).
//   4. alg:none — the canonical T-07-11 algorithm-confusion swap.
//   5. RS256 — second T-07-11 swap, asymmetric variant.
//   6. wrong secret — pure forgery defense (T-07-01).
//   7. missing aud — defense in depth, jose itself rejects.
//   8. missing role — our verify() post-condition catches it
//      (T-07-missing-claim defense in depth).
//
// Rejection assertions deliberately do NOT pin jose's error class names —
// `assert.rejects(() => svc.verify(...))` only asserts SOME rejection
// occurs, so the suite survives jose minor-version upgrades.
// -----------------------------------------------------------------------------

suite('Phase 7 — token service', () => {
  let secret: Uint8Array;
  let svc: TokenService;
  const claims: TokenClaims = {
    iss: 'host-1',
    sub: 'host-1',
    aud: 'sess-A',
    role: 'host',
  };

  setup(() => {
    secret = TokenService.newSecret();
    svc = new TokenService(secret);
  });

  test('happy path: issue + verify roundtrip resolves with all claims', async () => {
    const token = await svc.issue(claims);
    assert.strictEqual(typeof token, 'string');
    assert.ok(token.split('.').length === 3, 'JWT must be three dot-separated segments');

    const payload = await svc.verify(token, 'sess-A');

    assert.strictEqual(payload.iss, 'host-1');
    assert.strictEqual(payload.sub, 'host-1');
    assert.strictEqual(payload.aud, 'sess-A');
    assert.strictEqual(payload.role, 'host');
    assert.strictEqual(typeof payload.jti, 'string');
    assert.ok(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.jti as string),
      'jti must be a UUID string',
    );
    assert.strictEqual(typeof payload.iat, 'number');
    assert.strictEqual(typeof payload.exp, 'number');
    assert.ok(
      (payload.exp as number) > (payload.iat as number),
      'exp must be strictly greater than iat',
    );
  });

  test('rejects expired token', async () => {
    const expiredToken = await new SignJWT({ role: 'host' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('host-1')
      .setSubject('host-1')
      .setAudience('sess-A')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setJti(crypto.randomUUID())
      .sign(secret);

    await assert.rejects(() => svc.verify(expiredToken, 'sess-A'));
  });

  test('rejects token with wrong audience', async () => {
    const token = await svc.issue(claims);
    await assert.rejects(() => svc.verify(token, 'sess-B'));
  });

  test('rejects alg:none (T-07-11 algorithm-confusion)', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const header = b64({ alg: 'none', typ: 'JWT' });
    const body = b64({
      iss: 'host-1',
      sub: 'host-1',
      aud: 'sess-A',
      role: 'host',
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    });
    const algNoneToken = `${header}.${body}.`;

    await assert.rejects(() => svc.verify(algNoneToken, 'sess-A'));
  });

  test('rejects RS256-signed token (T-07-11 algorithm-swap)', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rs256Token = await new SignJWT({ role: 'host' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('host-1')
      .setSubject('host-1')
      .setAudience('sess-A')
      .setIssuedAt()
      .setExpirationTime('4h')
      .setJti(crypto.randomUUID())
      .sign(privateKey);

    await assert.rejects(() => svc.verify(rs256Token, 'sess-A'));
  });

  test('rejects token signed with a different secret', async () => {
    const secretB = TokenService.newSecret();
    const svcB = new TokenService(secretB);

    const tokenFromA = await svc.issue(claims);
    await assert.rejects(() => svcB.verify(tokenFromA, 'sess-A'));
  });

  test('rejects token missing aud claim', async () => {
    const noAudToken = await new SignJWT({ role: 'host' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('host-1')
      .setSubject('host-1')
      .setIssuedAt()
      .setExpirationTime('4h')
      .setJti(crypto.randomUUID())
      .sign(secret);

    await assert.rejects(() => svc.verify(noAudToken, 'sess-A'));
  });

  test('rejects token missing role claim', async () => {
    const claimsWithoutRole = { iss: 'host-1', sub: 'host-1', aud: 'sess-A' } as unknown as TokenClaims;
    const token = await svc.issue(claimsWithoutRole);

    await assert.rejects(() => svc.verify(token, 'sess-A'));
  });
});
