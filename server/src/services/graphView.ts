import { retrievability } from "./scheduler";

/** Fields the graph views need. Everything else (notably the 768-float labelEmbedding) stays in Firestore. */
export const GRAPH_FIELDS = ["accuracyRate", "interactionCount", "nextReviewDate", "courseId", "errorTypeMap", "fsrs"] as const;

export interface GraphNodeView {
  conceptNode: string;
  accuracyRate: number;
  interactionCount: number;
  nextReviewDate?: unknown;
  courseId?: string;
  errorTypeMap: Record<string, number>;
  /** The error type seen most often on this concept, or null when none has been recorded. */
  dominantErrorType: string | null;
  /** FSRS predicted recall now (0-1); omitted for nodes without FSRS state. */
  retrievability?: number;
}

/** Most frequent real error type; ties go to the earlier type in the map, "none" never wins. */
export function dominantErrorType(errorTypeMap: Record<string, number> | undefined): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [type, count] of Object.entries(errorTypeMap || {})) {
    if (type === "none" || !(Number(count) > bestCount)) continue;
    best = type;
    bestCount = Number(count);
  }
  return best;
}

/** Project an SMG document to the shape the graph API returns. */
export function toGraphNode(id: string, data: Record<string, any>, now: Date = new Date()): GraphNodeView {
  const errorTypeMap = data.errorTypeMap || {};
  return {
    conceptNode: id,
    accuracyRate: data.accuracyRate || 0,
    interactionCount: data.interactionCount || 0,
    ...(data.nextReviewDate ? { nextReviewDate: data.nextReviewDate } : {}),
    ...(data.courseId ? { courseId: data.courseId } : {}),
    errorTypeMap,
    dominantErrorType: dominantErrorType(errorTypeMap),
    ...(data.fsrs ? { retrievability: retrievability(data.fsrs, now) } : {}),
  };
}
