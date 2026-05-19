import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import * as crypto from 'crypto';

/**
 * Phase 7 — TokenService (CONTEXT D-07 + T-07-11)
 *
 * Thin, portable wrapper around the `jose` library. Used by:
 *   - SessionHost (issuer) at session creation to mint host + per-joiner tokens.
 *   - Relay (verifier — plan 07-09) at WSS handshake to validate every JWT.
 *
 * This file is DELIBERATELY VS-Code-free so the relay package (plan 07-09)
 * can consume it verbatim without pulling in editor APIs.
 *
 * Locked invariants (do not loosen without a CONTEXT revision):
 *   - Algorithm is HS256 only. `verify()` always passes `algorithms: ['HS256']`
 *     to jose's jwtVerify. This is the T-07-11 algorithm-confusion defense and
 *     it is asserted both by tests and by a source-grep gate in the plan.
 *   - Secret is 32 raw bytes (NEVER a base64 string). jose wants Uint8Array.
 *   - TTL is configurable via `VERSIONCON_TOKEN_TTL` env var (jose timestring
 *     format — e.g. '4h', '30m', '1d'). Default '4h' per D-07.
 */

export interface TokenClaims {
  iss: string;
  sub: string;
  aud: string;
  role: 'host' | 'member';
}

export class TokenService {
  private readonly secret: Uint8Array;
  private readonly ttl: string;

  /**
   * Generates a fresh 32-byte cryptographically-random secret suitable for
   * HS256 signing. Returned as a Uint8Array — never base64-encoded — so the
   * value cannot leak through accidental string coercion (T-07-secret-leak).
   */
  static newSecret(): Uint8Array {
    return new Uint8Array(crypto.randomBytes(32));
  }

  constructor(secret: Uint8Array) {
    if (secret.byteLength !== 32) {
      throw new Error('TokenService secret must be 32 bytes');
    }
    this.secret = secret;
    this.ttl = process.env.VERSIONCON_TOKEN_TTL ?? '4h';
  }

  async issue(claims: TokenClaims): Promise<string> {
    return new SignJWT({ role: claims.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(claims.iss)
      .setSubject(claims.sub)
      .setAudience(claims.aud)
      .setIssuedAt()
      .setExpirationTime(this.ttl)
      .setJti(crypto.randomUUID())
      .sign(this.secret);
  }

  /**
   * Verify a JWT against this service's secret. Returns the verified payload
   * on success; throws on any failure (signature, alg, audience, expiry,
   * missing role).
   *
   * Review MD-08 — optional `expectedIssuer` parameter: when supplied,
   * the verified payload's `iss` claim MUST match. The host's TokenService
   * always sets `iss` to the host's memberId on issue (see
   * SessionHostFactory.createCloud → tokenService.issue with iss: hostMemberId).
   * A future multi-host extension might revoke a co-host's tokens by
   * rotating the verifySecret while keeping the same sessionId; the iss
   * pin gives the verifier an early rejection signal in that case.
   * Backwards-compat: existing call-sites omit the argument and get the
   * pre-MD-08 lenient behavior.
   */
  async verify(
    token: string,
    audience: string,
    expectedIssuer?: string,
  ): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, this.secret, {
      algorithms: ['HS256'],
      audience,
      clockTolerance: '30s',
      ...(expectedIssuer !== undefined ? { issuer: expectedIssuer } : {}),
    });
    if (payload.role !== 'host' && payload.role !== 'member') {
      throw new Error('Missing role claim');
    }
    return payload;
  }
}
