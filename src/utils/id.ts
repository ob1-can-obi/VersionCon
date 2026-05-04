import * as crypto from 'crypto';

/**
 * Human-readable alphabet for invite codes.
 * 32 characters — excludes 0/O/I/1 to avoid visual ambiguity.
 */
export const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a cryptographically random invite code using the safe alphabet.
 *
 * Uses crypto.randomBytes for unbiased random selection. The alphabet
 * has exactly 32 characters (power of 2), so modulo bias is zero.
 *
 * @param length - Number of characters in the code (default 6)
 * @returns A human-readable invite code string
 */
export function generateInviteCode(length: number = 6): string {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return code;
}
