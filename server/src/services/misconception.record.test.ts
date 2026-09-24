import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory Firestore with real transaction semantics for the paths recordInteraction touches.
const { store, statsWrites, mockEmbedLabels, txnCount, failStatsSet, failStatsTxnGet, mockLogger } = vi.hoisted(() => ({
  store: new Map<string, Record<string, any>>(),
  statsWrites: [] as any[],
  mockEmbedLabels: vi.fn(async (labels: string[]) => labels.map(() => [0.5])),
  txnCount: { n: 0 },
  // Toggled by individual tests to exercise the best-effort gamification-sync catch handlers.
  // `value` is thrown as-is when set, so a string exercises the non-Error side of
  // `err instanceof Error ? err.message : err`.
  failStatsSet: { value: undefined as undefined | Error | string },
  failStatsTxnGet: { value: undefined as undefined | Error | string },
  mockLogger: { warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../db/firebase", () => {
  const ref = (path: string) => ({
    path,
    get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
    set: async (data: any, opts?: any) => {
      if (path.endsWith("/gamification/stats")) {
        if (failStatsSet.value !== undefined) throw failStatsSet.value;
        statsWrites.push(data);
      }
      store.set(path, opts?.merge ? { ...(store.get(path) || {}), ...data } : data);
    },
  });
  const db = {
    collection: (c: string) => ({
      doc: (uid: string) => ({
        collection: (sub: string) => ({ doc: (id: string) => ref(`${c}/${uid}/${sub}/${id}`) }),
      }),
    }),
    runTransaction: async (fn: (txn: any) => Promise<any>) => {
      txnCount.n++;
      const writes: Array<() => void> = [];
      const txn = {
        get: async (r: any) => {
          if (r.path.endsWith("/gamification/stats") && failStatsTxnGet.value !== undefined) {
            throw failStatsTxnGet.value;
          }
          return { exists: store.has(r.path), data: () => store.get(r.path) };
        },
        set: (r: any, data: any, opts?: any) =>
          writes.push(() => {
            if (r.path.endsWith("/gamification/stats")) statsWrites.push(data);
            store.set(r.path, opts?.merge ? { ...(store.get(r.path) || {}), ...data } : data);
          }),
        update: (r: any, data: any) => writes.push(() => store.set(r.path, { ...store.get(r.path), ...data })),
      };
      const result = await fn(txn);
      writes.forEach((w) => w());
      return result;
    },
  };
  return { db };
});
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => "TS",
    increment: (n: number) => ({ increment: n }),
    vector: (v: number[]) => ({ vector: v }),
  },
}));
vi.mock("../logger", () => ({ logger: mockLogger }));
vi.mock("./embeddings", () => ({ embedLabels: mockEmbedLabels, currentEmbeddingModel: () => "gemini-embedding-2" }));
vi.mock("./concepts", () => ({
  labelEmbeddingFields: (v: number[] | null) => (v ? { labelEmbedding: { vector: v }, labelEmbeddingModel: "gemini-embedding-2" } : {}),
  resolveConceptNodes: vi.fn(),
}));

import { recordInteraction } from "./misconception";

const node = (id: string) => store.get(`users/u1/smg/${id}`)!;

