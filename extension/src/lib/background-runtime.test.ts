/// <reference types="bun-types" />
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildIngestRequest,
  createMessageErrorResponse,
  handleExtensionMessage,
  ingestToBackend,
  readConfiguredApiUrl,
} from "./background-runtime";
import { persistFirebaseIdToken } from "./auth-session";
import { STORAGE_KEYS, type ExtensionRuntimeMessage, type IngestPagePayload, type IngestPdfPayload } from "./messages";
import type { StorageAreaLike } from "./chrome-storage";
import { createFakeChrome } from "./test-chrome";

function createStorage(initialState: Record<string, unknown> = {}): StorageAreaLike & { state: Record<string, unknown> } {
  const state = { ...initialState };

  return {
    state,
    get(keys) {
      const requestedKeys = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : Object.keys(keys);

      return requestedKeys.reduce<Record<string, unknown>>((result, key) => {
        if (key in state) {
          result[key] = state[key];
        }
        return result;
      }, {});
    },
    set(items) {
      Object.assign(state, items);
    },
    remove(keys) {
      const keysToRemove = Array.isArray(keys) ? keys : [keys];
      for (const key of keysToRemove) {
        delete state[key];
      }
    },
  };
}

const samplePayload: IngestPagePayload = {
  rawContent: "Integral practice set",
  courseName: "calc-101",
  sourcePlatform: "brightspace",
};

