import { describe, it, expect, vi, beforeEach } from "vitest";

function bagOfWords(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) || []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
}

const { envState, fsState, mockWriteFile } = vi.hoisted(() => ({
  envState: { geminiApiKey: "test-key" as string | undefined },
  fsState: { retrievalOverride: null as string | null },
  mockWriteFile: vi.fn(async () => undefined),
}));

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
vi.mock("../env", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    env: new Proxy(actual.env, {
      get: (target, key) => (key === "geminiApiKey" ? envState.geminiApiKey : target[key]),
    }),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    writeFile: mockWriteFile,
    readFile: async (p: string, enc: any) =>
      fsState.retrievalOverride && String(p).endsWith("retrieval.json") ? fsState.retrievalOverride : actual.readFile(p, enc),
  };
});

import { main } from "./run";

describe("eval main", () => {
  beforeEach(() => {
    envState.geminiApiKey = "test-key";
    fsState.retrievalOverride = null;
    mockWriteFile.mockClear();
  });

  it("refuses to run without an API key", async () => {
    envState.geminiApiKey = undefined;
    await expect(main([], vi.fn())).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });

  it("rejects a fixture whose relevance marker is in no chunk", async () => {
    fsState.retrievalOverride = JSON.stringify({ cases: [{ id: "x", question: "q", relevant: ["no such marker zzz"] }] });
    await expect(main([], vi.fn())).rejects.toThrow(/Relevance markers not found[\s\S]*no such marker zzz/);
  });

  it("prints the summary and writes JSON only when --json has a path", async () => {
    const log = vi.fn();
    const summary = await main(["--json", "out.json"], log);
    expect(summary.model).toBe("fake-bow");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("recall@5");
    expect(mockWriteFile).toHaveBeenCalledWith("out.json", JSON.stringify(summary, null, 2));

    mockWriteFile.mockClear();
    await main(["--json"], vi.fn());
    await main([], vi.fn());
    expect(mockWriteFile).not.toHaveBeenCalled();
  }, 30_000);
});
