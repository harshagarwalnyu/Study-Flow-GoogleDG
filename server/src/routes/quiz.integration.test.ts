import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Mock firebase-admin/firestore GLOBALLY
const { mockDb } = vi.hoisted(() => {
  const mock = {
    collection: vi.fn().mockReturnThis(),
    doc: vi.fn().mockReturnThis(),
    get: vi.fn(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    catch: vi.fn().mockReturnThis(),
    data: vi.fn(),
    exists: true,
  };
  mock.set.mockReturnValue({ catch: vi.fn() });
  return { mockDb: mock };
});

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => mockDb),
  FieldValue: { serverTimestamp: vi.fn(() => "ts"), increment: vi.fn((n) => n) },
}));

vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })) }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "m" }]) }));

const { 
  mockGenerateQuiz, 
  mockRetrieveChunks, 
  mockGetWeakest, 
  mockRecordInteraction, 
  mockSaveInteraction,
  mockGetDrillQueue,
  mockRecordActivity,
} = vi.hoisted(() => ({
  mockGenerateQuiz: vi.fn(),
  mockRetrieveChunks: vi.fn().mockResolvedValue([]),
  mockGetWeakest: vi.fn().mockResolvedValue([]),
  mockRecordInteraction: vi.fn().mockResolvedValue(undefined),
  mockSaveInteraction: vi.fn().mockResolvedValue("eid"),
  mockGetDrillQueue: vi.fn().mockResolvedValue([]),
  mockRecordActivity: vi.fn().mockResolvedValue(undefined),
}));

// Mock services
vi.mock("../services/gemini", () => ({ generateQuiz: mockGenerateQuiz }));
vi.mock("../services/rag", () => ({ retrieveChunks: mockRetrieveChunks }));
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
vi.mock("../services/misconception", () => ({
  getWeakestConcepts: mockGetWeakest,
  recordInteraction: mockRecordInteraction,
  getDrillQueue: mockGetDrillQueue,
}));
vi.mock("../services/firestore", () => ({ saveInteraction: mockSaveInteraction }));
vi.mock("../services/gamification", () => ({ recordActivity: mockRecordActivity }));
vi.mock("../services/cache", () => ({ cacheInvalidate: vi.fn() }));

vi.mock("../middleware/rateLimit", () => ({ apiLimiter: (req: any, res: any, next: any) => next(), aiLimiter: (req: any, res: any, next: any) => next() }));
vi.mock("../middleware/auth", () => ({
  requireFirebaseAuth: (req: any, res: any, next: any) => {
    req.user = { uid: "user123" };
    next();
  },
}));

import { app } from "../app";

