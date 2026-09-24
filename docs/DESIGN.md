# Study Flow — Design Document

*AI Study Companion · Team of 4 · Built on Google*

> **Audience**: developers contributing to this repo. For the full product pitch see `AI_Companion_Design_Doc_v3.md`.

---

## 1. Product Vision

Study Flow is a Chrome MV3 extension + React web app that builds a persistent model of each student's misconceptions and uses spaced repetition to fix them — **without asking the student to do anything extra**.

**Three core innovations vs. ChatGPT / NotebookLM:**

| Feature | Study Flow | ChatGPT | NotebookLM | Anki |
|---------|-----------|---------|------------|------|
| Knows your syllabus | Auto (content script) | No | Manual | No |
| Tracks misconceptions | Yes (SMG + FSRS) | No | No | Manual |
| Professor-style quizzes | Yes (weighted by weakness) | Generic | No | Manual |
| Lives in browser | Side panel | New tab | New tab | Separate app |
| Grows smarter over time | Yes | Resets per chat | Static | Manual |

**Target users**: university students on Brightspace or Gradescope, taking STEM courses.

---

## 2. System Architecture

```
Brightspace / Gradescope page
    │  extension/src/content.ts (extract page text / PDFs)
    ▼  POST /api/v1/ingest/text | /ingest/upload
┌──────────────────────────────────────────────────────────────┐
│ Express 5 API (TypeScript, port 3000)                        │
│  apiLimiter (per IP) → requireFirebaseAuth → aiLimiter (uid) │
│                                                              │
│  /analyze, /explain, /stream/explain                         │
│     RAG (findNearest) → explain (primary) → classify (fast)  │
│     → resolve concept → FSRS update → event → recordActivity │
│  /quiz → weakest concepts → generateQuiz → server-held keys  │
│  /quiz/answer → grade → FSRS update → recordActivity         │
│  /graph, /graph/drill → projected SMG, drillPriority         │
└───────────┬──────────────────────────────┬───────────────────┘
            ▼                              ▼
       Firestore                   Gemini API / Cloud Vision
  users/{uid}/smg, courses,     gemini-3.1-pro-preview (explain, quiz)
  events, quizSessions,         gemini-3.8-flash (classify)
  gamification; rateLimits      gemini-embedding-2 (768-dim); Vision OCR

Extension side panel / Web app → Firebase ID token → same /api/v1 routes
```

Model defaults are in `packages/shared/src/env/server.ts` (verified 2026-09-24).

### Packages / layout

```
server/             Express API (TypeScript, bun)
  src/ai/           geminiProvider.ts (model aliases, batching, retry)
  src/routes/       analyze explain stream quiz ingest graph course events gamification
  src/services/     gemini rag embeddings chunking ingestion concepts interactions
                    misconception scheduler graphView gamification cache ocr firestore
  src/middleware/   auth rateLimit firestoreRateLimitStore validate errorHandler
  src/eval/         retrieval + concept-merge evaluation (bun run eval)
  src/scripts/      reembed.ts (vector migration)
extension/          Chrome MV3 (React 19 + Vite): background.ts, content.ts, sidepanel/
web/                React 19 + Vite + TypeScript: pages/ (Home, Login, SignUp, Dashboard), lib/
packages/shared/    zod API contracts + env schema
packages/client/    typed API client shared by web and extension
```

---

## 3. Data Flow: Explain (Ask) Mode

```
1. Student asks in the side panel (text, highlighted selection, or screenshot → OCR)
2. POST /api/v1/analyze { content | imageBase64, courseId? }   (or /explain, /stream/explain)
3. retrieveChunkRecords(uid, courseId?, question)
     → embed with gemini-embedding-2, "task: question answering | query: …"
     → Firestore findNearest per course, in parallel (COSINE, distance ≤ RAG_MAX_COSINE_DISTANCE = 0.6)
     → chunks from a different embedding model are dropped
4. explainConcept(question, "[n] (from file)" context, student profile)
     → primary model, structured JSON { solution, mainConcept, relevantLecture, keyFormulas, personalizedCallout }
5. recordQuestionInteraction (services/interactions.ts)
     → classifyConcept(question, solution, knownConcepts) with the fast model
     → resolveConceptNode: exact id → nearest smg.labelEmbedding (≤ 0.15) → new node
     → recordInteraction (FSRS, transaction) + saveInteraction (event) → cache invalidation
6. recordActivity (XP + streak, one transaction)
7. Response includes classifierTag, eventId and sources (the files cited)
```

