import { describe, it, expect, vi, beforeEach } from "vitest";
import { chunkText, ingestText, ingestFile, sourceKeyFor, recordIngestedFile } from "./ingestion";

const { mockDb, mockBatch, mockFieldValue } = vi.hoisted(() => {
  const mock = {
    collection: vi.fn(),
    doc: vi.fn(),
    where: vi.fn(),
    get: vi.fn(),
    add: vi.fn(),
    set: vi.fn(),
    count: vi.fn(),
    batch: vi.fn(),
  };

  mock.collection.mockReturnValue(mock);
  mock.doc.mockReturnValue(mock);
  mock.where.mockReturnValue(mock);
  mock.count.mockReturnValue(mock);

  const mockBatch = {
    set: vi.fn(),
    delete: vi.fn(),
    commit: vi.fn().mockResolvedValue(true),
  };
  mock.batch.mockReturnValue(mockBatch);

  return {
    mockDb: mock,
    mockBatch,
    mockFieldValue: {
      serverTimestamp: vi.fn(() => "mock-ts"),
      vector: vi.fn((v) => v),
    },
  };
});

vi.mock("../db/firebase.ts", () => ({ db: mockDb }));
vi.mock("firebase-admin/firestore", () => ({ FieldValue: mockFieldValue }));

const { mockEmbedDocuments } = vi.hoisted(() => ({ mockEmbedDocuments: vi.fn() }));
vi.mock("./embeddings.ts", () => ({
  embedDocuments: mockEmbedDocuments,
  currentEmbeddingModel: () => "gemini-embedding-2",
  EMBEDDING_DIM: 768,
}));

const { mockExtractText, mockExtractTextFromPDF } = vi.hoisted(() => ({
  mockExtractText: vi.fn(),
  mockExtractTextFromPDF: vi.fn(),
}));
vi.mock("./ocr.ts", () => ({
  extractText: mockExtractText,
  extractTextFromPDF: mockExtractTextFromPDF,
}));

const { mockDiscoverConcepts, mockInitializeConcepts } = vi.hoisted(() => ({
  mockDiscoverConcepts: vi.fn(),
  mockInitializeConcepts: vi.fn(),
}));
vi.mock("./gemini.ts", () => ({ discoverConcepts: mockDiscoverConcepts }));
vi.mock("./misconception.ts", () => ({ initializeConcepts: mockInitializeConcepts }));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue("mock file content"),
}));

const vectorsFor = (n: number) => Array.from({ length: n }, (_, i) => [i / 10]);

