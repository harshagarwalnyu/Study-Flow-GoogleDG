import { describe, it, expect } from "vitest";
import { dominantErrorType, toGraphNode, GRAPH_FIELDS } from "./graphView";
import { applyEvidence } from "./scheduler";

describe("dominantErrorType", () => {
  it("picks the most frequent real error type", () => {
    expect(dominantErrorType({ procedural_error: 1, knowledge_gap: 3, reasoning_error: 2 })).toBe("knowledge_gap");
  });

  it("ignores 'none', zero and non-numeric counts, and returns null when nothing is left", () => {
    expect(dominantErrorType({ none: 9, procedural_error: 1 })).toBe("procedural_error");
    expect(dominantErrorType({ none: 5 })).toBeNull();
    expect(dominantErrorType({ knowledge_gap: 0, reasoning_error: "x" as any })).toBeNull();
    expect(dominantErrorType(undefined)).toBeNull();
  });

  it("breaks ties in favour of the type recorded first", () => {
    expect(dominantErrorType({ reasoning_error: 2, procedural_error: 2 })).toBe("reasoning_error");
  });
});

describe("toGraphNode", () => {
  it("projects only client fields and derives error type and recall", () => {
    const now = new Date("2026-09-24T12:00:00Z");
    const { card } = applyEvidence(null, { isCorrect: true }, new Date("2026-09-20T12:00:00Z"));
    const node = toGraphNode("chain_rule", {
      accuracyRate: 0.75, interactionCount: 4, courseId: "c1", nextReviewDate: "d",
      errorTypeMap: { procedural_error: 2 }, fsrs: card, labelEmbedding: [0.1, 0.2], easeFactor: 2.5,
    }, now);

    expect(node).toMatchObject({
      conceptNode: "chain_rule", accuracyRate: 0.75, interactionCount: 4, courseId: "c1",
      nextReviewDate: "d", errorTypeMap: { procedural_error: 2 }, dominantErrorType: "procedural_error",
    });
    expect(node.retrievability).toBeGreaterThan(0);
    expect(node.retrievability).toBeLessThan(1);
    expect(node).not.toHaveProperty("labelEmbedding");
    expect(node).not.toHaveProperty("easeFactor");
  });

  it("fills defaults for sparse nodes and omits absent optional fields", () => {
    expect(toGraphNode("x", {})).toEqual({ conceptNode: "x", accuracyRate: 0, interactionCount: 0, errorTypeMap: {}, dominantErrorType: null });
  });

  it("never asks Firestore for the embedding", () => {
    expect(GRAPH_FIELDS).not.toContain("labelEmbedding" as any);
  });
});