describe("background runtime", () => {
  it("builds the ingest payload expected by the backend", () => {
    expect(buildIngestRequest(samplePayload)).toEqual({
      courseId: "calc-101",
      rawContent: "Integral practice set",
      sourcePlatform: "brightspace",
    });
  });

  it("falls back to a 'general' courseId when no course name was derived", () => {
    expect(buildIngestRequest({ ...samplePayload, courseName: "" })).toEqual({
      courseId: "general",
      rawContent: "Integral practice set",
      sourcePlatform: "brightspace",
    });
  });

  it("normalizes a stored API URL and rejects unsafe hosts", async () => {
    const safeStorage = createStorage({ [STORAGE_KEYS.apiUrl]: "http://localhost:3000/" });
    await expect(readConfiguredApiUrl(safeStorage)).resolves.toBe("http://localhost:3000");

    const unsafeStorage = createStorage({ [STORAGE_KEYS.apiUrl]: "http://example.com" });
    await expect(readConfiguredApiUrl(unsafeStorage)).rejects.toThrow("VITE_API_URL");
  });

  it("stores last ingested content and posts it when a token exists", async () => {
    const localStorage = createStorage({ [STORAGE_KEYS.apiUrl]: "http://localhost:3000/" });
    const sessionStorage = createStorage({ [STORAGE_KEYS.firebaseIdToken]: "token-123" });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, courseId: "calc-101", ingestedAt: new Date().toISOString() }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      handleExtensionMessage(
        { type: "INGEST_PAGE", payload: samplePayload },
        {},
        {
          localStorage,
          sessionStorage,
          sidePanel: { open: vi.fn(() => Promise.resolve()) },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(sessionStorage.state[STORAGE_KEYS.lastIngestedContent]).toEqual(samplePayload);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/v1/ingest/text",
      expect.objectContaining({
        method: "POST",
        headers: expect.any(Headers),
      }),
    );

    const callArgs = (fetchImpl.mock.calls as any)[0];
    const headers = callArgs[1].headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("Content-Type")).toBe("application/json");

    const requestInit = callArgs[1] as RequestInit;
    expect(JSON.parse(String(requestInit.body))).toEqual({
      courseId: "calc-101",
      rawContent: "Integral practice set",
      sourcePlatform: "brightspace",
    });
  });

  it("skips ingestion silently when there is no stored Firebase token", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

    await ingestToBackend(samplePayload, {
      localStorage: createStorage(),
      sessionStorage: createStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mode: "development",
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("persists Ask prefill text and opens the side panel", async () => {
    const sessionStorage = createStorage();
    const open = vi.fn(() => Promise.resolve());

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK", payload: { selectedText: "Explain Green's theorem" } },
        { tab: { windowId: 42 } },
        {
          localStorage: createStorage(),
          sessionStorage,
          sidePanel: { open },
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(sessionStorage.state[STORAGE_KEYS.prefillAsk]).toBe("Explain Green's theorem");
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });
});

describe("auth session persistence", () => {
  it("stores and clears the Firebase ID token in session storage", async () => {
    const sessionStorage = createStorage();

    await persistFirebaseIdToken(sessionStorage, "fresh-token");
    expect(sessionStorage.state[STORAGE_KEYS.firebaseIdToken]).toBe("fresh-token");

    await persistFirebaseIdToken(sessionStorage, null);
    expect(sessionStorage.state[STORAGE_KEYS.firebaseIdToken]).toBeUndefined();
  });

  it("refreshes the drill badge on request, and tolerates a missing refresher", async () => {
    const refreshDrillBadge = vi.fn(async () => 3);
    const base = { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: { open: () => undefined } };
    await expect(handleExtensionMessage({ type: "REFRESH_DRILL_BADGE" }, {}, { ...base, refreshDrillBadge })).resolves.toEqual({ ok: true });
    expect(refreshDrillBadge).toHaveBeenCalledTimes(1);
    await expect(handleExtensionMessage({ type: "REFRESH_DRILL_BADGE" }, {}, base)).resolves.toEqual({ ok: true });
  });
});

const samplePdfPayload: IngestPdfPayload = {
  pdfUrl: "https://brightspace.example/DirectFile/9",
  filename: "syllabus.pdf",
  courseName: "calc-101",
  sourcePlatform: "brightspace",
};

describe("INGEST_PDF / ingestPdfToBackend", () => {
  it("skips the upload silently when there is no stored Firebase token", async () => {
    const fetchImpl = vi.fn();

    await expect(
      handleExtensionMessage(
        { type: "INGEST_PDF", payload: samplePdfPayload },
        {},
        {
          localStorage: createStorage(),
          sessionStorage: createStorage(),
          sidePanel: { open: vi.fn() },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing further when the PDF itself fails to download", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));

    await expect(
      handleExtensionMessage(
        { type: "INGEST_PDF", payload: samplePdfPayload },
        {},
        {
          localStorage: createStorage({ [STORAGE_KEYS.apiUrl]: "http://localhost:3000" }),
          sessionStorage: createStorage({ [STORAGE_KEYS.firebaseIdToken]: "tok" }),
          sidePanel: { open: vi.fn() },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("downloads the PDF with session cookies and uploads it as multipart form data", async () => {
    const pdfBytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === samplePdfPayload.pdfUrl) {
        expect(init).toEqual(expect.objectContaining({ credentials: "include" }));
        return Promise.resolve(new Response(pdfBytes, { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, filename: samplePdfPayload.filename, courseId: "calc-101" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    await expect(
      handleExtensionMessage(
        { type: "INGEST_PDF", payload: samplePdfPayload },
        {},
        {
          localStorage: createStorage({ [STORAGE_KEYS.apiUrl]: "http://localhost:3000" }),
          sessionStorage: createStorage({ [STORAGE_KEYS.firebaseIdToken]: "tok" }),
          sidePanel: { open: vi.fn() },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const uploadCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/ingest/upload"));
    expect(uploadCall).toBeDefined();
    const uploadBody = uploadCall?.[1]?.body as FormData;
    expect(uploadBody.get("courseId")).toBe("calc-101");
    const uploadedFile = uploadBody.get("file") as File;
    expect(uploadedFile.name).toBe("syllabus.pdf");
  });

  it("falls back to the global fetch when no fetchImpl override is provided", async () => {
    const globalFetch = vi.fn(() => Promise.resolve(new Response(null, { status: 403 })));
    vi.stubGlobal("fetch", globalFetch);

    try {
      await expect(
        handleExtensionMessage(
          { type: "INGEST_PDF", payload: samplePdfPayload },
          {},
          {
            localStorage: createStorage({ [STORAGE_KEYS.apiUrl]: "http://localhost:3000" }),
            sessionStorage: createStorage({ [STORAGE_KEYS.firebaseIdToken]: "tok" }),
            sidePanel: { open: vi.fn() },
          },
        ),
      ).resolves.toEqual({ ok: true });

      expect(globalFetch).toHaveBeenCalledWith(samplePdfPayload.pdfUrl, { credentials: "include" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("side-panel opening and screenshot capture (via global chrome)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("OPEN_ASK: does nothing when the sender has no window to target", async () => {
    const fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK" },
        {},
        { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: fakeChrome.sidePanel },
      ),
    ).resolves.toEqual({ ok: true });

    expect(fakeChrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it("OPEN_ASK: swallows the 'user gesture' error chrome throws for a stale/background trigger", async () => {
    const fakeChrome = createFakeChrome();
    (fakeChrome.sidePanel.open as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error("sidePanel.open() may only be called in response to a user gesture")),
    );
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK" },
        { tab: { windowId: 5 } },
        { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: fakeChrome.sidePanel },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("OPEN_ASK: rethrows any other side-panel error", async () => {
    const fakeChrome = createFakeChrome();
    (fakeChrome.sidePanel.open as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.reject(new Error("boom")),
    );
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK" },
        { tab: { windowId: 5 } },
        { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: fakeChrome.sidePanel },
      ),
    ).rejects.toThrow("boom");
  });

  it("OPEN_QUIZ: stores the pending route and opens the side panel", async () => {
    const fakeChrome = createFakeChrome();
    const sessionStorage = createStorage();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_QUIZ" },
        { tab: { windowId: 8 } },
        { localStorage: createStorage(), sessionStorage, sidePanel: fakeChrome.sidePanel },
      ),
    ).resolves.toEqual({ ok: true });

    expect(sessionStorage.state[STORAGE_KEYS.navigateTo]).toBe("quiz");
    expect(fakeChrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 8 });
  });

  it("OPEN_ASK_SCREENSHOT: captures the tab and stores the prefill image", async () => {
    const fakeChrome = createFakeChrome();
    const sessionStorage = createStorage();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK_SCREENSHOT", payload: { selectedText: "limits" } },
        { tab: { windowId: 2 } },
        { localStorage: createStorage(), sessionStorage, sidePanel: fakeChrome.sidePanel },
      ),
    ).resolves.toEqual({ ok: true });

    expect(sessionStorage.state[STORAGE_KEYS.prefillAskImageBase64]).toBe("ZmFrZQ==");
    expect(sessionStorage.state[STORAGE_KEYS.prefillAsk]).toBe("limits");
    expect(sessionStorage.state[STORAGE_KEYS.navigateTo]).toBe("ask");
  });

  it("OPEN_ASK_SCREENSHOT: defaults the prefill text to empty when there is no payload", async () => {
    const fakeChrome = createFakeChrome();
    const sessionStorage = createStorage();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK_SCREENSHOT" },
        { tab: { windowId: 2 } },
        { localStorage: createStorage(), sessionStorage, sidePanel: fakeChrome.sidePanel },
      ),
    ).resolves.toEqual({ ok: true });

    expect(sessionStorage.state[STORAGE_KEYS.prefillAsk]).toBe("");
  });

  it("OPEN_QUIZ_SCREENSHOT: captures the tab and stores the prefill image", async () => {
    const fakeChrome = createFakeChrome();
    const sessionStorage = createStorage();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_QUIZ_SCREENSHOT" },
        { tab: { windowId: 2 } },
        { localStorage: createStorage(), sessionStorage, sidePanel: fakeChrome.sidePanel },
      ),
    ).resolves.toEqual({ ok: true });

    expect(sessionStorage.state[STORAGE_KEYS.prefillQuizImageBase64]).toBe("ZmFrZQ==");
    expect(sessionStorage.state[STORAGE_KEYS.navigateTo]).toBe("quiz");
  });

  it("screenshot capture throws when the sender has no window to capture", async () => {
    const fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK_SCREENSHOT" },
        {},
        { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: fakeChrome.sidePanel },
      ),
    ).rejects.toThrow("No active window to capture.");
  });

  it("screenshot capture rejects when chrome.runtime.lastError is set", async () => {
    const fakeChrome = createFakeChrome();
    (fakeChrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_windowId: number, _opts: unknown, callback: (url?: string) => void) => {
        fakeChrome.runtime.lastError = { message: "Cannot access contents of this page" };
        callback(undefined);
        fakeChrome.runtime.lastError = undefined;
      },
    );
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK_SCREENSHOT" },
        { tab: { windowId: 1 } },
        { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: fakeChrome.sidePanel },
      ),
    ).rejects.toThrow("Cannot access contents of this page");
  });

  it("screenshot capture throws when the captured data URL has no base64 payload", async () => {
    const fakeChrome = createFakeChrome();
    (fakeChrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_windowId: number, _opts: unknown, callback: (url?: string) => void) => callback(""),
    );
    vi.stubGlobal("chrome", fakeChrome);

    await expect(
      handleExtensionMessage(
        { type: "OPEN_ASK_SCREENSHOT" },
        { tab: { windowId: 1 } },
        { localStorage: createStorage(), sessionStorage: createStorage(), sidePanel: fakeChrome.sidePanel },
      ),
    ).rejects.toThrow("Screenshot capture returned empty image data.");
  });
});

describe("unknown message types and error responses", () => {
  it("responds with an error for a message type outside the known union", async () => {
    const unknownMessage = { type: "SOMETHING_ELSE" } as unknown as ExtensionRuntimeMessage;

    await expect(
      handleExtensionMessage(unknownMessage, {}, {
        localStorage: createStorage(),
        sessionStorage: createStorage(),
        sidePanel: { open: vi.fn() },
      }),
    ).resolves.toEqual({ ok: false, error: "Unknown message type: SOMETHING_ELSE" });
  });

  it("createMessageErrorResponse formats Error and non-Error values", () => {
    expect(createMessageErrorResponse(new Error("bad request"))).toEqual({ ok: false, error: "bad request" });
    expect(createMessageErrorResponse("plain string failure")).toEqual({
      ok: false,
      error: "plain string failure",
    });
  });
});
