import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const {
  mockExplainStream,
  mockClassify,
  mockRetrieveChunks,
  mockRecordInteraction,
  mockSaveInteraction,
  mockRecordActivity,
  mockShouldUseRag,
  mockGetStudentProfile,
} = vi.hoisted(() => {
  const promiseWithCatch = () => {
    const p = Promise.resolve();
    (p as any).catch = vi.fn().mockReturnValue(p);
    return p;
  };
  
  return {
    mockExplainStream: vi.fn(),
    mockClassify: vi.fn().mockResolvedValue({}),
    mockRetrieveChunks: vi.fn().mockResolvedValue([]),
    mockRecordInteraction: vi.fn().mockImplementation(promiseWithCatch),
    mockSaveInteraction: vi.fn().mockImplementation(promiseWithCatch),
    mockRecordActivity: vi.fn().mockImplementation(promiseWithCatch),
    mockShouldUseRag: vi.fn().mockReturnValue(true),
    mockGetStudentProfile: vi.fn().mockResolvedValue(null),
  };
});

// Mock services BEFORE anything else
vi.mock("../services/gemini", () => ({
  explainConceptStream: mockExplainStream,
  classifyConcept: mockClassify,
}));
vi.mock("../services/rag", () => ({ retrieveChunks: mockRetrieveChunks }));
vi.mock("../services/misconception", () => ({ recordInteraction: mockRecordInteraction, getStudentProfile: mockGetStudentProfile }));
vi.mock("../services/concepts", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    listKnownConcepts: vi.fn().mockResolvedValue([]),
    resolveConceptNode: vi.fn(async (_uid: string, proposed: string) => ({
      conceptNode: actual.toSnakeCase(proposed) || "general_concept", matchedExisting: false, distance: null, labelEmbedding: null,
    })),
    resolveConceptNodes: vi.fn(async (_uid: string, proposed: string[]) => proposed.map((p) => ({
      conceptNode: actual.toSnakeCase(p) || "general_concept", matchedExisting: false, distance: null, labelEmbedding: null,
    }))),
  };
});
vi.mock("../services/firestore", () => ({ saveInteraction: mockSaveInteraction }));
vi.mock("../services/gamification", () => ({ recordActivity: mockRecordActivity }));
vi.mock("../services/ragPolicy", () => ({ shouldUseCourseRag: mockShouldUseRag }));
vi.mock("../services/cache", () => ({ cacheInvalidate: vi.fn() }));

// Mock foundational layers
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({ collection: vi.fn().mockReturnThis(), doc: vi.fn().mockReturnThis() })),
  FieldValue: { serverTimestamp: vi.fn(() => "ts"), increment: vi.fn((n) => n) },
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })) }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "m" }]) }));

vi.mock("../middleware/rateLimit", () => ({ apiLimiter: (req: any, res: any, next: any) => next(), aiLimiter: (req: any, res: any, next: any) => next() }));
vi.mock("../middleware/auth", () => ({
  requireFirebaseAuth: (req: any, res: any, next: any) => {
    req.user = { uid: "user123" };
    next();
  },
}));

import { app } from "../app";

