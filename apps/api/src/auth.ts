import jwt from 'jsonwebtoken';
import { errors } from './errors.js';

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
};

export function signToken(userId: string): string {
  // 30d for local dev ergonomics; Supabase-issued tokens in prod carry their own exp.
  return jwt.sign({ sub: userId }, secret(), { expiresIn: '30d' });
}

export function verifyToken(token: string): string {
  try {
    const payload = jwt.verify(token, secret()) as jwt.JwtPayload;
    if (!payload.sub) throw new Error('no sub');
    return payload.sub;
  } catch {
    throw errors.unauthorized();
  }
}

/** Fastify preHandler: attaches req.userId or rejects 401. */
export async function authenticate(req: any, _reply: any) {
  const header = req.headers['authorization'] as string | undefined;
  if (!header?.startsWith('Bearer ')) throw errors.unauthorized();
  req.userId = verifyToken(header.slice(7));
}