describe("ingestion service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.collection.mockReturnValue(mockDb);
    mockDb.doc.mockReturnValue(mockDb);
    mockDb.where.mockReturnValue(mockDb);
    mockDb.count.mockReturnValue(mockDb);
    mockDb.get.mockResolvedValue({ docs: [] });
    mockEmbedDocuments.mockImplementation(async (texts: string[]) => vectorsFor(texts.length));
    mockDiscoverConcepts.mockResolvedValue({ concepts: ["limits"] });
    mockInitializeConcepts.mockResolvedValue(undefined);
  });

  describe("chunkText", () => {
    it("returns empty array for empty string", () => {
      expect(chunkText("")).toEqual([]);
    });

    it("splits long text into chunks", () => {
      expect(chunkText("A".repeat(1200)).length).toBeGreaterThan(1);
    });

    it("breaks at sentence boundaries", () => {
      const text = "A".repeat(350) + ". " + "B".repeat(1000);
      expect(chunkText(text)[0]).toBe("A".repeat(350) + ".");
    });

    it("does not emit a redundant tail chunk that is a suffix of the previous one", () => {
      const chunks = chunkText("A".repeat(1100));
      // 0-500, 450-950, 900-1100 — and nothing after the chunk that reaches the end.
      expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);
    });

    it("emits a single chunk for short text", () => {
      expect(chunkText("short text.")).toEqual(["short text."]);
    });
  });

  describe("sourceKeyFor", () => {
    it("keys named files by filename", () => {
      expect(sourceKeyFor("anything", "notes.pdf")).toBe("file:notes.pdf");
    });

    it("keys unnamed captures by content so distinct captures never collide", () => {
      const a = sourceKeyFor("page one");
      const b = sourceKeyFor("page two");
      expect(a).toMatch(/^hash:[0-9a-f]{64}$/);
      expect(a).not.toBe(b);
      expect(sourceKeyFor("page one", "content-script-capture")).toBe(a);
    });
  });

  describe("ingestText", () => {
    it("stores one vector per chunk, aligned by index, tagged with model and source", async () => {
      const n = await ingestText("uid1", "course1", "A".repeat(1100), { filename: "w1.pdf" });

      expect(n).toBe(3);
      expect(mockEmbedDocuments).toHaveBeenCalledWith(expect.any(Array), "w1.pdf");
      expect(mockBatch.set).toHaveBeenCalledTimes(3);
      mockBatch.set.mock.calls.forEach(([, data], i) => {
        expect(data).toMatchObject({
          chunkIndex: i,
          embedding: [i / 10],
          embeddingModel: "gemini-embedding-2",
          embeddingDim: 768,
          sourceKey: "file:w1.pdf",
        });
      });
      expect(mockDb.set).toHaveBeenCalledTimes(1); // course doc
    });

    it("replaces chunks previously ingested from the same source", async () => {
      const staleRefs = [{ ref: "old-1" }, { ref: "old-2" }];
      mockDb.get.mockResolvedValue({ docs: staleRefs });

      await ingestText("uid1", "course1", "hello world.", { filename: "w1.pdf" });

      expect(mockDb.where).toHaveBeenCalledWith("sourceKey", "==", "file:w1.pdf");
      expect(mockBatch.delete).toHaveBeenCalledWith("old-1");
      expect(mockBatch.delete).toHaveBeenCalledWith("old-2");
      expect(mockBatch.set).toHaveBeenCalledTimes(1);
    });

    it("does not touch Firestore when embedding fails", async () => {
      mockEmbedDocuments.mockRejectedValue(new Error("Embedding response mismatch"));

      await expect(ingestText("uid1", "course1", "hello world.")).rejects.toThrow("mismatch");
      expect(mockBatch.delete).not.toHaveBeenCalled();
      expect(mockBatch.set).not.toHaveBeenCalled();
      expect(mockBatch.commit).not.toHaveBeenCalled();
    });

    it("commits in batches under the Firestore write limit", async () => {
      await ingestText("uid1", "course1", "A".repeat(401 * 450 + 50));
      expect(mockBatch.commit).toHaveBeenCalledTimes(2);
    });

    it("returns 0 without embedding when there are no chunks", async () => {
      expect(await ingestText("uid1", "course1", "")).toBe(0);
      expect(mockEmbedDocuments).not.toHaveBeenCalled();
    });
  });

  describe("recordIngestedFile", () => {
    it("upserts a deterministic file record", async () => {
      await recordIngestedFile("uid1", "course1", { filename: "a.pdf", sourcePlatform: "upload", contentHash: "h", chunkCount: 2 });
      await recordIngestedFile("uid1", "course1", { filename: "a.pdf", sourcePlatform: "upload", contentHash: "h2", chunkCount: 3 });

      const fileIds = mockDb.doc.mock.calls.map(([id]) => id).filter((id) => typeof id === "string" && id.length === 64);
      expect(fileIds).toHaveLength(2);
      expect(fileIds[0]).toBe(fileIds[1]);
      expect(mockDb.set).toHaveBeenLastCalledWith(
        expect.objectContaining({ filename: "a.pdf", contentHash: "h2", chunkCount: 3 }),
        { merge: true },
      );
    });
  });

  describe("ingestFile", () => {
    it("extracts PDFs, ingests, records the file and seeds concepts", async () => {
      mockExtractTextFromPDF.mockResolvedValue("pdf text.");
      await ingestFile("uid1", "course1", "/test.pdf", "test.pdf");

      expect(mockExtractTextFromPDF).toHaveBeenCalledWith("/test.pdf");
      expect(mockBatch.set).toHaveBeenCalledTimes(1);
      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ filename: "test.pdf", chunkCount: 1 }), { merge: true });
      expect(mockInitializeConcepts).toHaveBeenCalledWith("uid1", ["limits"], "course1");
    });

    it("OCRs images", async () => {
      mockExtractText.mockResolvedValue("image text");
      await ingestFile("uid1", "course1", "/test.png", "test.png");
      expect(mockExtractText).toHaveBeenCalledWith("/test.png");
    });

    it("reads other files as UTF-8 text", async () => {
      await ingestFile("uid1", "course1", "/test.txt", "test.txt");
      expect(mockEmbedDocuments).toHaveBeenCalledWith(["mock file content"], "test.txt");
    });
  });
});
