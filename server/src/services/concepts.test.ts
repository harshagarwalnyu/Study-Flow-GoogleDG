import { describe, it, expect, vi, beforeEach } from "vitest";

const { existingIds, nearest, findNearestCalls, mockEmbedLabels } = vi.hoisted(() => ({
  existingIds: new Set<string>(),
  // docs findNearest returns: { id, model, distance }
  nearest: [] as Array<{ id: string; model: string; distance: number }>,
  findNearestCalls: [] as any[],
  mockEmbedLabels: vi.fn(),
}));

vi.mock("../db/firebase", () => {
  const smg = {
    doc: (id: string) => ({ get: async () => ({ exists: existingIds.has(id) }) }),
    findNearest: (opts: any) => {
      findNearestCalls.push(opts);
      return {
        get: async () => ({
          docs: nearest
            .filter((n) => n.distance <= opts.distanceThreshold)
            .map((n) => ({
              id: n.id,
              get: (f: string) => (f === "labelEmbeddingModel" ? n.model : f === "_distance" ? n.distance : undefined),
            })),
        }),
      };
    },
    orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => ({ docs: [...existingIds].map((id) => ({ id })) }) }) }) }),
  };
  return { db: { collection: () => ({ doc: () => ({ collection: () => smg }) }) } };
});
vi.mock("firebase-admin/firestore", () => ({ FieldValue: { vector: (v: number[]) => ({ vector: v }) } }));
vi.mock("../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("./embeddings", () => ({
  embedLabels: mockEmbedLabels,
  currentEmbeddingModel: () => "gemini-embedding-2",
}));

import {
  toSnakeCase,
  normalizeClassifierTag,
  resolveConceptNode,
  resolveConceptNodes,
  labelEmbeddingFields,
  listKnownConcepts,
} from "./concepts";

describe("concepts", () => {
  beforeEach(() => {
    existingIds.clear();
    nearest.length = 0;
    findNearestCalls.length = 0;
    mockEmbedLabels.mockReset();
    mockEmbedLabels.mockImplementation(async (labels: string[]) => labels.map((_, i) => [i + 1]));
  });

  describe("toSnakeCase / normalizeClassifierTag", () => {
    it("snake-cases and bounds length", () => {
      expect(toSnakeCase("  Chain Rule (Derivatives)! ")).toBe("chain_rule_derivatives");
      expect(toSnakeCase(null)).toBe("");
      expect(toSnakeCase("a".repeat(500))).toHaveLength(120);
    });

    it("normalizes malformed classifier output", () => {
      expect(normalizeClassifierTag({ conceptNode: "Limits", errorType: "bogus", confidence: 7 }, "x")).toEqual({
        conceptNode: "limits", errorType: "knowledge_gap", confidence: 1,
      });
      expect(normalizeClassifierTag(null, "Main Concept")).toEqual({
        conceptNode: "main_concept", errorType: "knowledge_gap", confidence: 0.5,
      });
      expect(normalizeClassifierTag(undefined, "").conceptNode).toBe("general_concept");
    });
  });

  describe("resolveConceptNode", () => {
    it("reuses an exact existing id without embedding", async () => {
      existingIds.add("chain_rule");
      expect(await resolveConceptNode("u1", "Chain Rule")).toEqual({
        conceptNode: "chain_rule", matchedExisting: true, distance: 0, labelEmbedding: null,
      });
      expect(mockEmbedLabels).not.toHaveBeenCalled();
    });

    it("merges a near-duplicate label into the existing node", async () => {
      nearest.push({ id: "chain_rule", model: "gemini-embedding-2", distance: 0.08 });
      const res = await resolveConceptNode("u1", "derivatives_chain_rule");
      expect(res).toMatchObject({ conceptNode: "chain_rule", matchedExisting: true, distance: 0.08, labelEmbedding: null });
      expect(findNearestCalls[0]).toMatchObject({ vectorField: "labelEmbedding", distanceMeasure: "COSINE", distanceThreshold: 0.15 });
    });

    it("creates a new node (with its vector) when nothing is close enough", async () => {
      nearest.push({ id: "integration_by_parts", model: "gemini-embedding-2", distance: 0.4 });
      expect(await resolveConceptNode("u1", "chain_rule")).toEqual({
        conceptNode: "chain_rule", matchedExisting: false, distance: null, labelEmbedding: [1],
      });
    });

    it("ignores matches whose label vector came from another model", async () => {
      nearest.push({ id: "chain_rule", model: "text-embedding-004", distance: 0.01 });
      expect((await resolveConceptNode("u1", "chain_rule_2")).matchedExisting).toBe(false);
    });
  });

  describe("resolveConceptNodes", () => {
    it("embeds each unresolved label once and resolves duplicates consistently", async () => {
      existingIds.add("limits");
      const res = await resolveConceptNodes("u1", ["limits", "series", "Series", "limits"]);
      expect(res.map((r) => r.conceptNode)).toEqual(["limits", "series", "series", "limits"]);
      expect(mockEmbedLabels).toHaveBeenCalledTimes(1);
      expect(mockEmbedLabels).toHaveBeenCalledWith(["series"]);
      expect(res[1]).toBe(res[2]);
      expect(findNearestCalls).toHaveLength(1);
    });

    it("falls back to general_concept for empty labels", async () => {
      const [res] = await resolveConceptNodes("u1", [""]);
      expect(res.conceptNode).toBe("general_concept");
    });
  });

  it("builds label-vector fields only when a vector is present", () => {
    expect(labelEmbeddingFields(null)).toEqual({});
    expect(labelEmbeddingFields([1, 2])).toEqual({ labelEmbedding: { vector: [1, 2] }, labelEmbeddingModel: "gemini-embedding-2" });
  });

  it("lists known concept ids", async () => {
    existingIds.add("a").add("b");
    expect(await listKnownConcepts("u1")).toEqual(["a", "b"]);
  });
});
