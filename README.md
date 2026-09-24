# AI Companion (Study Flow)

A Chrome extension + web app that gives university math/STEM students **contextual study help grounded in their actual course materials**. Instead of generic AI answers that reset every session, Study Flow builds a persistent model of what each student misunderstands and uses spaced repetition to fix it.

---

## Why This Exists

Students juggle search tabs, calculators, ChatGPT, and Anki -- none of which know what their professor actually taught. Study Flow solves three problems:

1. **Context loss** -- AI tools don't know your syllabus. Study Flow auto-ingests your Brightspace/Gradescope materials so every answer is grounded in what your professor actually covered.
2. **Cognitive debt** -- Students re-learn the same concepts because nothing tracks what they misunderstand. The Student Misconception Graph (SMG) classifies every interaction and uses FSRS spaced repetition to schedule targeted review.
3. **Workflow disruption** -- Switching to a separate study tool breaks focus. The Chrome extension side panel keeps help one click away without leaving the page.

---

## Who Is This For

- **University students** taking math, CS, or STEM courses that use Brightspace or Gradescope
- **Self-directed learners** who want structured review instead of generic AI chat
- **Study groups** where members can compare misconception patterns (future feature)

---

## What It Does

### Chrome Extension (Side Panel)

| Feature | What It Does | How It Works |
|---------|-------------|--------------|
| **Ask / Explain** | Type or paste a problem, get a structured explanation | RAG retrieves relevant chunks from your ingested course materials, Gemini generates a step-by-step solution with concept identification and key formulas |
| **Quiz** | Generate professor-style practice questions | FSRS scheduling picks the concepts you are forgetting, Gemini creates MCQs grounded in your course material, answers update your misconception graph |
| **My Graph** | See your concept mastery at a glance | Mastery by concept plus its most common error type; the toolbar badge shows how many reviews are due |
| **Auto-Ingestion** | Course materials sync automatically | Content script detects Brightspace/Gradescope pages, extracts text, chunks and embeds it into Firestore |

### Web App (Dashboard)

| Feature | What It Does |
|---------|-------------|
| **Landing page** | Product overview, feature highlights, install CTA |
| **Sign up / Log in** | Firebase Auth with Google SSO or email/password |
| **Dashboard** | Network graph of concepts, drill queue, session history |

### Backend (Express API)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/analyze` | Full pipeline: RAG + Gemini explain + classifier + SMG update |
| `POST /api/v1/explain` | Lightweight explain (no SMG update) |
| `POST /api/v1/quiz` | Generate quiz questions weighted by weak concepts |
| `POST /api/v1/quiz/answer` | Submit answer, update the SMG schedule (FSRS) |
| `GET /api/v1/quiz/queue` | Spaced repetition drill queue |
| `POST /api/v1/ingest/upload` | Upload and ingest a file (PDF, image, text) |
| `POST /api/v1/ingest/text` | Ingest raw text from content script |
| `GET /api/v1/graph` | Full misconception graph for the user |
| `GET /api/v1/graph/drill` | Drill queue: due reviews, then new concepts |
| `GET /api/v1/graph/course/:id` | Graph filtered by course |
| `GET /api/v1/courses` | List ingested courses |
| `GET /api/v1/courses/:id` | Course details + ingested files + chunk count |
| `GET /api/v1/events` | Paginated interaction history |

---

## How It Works (Architecture)

```
Chrome Extension                 Web App
     |                              |
     |  Firebase Auth (Google SSO)  |
     +----------+------------------+
                |
          Bearer Token
                |
        Express API Server
      (TypeScript, port 3000)
                |
     +----------+----------+
     |          |          |
  Gemini    Firestore   Cloud Vision
  (LLM)    (Database)     (OCR)
```

### The AI Pipeline (Analyze Flow)

1. Student types a question in the extension
2. **RAG retrieval**: the question is embedded (`gemini-embedding-2`) and the closest course chunks are found with Firestore vector search, across courses in parallel, with a distance cutoff
3. **Gemini explain**: chunks (labelled with their source files) + question + the student's weak concepts go to `gemini-3.1-pro-preview`, which returns structured JSON (solution, main concept, key formulas, personalized callout); the response cites its sources
4. **Classifier**: `gemini-3.8-flash` tags the interaction with a concept + error type (conceptual misunderstanding, procedural error, knowledge gap, reasoning error); the concept is matched to an existing node by label embedding so near-duplicates merge
5. **SMG update**: FSRS reschedules the concept when the interaction is real evidence of recall (quiz answers, or a question that reveals a misconception)
6. **Event log**: the full interaction is saved to Firestore for session history

### The Student Misconception Graph (SMG)

Each student has a collection of concept nodes at `users/{uid}/smg/{conceptNode}`. Each node tracks:

- **accuracyRate** -- running correct/incorrect ratio
- **errorTypeMap** -- frequency of each error type (e.g., `{ "procedural_error": 3, "knowledge_gap": 1 }`)
- **fsrs** -- FSRS memory state (stability, difficulty, reps, lapses, due date)
- **nextReviewDate** -- when this concept should be reviewed (predicted recall falls to 90%)
- **interactionCount** -- total times this concept has appeared

