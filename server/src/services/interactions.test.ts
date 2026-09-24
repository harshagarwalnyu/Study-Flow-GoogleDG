import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClassify, mockRecord, mockSave, mockInvalidate, mockKnown, mockResolve } = vi.hoisted(() => ({
  mockClassify: vi.fn(),
  mockRecord: vi.fn().mockResolvedValue(undefined),
  mockSave: vi.fn().mockResolvedValue("evt-1"),
  mockInvalidate: vi.fn(),
  mockKnown: vi.fn().mockResolvedValue(["chain_rule"]),
  mockResolve: vi.fn(),
}));

vi.mock("./gemini", () => ({ classifyConcept: mockClassify }));
vi.mock("./misconception", () => ({ recordInteraction: mockRecord }));
vi.mock("./firestore", () => ({ saveInteraction: mockSave }));
vi.mock("./cache", () => ({ cacheInvalidate: mockInvalidate }));
vi.mock("./concepts", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, listKnownConcepts: mockKnown, resolveConceptNode: mockResolve };
});
vi.mock("../db/firebase", () => ({ db: {} }));

import { recordQuestionInteraction, sourcesFrom, formatContext } from "./interactions";

const chunk = (content: string, filename?: string, courseId = "c1") => ({ content, courseId, distance: 0.1, filename });

describe("sourcesFrom / formatContext", () => {
  it("lists distinct files in rank order and skips unnamed chunks", () => {
    expect(sourcesFrom([chunk("a", "w1.pdf"), chunk("b"), chunk("c", "w2.pdf"), chunk("d", "w1.pdf"), chunk("e", "w1.pdf", "c2")])).toEqual([
      { filename: "w1.pdf", courseId: "c1" },
      { filename: "w2.pdf", courseId: "c1" },
      { filename: "w1.pdf", courseId: "c2" },
    ]);
  });

  it("numbers chunks and labels their files", () => {
    expect(formatContext([chunk("alpha", "w1.pdf"), chunk("beta")])).toBe("[1] (from w1.pdf)\nalpha\n\n---\n\n[2]\nbeta");
    expect(formatContext([])).toBe("");
  });
});

describe("recordQuestionInteraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKnown.mockResolvedValue(["chain_rule"]);
    mockSave.mockResolvedValue("evt-1");
  });

  it("classifies with known concepts, resolves the node, and records exposure without correctness", async () => {
    mockClassify.mockResolvedValue({ conceptNode: "Derivatives Chain Rule", errorType: "procedural_error", confidence: 0.7 });
    mockResolve.mockResolvedValue({ conceptNode: "chain_rule", matchedExisting: true, distance: 0.06, labelEmbedding: null });

    const out = await recordQuestionInteraction("u1", {
      question: "q", solution: "s", mainConcept: "Chain rule", courseId: "c1", response: { solution: "s" }, requestMeta: { ip: "x" },
    });

    expect(mockClassify).toHaveBeenCalledWith("q", "s", ["chain_rule"]);
    expect(mockResolve).toHaveBeenCalledWith("u1", "derivatives_chain_rule");
    expect(out).toEqual({ classifierTag: { conceptNode: "chain_rule", errorType: "procedural_error", confidence: 0.7 }, eventId: "evt-1" });
    expect(mockSave).toHaveBeenCalledWith("u1", expect.objectContaining({ courseId: "c1", eventType: "explain", requestMeta: { ip: "x" } }));
    const [, node, params] = mockRecord.mock.calls[0];
    expect(node).toBe("chain_rule");
    expect(params).toEqual({ errorType: "procedural_error", confidence: 0.7, courseId: "c1", labelEmbedding: null });
    expect(mockInvalidate).toHaveBeenCalledWith("graph:u1");
    expect(mockInvalidate).toHaveBeenCalledWith("drill:u1");
  });

  it("falls back to the explanation's main concept and stores null courseId", async () => {
    mockClassify.mockResolvedValue({});
    mockResolve.mockImplementation(async (_u: string, id: string) => ({ conceptNode: id, matchedExisting: false, distance: null, labelEmbedding: [1] }));

    const out = await recordQuestionInteraction("u1", { question: "q", solution: "s", mainConcept: "Taylor Series", response: {} });

    expect(out.classifierTag.conceptNode).toBe("taylor_series");
    expect(mockSave.mock.calls[0][1].courseId).toBeNull();
    expect(mockSave.mock.calls[0][1]).not.toHaveProperty("requestMeta");
    expect(mockRecord.mock.calls[0][2].labelEmbedding).toEqual([1]);
  });

  it("propagates classifier failures to the caller", async () => {
    mockClassify.mockRejectedValue(new Error("down"));
    await expect(recordQuestionInteraction("u1", { question: "q", solution: "s", response: {} })).rejects.toThrow("down");
    expect(mockSave).not.toHaveBeenCalled();
  });
});
