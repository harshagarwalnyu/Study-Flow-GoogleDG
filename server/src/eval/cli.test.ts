import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockMain } = vi.hoisted(() => ({ mockMain: vi.fn() }));
vi.mock("./run", () => ({ main: mockMain }));

describe("eval cli entry", () => {
  beforeEach(() => {
    vi.resetModules();
    mockMain.mockReset();
  });

  it("passes the script arguments to main", async () => {
    mockMain.mockResolvedValue({});
    const argv = process.argv;
    process.argv = ["bun", "cli.ts", "--json", "o.json"];
    try {
      await import("./cli");
    } finally {
      process.argv = argv;
    }
    expect(mockMain).toHaveBeenCalledWith(["--json", "o.json"]);
  });

  it("prints the error and exits 1 when main fails", async () => {
    mockMain.mockRejectedValue(new Error("no key"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await import("./cli");
    expect(err).toHaveBeenCalledWith("no key");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    err.mockRestore();
  });
});
