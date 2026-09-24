import { describe, it, expect } from "vitest";
import { chunkText, TARGET_CHUNK_CHARS, MAX_CHUNK_CHARS } from "./chunking";

const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ") + ".";

describe("chunkText", () => {
  it("returns nothing for empty or whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n \n")).toEqual([]);
  });

  it("keeps a short document as one chunk", () => {
    expect(chunkText("The derivative measures rate of change.")).toEqual(["The derivative measures rate of change."]);
  });

  it("prefixes chunks with their markdown heading path", () => {
    const text = "# Week 3\n\n## The Chain Rule\n\nDifferentiate the outer function, then the inner.\n";
    expect(chunkText(text)).toEqual(["Week 3 > The Chain Rule\nDifferentiate the outer function, then the inner."]);
  });

  it("starts a new chunk at each section so topics never mix", () => {
    const text = "## Product Rule\n\n(fg)' = f'g + fg'.\n\n## Quotient Rule\n\n(f/g)' = (f'g - fg')/g^2.";
    expect(chunkText(text)).toEqual([
      "Product Rule\n(fg)' = f'g + fg'.",
      "Quotient Rule\n(f/g)' = (f'g - fg')/g^2.",
    ]);
  });

  it("pops back up the heading stack for sibling and parent sections", () => {
    const text = "# A\n## A1\nx.\n## A2\ny.\n# B\nz.";
    expect(chunkText(text)).toEqual(["A > A1\nx.", "A > A2\ny.", "B\nz."]);
  });

  it("recognizes headings from PDF-extracted notes without markdown", () => {
    const text = [
      "# Lecture Notes",
      "Theorem 2.1 (Mean Value Theorem)",
      "If f is continuous on [a,b] and differentiable on (a,b), some c has f'(c) = (f(b)-f(a))/(b-a).",
      "",
      "Example 3: Applying the MVT",
      "Take f(x) = x^2 on [0, 2].",
    ].join("\n");
    expect(chunkText(text)).toEqual([
      "Lecture Notes > Theorem 2.1 (Mean Value Theorem)\nIf f is continuous on [a,b] and differentiable on (a,b), some c has f'(c) = (f(b)-f(a))/(b-a).",
      "Lecture Notes > Example 3: Applying the MVT\nTake f(x) = x^2 on [0, 2].",
    ]);
  });

  it("does not treat sentences that merely start with a keyword or number as headings", () => {
    const text = "Example problems are at the end of the chapter.\n3.14 is roughly pi\nDefinitions follow below.";
    expect(chunkText(text)).toHaveLength(1);
    expect(chunkText(text)[0].startsWith("Example problems")).toBe(true);
  });

  it("packs whole paragraphs up to the target size", () => {
    const para = words(20); // ~150 chars
    const text = Array.from({ length: 12 }, () => para).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TARGET_CHUNK_CHARS);
      // No paragraph is ever split across chunks.
      expect(c.split("\n").every((p) => p === para)).toBe(true);
    }
  });

  it("splits a single over-long paragraph at sentence boundaries within the max size", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something about limits.`);
    const chunks = chunkText(sentences.join(" "));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(c).toMatch(/\.$/);
    }
  });

  it("hard-cuts unbroken text that has no sentence boundaries", () => {
    const chunks = chunkText("x".repeat(4000));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.length <= MAX_CHUNK_CHARS)).toBe(true);
    expect(chunks.join("")).toBe("x".repeat(4000));
  });

  it("preserves every word of the source", () => {
    const text = "# T\n\n" + Array.from({ length: 30 }, (_, i) => words(15, `p${i}w`)).join("\n\n");
    const out = chunkText(text).join(" ");
    for (const w of text.replace(/^# T/, "").match(/p\d+w\d+/g)!) expect(out).toContain(w);
  });

  it("normalizes Windows line endings", () => {
    expect(chunkText("## H\r\n\r\nbody.")).toEqual(["H\nbody."]);
  });
});