`/explain` responds before step 5 (it runs afterwards); `/analyze` and `/stream/explain` finish it before closing the response.

---

## 4. Data Flow: Quiz Mode

```
1. POST /api/v1/quiz { topic?, courseId?, count? }
2. No topic → getWeakestConcepts(uid)
3. retrieveChunks for the topic; generateQuiz(topic, chunks, smgData, count) with the primary model
4. Malformed questions are dropped; concepts are canonicalised
5. Answers are stored at users/{uid}/quizSessions/{sessionId} (30 min); the client gets questions without answers
6. POST /api/v1/quiz/answer { conceptNode, selectedAnswer, sessionId, questionIndex, courseId? }
     → graded server-side → recordInteraction (Good / Again) → event → recordActivity
     → response { isCorrect, correctAnswer, eventId }; extension refreshes its badge
```

---

## 5. Data Flow: Ingestion

```
Auto (content script) → POST /api/v1/ingest/text { courseId, rawContent, sourcePlatform }
Manual               → POST /api/v1/ingest/upload (multipart file + courseId); OCR for images/PDFs

Both:
  → chunkText (services/chunking.ts): heading-aware, ~900-char target, 1500 max,
    heading path prefixed to each chunk
  → embedDocuments ("title: … | text: …"), batches of 100, before any write
  → delete older chunks from the same source (sourceKey), write new ones tagged
    embeddingModel / embeddingDim / sourceKey
  → recordIngestedFile upserts files/{fileId}; discovered concepts are initialised in the SMG
```

The Gemini File API is not used (uploads expire after 48 h). After changing the embedding model, run `bun run --cwd server reembed`.

---

## 6. Spaced Repetition: FSRS

Implementation: `server/src/services/scheduler.ts` (ts-fsrs), used by `recordInteraction` in `misconception.ts`.

Parameters: request retention 0.9, maximum interval 365 days, no fuzz, no short-term steps (reviews land on day boundaries).

### Evidence → grade (`gradeFor`)

| Interaction | Grade |
|-------------|-------|
| Quiz answer correct | Good |
| Quiz answer wrong | Again |
| Question whose classifier `errorType ≠ none` with confidence ≥ 0.5 | Again |
| Any other question | none — the schedule is not changed |

A plain question is exposure, not a recall test: scoring it as a pass would push back the review of a concept the student is confused about. `recordInteraction` runs in a Firestore transaction; accuracy counts change only on graded answers. Nodes without an `fsrs` field (scheduled by the old SM-2 code) keep their `nextReviewDate` until the first graded review.

### Drill queue order (`drillPriority`)

| Bucket | Urgency |
|--------|---------|
| Due review (R ≤ 0.9) | 10 + (1 − R)·10 + (1 − accuracy)·5 |
| New, asked about | 6 |
| New, from ingestion only | 5 |
| Review not yet due | (1 − R)·10 + (1 − accuracy)·4 |
| Legacy SM-2 node | overdueDays·2 + (1 − accuracy)·5 |

R is FSRS retrievability now. Drill items carry `due` and `retrievability`; the extension badge counts `due` items.

---

## 7. Misconception Taxonomy

The classifier assigns each interaction an `errorType`:

| errorType | Meaning |
|-----------|---------|
| `conceptual_misunderstanding` | Wrong mental model of a concept |
| `procedural_error` | Knows the concept but applies it incorrectly |
| `knowledge_gap` | Hasn't encountered this concept before |
| `reasoning_error` | Logic / inference error (not a knowledge gap) |
| `none` | No error detected (correct answer or no misconception) |

