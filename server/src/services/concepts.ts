import { FieldValue } from "firebase-admin/firestore";
import { db } from "../db/firebase";
import { env } from "../env";
import { logger } from "../logger";
import { embedLabels, currentEmbeddingModel } from "./embeddings";

export const ALLOWED_ERROR_TYPES = new Set([
  "conceptual_misunderstanding",
  "procedural_error",
  "knowledge_gap",
  "reasoning_error",
  "none",
]);

export interface ClassifierTag {
  conceptNode: string;
  errorType: string;
  confidence: number;
}

export function toSnakeCase(input: unknown): string {
  return String(input ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function normalizeClassifierTag(classifierTag: any, fallbackConcept: string): ClassifierTag {
  const fallback = toSnakeCase(fallbackConcept) || "general_concept";
  const conceptNode = toSnakeCase(classifierTag?.conceptNode) || fallback;
  const errorType = ALLOWED_ERROR_TYPES.has(classifierTag?.errorType)
    ? classifierTag.errorType
    : "knowledge_gap";
  const rawConfidence = Number(classifierTag?.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0.5;

  return { conceptNode, errorType, confidence };
}

export interface ResolvedConcept {
  conceptNode: string;
  /** True when an existing node was reused (exact id or embedding match). */
  matchedExisting: boolean;
  /** Cosine distance to the matched node; 0 for exact id matches, null for new nodes. */
  distance: number | null;
  /** Label vector to store when this creates a new node, so later labels can match it. */
  labelEmbedding: number[] | null;
}

function smgCollection(uid: string) {
  return db.collection("users").doc(uid).collection("smg");
}

/**
 * Map a proposed concept label onto the student's existing SMG node when they mean the same
 * thing (`chain_rule` vs `derivatives_chain_rule`), so one weakness is tracked as one node.
 *
 * Exact ids short-circuit; otherwise the label is embedded and matched against stored label
 * vectors with a strict distance cutoff. Anything farther becomes a new node.
 */
export async function resolveConceptNode(uid: string, proposed: string): Promise<ResolvedConcept> {
  const [resolved] = await resolveConceptNodes(uid, [proposed]);
  return resolved;
}

export async function resolveConceptNodes(uid: string, proposed: string[]): Promise<ResolvedConcept[]> {
  const ids = proposed.map((p) => toSnakeCase(p) || "general_concept");
  const smg = smgCollection(uid);

  const existing = await Promise.all(ids.map((id) => smg.doc(id).get()));
  const unresolved = ids.map((id, i) => (existing[i].exists ? null : id));
  const toEmbed = [...new Set(unresolved.filter((id): id is string => id !== null))];

  const vectors = new Map<string, number[]>();
  if (toEmbed.length > 0) {
    const embedded = await embedLabels(toEmbed);
    toEmbed.forEach((id, i) => vectors.set(id, embedded[i]));
  }

  const model = currentEmbeddingModel();

  const matchNew = async (id: string): Promise<ResolvedConcept> => {
    const vector = vectors.get(id)!;
    const snap = await (smg as any)
      .findNearest({
        vectorField: "labelEmbedding",
        queryVector: vector,
        limit: 3,
        distanceMeasure: "COSINE",
        distanceResultField: "_distance",
        distanceThreshold: env.conceptMatchMaxDistance,
      })
      .get();

    const match = snap.docs.find((d: any) => d.get("labelEmbeddingModel") === model);
    if (!match) return { conceptNode: id, matchedExisting: false, distance: null, labelEmbedding: vector };

    const distance = match.get("_distance") ?? null;
    logger.info({ uid, proposed: id, matched: match.id, distance }, "concept label merged into existing node");
    return { conceptNode: match.id, matchedExisting: true, distance, labelEmbedding: null };
  };

  // Memoize the promise, not the result: duplicates start concurrently and must share one lookup.
  const pending = new Map<string, Promise<ResolvedConcept>>();
  return Promise.all(ids.map((id, i) => {
    if (existing[i].exists) {
      return { conceptNode: id, matchedExisting: true, distance: 0, labelEmbedding: null };
    }
    if (!pending.has(id)) pending.set(id, matchNew(id));
    return pending.get(id)!;
  }));
}

/** Fields that let a new SMG node be found by later label matches. */
export function labelEmbeddingFields(labelEmbedding: number[] | null): Record<string, unknown> {
  if (!labelEmbedding) return {};
  return {
    labelEmbedding: FieldValue.vector(labelEmbedding),
    labelEmbeddingModel: currentEmbeddingModel(),
  };
}

/**
 * The student's most recently touched concept ids, offered to the classifier so it reuses
 * existing names instead of inventing near-duplicates.
 */
export async function listKnownConcepts(uid: string, limit = 40): Promise<string[]> {
  const snap = await smgCollection(uid).orderBy("lastInteractionAt", "desc").limit(limit).select().get();
  return snap.docs.map((d) => d.id);
}
