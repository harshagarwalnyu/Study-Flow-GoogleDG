import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmbedContent = vi.fn();
vi.mock("../ai/index", () => ({
  getAiProvider: vi.fn(() => ({
    embedContent: mockEmbedContent,
    resolveModelName: (alias: string) => (alias === "embedding" ? "gemini-embedding-2" : alias),
  })),
}));

import {
  embedQuery,
  embedDocuments,
  embedLabels,
  formatQuery,
  formatDocument,
  cosineSimilarity,
  currentEmbeddingModel,
} from "./embeddings";

describe("Embeddings Service", () => {
  beforeEach(() => mockEmbedContent.mockReset());

  it("formats queries and documents with the paired gemini-embedding-2 retrieval prefixes", () => {
    expect(formatQuery("what is a limit")).toBe("task: question answering | query: what is a limit");
    expect(formatDocument("body", "Week 1 notes.pdf")).toBe("title: Week 1 notes.pdf | text: body");
    expect(formatDocument("body")).toBe("title: none | text: body");
    expect(formatDocument("body", "  multi\nline  ")).toBe("title: multi line | text: body");
  });

  it("embeds a query at 768 dimensions", async () => {
    mockEmbedContent.mockResolvedValue([[0.1, 0.2]]);
    expect(await embedQuery("q")).toEqual([0.1, 0.2]);
    expect(mockEmbedContent).toHaveBeenCalledWith({
      contents: "task: question answering | query: q",
      outputDimensionality: 768,
    });
  });

  it("embeds documents with the title applied to each", async () => {
    mockEmbedContent.mockResolvedValue([[0.1], [0.2]]);
    expect(await embedDocuments(["a", "b"], "t")).toEqual([[0.1], [0.2]]);
    expect(mockEmbedContent).toHaveBeenCalledWith({
      contents: ["title: t | text: a", "title: t | text: b"],
      outputDimensionality: 768,
    });
  });

  it("skips the API for empty inputs", async () => {
    expect(await embedDocuments([])).toEqual([]);
    expect(await embedLabels([])).toEqual([]);
    expect(mockEmbedContent).not.toHaveBeenCalled();
  });

  it("embeds concept labels as words, not snake_case", async () => {
    mockEmbedContent.mockResolvedValue([[1]]);
    await embedLabels(["chain_rule"]);
    expect(mockEmbedContent).toHaveBeenCalledWith({
      contents: ["task: clustering | query: chain rule"],
      outputDimensionality: 768,
    });
  });

  it("reports the concrete embedding model id", () => {
    expect(currentEmbeddingModel()).toBe("gemini-embedding-2");
  });

  it("computes cosine similarity", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});
