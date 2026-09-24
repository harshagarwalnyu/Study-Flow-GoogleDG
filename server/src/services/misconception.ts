import { db } from "../db/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { logger } from "../logger";
import { labelEmbeddingFields, resolveConceptNodes } from "./concepts";
import { embedLabels } from "./embeddings";
import { applyEvidence, newCard, drillPriority, type StoredCard } from "./scheduler";
import { GRAPH_FIELDS, toGraphNode, type GraphNodeView } from "./graphView";

interface InteractionParams {
  errorType: string;
  confidence: number;
  courseId?: string;
  /** true/false for graded answers; undefined for questions, which carry no correctness signal. */
  isCorrect?: boolean;
  /** Label vector for a node that does not exist yet (from resolveConceptNode). */
  labelEmbedding?: number[] | null;
}

interface SmgNode {
  interactionCount?: number;
  reviewIntervalDays?: number;
  fsrs?: StoredCard | Record<string, any>;
  correctCount?: number;
  incorrectCount?: number;
  accuracyRate?: number;
  errorTypeMap?: Record<string, number>;
  courseId?: string | null;
  nextReviewDate?: Date | any;
  lastErrorAt?: any;
}

/**
 * Record a student interaction and update the SMG node's FSRS schedule and statistics.
 * Updates users/{uid}/smg/{conceptNode} inside a transaction: a background question and a
 * quiz answer on the same concept can land together, and a plain read-then-write would let
 * one silently overwrite the other's counts and schedule.
 *
 * @param {boolean} [params.isCorrect] true/false for graded answers; undefined for questions
 */
export async function recordInteraction(uid: string, conceptNode: string, { errorType, confidence, courseId, isCorrect, labelEmbedding = null }: InteractionParams): Promise<void> {
  const userRef = db.collection("users").doc(uid);
  const smgRef = userRef.collection("smg").doc(conceptNode);
  const statsRef = userRef.collection("gamification").doc("stats");

  // Embedding is a network call, so never do it inside the transaction (which may retry).
  const existing = await smgRef.get();
  const vector = existing.exists ? null : labelEmbedding ?? (await embedLabels([conceptNode]))[0];

  const outcome = await db.runTransaction(async (txn) => {
    const doc = await txn.get(smgRef);
    const now = new Date();
    const evidence = { isCorrect, errorType, confidence };

    if (doc.exists) {
      const data = doc.data() as SmgNode;
      const { card } = applyEvidence((data.fsrs as Record<string, any>) ?? null, evidence, now, data.nextReviewDate);

      const correctCount = (data.correctCount || 0) + (isCorrect === true ? 1 : 0);
      const incorrectCount = (data.incorrectCount || 0) + (isCorrect === false ? 1 : 0);
      const totalAnswered = correctCount + incorrectCount;
      const accuracyRate = totalAnswered > 0 ? correctCount / totalAnswered : (data.accuracyRate ?? 0);

      const errorTypeMap = { ...(data.errorTypeMap || {}) };
      if (errorType && errorType !== "none") {
        errorTypeMap[errorType] = (errorTypeMap[errorType] || 0) + 1;
      }

      txn.update(smgRef, {
        accuracyRate,
        correctCount,
        incorrectCount,
        errorTypeMap,
        interactionCount: (data.interactionCount || 0) + 1,
        fsrs: card,
        reviewIntervalDays: card.scheduledDays,
        nextReviewDate: card.due,
        lastInteractionAt: FieldValue.serverTimestamp(),
        lastErrorAt: isCorrect === false ? FieldValue.serverTimestamp() : (data.lastErrorAt || null),
        courseId: courseId || data.courseId || null,
        isInitializedOnly: false,
      });
      return { created: false, accuracyRate, answered: totalAnswered > 0 };
    }

    const { card } = applyEvidence(null, evidence, now);
    const accuracyRate = isCorrect === undefined ? 0 : isCorrect ? 1 : 0;
    txn.set(smgRef, {
      courseId: courseId || null,
      accuracyRate,
      correctCount: isCorrect === true ? 1 : 0,
      incorrectCount: isCorrect === false ? 1 : 0,
      errorTypeMap: errorType && errorType !== "none" ? { [errorType]: 1 } : {},
      interactionCount: 1,
      fsrs: card,
      reviewIntervalDays: card.scheduledDays,
      nextReviewDate: card.due,
      lastInteractionAt: FieldValue.serverTimestamp(),
      lastErrorAt: isCorrect === false ? FieldValue.serverTimestamp() : null,
      ...labelEmbeddingFields(vector),
    });
    return { created: true, accuracyRate, answered: isCorrect !== undefined };
  });

  // Gamification stats are best-effort and must not fail the interaction.
  if (outcome.created) {
    const updates: Record<string, unknown> = { conceptCount: FieldValue.increment(1) };
    if (outcome.answered && outcome.accuracyRate >= 0.9) updates.maxAccuracy = outcome.accuracyRate;
    statsRef.set(updates, { merge: true })
      .catch((err: any) => logger.warn({ err: err instanceof Error ? err.message : err, uid, conceptNode }, "gamification stat sync failed"));
  } else if (outcome.answered && outcome.accuracyRate >= 0.9) {
    db.runTransaction(async (txn) => {
      const snap = await txn.get(statsRef);
      const current = snap.exists ? ((snap.data() as any).maxAccuracy ?? 0) : 0;
      if (outcome.accuracyRate > current) txn.set(statsRef, { maxAccuracy: outcome.accuracyRate }, { merge: true });
    }).catch((err: any) => logger.warn({ err: err instanceof Error ? err.message : err, uid, conceptNode }, "gamification stat sync failed"));
  }
}

