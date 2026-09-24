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
  mockAddXP,
  mockUpdateStreak
} = vi.hoisted(() => ({
  mockExplain: vi.fn(),
  mockClassify: vi.fn(),
  mockRetrieveChunks: vi.fn(),
  mockRecordInteraction: vi.fn().mockResolvedValue(undefined),
  mockSaveInteraction: vi.fn().mockResolvedValue("event-id"),
  mockEnsureUserDoc: vi.fn().mockResolvedValue(undefined),
  mockExtractOCR: vi.fn(),
  mockAddXP: vi.fn().mockResolvedValue(undefined),
  mockUpdateStreak: vi.fn().mockResolvedValue(undefined),
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
vi.mock("../services/gamification", () => ({ addXP: mockAddXP, updateStreak: mockUpdateStreak }));
vi.mock("../services/cache", () => ({ cacheInvalidate: vi.fn() }));

// Mock foundational layers
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({ collection: vi.fn().mockReturnThis(), doc: vi.fn().mockReturnThis() })),
  FieldValue: { serverTimestamp: vi.fn(() => "ts"), increment: vi.fn((n) => n) },
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })) }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "m" }]) }));

vi.mock("../middleware/rateLimit", () => ({ apiLimiter: (req: any, res: any, next: any) => next() }));
vi.mock("../middleware/auth", () => ({
  requireFirebaseAuth: (req: any, res: any, next: any) => {
    req.user = { uid: "user123", email: "u@e.com", name: "User" };
    next();
  },
}));

import { app } from "../app";
import * as misconception from "../services/misconception";
import * as concepts from "../services/concepts";

describe("Analyze API Integration", () => {
  beforeEach(() => {
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
});
