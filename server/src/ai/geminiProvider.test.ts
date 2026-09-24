import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEmbed, mockUpload } = vi.hoisted(() => ({ mockEmbed: vi.fn(), mockUpload: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(function () {
    return {
      models: { embedContent: mockEmbed, generateContent: vi.fn(), generateContentStream: vi.fn() },
      files: { upload: mockUpload },
    };
  }),
}));

import { createGeminiProvider, isRetryableGeminiError, parseJsonResponse, EMBED_BATCH_SIZE } from "./geminiProvider";

const fakeEmbeddings = (n: number, offset = 0) => ({
  embeddings: Array.from({ length: n }, (_, i) => ({ values: [offset + i] })),
});

describe("geminiProvider", () => {
  beforeEach(() => {
    mockEmbed.mockReset();
    mockUpload.mockReset();
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

    it("throws when the response has fewer embeddings than inputs", async () => {
      mockEmbed.mockResolvedValue(fakeEmbeddings(1));
      await expect(createGeminiProvider().embedContent({ contents: ["a", "b"] })).rejects.toThrow(/mismatch/);
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
      [{ code: 503 }],
      [{ message: "got 429 Too Many Requests" }],
      [{ message: "quota exceeded" }],
    ])("retries %j", (err) => expect(isRetryableGeminiError(err)).toBe(true));

    it.each([[{ status: 400 }], [{ status: 404, message: "model not found" }], [null]])(
      "does not retry %j",
      (err) => expect(isRetryableGeminiError(err)).toBe(false),
    );
  });

  it("parses fenced JSON and reports invalid JSON", () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseJsonResponse("nope")).toThrow(/invalid JSON/);
  });
});
