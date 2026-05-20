// -----------------------------------------------------------------------------
// Phase 7 Plan 07-13 — gap-closure (BLOCKER 2 / MD-03 / Option A).
//
// TokenService.issueBootstrap unit tests.
//
// issueBootstrap mints a SHORT-LIVED (15-minute hard-cap) role:'member' JWT
// that is embedded in the share-screen deep-link's `bt` query param so a
// cloud-mode joiner has a valid Bearer token to open the WSS to the relay
// BEFORE the host's auth-response flow runs. The relay's existing verifyToken
// path (relay/src/auth.ts:74-164) accepts this JWT verbatim because it signs
// against the per-session verifySecret and shape-checks as a normal member
// JWT — proven by serverAuthIntegration.test.js test 3 ("member auth happy
// path: pre-registered session + member-JWT signed with same secret").
//
// Tests pin the bootstrap JWT shape AND the source-grep gates enforcing
// threat-model invariants:
//   T-07-11 (HS256 pin)   — `setProtectedHeader({ alg: 'HS256' })` count == 2
//                            (existing `issue` + new `issueBootstrap`)
//   T-07-15 (no role:host) — bootstrap JWT NEVER mints role:'host'
//                            (`role: 'host'` count in TokenService.ts == 0)
//   Bootstrap exp hard cap — `setExpirationTime('15m')` literal present
//                            (NOT the env-driven this.ttl); env override
//                            of VERSIONCON_TOKEN_TTL has no effect.
// -----------------------------------------------------------------------------

import * as assert from 'assert';
import * as path from 'path';
import * as fsSync from 'fs';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { TokenService } from '../../auth/TokenService.js';

