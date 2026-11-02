import admin from 'firebase-admin';
import { errors } from './errors.js';

export interface FirebaseIdentity {
  uid: string;
  email?: string;
  email_verified?: boolean;
}

// Injectable seams for unit tests. Never set in production code paths.
let testVerifier: ((idToken: string) => Promise<FirebaseIdentity>) | null = null;
let testRevocation: ((uid: string) => Promise<number | null>) | null = null;

export function setFirebaseTestHooks(
  verifier: ((idToken: string) => Promise<FirebaseIdentity>) | null,
  revocation: ((uid: string) => Promise<number | null>) | null = null,
) {
  testVerifier = verifier;
  testRevocation = revocation;
}

const prodLike = () => Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';

// Offline seam for local/E2E runs (unsigned base64url JSON tokens). It is
// hard-refused in any production-like environment - Vercel always sets
// VERCEL=1 - so it cannot be enabled there by accident or by a stray env var.
function testModeAllowed(): boolean {
  return process.env.FIREBASE_TEST_MODE === 'true' && !prodLike();
}

export async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseIdentity> {
  if (testVerifier) return testVerifier(idToken);
  if (process.env.FIREBASE_TEST_MODE === 'true') {
    if (!testModeAllowed()) throw new Error('FIREBASE_TEST_MODE is forbidden in production');
    try {
      return JSON.parse(Buffer.from(idToken, 'base64url').toString('utf8')) as FirebaseIdentity;
    } catch {
      throw errors.unauthorized();
    }
  }
  const auth = adminAuth();
  try {
    const decoded = await auth.verifyIdToken(idToken);
    return { uid: decoded.uid, email: decoded.email, email_verified: decoded.email_verified };
  } catch {
    throw errors.unauthorized();
  }
}

// Seconds since epoch before which Firebase credentials/sessions were revoked
// (password change/reset or explicit revocation). null when the lookup is not
// available (test seam, or Admin not configured) - callers decide policy.
export async function firebaseTokensValidAfter(uid: string): Promise<number | null> {
  if (testRevocation) return testRevocation(uid);
  if (process.env.FIREBASE_TEST_MODE === 'true') {
    if (!testModeAllowed()) throw new Error('FIREBASE_TEST_MODE is forbidden in production');
    return null;
  }
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const user = await adminAuth().getUser(uid);
    return user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) / 1000 : null;
  } catch {
    return null;
  }
}

let app: admin.app.App | null = null;
function adminAuth(): admin.auth.Auth {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!sa) {
    throw errors.unavailable('firebase_not_configured', 'Sign-in is not configured on this deployment');
  }
  if (!app) {
    app = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)) });
  }
  return admin.auth(app);
}
