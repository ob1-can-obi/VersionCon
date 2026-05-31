import { parseToken, isExpired } from './auth.js';

export interface AuthResult {
  valid: boolean;
  userId?: string;
  reason?: string;
}

export function handleAuth(token: string): AuthResult {
  try {
    const parsed = parseToken(token);
    if (isExpired(parsed.expiry)) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true, userId: parsed.userId };
  } catch (e) {
    return { valid: false, reason: 'parse-error' };
  }
}

export function summarize(token: string): string {
  const result = handleAuth(token);
  if (result.valid) {
    return `OK: user ${result.userId}`;
  }
  return `DENY: ${result.reason}`;
}
