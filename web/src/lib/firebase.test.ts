import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";

const initializeApp = vi.fn(() => ({ name: "mock-app" }));
const getApps = vi.fn(() => [] as unknown[]);
const getAuth = vi.fn(() => ({ currentUser: null }));
const signOut = vi.fn().mockResolvedValue(undefined);

vi.mock("firebase/app", () => ({
  initializeApp,
  getApps,
}));

vi.mock("firebase/auth", () => ({
  getAuth,
  signOut,
}));

const REQUIRED_ENV = {
  VITE_FIREBASE_API_KEY: "test-api-key",
  VITE_FIREBASE_AUTH_DOMAIN: "test.firebaseapp.com",
  VITE_FIREBASE_PROJECT_ID: "test-project",
};

function stubFirebaseConfigEnv() {
  Object.entries(REQUIRED_ENV).forEach(([key, value]) => {
    vi.stubEnv(key, value);
  });
}

function stubMissingFirebaseConfigEnv() {
  vi.stubEnv("VITE_FIREBASE_API_KEY", "");
  vi.stubEnv("VITE_FIREBASE_AUTH_DOMAIN", "");
  vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "");
}

describe("lib/firebase", () => {
  // The first import transforms @study-flow/client and @study-flow/shared from TS source, which
  // can exceed the 5s test timeout on a loaded machine. Pay it once here; each test still
  // re-evaluates the module after vi.resetModules().
  beforeAll(async () => {
    await import("./firebase");
  }, 30_000);

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    initializeApp.mockReturnValue({ name: "mock-app" });
    getApps.mockReturnValue([]);
    getAuth.mockReturnValue({ currentUser: null });
    signOut.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves clientMode to 'test' when import.meta.env.MODE is 'test'", async () => {
    vi.stubEnv("MODE", "test");
    vi.stubEnv("PROD", true);

    const { clientMode } = await import("./firebase");

    expect(clientMode).toBe("test");
  });

  it("resolves clientMode to 'production' when MODE isn't 'test' and PROD is true", async () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("PROD", true);

    const { clientMode } = await import("./firebase");

    expect(clientMode).toBe("production");
  });

  it("resolves clientMode to 'development' when MODE isn't 'test' and PROD is false", async () => {
    vi.stubEnv("MODE", "development");
    vi.stubEnv("PROD", false);

    const { clientMode } = await import("./firebase");

    expect(clientMode).toBe("development");
  });

  it("exposes a null auth and hasFirebaseConfig=false when Firebase env vars are missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubMissingFirebaseConfigEnv();

    const { auth, hasFirebaseConfig } = await import("./firebase");

    expect(hasFirebaseConfig).toBe(false);
    expect(auth).toBeNull();
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it("initializes Firebase and exposes a real auth instance when config env vars are present", async () => {
    stubFirebaseConfigEnv();

    const fakeAuthInstance = { currentUser: null };
    getAuth.mockReturnValue(fakeAuthInstance);

    const { auth, hasFirebaseConfig } = await import("./firebase");

    expect(hasFirebaseConfig).toBe(true);
    expect(initializeApp).toHaveBeenCalledTimes(1);
    expect(getAuth).toHaveBeenCalledWith({ name: "mock-app" });
    expect(auth).toBe(fakeAuthInstance);
  });

  describe("signOutCurrentUser", () => {
    it("does nothing when there is no configured auth instance", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubMissingFirebaseConfigEnv();

      const { signOutCurrentUser } = await import("./firebase");

      await signOutCurrentUser();

      expect(signOut).not.toHaveBeenCalled();
    });

    it("calls firebase signOut with the active auth instance", async () => {
      stubFirebaseConfigEnv();
      const fakeAuthInstance = { currentUser: null };
      getAuth.mockReturnValue(fakeAuthInstance);

      const { signOutCurrentUser } = await import("./firebase");

      await signOutCurrentUser();

      expect(signOut).toHaveBeenCalledWith(fakeAuthInstance);
    });
  });
});
