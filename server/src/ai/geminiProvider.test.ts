import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockEmbed, mockUpload, mockGenerate, mockGenerateStream } = vi.hoisted(() => ({
  mockEmbed: vi.fn(),
  mockUpload: vi.fn(),
  mockGenerate: vi.fn(),
  mockGenerateStream: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return {
      models: {
        embedContent: mockEmbed,
        generateContent: mockGenerate,
        generateContentStream: mockGenerateStream,
      },
      files: { upload: mockUpload },
    };
  }),
}));

import {
  createGeminiProvider,
  isRetryableGeminiError,
  parseJsonResponse,
  EMBED_BATCH_SIZE,
  geminiProvider,
} from "./geminiProvider";

const fakeEmbeddings = (n: number, offset = 0) => ({
  embeddings: Array.from({ length: n }, (_, i) => ({ values: [offset + i] })),
});

describe("geminiProvider", () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockUpload.mockReset();
    mockGenerate.mockReset();
    mockGenerateStream.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("exported geminiProvider singleton", () => {
    it("is defined and initialized", () => {
      expect(geminiProvider.name).toBe("gemini");
      expect(geminiProvider.client).toBeDefined();
    });
  });

  describe("resolveModelName", () => {
    it("resolves the model aliases and custom strings", () => {
      const provider = createGeminiProvider();
      expect(provider.resolveModelName("primary")).toBeDefined();
      expect(provider.resolveModelName("fast")).toBeDefined();
      expect(provider.resolveModelName("embedding")).toBe("gemini-embedding-2");
      expect(provider.resolveModelName("custom-model-x")).toBe("custom-model-x");
      expect(provider.resolveModelName(undefined as any)).toBe(provider.resolveModelName("primary"));
    });
  });

  describe("generateJson", () => {
    it("generates JSON with default options and string prompt", async () => {
      const provider = createGeminiProvider();
      mockGenerate.mockResolvedValue({
        text: '```json\n{"success": true}\n```',
      });

      const res = await provider.generateJson({ prompt: "give json" });
      expect(res).toEqual({ success: true });
      expect(mockGenerate).toHaveBeenCalledWith({
        model: provider.resolveModelName("primary"),
        contents: [{ role: "user", parts: [{ text: "give json" }] }],
        config: {
          temperature: 0.4,
          responseMimeType: "application/json",
        },
      });
    });

    it("generates JSON with custom model, temperature, and array prompt", async () => {
      const provider = createGeminiProvider();
      mockGenerate.mockResolvedValue({
        text: '{"items": [1, 2]}',
      });

      const promptArray = [{ role: "user", parts: [{ text: "step 1" }] }];
      const res = await provider.generateJson({
        model: "fast",
        prompt: promptArray,
        temperature: 0.8,
      });

      expect(res).toEqual({ items: [1, 2] });
      expect(mockGenerate).toHaveBeenCalledWith({
        model: provider.resolveModelName("fast"),
        contents: promptArray,
        config: {
          temperature: 0.8,
          responseMimeType: "application/json",
        },
      });
    });

    it("handles response.text being empty/null", async () => {
      const provider = createGeminiProvider();
      mockGenerate.mockResolvedValue({ text: "" });

      await expect(provider.generateJson({ prompt: "empty" })).rejects.toThrow(/invalid JSON/);
    });

    it("retries on retryable error and succeeds", async () => {
      vi.useFakeTimers();
      const provider = createGeminiProvider();

      mockGenerate
        .mockRejectedValueOnce({ status: 429, message: "Rate limit" })
        .mockResolvedValueOnce({ text: '{"retried": true}' });

      const promise = provider.generateJson({ prompt: "test" });
      await vi.advanceTimersByTimeAsync(2000);
      const res = await promise;

      expect(res).toEqual({ retried: true });
      expect(mockGenerate).toHaveBeenCalledTimes(2);
    });

    it("fails fast on non-retryable error", async () => {
      const provider = createGeminiProvider();
      mockGenerate.mockRejectedValue({ status: 400, message: "Bad Request" });

      await expect(provider.generateJson({ prompt: "bad" })).rejects.toMatchObject({ status: 400 });
      expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it("retries up to 3 times and throws last error on persistent retryable failure", async () => {
      vi.useFakeTimers();
      const provider = createGeminiProvider();
      mockGenerate.mockRejectedValue({ status: 503, message: "Unavailable" });

      const promise = provider.generateJson({ prompt: "fail" });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await expect(promise).rejects.toMatchObject({ status: 503 });
      expect(mockGenerate).toHaveBeenCalledTimes(3);
    });
  });

  describe("streamText", () => {
    it("streams text with string prompt and default options", async () => {
      const provider = createGeminiProvider();
      const mockStream = { [Symbol.asyncIterator]: async function* () { yield { text: () => "chunk" }; } };
      mockGenerateStream.mockResolvedValue(mockStream);

      const stream = await provider.streamText({ prompt: "stream this" });
      expect(stream).toBe(mockStream);
      expect(mockGenerateStream).toHaveBeenCalledWith({
        model: provider.resolveModelName("primary"),
        contents: [{ role: "user", parts: [{ text: "stream this" }] }],
        config: { temperature: 0.4 },
      });
    });

    it("streams text with array prompt and custom options", async () => {
      const provider = createGeminiProvider();
      const mockStream = {};
      mockGenerateStream.mockResolvedValue(mockStream);

      const promptArray = [{ role: "user", parts: [{ text: "p1" }] }];
      const stream = await provider.streamText({
        model: "fast",
        prompt: promptArray,
        temperature: 0.2,
      });

      expect(stream).toBe(mockStream);
      expect(mockGenerateStream).toHaveBeenCalledWith({
        model: provider.resolveModelName("fast"),
        contents: promptArray,
        config: { temperature: 0.2 },
      });
    });

    it("retries on retryable stream error and succeeds", async () => {
      vi.useFakeTimers();
      const provider = createGeminiProvider();
      const mockStream = { ok: true };

      mockGenerateStream
        .mockRejectedValueOnce({ status: "UNAVAILABLE" })
        .mockResolvedValueOnce(mockStream);

      const promise = provider.streamText({ prompt: "stream retry" });
      await vi.advanceTimersByTimeAsync(2000);
      const res = await promise;

      expect(res).toBe(mockStream);
      expect(mockGenerateStream).toHaveBeenCalledTimes(2);
    });

    it("fails fast on non-retryable stream error", async () => {
      const provider = createGeminiProvider();
      mockGenerateStream.mockRejectedValue({ status: 404, message: "Not found" });

      await expect(provider.streamText({ prompt: "stream 404" })).rejects.toMatchObject({ status: 404 });
      expect(mockGenerateStream).toHaveBeenCalledTimes(1);
    });

    it("retries up to 3 times on persistent stream error and throws", async () => {
      vi.useFakeTimers();
      const provider = createGeminiProvider();
      mockGenerateStream.mockRejectedValue({ status: "RESOURCE_EXHAUSTED" });

      const promise = provider.streamText({ prompt: "exhausted" });
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(4000);
      await expect(promise).rejects.toMatchObject({ status: "RESOURCE_EXHAUSTED" });
      expect(mockGenerateStream).toHaveBeenCalledTimes(3);
    });
  });

  describe("embedContent", () => {
    it("resolves the embedding alias to the configured live model", () => {
      expect(createGeminiProvider().resolveModelName("embedding")).toBe("gemini-embedding-2");
      expect(createGeminiProvider().resolveModelName("fast")).toBe("gemini-3.8-flash");
    });

    it("splits large inputs into batches and preserves order", async () => {
      const total = EMBED_BATCH_SIZE * 2 + 5;
      mockEmbed.mockImplementation(async ({ contents }: any) => {
        const first = Number(contents[0].parts[0].text);
        return fakeEmbeddings(contents.length, first);
      });

      const texts = Array.from({ length: total }, (_, i) => String(i));
      const vectors = await createGeminiProvider().embedContent({ contents: texts });

      expect(mockEmbed).toHaveBeenCalledTimes(3);
      expect(vectors).toHaveLength(total);
      expect(vectors.map((v) => v[0])).toEqual(texts.map(Number));
      expect(mockEmbed.mock.calls[0][0]).toMatchObject({ model: "gemini-embedding-2", config: { outputDimensionality: 768 } });
    });

    it("wraps a single string", async () => {
      mockEmbed.mockResolvedValue(fakeEmbeddings(1));
      expect(await createGeminiProvider().embedContent({ contents: "hi" })).toEqual([[0]]);
    });

    it("throws instead of returning a misaligned result when vectors are missing", async () => {
      mockEmbed.mockResolvedValue({ embeddings: [{ values: [1] }, { values: [] }] });
      await expect(createGeminiProvider().embedContent({ contents: ["a", "b"] })).rejects.toThrow(/expected 2 vectors, got 1/);
    });

    it("throws when the response has fewer embeddings than inputs or undefined embeddings", async () => {
      mockEmbed.mockResolvedValue(fakeEmbeddings(1));
      await expect(createGeminiProvider().embedContent({ contents: ["a", "b"] })).rejects.toThrow(/mismatch/);

      mockEmbed.mockResolvedValue({});
      await expect(createGeminiProvider().embedContent({ contents: ["a"] })).rejects.toThrow(/mismatch/);
    });
  });

  it("uploads files through the SDK files API", async () => {
    mockUpload.mockResolvedValue({ uri: "files/abc" });
    const file = await createGeminiProvider().uploadFile({ filePath: "/tmp/a.pdf", displayName: "a.pdf", mimeType: "application/pdf" });
    expect(file).toEqual({ uri: "files/abc" });
    expect(mockUpload).toHaveBeenCalledWith({ file: "/tmp/a.pdf", config: { displayName: "a.pdf", mimeType: "application/pdf" } });
  });

  describe("isRetryableGeminiError", () => {
    it.each([
      [{ status: 429 }],
      [{ status: 503 }],
      [{ status: "RESOURCE_EXHAUSTED" }],
      [{ status: "UNAVAILABLE" }],
      [{ code: 429 }],
      [{ code: 503 }],
      [{ message: "got 429 Too Many Requests" }],
      [{ message: "quota exceeded" }],
      [{ message: "service UNAVAILABLE right now" }],
      [{ message: "error RESOURCE_EXHAUSTED" }],
    ])("retries %j", (err) => expect(isRetryableGeminiError(err)).toBe(true));

    it.each([[{ status: 400 }], [{ status: 404, message: "model not found" }], [null], [{}]])(
      "does not retry %j",
      (err) => expect(isRetryableGeminiError(err)).toBe(false),
    );
  });

  describe("parseJsonResponse", () => {
    it("parses fenced JSON and plain JSON", () => {
      expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
      expect(parseJsonResponse('{"b":2}')).toEqual({ b: 2 });
    });

    it("throws on invalid JSON", () => {
      expect(() => parseJsonResponse("nope")).toThrow(/invalid JSON/);

      const spy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw "custom string error";
      });
      expect(() => parseJsonResponse("nope")).toThrow(/custom string error/);
      spy.mockRestore();
    });
  });
});
