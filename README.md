# finance-frontend

Vite + React + TypeScript SPA for The Lab. Email/password and Google auth
against a separate Django backend (JWT access + refresh).

> This is a personal research tool. The paper trading league it displays
> simulates trades against live market prices -- it places **no real orders**,
> connects to no brokerage execution venue, and holds no real positions or
> money. Nothing produced by this software or the AI agents whose output it
> renders is investment advice or a recommendation to buy or sell any
> security. It ships with no warranty; see [LICENSE](LICENSE). Use at your own
> risk.

**This is the frontend only.** It needs the backend running to do anything past
the login screen — see [finance-backend](https://github.com/CodingPA/finance-backend) for its setup. The
two are separate repos with separate deploys, so nothing here builds or starts
the backend for you.

## Run it with Docker

```
docker compose up --build
```

Then open <http://localhost:8080>.

nginx inside the container serves the built bundle and forwards `/api` and
`/ws` to the backend, which keeps CORS out of the picture. It expects the
backend on `http://host.docker.internal:8001` — i.e. the backend's own
`docker compose` publishing port 8001 on your host. Override if it's elsewhere:

```
BACKEND_URL=http://192.168.1.20:8001 docker compose up --build
```

That's a runtime setting; repointing it is a restart, not a rebuild. If the
backend's compose only exposes 8001 on an internal Docker network rather than
publishing it to the host, `host.docker.internal` won't reach it and you'll
need to put both containers on a shared external network instead.

**Google sign-in** is optional and off by default. Enabling it means a rebuild,
because Vite inlines `VITE_*` vars into the bundle at build time:

```
VITE_GOOGLE_CLIENT_ID=<your-client-id> docker compose up --build
```

`FRONTEND_PORT` (default `8080`) changes the published port.

## Run it without Docker

```
npm install
cp .env.example .env.local   # fill in VITE_GOOGLE_CLIENT_ID if testing Google sign-in
npm run dev
```

The dev server proxies `/api/*` and `/ws/*` to `http://localhost:8001` (see
`vite.config.ts`) — same relative-path convention as the container. Run the
backend on port 8001 separately.

`npm run build` produces static output in `dist/`; `npm run lint` is
`tsc --noEmit`.

## Stack notes

- **Backend docs are in the other repo.** Source comments cite paths like
  `finance-backend/docs/league-api.md` and
  `finance-backend/docs/authentication.md` — those are relative to
  [finance-backend](https://github.com/CodingPA/finance-backend), not to this repo. `docs/` here holds
  only specs written *for* the backend from the frontend's side.

- **SPA, not SSR.** The auth model keeps the access token in memory and the
  refresh token in `localStorage` — that only works client-side, so Next.js
  or any server-rendered framework would fight it. Vite + React Router.
- **No CSS framework.** Styling comes entirely from the "Modernist" design
  system (`src/styles/modernist.css`, vendored from a Claude design
  project) — flat, Archivo type, red accent, zero border-radius. Build with
  its existing classes (`.btn`, `.field`, `.input`, `.card`, `.nav`, ...)
  rather than inventing new ones; `src/styles/app.css` holds only page-layout
  rules that aren't part of the design system itself.

## Auth

`src/lib/api.ts` implements the backend's token flow: register/login/google all
return `{access, refresh, user}`; `access` stays in memory, `refresh` goes to
`localStorage` and is overwritten on every rotation. `apiFetch` retries once on
a 401 via silent refresh. `src/context/AuthContext.tsx` wraps that in React
state and hydrates on app load (refresh -> `/api/auth/me/`).

**Google sign-in** is wired but untested end-to-end — it needs
`VITE_GOOGLE_CLIENT_ID` set here and the matching `GOOGLE_OAUTH_CLIENT_ID` set
on the backend. With no client ID configured, the Google button just doesn't
render.

## Status

Behind email/password login (with session persistence across reloads):

- **Dashboard** (`/`) — the companies you track, each with its latest screen
  summary and your pending/shortlisted/killed verdict.
- **Screener** (`/screen/:ticker`) — a ticker's financials and filings from
  the backend's screen, plus your research clips, thesis journal, linked
  Wikipedia pages and uploaded audio/video for transcription.
- **Social** (`/social`) — watched subreddits and the tickers the backend's
  scans found being discussed, with the posts behind each count.
- **League** (`/league`, `/league/competitors/:id`) — the paper trading
  league: standings, equity curves, positions, trades, and each AI
  competitor's wake-up transcripts.
- **Chat assistant** — a side panel on every page, with replies streamed
  over the realtime socket and a model picker grouped by provider.
- **Notifications** — the backend's notification feed, live over the same
  socket.

Not done yet: Google sign-in is wired but hasn't been verified end-to-end
(it needs a real client ID — see [Auth](#auth)). There are no automated
tests; CI runs the type-check and production build only.

## License

Copyright 2026 George Cann, CodingPA LLC.

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the
full text and [NOTICE](NOTICE) for the attribution notice that travels with
redistributions — same terms as
[finance-backend](https://github.com/CodingPA/finance-backend), chosen for the explicit patent grant and
for making contributions inbound-licensed without a separate CLA.

The License covers this source code only, not any data displayed through it —
see "Data sources and their terms" in
[finance-backend's README](https://github.com/CodingPA/finance-backend#readme).

---

## How the maintainer's instance is deployed

Everything below is specific to `finance.codingpa.com` and isn't needed to run
your own copy — the Docker path above is self-contained. It's kept here as a
worked example of a bare-metal deploy.

`deploy.sh` and `deploy/nginx.conf` are that setup, not user-facing entry
points: `deploy.sh` hard-resets the checkout to `origin/main`, and
`deploy/nginx.conf` hardcodes a domain, a deploy user's home directory and
certbot paths. The container uses a separate generic config
(`deploy/nginx.container.conf.template`); the two aren't interchangeable.

The site is served straight off the Vite build's `dist/` output — there's no
Node process for the frontend to keep alive, so pm2 isn't involved (it's still
what runs the Django backend). nginx serves `dist/` and reverse-proxies `/api`
and `/ws` to the backend on the same box (`localhost:8001`). Pushes to `main`
deploy automatically: once the build job in `.github/workflows/deploy.yml`
passes, its deploy job SSHes in and runs `deploy.sh`. That job is gated to
this repository, so it never runs on forks.

### One-time server setup

1. **Deploy key** (so the server has its own read-only credentials rather than
   a personal account's):
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
   if the deploy user's home directory isn't `/home/deployer`):
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

Merging to `main` is the deploy. The workflow connects with the
`DEPLOY_SSH_KEY` repository secret (an SSH private key for the deploy user)
to the host and user hardcoded in `.github/workflows/deploy.yml`, and runs
the same command you'd run by hand:

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
