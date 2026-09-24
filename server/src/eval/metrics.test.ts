import { describe, it, expect } from "vitest";
import { retrievalReport, thresholdSweep, pickThreshold } from "./metrics";

const hit = (distance: number, relevant: boolean) => ({ distance, relevant });

describe("retrievalReport", () => {
  const results = [
    { id: "q1", ranked: [hit(0.2, true), hit(0.3, false)] },
    { id: "q2", ranked: [hit(0.25, false), hit(0.5, true)] },
    { id: "q3", ranked: [hit(0.4, false), hit(0.45, false)] },
    { id: "q4", ranked: [hit(0.1, false), hit(0.2, false), hit(0.7, true)] },
  ];

  it("computes recall@k and MRR", () => {
    const r = retrievalReport(results, [1, 2, 3], 0.6);
    expect(r.cases).toBe(4);
    expect(r.recallAtK).toEqual({ 1: 0.25, 2: 0.5, 3: 0.75 });
    expect(r.mrr).toBeCloseTo((1 + 0.5 + 0 + 1 / 3) / 4);
  });

  it("measures how the distance threshold trades relevant hits against noise", () => {
    const r = retrievalReport(results, [3], 0.6);
    // q1 (0.2) and q2 (0.5) keep their relevant hit; q4's (0.7) is cut. q3 has none.
    expect(r.relevantKeptAtThreshold).toBeCloseTo(2 / 3);
    // top-3 hits: 9 total, irrelevant under 0.6: 0.3, 0.25, 0.4, 0.45, 0.1, 0.2 = 6
    expect(r.irrelevantPassingAtThreshold).toBeCloseTo(6 / 9);
  });

  it("handles empty input", () => {
    const r = retrievalReport([], [1], 0.5);
    expect(r).toMatchObject({ cases: 0, mrr: 0, relevantKeptAtThreshold: 0, irrelevantPassingAtThreshold: 0 });
  });
});

describe("thresholdSweep / pickThreshold", () => {
  const pairs = [
    { a: "chain_rule", b: "derivatives_chain_rule", same: true, distance: 0.05 },
    { a: "limits", b: "limit_definition", same: true, distance: 0.12 },
    { a: "series", b: "infinite_series", same: true, distance: 0.2 },
    { a: "chain_rule", b: "product_rule", same: false, distance: 0.18 },
    { a: "limits", b: "integrals", same: false, distance: 0.5 },
  ];

  it("computes precision, recall and F1 per threshold", () => {
    const [low, mid, high] = thresholdSweep(pairs, [0.1, 0.15, 0.25]);
    expect(low).toMatchObject({ threshold: 0.1, precision: 1, recall: 1 / 3 });
    expect(mid).toMatchObject({ threshold: 0.15, precision: 1, recall: 2 / 3 });
    expect(high.precision).toBeCloseTo(3 / 4);
    expect(high.recall).toBe(1);
  });

  it("treats a threshold that merges nothing as vacuously precise", () => {
    expect(thresholdSweep(pairs, [0.01])[0]).toMatchObject({ precision: 1, recall: 0, f1: 0 });
  });

  it("picks the highest-recall threshold that keeps precision above the floor", () => {
    expect(pickThreshold(thresholdSweep(pairs, [0.05, 0.1, 0.15, 0.25]))?.threshold).toBe(0.15);
  });

  it("falls back to best F1 when no threshold is precise enough", () => {
    // Test fallback with points where F1 increases then decreases to hit both ternary branches
    const fallbackPoints = [
      { threshold: 0.1, precision: 0.5, recall: 0.5, f1: 0.5 },
      { threshold: 0.2, precision: 0.8, recall: 0.8, f1: 0.8 },
      { threshold: 0.3, precision: 0.2, recall: 0.2, f1: 0.2 },
    ];
    expect(pickThreshold(fallbackPoints, 0.95)?.threshold).toBe(0.2);
    expect(pickThreshold([])).toBeNull();
  });

  it("handles case with zero positive pairs in thresholdSweep", () => {
    const allNeg = [
      { a: "x", b: "y", same: false, distance: 0.1 },
    ];
    const [res] = thresholdSweep(allNeg, [0.2]);
    expect(res.recall).toBe(0);
  });

  it("favors lower threshold when recall is tied in safe points", () => {
    const points = [
      { threshold: 0.2, precision: 0.98, recall: 0.8, f1: 0.88 },
      { threshold: 0.1, precision: 0.98, recall: 0.8, f1: 0.88 },
    ];
    expect(pickThreshold(points, 0.95)?.threshold).toBe(0.1);
  });
});
