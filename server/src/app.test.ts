import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

const { mockDb } = vi.hoisted(() => {
  const mock: any = {
    collection: vi.fn(),
    doc: vi.fn(),
    get: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  mock.collection.mockReturnValue(mock);
  mock.doc.mockReturnValue(mock);
  mock.where.mockReturnValue(mock);
  mock.limit.mockReturnValue(mock);
  return { mockDb: mock };
});

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => mockDb),
  FieldValue: { serverTimestamp: vi.fn(() => "ts"), increment: vi.fn((n) => n) },
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })) }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "m" }]) }));
vi.mock("./routes/index", () => ({ apiRouter: (_req: any, _res: any, next: any) => next() }));
vi.mock("./middleware/rateLimit", () => ({
  apiLimiter: (_req: any, _res: any, next: any) => next(),
  aiLimiter: (_req: any, _res: any, next: any) => next(),
}));

describe("app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection.mockReturnValue(mockDb);
    mockDb.doc.mockReturnValue(mockDb);
    mockDb.limit.mockReturnValue(mockDb);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("handles development mode /health check when Firestore succeeds", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOWED_ORIGINS", "");

    mockDb.get.mockResolvedValue({});

    const { app } = await import("./app");

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: "study-flow-api",
      env: "development",
      firestore: true,
    });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("handles development mode /health check when Firestore fails", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");

    mockDb.get.mockRejectedValue(new Error("Firestore down"));

    const { app } = await import("./app");

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      service: "study-flow-api",
      env: "development",
      firestore: false,
    });
  });

  it("handles production mode /health check when Firestore succeeds with allowed origins", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS", "https://example.com, https://app.example.com");

    mockDb.get.mockResolvedValue({});

    const { app } = await import("./app");

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      service: "study-flow-api",
    });
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });

  it("handles production mode /health check when Firestore fails and no allowed origins configured", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOWED_ORIGINS", "");

    mockDb.get.mockRejectedValue(new Error("Unavailable"));

    const { app } = await import("./app");

    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      ok: false,
      service: "study-flow-api",
    });
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  });
});
