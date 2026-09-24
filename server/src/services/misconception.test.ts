import { describe, it, expect, vi, beforeEach } from "vitest";
import { getWeakestConcepts, getGraph, getDrillQueue, initializeConcepts, getStudentProfile } from "./misconception";
import { resolveConceptNodes } from "./concepts";
import { applyEvidence, newCard } from "./scheduler";

const { mockDb, mockFieldValue, mockBatch } = vi.hoisted(() => {
  const mockBatch = { set: vi.fn(), commit: vi.fn().mockResolvedValue(undefined) };
  const mock = {
    collection: vi.fn(),
    doc: vi.fn(),
    where: vi.fn(),
    select: vi.fn(),
    get: vi.fn(),
    set: vi.fn().mockReturnValue({ catch: vi.fn() }),
    update: vi.fn().mockResolvedValue(true),
    orderBy: vi.fn(),
    limit: vi.fn(),
    runTransaction: vi.fn().mockReturnValue({ catch: vi.fn() }),
    batch: vi.fn(() => mockBatch),
  };

  mock.collection.mockReturnValue(mock);
  mock.doc.mockReturnValue(mock);
  mock.where.mockReturnValue(mock);
  mock.select.mockReturnValue(mock);
  mock.orderBy.mockReturnValue(mock);
  mock.limit.mockReturnValue(mock);

  return {
    mockDb: mock,
    mockBatch,
    mockFieldValue: {
      serverTimestamp: vi.fn(() => "mock-ts"),
      increment: vi.fn((n) => ({ type: "increment", value: n })),
    },
  };
});

// ── Embeddings + concept resolution (network/vector-index backed) ─────────
vi.mock("./embeddings", () => ({
  embedLabels: vi.fn(async (labels: string[]) => labels.map(() => [0.5, 0.5])),
  currentEmbeddingModel: () => "gemini-embedding-2",
}));
vi.mock("./concepts", () => ({
  labelEmbeddingFields: (v: number[] | null) => (v ? { labelEmbedding: v, labelEmbeddingModel: "gemini-embedding-2" } : {}),
  resolveConceptNodes: vi.fn(async (_uid: string, labels: string[]) =>
    labels.map((l) => ({ conceptNode: l, matchedExisting: false, distance: null, labelEmbedding: [0.1] }))),
}));

vi.mock("../db/firebase", () => ({ db: mockDb }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: mockFieldValue }));

