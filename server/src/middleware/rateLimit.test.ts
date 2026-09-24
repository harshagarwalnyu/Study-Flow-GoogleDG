import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// In-memory Firestore double with transactions, for the shared store.
const { docs } = vi.hoisted(() => ({ docs: new Map<string, any>() }));
vi.mock("../db/firebase", () => {
  const ref = (path: string) => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    update: async (d: any) => {
      if (!docs.has(path)) throw new Error("NOT_FOUND");
      const cur = docs.get(path);
      docs.set(path, { ...cur, hits: d.hits?.increment != null ? cur.hits + d.hits.increment : d.hits });
    },
    delete: async () => void docs.delete(path),
  });
  return {
    db: {
      collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`) }),
      runTransaction: async (fn: any) => {
        const writes: Array<() => void> = [];
        const out = await fn({
          get: async (r: any) => ({ exists: docs.has(r.path), data: () => docs.get(r.path) }),
          set: (r: any, d: any) => writes.push(() => docs.set(r.path, d)),
          update: (r: any, d: any) => writes.push(() => docs.set(r.path, { ...docs.get(r.path), ...d })),
        });
        writes.forEach((w) => w());
        return out;
      },
    },
  };
});
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { increment: (n: number) => ({ increment: n }) } }));

import { FirestoreRateLimitStore } from "./firestoreRateLimitStore";
import { aiLimiter } from "./rateLimit";
import { env, parseTrustProxy, parseRateLimitStore } from "../env";

describe("FirestoreRateLimitStore", () => {
  let store: FirestoreRateLimitStore;
  beforeEach(() => {
    docs.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
    store = new FirestoreRateLimitStore({ prefix: "ai:" });
    store.init({ windowMs: 60_000 } as any);
  });
  afterEach(() => vi.useRealTimers());

  it("counts hits within a window and reports when it resets", async () => {
    const first = await store.increment("u1");
    const second = await store.increment("u1");
    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.resetTime).toEqual(new Date("2026-09-24T12:01:00Z"));
    expect(await store.get("u1")).toEqual({ totalHits: 2, resetTime: second.resetTime });
  });

  it("starts a new window once the old one has passed, with a TTL timestamp", async () => {
    await store.increment("u1");
    await store.increment("u1");
    vi.setSystemTime(new Date("2026-09-24T12:01:00.001Z"));
    expect(await store.get("u1")).toBeUndefined();
    const next = await store.increment("u1");
    expect(next.totalHits).toBe(1);
    expect(docs.get("rateLimits/ai%3Au1").expireAt).toEqual(next.resetTime);
  });

  it("keeps keys separate and encodes characters that are unsafe in document ids", async () => {
    await store.increment("u1");
    await store.increment("ip:10.0.0.1/x");
    expect((await store.increment("u1")).totalHits).toBe(2);
    expect([...docs.keys()]).toContain("rateLimits/ai%3Aip%3A10.0.0.1%2Fx");
  });

  it("decrements, tolerates decrementing a missing key, and resets", async () => {
    await store.increment("u1");
    await store.increment("u1");
    await store.decrement("u1");
    expect((await store.get("u1"))?.totalHits).toBe(1);
    await expect(store.decrement("nobody")).resolves.toBeUndefined();
    await store.resetKey("u1");
    expect(await store.get("u1")).toBeUndefined();
  });

  it("is declared shared so express-rate-limit does not warn about double counting", () => {
    expect(store.localKeys).toBe(false);
    expect(store.prefix).toBe("ai:");
  });
});

describe("aiLimiter", () => {
  const appFor = () => {
    const app = express();
    app.use((req, _res, next) => {
      const uid = req.header("x-test-uid");
      if (uid) req.user = { uid } as any;
      next();
    });
    app.post("/ai", aiLimiter, (_req, res) => res.json({ ok: true }));
    return app;
  };

  it("limits each signed-in user separately, whatever IP they share", async () => {
    const app = appFor();
    for (let i = 0; i < env.rateLimitAiPerMinute; i++) {
      await request(app).post("/ai").set("x-test-uid", "limit-a").expect(200);
    }
    const blocked = await request(app).post("/ai").set("x-test-uid", "limit-a");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/Too many requests/);
    await request(app).post("/ai").set("x-test-uid", "limit-b").expect(200);
  });
});

describe("env parsing for rate limiting", () => {
  it("parses TRUST_PROXY as a hop count, a boolean, or off", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("0")).toBe(0);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("nonsense")).toBe(false);
  });

  it("only enables the shared store when asked", () => {
    expect(parseRateLimitStore("firestore")).toBe("firestore");
    expect(parseRateLimitStore(" Firestore ")).toBe("firestore");
    expect(parseRateLimitStore("redis")).toBe("memory");
    expect(parseRateLimitStore(undefined)).toBe("memory");
    expect(env.rateLimitIpPerMinute).toBe(120);
  });
});
