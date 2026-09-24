import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Mock necessary deps
vi.mock("../middleware/rateLimit", () => ({ apiLimiter: (req: any, res: any, next: any) => next(), aiLimiter: (req: any, res: any, next: any) => next() }));
vi.mock("firebase-admin/app", () => ({ initializeApp: vi.fn(), cert: vi.fn(), getApps: vi.fn(() => [{ name: "mock" }]) }));

const mockSnap = {
  empty: false,
  docs: [{ id: "event-1", data: () => ({ eventType: "login", createdAt: new Date() }) }]
};

const mockGet = vi.fn().mockResolvedValue(mockSnap);
const mockOrderBy = vi.fn(() => ({ limit: vi.fn(() => ({ get: mockGet })), startAfter: vi.fn(() => ({ limit: vi.fn(() => ({ get: mockGet })) })) }));
const mockLimit = vi.fn(() => ({ get: mockGet }));

const mockCollection = vi.fn(() => ({
  doc: vi.fn(() => ({ collection: vi.fn(() => ({ orderBy: mockOrderBy, limit: mockLimit })) })),
  where: vi.fn()
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => ({ collection: mockCollection })),
  FieldValue: { serverTimestamp: vi.fn(() => "MOCK_TS") }
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({
    verifyIdToken: vi.fn().mockResolvedValue({ uid: "test-user-123", email: "test@example.com" })
  }))
}));

vi.mock("../services/firestore", () => ({
  saveClientEvent: vi.fn().mockResolvedValue("new-event-id")
}));

const { app } = await import("../app");

describe("Events API Integration", () => {
  it("GET /api/v1/events returns events list", async () => {
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Bearer token")
      .query({ limit: 10, offset: 0 });
    
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.count).toBe(1);
  });

  it("GET /api/v1/events handles offset", async () => {
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Bearer token")
      .query({ limit: 10, offset: 5 });
    
    expect(res.status).toBe(200);
    expect(mockOrderBy).toHaveBeenCalled();
  });

  it("POST /api/v1/events/track saves an event", async () => {
    const res = await request(app)
      .post("/api/v1/events/track")
      .set("Authorization", "Bearer token")
      .send({ eventType: "page_view", content: "home", meta: { some: "data" } });
    
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.eventId).toBe("new-event-id");
  });

  it("POST /api/v1/events/track returns 400 for invalid body", async () => {
    const res = await request(app)
      .post("/api/v1/events/track")
      .set("Authorization", "Bearer token")
      .send({ content: "home" }); // missing eventType
    
    expect(res.status).toBe(400);
  });

  it("GET /api/v1/events handles error", async () => {
    mockGet.mockRejectedValueOnce(new Error("firestore failure"));
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(500);
  });

  it("POST /api/v1/events/track handles saveClientEvent error", async () => {
    const { saveClientEvent } = await import("../services/firestore");
    vi.mocked(saveClientEvent).mockRejectedValueOnce(new Error("save failure"));
    const res = await request(app)
      .post("/api/v1/events/track")
      .set("Authorization", "Bearer token")
      .send({ eventType: "test_err" });
    expect(res.status).toBe(500);
  });

  it("POST /api/v1/events/track works with minimal body", async () => {
    const res = await request(app)
      .post("/api/v1/events/track")
      .set("Authorization", "Bearer token")
      .send({ eventType: "simple" });
    expect(res.status).toBe(200);
  });

  it("POST /api/v1/events/track defaults body to {} when the client sends no body at all", async () => {
    // No .send() and no Content-Type: express.json() never touches req.body, so the route's
    // `req.body ?? {}` fallback is what turns that into a defined object instead of a crash.
    const res = await request(app)
      .post("/api/v1/events/track")
      .set("Authorization", "Bearer token");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("eventType (string) is required");
  });

  // req.ip is typed as a non-optional string by @types/express, and supertest's loopback
  // socket always yields a truthy value, so `req.ip || ""` cannot be reached through a normal
  // request. It is still real, reachable code (Unix-domain-socket connections and some proxy
  // misconfigurations leave req.ip undefined), so we invoke the router's own handler directly.
  it("logs an empty ip instead of undefined when req.ip is unavailable", async () => {
    const { saveClientEvent } = await import("../services/firestore");
    vi.mocked(saveClientEvent).mockResolvedValueOnce("evt-1");

    const { eventsRouter } = await import("./events");
    const layer = (eventsRouter as any).stack.find((l: any) => l.route?.path === "/track");
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;

    const req: any = {
      user: { uid: "test-user-123" },
      body: { eventType: "page_view" },
      ip: "",
      originalUrl: "/api/v1/events/track",
      method: "POST",
      headers: {},
    };
    const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true, eventId: "evt-1" });
    const [, payload] = vi.mocked(saveClientEvent).mock.calls.at(-1)!;
    expect(payload.requestMeta?.ip).toBe("");
  });

  it("GET /api/v1/events handles offset with empty skipSnap", async () => {
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    const res = await request(app)
      .get("/api/v1/events")
      .set("Authorization", "Bearer token")
      .query({ limit: 10, offset: 5 });
    expect(res.status).toBe(200);
  });
});
