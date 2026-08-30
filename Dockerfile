# Two stages: Node builds the Vite bundle, nginx serves the result. Nothing
# Node-related survives into the final image -- the frontend is static files,
# so there's no process that needs to stay running to hand them back.

FROM node:20-alpine AS build
WORKDIR /app

# Manifests first, so the dependency install layer caches independently of
# source edits.
COPY package.json package-lock.json ./
RUN npm ci

# Vite inlines VITE_* vars at build time, which is why this is a build arg and
# not a runtime env var: changing it needs `docker compose up --build`, not a
# restart. Left blank, the Google sign-in button simply doesn't render (see
# src/components/GoogleButton.tsx).
ARG VITE_GOOGLE_CLIENT_ID=""
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

# VITE_API_BASE_URL is deliberately not a build arg. It defaults to the
# relative "/api" (src/lib/api.ts), and nginx in the next stage proxies that to
# the backend -- so the backend's address stays a runtime value (BACKEND_URL)
# instead of being frozen into the bundle.

COPY . .
# `npm run build` is `tsc -b && vite build` -- a type error fails the image build.
RUN npm run build

FROM nginx:alpine

# nginx:alpine's stock entrypoint runs envsubst over /etc/nginx/templates/*.template
# at container start. NGINX_ENVSUBST_FILTER restricts that to BACKEND_URL;
# without it, nginx's own $host / $remote_addr / $http_upgrade variables in the
# template would be substituted away to empty strings.
ENV NGINX_ENVSUBST_FILTER=BACKEND_URL
ENV BACKEND_URL=http://host.docker.internal:8001

COPY deploy/nginx.container.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
