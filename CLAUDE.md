# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commands

Bun monorepo, **bun only** (never npm). Workspaces: `server`, `web`, `extension`, `packages/shared` (zod contracts + env schema), `packages/client` (typed API client used by web and extension).

```bash
bun install --frozen-lockfile
bun run dev:server       # Express API on :3000 (bun --watch src/index.ts)
bun run dev:web          # Vite web app on :5173
bun run dev:extension    # Vite watch build into extension/dist
bun run dev:all          # all of the above
bun run check            # lint + typecheck + tests + build, every workspace — run before committing
bun run --cwd <server|web|extension|packages/shared|packages/client> test:coverage   # vitest; CI gate is 100% on all four metrics
bun run --cwd server eval            # retrieval / concept-merge eval (needs GEMINI_API_KEY)
bun run --cwd server reembed -- --dry-run   # migrate stored vectors to the current embedding model
bun run --cwd extension test         # vitest + jsdom (was bun:test; bun coverage ignored unimported files)
```

Health check: `curl http://localhost:3000/health`

## Environment

`server/.env` (see `server/.env.example`): `GEMINI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_PROJECT_ID`, `ALLOWED_ORIGINS`. Optional: `GEMINI_MODEL`, `GEMINI_FAST_MODEL`, `GEMINI_EMBEDDING_MODEL`, `RAG_MAX_COSINE_DISTANCE` (0.6), `CONCEPT_MATCH_MAX_DISTANCE` (0.15), `TRUST_PROXY`, `RATE_LIMIT_STORE` (`memory`|`firestore`), `RATE_LIMIT_IP_PER_MINUTE` (120), `RATE_LIMIT_AI_PER_MINUTE` (20).

Model defaults live in `packages/shared/src/env/server.ts`: primary `gemini-3.1-pro-preview`, fast `gemini-3.8-flash`, embeddings `gemini-embedding-2` (verified 2026-09-24). **Web-search before changing any model name** — text-embedding-004 and gemini-2.0-flash are already shut down.

`web/.env.local`, `extension/.env`: `VITE_FIREBASE_*` + `VITE_API_URL` (see the `.env.example` files). Never hardcode Firebase config.

## Architecture

**`server/`** — TypeScript, Express 5. `src/index.ts` → `src/app.ts`; routes under `/api/v1` (`src/routes/index.ts`). Gemini access goes through `src/ai/geminiProvider.ts` (model aliases `primary`/`fast`, batching, retry on 429/503). Logging: pino `logger` — never `console.log`.

**`web/`** — React 19 + Vite + TypeScript. Plain React state + `lib/api.ts` (wraps `@study-flow/client`); auth context in `lib/auth.tsx`. Concept graph is **Cytoscape** (`pages/Dashboard.tsx`): fill = accuracy, border colour + shape = dominant error type.

**`extension/`** — Chrome MV3, React 19 + Vite (TS + JSX). `src/background.ts` (service worker; drill badge via `chrome.alarms`), `src/content.ts` (Brightspace/Gradescope extraction), `src/sidepanel/` (SPA). Auth: `chrome.identity` → Firebase; token kept in `chrome.storage.session`.

### Question pipeline (`/analyze`, `/explain`, `/stream/explain`)
1. `retrieveChunkRecords` (`services/rag.ts`) — embed query, Firestore `findNearest` per course in parallel (COSINE, distance ≤ `RAG_MAX_COSINE_DISTANCE`).
2. Explain with the primary model, personalised by `getStudentProfile`; context carries `[n] (from file)` citations and responses return `sources`.
3. `recordQuestionInteraction` (`services/interactions.ts`) — classify, canonicalise the concept (`services/concepts.ts`: exact id → nearest `smg.labelEmbedding` ≤ 0.15 → new node), `recordInteraction`, save event, invalidate cache. `/explain` does this after responding; the others await it.
4. `recordActivity` (`services/gamification.ts`) — one awaited transaction for XP, quiz count and UTC streak.

### SMG + scheduling
`users/{uid}/smg/{conceptNode}` (snake_case ids). FSRS via ts-fsrs in `services/scheduler.ts` (retention 0.9). Grades: correct → Good, wrong → Again, question with a confident (≥0.5) misconception → Again, any other question → schedule unchanged. `recordInteraction` is a transaction; nodes without `fsrs` are legacy SM-2 and keep their due date until the first graded review. Drill order (`drillPriority`): due reviews, then new concepts, then not-yet-due reviews. Graph responses are projected by `services/graphView.ts` — never return raw SMG docs (they hold 768-float label embeddings).

### Ingestion
`services/chunking.ts` (heading-aware, ~900/1500 chars) → `ingestText` embeds, replaces chunks from the same source, tags `embeddingModel`/`embeddingDim`/`sourceKey`. RAG drops chunks from other embedding models; run `reembed` after a model change.

### Firestore
```
users/{uid}
  ├── courses/{courseId}/files/{fileId}, chunks/{chunkId} (content, embedding vector, embeddingModel, sourceKey)
  ├── events/{eventId}
  ├── smg/{conceptNode}      accuracyRate, interactionCount, errorTypeMap, fsrs, nextReviewDate, labelEmbedding, courseId
  ├── quizSessions/{id}      server-held answers, 30 min expiry
  └── gamification/stats     xp, streak, lastActivityDate, quizCount, unlockedAchievements
rateLimits/{key}             only with RATE_LIMIT_STORE=firestore (TTL on expireAt)
```
Vector indexes: `firestore.indexes.json`. Deploy order: `firebase deploy --only firestore:indexes` → server → `reembed`.

### Rate limits and caching
`apiLimiter` per IP before auth; `aiLimiter` per uid after `requireFirebaseAuth` on Gemini-backed routes — keep that order when adding routes. `services/cache.ts` is per process (staleness ≤ TTL across instances).

### Tests / CI
Vitest mocks Firebase Admin and Gemini; no credentials needed. When a route gains a middleware export, update the `vi.mock("../middleware/rateLimit")` factories in route tests. Response fields must be added to the zod schemas in `packages/shared/src/contracts/api.ts` or clients silently lose them. CI (bun 1.3.11): lint, test-server (coverage), build, security (`bun audit`).
