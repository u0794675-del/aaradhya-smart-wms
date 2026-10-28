import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  api,
  ApiError,
  setUnauthorizedHandler,
  type Meta,
  type User,
} from './api';
import { Icon, Spinner } from './ui';

interface AuthContextValue {
  user: User | null;
  meta: Meta | null;
  loading: boolean;
  can: (permission: string) => boolean;
  login: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refreshMeta: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setUnauthorizedHandler(() => {
      if (!cancelled) {
        setUser(null);
        setMeta(null);
      }
    });
    (async () => {
      try {
        const session = await api.get<{ user: User }>('/auth/me');
        const metadata = await api.get<Meta>('/meta');
        if (!cancelled) {
          setUser(session.user);
          setMeta(metadata);
        }
      } catch {
        if (!cancelled) {
          setUser(null);
          setMeta(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session = await api.post<{ user: User }>('/auth/login', { email, password });
    const metadata = await api.get<Meta>('/meta');
    setUser(session.user);
    setMeta(metadata);
    return session.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      // The local session is cleared even if the server session already expired.
    } finally {
      setUser(null);
      setMeta(null);
    }
  }, []);

  const refreshMeta = useCallback(async () => {
    const metadata = await api.get<Meta>('/meta');
    setMeta(metadata);
  }, []);

  const can = useCallback(
    (permission: string) => Boolean(user?.permissions.includes(permission)),
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, meta, loading, can, login, logout, refreshMeta }),
    [user, meta, loading, can, login, logout, refreshMeta],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export function FullPageLoader({ label = 'Opening your workspace…' }: { label?: string }) {
  return (
    <div className="full-loader">
      <div className="brand-mark">A</div>
      <Spinner label={label} />
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

export function RequirePermission({
  permission,
  children,
}: {
  permission: string | string[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  const allowed = Array.isArray(permission) ? permission.some((code) => can(code)) : can(permission);
  if (!allowed) return <AccessDenied permission={Array.isArray(permission) ? permission.join(' or ') : permission} />;
  return <>{children}</>;
}

export function AccessDenied({ permission }: { permission: string }) {
  return (
    <div className="page">
      <div className="access-denied card">
        <span className="access-denied-icon">
          <Icon name="lock" size={28} />
        </span>
        <h1>Access restricted</h1>
        <p>
          Your role does not include the <code>{permission}</code> permission, so this workspace is hidden. Ask an
          administrator if you need access. Every permission denial is audited.
        </p>
        <a className="btn btn-primary" href="/">
          Back to your workspace
        </a>
      </div>
    </div>
  );
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
