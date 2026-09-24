import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetApps, mockInitializeApp, mockCert } = vi.hoisted(() => ({
  mockGetApps: vi.fn((): Array<{ name: string }> => []),
  mockInitializeApp: vi.fn(),
  mockCert: vi.fn((sa) => ({ cert: sa })),
}));

vi.mock("firebase-admin/app", () => ({
  getApps: mockGetApps,
  initializeApp: mockInitializeApp,
  cert: mockCert,
}));

const { mockGetFirestore } = vi.hoisted(() => ({
  mockGetFirestore: vi.fn(() => ({ collection: vi.fn() })),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: mockGetFirestore,
  FieldValue: { serverTimestamp: vi.fn() },
}));

const { mockGetAuth } = vi.hoisted(() => ({
  mockGetAuth: vi.fn(() => ({ verifyIdToken: vi.fn() })),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: mockGetAuth,
}));

const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn((_p: unknown) => false),
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
  };
});

const validSaJson = JSON.stringify({
  client_email: "test@example.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk...",
  project_id: "test-proj",
});

describe("src/db/firebase.ts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    mockGetApps.mockReturnValue([]);
    mockInitializeApp.mockReset();
    mockCert.mockClear();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not reinitialize if an app is already initialized", async () => {
    mockGetApps.mockReturnValue([{ name: "[DEFAULT]" }]);
    const mod = await import("./firebase");
    expect(mockInitializeApp).not.toHaveBeenCalled();
    expect(mod.db).toBeDefined();
    expect(mod.auth).toBeDefined();
  });

  it("loads inline JSON from GOOGLE_APPLICATION_CREDENTIALS", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", validSaJson);
    await import("./firebase");
    expect(mockCert).toHaveBeenCalledWith(JSON.parse(validSaJson));
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: { cert: JSON.parse(validSaJson) },
      projectId: "test-proj",
    });
  });

  it("throws when GOOGLE_APPLICATION_CREDENTIALS inline JSON is missing client_email", async () => {
    const invalidSa = JSON.stringify({ private_key: "abc" });
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", invalidSa);
    await expect(import("./firebase")).rejects.toThrow(
      /missing client_email or private_key/
    );
  });

  it("throws when GOOGLE_APPLICATION_CREDENTIALS inline JSON has invalid syntax", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "{not-json");
    await expect(import("./firebase")).rejects.toThrow(
      /Invalid Firebase service account JSON from GOOGLE_APPLICATION_CREDENTIALS/
    );
  });

  it("loads file from GOOGLE_APPLICATION_CREDENTIALS when path is absolute and uses FIREBASE_PROJECT_ID fallback", async () => {
    const saWithoutProjectId = JSON.stringify({
      client_email: "test@example.com",
      private_key: "key123",
    });
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/etc/secrets/sa.json");
    vi.stubEnv("FIREBASE_PROJECT_ID", "env-project-id");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(saWithoutProjectId);

    await import("./firebase");
    expect(mockExistsSync).toHaveBeenCalledWith("/etc/secrets/sa.json");
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: { cert: JSON.parse(saWithoutProjectId) },
      projectId: "env-project-id",
    });
  });

  it("loads relative file path from GOOGLE_APPLICATION_CREDENTIALS and throws if not found", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "relative/sa.json");
    mockExistsSync.mockReturnValue(false);

    await expect(import("./firebase")).rejects.toThrow(
      /Firebase credentials file not found/
    );
  });

  it("loads file from FIREBASE_SERVICE_ACCOUNT_PATH", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_PATH", "/var/sa.json");
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(validSaJson);

    await import("./firebase");
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: { cert: JSON.parse(validSaJson) },
      projectId: "test-proj",
    });
  });

  it("loads inline JSON from FIREBASE_SERVICE_ACCOUNT_JSON", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_PATH", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_JSON", validSaJson);

    await import("./firebase");
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: { cert: JSON.parse(validSaJson) },
      projectId: "test-proj",
    });
  });

  it("loads from default serviceAccount.json file if it exists", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_PATH", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_JSON", "");
    mockExistsSync.mockImplementation((p: any) => String(p).endsWith("serviceAccount.json"));
    mockReadFileSync.mockReturnValue(validSaJson);

    await import("./firebase");
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: { cert: JSON.parse(validSaJson) },
      projectId: "test-proj",
    });
  });

  it("initializes with only projectId when FIREBASE_PROJECT_ID is provided without credentials", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_PATH", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_JSON", "");
    vi.stubEnv("FIREBASE_PROJECT_ID", "standalone-project");
    mockExistsSync.mockReturnValue(false);

    await import("./firebase");
    expect(mockInitializeApp).toHaveBeenCalledWith({
      projectId: "standalone-project",
    });
  });

  it("initializes with no arguments when no credentials or project ID are provided", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_PATH", "");
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_JSON", "");
    vi.stubEnv("FIREBASE_PROJECT_ID", "");
    mockExistsSync.mockReturnValue(false);

    await import("./firebase");
    expect(mockInitializeApp).toHaveBeenCalledWith();
  });

  it("handles non-Error thrown in parseServiceAccountJson", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "{bad-json");
    const jsonSpy = vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
      throw "non-error-exception";
    });

    await expect(import("./firebase")).rejects.toThrow(
      /Invalid Firebase service account JSON from GOOGLE_APPLICATION_CREDENTIALS: non-error-exception/
    );
    jsonSpy.mockRestore();
  });

  it("returns null for whitespace or non-string paths in loadServiceAccountFromFile", async () => {
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    // Whitespace path in FIREBASE_SERVICE_ACCOUNT_PATH
    vi.stubEnv("FIREBASE_SERVICE_ACCOUNT_PATH", "   ");
    vi.stubEnv("FIREBASE_PROJECT_ID", "default-proj");
    mockExistsSync.mockReturnValue(false);

    await import("./firebase");
    expect(mockInitializeApp).toHaveBeenCalledWith({
      projectId: "default-proj",
    });
  });
});