`conceptNode` is the snake_case concept identifier (e.g., `lhopitals_rule`, `matrix_multiplication`, `dynamic_programming`). It serves as the Firestore document ID in `users/{uid}/smg/`.

---

## 8. API Reference

All endpoints require `Authorization: Bearer <firebase-id-token>` except `/health`.

| Method | Endpoint | Body / Params | Response |
|--------|----------|---------------|----------|
| GET | `/health` | — | `{ ok, service, env?, firestore? }` |
| POST | `/api/v1/analyze` | `{ content?, imageBase64?, courseId? }` | `{ question, solution, mainConcept, relevantLecture, keyFormulas, personalizedCallout, sources, classifierTag, eventId }` |
| POST | `/api/v1/explain` | `{ question, courseId? }` | `{ question, solution, mainConcept, relevantLecture, keyFormulas, personalizedCallout, sources }`; SMG updated after the response |
| POST | `/api/v1/stream/explain` | `{ question, courseId? }` | SSE `data: {text}` … `data: [DONE]` |
| POST | `/api/v1/quiz` | `{ topic?, courseId?, count? }` | `{ topic, courseId?, sessionId, questions: [{ question, options[], explanation?, difficulty, conceptNode }] }` |
| POST | `/api/v1/quiz/answer` | `{ conceptNode, selectedAnswer, sessionId, questionIndex, courseId? }` | `{ isCorrect, correctAnswer, eventId }` |
| GET | `/api/v1/quiz/queue` | — | `{ queue: [DrillItem] }` |
| POST | `/api/v1/ingest/upload` | multipart: `file`, `courseId`, `sourcePlatform?` | `{ ok, filename, courseId }` |
| POST | `/api/v1/ingest/text` | `{ courseId, rawContent, sourcePlatform?, filename? }` | `{ ok, courseId, ingestedAt }` |
| GET | `/api/v1/graph` | — | `{ nodes: [GraphNode] }` |
| GET | `/api/v1/graph/drill` | — | `{ queue: [DrillItem] }` |
| GET | `/api/v1/graph/course/:courseId` | — | `{ nodes: [GraphNode] }` |
| GET | `/api/v1/courses` | — | `{ courses: [...] }` |
| GET | `/api/v1/courses/:courseId` | — | course detail |
| GET | `/api/v1/events` | `?limit&offset` | `{ events, count }` |
| GET | `/api/v1/gamification` | — | `{ xp, level, xpIntoLevel, nextLevelXP, streak, achievements }` (read-only) |

Gemini-backed routes (analyze, explain, stream, quiz generation, ingest) are rate-limited per user. Exact shapes: `packages/shared/src/contracts/api.ts`.

### Type: GraphNode
```json
{
  "conceptNode": "lhopitals_rule",
  "accuracyRate": 0.6,
  "interactionCount": 5,
  "nextReviewDate": "<timestamp>",
  "courseId": "calc1",
  "errorTypeMap": { "procedural_error": 2, "knowledge_gap": 1 },
  "dominantErrorType": "procedural_error",
  "retrievability": 0.83
}
```

### Type: DrillItem
```json
{
  "conceptNode": "lhopitals_rule",
  "accuracyRate": 0.6,
  "nextReviewDate": "<timestamp>",
  "interactionCount": 5,
  "urgency": 13.7,
  "due": true,
  "retrievability": 0.81
}
```

---

## 9. Firestore Data Model

All data is under `users/{uid}/`. Users can only read/write their own subcollections (enforced by Firestore security rules and the backend `requireFirebaseAuth` middleware).

### `users/{uid}`
| Field | Type | Notes |
|-------|------|-------|
| email | string | From Firebase Auth |
| displayName | string | From Firebase Auth |
| createdAt | timestamp | First sign-in |