describe("Quiz API Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.exists = true;
    mockDb.data.mockReturnValue({});
  });

  describe("POST /api/v1/quiz", () => {
    it("generates a quiz with provided topic", async () => {
      mockGenerateQuiz.mockResolvedValue({ questions: [{ question: "Q1", options: ["A", "B"], answer: 0 }] });
      
      const res = await request(app)
        .post("/api/v1/quiz")
        .send({ topic: "math", courseId: "c1", count: 1 });

      expect(res.status).toBe(200);
      expect(res.body.questions).toHaveLength(1);
      expect(mockRetrieveChunks).toHaveBeenCalled();
    });

    it("deletes expired quiz sessions in the background after generating", async () => {
      const expired = { ref: { delete: vi.fn(async () => undefined) } };
      mockDb.get.mockResolvedValue({ docs: [expired], exists: false, data: () => ({}) });
      mockGenerateQuiz.mockResolvedValue({ questions: [{ question: "Q1", options: ["A", "B"], answer: 0 }] });

      const res = await request(app).post("/api/v1/quiz").send({ topic: "math", courseId: "c1", count: 1 });

      expect(res.status).toBe(200);
      await vi.waitFor(() => expect(expired.ref.delete).toHaveBeenCalledTimes(1));
      expect(mockDb.where).toHaveBeenCalledWith("expiresAt", "<", expect.any(Number));
    });

    it("picks weakest concepts if no topic provided", async () => {
      mockGetWeakest.mockResolvedValue([{ conceptNode: "weak1" }]);
      mockGenerateQuiz.mockResolvedValue({ questions: [] });

      const res = await request(app)
        .post("/api/v1/quiz")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.topic).toBe("weak1");
    });

    it("defaults to 'general' if no topic and no weak concepts", async () => {
      mockGetWeakest.mockResolvedValue([]);
      mockGenerateQuiz.mockResolvedValue({ questions: [] });

      const res = await request(app)
        .post("/api/v1/quiz")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.topic).toBe("general");
    });

    it("passes the topic, chunks and weak-concept data to the generator", async () => {
      const weak = { conceptNode: "chain_rule", errorTypeMap: { procedural_error: 2 } };
      mockGetWeakest.mockResolvedValue([weak]);
      mockRetrieveChunks.mockResolvedValue(["chunk a"]);
      mockGenerateQuiz.mockResolvedValue({ questions: [] });

      await request(app).post("/api/v1/quiz").send({ count: 2 });

      expect(mockGenerateQuiz).toHaveBeenCalledWith("chain_rule", ["chunk a"], weak, 2);
    });

    it("drops malformed questions and tags the rest with canonical concept ids", async () => {
      mockGenerateQuiz.mockResolvedValue({
        questions: [
          { question: "ok", options: ["A", "B"], answer: 1, conceptNode: "Chain Rule" },
          { question: "bad answer index", options: ["A", "B"], answer: 5 },
          { question: "no options", answer: 0 },
        ],
      });

      const res = await request(app).post("/api/v1/quiz").send({ topic: "calc" });

      expect(res.status).toBe(200);
      expect(res.body.questions).toHaveLength(1);
      expect(res.body.questions[0].conceptNode).toBe("chain_rule");
      expect(res.body.questions[0]).not.toHaveProperty("answer");
    });

    it("handles a generator response with no questions field at all", async () => {
      mockGenerateQuiz.mockResolvedValue({}); // no `questions` key — defends against a malformed model response

      const res = await request(app).post("/api/v1/quiz").send({ topic: "math" });

      expect(res.status).toBe(200);
      expect(res.body.questions).toEqual([]);
      const [, savedInteraction] = mockSaveInteraction.mock.calls[0];
      expect(savedInteraction.response.questionCount).toBe(0);
    });

    it("fails instead of returning an ungradeable quiz when the session cannot be saved", async () => {
      mockGenerateQuiz.mockResolvedValue({ questions: [{ question: "Q1", options: ["A", "B"], answer: 0 }] });
      mockDb.set.mockImplementationOnce(() => Promise.reject(new Error("firestore down")));

      const res = await request(app).post("/api/v1/quiz").send({ topic: "math" });

      expect(res.status).toBe(500);
    });
  });

  describe("POST /api/v1/quiz/answer", () => {
    it("grades answer correctly", async () => {
      const validUuid = "550e8400-e29b-41d4-a716-446655440000";
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({
          questions: [{ conceptNode: "n1", answer: 0 }],
          expiresAt: Date.now() + 100000,
        }),
      });

      const res = await request(app)
        .post("/api/v1/quiz/answer")
        .send({ conceptNode: "n1", selectedAnswer: 0, sessionId: validUuid, questionIndex: 0 });

      expect(res.status).toBe(200);
      expect(res.body.isCorrect).toBe(true);
      expect(mockRecordInteraction).toHaveBeenCalled();
      expect(mockRecordActivity).toHaveBeenCalledWith("user123", { xp: 10, quizCorrect: true });
    });

    it("records a wrong answer as activity without XP", async () => {
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({ questions: [{ conceptNode: "n1", answer: 0 }], expiresAt: Date.now() + 100000 }),
      });

      const res = await request(app)
        .post("/api/v1/quiz/answer")
        .send({ conceptNode: "n1", selectedAnswer: 2, sessionId: "550e8400-e29b-41d4-a716-446655440000", questionIndex: 0 });

      expect(res.body.isCorrect).toBe(false);
      expect(mockRecordActivity).toHaveBeenCalledWith("user123", {});
    });

    it("returns 400 if the submitted conceptNode does not match the stored question", async () => {
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({
          questions: [{ conceptNode: "n1", answer: 0 }],
          expiresAt: Date.now() + 100000,
        }),
      });

      const res = await request(app)
        .post("/api/v1/quiz/answer")
        .send({ conceptNode: "spoofed_concept", selectedAnswer: 0, sessionId: "550e8400-e29b-41d4-a716-446655440000", questionIndex: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid question reference.");
      expect(mockRecordInteraction).not.toHaveBeenCalled();
    });

    it("returns 400 if questionIndex has no stored question", async () => {
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({
          questions: [{ conceptNode: "n1", answer: 0 }],
          expiresAt: Date.now() + 100000,
        }),
      });

      const res = await request(app)
        .post("/api/v1/quiz/answer")
        .send({ conceptNode: "n1", selectedAnswer: 0, sessionId: "550e8400-e29b-41d4-a716-446655440000", questionIndex: 5 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid question reference.");
    });

    it("returns 400 if session expired", async () => {
      const validUuid = "550e8400-e29b-41d4-a716-446655440000";
      mockDb.get.mockResolvedValue({
        exists: true,
        data: () => ({ expiresAt: Date.now() - 1000 }),
      });

      const res = await request(app)
        .post("/api/v1/quiz/answer")
        .send({ conceptNode: "n1", selectedAnswer: 0, sessionId: validUuid, questionIndex: 0 });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("expired");
    });

    it("handles errors", async () => {
      mockDb.get.mockRejectedValue(new Error("fail"));
      const res = await request(app)
        .post("/api/v1/quiz/answer")
        .send({ conceptNode: "n1", selectedAnswer: 0, sessionId: "550e8400-e29b-41d4-a716-446655440000", questionIndex: 0 });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/v1/quiz/queue", () => {
    it("returns drill queue", async () => {
      mockGetDrillQueue.mockResolvedValue([{ conceptNode: "n1" }]);

      const res = await request(app).get("/api/v1/quiz/queue");

      expect(res.status).toBe(200);
      expect(res.body.queue).toHaveLength(1);
    });

    it("handles errors", async () => {
      mockGetDrillQueue.mockRejectedValue(new Error("fail"));
      const res = await request(app).get("/api/v1/quiz/queue");
      expect(res.status).toBe(500);
    });
  });
});
