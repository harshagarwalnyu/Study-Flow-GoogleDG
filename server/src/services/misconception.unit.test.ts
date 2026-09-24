import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock firebase-admin/app to prevent initFirebaseAdmin() from running ────
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

vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  cert: vi.fn(),
  getApps: vi.fn(() => [{ name: "mock" }]),
}));

// ── Mock firebase-admin/auth (db/firebase.js calls getAuth() at module level)
vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({
    verifyIdToken: vi.fn().mockResolvedValue({ uid: "uid-1", email: "test@example.com" }),
  })),
}));

// ── Build reusable Firestore mock stubs ────────────────────────────────────
const mockUpdate = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn().mockResolvedValue(undefined);
const mockGet = vi.fn();

// smgRef mock: get/set/update on the concept document
const mockSmgDocRef = {
  get: mockGet,
  set: mockSet,
  update: mockUpdate,
};

// Gamification stats doc ref — needs .set() that returns a thenable
const mockGamStatsRef = {
  set: vi.fn().mockResolvedValue(undefined),
};

// Tracks the last smg doc id requested so we can assert collection paths
let _lastSmgDocId = null;
let _lastSmgCollectionPath = null;

const mockSmgCollection = vi.fn(() => ({
  doc: vi.fn((id) => {
    _lastSmgDocId = id;
    return mockSmgDocRef;
  }),
  where: vi.fn(() => ({
    orderBy: vi.fn(() => ({
      limit: vi.fn(() => ({
        get: mockGet,
      })),
    })),
    limit: vi.fn(() => ({
      get: mockGet,
    })),
    get: mockGet,
  })),
  orderBy: vi.fn(() => ({
    limit: vi.fn(() => ({
      get: mockGet,
    })),
  })),
  get: mockGet,
}));

const mockGamificationCollection = vi.fn(() => ({
  doc: vi.fn(() => mockGamStatsRef),
}));

// users/{uid} document — provides .collection() routing
const mockUserDoc = vi.fn(() => ({
  collection: vi.fn((name) => {
    _lastSmgCollectionPath = name;
    if (name === "smg") return mockSmgCollection();
    if (name === "gamification") return mockGamificationCollection();
    return { doc: vi.fn(() => ({ get: mockGet, set: mockSet })) };
  }),
}));

const mockDb = {
  collection: vi.fn((name) => ({
    doc: name === "users" ? mockUserDoc : vi.fn(() => ({ get: mockGet })),
  })),
};

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(() => mockDb),
  FieldValue: {
    serverTimestamp: vi.fn(() => "MOCK_TS"),
    vector: vi.fn((v) => v),
    increment: vi.fn((n) => ({ _increment: n })),
  },
}));

// ── Import the module under test AFTER mocks are established ──────────────
const { getWeakestConcepts, getDrillQueue } =
  await import("./misconception");

// ── Helpers ────────────────────────────────────────────────────────────────
function makeSmgDoc(overrides = {}) {
  return {
    exists: true,
    data: () => ({
      accuracyRate: 0.5,
      correctCount: 5,
      incorrectCount: 5,
      interactionCount: 10,
      easeFactor: 2.5,
      reviewIntervalDays: 6,
      errorTypeMap: {},
      lastErrorAt: null,
      courseId: null,
      ...overrides,
    }),
  };
}

describe("getWeakestConcepts()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGamStatsRef.set.mockResolvedValue(undefined);
  });

  it("returns due-for-review concepts when nextReviewDate query is non-empty", async () => {
    const docA = { id: "derivatives_chain_rule", data: () => ({ accuracyRate: 0.3, interactionCount: 5 }) };
    const docB = { id: "integrals_by_parts", data: () => ({ accuracyRate: 0.6, interactionCount: 8 }) };

    // nextReviewDate query returns results
    mockGet.mockResolvedValueOnce({ empty: false, docs: [docA, docB] });

    const result = await getWeakestConcepts("uid-1", 10);

    expect(result).toHaveLength(2);
    expect(result[0].conceptNode).toBe("derivatives_chain_rule");
    expect(result[0].accuracyRate).toBe(0.3);
    expect(result[1].conceptNode).toBe("integrals_by_parts");
  });

  it("falls back to accuracyRate-ordered query when no concepts are due", async () => {
    const docA = { id: "limits_epsilon_delta", data: () => ({ accuracyRate: 0.2 }) };

    // Primary query empty → fallback fires
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    // Fallback query result
    mockGet.mockResolvedValueOnce({ empty: false, docs: [docA] });

    const result = await getWeakestConcepts("uid-1", 10);

    expect(result).toHaveLength(1);
    expect(result[0].conceptNode).toBe("limits_epsilon_delta");
    expect(result[0].accuracyRate).toBe(0.2);
  });

  it("returns empty array when both queries return no documents", async () => {
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    mockGet.mockResolvedValueOnce({ empty: false, docs: [] });

    const result = await getWeakestConcepts("uid-1", 10);
    expect(result).toHaveLength(0);
  });
});

