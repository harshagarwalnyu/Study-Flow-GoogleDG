/**
 * Offline evaluation of retrieval and concept merging against the live embedding model.
 *
 *   bun run --cwd server eval                 # uses GEMINI_API_KEY from server/.env
 *   bun run --cwd server eval -- --json out.json
 *
 * Retrieval runs in memory over eval/fixtures/corpus with the production chunker and
 * embedding formats, so it measures the same pipeline Firestore serves, minus Firestore.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkText } from "../services/ingestion";
import { embedDocuments, embedQuery, embedLabels, cosineSimilarity, currentEmbeddingModel } from "../services/embeddings";
import { env } from "../env";
import {
  retrievalReport,
  thresholdSweep,
  pickThreshold,
  type RetrievalCaseResult,
  type LabeledPair,
  type RetrievalReport,
  type ThresholdPoint,
} from "./metrics";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../eval/fixtures");
const KS = [1, 3, 5];
const TOP = Math.max(...KS);

interface RetrievalCase { id: string; question: string; relevant: string[] }
interface ConceptPair { a: string; b: string; same: boolean }

export interface CorpusChunk { title: string; content: string; vector: number[] }

export async function loadCorpus(dir = path.join(FIXTURES, "corpus")): Promise<CorpusChunk[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  const chunks: CorpusChunk[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf-8");
    const pieces = chunkText(text);
    const vectors = await embedDocuments(pieces, file);
    pieces.forEach((content, i) => chunks.push({ title: file, content, vector: vectors[i] }));
  }
  return chunks;
}

export async function evaluateRetrieval(corpus: CorpusChunk[], cases: RetrievalCase[]): Promise<RetrievalCaseResult[]> {
  const results: RetrievalCaseResult[] = [];
  for (const c of cases) {
    const q = await embedQuery(c.question);
    const ranked = corpus
      .map((chunk) => ({
        distance: 1 - cosineSimilarity(q, chunk.vector),
        relevant: c.relevant.some((marker) => chunk.content.includes(marker)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, TOP);
    results.push({ id: c.id, ranked });
  }
  return results;
}

export async function evaluateConceptPairs(pairs: ConceptPair[]): Promise<LabeledPair[]> {
  const labels = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const vectors = await embedLabels(labels);
  const byLabel = new Map(labels.map((l, i) => [l, vectors[i]]));
  return pairs.map((p) => ({ ...p, distance: 1 - cosineSimilarity(byLabel.get(p.a)!, byLabel.get(p.b)!) }));
}

/** Sanity check that every relevance marker exists in the corpus; a typo would silently lower recall. */
export function missingMarkers(corpus: CorpusChunk[], cases: RetrievalCase[]): string[] {
  return cases.flatMap((c) =>
    c.relevant.filter((m) => !corpus.some((chunk) => chunk.content.includes(m))).map((m) => `${c.id}: "${m}"`),
  );
}

export interface EvalSummary {
  model: string;
  retrieval: RetrievalReport & { threshold: number; offTopicPassing: number };
  concepts: { threshold: number; current: ThresholdPoint; recommended: ThresholdPoint | null; sweep: ThresholdPoint[] };
  misses: string[];
}

export function summarize(
  results: RetrievalCaseResult[],
  cases: RetrievalCase[],
  pairs: LabeledPair[],
  ragThreshold: number,
  conceptThreshold: number,
): EvalSummary {
  const onTopic = results.filter((r) => cases.find((c) => c.id === r.id)!.relevant.length > 0);
  const offTopic = results.filter((r) => cases.find((c) => c.id === r.id)!.relevant.length === 0);
  const offTopicPassing = offTopic.length
    ? offTopic.filter((r) => r.ranked.some((h) => h.distance <= ragThreshold)).length / offTopic.length
    : 0;

  const grid = Array.from({ length: 30 }, (_, i) => Math.round((0.02 + i * 0.02) * 100) / 100);
  if (!grid.includes(conceptThreshold)) grid.push(conceptThreshold);
  grid.sort((a, b) => a - b);
  const sweep = thresholdSweep(pairs, grid);

  return {
    model: currentEmbeddingModel(),
    retrieval: { ...retrievalReport(onTopic, KS, ragThreshold), threshold: ragThreshold, offTopicPassing },
    concepts: {
      threshold: conceptThreshold,
      current: sweep.find((p) => p.threshold === conceptThreshold)!,
      recommended: pickThreshold(sweep),
      sweep,
    },
    misses: onTopic.filter((r) => !r.ranked.slice(0, 5).some((h) => h.relevant)).map((r) => r.id),
  };
}

function pct(x: number) {
  return `${(x * 100).toFixed(1)}%`;
}

export function formatSummary(s: EvalSummary): string {
  const r = s.retrieval;
  const c = s.concepts;
  return [
    `Embedding model: ${s.model}`,
    "",
    `Retrieval (${r.cases} on-topic questions)`,
    `  recall@1 ${pct(r.recallAtK[1])}  recall@3 ${pct(r.recallAtK[3])}  recall@5 ${pct(r.recallAtK[5])}  MRR ${r.mrr.toFixed(3)}`,
    `  at RAG_MAX_COSINE_DISTANCE=${r.threshold}: relevant kept ${pct(r.relevantKeptAtThreshold)}, ` +
      `irrelevant top-5 hits passing ${pct(r.irrelevantPassingAtThreshold)}, off-topic questions leaking context ${pct(r.offTopicPassing)}`,
    s.misses.length ? `  missed@5: ${s.misses.join(", ")}` : "  missed@5: none",
    "",
    "Concept merging",
    `  at CONCEPT_MATCH_MAX_DISTANCE=${c.threshold}: precision ${pct(c.current.precision)}, recall ${pct(c.current.recall)}`,
    c.recommended
      ? `  recommended ${c.recommended.threshold}: precision ${pct(c.recommended.precision)}, recall ${pct(c.recommended.recall)}`
      : "  recommended: n/a",
  ].join("\n");
}

/** CLI entry (see cli.ts). Throws on misconfiguration instead of exiting, so it can be tested. */
export async function main(argv: string[], log: (line: string) => void = console.log): Promise<EvalSummary> {
  if (!env.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set (server/.env). The eval calls the live embedding API.");
  }
  const { cases } = JSON.parse(await readFile(path.join(FIXTURES, "retrieval.json"), "utf-8")) as { cases: RetrievalCase[] };
  const { pairs } = JSON.parse(await readFile(path.join(FIXTURES, "concept_pairs.json"), "utf-8")) as { pairs: ConceptPair[] };

  const corpus = await loadCorpus();
  const missing = missingMarkers(corpus, cases);
  if (missing.length) {
    throw new Error(`Relevance markers not found in any chunk (fix the fixture):\n  ${missing.join("\n  ")}`);
  }

  const summary = summarize(
    await evaluateRetrieval(corpus, cases),
    cases,
    await evaluateConceptPairs(pairs),
    env.ragMaxCosineDistance,
    env.conceptMatchMaxDistance,
  );
  log(formatSummary(summary));

  const jsonAt = argv.indexOf("--json");
  if (jsonAt !== -1 && argv[jsonAt + 1]) {
    await writeFile(argv[jsonAt + 1], JSON.stringify(summary, null, 2));
  }
  return summary;
}
