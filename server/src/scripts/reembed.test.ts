import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase-admin/firestore", () => ({
  FieldPath: { documentId: () => "__name__" },
  FieldValue: { vector: (v: number[]) => ({ vector: v }), serverTimestamp: () => "ts" },
}));

const { mockEmbedDocuments } = vi.hoisted(() => ({ mockEmbedDocuments: vi.fn() }));
vi.mock("../services/embeddings", () => ({
  embedDocuments: mockEmbedDocuments,
  currentEmbeddingModel: () => "gemini-embedding-2",
  EMBEDDING_DIM: 768,
}));

import { reembedStaleChunks, _parseArgsForTests as parseArgs } from "./reembed";

type Row = { id: string; data: Record<string, any> };

/** Minimal Firestore double: ordered paging with startAfter + batched updates applied in place. */
function fakeDb(rowsBySource: Record<string, Row[]>, courseIds: string[] = []) {
  const updates: Array<{ id: string; patch: any }> = [];
  const snap = (row: Row) => ({
    id: row.id,
    ref: row,
    get: (path: string) => path.split(".").reduce((o: any, k) => o?.[k], row.data),
  });
  const query = (rows: Row[], after?: string, limit = Infinity): any => ({
    orderBy: () => query(rows, after, limit),
    limit: (n: number) => query(rows, after, n),
    startAfter: (cursor: any) => query(rows, cursor.id, limit),
    get: async () => {
      const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id)).filter((r) => after === undefined || r.id > after);
      const docs = sorted.slice(0, limit).map(snap);
      return { empty: docs.length === 0, size: docs.length, docs };
    },
    firestore: db,
  });
  const db: any = {
    collectionGroup: () => query(rowsBySource.all || []),
    collection: () => ({
      doc: () => ({
        collection: () => ({
          select: () => ({
            get: async () => ({
              docs: courseIds.map((id) => ({ ref: { collection: () => query(rowsBySource[id] || []) } })),
            }),
          }),
        }),
      }),
    }),
    batch: () => {
      const pending: Array<{ row: Row; patch: any }> = [];
      return {
        update: (row: Row, patch: any) => pending.push({ row, patch }),
        commit: async () => {
          for (const { row, patch } of pending) {
            Object.assign(row.data, patch);
            updates.push({ id: row.id, patch });
          }
        },
      };
    },
  };
  return { db, updates };
}

const row = (id: string, data: Record<string, any>): Row => ({ id, data: { content: `text ${id}`, ...data } });

describe("reembedStaleChunks", () => {
  beforeEach(() => {
    mockEmbedDocuments.mockReset();
    mockEmbedDocuments.mockImplementation(async (texts: string[]) => texts.map((_, i) => [i]));
  });

  it("re-embeds only chunks from other or unrecorded models, grouped by title", async () => {
    const rows = [
      row("a", { embeddingModel: "text-embedding-004", metadata: { filename: "w1.pdf" } }),
      row("b", { metadata: { filename: "w1.pdf" } }),
      row("c", { embeddingModel: "gemini-embedding-2" }),
      row("d", { embeddingModel: "text-embedding-004" }),
    ];
    const { db, updates } = fakeDb({ all: rows });

    const res = await reembedStaleChunks(db);

    expect(res).toEqual({ scanned: 4, stale: 3, updated: 3 });
    expect(updates.map((u) => u.id).sort()).toEqual(["a", "b", "d"]);
    expect(updates[0].patch).toMatchObject({ embeddingModel: "gemini-embedding-2", embeddingDim: 768 });
    expect(mockEmbedDocuments).toHaveBeenCalledWith(["text a", "text b"], "w1.pdf");
    expect(mockEmbedDocuments).toHaveBeenCalledWith(["text d"], undefined);
  });

  it("is a no-op on a second run (resumable)", async () => {
    const { db } = fakeDb({ all: [row("a", {}), row("b", {})] });
    await reembedStaleChunks(db);
    mockEmbedDocuments.mockClear();

    expect(await reembedStaleChunks(db)).toEqual({ scanned: 2, stale: 0, updated: 0 });
    expect(mockEmbedDocuments).not.toHaveBeenCalled();
  });

  it("counts without writing in dry-run mode", async () => {
    const { db, updates } = fakeDb({ all: [row("a", {})] });
    expect(await reembedStaleChunks(db, { dryRun: true })).toEqual({ scanned: 1, stale: 1, updated: 0 });
    expect(updates).toHaveLength(0);
    expect(mockEmbedDocuments).not.toHaveBeenCalled();
  });

  it("pages through large collections", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => row(String(i).padStart(4, "0"), {}));
    const { db } = fakeDb({ all: rows });
    expect(await reembedStaleChunks(db)).toEqual({ scanned: 450, stale: 450, updated: 450 });
  });

  it("scopes to one student's courses with --uid", async () => {
    const { db, updates } = fakeDb({ calc: [row("x", {})], bio: [row("y", {})], all: [row("z", {})] }, ["calc", "bio"]);
    const res = await reembedStaleChunks(db, { uid: "u1" });
    expect(res.updated).toBe(2);
    expect(updates.map((u) => u.id).sort()).toEqual(["x", "y"]);
  });
});

describe("parseArgs", () => {
  it("parses flags", () => {
    expect(parseArgs(["--dry-run", "--uid", "abc"])).toEqual({ dryRun: true, uid: "abc" });
    expect(parseArgs([])).toEqual({ dryRun: false });
    expect(() => parseArgs(["--uid"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--uid", "--dry-run"])).toThrow(/requires a value/);
  });
});
