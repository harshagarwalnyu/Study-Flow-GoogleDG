import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const { mockExplain, mockRetrieveChunkRecords, mockGetProfile, mockRecordQuestion } = vi.hoisted(() => ({
  mockExplain: vi.fn(),
  mockRetrieveChunkRecords: vi.fn().mockResolvedValue([]),
  mockGetProfile: vi.fn().mockResolvedValue(null),
  mockRecordQuestion: vi.fn().mockResolvedValue({ classifierTag: {}, eventId: "e1" }),
}));

// Mock services
vi.mock("../services/gemini", () => ({ explainConcept: mockExplain }));
vi.mock("../services/rag", () => ({ retrieveChunkRecords: mockRetrieveChunkRecords }));
vi.mock("../services/misconception", () => ({ getStudentProfile: mockGetProfile }));
vi.mock("../services/interactions", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, recordQuestionInteraction: mockRecordQuestion };
});

// Mock foundations
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({ collection: vi.fn().mockReturnThis(), doc: vi.fn().mockReturnThis() })),
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })) }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "m" }]) }));

vi.mock("../middleware/rateLimit", () => ({ apiLimiter: (req: any, res: any, next: any) => next() }));
vi.mock("../middleware/auth", () => ({
  requireFirebaseAuth: (req: any, res: any, next: any) => {
    req.user = { uid: "user123" };
    next();
  },
}));

import { app } from "../app";

const explanation = {
  solution: "sol",
  mainConcept: "C",
  relevantLecture: "L",
  keyFormulas: [],
  personalizedCallout: "P",
};

describe("Explain API Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRetrieveChunkRecords.mockResolvedValue([]);
    mockGetProfile.mockResolvedValue(null);
    mockRecordQuestion.mockResolvedValue({ classifierTag: {}, eventId: "e1" });
  });

  it("POST /api/v1/explain returns explanation", async () => {
    mockExplain.mockResolvedValue(explanation);

    const res = await request(app)
      .post("/api/v1/explain")
      .send({ question: "test", courseId: "c1" });

    expect(res.status).toBe(200);
    expect(res.body.solution).toBe("sol");
    expect(res.body.sources).toEqual([]);
  });

  it("labels context by file, personalizes, and cites the source files", async () => {
    const profile = { weakConcepts: ["limits"], errorTypeMap: {} };
    mockGetProfile.mockResolvedValue(profile);
    mockRetrieveChunkRecords.mockResolvedValue([
      { content: "A", courseId: "c1", distance: 0.1, filename: "week1.pdf" },
      { content: "B", courseId: "c1", distance: 0.2, filename: "week1.pdf" },
      { content: "C", courseId: "c1", distance: 0.3, filename: "week2.pdf" },
    ]);
    mockExplain.mockResolvedValue(explanation);

    const res = await request(app).post("/api/v1/explain").send({ question: "what is a limit", courseId: "c1" });

    expect(res.status).toBe(200);
    const [, context, passedProfile] = mockExplain.mock.calls[0];
    expect(context).toContain("[1] (from week1.pdf)\nA");
    expect(context).toContain("[3] (from week2.pdf)\nC");
    expect(passedProfile).toBe(profile);
    expect(res.body.sources).toEqual([
      { filename: "week1.pdf", courseId: "c1" },
      { filename: "week2.pdf", courseId: "c1" },
    ]);
  });

  it("feeds the question into the misconception graph without blocking the response", async () => {
    mockExplain.mockResolvedValue(explanation);
    let finishRecording: () => void = () => {};
    mockRecordQuestion.mockReturnValue(new Promise((resolve) => { finishRecording = () => resolve({}); }));

    const res = await request(app).post("/api/v1/explain").send({ question: "q", courseId: "c1" });

    expect(res.status).toBe(200); // responded while recording is still pending
    expect(mockRecordQuestion).toHaveBeenCalledWith("user123", expect.objectContaining({
      question: "q", solution: "sol", mainConcept: "C", courseId: "c1",
    }));
    finishRecording();
  });

  it("still answers when background recording fails", async () => {
    mockExplain.mockResolvedValue(explanation);
    mockRecordQuestion.mockRejectedValue(new Error("classifier down"));

    const res = await request(app).post("/api/v1/explain").send({ question: "q" });
    expect(res.status).toBe(200);
  });

  it("handles errors", async () => {
    mockExplain.mockRejectedValueOnce(new Error("fail"));
    const res = await request(app)
      .post("/api/v1/explain")
      .send({ question: "test" });

    expect(res.status).toBe(500);
  });
});
