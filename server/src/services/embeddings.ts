import { getAiProvider } from "../ai/index";

export const EMBEDDING_DIM = 768;

/**
 * The concrete embedding model id. Stored on every chunk so retrieval never compares
 * vectors from different models (their spaces are unrelated even at equal dimension).
 */
export function currentEmbeddingModel(): string {
  return getAiProvider().resolveModelName("embedding");
}

/**
 * gemini-embedding-2 has no task_type parameter; asymmetric retrieval is expressed with
 * text prefixes, and queries and documents must use the paired formats consistently.
 * https://ai.google.dev/gemini-api/docs/embeddings (verified 2026-09-24)
 */
export function formatQuery(text: string): string {
  return `task: question answering | query: ${text}`;
}

export function formatDocument(text: string, title?: string): string {
  const cleanTitle = (title || "").replace(/\s+/g, " ").trim() || "none";
  return `title: ${cleanTitle} | text: ${text}`;
}

/** Embed a student question for retrieval against course chunks. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await getAiProvider().embedContent({
    contents: formatQuery(text),
    outputDimensionality: EMBEDDING_DIM,
  });
  return vector;
}

/** Embed course-material chunks; returns one vector per input, in order. */
export async function embedDocuments(texts: string[], title?: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  return getAiProvider().embedContent({
    contents: texts.map((t) => formatDocument(t, title)),
    outputDimensionality: EMBEDDING_DIM,
  });
}

/** Embed short labels (e.g. concept names) symmetrically for similarity matching. */
export async function embedLabels(labels: string[]): Promise<number[][]> {
  if (labels.length === 0) return [];
  return getAiProvider().embedContent({
    contents: labels.map((l) => `task: clustering | query: ${l.replace(/_/g, " ")}`),
    outputDimensionality: EMBEDDING_DIM,
  });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}
