import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseBoolean,
  parsePositiveInt,
  parsePositiveFloat,
  parseTrustProxy,
  parseRateLimitStore,
} from "./env";

describe("env utilities", () => {
  describe("parseBoolean", () => {
    it("returns fallback for null and undefined", () => {
      expect(parseBoolean(null, true)).toBe(true);
      expect(parseBoolean(undefined, false)).toBe(false);
    });

    it("parses truthy strings", () => {
      expect(parseBoolean("1", false)).toBe(true);
      expect(parseBoolean("true", false)).toBe(true);
      expect(parseBoolean("TRUE", false)).toBe(true);
      expect(parseBoolean("yes", false)).toBe(true);
      expect(parseBoolean("on", false)).toBe(true);
      expect(parseBoolean(" on ", false)).toBe(true);
    });

    it("parses falsy strings", () => {
      expect(parseBoolean("0", true)).toBe(false);
      expect(parseBoolean("false", true)).toBe(false);
      expect(parseBoolean("FALSE", true)).toBe(false);
      expect(parseBoolean("no", true)).toBe(false);
      expect(parseBoolean("off", true)).toBe(false);
      expect(parseBoolean(" off ", true)).toBe(false);
    });

    it("returns fallback for unrecognized strings", () => {
      expect(parseBoolean("random", true)).toBe(true);
      expect(parseBoolean("random", false)).toBe(false);
      expect(parseBoolean("", false)).toBe(false);
    });
  });

  describe("parsePositiveInt", () => {
    it("parses valid positive ints", () => {
      expect(parsePositiveInt("42", 10)).toBe(42);
      expect(parsePositiveInt(5, 10)).toBe(5);
    });

    it("returns fallback for zero, negative, NaN or null", () => {
      expect(parsePositiveInt("0", 10)).toBe(10);
      expect(parsePositiveInt("-5", 10)).toBe(10);
      expect(parsePositiveInt("abc", 10)).toBe(10);
      expect(parsePositiveInt(null, 10)).toBe(10);
      expect(parsePositiveInt(undefined, 10)).toBe(10);
    });
  });

  describe("parsePositiveFloat", () => {
    it("parses valid positive floats", () => {
      expect(parsePositiveFloat("0.75", 0.5)).toBe(0.75);
      expect(parsePositiveFloat(1.25, 0.5)).toBe(1.25);
    });

    it("returns fallback for zero, negative, NaN or null", () => {
      expect(parsePositiveFloat("0", 0.5)).toBe(0.5);
      expect(parsePositiveFloat("-0.5", 0.5)).toBe(0.5);
      expect(parsePositiveFloat("invalid", 0.5)).toBe(0.5);
      expect(parsePositiveFloat(null, 0.5)).toBe(0.5);
      expect(parsePositiveFloat(undefined, 0.5)).toBe(0.5);
    });
  });

  describe("parseTrustProxy", () => {
    it("returns false for null, undefined or empty strings", () => {
      expect(parseTrustProxy(null)).toBe(false);
      expect(parseTrustProxy(undefined)).toBe(false);
      expect(parseTrustProxy("")).toBe(false);
      expect(parseTrustProxy("   ")).toBe(false);
    });

    it("parses non-negative hop counts", () => {
      expect(parseTrustProxy("0")).toBe(0);
      expect(parseTrustProxy("1")).toBe(1);
      expect(parseTrustProxy("2")).toBe(2);
      expect(parseTrustProxy(3)).toBe(3);
    });

    it("falls back to boolean parsing for non-numeric or negative values", () => {
      expect(parseTrustProxy("true")).toBe(true);
      expect(parseTrustProxy("yes")).toBe(true);
      expect(parseTrustProxy("false")).toBe(false);
      expect(parseTrustProxy("-1")).toBe(false);
      expect(parseTrustProxy("invalid")).toBe(false);
    });
  });

  describe("parseRateLimitStore", () => {
    it("returns firestore when configured", () => {
      expect(parseRateLimitStore("firestore")).toBe("firestore");
      expect(parseRateLimitStore("FIRESTORE")).toBe("firestore");
      expect(parseRateLimitStore(" firestore ")).toBe("firestore");
    });

    it("defaults to memory for other values", () => {
      expect(parseRateLimitStore("memory")).toBe("memory");
      expect(parseRateLimitStore("")).toBe("memory");
      expect(parseRateLimitStore(null)).toBe("memory");
      expect(parseRateLimitStore(undefined)).toBe("memory");
      expect(parseRateLimitStore("redis")).toBe("memory");
    });
  });

  describe("env exported object", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("loads defaults and environment variables properly", async () => {
      vi.resetModules();
      vi.stubEnv("RAG_MAX_COSINE_DISTANCE", "0.45");
      vi.stubEnv("CONCEPT_MATCH_MAX_DISTANCE", "0.1");
      vi.stubEnv("GRAPHIFY_ENABLED", "false");
      vi.stubEnv("TRUST_PROXY", "2");
      vi.stubEnv("RATE_LIMIT_STORE", "firestore");
      vi.stubEnv("RATE_LIMIT_IP_PER_MINUTE", "60");
      vi.stubEnv("RATE_LIMIT_AI_PER_MINUTE", "10");

      const mod = await import("./env");
      expect(mod.env.ragMaxCosineDistance).toBe(0.45);
      expect(mod.env.conceptMatchMaxDistance).toBe(0.1);
      expect(mod.env.graphifyEnabled).toBe(false);
      expect(mod.env.trustProxy).toBe(2);
      expect(mod.env.rateLimitStore).toBe("firestore");
      expect(mod.env.rateLimitIpPerMinute).toBe(60);
      expect(mod.env.rateLimitAiPerMinute).toBe(10);
    });
  });
});