/**
 * Get the student's weakest concepts, ordered by lowest accuracy and nearest review date.
 * Used to weight quiz generation toward areas of weakness.
 *
 * @param {string} uid
 * @param {number} limit
 * @returns {Promise<Array<any>>}
 */
export async function getWeakestConcepts(uid: string, limit: number = 10): Promise<any[]> {
  const smgRef = db.collection("users").doc(uid).collection("smg");

  // Get concepts due for review (nextReviewDate <= now)
  const now = new Date();
  const snap = await smgRef
    .where("nextReviewDate", "<=", now)
    .orderBy("nextReviewDate", "asc")
    .limit(limit)
    .get();

  if (snap.empty) {
    // Fall back to lowest accuracy concepts
    const fallback = await smgRef
      .orderBy("accuracyRate", "asc")
      .limit(limit)
      .get();
    return fallback.docs.map((doc) => ({ conceptNode: doc.id, ...doc.data() }));
  }

  return snap.docs.map((doc) => ({ conceptNode: doc.id, ...doc.data() }));
}

/**
 * Get the full SMG graph for a user (all concept nodes), projected to the fields the client uses.
 */
export async function getGraph(uid: string): Promise<GraphNodeView[]> {
  const snap = await db.collection("users").doc(uid).collection("smg").select(...GRAPH_FIELDS).get();
  const now = new Date();
  return snap.docs.map((doc) => toGraphNode(doc.id, doc.data(), now));
}


/**
 * Get the spaced repetition drill queue — concepts due for review,
 * weighted by accuracy rate and urgency.
 *
 * @param {string} uid
 * @param {number} limit
 * @returns {Promise<Array<any>>}
 */
export async function getDrillQueue(uid: string, limit: number = 20): Promise<any[]> {
  const smgRef = db.collection("users").doc(uid).collection("smg");
  const now = new Date();
  const lookahead = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const snap = await smgRef
    .where("nextReviewDate", "<=", lookahead)
    .orderBy("nextReviewDate", "asc")
    .limit(limit * 5)
    .get();

  const items = snap.docs.map((doc) => {
    const data = doc.data() as SmgNode;
    const { urgency, due, retrievability: recall } = drillPriority(data as any, now);
    return {
      conceptNode: doc.id,
      accuracyRate: data.accuracyRate || 0,
      nextReviewDate: (data.nextReviewDate as any)?.toDate?.() || data.nextReviewDate || now,
      interactionCount: data.interactionCount || 0,
      urgency,
      due,
      ...(recall !== undefined ? { retrievability: recall } : {}),
    };
  });

  items.sort((a, b) => b.urgency - a.urgency);
  return items.slice(0, limit);
}

/**
 * Initialize a set of concepts in the SMG with default values if they don't exist.
 * This pre-populates the Knowledge Graph after ingestion. Discovered labels go through the
 * same resolution as classifier labels, so ingestion cannot create near-duplicate nodes.
 *
 * @param {string} uid
 * @param {string[]} concepts
 * @param {string} courseId
 */
export async function initializeConcepts(uid: string, concepts: string[], courseId: string): Promise<void> {
  if (concepts.length === 0) return;
  const resolved = await resolveConceptNodes(uid, concepts);

  const batch = db.batch();
  const seen = new Set<string>();
  for (const concept of resolved) {
    if (concept.matchedExisting || seen.has(concept.conceptNode)) continue;
    seen.add(concept.conceptNode);
    batch.set(db.collection("users").doc(uid).collection("smg").doc(concept.conceptNode), {
      courseId,
      accuracyRate: 1.0, // Start with "perfect" (untested)
      correctCount: 0,
      incorrectCount: 0,
      errorTypeMap: {},
      interactionCount: 0,
      fsrs: newCard(new Date()),
      reviewIntervalDays: 0,
      nextReviewDate: new Date(),
      lastInteractionAt: FieldValue.serverTimestamp(),
      lastErrorAt: null,
      isInitializedOnly: true, // Marker for tracking
      ...labelEmbeddingFields(concept.labelEmbedding),
    });
  }

  if (seen.size > 0) {
    await batch.commit();
  }
}

export interface StudentProfile {
  weakConcepts: string[];
  errorTypeMap: Record<string, number>;
}

/**
 * Summarize the student's current weak spots for prompt personalization. Runs before the
 * question is classified, so it describes the student overall rather than one concept.
 */
export async function getStudentProfile(uid: string, limit = 5): Promise<StudentProfile | null> {
  const weakest = await getWeakestConcepts(uid, limit);
  if (weakest.length === 0) return null;
  const errorTypeMap: Record<string, number> = {};
  for (const node of weakest) {
    for (const [type, count] of Object.entries((node.errorTypeMap || {}) as Record<string, number>)) {
      errorTypeMap[type] = (errorTypeMap[type] || 0) + count;
    }
  }
  return { weakConcepts: weakest.map((n) => n.conceptNode), errorTypeMap };
}
