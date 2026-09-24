import { describe, it, expect, vi, afterEach } from "vitest";

describe("server entrypoint src/index.ts", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("starts listening on env.port and logs message", async () => {
    const listenMock = vi.fn((port: number, cb: () => void) => {
      if (cb) cb();
      return {} as any;
    });

    const infoMock = vi.fn();

    vi.doMock("./app", () => ({
      app: {
        listen: listenMock,
      },
    }));

    vi.doMock("./logger", () => ({
      logger: {
        info: infoMock,
      },
    }));

    vi.doMock("./env", () => ({
      env: {
        port: 3000,
      },
    }));

    await import("./index");

    expect(listenMock).toHaveBeenCalledWith(3000, expect.any(Function));
    expect(infoMock).toHaveBeenCalledWith({ port: 3000 }, "Server listening");
  });
});
