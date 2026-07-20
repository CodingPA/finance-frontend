import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import type { AuthUser } from "../lib/api";
import { realtime } from "../lib/ws";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  useEffect(() => {
    let cancelled = false;
    api.bootstrapAuth().then((hydratedUser) => {
      if (cancelled) return;
      setUser(hydratedUser);
      setStatus(hydratedUser ? "authenticated" : "unauthenticated");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The realtime socket needs the same token the HTTP client holds, so it
  // only ever connects once auth is settled -- and drops the moment we're not.
  useEffect(() => {
    if (status === "authenticated") {
      realtime.connect();
    } else {
      realtime.disconnect();
    }
  }, [status]);

  const login = useCallback(async (email: string, password: string) => {
    const loggedInUser = await api.login(email, password);
    setUser(loggedInUser);
    setStatus("authenticated");
  }, []);

  const register = useCallback(async (email: string, password: string, name?: string) => {
    const registeredUser = await api.register(email, password, name);
    setUser(registeredUser);
    setStatus("authenticated");
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string) => {
    const loggedInUser = await api.loginWithGoogle(idToken);
    setUser(loggedInUser);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  return (
    <AuthContext.Provider value={{ user, status, login, register, loginWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
