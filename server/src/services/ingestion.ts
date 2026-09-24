import { embedDocuments, currentEmbeddingModel, EMBEDDING_DIM } from "./embeddings";
import { extractText, extractTextFromPDF } from "./ocr";
import { db } from "../db/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { discoverConcepts } from "./gemini";
import { initializeConcepts } from "./misconception";

export { chunkText } from "./chunking";
import { chunkText } from "./chunking";

const DEFAULT_CAPTURE_NAME = "content-script-capture";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Identity of an ingested source. Re-ingesting the same named file replaces its chunks;
 * unnamed page captures are keyed by content so identical captures are not duplicated
 * and distinct captures never overwrite each other.
 */
export function sourceKeyFor(text: string, filename?: string): string {
  if (filename && filename !== DEFAULT_CAPTURE_NAME) return `file:${filename}`;
  return `hash:${sha256(text)}`;
}

interface IngestMetadata {
  source?: string;
  page?: number;
  week?: number;
  filename?: string;
}

const WRITE_BATCH_LIMIT = 400;

/**
 * Ingest a plain-text string: chunk it, embed all chunks, and store in Firestore.
 * Chunks are stored at users/{uid}/courses/{courseId}/chunks/{auto-id}.
 * Prior chunks from the same source are deleted so re-ingesting never duplicates.
 *
 * @returns number of chunks written
 */
export async function ingestText(uid: string, courseId: string, text: string, metadata: IngestMetadata = {}): Promise<number> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;

  const sourceKey = sourceKeyFor(text, metadata.filename);
  // Embed before touching Firestore: a failed embedding call must not leave the source half-replaced.
  const vectors = await embedDocuments(chunks, metadata.filename);
  const embeddingModel = currentEmbeddingModel();

  const courseRef = db.collection("users").doc(uid).collection("courses").doc(courseId);
  const chunksRef = courseRef.collection("chunks");

  const stale = await chunksRef.where("sourceKey", "==", sourceKey).get();

  let batch = db.batch();
  let batchCount = 0;
  const flushIfFull = async () => {
    if (++batchCount >= WRITE_BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  };

  for (const doc of stale.docs) {
    batch.delete(doc.ref);
    await flushIfFull();
  }

  for (let i = 0; i < chunks.length; i++) {
    batch.set(chunksRef.doc(), {
      content: chunks[i],
      embedding: FieldValue.vector(vectors[i]),
      embeddingModel,
      embeddingDim: EMBEDDING_DIM,
      sourceKey,
      metadata,
      chunkIndex: i,
      createdAt: FieldValue.serverTimestamp(),
    });
    await flushIfFull();
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  // Ensure course doc exists so it shows up in the courses list
  await courseRef.set({
    lastIngestedAt: FieldValue.serverTimestamp(),
    platform: metadata.source || "content-script",
  }, { merge: true });

  return chunks.length;
}

/**
 * Upsert the file record shown in the course view (routes/course.ts lists these).
 * Keyed by courseId+filename so a re-upload updates the record instead of adding one.
 */
export async function recordIngestedFile(
  uid: string,
  courseId: string,
  { filename, sourcePlatform, contentHash, chunkCount }: { filename: string; sourcePlatform: string; contentHash: string; chunkCount: number },
): Promise<void> {
  const fileId = sha256(`${courseId}:${filename}`);
  await db.collection("users").doc(uid)
    .collection("courses").doc(courseId)
    .collection("files").doc(fileId)
    .set({
      filename,
      sourcePlatform,
      contentHash,
      chunkCount,
      uploadedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
}

/**
 * Read a file from disk, extract text, then ingest via chunking + embedding.
 *
 * Files are not uploaded to the Gemini File API: those uploads expire after 48 hours and
 * no prompt ever consumed the stored URIs, so the upload only added latency and a failure mode.
 */
export async function ingestFile(uid: string, courseId: string, filePath: string, filename: string, sourcePlatform: string = "upload"): Promise<void> {
  const ext = path.extname(filename).toLowerCase();
  let text: string;

  if (ext === ".pdf") {
    text = await extractTextFromPDF(filePath);
  } else if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"].includes(ext)) {
    text = await extractText(filePath);
  } else {
    text = await readFile(filePath, "utf-8");
  }

  const [{ concepts }, chunkCount] = await Promise.all([
    discoverConcepts(text),
    ingestText(uid, courseId, text, { filename, source: sourcePlatform }),
  ]);

  await Promise.all([
    recordIngestedFile(uid, courseId, { filename, sourcePlatform, contentHash: sha256(text), chunkCount }),
    initializeConcepts(uid, concepts, courseId),
  ]);
}
