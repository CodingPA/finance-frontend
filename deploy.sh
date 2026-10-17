#!/usr/bin/env bash
# Deploy script for finance.codingpa.com. Run this ON THE SERVER, inside the
# cloned repo (or `ssh you@server 'cd /path/to/finance-frontend && ./deploy.sh'`
# from anywhere else). nginx serves dist/ directly -- see deploy/nginx.conf --
# so there's no process to restart here; a build that lands in dist/ is a
# live deploy the instant it finishes.
#
# One-time setup (deploy key, nginx site, certbot) is in README.md's
# "How the maintainer's instance is deployed" section, not this script.
# Pushes to main also run this automatically via .github/workflows/deploy.yml.

set -euo pipefail

# cd to the repo root regardless of where this script is invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Checking working tree is clean"
if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to deploy: uncommitted changes in $(pwd)." >&2
  echo "This checkout should only ever move via 'git pull' -- investigate before deploying." >&2
  exit 1
fi

echo "==> Pulling origin/main"
git fetch origin main
git reset --hard origin/main

echo "==> Installing dependencies (npm ci)"
npm ci

echo "==> Building with Node $(node -v) (tsc -b && vite build)"
npm run build

echo "==> Done: $(git rev-parse --short HEAD) built to dist/ at $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