The drill queue puts due reviews first (most forgotten first), then new concepts, then reviews that are not due yet. See [docs/DESIGN.md](docs/DESIGN.md#6-spaced-repetition-fsrs).

### Course Ingestion

Materials are ingested two ways:

1. **File upload** (`POST /ingest/upload`): PDF, image, or text file -> OCR if needed -> heading-aware chunks (~900 chars, section path kept) -> batch embed with `gemini-embedding-2` -> replace any earlier chunks from the same source -> store with vectors in Firestore
2. **Content script** (`POST /ingest/text`): extension detects Brightspace/Gradescope pages -> extracts page text -> sends to backend -> same chunk/embed pipeline

Chunks are stored at `users/{uid}/courses/{courseId}/chunks/{auto-id}` with vector embeddings for cosine similarity search.

---

## Data Model (Firestore)

```
users/{uid}
  ├── email, displayName, createdAt
  │
  ├── courses/{courseId}
  │   ├── platform, lastIngestedAt
  │   ├── files/{fileId}        -- geminiFileUri, filename, fileHash, uploadedAt
  │   └── chunks/{chunkId}      -- content, embedding (vector), metadata, chunkIndex
  │
  ├── events/{eventId}          -- courseId, eventType, content, response, classifierTag, createdAt
  │
  └── smg/{conceptNode}         -- accuracyRate, errorTypeMap, easeFactor, reviewIntervalDays,
                                   nextReviewDate, interactionCount, correctCount, incorrectCount
```

---

## Quick Start

### Prerequisites

- Bun 1.3+
- A Firebase project with Firestore and Auth enabled
- A Gemini API key ([get one here](https://aistudio.google.com/app/apikey))
- (Optional) Google Cloud Vision API enabled for OCR

### 1. Clone and install

```bash
git clone <repo-url>
cd AI-Companion-GDG-Project

# Install all workspaces (requires bun: https://bun.sh)
cd server && bun install && cd ../web && bun install && cd ../extension && bun install && cd ..
```

### 2. Configure the backend

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:
```
GEMINI_API_KEY=your-gemini-key
GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-service-account.json
FIREBASE_PROJECT_ID=your-project-id
# Optional token-usage controls (enabled by default)
GRAPHIFY_ENABLED=true
GRAPHIFY_CONTEXT_MAX_TOKENS=1200
GRAPHIFY_ANSWER_MAX_TOKENS=450
```

### 3. Start the API server

```bash
cd server
bun run dev
```

The server starts at `http://localhost:3000`. Verify with `curl http://localhost:3000/health`.

### 4. Run the web app

```bash
cp web/.env.example web/.env.local
# Fill in VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID

cd web
bun run dev
```

Opens at `http://localhost:5173`.

### 5. Build the extension

```bash
cp extension/.env.example extension/.env
# Fill in VITE_FIREBASE_* and VITE_API_URL

cd extension
bun run build
```

Then in Chrome: Extensions -> Developer mode -> Load unpacked -> select `extension/dist`.

---

## Project Structure

```
├── server/            Express 5 API (TypeScript)
│   └── src/
│       ├── ai/            Gemini provider (models, batching, retry)
│       ├── routes/        analyze, explain, stream, quiz, ingest, graph, course, events, gamification
│       ├── services/      rag, embeddings, chunking, ingestion, concepts, interactions,
│       │                  misconception (SMG), scheduler (FSRS), graphView, gamification, cache, ocr
│       ├── middleware/    auth, rate limits, validation, errors
│       ├── eval/          retrieval + concept-merge evaluation (`bun run --cwd server eval`)
│       └── scripts/       reembed (vector migration)
├── web/               Marketing site + dashboard (React 19, Vite, TypeScript, Cytoscape)
├── extension/         Chrome MV3 (React 19, Vite): background.ts, content.ts, sidepanel/
├── packages/shared/   zod API contracts + env schema
├── packages/client/   typed API client for web + extension
└── docs/              ARCHITECTURE.md, DESIGN.md (current); older planning docs are marked historical
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | React 19, Chrome MV3 Side Panel API, Vite |
| Web App | React 19, React Router 7, Vite |
| Backend | TypeScript, Express 5 (bun) |
| Database | Firestore (NoSQL, real-time) |
| AI | Gemini 3.1 Pro (explain, quiz), Gemini 3.8 Flash (classify), gemini-embedding-2 |
| OCR | Google Cloud Vision API |
| Auth | Firebase Authentication (Google SSO + email/password) |
| Vector Search | Firestore native vector search (findNearest) with cosine similarity fallback |

---

## Authentication Flow

### Web App
1. User clicks "Sign in with Google" or enters email/password
2. Firebase client SDK handles the auth flow
3. On success, `onAuthStateChanged` updates the React context
4. Every API call includes `Authorization: Bearer <firebase-id-token>`
5. Backend verifies token via `firebase-admin` `auth.verifyIdToken()`

### Chrome Extension
1. User clicks "Sign in with Google"
2. `chrome.identity.getAuthToken()` gets a Google OAuth token
3. `signInWithCredential()` exchanges it for a Firebase credential
4. Token is used for all API calls via the fetch wrapper

---

## Comparison to Alternatives

| | Study Flow | ChatGPT/Gemini | NotebookLM | Anki |
|---|---|---|---|---|
| Knows your syllabus | Yes (auto-ingest) | No | Manual upload | No |
| Tracks misconceptions | Yes (SMG + FSRS) | No | No | Manual cards |
| Professor-style quizzes | Yes (weighted by weakness) | Generic | No | Manual cards |
| In-browser workflow | Side panel | Separate tab | Separate tab | Separate app |
| Personalized over time | Yes (grows smarter) | Resets each chat | Static | Manual |

---

## License

Private team project.
