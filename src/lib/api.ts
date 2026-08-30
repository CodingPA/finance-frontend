// Backend auth client. Implements the token model from finance-backend/docs/authentication.md:
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
    super(extractErrorDetail(body));
    this.status = status;
    this.body = body;
  }
}

// Most errors are {detail: "..."}, some (e.g. the screen endpoint's "ticker
// not found") come back as a bare array of message strings, and DRF field
// validation (e.g. the assistant message endpoint's bad `ticker`) comes back
// as {field: ["..."]} -- fall through all three shapes before giving up.
function extractErrorDetail(body: unknown): string {
  if (Array.isArray(body) && typeof body[0] === "string") return body[0];
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.detail === "string") return obj.detail;
    for (const value of Object.values(obj)) {
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
  }
  return "Request failed";
}

// In-memory only — never persisted, per the auth doc's recommendation.
let accessToken: string | null = null;

/** Current access token, e.g. for the WebSocket handshake (`?token=`). */
export function getAccessToken(): string | null {
  return accessToken;
}

function authHeader(): HeadersInit {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/** Exported for reuse by other resource clients (e.g. lib/companies.ts). */
export async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Refresh the access token in place. Exported for the WebSocket client to
 *  reuse on a 4001 (stale token) close before it retries. */
export async function refreshAccessToken(): Promise<boolean> {
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

/** Authenticated fetch with one silent-refresh-and-retry on 401. Skips the
 *  default JSON content-type for a FormData body (e.g. file uploads) -- the
 *  browser needs to set its own multipart boundary, which it won't do if
 *  Content-Type is already present. */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const isFormData = options.body instanceof FormData;
  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        ...(isFormData ? {} : { "Content-Type": "application/json" }),
        ...authHeader(),
        ...options.headers,
      },
    });

  let res = await doFetch();
  if (res.status === 401 && accessToken !== null) {
    const refreshed = await refreshAccessToken();
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
  const refreshed = await refreshAccessToken();
  if (!refreshed) return null;

  try {
    return await fetchMe();
  } catch {
    accessToken = null;
    localStorage.removeItem(REFRESH_STORAGE_KEY);
    return null;
  }
}
