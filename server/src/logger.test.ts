import { describe, it, expect, vi, afterEach } from "vitest";

describe("logger", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("configures pretty transport in development mode with custom LOG_LEVEL", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOG_LEVEL", "debug");

    const pinoMock = vi.fn((opts) => opts);
    vi.doMock("pino", () => ({ default: pinoMock }));

    const { logger } = await import("./logger");
    expect(pinoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "debug",
        transport: expect.objectContaining({
          target: "pino-pretty",
        }),
      })
    );
    expect(logger).toBeDefined();
  });

  it("configures pretty transport in development mode with default info level", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.LOG_LEVEL;

    const pinoMock = vi.fn((opts) => opts);
    vi.doMock("pino", () => ({ default: pinoMock }));

    await import("./logger");
    expect(pinoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        transport: expect.objectContaining({
          target: "pino-pretty",
        }),
      })
    );
  });

  it("configures standard logging in production mode with custom LOG_LEVEL", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LOG_LEVEL", "warn");

    const pinoMock = vi.fn((opts) => opts);
    vi.doMock("pino", () => ({ default: pinoMock }));

    await import("./logger");
    expect(pinoMock).toHaveBeenCalledWith({
      level: "warn",
    });
  });

  it("configures standard logging in production mode with default info level", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.LOG_LEVEL;

    const pinoMock = vi.fn((opts) => opts);
    vi.doMock("pino", () => ({ default: pinoMock }));

    await import("./logger");
    expect(pinoMock).toHaveBeenCalledWith({
      level: "info",
    });
  });
});
