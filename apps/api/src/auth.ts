import jwt, { type SignOptions } from 'jsonwebtoken';
import { errors } from './errors.js';

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
};

export function signToken(userId: string, expiresIn: SignOptions['expiresIn'] = '7d'): string {
  return jwt.sign({ sub: userId, iss: 'teamform-api' }, secret(), { expiresIn });
}

export function verifyToken(token: string): string {
  try {
    const payload = jwt.verify(token, secret(), { issuer: 'teamform-api' }) as jwt.JwtPayload;
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
