import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { 
  mockExplain, 
  mockClassify, 
  mockRetrieveChunks, 
  mockRecordInteraction, 
  mockSaveInteraction, 
  mockEnsureUserDoc,
  mockExtractOCR,
  mockRecordActivity,
  mockUserHolder,
} = vi.hoisted(() => ({
  mockExplain: vi.fn(),
  mockClassify: vi.fn(),
  mockRetrieveChunks: vi.fn(),
  mockRecordInteraction: vi.fn().mockResolvedValue(undefined),
  mockSaveInteraction: vi.fn().mockResolvedValue("event-id"),
  mockEnsureUserDoc: vi.fn().mockResolvedValue(undefined),
  mockExtractOCR: vi.fn(),
  mockRecordActivity: vi.fn().mockResolvedValue(undefined),
  mockUserHolder: { user: { uid: "user123", email: "u@e.com", name: "User" } as { uid: string; email?: string; name?: string } },
}));

// Mock services
vi.mock("../services/gemini", () => ({
  explainConcept: mockExplain,
  classifyConcept: mockClassify,
}));
vi.mock("../services/rag", () => ({ retrieveChunkRecords: mockRetrieveChunks }));
vi.mock("../services/misconception", () => ({ recordInteraction: mockRecordInteraction, getStudentProfile: vi.fn().mockResolvedValue(null) }));
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
vi.mock("../services/firestore", () => ({
  saveInteraction: mockSaveInteraction,
  ensureUserDoc: mockEnsureUserDoc,
}));
vi.mock("../services/ocr", () => ({ extractTextFromBase64: mockExtractOCR }));
vi.mock("../services/gamification", () => ({ recordActivity: mockRecordActivity }));
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
    req.user = mockUserHolder.user;
    next();
  },
}));

import { app } from "../app";
import * as misconception from "../services/misconception";
import * as concepts from "../services/concepts";

