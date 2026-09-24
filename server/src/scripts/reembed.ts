/**
 * Re-embed course chunks whose vectors came from a different (or unrecorded) embedding model,
 * and backfill SMG concept-label vectors used to merge near-duplicate concepts.
 *
 *   bun run --cwd server reembed -- --dry-run         # count what would change
 *   bun run --cwd server reembed -- --uid <uid>       # one student
 *   bun run --cwd server reembed                      # everyone
 *
 * Safe to re-run: chunks already tagged with the current model are skipped, so an
 * interrupted run resumes where it stopped.
 */
import { FieldPath, FieldValue, type Firestore, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { embedDocuments, embedLabels, currentEmbeddingModel, EMBEDDING_DIM } from "../services/embeddings";

const PAGE_SIZE = 200;

export interface ReembedOptions {
  uid?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface ReembedResult {
  scanned: number;
  stale: number;
  updated: number;
  conceptsScanned: number;
  conceptsUpdated: number;
}

export async function reembedStaleChunks(db: Firestore, { uid, dryRun = false, log = () => {} }: ReembedOptions = {}): Promise<ReembedResult> {
  const model = currentEmbeddingModel();
  const result: ReembedResult = { scanned: 0, stale: 0, updated: 0, conceptsScanned: 0, conceptsUpdated: 0 };

  const sources: Query[] = uid
    ? (await db.collection("users").doc(uid).collection("courses").select().get()).docs.map((c) => c.ref.collection("chunks"))
    : [db.collectionGroup("chunks")];

  for (const source of sources) {
    await reembedSource(source, model, dryRun, result, log);
  }

  const conceptSource: Query = uid
    ? db.collection("users").doc(uid).collection("smg")
    : db.collectionGroup("smg");
  await backfillConceptLabels(conceptSource, model, dryRun, result);

  return result;
}

async function reembedSource(source: Query, model: string, dryRun: boolean, result: ReembedResult, log: (msg: string) => void) {
  const db = source.firestore;
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = source.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    cursor = page.docs[page.docs.length - 1];
    result.scanned += page.size;

    const stale = page.docs.filter((d) => d.get("embeddingModel") !== model && typeof d.get("content") === "string");
    result.stale += stale.length;
    if (stale.length === 0 || dryRun) continue;

    // Titles are part of the document embedding, so group by source file.
    const byTitle = new Map<string, QueryDocumentSnapshot[]>();
    for (const doc of stale) {
      const title = (doc.get("metadata.filename") as string | undefined) || "";
      byTitle.set(title, [...(byTitle.get(title) || []), doc]);
    }

    const batch = db.batch();
    for (const [title, docs] of byTitle) {
      const vectors = await embedDocuments(docs.map((d) => d.get("content") as string), title || undefined);
      docs.forEach((doc, i) => {
        batch.update(doc.ref, {
          embedding: FieldValue.vector(vectors[i]),
          embeddingModel: model,
          embeddingDim: EMBEDDING_DIM,
          reembeddedAt: FieldValue.serverTimestamp(),
        });
      });
    }
    await batch.commit();
    result.updated += stale.length;
    log(`re-embedded ${result.updated} chunk(s) so far (scanned ${result.scanned})`);
  }
}

async function backfillConceptLabels(source: Query, model: string, dryRun: boolean, result: ReembedResult) {
  const db = source.firestore;
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let query = source.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.empty) break;
    cursor = page.docs[page.docs.length - 1];
    result.conceptsScanned += page.size;

    const stale = page.docs.filter((d) => d.get("labelEmbeddingModel") !== model);
    if (stale.length === 0 || dryRun) continue;
    const vectors = await embedLabels(stale.map((d) => d.id));
    const batch = db.batch();
    stale.forEach((doc, i) => {
      batch.update(doc.ref, { labelEmbedding: FieldValue.vector(vectors[i]), labelEmbeddingModel: model });
    });
    await batch.commit();
    result.conceptsUpdated += stale.length;
  }
}

function parseArgs(argv: string[]): ReembedOptions {
  const opts: ReembedOptions = { dryRun: argv.includes("--dry-run") };
  const uidAt = argv.indexOf("--uid");
  if (uidAt !== -1) {
    const uid = argv[uidAt + 1];
    if (!uid || uid.startsWith("--")) throw new Error("--uid requires a value");
    opts.uid = uid;
  }
  return opts;
}

/** CLI entry (see reembed-cli.ts). */
export async function main(argv: string[], log: (line: string) => void = console.log): Promise<ReembedResult> {
  const { db } = await import("../db/firebase");
  const opts = parseArgs(argv);
  const res = await reembedStaleChunks(db, { ...opts, log });
  log(
    `${opts.dryRun ? "[dry run] " : ""}model=${currentEmbeddingModel()} chunks: scanned=${res.scanned} stale=${res.stale} updated=${res.updated}; ` +
    `concepts: scanned=${res.conceptsScanned} updated=${res.conceptsUpdated}`,
  );
  return res;
}

export { parseArgs, parseArgs as _parseArgsForTests };
