import { describe, expect, it } from "vitest";
import { isExtensionRuntimeMessage, STORAGE_KEYS } from "./messages";

describe("isExtensionRuntimeMessage", () => {
  it("rejects non-object and null messages", () => {
    expect(isExtensionRuntimeMessage(null)).toBe(false);
    expect(isExtensionRuntimeMessage(undefined)).toBe(false);
    expect(isExtensionRuntimeMessage("INGEST_PAGE")).toBe(false);
    expect(isExtensionRuntimeMessage(42)).toBe(false);
  });

  it("rejects objects with an unknown or missing type", () => {
    expect(isExtensionRuntimeMessage({})).toBe(false);
    expect(isExtensionRuntimeMessage({ type: "NOT_A_REAL_TYPE" })).toBe(false);
  });

  it.each([
    "INGEST_PAGE",
    "INGEST_PDF",
    "OPEN_ASK",
    "OPEN_ASK_SCREENSHOT",
    "OPEN_QUIZ",
    "OPEN_QUIZ_SCREENSHOT",
  ])("accepts a %s message", (type) => {
    expect(isExtensionRuntimeMessage({ type })).toBe(true);
  });

  it("does not recognize REFRESH_DRILL_BADGE (internal-only, not from content scripts)", () => {
    expect(isExtensionRuntimeMessage({ type: "REFRESH_DRILL_BADGE" })).toBe(false);
  });

  it("exposes the storage key constants used across the extension", () => {
    expect(STORAGE_KEYS.firebaseIdToken).toBe("firebaseIdToken");
    expect(STORAGE_KEYS.apiUrl).toBe("apiUrl");
  });
});
