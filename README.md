# `@jobmatchme/bee-web`

`bee-web` is the browser-facing adapter for the Bee Dance stack.

It exposes a small local HTTP/SSE API for `bee-dashboard`, forwards turns to
Bee compatible workers through `@jobmatchme/bee-gate` and NATS, and can proxy
read-only history from `fabee-log-read-api` for the authenticated web user.

## Design intent

`bee-web` is intentionally thin, analogous to `bee-slack`:

- browser/API specific concerns live here
- Bee Dance gateway behavior stays in `@jobmatchme/bee-gate`
- agent execution stays in the worker, e.g. `Fabee-pi-agent`
- durable agent context stays on the worker PVC for the MVP

## Local development

Copy the example config and adjust the worker subject if needed:

```bash
cp local.config.example.json local.config.json
```

Port-forward NATS from the cluster:

```bash
kubectl -n nats port-forward svc/nats 4222:4222
```

Optional for history development:

```bash
kubectl -n ai-agents port-forward svc/fabee-pi-agent 8080:8080
export BEE_WEB_HISTORY_API_BASE_URL=http://127.0.0.1:8080
export BEE_WEB_HISTORY_API_BEARER_TOKEN=dev-token
```

Install dependencies and start the adapter:

```bash
npm install
npm run dev -- ./local.config.json
```

## Auth and session ids

For deployed web routes, `bee-web` now reads authenticated email headers like
`X-Forwarded-Email` / `X-Auth-Request-Email`, derives `userKey` server-side via
`email.replace(/@jobmatch.me$/, "").replace(/[^a-zA-Z0-9:_-]/g, "_")`, and can
mint user-scoped session ids like:

```txt
fabee-pi-agent:web:<userKey>:<uuid>
```

The browser no longer needs to choose `userKey`.

## HTTP/SSE API

```txt
GET  /health
GET  /api/routes
GET  /api/sessions
POST /api/sessions
GET  /api/sessions/:sessionId
PUT  /api/sessions/:sessionId/collaborators
POST /api/sessions/:sessionId/archive
GET  /api/sessions/:sessionId/events
POST /api/sessions/:sessionId/messages
POST /api/sessions/:sessionId/runs/:turnId/cancel
GET  /api/sessions/:sessionId/artifacts/:artifactId/download
GET  /api/history/sessions
GET  /api/history/sessions/:sessionId
GET  /api/history/sessions/:sessionId/runs
```

History endpoints proxy `fabee-log-read-api` with the current authenticated
user only.

SSE sends a named `snapshot` event on connect/reconnect plus live `status` events (`waiting`, `running`, `completed`, `failed`, `cancelled`).

## MVP scope

Included:

- route allowlist for worker subjects
- local HTTP API
- SSE streaming to the browser
- stateless session id generation
- optional authenticated history proxying

Not included yet:

- database persistence
- first-party login flow
- file uploads
- SSE replay after reload
