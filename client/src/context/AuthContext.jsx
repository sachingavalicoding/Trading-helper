import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => tokenStore.get());
  const [loading, setLoading] = useState(Boolean(tokenStore.get()));

  const logout = useCallback(() => {
    tokenStore.set(null);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
  }, [logout]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    api('/auth/me')
      .then((d) => alive && setUser(d.user))
      .catch(() => alive && logout())
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [token, logout]);

  const authenticate = useCallback(async (path, body) => {
    const d = await api(path, { method: 'POST', body });
    tokenStore.set(d.token);
    setToken(d.token);
    setUser(d.user);
    return d.user;
  }, []);

  const value = useMemo(
    () => ({
      user,
      token,
      loading,
      login: (email, password) => authenticate('/auth/login', { email, password }),
      register: (name, email, password) => authenticate('/auth/register', { name, email, password }),
      logout,
    }),
    [user, token, loading, authenticate, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
