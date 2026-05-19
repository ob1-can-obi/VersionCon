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

  async issue(_claims: TokenClaims): Promise<string> {
    throw new Error('NOT IMPLEMENTED — Task 2');
  }

  async verify(_token: string, _audience: string): Promise<JWTPayload> {
    throw new Error('NOT IMPLEMENTED — Task 2');
  }
}
