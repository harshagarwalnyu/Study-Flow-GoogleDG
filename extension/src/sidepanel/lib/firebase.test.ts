import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { initializeAppMock, getAppsMock, getAuthMock } = vi.hoisted(() => ({
  initializeAppMock: vi.fn((config: unknown) => ({ name: "app", config })),
  getAppsMock: vi.fn(() => [] as unknown[]),
  getAuthMock: vi.fn((app: unknown) => ({ app })),
}));

vi.mock("firebase/app", () => ({
  initializeApp: initializeAppMock,
  getApps: getAppsMock,
}));

vi.mock("firebase/auth", () => ({
  getAuth: getAuthMock,
}));

const FULL_CONFIG_ENV = {
  VITE_FIREBASE_API_KEY: "key-123",
  VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "example-project",
};

// Explicitly empty rather than unset: the real process env (a dev's .env.local, CI's
// placeholders) would otherwise leak into the "missing config" cases.
function stubMissingConfig() {
  for (const key of Object.keys(FULL_CONFIG_ENV)) {
    vi.stubEnv(key, "");
  }
}

function stubFullConfig() {
  for (const [key, value] of Object.entries(FULL_CONFIG_ENV)) {
    vi.stubEnv(key, value);
  }
}

describe("sidepanel firebase config", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    initializeAppMock.mockClear();
    getAppsMock.mockClear();
    getAuthMock.mockClear();
    getAppsMock.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and leaves auth null when required config is missing, in dev mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("DEV", true);
    stubMissingConfig();

    const mod = await import("./firebase");

    expect(mod.hasFirebaseConfig).toBe(false);
    expect(mod.auth).toBeNull();
    expect(initializeAppMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "Firebase config is missing or invalid in the extension build.",
    );
  });

  it("stays silent when config is missing and not in dev mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("DEV", false);
    stubMissingConfig();

    const mod = await import("./firebase");

    expect(mod.hasFirebaseConfig).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('treats the literal strings "undefined"/"null" as missing config', async () => {
    vi.stubEnv("VITE_FIREBASE_API_KEY", "undefined");
    vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "null");
    vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "example-project");

    const mod = await import("./firebase");

    expect(mod.hasFirebaseConfig).toBe(false);
  });

  it("initializes a fresh Firebase app when full config is present and none exists yet", async () => {
    stubFullConfig();
    getAppsMock.mockReturnValue([]);

    const mod = await import("./firebase");

    expect(mod.hasFirebaseConfig).toBe(true);
    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(getAuthMock).toHaveBeenCalledTimes(1);
    expect(mod.auth).not.toBeNull();
  });

  it("reuses an already-initialized Firebase app instead of calling initializeApp again", async () => {
    stubFullConfig();
    const existingApp = { name: "existing" };
    getAppsMock.mockReturnValue([existingApp]);

    const mod = await import("./firebase");

    expect(mod.hasFirebaseConfig).toBe(true);
    expect(initializeAppMock).not.toHaveBeenCalled();
    expect(getAuthMock).toHaveBeenCalledWith(existingApp);
  });
});
