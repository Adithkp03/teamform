import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, clearTokens, getRefreshToken, getToken, storeTokens } from './api';
import { firebaseSignOut } from './firebaseClient';

interface AuthState {
  token: string | null;
  userId: string | null;
  login: (token: string, userId: string, refreshToken?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [userId, setUserId] = useState<string | null>(() => localStorage.getItem('tf_uid'));

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
    if (rt) {
      // Best-effort server-side revocation; local session ends regardless.
      api('/api/auth/logout', { method: 'POST', body: { refresh_token: rt } }).catch(() => {});
    }
    clearTokens();
    // End the Firebase browser session too (no-op for dev-login users).
    firebaseSignOut().catch(() => {});
  };

  return <AuthContext.Provider value={{ token, userId, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
