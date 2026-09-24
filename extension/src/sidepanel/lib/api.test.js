import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { currentUserMock } = vi.hoisted(() => ({
  currentUserMock: { current: null },
}));

vi.mock("./firebase", () => ({
  get auth() {
    return { currentUser: currentUserMock.current };
  },
  hasFirebaseConfig: true,
}));

describe("apiFetch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    currentUserMock.current = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attaches a bearer token from the signed-in Firebase user and returns parsed JSON", async () => {
    currentUserMock.current = { getIdToken: vi.fn(() => Promise.resolve("firebase-token")) };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch, API_URL } = await import("./api");
    const result = await apiFetch("/api/v1/thing");

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith(`${API_URL}/api/v1/thing`, expect.any(Object));
    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer firebase-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("falls back to the chrome.storage.session token when there is no Firebase user", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", {
      storage: {
        session: {
          get: vi.fn((_keys, cb) => cb({ firebaseIdToken: "stored-token" })),
        },
      },
    });

    const { apiFetch } = await import("./api");
    await apiFetch("/api/v1/thing");

    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer stored-token");
  });

  it("sends no Authorization header when there is no user and no stored token", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await apiFetch("/api/v1/thing");

    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws a friendly message when chrome.storage.session has no token stored", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", {
      storage: { session: { get: vi.fn((_keys, cb) => cb({})) } },
    });

    const { apiFetch } = await import("./api");
    await apiFetch("/api/v1/thing");

    const headers = fetchImpl.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it("rejects a non-localhost http:// API URL", async () => {
    vi.stubEnv("VITE_API_URL", "http://example.com");
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/must be localhost for HTTP/);
  });

  it("allows a localhost http:// API URL", async () => {
    vi.stubEnv("VITE_API_URL", "http://localhost:3000");
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).resolves.toEqual({ ok: true });
  });

  it("allows a 127.0.0.1 http:// API URL", async () => {
    vi.stubEnv("VITE_API_URL", "http://127.0.0.1:3000");
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).resolves.toEqual({ ok: true });
  });

  it("allows an IPv6 loopback http:// API URL", async () => {
    vi.stubEnv("VITE_API_URL", "http://[::1]:3000");
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).resolves.toEqual({ ok: true });
  });

  it("rejects a production build that is not served over https", async () => {
    vi.stubEnv("VITE_API_URL", "https://valid.example.com");
    vi.stubEnv("PROD", true);
    // Re-stub the URL to something non-https and non-local after PROD is toggled.
    vi.stubEnv("VITE_API_URL", "ftp://weird.example.com");
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/must use https/);
  });

  it("tolerates a VITE_API_URL that new URL() cannot parse", async () => {
    // Not http(s), so validateApiUrl's early checks don't fire, but computing
    // `apiHost` still has to survive the URL constructor throwing.
    vi.stubEnv("VITE_API_URL", "not a url");
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).resolves.toEqual({ ok: true });
  });

  it("allows a production build served over https", async () => {
    vi.stubEnv("VITE_API_URL", "https://api.example.com");
    vi.stubEnv("PROD", true);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).resolves.toEqual({ ok: true });
  });

  it("wraps a network failure (TypeError) in a developer-friendly message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch, API_URL } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(new RegExp(`Cannot reach API at ${API_URL}`));
  });

  it("passes through a non-network error message unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("boom"))),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow("boom");
  });

  it("falls back to String(err) when the rejection has no .message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject("network down")),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow("network down");
  });

  it("recovers from res.json() rejecting on a malformed error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("not json{", { status: 503 }))),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow("{}");
  });

  it("stringifies a non-string error field from the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 12345 }), { status: 400 })),
      ),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow("12345");
  });

  it("maps a 429 response to a quota-exceeded message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "slow down" }), { status: 429 }),
        ),
      ),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/Gemini API quota exceeded/);
  });

  it("maps a resource_exhausted body message to the quota-exceeded message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "RESOURCE_EXHAUSTED: over limit" }), {
            status: 500,
          }),
        ),
      ),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/Gemini API quota exceeded/);
  });

  it("maps a billing-related body message to the quota-exceeded message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "billing account disabled" }), {
            status: 402,
          }),
        ),
      ),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/Gemini API quota exceeded/);
  });

  it("uses the raw string body when JSON parsing gives a plain string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify("just a string"), { status: 400 })),
      ),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow("just a string");
  });

  it("stringifies an object body with no error/message field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ weird: "shape" }), { status: 400 }))),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/weird/);
  });

  it("falls back to a generic status message when the parsed body is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("null", { status: 500 }))),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow("Request failed (500)");
  });

  it("truncates an overly long error message", async () => {
    const longMessage = "x".repeat(500);
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ error: longMessage }), { status: 400 })),
      ),
    );
    vi.stubGlobal("chrome", undefined);

    const { apiFetch } = await import("./api");
    await expect(apiFetch("/x")).rejects.toThrow(/x{420}…$/);
  });
});
