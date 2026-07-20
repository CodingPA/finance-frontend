# finance-frontend

Vite + React + TypeScript SPA for The Lab. Talks to the Django backend
described in `docs/api-endpoints.md` and `docs/authentication.md` (email/password
and Google auth, JWT access + refresh).

## Stack notes

- **SPA, not SSR.** The auth model keeps the access token in memory and the
  refresh token in `localStorage` — that only works client-side, so Next.js
  or any server-rendered framework would fight it. Vite + React Router.
- **No CSS framework.** Styling comes entirely from the "Modernist" design
  system (`src/styles/modernist.css`, vendored from the linked Claude design
  project) — flat, Archivo type, red accent, zero border-radius. Build with
  its existing classes (`.btn`, `.field`, `.input`, `.card`, `.nav`, ...)
  rather than inventing new ones; `src/styles/app.css` holds only page-layout
  rules that aren't part of the design system itself.

## Getting started

```
npm install
cp .env.example .env.local   # fill in VITE_GOOGLE_CLIENT_ID if testing Google sign-in
npm run dev
```

The dev server proxies `/api/*` to `http://localhost:8001` (see
`vite.config.ts`), matching the relative-path calls shown in the backend
docs. Run the Django backend on port 8001 separately.

## Auth

`src/lib/api.ts` implements the token flow from `docs/authentication.md`:
register/login/google all return `{access, refresh, user}`; `access` stays
in memory, `refresh` goes to `localStorage` and is overwritten on every
rotation. `apiFetch` retries once on a 401 via silent refresh.
`src/context/AuthContext.tsx` wraps that in React state and hydrates on app
load (refresh -> `/api/auth/me/`).

**Google sign-in** is wired but untested — it needs `VITE_GOOGLE_CLIENT_ID`
set here and the matching `GOOGLE_OAUTH_CLIENT_ID` set on the backend. With
no client ID configured, the Google button just doesn't render.

## Status

Email/password login, registration, logout, session persistence, and a
protected route wrapper are in place. Not yet built: Google sign-in
end-to-end verification (needs a real client ID), and everything past the
auth shell (The Lab's screen/rank/deep-dive workflow).
