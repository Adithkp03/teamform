import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface AuthState {
  token: string | null;
  userId: string | null;
  login: (token: string, userId: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('tf_token'));
  const [userId, setUserId] = useState<string | null>(() => localStorage.getItem('tf_uid'));

  const login = (t: string, uid: string) => {
    localStorage.setItem('tf_token', t);
    localStorage.setItem('tf_uid', uid);
    setToken(t); setUserId(uid);
  };
  const logout = () => {
    localStorage.removeItem('tf_token');
    localStorage.removeItem('tf_uid');
    setToken(null); setUserId(null);
  };

  return <AuthContext.Provider value={{ token, userId, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
