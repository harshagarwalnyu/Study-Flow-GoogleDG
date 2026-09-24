import { embedQuery, currentEmbeddingModel } from "./embeddings";
import { db } from "../db/firebase";
import { env } from "../env";
import { logger } from "../logger";

const TOP_K = 5;
// Over-fetch so dropping chunks embedded by a different model still leaves TOP_K candidates.
const CANDIDATE_MULTIPLIER = 2;

export interface RetrievedChunk {
  content: string;
  courseId: string;
  /** Cosine distance (0 = identical, 2 = opposite). */
  distance: number;
  filename?: string;
  chunkIndex?: number;
}

interface ChunkDoc {
  content?: string;
  embeddingModel?: string;
  metadata?: { filename?: string };
  chunkIndex?: number;
  _distance?: number;
}

async function nearestInCourse(
  uid: string,
  courseId: string,
  queryVector: number[],
  embeddingModel: string,
): Promise<{ chunks: RetrievedChunk[]; staleModelHits: number }> {
  const chunksRef = db.collection("users").doc(uid)
    .collection("courses").doc(courseId)
    .collection("chunks");

  const snap = await (chunksRef as any)
    .findNearest({
      vectorField: "embedding",
      queryVector,
      limit: TOP_K * CANDIDATE_MULTIPLIER,
      distanceMeasure: "COSINE",
      distanceResultField: "_distance",
      distanceThreshold: env.ragMaxCosineDistance,
    })
    .get();

  let staleModelHits = 0;
  const chunks: RetrievedChunk[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as ChunkDoc;
    if (!data.content) continue;
    // Vectors from another model live in an unrelated space; their distances are meaningless.
    if (data.embeddingModel !== embeddingModel) {
      staleModelHits++;
      continue;
    }
    chunks.push({
      content: data.content,
      courseId,
      distance: typeof data._distance === "number" ? data._distance : 0,
      filename: data.metadata?.filename,
      chunkIndex: data.chunkIndex,
    });
  }
  return { chunks, staleModelHits };
}

/**
 * Retrieve the top-K most relevant chunks, with source metadata, using Firestore vector search.
 * Without a courseId, every course is searched with its own indexed query and results are
 * merged by distance — no chunk collection is ever scanned in-process.
 */
export async function retrieveChunkRecords(uid: string, courseId: string | undefined, question: string): Promise<RetrievedChunk[]> {
  const queryVector = await embedQuery(question);
  const embeddingModel = currentEmbeddingModel();

  let courseIds: string[];
  if (courseId) {
    courseIds = [courseId];
  } else {
    const coursesSnap = await db.collection("users").doc(uid).collection("courses").select().get();
    courseIds = coursesSnap.docs.map((d) => d.id);
  }
  if (courseIds.length === 0) return [];

  const results = await Promise.all(
    courseIds.map((id) => nearestInCourse(uid, id, queryVector, embeddingModel)),
  );

  const staleModelHits = results.reduce((n, r) => n + r.staleModelHits, 0);
  if (staleModelHits > 0) {
    logger.warn(
      { uid, courseIds, staleModelHits, embeddingModel },
      "Skipped chunks embedded with a different model; run `bun run --cwd server reembed` to migrate them",
    );
  }

  return results
    .flatMap((r) => r.chunks)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, TOP_K);
}

/** Content-only view used by prompts that do not cite sources. */
export async function retrieveChunks(uid: string, courseId: string | undefined, question: string): Promise<string[]> {
  return (await retrieveChunkRecords(uid, courseId, question)).map((c) => c.content);
}
