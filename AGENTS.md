# AGENTS.md — Contributor & AI Coding Agent Guide

Guidelines for AI coding agents and contributors working on **AI Gateway**.

## Project Overview

Self-hosted, OpenAI-compatible AI Gateway built on **Node.js ≥ 22 (ESM)**, **Hono**, **SQLite (`better-sqlite3`)**, and a **zero-build vanilla JS/CSS dashboard**.

- **UI & code comments**: Bahasa Indonesia (preserve this convention across `src/` and `public/`). Public `README.md` and `AGENTS.md` are in English.
- **No frontend framework or bundler**: `public/` is served directly with content-hash cache busting (`src/assets.js`). Do not introduce React/Vite/Webpack without explicit approval.

## Repository Map

```
src/
  server.js          Hono app: /v1/* routes, /models.md, /openapi.json, /docs, dashboard static & TLS
  proxy.js           Core proxy: auth, endpoint validation, routing, fill-first key pool, streaming,
                     reasoning_content emission, /v1/audio/transcriptions adapter, cost & logging
  admin.js           /api/admin/*: auth, providers, keys, models, directory (models.dev), custom import,
                     OAuth flows, stats, logs, settings, dashboard /chat
  keypool.js         Encrypted provider_keys pool (fill-first), per-(key, model) cooldowns,
                     429 reset timestamp parsing, quota-based auto-cooldown cache
  catalog.js         Single source of truth: built-in presets, publicModelId(),
                     supportedEndpointsFor(), inputModalitiesFor(), formatModelObject()
  modelsdev.js       Live models.dev/api.json client + 12h cache (300+ OpenAI-compatible providers)
  openapi.js         Dynamic OpenAPI 3.1.0 spec (/openapi.json) & Scalar UI (/docs)
  modelsmd.js        Public Markdown catalog (/models.md) — user-facing only, no internal details
  db.js              SQLite schema, migrations, settings
  crypto.js          AES-256-GCM encrypt/decrypt (APP_SECRET), sha256, session signing
  credimport.js      Optional local desktop credential reader (Codex auth.json / Windows Credential Manager)
  assets.js          Content-hash asset versioning (?v=hash)
  realtime.js        WebSocket realtime audio transcription proxy
  adapters/
    codex.js         ChatGPT Codex OAuth adapter (Responses SSE, reasoning, Native/SSE image gen, usage)
    antigravity.js   Google Antigravity OAuth adapter (Cloud Code, resolveWireModel, multimodal inputs,
                     reasoning, image gen, usage)
public/
  index.html, app.js, ui.js, style.css, icons.css, icons/, fonts/
scripts/
  e2e-test.mjs       Full end-to-end test suite (mock upstream + temp SQLite DB)
  build-icons.mjs    Bundles public/icons/ui-*.svg -> public/icons.css
  create-key.js      CLI helper to create a gateway API key
  probe-subs.mjs     Read-only subscription quota/model probe
```

## Key Architectural Invariants

1. **Single source of truth for capabilities**:
   - `supportedEndpointsFor(row)`, `inputModalitiesFor(row)`, and `formatModelObject(row)` in `src/catalog.js` drive `GET /v1/models`, `GET /v1/models/{model}`, endpoint validation in `src/proxy.js`, and `GET /models.md`.
   - Unsupported `(model, endpoint)` pairs MUST return `400` OpenAI-style JSON (`code: "unsupported_endpoint"`, `param: "model"`). Unknown `/v1/*` routes MUST return `404` JSON (never redirect to HTML).
2. **Public vs. internal separation**:
   - Never expose `upstream_model`, `base_url`, `auth_type`, or raw tokens in `/v1/models`, `/v1/models/{model}`, `/models.md`, or logs.
3. **Fill-first pooling**:
   - `usableKeys(providerId, model)` orders by `priority, id` (fill-first, not round-robin) to preserve upstream prompt cache hit rates.
4. **Streaming safety (Node.js Web Streams)**:
   - In `subscriptionChat` (`src/proxy.js`), `ReadableStream.pull()` MUST loop (`while (true)`) until at least one client chunk is enqueued or upstream ends — returning from `pull()` without enqueuing stalls the stream on Node 22+.
5. **Security & Secrets**:
   - Never hardcode OAuth client secrets, API keys, or personal emails/domains in source files. Read secrets from `.env` (`process.env`).
   - Do not use `data-copy` attributes in `public/` for anything other than copy-to-clipboard (`public/ui.js` attaches a global click handler).

## Commands & Verification

```bash
npm start            # Start gateway (default http://localhost:8787)
npm test             # Run all e2e tests (scripts/e2e-test.mjs) — must pass 100%
node --check <file>  # Quick syntax check before running tests
node scripts/build-icons.mjs   # Rebuild public/icons.css after adding public/icons/ui-*.svg
```

### Before Finishing Any Change

1. Run `node --check` on every modified JS/MJS file.
2. Run `npm test` and add regression tests in `scripts/e2e-test.mjs` for new routes, adapters, or bug fixes.
3. Keep `src/openapi.js`, `src/modelsmd.js`, and `README.md` aligned when adding or changing public endpoints.
4. Check `git status` and `git diff` to ensure no secrets, `.env`, `data/`, `logs/`, or temporary files are staged.