// ── getDrillQueue() ────────────────────────────────────────────────────────
describe("getDrillQueue()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGamStatsRef.set.mockResolvedValue(undefined);
  });

  function makeDoc(id: string, { accuracyRate, daysOverdue }: { accuracyRate: number; daysOverdue: number }) {
    const reviewDate = new Date(Date.now() - daysOverdue * 24 * 60 * 60 * 1000);
    return {
      id,
      data: () => ({
        accuracyRate,
        interactionCount: 5,
        nextReviewDate: reviewDate, // plain Date — covers the `|| data.nextReviewDate` path
      }),
    };
  }

  it("returns concepts sorted by urgency descending", async () => {
    // high urgency: 5 days overdue, 0% accuracy → urgency = 5*2 + (1-0)*5 = 15
    // medium urgency: 2 days overdue, 0.5 accuracy → urgency = 2*2 + (1-0.5)*5 = 6.5
    // low urgency: 0 days overdue, 0.8 accuracy → urgency = 0 + (1-0.8)*5 = 1
    const highDoc = makeDoc("derivatives_chain_rule", { accuracyRate: 0, daysOverdue: 5 });
    const medDoc = makeDoc("integrals_by_parts", { accuracyRate: 0.5, daysOverdue: 2 });
    const lowDoc = makeDoc("limits_continuity", { accuracyRate: 0.8, daysOverdue: 0 });

    // getDrillQueue fetches all with one query (the lookahead where clause)
    mockGet.mockResolvedValueOnce({ docs: [medDoc, lowDoc, highDoc] });

    const result = await getDrillQueue("uid-1", 20);

    expect(result[0].conceptNode).toBe("derivatives_chain_rule");
    expect(result[1].conceptNode).toBe("integrals_by_parts");
    expect(result[2].conceptNode).toBe("limits_continuity");
  });

  it("computes urgency correctly using the documented formula", async () => {
    // overdueDays * 2 + (1 - accuracyRate) * 5
    const doc = makeDoc("matrix_eigenvalues", { accuracyRate: 0.4, daysOverdue: 3 });
    mockGet.mockResolvedValueOnce({ docs: [doc] });

    const result = await getDrillQueue("uid-1", 20);

    // 3*2 + (1-0.4)*5 = 6 + 3 = 9
    expect(result[0].urgency).toBeCloseTo(9, 1);
  });

  it("respects the limit parameter and returns at most limit items", async () => {
    const docs = Array.from({ length: 15 }, (_, i) =>
      makeDoc(`concept_${i}`, { accuracyRate: 0.5, daysOverdue: i })
    );
    mockGet.mockResolvedValueOnce({ docs });

    const result = await getDrillQueue("uid-1", 5);

    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("returns empty array when no concepts are queued", async () => {
    mockGet.mockResolvedValueOnce({ docs: [] });

    const result = await getDrillQueue("uid-1", 20);
    expect(result).toHaveLength(0);
  });

  it("handles Firestore Timestamp shape via .toDate() on nextReviewDate", async () => {
    const reviewDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const doc = {
      id: "derivatives_power_rule",
      data: () => ({
        accuracyRate: 0.6,
        interactionCount: 3,
        nextReviewDate: { toDate: () => reviewDate }, // Firestore Timestamp shape
      }),
    };
    mockGet.mockResolvedValueOnce({ docs: [doc] });

    const result = await getDrillQueue("uid-1", 20);

    expect(result).toHaveLength(1);
    expect(result[0].nextReviewDate).toBe(reviewDate);
    // 2 days overdue, 0.4 accuracy → urgency = 2*2 + (1-0.6)*5 = 4 + 2 = 6
    expect(result[0].urgency).toBeCloseTo(6, 1);
  });
});
