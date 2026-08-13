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

## Deployment

`finance.codingpa.com`, served straight off the Vite build's `dist/` output
-- there's no Node process for the frontend to keep alive, so pm2 isn't
involved here (it's still what runs the Django backend, unaffected by any
of this). nginx serves `dist/` directly and reverse-proxies `/api` and
`/ws` to the backend on the same box (`localhost:8001`, reachable
separately at `finance-api.codingpa.com`) -- the same relative-path
convention `vite.config.ts`'s dev proxy uses, so the production build needs
no `VITE_API_BASE_URL` override. Deploys are manual: SSH in and run
`deploy.sh`.

### One-time server setup

1. **Deploy key** (the GitHub repo is private, so the server needs its own
   read-only key rather than your personal credentials):
   ```
   ssh-keygen -t ed25519 -C "finance-frontend-deploy" -f ~/.ssh/finance-frontend-deploy -N ""
   cat ~/.ssh/finance-frontend-deploy.pub
   ```
   Add that public key under the repo's **Settings -> Deploy keys** on
   GitHub (read-only is enough -- the server only ever pulls). Then point
   git at it:
   ```
   cat >> ~/.ssh/config <<'EOF'
   Host github.com-finance-frontend
       HostName github.com
       User git
       IdentityFile ~/.ssh/finance-frontend-deploy
       IdentitiesOnly yes
   EOF
   ```

2. **Clone** into the deploy user's home directory using that host alias
   (`deploy/nginx.conf`'s `root` already assumes this exact path -- update
   it too if the deploy user's name or home directory ever changes):
   ```
   git clone git@github.com-finance-frontend:CodingPA/finance-frontend.git ~/finance-frontend
   cd ~/finance-frontend
   chmod +x deploy.sh
   ```

3. **Production env file** -- `.env.production.local` is gitignored (same
   as `.env.local` in dev), so create it once directly on the server if you
   want Google sign-in working in production:
   ```
   echo "VITE_GOOGLE_CLIENT_ID=<your-prod-client-id>" > .env.production.local
   ```
   Leave it out (or blank) to ship with the Google button simply not
   rendering, same as dev. `VITE_API_BASE_URL` doesn't need setting -- the
   `/api` default is correct in production too, since nginx is doing the
   proxying.

4. **nginx site** -- copy `deploy/nginx.conf` in (fix the `root` path first
   if the deploy user's home directory isn't `/home/deploy`):
   ```
   sudo ln -s ~/finance-frontend/deploy/nginx.conf /etc/nginx/sites-available/finance.codingpa.com
   sudo ln -s /etc/nginx/sites-available/finance.codingpa.com /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d finance.codingpa.com
   ```
   `certbot` rewrites that file in place to add the HTTPS server block and
   HTTP->HTTPS redirect -- don't hand-write `ssl_certificate` lines
   yourself.

5. **First build** -- `deploy.sh` refuses to run against a dirty working
   tree, but a fresh clone is already clean, so just:
   ```
   ./deploy.sh
   ```

### Every deploy after that

```
ssh deploy@server '~/finance-frontend/deploy.sh'
```

`deploy.sh` does the whole thing: refuses to run if the checkout isn't
clean (this checkout should only ever move via `git pull` -- a dirty tree
means something unexpected happened and is worth investigating rather than
silently overwriting), hard-resets to `origin/main`, `npm ci`, then
`npm run build`. Nothing needs restarting afterward -- nginx reads
`dist/`'s files fresh on every request, so the moment the build finishes,
it's live.

**Rollback:** `git log` for the last-known-good commit, then
`git reset --hard <sha> && npm ci && npm run build` on the server (the
same steps `deploy.sh` runs, just pinned to an older commit instead of
`origin/main`).

## Status

Email/password login, registration, logout, session persistence, and a
protected route wrapper are in place. Not yet built: Google sign-in
end-to-end verification (needs a real client ID), and everything past the
auth shell (The Lab's screen/rank/deep-dive workflow).
