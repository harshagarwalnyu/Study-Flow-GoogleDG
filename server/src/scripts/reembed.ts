/**
 * Re-embed course chunks whose vectors came from a different (or unrecorded) embedding model.
 *
 *   bun run --cwd server reembed -- --dry-run         # count what would change
 *   bun run --cwd server reembed -- --uid <uid>       # one student
 *   bun run --cwd server reembed                      # everyone
 *
 * Safe to re-run: chunks already tagged with the current model are skipped, so an
 * interrupted run resumes where it stopped.
 */
import { FieldPath, FieldValue, type Firestore, type Query, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { embedDocuments, currentEmbeddingModel, EMBEDDING_DIM } from "../services/embeddings";

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
}

export async function reembedStaleChunks(db: Firestore, { uid, dryRun = false, log = () => {} }: ReembedOptions = {}): Promise<ReembedResult> {
  const model = currentEmbeddingModel();
  const result: ReembedResult = { scanned: 0, stale: 0, updated: 0 };

  const sources: Query[] = uid
    ? (await db.collection("users").doc(uid).collection("courses").select().get()).docs.map((c) => c.ref.collection("chunks"))
    : [db.collectionGroup("chunks")];

  for (const source of sources) {
    await reembedSource(source, model, dryRun, result, log);
  }

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

if (import.meta.main) {
  const { db } = await import("../db/firebase");
  const opts = parseArgs(process.argv.slice(2));
  const res = await reembedStaleChunks(db, { ...opts, log: (m) => console.log(m) });
  console.log(`${opts.dryRun ? "[dry run] " : ""}model=${currentEmbeddingModel()} scanned=${res.scanned} stale=${res.stale} updated=${res.updated}`);
}

export { parseArgs as _parseArgsForTests };
