import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome } from "./test-chrome";
import { STORAGE_KEYS } from "./messages";

const authStateMock = vi.hoisted(() => ({
  auth: null as { currentUser: { getIdToken: () => Promise<string> } | null } | null,
}));
vi.mock("./auth", () => ({ authState: authStateMock }));

const { apiFetch, apiFetchParsed } = await import("./api");

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authStateMock.auth = null;
  });

  it("uses the Firebase user's ID token when a current user exists", async () => {
    authStateMock.auth = {
      currentUser: { getIdToken: vi.fn(() => Promise.resolve("firebase-token")) },
    };
    const fakeChrome = createFakeChrome({ storage: { local: { [STORAGE_KEYS.apiUrl]: "http://localhost:3000" } } });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ hello: "world" }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiFetch("/api/v1/graph")).resolves.toEqual({ hello: "world" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer firebase-token");
  });

  it("falls back to the session-stored ID token when there is no current Firebase user", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome({
      storage: {
        local: { [STORAGE_KEYS.apiUrl]: "http://localhost:3000" },
        session: { [STORAGE_KEYS.firebaseIdToken]: "session-token" },
      },
    });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await apiFetch("/api/v1/graph");

    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer session-token");
  });

  it("sends no Authorization header when neither a Firebase user nor a session token exists", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome({ storage: { local: { [STORAGE_KEYS.apiUrl]: "http://localhost:3000" } } });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await apiFetch("/api/v1/graph");

    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers((init as RequestInit).headers).get("Authorization")).toBeNull();
  });

  it("prefers a locally stored apiUrl override over the built-in default", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome({ storage: { local: { [STORAGE_KEYS.apiUrl]: "http://localhost:4001" } } });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await apiFetch("/api/v1/graph");

    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:4001/api/v1/graph", expect.anything());
  });

  it("falls back to the extension's default API URL when nothing is stored locally", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await apiFetch("/api/v1/graph");

    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:3000/api/v1/graph", expect.anything());
  });

  it("propagates the backend's error message when the response is not ok", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome({ storage: { local: { [STORAGE_KEYS.apiUrl]: "http://localhost:3000" } } });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Not authorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await expect(apiFetch("/api/v1/graph")).rejects.toThrow("Not authorized");
  });
});

describe("apiFetchParsed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authStateMock.auth = null;
  });

  it("parses the fetched response through the given schema", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome({ storage: { local: { [STORAGE_KEYS.apiUrl]: "http://localhost:3000" } } });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ count: 3 }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const schema = { parse: (data: unknown) => ({ doubled: (data as { count: number }).count * 2 }) };
    await expect(apiFetchParsed("/api/v1/graph", schema)).resolves.toEqual({ doubled: 6 });
  });

  it("propagates a schema parse failure", async () => {
    authStateMock.auth = { currentUser: null };
    const fakeChrome = createFakeChrome({ storage: { local: { [STORAGE_KEYS.apiUrl]: "http://localhost:3000" } } });
    vi.stubGlobal("chrome", fakeChrome);
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const schema = {
      parse: () => {
        throw new Error("shape mismatch");
      },
    };
    await expect(apiFetchParsed("/api/v1/graph", schema)).rejects.toThrow("shape mismatch");
  });
});
