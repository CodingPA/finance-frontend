// Backend auth client. Implements the token model from docs/authentication.md:
// access token in memory only, refresh token in localStorage, rotated on
// every refresh call. See that doc for the reasoning.

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";
const REFRESH_STORAGE_KEY = "refresh";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  initials: string;
  date_joined: string;
}

interface TokenPair {
  access: string;
  refresh: string;
}

interface AuthResponse extends TokenPair {
  user: AuthUser;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const detail =
      body && typeof body === "object" && "detail" in body && typeof (body as { detail?: unknown }).detail === "string"
        ? (body as { detail: string }).detail
        : "Request failed";
    super(detail);
    this.status = status;
    this.body = body;
  }
}

// In-memory only — never persisted, per the auth doc's recommendation.
let accessToken: string | null = null;

function authHeader(): HeadersInit {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

async function tryRefresh(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_STORAGE_KEY);
  if (!refresh) return false;

  const res = await fetch(`${API_BASE}/auth/token/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh }),
  });

  if (!res.ok) {
    localStorage.removeItem(REFRESH_STORAGE_KEY);
    accessToken = null;
    return false;
  }

  // Refresh tokens rotate on every call — the response's `refresh` must
  // overwrite the stored one, or the next refresh 401s.
  const data: TokenPair = await res.json();
  accessToken = data.access;
  localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh);
  return true;
}

/** Authenticated fetch with one silent-refresh-and-retry on 401. */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
        ...options.headers,
      },
    });

  let res = await doFetch();
  if (res.status === 401 && accessToken !== null) {
    const refreshed = await tryRefresh();
    if (refreshed) res = await doFetch();
  }
  return res;
}

export async function register(email: string, password: string, name?: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/register/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, ...(name ? { name } : {}) }),
  });
  const data = await parseJsonOrThrow<AuthResponse>(res);
  accessToken = data.access;
  localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh);
  return data.user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/login/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await parseJsonOrThrow<AuthResponse>(res);
  accessToken = data.access;
  localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh);
  return data.user;
}

export async function loginWithGoogle(idToken: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/auth/google/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id_token: idToken }),
  });
  const data = await parseJsonOrThrow<AuthResponse>(res);
  accessToken = data.access;
  localStorage.setItem(REFRESH_STORAGE_KEY, data.refresh);
  return data.user;
}

export async function fetchMe(): Promise<AuthUser> {
  const res = await apiFetch("/auth/me/");
  return parseJsonOrThrow<AuthUser>(res);
}

export async function logout(): Promise<void> {
  const refresh = localStorage.getItem(REFRESH_STORAGE_KEY);
  if (refresh) {
    await apiFetch("/auth/logout/", {
      method: "POST",
      body: JSON.stringify({ refresh }),
    }).catch(() => {
      // Best-effort: even if the blacklist call fails, clear local state
      // below so the UI always ends up logged out.
    });
  }
  accessToken = null;
  localStorage.removeItem(REFRESH_STORAGE_KEY);
}

/** Called once on app load: silently refresh, then hydrate the user. */
export async function bootstrapAuth(): Promise<AuthUser | null> {
  const refreshed = await tryRefresh();
  if (!refreshed) return null;

  try {
    return await fetchMe();
  } catch {
    accessToken = null;
    localStorage.removeItem(REFRESH_STORAGE_KEY);
    return null;
  }
}
