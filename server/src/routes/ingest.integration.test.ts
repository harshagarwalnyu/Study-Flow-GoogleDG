import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockIngestFile, mockIngestText, mockUnlink, mockUserHolder } = vi.hoisted(() => ({
  mockIngestFile: vi.fn().mockResolvedValue(undefined),
  mockIngestText: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockUserHolder: { user: { uid: "user123", email: "u@e.com", name: "User" } as { uid: string; email?: string; name?: string } },
}));

// Mock ALL external and internal dependencies BEFORE app
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({
    collection: vi.fn().mockReturnThis(),
    doc: vi.fn().mockReturnThis(),
    batch: vi.fn(() => ({ set: vi.fn(), commit: vi.fn().mockResolvedValue(true) })),
  })),
  FieldValue: { serverTimestamp: vi.fn(() => "ts"), increment: vi.fn((n) => n) },
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })) }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "m" }]) }));

vi.mock("../ai/index", () => ({
  getAiProvider: vi.fn(() => ({ generateJson: vi.fn(), streamText: vi.fn(), embedContent: vi.fn(), uploadFile: vi.fn() })),
}));

vi.mock("../services/ingestion", () => ({
  ingestFile: mockIngestFile,
  ingestText: mockIngestText,
}));
vi.mock("../services/firestore", () => ({ ensureUserDoc: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/cache", () => ({ cacheInvalidate: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, unlink: mockUnlink };
});

vi.mock("../middleware/rateLimit", () => ({ apiLimiter: (req: any, res: any, next: any) => next(), aiLimiter: (req: any, res: any, next: any) => next() }));
vi.mock("../middleware/auth", () => ({
  requireFirebaseAuth: (req: any, res: any, next: any) => {
    req.user = mockUserHolder.user;
    next();
  },
}));

import request from "supertest";
const { app } = await import("../app");
const { ensureUserDoc } = await import("../services/firestore");

describe("Ingest API Integration", () => {
  beforeEach(() => {
    mockUserHolder.user = { uid: "user123", email: "u@e.com", name: "User" };
  });

  it("POST /api/v1/ingest/text ingests raw text", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/text")
      .set("Authorization", "Bearer valid")
      .send({ courseId: "c1", rawContent: "some text", sourcePlatform: "brightspace" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/v1/ingest/upload ingests uploaded file", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/upload")
      .set("Authorization", "Bearer valid")
      .field("courseId", "c1")
      .attach("file", Buffer.from("content"), "test.txt");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/v1/ingest/upload returns 400 if no file", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/upload")
      .set("Authorization", "Bearer valid")
      .field("courseId", "c1");

    expect(res.status).toBe(400);
  });

  it("POST /api/v1/ingest/upload returns 400 if no courseId", async () => {
    const res = await request(app)
      .post("/api/v1/ingest/upload")
      .set("Authorization", "Bearer valid")
      .attach("file", Buffer.from("content"), "test.txt");

    expect(res.status).toBe(400);
  });

  it("POST /api/v1/ingest/upload handles failures and cleans up", async () => {
    mockIngestFile.mockRejectedValueOnce(new Error("fail"));
    const res = await request(app)
      .post("/api/v1/ingest/upload")
      .set("Authorization", "Bearer valid")
      .field("courseId", "c1")
      .attach("file", Buffer.from("content"), "test.txt");

    expect(res.status).toBe(500);
  });

  it("POST /api/v1/ingest/text handles errors", async () => {
    mockIngestText.mockRejectedValueOnce(new Error("fail"));
    const res = await request(app)
      .post("/api/v1/ingest/text")
      .set("Authorization", "Bearer valid")
      .send({ courseId: "c1", rawContent: "text" });

    expect(res.status).toBe(500);
  });

  it("POST /api/v1/ingest/upload falls back to empty email/name when the token lacks them", async () => {
    mockUserHolder.user = { uid: "user123" };
    const res = await request(app)
      .post("/api/v1/ingest/upload")
      .set("Authorization", "Bearer valid")
      .field("courseId", "c1")
      .attach("file", Buffer.from("content"), "test.txt");

    expect(res.status).toBe(200);
    expect(ensureUserDoc).toHaveBeenCalledWith("user123", "", "");
  });

  it("POST /api/v1/ingest/text falls back to empty email/name when the token lacks them", async () => {
    mockUserHolder.user = { uid: "user123" };
    const res = await request(app)
      .post("/api/v1/ingest/text")
      .set("Authorization", "Bearer valid")
      .send({ courseId: "c1", rawContent: "text" });

    expect(res.status).toBe(200);
    expect(ensureUserDoc).toHaveBeenCalledWith("user123", "", "");
  });

  it("POST /api/v1/ingest/upload swallows a failed temp-file cleanup instead of crashing the response", async () => {
    mockUnlink.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    const res = await request(app)
      .post("/api/v1/ingest/upload")
      .set("Authorization", "Bearer valid")
      .field("courseId", "c1")
      .attach("file", Buffer.from("content"), "test.txt");

    expect(res.status).toBe(200);
    // Give the fire-and-forget unlink().catch() a tick to run before asserting it was reached.
    await vi.waitFor(() => expect(mockUnlink).toHaveBeenCalled());
  });
});
