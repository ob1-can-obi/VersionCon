import * as crypto from 'crypto';

/**
 * Handles invite code validation with constant-time comparison and per-IP rate limiting.
 *
 * Security considerations (T-01-03):
 * - Uses crypto.timingSafeEqual to prevent timing attacks on invite code comparison
 * - Rate limits auth attempts to 5 per IP per 60 seconds
 * - Invite codes use a safe alphabet excluding ambiguous characters (0/O/I/1)
 */

/** Safe alphabet for invite codes -- excludes 0/O/I/1 for readability */
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 6;

interface RateLimitEntry {
  attempts: number;
  lastAttempt: number;
}

export class AuthHandler {
  private storedCode: string;
  private readonly rateLimitMap: Map<string, RateLimitEntry> = new Map();
  private static readonly MAX_ATTEMPTS = 5;
  private static readonly WINDOW_MS = 60_000; // 60 seconds

  constructor(inviteCode: string) {
    this.storedCode = inviteCode;
  }

  /**
   * Validates an invite code using constant-time comparison.
   * Handles length mismatch by comparing against a padded/truncated buffer
   * so that timingSafeEqual always receives equal-length inputs.
   */
  validateInviteCode(provided: string): boolean {
    const storedBuf = Buffer.from(this.storedCode, 'utf-8');
    const providedBuf = Buffer.from(provided, 'utf-8');

    // timingSafeEqual requires same-length buffers.
    // To avoid leaking length information, we always compare against
    // a buffer of the stored code's length. If provided is shorter, we pad it;
    // if longer, we truncate. Either way the comparison will fail, but in constant time.
    if (providedBuf.length !== storedBuf.length) {
      // Create a buffer of the correct length filled with the provided bytes
      // (or zeros if too short). The comparison will fail but takes constant time.
      const normalised = Buffer.alloc(storedBuf.length);
      providedBuf.copy(normalised, 0, 0, Math.min(providedBuf.length, storedBuf.length));
      crypto.timingSafeEqual(normalised, storedBuf);
      return false;
    }

    return crypto.timingSafeEqual(providedBuf, storedBuf);
  }

  /**
   * Checks whether a client IP has exceeded the rate limit for auth attempts.
   * Returns { allowed: true } if the attempt is permitted, or
   * { allowed: false, retryAfterMs } if rate-limited.
   */
  checkRateLimit(clientIp: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    this.cleanExpiredEntries(now);

    const entry = this.rateLimitMap.get(clientIp);

    if (!entry) {
      this.rateLimitMap.set(clientIp, { attempts: 1, lastAttempt: now });
      return { allowed: true };
    }

    // If outside the window, reset
    if (now - entry.lastAttempt > AuthHandler.WINDOW_MS) {
      entry.attempts = 1;
      entry.lastAttempt = now;
      return { allowed: true };
    }

    if (entry.attempts >= AuthHandler.MAX_ATTEMPTS) {
      const retryAfterMs = AuthHandler.WINDOW_MS - (now - entry.lastAttempt);
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    entry.attempts++;
    entry.lastAttempt = now;
    return { allowed: true };
  }

  /**
   * Generates a new invite code using the safe alphabet and crypto.randomBytes.
   * Updates the internal stored code and returns the new code.
   */
  regenerateCode(): string {
    const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
    let code = '';
    for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
      code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
    }
    this.storedCode = code;
    return code;
  }

  /** Returns the current invite code. */
  get currentCode(): string {
    return this.storedCode;
  }

  /** Removes rate limit entries whose window has expired. */
  private cleanExpiredEntries(now: number): void {
    for (const [ip, entry] of this.rateLimitMap) {
      if (now - entry.lastAttempt > AuthHandler.WINDOW_MS) {
        this.rateLimitMap.delete(ip);
      }
    }
  }
}
