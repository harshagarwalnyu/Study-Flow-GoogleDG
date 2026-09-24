# Architecture -- Study Flow

System overview (updated 2026-09-24). Flow-level detail, the FSRS rules and the data model are in [DESIGN.md](DESIGN.md); request/response shapes are in [server/API.md](../server/API.md) and `packages/shared/src/contracts/api.ts`.

---

## High-Level Overview

```
+---------------------+     +----------------------+
|  Chrome Extension   |     |       Web App        |
|  (MV3 side panel)   |     |  (React 19 + Vite)   |
|  Ask / Quiz / Graph |     |  Landing, auth,      |
|  auto-ingest,       |     |  dashboard (Cytoscape|
|  due-review badge   |     |  concept graph)      |
+----------+----------+     +-----------+----------+
           |   Firebase ID token (Bearer)|
           +--------------+--------------+
                          v
              +-----------------------+
              |  Express 5 API (TS)   |
              |  per-IP + per-user    |
              |  rate limits          |
              +-----------+-----------+
                          |
       +------------------+-------------------+
       v                  v                   v
 Gemini API          Firestore            Cloud Vision
 3.1 Pro (explain,   SMG, chunks +        (OCR)
 quiz), 3.8 Flash    vector indexes,
 (classify),         events, sessions,
 embedding-2 (768)   gamification
```

Model defaults: `packages/shared/src/env/server.ts` (verified 2026-09-24).

---

## Component Responsibilities

### Chrome Extension (`extension/`)

| Component | File | Role |
|-----------|------|------|
| Background worker | `src/background.ts`, `src/lib/background-runtime.ts` | Side panel, message bridge, ingestion calls |
| Drill nudge | `src/lib/drill-nudge.ts` | Toolbar badge with due-review count (hourly `chrome.alarms`, sign-in changes, after quiz answers) |
| Content script | `src/content.ts` | Brightspace/Gradescope text + PDF extraction, highlighted-selection capture |
| Side panel | `src/sidepanel/` | Ask (with citations + "For you" callout), Quiz, My Graph |
| Auth | `src/lib/auth.tsx` | `chrome.identity` → Firebase credential; ID token in `chrome.storage.session` |

### Web App (`web/`)

| Component | File | Role |
|-----------|------|------|
| Auth context | `src/lib/auth.tsx` | Firebase Auth (Google + email/password) |
| API wrapper | `src/lib/api.ts` | Wraps `@study-flow/client` with the Bearer token |
| Dashboard | `src/pages/Dashboard.tsx` | Concept graph (fill = accuracy, border + shape = dominant error type), drill queue, history, ingestion |

### Shared packages

| Package | Role |
|---------|------|
| `packages/shared` | zod API contracts and env schema (single source of response shapes) |
| `packages/client` | Typed API client used by web and extension |

### Backend (`server/src`)

| Subsystem | Files | Role |
|-----------|-------|------|
| Middleware | `middleware/auth.ts`, `rateLimit.ts`, `firestoreRateLimitStore.ts` | Token verification; `apiLimiter` per IP, `aiLimiter` per uid (optional shared Firestore store) |
| Gemini access | `ai/geminiProvider.ts`, `services/gemini.ts` | Model aliases, embedding batches, retry; explain / classify / quiz prompts |
| Question pipeline | `routes/analyze.ts`, `explain.ts`, `stream.ts`, `services/interactions.ts` | RAG → explain → classify → canonicalise → SMG → event |
| Retrieval | `services/rag.ts`, `services/embeddings.ts` | Query embedding, per-course `findNearest` in parallel, distance cutoff, model filter |
| Ingestion | `routes/ingest.ts`, `services/ingestion.ts`, `services/chunking.ts` | Heading-aware chunks, embed-then-write, same-source replacement |
| Concepts | `services/concepts.ts` | Label canonicalisation by label embedding |
| SMG + scheduling | `services/misconception.ts`, `services/scheduler.ts`, `services/graphView.ts` | FSRS updates in a transaction, drill ordering, projected graph views |
| Quiz | `routes/quiz.ts` | Generation from weak concepts; server-held answer keys; grading |
| Gamification | `services/gamification.ts` | `recordActivity` transaction (XP, streak), achievements |
| Eval / ops | `eval/`, `scripts/reembed.ts` | Retrieval + concept-merge evaluation; vector migration |

---

## Key Flows (summary)

1. **Ask**: embed question → vector search over course chunks → primary model explains using cited chunks and the student's weak concepts → fast model classifies concept + error type → concept merged with an existing node when close → FSRS updates the node if the question revealed a misconception → event saved → XP/streak.
2. **Quiz**: weakest/due concepts → questions generated from course chunks → answer keys kept server-side (30 min) → answers graded → FSRS Good/Again → badge refresh.
3. **Ingest**: page text or upload (OCR as needed) → chunks → embeddings → Firestore, replacing the source's earlier chunks → discovered concepts seeded as new SMG nodes.
4. **Review**: drill queue = due reviews (most forgotten first), then new concepts, then not-yet-due reviews.

Details: [DESIGN.md §3–6](DESIGN.md).

---

## Authentication

```
Extension: chrome.identity.getAuthToken() → GoogleAuthProvider.credential(null, token)
           → signInWithCredential → Firebase ID token
Web:       signInWithPopup(Google) | signInWithEmailAndPassword → Firebase ID token
Backend:   Authorization: Bearer <token> → auth.verifyIdToken → req.user
```

---

## Security Model

- **Data isolation**: all data under `users/{uid}/`; every route verifies the Firebase token.
- **Rate limiting**: per-IP guard on all routes; per-user limit on Gemini-backed routes. Set `TRUST_PROXY` behind a load balancer.
- **Quiz integrity**: answer keys never leave the server.
- **Embeddings stay server-side**: graph responses are projected with Firestore `select`.
- **No stored site credentials**: the extension reads pages in the user's existing session.
- **Config**: Firebase web config comes from `VITE_FIREBASE_*` env vars, never source (see the `.env.example` files).

---

## Scaling Notes

- Rate limit: `RATE_LIMIT_STORE=firestore` makes the per-user AI limit exact across instances (enable TTL on `rateLimits.expireAt`).
- Cache (`services/cache.ts`) is per process; cross-instance staleness is bounded by TTL (≤ 60 s for graph/drill). Use session affinity.
- `/explain` records the interaction after responding; on runtimes that throttle CPU after a response, move that to a task queue.

## Environment Variables

See `server/.env.example`, `web/.env.example`, `extension/.env.example`, and [DESIGN.md §14](DESIGN.md#14-environment-variables).

## Deploy Order

`firebase deploy --only firestore:indexes` → deploy the server → `bun run --cwd server reembed`.
