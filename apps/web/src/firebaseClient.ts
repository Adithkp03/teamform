import { initializeApp, getApps } from '@firebase/app';
import {
  getAuth, setPersistence, inMemoryPersistence, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendEmailVerification, sendPasswordResetEmail,
  signOut, type User,
} from '@firebase/auth';

// Public client configuration (shipped to browsers by design; not a secret).
// Overridable via VITE_FIREBASE_* env vars for previews/other projects.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'AIzaSyCaDpPZSSxnyt_o4Dar161rtu0JrGx3AWc',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'teamform-ac37a.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'teamform-ac37a',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '1:184568789325:web:f350e8f627575146ee9f04',
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const firebaseAuth = getAuth(app);
// Never persist the Firebase credential (IndexedDB/localStorage by default):
// the app session - an HttpOnly cookie - owns persistence, so the Firebase
// refresh token lives in memory only and is signed out right after the app
// exchange. Awaiting this before sign-in/up avoids a persistence race.
const persistenceReady = setPersistence(firebaseAuth, inMemoryPersistence).catch(() => {});

export async function firebaseSignIn(email: string, password: string): Promise<User> {
  await persistenceReady;
  const cred = await signInWithEmailAndPassword(firebaseAuth, email, password);
  return cred.user;
}

export async function firebaseSignUp(email: string, password: string): Promise<User> {
  await persistenceReady;
  const cred = await createUserWithEmailAndPassword(firebaseAuth, email, password);
  // Verification email comes from Firebase itself; the account cannot be
  // exchanged for app tokens until the address is verified (server-enforced).
  await sendEmailVerification(cred.user);
  return cred.user;
}

export async function firebaseResendVerification(user: User): Promise<void> {
  await sendEmailVerification(user);
}

export async function firebaseSendReset(email: string): Promise<void> {
  await sendPasswordResetEmail(firebaseAuth, email);
}

export async function firebaseSignOut(): Promise<void> {
  await signOut(firebaseAuth);
}

/** Fresh ID token + the session's Firebase refresh token for the app exchange. */
export async function firebaseTokens(user: User): Promise<{ idToken: string; refreshToken: string }> {
  await user.reload(); // pick up email_verified after the user clicks the link
  const idToken = await user.getIdToken();
  if (!user.refreshToken) throw new Error('Firebase did not return a refresh token; please sign in again');
  return { idToken, refreshToken: user.refreshToken };
}
