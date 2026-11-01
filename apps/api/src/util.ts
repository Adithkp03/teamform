import { z } from 'zod';
import { errors } from './errors.js';

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw errors.badRequest(`${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return result.data;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // Crockford base32, no ambiguous chars
/** 10 chars from a 32-char alphabet = 50 bits of entropy. Combined with per-user
 *  rate limits and expiry, brute force is not practical (see design doc). */
export function genInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join('');
}
