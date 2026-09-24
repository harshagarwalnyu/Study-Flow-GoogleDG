import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiClient = {
  apiUrl: "http://mock-api.test",
  apiFetch: vi.fn(),
};

const createFirebaseApiClient = vi.fn(() => mockApiClient);
const clientFetchGraph = vi.fn();
const clientFetchDrillQueue = vi.fn();
const clientFetchRecentEvents = vi.fn();
const clientFetchGamification = vi.fn();
const clientTrackClientEvent = vi.fn();
const clientIngestTextContent = vi.fn();
const clientUploadIngestFile = vi.fn();

vi.mock("@study-flow/client", () => ({
  createFirebaseApiClient,
  fetchGraph: clientFetchGraph,
  fetchDrillQueue: clientFetchDrillQueue,
  fetchRecentEvents: clientFetchRecentEvents,
  fetchGamification: clientFetchGamification,
  trackClientEvent: clientTrackClientEvent,
  ingestTextContent: clientIngestTextContent,
  uploadIngestFile: clientUploadIngestFile,
}));

const fakeAuthState = {
  env: { VITE_API_URL: "http://from-env.test" },
};

vi.mock("./firebase", () => ({
  authState: fakeAuthState,
  clientMode: "test",
}));

describe("lib/api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates the underlying Firebase API client once at module load using authState + clientMode", async () => {
    const api = await import("./api");

    expect(createFirebaseApiClient).toHaveBeenCalledWith(
      fakeAuthState,
      fakeAuthState.env.VITE_API_URL,
      { mode: "test" },
    );
    expect(api.apiUrl).toBe(mockApiClient.apiUrl);
  });

  it("apiFetch forwards path and options to the underlying client", async () => {
    const api = await import("./api");
    mockApiClient.apiFetch.mockResolvedValue({ ok: true });

    const result = await api.apiFetch("/foo", { method: "POST" });

    expect(mockApiClient.apiFetch).toHaveBeenCalledWith("/foo", {
      method: "POST",
    });
    expect(result).toEqual({ ok: true });
  });

  it("fetchGraph delegates to the client helper with the api client and options", async () => {
    const api = await import("./api");
    const options = { signal: new AbortController().signal };
    clientFetchGraph.mockResolvedValue({ nodes: [] });

    const result = await api.fetchGraph(options);

    expect(clientFetchGraph).toHaveBeenCalledWith(mockApiClient, options);
    expect(result).toEqual({ nodes: [] });
  });

  it("fetchDrillQueue delegates to the client helper with the api client and options", async () => {
    const api = await import("./api");
    clientFetchDrillQueue.mockResolvedValue({ queue: [] });

    const result = await api.fetchDrillQueue();

    expect(clientFetchDrillQueue).toHaveBeenCalledWith(mockApiClient, undefined);
    expect(result).toEqual({ queue: [] });
  });

  it("fetchRecentEvents defaults the limit to 20 when not provided", async () => {
    const api = await import("./api");
    clientFetchRecentEvents.mockResolvedValue({ events: [], count: 0 });

    await api.fetchRecentEvents();

    expect(clientFetchRecentEvents).toHaveBeenCalledWith(
      mockApiClient,
      20,
      undefined,
    );
  });

  it("fetchRecentEvents forwards a custom limit and options", async () => {
    const api = await import("./api");
    const options = { skipJsonContentType: true };
    clientFetchRecentEvents.mockResolvedValue({ events: [], count: 0 });

    await api.fetchRecentEvents(5, options);

    expect(clientFetchRecentEvents).toHaveBeenCalledWith(
      mockApiClient,
      5,
      options,
    );
  });

  it("fetchGamification delegates to the client helper", async () => {
    const api = await import("./api");
    clientFetchGamification.mockResolvedValue({ xp: 1 });

    const result = await api.fetchGamification();

    expect(clientFetchGamification).toHaveBeenCalledWith(
      mockApiClient,
      undefined,
    );
    expect(result).toEqual({ xp: 1 });
  });

  it("trackClientEvent delegates the payload and options to the client helper", async () => {
    const api = await import("./api");
    const payload = { eventType: "page_view", content: "/" };
    clientTrackClientEvent.mockResolvedValue({ eventId: "e1" });

    const result = await api.trackClientEvent(payload as any);

    expect(clientTrackClientEvent).toHaveBeenCalledWith(
      mockApiClient,
      payload,
      undefined,
    );
    expect(result).toEqual({ eventId: "e1" });
  });

  it("ingestTextContent delegates the payload and options to the client helper", async () => {
    const api = await import("./api");
    const payload = {
      courseId: "c1",
      rawContent: "notes",
      filename: "f.txt",
      sourcePlatform: "dashboard",
    };
    clientIngestTextContent.mockResolvedValue({ ok: true });

    const result = await api.ingestTextContent(payload as any);

    expect(clientIngestTextContent).toHaveBeenCalledWith(
      mockApiClient,
      payload,
      undefined,
    );
    expect(result).toEqual({ ok: true });
  });

  it("uploadIngestFile delegates the file, courseId, and options to the client helper", async () => {
    const api = await import("./api");
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    clientUploadIngestFile.mockResolvedValue({ ok: true });

    const result = await api.uploadIngestFile(file, "course-1");

    expect(clientUploadIngestFile).toHaveBeenCalledWith(
      mockApiClient,
      file,
      "course-1",
      undefined,
    );
    expect(result).toEqual({ ok: true });
  });
});