### `users/{uid}/smg/{conceptNode}`
| Field | Type | Notes |
|-------|------|-------|
| courseId | string | Most recent course |
| accuracyRate | number | correctCount / (correctCount + incorrectCount) |
| correctCount | number | Running total |
| incorrectCount | number | Running total |
| errorTypeMap | map | `{ errorType: count }` |
| interactionCount | number | All interactions (including explains) |
| fsrs | map | FSRS card: due, stability, difficulty, scheduledDays, learningSteps, reps, lapses, state, lastReview |
| reviewIntervalDays | number | FSRS scheduled days (legacy SM-2 value on old nodes) |
| nextReviewDate | timestamp | `fsrs.due`, kept as a top-level field for queries |
| labelEmbedding | vector | 768-dim label vector for concept matching (never sent to clients) |
| labelEmbeddingModel | string | Model that produced `labelEmbedding` |
| isInitializedOnly | boolean | Created by ingestion, not yet studied |
| lastInteractionAt | timestamp | Server timestamp |
| lastErrorAt | timestamp \| null | Last wrong answer |
| easeFactor | number | Legacy SM-2 field on old nodes only |

### `users/{uid}/events/{eventId}`
| Field | Type | Notes |
|-------|------|-------|
| courseId | string | — |
| eventType | string | "explain" \| "quiz_generated" \| "quiz_answer" |
| content | string | Student's question or topic |
| response | map | Full Gemini response |
| classifierTag | map | `{ conceptNode, errorType, confidence }` |
| requestMeta | map | `{ path, method, ip, userAgent }` |
| createdAt | timestamp | — |

### `users/{uid}/courses/{courseId}`
| Field | Type | Notes |
|-------|------|-------|
| platform | string | "brightspace" \| "gradescope" \| "upload" |
| lastIngestedAt | timestamp | — |

### `users/{uid}/courses/{courseId}/chunks/{chunkId}`
| Field | Type | Notes |
|-------|------|-------|
| content | string | Chunk text (~900 chars) with its heading path prefixed |
| embedding | vector | 768-dim (Firestore vector, flat index in firestore.indexes.json) |
| embeddingModel | string | e.g. `gemini-embedding-2`; RAG ignores other models |
| embeddingDim | number | 768 |
| sourceKey | string | `file:<name>` or `hash:<sha256>`; re-ingesting a source replaces its chunks |
| filename | string | Source file name, used for citations |
| chunkIndex | number | Position in original doc |
| createdAt | timestamp | — |

### `users/{uid}/courses/{courseId}/files/{fileId}`
| Field | Type | Notes |
|-------|------|-------|
| filename | string | — |
| sourcePlatform | string | — |
| contentHash | string | SHA-256 of the content |
| chunkCount | number | Chunks written |
| uploadedAt | timestamp | — |

`fileId` is SHA-256 of `courseId:filename`.

---

## 10. Authentication

```
Extension flow:
  chrome.identity.getAuthToken()     → Google OAuth access token
  GoogleAuthProvider.credential(null, token)
  signInWithCredential(auth, cred)   → Firebase user + ID token
  Authorization: Bearer <id-token>   → API calls

Web app flow:
  signInWithPopup(auth, GoogleAuthProvider)    → Firebase user + ID token
  OR signInWithEmailAndPassword(auth, e, p)    → Firebase user + ID token
  Authorization: Bearer <id-token>             → API calls

Backend:
  requireFirebaseAuth middleware
  auth.verifyIdToken(token)          → { uid, email, name }
  req.user set for all downstream handlers
```

---

## 11. In-Memory Cache

`server/src/services/cache.ts` — LRU Map with TTL, per process.

- **Capacity**: 5,000 entries; **TTL**: 60 s for graph/drill, 2 min default; sweep every 100 writes
- **Invalidation**: after SMG writes (`graph:{uid}`, `drill:{uid}`) and ingestion (`courses:{uid}`)
- **Multiple instances**: invalidation only reaches the instance that handled the write, so others can serve stale data until TTL. Use load-balancer session affinity; anything that must be exact belongs in Firestore.

---

## 12. Extension UX

**Side panel tabs** (dark theme: bg `#06080c`, accent `#3ee0d0`):

