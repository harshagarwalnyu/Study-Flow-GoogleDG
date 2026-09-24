import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateJson, mockStreamText } = vi.hoisted(() => ({
  mockGenerateJson: vi.fn(),
  mockStreamText: vi.fn(),
}));
vi.mock("../ai/index", () => ({
  getAiProvider: () => ({ generateJson: mockGenerateJson, streamText: mockStreamText }),
}));

import {
  identifyConcept,
  explainConcept,
  classifyConcept,
  generateQuiz,
  explainConceptStream,
  discoverConcepts,
} from "./gemini";

const promptOf = (mock: any) => mock.mock.calls.at(-1)[0].prompt as string;

describe("gemini prompts", () => {
  beforeEach(() => {
    mockGenerateJson.mockReset().mockResolvedValue({ ok: true });
    mockStreamText.mockReset().mockResolvedValue("stream");
  });

  it("identifyConcept uses the fast model deterministically", async () => {
    await identifyConcept("what is a derivative");
    expect(mockGenerateJson).toHaveBeenCalledWith(expect.objectContaining({ model: "fast", temperature: 0 }));
    expect(promptOf(mockGenerateJson)).toContain("what is a derivative");
  });

  describe("explainConcept", () => {
    it("includes context, and omits the history section with no profile", async () => {
      await explainConcept("q?", "CTX");
      const p = promptOf(mockGenerateJson);
      expect(p).toContain("CTX");
      expect(p).not.toContain("--- STUDENT HISTORY");
      expect(mockGenerateJson.mock.calls[0][0].model).toBe("primary");
    });

    it("falls back to general knowledge when there is no context", async () => {
      await explainConcept("q?", "");
      expect(promptOf(mockGenerateJson)).toContain("No course materials available");
    });

    it("personalizes with the student's weak concepts and top misconceptions", async () => {
      await explainConcept("q?", "", {
        weakConcepts: ["chain_rule", "limits"],
        errorTypeMap: { procedural_error: 5, knowledge_gap: 1, reasoning_error: 3, conceptual_misunderstanding: 2 },
      });
      const p = promptOf(mockGenerateJson);
      expect(p).toContain("Currently Weak Concepts: chain rule, limits");
      expect(p).toContain("Primary Misconceptions: procedural_error, reasoning_error, conceptual_misunderstanding");
      expect(p).not.toMatch(/Primary Misconceptions:.*knowledge_gap/);
    });

    it("omits an empty profile rather than printing an empty header", async () => {
      await explainConcept("q?", "", { weakConcepts: [], errorTypeMap: {} });
      expect(promptOf(mockGenerateJson)).not.toContain("--- STUDENT HISTORY");
    });

    it("includes recent interactions when present", async () => {
      await explainConcept("q?", "", { recentInteractions: [{ q: "old q", a: "old a" }] });
      expect(promptOf(mockGenerateJson)).toContain("- Q: old q");
    });

    it("truncates oversized context", async () => {
      await explainConcept("q?", "x".repeat(9000));
      expect(promptOf(mockGenerateJson)).not.toContain("x".repeat(5001));
    });
  });

  describe("classifyConcept", () => {
    it("offers the student's existing concept ids for reuse", async () => {
      await classifyConcept("q", "sol", ["chain_rule", "limits"]);
      const p = promptOf(mockGenerateJson);
      expect(p).toContain("return it EXACTLY");
      expect(p).toContain("chain_rule, limits");
    });

    it("omits the known-concepts block for new students and caps its size", async () => {
      await classifyConcept("q", "sol");
      expect(promptOf(mockGenerateJson)).not.toContain("already has these concept ids");

      await classifyConcept("q", "sol", Array.from({ length: 60 }, (_, i) => `c${i}`));
      const p = promptOf(mockGenerateJson);
      expect(p).toContain("c39");
      expect(p).not.toContain("c40");
    });

    it("tolerates missing inputs", async () => {
      await classifyConcept(undefined as any, null as any);
      expect(mockGenerateJson).toHaveBeenCalledWith(expect.objectContaining({ model: "fast" }));
    });
  });

  describe("generateQuiz", () => {
    it("targets the topic with weak-concept hints and joined chunks", async () => {
      await generateQuiz("chain_rule", ["c1", "c2"], { conceptNode: "chain_rule", errorTypeMap: { procedural_error: 2 } }, 4);
      const p = promptOf(mockGenerateJson);
      expect(p).toContain('Generate 4 multiple-choice questions for the topic "chain_rule"');
      expect(p).toContain("c1\n\n---\n\nc2");
      expect(p).toContain("Common error types: procedural_error");
    });

    it("hints with an empty concept name when smgData has no conceptNode", async () => {
      await generateQuiz("chain_rule", [], { errorTypeMap: { procedural_error: 1 } });
      const p = promptOf(mockGenerateJson);
      expect(p).toContain("Student weak concept hint: . Common error types: procedural_error");
    });

    it("hints with no error types when smgData has no errorTypeMap", async () => {
      await generateQuiz("chain_rule", [], { conceptNode: "chain_rule" });
      const p = promptOf(mockGenerateJson);
      expect(p).toContain("Student weak concept hint: chain_rule. Common error types: ");
    });

    it("defaults sensibly", async () => {
      await generateQuiz("");
      const p = promptOf(mockGenerateJson);
      expect(p).toContain('topic "general"');
      expect(p).toContain("No course material provided.");
      expect(p).toContain("Generate 3");
    });
  });

  it("explainConceptStream streams with optional personalization", async () => {
    expect(await explainConceptStream("q", "ctx", { weakConcepts: ["limits"] })).toBe("stream");
    expect(promptOf(mockStreamText)).toContain("Currently Weak Concepts: limits");
    await explainConceptStream("q");
    expect(promptOf(mockStreamText)).not.toContain("--- STUDENT HISTORY");
  });

  describe("discoverConcepts", () => {
    it("returns discovered concepts", async () => {
      mockGenerateJson.mockResolvedValue({ concepts: ["limits"] });
      expect(await discoverConcepts("text")).toEqual({ concepts: ["limits"] });
    });

    it("returns an empty list on malformed output or failure", async () => {
      mockGenerateJson.mockResolvedValue({});
      expect(await discoverConcepts("text")).toEqual({ concepts: [] });
      mockGenerateJson.mockRejectedValue(new Error("down"));
      expect(await discoverConcepts("text")).toEqual({ concepts: [] });
    });
  });
});