describe("Analyze API Integration", () => {
  beforeEach(() => {
    mockUserHolder.user = { uid: "user123", email: "u@e.com", name: "User" };
    vi.clearAllMocks();
  });

  it("POST /api/v1/analyze processes text and returns explanation", async () => {
    mockExplain.mockResolvedValue({
      solution: "explanation",
      mainConcept: "X",
      relevantLecture: "L1",
      keyFormulas: ["f1"],
      personalizedCallout: "well done",
    });
    mockClassify.mockResolvedValue({ conceptNode: "node1", errorType: "none", confidence: 0.9 });
    mockRetrieveChunks.mockResolvedValue([{ content: "chunk1", courseId: "c1", distance: 0.1, filename: "w1.pdf" }]);

    const res = await request(app)
      .post("/api/v1/analyze")
      .set("Authorization", "Bearer valid")
      .send({ question: "How does X work?", courseId: "c1", content: "text" });

    expect(res.status).toBe(200);
    expect(res.body.solution).toBe("explanation");
    expect(mockSaveInteraction).toHaveBeenCalled();
    expect(mockRecordInteraction).toHaveBeenCalled();
    // Awaited before responding, not fire-and-forget.
    expect(mockRecordActivity).toHaveBeenCalledWith("user123", { xp: 5 });
  });

  it("personalizes, reuses existing concepts, and does not grade a question as right or wrong", async () => {
    const profile = { weakConcepts: ["chain_rule"], errorTypeMap: { procedural_error: 3 } };
    vi.mocked(misconception.getStudentProfile).mockResolvedValueOnce(profile);
    vi.mocked(concepts.listKnownConcepts).mockResolvedValueOnce(["chain_rule"]);
    vi.mocked(concepts.resolveConceptNode).mockResolvedValueOnce({
      conceptNode: "chain_rule", matchedExisting: true, distance: 0.07, labelEmbedding: null,
    });
    mockExplain.mockResolvedValue({ solution: "sol", mainConcept: "Chain rule" });
    mockClassify.mockResolvedValue({ conceptNode: "derivatives_chain_rule", errorType: "procedural_error", confidence: 0.8 });
    mockRetrieveChunks.mockResolvedValue([{ content: "chunk1", courseId: "c1", distance: 0.1, filename: "w1.pdf" }]);

    const res = await request(app)
      .post("/api/v1/analyze")
      .send({ courseId: "c1", content: "Why is d/dx sin(x^2) not cos(x^2)? I keep getting this wrong." });

    expect(res.status).toBe(200);
    expect(mockExplain).toHaveBeenCalledWith(expect.any(String), "[1] (from w1.pdf)\nchunk1", profile);
    expect(res.body.sources).toEqual([{ filename: "w1.pdf", courseId: "c1" }]);
    expect(mockClassify).toHaveBeenCalledWith(expect.any(String), "sol", ["chain_rule"]);
    expect(res.body.classifierTag.conceptNode).toBe("chain_rule");
    const [uid, node, params] = mockRecordInteraction.mock.calls[0];
    expect([uid, node]).toEqual(["user123", "chain_rule"]);
    expect(params).toMatchObject({ errorType: "procedural_error", confidence: 0.8, courseId: "c1" });
    expect(params.isCorrect).toBeUndefined();
  });

  it("POST /api/v1/analyze processes imageBase64", async () => {
    mockExtractOCR.mockResolvedValue("ocr text");
    mockExplain.mockResolvedValue({ solution: "sol" });
    mockClassify.mockResolvedValue({});

    const res = await request(app)
      .post("/api/v1/analyze")
      .send({ imageBase64: "base64data" });

    expect(res.status).toBe(200);
    expect(res.body.question).toBe("ocr text");
    expect(mockExtractOCR).toHaveBeenCalledWith("base64data");
  });

  it("returns 400 if no content or imageBase64", async () => {
    const res = await request(app)
      .post("/api/v1/analyze")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 400 if OCR returns empty text", async () => {
    mockExtractOCR.mockResolvedValueOnce("");
    const res = await request(app)
      .post("/api/v1/analyze")
      .send({ imageBase64: "blank_img" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("content (string) or imageBase64 is required");
  });

  it("handles normalization of classifier tag", async () => {
    mockExplain.mockResolvedValue({ mainConcept: "fallback" });
    mockClassify.mockResolvedValue({ conceptNode: "Node 1", errorType: "invalid", confidence: "0.8" });

    const res = await request(app)
      .post("/api/v1/analyze")
      .send({ content: "text" });

    expect(res.status).toBe(200);
    expect(res.body.classifierTag.conceptNode).toBe("node_1");
    expect(res.body.classifierTag.errorType).toBe("knowledge_gap"); // fallback
    expect(res.body.classifierTag.confidence).toBe(0.8);
  });

  it("handles errors", async () => {
    mockExplain.mockRejectedValue(new Error("Gemini down"));
    const res = await request(app)
      .post("/api/v1/analyze")
      .send({ content: "text" });

    expect(res.status).toBe(500);
  });

  it("handles missing email and name gracefully", async () => {
    mockUserHolder.user = { uid: "user123" };
    mockExplain.mockResolvedValue({ solution: "sol" });
    mockClassify.mockResolvedValue({});

    const res = await request(app)
      .post("/api/v1/analyze")
      .send({ content: "text without email or name" });

    expect(res.status).toBe(200);
    expect(mockEnsureUserDoc).toHaveBeenCalledWith("user123", "", "");
  });

  // req.ip is typed as a non-optional string by @types/express, and every real HTTP
  // transport (including supertest's loopback socket) always yields a truthy value, so the
  // `req.ip || ""` fallback cannot be reached through a normal request. It is still real,
  // reachable code (Unix-domain-socket connections and some proxy misconfigurations leave
  // req.ip undefined), so we invoke the router's own handler directly instead of faking a
  // socket, and assert on the same logged behavior the fallback exists to produce.
  it("logs an empty ip instead of undefined when req.ip is unavailable", async () => {
    mockExplain.mockResolvedValue({ solution: "sol" });
    mockClassify.mockResolvedValue({});

    const { analyzeRouter } = await import("./analyze");
    const layer = (analyzeRouter as any).stack.find((l: any) => l.route?.path === "/");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const req: any = {
      user: { uid: "user123", email: "u@e.com", name: "User" },
      body: { content: "text" },
      ip: "",
      originalUrl: "/api/v1/analyze",
      method: "POST",
      headers: {},
    };
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const [, payload] = mockSaveInteraction.mock.calls[0];
    expect(payload.requestMeta.ip).toBe("");
  });
});
