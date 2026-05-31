export interface ParsedToken {
  userId: string;
  expiry: number;
}

export function parseToken(token: string): ParsedToken {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new Error('Invalid token format');
  }
  return {
    userId: parts[0],
    expiry: parseInt(parts[1], 10),
  };
}

export function isExpired(expiry: number): boolean {
  return Date.now() > expiry * 1000;
}
