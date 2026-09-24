import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, courseChunks, findNearestCalls, mockLogger } = vi.hoisted(() => {
  // courseId -> docs findNearest returns for that course
  const courseChunks: Record<string, any[]> = {};
  const findNearestCalls: Array<{ courseId: string; options: any }> = [];

  const courseRef = (courseId: string) => ({
    collection: (name: string) => {
      if (name !== "chunks") throw new Error(`unexpected collection ${name}`);
      return {
        findNearest: (options: any) => {
          findNearestCalls.push({ courseId, options });
          return { get: async () => ({ docs: (courseChunks[courseId] || []).map((d) => ({ data: () => d })) }) };
        },
      };
    },
  });

  const mockDb = {
    collection: vi.fn(() => ({
      doc: vi.fn(() => ({
        collection: vi.fn(() => ({
          doc: (courseId: string) => courseRef(courseId),
          select: () => ({
            get: async () => ({ docs: Object.keys(courseChunks).map((id) => ({ id })) }),
          }),
        })),
      })),
    })),
  };
  return {
    mockDb,
    courseChunks,
    findNearestCalls,
    mockLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
});

vi.mock("../db/firebase", () => ({ db: mockDb }));
vi.mock("../logger", () => ({ logger: mockLogger }));
vi.mock("./embeddings", () => ({
  embedQuery: vi.fn(async () => [0.1, 0.2, 0.3]),
  currentEmbeddingModel: () => "gemini-embedding-2",
}));

import { retrieveChunks, retrieveChunkRecords } from "./rag";

const chunk = (content: string, distance: number, extra: Record<string, unknown> = {}) => ({
  content,
  _distance: distance,
  embeddingModel: "gemini-embedding-2",
  metadata: { filename: `${content}.pdf` },
  chunkIndex: 0,
  ...extra,
});

describe("rag", () => {
  beforeEach(() => {
    for (const k of Object.keys(courseChunks)) delete courseChunks[k];
    findNearestCalls.length = 0;
    mockLogger.warn.mockClear();
  });

  it("queries one course with the options-form findNearest and a distance threshold", async () => {
    courseChunks.calc = [chunk("a", 0.1), chunk("b", 0.2)];

    const result = await retrieveChunks("u1", "calc", "what is a limit");

    expect(result).toEqual(["a", "b"]);
    expect(findNearestCalls).toHaveLength(1);
    expect(findNearestCalls[0].options).toMatchObject({
      vectorField: "embedding",
      queryVector: [0.1, 0.2, 0.3],
      distanceMeasure: "COSINE",
      distanceResultField: "_distance",
      distanceThreshold: expect.any(Number),
    });
  });

  it("returns source metadata for citations", async () => {
    courseChunks.calc = [chunk("a", 0.15, { chunkIndex: 3 })];
    const [record] = await retrieveChunkRecords("u1", "calc", "q");
    expect(record).toEqual({ content: "a", courseId: "calc", distance: 0.15, filename: "a.pdf", chunkIndex: 3 });
  });

  it("reports distance 0 when the store returns no numeric distance", async () => {
    courseChunks.calc = [chunk("a", 0.15, { _distance: undefined })];
    const [record] = await retrieveChunkRecords("u1", "calc", "q");
    expect(record.distance).toBe(0);
  });

  it("drops chunks embedded by a different model and warns once", async () => {
    courseChunks.calc = [
      chunk("legacy", 0.01, { embeddingModel: "text-embedding-004" }),
      chunk("untagged", 0.02, { embeddingModel: undefined }),
      chunk("fresh", 0.3),
    ];

    expect(await retrieveChunks("u1", "calc", "q")).toEqual(["fresh"]);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatchObject({ staleModelHits: 2 });
  });

  it("searches every course with indexed queries and merges by distance", async () => {
    courseChunks.calc = [chunk("c1", 0.4), chunk("c2", 0.05)];
    courseChunks.linalg = [chunk("l1", 0.2), chunk("l2", 0.5)];
    courseChunks.physics = [chunk("p1", 0.1), chunk("p2", 0.3), chunk("p3", 0.35)];

    const result = await retrieveChunks("u1", undefined, "q");

    expect(findNearestCalls.map((c) => c.courseId).sort()).toEqual(["calc", "linalg", "physics"]);
    expect(result).toEqual(["c2", "p1", "l1", "p2", "p3"]);
  });

  it("returns nothing when the student has no courses", async () => {
    expect(await retrieveChunks("u1", undefined, "q")).toEqual([]);
    expect(findNearestCalls).toHaveLength(0);
  });

  it("skips empty-content chunks", async () => {
    courseChunks.calc = [chunk("", 0.1), chunk("ok", 0.2)];
    expect(await retrieveChunks("u1", "calc", "q")).toEqual(["ok"]);
  });
});
