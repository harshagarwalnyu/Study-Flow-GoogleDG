# Evaluation

Measures the two ML decisions the server makes with fixed thresholds, against the live
embedding model:

| What | Env var | Metric |
|---|---|---|
| Which course chunks reach the prompt | `RAG_MAX_COSINE_DISTANCE` (0.6) | recall@1/3/5, MRR, relevant hits kept vs. noise passing the cutoff, off-topic leakage |
| When two concept labels become one SMG node | `CONCEPT_MATCH_MAX_DISTANCE` (0.15) | precision/recall per threshold; recommends the highest-recall threshold with precision ≥ 95% |

```bash
bun run --cwd server eval                    # needs GEMINI_API_KEY in server/.env
bun run --cwd server eval -- --json out.json # also write the full sweep
```

Retrieval runs in memory with the production chunker (`chunkText`) and embedding formats
(`embedDocuments`/`embedQuery`), so it tests what Firestore serves without needing Firestore.

## Fixtures are a seed, not a benchmark

`fixtures/` is **synthetic**: five short course-note documents, 26 on-topic questions,
4 off-topic probes, and 36 labelled concept pairs. It exists so the harness runs today and so
threshold changes are measured instead of guessed. Numbers from it say little about real
students. Replace it with:

1. Real course materials students have ingested (with permission), in `fixtures/corpus/`.
2. Real questions from the `events` log, each labelled with the chunk text that answers it.
3. Real `conceptNode` pairs from production SMGs, labelled same/different by a TA.

Precision matters more than recall for concept merging: a wrong merge mixes two concepts'
review history, while a missed merge only leaves a duplicate node.
