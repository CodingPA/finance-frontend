# Security policy

## Reporting a vulnerability

Please report security issues privately rather than in a public issue: use
**Report a vulnerability** on this repository's
[Security tab](https://github.com/CodingPA/finance-frontend/security/advisories/new)
(GitHub's private vulnerability reporting).

Include what you found, how to reproduce it, and what an attacker could do
with it. This is a personal project maintained in spare time, so responses
are best-effort -- there's no bug bounty and no guaranteed response time.

## Scope

This repository is the browser client only. Issues in the API, server-side
auth, data-provider handling or the AI agents belong to
[finance-backend](https://github.com/CodingPA/finance-backend) -- report
those there the same way.

Known design decisions, not vulnerabilities on their own: the refresh token
is kept in `localStorage` and the access token in memory (see "Auth" in the
[README](README.md#auth)), and the WebSocket handshake passes the access
token as a `?token=` query parameter, as the backend requires. A report
showing a concrete way to steal either token is very much in scope.

## Supported versions

Only the latest commit on `main` gets fixes.
