import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, clearTokens, getRefreshToken, getToken, refreshAccessToken, storeTokens } from './api';
import { firebaseSignOut } from './firebaseClient';

interface AuthState {
  token: string | null;
  userId: string | null;
  restoring: boolean;
  login: (token: string, userId: string, refreshToken?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [userId, setUserId] = useState<string | null>(() => localStorage.getItem('tf_uid'));
  // Cookie sessions carry no JS-readable token: after a wipe of localStorage
  // (or any boot without an access token) the app would look logged out even
  // though the HttpOnly cookie is still valid. When the non-secret tf_sess
  // flag says a cookie session exists, silently refresh once before the
  // router decides - flagged users keep their session, anonymous users go
  // straight to sign-in with no extra request.
  const [restoring, setRestoring] = useState(() => !getToken() && localStorage.getItem('tf_sess') === '1');
  useEffect(() => {
    if (!restoring) return;
    let alive = true;
    refreshAccessToken().finally(() => { if (alive) setRestoring(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The api client rotates the access token on 401s; stay in sync.
  useEffect(() => {
    const sync = () => { setToken(getToken()); setUserId(localStorage.getItem('tf_uid')); };
    window.addEventListener('tf-auth-changed', sync);
    return () => window.removeEventListener('tf-auth-changed', sync);
  }, []);

  const login = (t: string, uid: string, refreshToken?: string) => {
    storeTokens(t, uid, refreshToken);
  };
  const logout = () => {
    const rt = getRefreshToken();
    // Best-effort server-side revocation: the legacy body token if one is
    // still stored, plus the HttpOnly session cookie (sent automatically);
    // the local session ends regardless.
    api('/api/auth/logout', { method: 'POST', body: rt ? { refresh_token: rt } : {} }).catch(() => {});
    clearTokens();
    // End the Firebase browser session too (no-op for dev-login users).
    firebaseSignOut().catch(() => {});
  };

  return <AuthContext.Provider value={{ token, userId, restoring, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
