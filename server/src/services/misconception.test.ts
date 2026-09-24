import { describe, it, expect, vi, beforeEach } from "vitest";
import { getWeakestConcepts, getGraph, getDrillQueue } from "./misconception";

const { mockDb, mockFieldValue } = vi.hoisted(() => {
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
  };

  mock.collection.mockReturnValue(mock);
  mock.doc.mockReturnValue(mock);
  mock.where.mockReturnValue(mock);
  mock.select.mockReturnValue(mock);
  mock.orderBy.mockReturnValue(mock);
  mock.limit.mockReturnValue(mock);

  return {
    mockDb: mock,
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
  });
});
