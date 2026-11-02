import { initializeApp } from 'firebase/app';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendEmailVerification, sendPasswordResetEmail, signOut, type Auth,
} from 'firebase/auth';

// Offline seam for E2E: mints the unsigned tokens the API's FIREBASE_TEST_MODE
// verifier accepts. Never enabled in production builds (the API also refuses
// the seam there, belt and braces).
export const FIREBASE_TEST_MODE = import.meta.env.VITE_FIREBASE_TEST_MODE === 'true';

const testToken = (email: string, verified: boolean) =>
  btoa(JSON.stringify({ uid: `e2e-${email.toLowerCase()}`, email: email.toLowerCase(), email_verified: verified }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let auth: Auth | null = null;
function firebaseAuth(): Auth {
  if (!auth) {
    const app = initializeApp({
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    });
    auth = getAuth(app);
  }
  return auth;
}

/** Map Firebase auth error codes to plain messages. */
export function authErrorMessage(err: any): string {
  switch (err?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong email or password.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists. Sign in instead.';
    case 'auth/weak-password':
      return 'Password is too weak - use at least 8 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'auth/invalid-email':
      return 'That email address is not valid.';
    default:
      return err?.message ?? 'Something went wrong. Try again.';
  }
}

/** Create the Firebase account and send the verification email. The account
 * cannot sign into TeamForm until the email is verified. */
export async function signUp(email: string, password: string): Promise<void> {
  if (FIREBASE_TEST_MODE) return;
  const a = firebaseAuth();
  const cred = await createUserWithEmailAndPassword(a, email, password);
  await sendEmailVerification(cred.user);
  await signOut(a);
}

/** Sign in and return the Firebase ID token to exchange with our API. */
export async function signIn(email: string, password: string): Promise<string> {
  if (FIREBASE_TEST_MODE) return testToken(email, true);
  const a = firebaseAuth();
  const cred = await signInWithEmailAndPassword(a, email, password);
  return cred.user.getIdToken();
}

/** Resend the verification email (requires the password to re-authenticate). */
export async function resendVerification(email: string, password: string): Promise<void> {
  if (FIREBASE_TEST_MODE) return;
  const a = firebaseAuth();
  const cred = await signInWithEmailAndPassword(a, email, password);
  if (!cred.user.emailVerified) await sendEmailVerification(cred.user);
  await signOut(a);
}

/** Firebase-hosted password reset: email delivery and the reset page are
 * handled by Firebase; the new password is the credential on next sign-in. */
export async function sendReset(email: string): Promise<void> {
  if (FIREBASE_TEST_MODE) return;
  await sendPasswordResetEmail(firebaseAuth(), email);
}
