import { describe, expect, it } from "vitest";
import { httpError } from "./errors";

describe("httpError", () => {
  it("creates an Error with the given message and status", () => {
    const err = httpError(404, "not found");

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("not found");
    expect(err.status).toBe(404);
    expect(err.details).toBeUndefined();
  });

  it("attaches details when provided", () => {
    const details = [{ field: "email", issue: "required" }];
    const err = httpError(400, "validation failed", details);

    expect(err.status).toBe(400);
    expect(err.details).toBe(details);
  });

  it("does not set details when details argument is omitted", () => {
    const err = httpError(500, "boom");

    expect("details" in err ? err.details : undefined).toBeUndefined();
  });
});