describe("recordInteraction (FSRS)", () => {
  beforeEach(() => {
    store.clear();
    statsWrites.length = 0;
    txnCount.n = 0;
    mockEmbedLabels.mockClear();
    failStatsSet.value = undefined;
    failStatsTxnGet.value = undefined;
    mockLogger.warn.mockClear();
  });

  it("creates a node with an FSRS card and a label vector on the first graded answer", async () => {
    await recordInteraction("u1", "chain_rule", { errorType: "none", confidence: 1, isCorrect: true, courseId: "c1" });

    const n = node("chain_rule");
    expect(n).toMatchObject({ accuracyRate: 1, correctCount: 1, incorrectCount: 0, interactionCount: 1, courseId: "c1" });
    expect(n.fsrs.reps).toBe(1);
    expect(n.nextReviewDate).toEqual(n.fsrs.due);
    expect(n.nextReviewDate.getTime()).toBeGreaterThan(Date.now());
    expect(n.labelEmbedding).toEqual({ vector: [0.5] });
    expect(statsWrites[0]).toMatchObject({ conceptCount: { increment: 1 }, maxAccuracy: 1 });
    expect(txnCount.n).toBe(1);
  });

  it("creates a node from a wrong first answer: counts the miss and records its error type", async () => {
    await recordInteraction("u1", "series", { errorType: "knowledge_gap", confidence: 1, isCorrect: false });

    const n = node("series");
    expect(n).toMatchObject({
      accuracyRate: 0,
      correctCount: 0,
      incorrectCount: 1,
      errorTypeMap: { knowledge_gap: 1 },
      lastErrorAt: "TS",
      courseId: null,
    });
    expect(n.fsrs.lapses + n.fsrs.reps).toBeGreaterThan(0);
  });

  it("uses the resolver's label vector instead of embedding again", async () => {
    await recordInteraction("u1", "limits", { errorType: "none", confidence: 1, labelEmbedding: [0.9] });
    expect(mockEmbedLabels).not.toHaveBeenCalled();
    expect(node("limits").labelEmbedding).toEqual({ vector: [0.9] });
  });

  it("records a plain question as exposure: no correctness, no schedule change, due now", async () => {
    const before = Date.now();
    await recordInteraction("u1", "limits", { errorType: "none", confidence: 0.9 });
    const n = node("limits");
    expect(n).toMatchObject({ correctCount: 0, incorrectCount: 0, accuracyRate: 0, interactionCount: 1 });
    expect(n.fsrs.reps).toBe(0);
    expect(n.nextReviewDate.getTime()).toBeLessThanOrEqual(Date.now());
    expect(n.nextReviewDate.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(statsWrites[0]).not.toHaveProperty("maxAccuracy");
  });

  it("brings a concept's review forward when a question reveals a misconception", async () => {
    await recordInteraction("u1", "chain_rule", { errorType: "none", confidence: 1, isCorrect: true });
    await recordInteraction("u1", "chain_rule", { errorType: "none", confidence: 1, isCorrect: true });
    const dueAfterPasses = node("chain_rule").nextReviewDate.getTime();

    await recordInteraction("u1", "chain_rule", { errorType: "procedural_error", confidence: 0.85 });

    const n = node("chain_rule");
    expect(n.nextReviewDate.getTime()).toBeLessThan(dueAfterPasses);
    expect(n.fsrs.lapses).toBe(1);
    expect(n.errorTypeMap).toEqual({ procedural_error: 1 });
    // A question is not an answer: accuracy stays at 2/2.
    expect(n).toMatchObject({ correctCount: 2, incorrectCount: 0, accuracyRate: 1, interactionCount: 3 });
  });

  it("counts wrong answers, records the error, and keeps the node's course", async () => {
    await recordInteraction("u1", "series", { errorType: "none", confidence: 1, isCorrect: true, courseId: "c1" });
    await recordInteraction("u1", "series", { errorType: "knowledge_gap", confidence: 1, isCorrect: false });

    const n = node("series");
    expect(n).toMatchObject({ correctCount: 1, incorrectCount: 1, accuracyRate: 0.5, courseId: "c1", lastErrorAt: "TS" });
    expect(n.errorTypeMap).toEqual({ knowledge_gap: 1 });
  });

  it("migrates an SM-2 node: keeps its due date until the first real review", async () => {
    const legacyDue = new Date(Date.now() + 5 * 86_400_000);
    store.set("users/u1/smg/eigenvalues", {
      accuracyRate: 0.5, correctCount: 1, incorrectCount: 1, interactionCount: 2,
      easeFactor: 2.3, reviewIntervalDays: 6, nextReviewDate: { toDate: () => legacyDue }, errorTypeMap: {},
    });

    await recordInteraction("u1", "eigenvalues", { errorType: "none", confidence: 1 });
    expect(node("eigenvalues").nextReviewDate).toEqual(legacyDue);
    expect(node("eigenvalues").fsrs.reps).toBe(0);

    await recordInteraction("u1", "eigenvalues", { errorType: "none", confidence: 1, isCorrect: true });
    expect(node("eigenvalues").fsrs.reps).toBe(1);
    expect(node("eigenvalues").accuracyRate).toBeCloseTo(2 / 3);
  });

  it("does not embed inside the transaction and does not re-embed existing nodes", async () => {
    await recordInteraction("u1", "a", { errorType: "none", confidence: 1 });
    await recordInteraction("u1", "a", { errorType: "none", confidence: 1 });
    expect(mockEmbedLabels).toHaveBeenCalledTimes(1);
  });

  it("logs but does not throw when the gamification stat sync fails for a brand-new node", async () => {
    failStatsSet.value = new Error("gamification stats write failed");
    await expect(
      recordInteraction("u1", "new_concept", { errorType: "none", confidence: 1, isCorrect: true }),
    ).resolves.toBeUndefined();

    // The SMG node itself was still written — only the best-effort stats sync failed.
    expect(node("new_concept")).toMatchObject({ correctCount: 1 });
    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "u1", conceptNode: "new_concept", err: "gamification stats write failed" }),
        "gamification stat sync failed",
      ),
    );
  });

  it("logs the raw value, not .message, when the stat sync rejects with something other than an Error", async () => {
    failStatsSet.value = "non-error rejection";
    await expect(
      recordInteraction("u1", "new_concept", { errorType: "none", confidence: 1, isCorrect: true }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "u1", conceptNode: "new_concept", err: "non-error rejection" }),
        "gamification stat sync failed",
      ),
    );
  });

  it("logs but does not throw when the best-effort maxAccuracy sync fails for an existing node", async () => {
    // First interaction creates the node (stats sync succeeds, untouched by the flag).
    await recordInteraction("u1", "mastered", { errorType: "none", confidence: 1, isCorrect: true });

    // Second interaction takes the update path (outcome.created === false) and, since accuracy
    // stays >= 0.9, fires the best-effort maxAccuracy transaction — which we make fail.
    failStatsTxnGet.value = new Error("gamification stats transaction read failed");
    await expect(
      recordInteraction("u1", "mastered", { errorType: "none", confidence: 1, isCorrect: true }),
    ).resolves.toBeUndefined();

    expect(node("mastered")).toMatchObject({ correctCount: 2 });
    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "u1", conceptNode: "mastered" }),
        "gamification stat sync failed",
      ),
    );
  });

  it("logs the raw value for a non-Error rejection from the maxAccuracy sync too", async () => {
    await recordInteraction("u1", "mastered2", { errorType: "none", confidence: 1, isCorrect: true });
    failStatsTxnGet.value = "non-error rejection";
    await expect(
      recordInteraction("u1", "mastered2", { errorType: "none", confidence: 1, isCorrect: true }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ uid: "u1", conceptNode: "mastered2", err: "non-error rejection" }),
        "gamification stat sync failed",
      ),
    );
  });

  it("bootstraps the best-effort maxAccuracy stat when a stats doc already exists but has none yet", async () => {
    // First interaction: an ungraded question — creates the node and a stats doc, but the
    // create-path only sets maxAccuracy when the interaction was answered, so it is absent.
    await recordInteraction("u1", "fresh_topic", { errorType: "none", confidence: 1 });
    expect(statsWrites[0]).not.toHaveProperty("maxAccuracy");

    // Second interaction: a correct answer — update path; statsRef exists but has no
    // maxAccuracy yet, so `(snap.data().maxAccuracy ?? 0)` must fall back to 0.
    await recordInteraction("u1", "fresh_topic", { errorType: "none", confidence: 1, isCorrect: true });

    await vi.waitFor(() => expect(statsWrites.some((w) => w.maxAccuracy === 1)).toBe(true));
  });

  it("bootstraps the best-effort maxAccuracy stat when the stats doc has never existed at all", async () => {
    // Seed the SMG node directly, bypassing recordInteraction's create path entirely, so the
    // gamification/stats doc has genuinely never been written for this user.
    store.set("users/u1/smg/seeded_topic", {
      accuracyRate: 0, correctCount: 0, incorrectCount: 0, interactionCount: 0, errorTypeMap: {},
    });
    expect(statsWrites).toHaveLength(0);

    await recordInteraction("u1", "seeded_topic", { errorType: "none", confidence: 1, isCorrect: true });

    await vi.waitFor(() => expect(statsWrites.some((w) => w.maxAccuracy === 1)).toBe(true));
  });

  it("records exposure with none of the counters ever initialized, using every documented default", async () => {
    // A node with literally none of the numeric/map fields set — as if written by some other
    // path than recordInteraction — exercises every `data.<field> || <default>` fallback at once.
    store.set("users/u1/smg/bare_node", {});

    await recordInteraction("u1", "bare_node", { errorType: "none", confidence: 0.9 }); // a question, not an answer

    const n = node("bare_node");
    expect(n).toMatchObject({ correctCount: 0, incorrectCount: 0, interactionCount: 1, accuracyRate: 0 });
    expect(n.errorTypeMap).toEqual({});
  });
});