describe("misconception service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection.mockReturnValue(mockDb);
    mockDb.doc.mockReturnValue(mockDb);
    mockDb.where.mockReturnValue(mockDb);
    mockDb.orderBy.mockReturnValue(mockDb);
    mockDb.limit.mockReturnValue(mockDb);
    mockDb.set.mockReturnValue({ catch: vi.fn() });
    mockDb.runTransaction.mockReturnValue({ catch: vi.fn() });
  });

  describe("getWeakestConcepts", () => {
    it("returns concepts and handles empty snap", async () => {
      mockDb.get.mockResolvedValueOnce({ empty: true });
      mockDb.get.mockResolvedValueOnce({ docs: [] });
      const res = await getWeakestConcepts("u1");
      expect(res).toEqual([]);
    });
  });

  describe("getGraph", () => {
    it("returns projected nodes and never reads label embeddings", async () => {
      mockDb.get.mockResolvedValue({ docs: [{ id: "n1", data: () => ({ accuracyRate: 0.5 }) }] });
      const res = await getGraph("u1");
      expect(res[0]).toMatchObject({ conceptNode: "n1", accuracyRate: 0.5, dominantErrorType: null });
      expect(mockDb.select.mock.calls[0]).not.toContain("labelEmbedding");
    });
  });

  describe("getDrillQueue", () => {
    it("sorts by urgency and handles toDate", async () => {
      const now = new Date();
      mockDb.get.mockResolvedValue({
        docs: [
          { id: "node1", data: () => ({ nextReviewDate: { toDate: () => new Date(now.getTime() - 100000) }, accuracyRate: 0.5 }) },
          { id: "node2", data: () => ({ nextReviewDate: new Date(now.getTime() - 1000), accuracyRate: 0.9 }) },
        ],
      });

      const result = await getDrillQueue("uid1");
      expect(result.length).toBe(2);
      expect(result[0].conceptNode).toBe("node1");
    });

    it("puts forgotten studied concepts ahead of never-studied ones and flags what is due", async () => {
      const longAgo = new Date(Date.now() - 60 * 86_400_000);
      const studied = applyEvidence(null, { isCorrect: true }, longAgo).card;
      mockDb.get.mockResolvedValue({
        docs: [
          { id: "from_ingestion", data: () => ({ fsrs: newCard(new Date()), nextReviewDate: new Date(), isInitializedOnly: true }) },
          { id: "forgotten", data: () => ({ fsrs: studied, nextReviewDate: studied.due, accuracyRate: 1, interactionCount: 1 }) },
        ],
      });

      const result = await getDrillQueue("uid1");
      expect(result.map((r: any) => r.conceptNode)).toEqual(["forgotten", "from_ingestion"]);
      expect(result[0]).toMatchObject({ due: true });
      expect(result[0].retrievability).toBeLessThan(0.9);
      expect(result[1]).toMatchObject({ due: false });
      expect(result[1]).not.toHaveProperty("retrievability");
    });

    it("defaults nextReviewDate to now when the stored node has none at all", async () => {
      const before = Date.now();
      mockDb.get.mockResolvedValue({
        docs: [{ id: "no_date", data: () => ({ fsrs: newCard(new Date()), isInitializedOnly: true }) }],
      });

      const result = await getDrillQueue("uid1");
      expect(result[0].nextReviewDate.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe("initializeConcepts", () => {
    it("does nothing for an empty concept list", async () => {
      await initializeConcepts("u1", [], "c1");
      expect(mockDb.batch).not.toHaveBeenCalled();
      expect(mockBatch.commit).not.toHaveBeenCalled();
    });

    it("skips concepts that resolved onto an existing node", async () => {
      vi.mocked(resolveConceptNodes).mockResolvedValueOnce([
        { conceptNode: "chain_rule", matchedExisting: true, distance: 0, labelEmbedding: null },
      ]);

      await initializeConcepts("u1", ["Chain Rule"], "c1");

      expect(mockBatch.set).not.toHaveBeenCalled();
      expect(mockBatch.commit).not.toHaveBeenCalled();
    });

    it("batches new, deduplicated concepts and commits once", async () => {
      vi.mocked(resolveConceptNodes).mockResolvedValueOnce([
        { conceptNode: "limits", matchedExisting: false, distance: null, labelEmbedding: [0.1] },
        { conceptNode: "limits", matchedExisting: false, distance: null, labelEmbedding: [0.1] }, // duplicate label
        { conceptNode: "series", matchedExisting: true, distance: 0, labelEmbedding: null }, // already exists
      ]);

      await initializeConcepts("u1", ["limits", "Limits", "series"], "c1");

      expect(mockBatch.set).toHaveBeenCalledTimes(1);
      const [, payload] = mockBatch.set.mock.calls[0];
      expect(payload).toMatchObject({ courseId: "c1", accuracyRate: 1.0, isInitializedOnly: true });
      expect(mockBatch.commit).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStudentProfile", () => {
    it("returns null when the student has no weak concepts yet", async () => {
      mockDb.get.mockResolvedValueOnce({ empty: true }); // due-for-review query
      mockDb.get.mockResolvedValueOnce({ docs: [] }); // fallback query, also empty

      expect(await getStudentProfile("u1")).toBeNull();
    });

    it("aggregates error-type counts across the student's weakest concepts", async () => {
      mockDb.get.mockResolvedValueOnce({
        empty: false,
        docs: [
          { id: "chain_rule", data: () => ({ errorTypeMap: { procedural_error: 2 } }) },
          { id: "limits", data: () => ({ errorTypeMap: { procedural_error: 1, knowledge_gap: 1 } }) },
        ],
      });

      const profile = await getStudentProfile("u1");

      expect(profile).toEqual({
        weakConcepts: ["chain_rule", "limits"],
        errorTypeMap: { procedural_error: 3, knowledge_gap: 1 },
      });
    });

    it("tolerates a weakest concept with no errorTypeMap field at all", async () => {
      mockDb.get.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: "fresh_from_ingestion", data: () => ({}) }],
      });

      const profile = await getStudentProfile("u1");

      expect(profile).toEqual({ weakConcepts: ["fresh_from_ingestion"], errorTypeMap: {} });
    });
  });
});