| Tab | What it does |
|-----|-------------|
| Hub | Shows SMG-weighted recommended topics + quick links to Ask / Quiz |
| Ask | Text input → calls `/analyze` → renders solution cards (step-by-step, key formulas, relevant lecture, personalized callout based on SMG) |
| Quiz | Topic input (or auto-select from weak areas) → MCQ with 4 options → color-coded feedback → running score |
| My Graph | Per-concept mastery bars with a "mostly <error type>" tag; the web dashboard has the Cytoscape network |

**Toolbar badge**: number of concepts due for review, refreshed hourly (`chrome.alarms`), on sign-in changes and after quiz answers.

**Content script** (`content.ts`):
- Triggers on `*://*.brightspace.com/*` and `*://*.gradescope.com/*`
- Extracts page text, sends to `/api/v1/ingest/text`
- Shadow DOM widget planned for "Explain this" / "Quiz me" buttons on selected text

---

## 13. Security Model

| Concern | Implementation |
|---------|----------------|
| API auth | Every route (except `/health`) requires a valid Firebase ID token |
| Data isolation | All Firestore paths scoped to `users/{uid}/`; Firestore rules enforce `request.auth.uid === userId` |
| No credential storage | Extension uses `chrome.identity` (existing Google session); never reads Brightspace cookies or passwords |
| Embeddings | Label and chunk vectors stay server-side; graph responses are projected |
| Input limits | Express JSON parser capped at 1MB; route-level schema validation via `validate` middleware |
| Rate limiting | `apiLimiter` per IP on `/api/v1/*` (120/min); `aiLimiter` per uid on Gemini routes (20/min, optional shared Firestore store); `TRUST_PROXY` for real client IPs |
| Security headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS in production |

---

## 14. Environment Variables

### `server/.env`
| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | AI Studio key |
| `GOOGLE_APPLICATION_CREDENTIALS` | One of these | Path to Firebase service account JSON |
| `FIREBASE_PROJECT_ID` | One of these | Project ID for ADC fallback |
| `PORT` | No | Defaults to 3000 |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (empty = permissive in dev) |
| `GEMINI_MODEL` / `GEMINI_FAST_MODEL` / `GEMINI_EMBEDDING_MODEL` | No | Override model defaults (see section 2) |
| `RAG_MAX_COSINE_DISTANCE` | No | RAG cutoff, default 0.6 (tune with `bun run --cwd server eval`) |
| `CONCEPT_MATCH_MAX_DISTANCE` | No | Concept merge cutoff, default 0.15 |
| `TRUST_PROXY` | No | Proxy hop count (1 behind one load balancer) |
| `RATE_LIMIT_STORE` | No | `memory` (default) or `firestore` (shared AI limit) |
| `RATE_LIMIT_IP_PER_MINUTE` / `RATE_LIMIT_AI_PER_MINUTE` | No | Defaults 120 / 20 |

### `web/.env.local` and `extension/.env`
| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Yes | Firebase web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Yes | `<project>.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | Yes | Firebase project ID |
| `VITE_API_URL` | No | Backend URL (default: `http://localhost:3000`) |

---

## 15. Running Locally

```bash
# Install all workspaces
cd server && bun install
cd ../web && bun install
cd ../extension && bun install

# Fill in env files (see section 14)
# server/.env needs GEMINI_API_KEY + FIREBASE_PROJECT_ID at minimum

# Start all three in separate terminals
cd server && bun run dev        # Express API on :3000
cd web    && bun run dev        # Vite web app on :5173
cd extension && bun run dev     # Vite extension build (watch mode)

# Load extension in Chrome: chrome://extensions → Load unpacked → extension/dist/
```

---

## 16. CI/CD

GitHub Actions (`.github/workflows/ci.yml`):

| Job | What it runs |
|-----|-------------|
| `lint` | `bun run lint` (ESLint, `--max-warnings 0`) |
| `test-server` | `bun run --cwd server test:coverage` (Vitest, 80% thresholds) |
| `build` | `bun run build` (web + extension Vite builds) |
| `dependency-review` | `actions/dependency-review-action` (PR only; needs the repo dependency graph enabled) |
| `security` | `bun audit` |
| `required` | Gate job — PR is mergeable only if all above pass |

Firebase Hosting deploys preview URLs on each PR and production on merge to `main`.
