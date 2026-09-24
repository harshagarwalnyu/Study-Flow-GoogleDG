import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMain } = vi.hoisted(() => ({ mockMain: vi.fn() }));
vi.mock("./reembed", () => ({ main: mockMain }));

describe("reembed cli entry", () => {
  beforeEach(() => {
    vi.resetModules();
    mockMain.mockReset();
  });

  it("passes the script arguments to main", async () => {
    mockMain.mockResolvedValue({});
    const argv = process.argv;
    process.argv = ["bun", "reembed-cli.ts", "--dry-run", "--uid", "u1"];
    try {
      await import("./reembed-cli");
    } finally {
      process.argv = argv;
    }
    expect(mockMain).toHaveBeenCalledWith(["--dry-run", "--uid", "u1"]);
  });

  it("prints the error and exits 1 when main fails", async () => {
    mockMain.mockRejectedValue(new Error("no key"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./reembed-cli");
    expect(err).toHaveBeenCalledWith("no key");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    err.mockRestore();
  });
});
