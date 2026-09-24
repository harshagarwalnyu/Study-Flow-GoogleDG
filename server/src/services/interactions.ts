import { classifyConcept } from "./gemini";
import { recordInteraction } from "./misconception";
import { saveInteraction } from "./firestore";
import { cacheInvalidate } from "./cache";
import { normalizeClassifierTag, resolveConceptNode, listKnownConcepts, type ClassifierTag } from "./concepts";
import type { RetrievedChunk } from "./rag";

export interface Source {
  filename: string;
  courseId: string;
}

/** Distinct source files behind the retrieved chunks, in rank order. */
export function sourcesFrom(chunks: RetrievedChunk[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const c of chunks) {
    if (!c.filename) continue;
    const key = `${c.courseId}\u0000${c.filename}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ filename: c.filename, courseId: c.courseId });
  }
  return out;
}

/** Number each chunk and name its file, so the model can say which lecture it used. */
export function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => `[${i + 1}]${c.filename ? ` (from ${c.filename})` : ""}\n${c.content}`)
    .join("\n\n---\n\n");
}

export interface QuestionInteraction {
  question: string;
  solution: string;
  mainConcept?: string;
  courseId?: string;
  response: Record<string, unknown>;
  requestMeta?: Record<string, unknown>;
}

/**
 * Feed a student question into the misconception graph: classify it, map the label onto an
 * existing SMG node, then log the event and update the node. Questions carry no correctness
 * signal, so SM-2 records exposure (isCorrect undefined), not a right/wrong answer.
 */
export async function recordQuestionInteraction(uid: string, input: QuestionInteraction): Promise<{ classifierTag: ClassifierTag; eventId: string }> {
  const knownConcepts = await listKnownConcepts(uid);
  const raw = await classifyConcept(input.question, input.solution, knownConcepts);
  const normalized = normalizeClassifierTag(raw, input.mainConcept || "");
  const resolved = await resolveConceptNode(uid, normalized.conceptNode);
  const classifierTag = { ...normalized, conceptNode: resolved.conceptNode };

  const [eventId] = await Promise.all([
    saveInteraction(uid, {
      courseId: input.courseId ?? null,
      content: input.question,
      eventType: "explain",
      response: input.response,
      classifierTag,
      ...(input.requestMeta ? { requestMeta: input.requestMeta } : {}),
    }),
    recordInteraction(uid, classifierTag.conceptNode, {
      errorType: classifierTag.errorType,
      confidence: classifierTag.confidence,
      courseId: input.courseId,
      labelEmbedding: resolved.labelEmbedding,
    }),
  ]);
  cacheInvalidate(`graph:${uid}`);
  cacheInvalidate(`drill:${uid}`);

  return { classifierTag, eventId };
}