describe("Stream API Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips writing an SSE data frame for a chunk with no text", async () => {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { text: () => "" }; // empty delta from the model — nothing to send
        yield { text: () => "real content" };
      },
    };
    mockExplainStream.mockResolvedValue(mockStream);

    const res = await request(app)
      .post("/api/v1/stream/explain")
      .send({ question: "test" });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('data: {"text":""}');
    expect(res.text).toContain('data: {"text":"real content"}');
  });

  it("POST /api/v1/stream/explain streams text content", async () => {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { text: () => "First chunk" };
        yield { text: "Second chunk" };
      },
    };
    mockExplainStream.mockResolvedValue(mockStream);
    mockRetrieveChunks.mockResolvedValue(["chunk1"]);
    mockClassify.mockResolvedValue({ conceptNode: "node1", errorType: "none", confidence: 0.9 });

    const res = await request(app)
      .post("/api/v1/stream/explain")
      .set("Authorization", "Bearer valid")
      .send({ question: "How does X work?", courseId: "c1" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("[DONE]");

    await vi.waitFor(() => expect(mockRecordActivity).toHaveBeenCalled());
  });

  it("handles failures and side-effect errors", async () => {
    mockExplainStream.mockRejectedValue(new Error("Gemini down"));
    
    const res = await request(app)
      .post("/api/v1/stream/explain")
      .send({ question: "test" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Stream interrupted");
  });

  it("handles side-effect failures", async () => {
    const mockStream = { async *[Symbol.asyncIterator]() { yield { text: "ok" }; } };
    mockExplainStream.mockResolvedValue(mockStream);
    mockClassify.mockResolvedValue({ conceptNode: "node1" }); // Succeed here
    
    // But make internal ones fail
    mockRecordInteraction.mockRejectedValue(new Error("side fail"));
    mockSaveInteraction.mockRejectedValue(new Error("side fail"));

    const res = await request(app)
      .post("/api/v1/stream/explain")
      .send({ question: "test" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockRecordActivity).toHaveBeenCalled());
  });

  it("streams the answer without RAG context when retrieveChunks fails", async () => {
    const mockStream = { async *[Symbol.asyncIterator]() { yield { text: "answer without context" }; } };
    mockExplainStream.mockResolvedValue(mockStream);
    mockRetrieveChunks.mockRejectedValueOnce(new Error("rag down"));

    const res = await request(app)
      .post("/api/v1/stream/explain")
      .send({ question: "test", courseId: "c1" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("answer without context");
    expect(res.text).toContain("[DONE]");
    // ragContext falls back to "" — the model still gets called, just without course context.
    expect(mockExplainStream).toHaveBeenCalledWith("test", "", null);
  });

  it("streams the answer without personalization when getStudentProfile fails", async () => {
    const mockStream = { async *[Symbol.asyncIterator]() { yield { text: "answer" }; } };
    mockExplainStream.mockResolvedValue(mockStream);
    mockGetStudentProfile.mockRejectedValueOnce(new Error("profile down"));

    const res = await request(app)
      .post("/api/v1/stream/explain")
      .send({ question: "test" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("[DONE]");
    // profile.catch() resolved to null instead of rejecting the request.
    expect(mockExplainStream).toHaveBeenCalledWith("test", "", null);
  });

  // The 20s heartbeat only fires on a connection that is still open past that mark; no
  // supertest request in this suite runs anywhere near that long. We invoke the router's own
  // handler directly against fake req/res objects (bypassing the real HTTP socket, not the
  // route logic) so fake timers can advance past 20s without an actual 20-second test.
  it("writes an SSE heartbeat comment every 20s while the stream is open", async () => {
    let releaseChunk: () => void;
    const gate = new Promise<void>((resolve) => { releaseChunk = resolve; });
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield { text: () => "chunk1" };
        await gate;
        yield { text: () => "chunk2" };
      },
    };
    mockExplainStream.mockResolvedValue(mockStream);

    const { streamRouter } = await import("./stream");
    const layer = (streamRouter as any).stack.find((l: any) => l.route?.path === "/explain");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const { EventEmitter } = await import("node:events");
    const req: any = new EventEmitter();
    req.user = { uid: "user123" };
    req.body = { question: "test" };

    const writes: string[] = [];
    const res: any = {
      setHeader: vi.fn(),
      write: vi.fn((chunk: string) => { writes.push(chunk); return true; }),
      end: vi.fn(),
    };

    vi.useFakeTimers();
    try {
      const handlerPromise = handler(req, res);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(writes).toContain(": ping\n\n");

      releaseChunk!();
      await vi.advanceTimersByTimeAsync(0);
      await handlerPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(res.end).toHaveBeenCalled();
    expect(writes.some((w) => w.includes("chunk1"))).toBe(true);
    expect(writes.some((w) => w.includes("chunk2"))).toBe(true);
  });
});
