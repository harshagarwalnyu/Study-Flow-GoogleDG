import { describe, expect, it } from "vitest";
import { getErrorMessage } from "./error";

describe("getErrorMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(getErrorMessage("plain string")).toBe("plain string");
    expect(getErrorMessage(404)).toBe("404");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});
