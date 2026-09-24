/** Pure evaluation metrics — no I/O, so they are unit-tested directly. */

export interface RankedHit {
  /** Cosine distance of this retrieved chunk to the query. */
  distance: number;
  relevant: boolean;
}

export interface RetrievalCaseResult {
  id: string;
  /** Retrieved chunks in rank order (closest first). */
  ranked: RankedHit[];
}

export interface RetrievalReport {
  cases: number;
  recallAtK: Record<number, number>;
  mrr: number;
  /** Among queries with a relevant chunk, share whose best relevant hit survives the distance threshold. */
  relevantKeptAtThreshold: number;
  /** Share of top-k hits that are irrelevant yet pass the threshold (noise injected into prompts). */
  irrelevantPassingAtThreshold: number;
}

export function retrievalReport(results: RetrievalCaseResult[], ks: number[], threshold: number): RetrievalReport {
  const n = results.length || 1;
  const recallAtK: Record<number, number> = {};
  for (const k of ks) {
    recallAtK[k] = results.filter((r) => r.ranked.slice(0, k).some((h) => h.relevant)).length / n;
  }

  const mrr = results.reduce((sum, r) => {
    const rank = r.ranked.findIndex((h) => h.relevant);
    return sum + (rank === -1 ? 0 : 1 / (rank + 1));
  }, 0) / n;

  const withRelevant = results.filter((r) => r.ranked.some((h) => h.relevant));
  const kept = withRelevant.filter((r) => r.ranked.some((h) => h.relevant && h.distance <= threshold)).length;

  const maxK = Math.max(...ks);
  const topHits = results.flatMap((r) => r.ranked.slice(0, maxK));
  const irrelevantPassing = topHits.filter((h) => !h.relevant && h.distance <= threshold).length;

  return {
    cases: results.length,
    recallAtK,
    mrr,
    relevantKeptAtThreshold: withRelevant.length ? kept / withRelevant.length : 0,
    irrelevantPassingAtThreshold: topHits.length ? irrelevantPassing / topHits.length : 0,
  };
}

export interface LabeledPair {
  a: string;
  b: string;
  same: boolean;
  distance: number;
}

export interface ThresholdPoint {
  threshold: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Precision/recall of "merge when distance <= threshold" across candidate thresholds. */
export function thresholdSweep(pairs: LabeledPair[], thresholds: number[]): ThresholdPoint[] {
  return thresholds.map((threshold) => {
    const merged = pairs.filter((p) => p.distance <= threshold);
    const truePos = merged.filter((p) => p.same).length;
    const positives = pairs.filter((p) => p.same).length;
    const precision = merged.length ? truePos / merged.length : 1;
    const recall = positives ? truePos / positives : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { threshold, precision, recall, f1 };
  });
}

/**
 * Best merge threshold, favouring precision: a wrong merge corrupts two concepts' history,
 * while a missed merge only leaves a duplicate. Picks the highest-recall threshold whose
 * precision meets the floor; falls back to best F1 if none does.
 */
export function pickThreshold(points: ThresholdPoint[], precisionFloor = 0.95): ThresholdPoint | null {
  if (points.length === 0) return null;
  const safe = points.filter((p) => p.precision >= precisionFloor && p.recall > 0);
  if (safe.length) return safe.reduce((best, p) => (p.recall > best.recall || (p.recall === best.recall && p.threshold < best.threshold) ? p : best));
  return points.reduce((best, p) => (p.f1 > best.f1 ? p : best));
}
