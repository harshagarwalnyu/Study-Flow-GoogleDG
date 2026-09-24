import { describe, it, expect } from "vitest";
import { getAiProvider, setAiProviderForTests } from "./index";
import { geminiProvider, type GeminiProvider } from "./geminiProvider";

describe("ai index provider registry", () => {
  it("defaults to geminiProvider and allows overriding for tests", () => {
    const defaultProvider = getAiProvider();
    expect(defaultProvider).toBe(geminiProvider);

    const mockProvider = {
      generateContent: () => Promise.resolve({ text: "mock" }),
    } as unknown as GeminiProvider;

    setAiProviderForTests(mockProvider);
    expect(getAiProvider()).toBe(mockProvider);

    // Reset back
    setAiProviderForTests(geminiProvider);
    expect(getAiProvider()).toBe(geminiProvider);
  });
});
