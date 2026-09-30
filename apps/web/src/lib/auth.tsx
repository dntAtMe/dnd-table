import type { User } from '@dnd/protocol';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api } from './api';

interface AuthState {
  /** undefined while loading, null when signed out. */
  user: User | null | undefined;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api<{ user: User | null }>('/api/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => setUser(null));
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, setUser, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Renders children for signed-in users; otherwise sends them to sign in and back. */
export function RequireAuth({ children }: { children: (user: User) => ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (user === undefined) return <div className="page-loading">Loading…</div>;
  if (user === null) return <Navigate to={`/?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children(user)}</>;
}