suite('Phase 7 — token service bootstrap (MD-03 Option A)', () => {
  let secret: Uint8Array;
  let svc: TokenService;

  setup(() => {
    secret = TokenService.newSecret();
    svc = new TokenService(secret);
  });

  test('issueBootstrap returns a JWT-shaped string (three dot-separated segments)', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    assert.strictEqual(typeof jwt, 'string');
    assert.ok(jwt.startsWith('eyJ'), 'JWT must start with base64url-encoded header (eyJ)');
    assert.strictEqual(jwt.split('.').length, 3, 'JWT must be three dot-separated segments');
  });

  test('bootstrap JWT carries role:"member" (literal, never "host" — T-07-15)', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const claims = decodeJwt(jwt);
    assert.strictEqual(
      claims.role,
      'member',
      'bootstrap JWT MUST carry role:"member" — never "host" (T-07-15 elevation-of-privilege defense)',
    );
  });

  test('bootstrap JWT sub is "bootstrap-" + sessionId (fixed marker, multi-joiner OK)', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const claims = decodeJwt(jwt);
    assert.strictEqual(
      claims.sub,
      'bootstrap-vc-abc123def',
      'sub MUST be the concatenation of literal "bootstrap-" + sessionId arg',
    );
  });

  test('bootstrap JWT iss is the hostMemberId arg verbatim', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const claims = decodeJwt(jwt);
    assert.strictEqual(
      claims.iss,
      'host-member-id-1',
      'iss MUST be the hostMemberId arg verbatim',
    );
  });

  test('bootstrap JWT aud is the sessionId arg verbatim', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const claims = decodeJwt(jwt);
    assert.strictEqual(
      claims.aud,
      'vc-abc123def',
      'aud MUST be the sessionId arg verbatim',
    );
  });

  test('bootstrap JWT exp - iat === 900 (15m HARD CAP — ignores VERSIONCON_TOKEN_TTL env)', async () => {
    const oldTtl = process.env.VERSIONCON_TOKEN_TTL;
    process.env.VERSIONCON_TOKEN_TTL = '4h';
    try {
      // Construct a FRESH TokenService AFTER setting the env var so the env
      // is observed at construction time (TokenService captures the env at
      // constructor time into this.ttl). issueBootstrap MUST ignore this.ttl
      // and use the literal '15m'.
      const envSvc = new TokenService(TokenService.newSecret());
      const jwt = await envSvc.issueBootstrap('vc-abc123def', 'host-member-id-1');
      const claims = decodeJwt(jwt);
      assert.ok(typeof claims.exp === 'number', 'exp claim present');
      assert.ok(typeof claims.iat === 'number', 'iat claim present');
      assert.strictEqual(
        (claims.exp as number) - (claims.iat as number),
        900,
        '15m bootstrap exp MUST ignore VERSIONCON_TOKEN_TTL env (900s == 15min)',
      );
    } finally {
      if (oldTtl === undefined) delete process.env.VERSIONCON_TOKEN_TTL;
      else process.env.VERSIONCON_TOKEN_TTL = oldTtl;
    }
  });

  test('bootstrap JWT header pins HS256 (T-07-11 algorithm pin preserved)', async () => {
    const jwt = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const header = decodeProtectedHeader(jwt);
    assert.strictEqual(
      header.alg,
      'HS256',
      'protected header alg MUST be HS256 (T-07-11 algorithm-confusion defense)',
    );
  });

  test('two consecutive issueBootstrap calls produce distinct jti claims (replay defense)', async () => {
    const jwt1 = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const jwt2 = await svc.issueBootstrap('vc-abc123def', 'host-member-id-1');
    const c1 = decodeJwt(jwt1);
    const c2 = decodeJwt(jwt2);
    assert.strictEqual(typeof c1.jti, 'string');
    assert.strictEqual(typeof c2.jti, 'string');
    assert.notStrictEqual(
      c1.jti,
      c2.jti,
      'each bootstrap JWT must carry a distinct jti (UUIDv4 uniqueness)',
    );
  });

  test('source-grep: TokenService.ts has NO JWT-MINT site with role:"host" (T-07-15)', () => {
    const filePath = path.resolve(process.cwd(), 'src/auth/TokenService.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    // T-07-15: issueBootstrap must NEVER mint host role. Host JWTs are minted
    // in SessionHostFactory.ts via tokenService.issue({...role:'host'}), NOT
    // hard-coded inside TokenService.ts. The plan's `grep -c "role: 'host'"
    // == 0` spec collides with the pre-existing TokenClaims interface union
    // `role: 'host' | 'member'` (line 27 since 07-03); the literal-grep cannot
    // distinguish the type-union declaration from a JWT-mint call. The SPIRIT
    // of the gate is enforced by a stricter regex: NO `new SignJWT({...
    // role: 'host' ...}` call site may exist in this file. issue() uses the
    // parameterized form `new SignJWT({ role: claims.role })` and
    // issueBootstrap uses `new SignJWT({ role: 'member' })` — neither is a
    // hard-coded role:'host' mint.
    const mintSitePattern = /new SignJWT\(\s*\{[^}]*role:\s*['"]host['"]/g;
    const mintMatches = src.match(mintSitePattern) ?? [];
    assert.strictEqual(
      mintMatches.length,
      0,
      "TokenService.ts must contain ZERO SignJWT({ role: 'host', ... }) mint sites (T-07-15 elevation-of-privilege defense)",
    );

    // Additionally, no role:'host' literal may appear in the issueBootstrap
    // function body. We isolate the function body via a delimiter scan and
    // assert role:'host' is absent from it.
    const ibStart = src.indexOf('async issueBootstrap');
    assert.ok(ibStart >= 0, 'issueBootstrap method must exist');
    // Find the matching close brace via simple brace counting.
    let depth = 0;
    let bodyStart = src.indexOf('{', ibStart);
    let bodyEnd = -1;
    for (let i = bodyStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    assert.ok(bodyEnd > bodyStart, 'issueBootstrap body must close');
    const body = src.slice(bodyStart, bodyEnd + 1);
    assert.ok(
      !/role:\s*['"]host['"]/.test(body),
      "issueBootstrap function body MUST NOT contain role: 'host' (T-07-15)",
    );
  });

  test("source-grep: TokenService.ts contains '15m' literal (bootstrap exp hard cap)", () => {
    const filePath = path.resolve(process.cwd(), 'src/auth/TokenService.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    const matches = src.match(/'15m'/g) ?? [];
    assert.ok(
      matches.length >= 1,
      "TokenService.ts must contain the literal '15m' at the issueBootstrap exp call site",
    );
  });

  test("source-grep: TokenService.ts contains 'bootstrap-' sub marker", () => {
    const filePath = path.resolve(process.cwd(), 'src/auth/TokenService.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    const matches = src.match(/'bootstrap-'/g) ?? [];
    assert.ok(
      matches.length >= 1,
      "TokenService.ts must contain the literal 'bootstrap-' as the sub prefix",
    );
  });

  test('source-grep: TokenService.ts has EXACTLY 2 setProtectedHeader({alg:HS256}) call sites (T-07-11)', () => {
    const filePath = path.resolve(process.cwd(), 'src/auth/TokenService.ts');
    const src = fsSync.readFileSync(filePath, 'utf-8');
    const matches = src.match(/setProtectedHeader\(\{ alg: 'HS256' \}\)/g) ?? [];
    assert.strictEqual(
      matches.length,
      2,
      "TokenService.ts MUST have EXACTLY 2 setProtectedHeader({ alg: 'HS256' }) sites — existing issue() + new issueBootstrap() (T-07-11 algorithm-pin extended)",
    );
  });
});
