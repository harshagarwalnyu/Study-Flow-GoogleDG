import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Deterministic stand-in for the embedding model: hashed bag of words. Good enough to rank
// lexically-overlapping text, which is all these wiring tests need.
function bagOfWords(text: string): number[] {
  const v = new Array(256).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9^']+/g) || []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 256] += 1;
  }
  return v;
}

vi.mock("../services/embeddings", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(bagOfWords)),
    embedQuery: vi.fn(async (text: string) => bagOfWords(text)),
    embedLabels: vi.fn(async (labels: string[]) => labels.map((l) => bagOfWords(l.replace(/_/g, " ")))),
    currentEmbeddingModel: () => "fake-bow",
  };
});

import { loadCorpus, evaluateRetrieval, evaluateConceptPairs, missingMarkers, summarize, formatSummary } from "./run";

const FIXTURES = path.resolve(__dirname, "../../eval/fixtures");
const load = async (f: string) => JSON.parse(await readFile(path.join(FIXTURES, f), "utf-8"));

describe("eval runner", () => {
  it("every relevance marker in the fixture survives chunking intact", async () => {
    const corpus = await loadCorpus();
    const { cases } = await load("retrieval.json");
    expect(corpus.length).toBeGreaterThan(10);
    expect(missingMarkers(corpus, cases)).toEqual([]);
  });

  it("produces a complete summary end to end", async () => {
    const corpus = await loadCorpus();
    const { cases } = await load("retrieval.json");
    const { pairs } = await load("concept_pairs.json");

    const summary = summarize(
      await evaluateRetrieval(corpus, cases),
      cases,
      await evaluateConceptPairs(pairs),
      0.6,
      0.15,
    );

    expect(summary.model).toBe("fake-bow");
    expect(summary.retrieval.cases).toBe(cases.filter((c: any) => c.relevant.length > 0).length);
    // Even a lexical baseline should find most answers in a 5-document corpus.
    expect(summary.retrieval.recallAtK[5]).toBeGreaterThan(0.5);
    expect(summary.concepts.current.threshold).toBe(0.15);
    expect(summary.concepts.sweep.length).toBeGreaterThan(10);

    const text = formatSummary(summary);
    expect(text).toContain("recall@5");
    expect(text).toContain("CONCEPT_MATCH_MAX_DISTANCE=0.15");
  });

  it("flags markers that do not exist in the corpus", () => {
    const corpus = [{ title: "t", content: "alpha beta", vector: [] }];
    expect(missingMarkers(corpus, [{ id: "x", question: "q", relevant: ["alpha", "gamma"] }])).toEqual(['x: "gamma"']);
  });
});
