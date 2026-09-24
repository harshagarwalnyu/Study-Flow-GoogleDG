import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, ProtectedRoute, useAuth } from "./auth";
import { installChromeStub } from "../test-utils";

type AuthStateCallback = (user: unknown) => void;
type AuthErrorCallback = (err: { message: string }) => void;

const { onAuthStateChangedMock, firebaseConfigState } = vi.hoisted(() => ({
  onAuthStateChangedMock: vi.fn(),
  firebaseConfigState: { hasFirebaseConfig: true, auth: {} as unknown },
}));

vi.mock("./firebase", () => ({
  get auth() {
    return firebaseConfigState.auth;
  },
  get hasFirebaseConfig() {
    return firebaseConfigState.hasFirebaseConfig;
  },
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: onAuthStateChangedMock,
}));

function ContextProbe() {
  const { user, loading, error } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? "none"}</span>
      <span data-testid="user">{user ? (user as { uid: string }).uid : "none"}</span>
    </div>
  );
}

describe("AuthProvider", () => {
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    firebaseConfigState.hasFirebaseConfig = true;
    firebaseConfigState.auth = {};
    unsubscribe = vi.fn();
    onAuthStateChangedMock.mockReset();
    onAuthStateChangedMock.mockImplementation(() => unsubscribe);
    installChromeStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports a configuration error and stops loading when Firebase is not configured", async () => {
    firebaseConfigState.hasFirebaseConfig = false;
    firebaseConfigState.auth = null;

    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );

    expect(await screen.findByTestId("error")).toHaveProperty(
      "textContent",
      "Firebase is not configured. Check your extension/.env file.",
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(onAuthStateChangedMock).not.toHaveBeenCalled();
  });

  it("syncs the ID token to session storage and exposes the user when signed in", async () => {
    const getIdToken = vi.fn(() => Promise.resolve("id-token-abc"));
    let capturedSuccess: AuthStateCallback = () => {};

    onAuthStateChangedMock.mockImplementation((_auth: unknown, onNext: AuthStateCallback) => {
      capturedSuccess = onNext;
      return unsubscribe;
    });

    const chromeStub = installChromeStub();

    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );

    await act(async () => {
      capturedSuccess({ uid: "user-1", getIdToken });
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("user-1"));
    expect(screen.getByTestId("loading").textContent).toBe("false");
    await waitFor(() =>
      expect(chromeStub.storage.session.set).toHaveBeenCalledWith({ firebaseIdToken: "id-token-abc" }),
    );
  });

  it("clears session storage when the user signs out", async () => {
    let capturedSuccess: AuthStateCallback = () => {};
    onAuthStateChangedMock.mockImplementation((_auth: unknown, onNext: AuthStateCallback) => {
      capturedSuccess = onNext;
      return unsubscribe;
    });
    const chromeStub = installChromeStub();

    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );

    act(() => {
      capturedSuccess(null);
    });

    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("none"));
    expect(chromeStub.storage.session.remove).toHaveBeenCalledWith("firebaseIdToken");
  });

  it("surfaces an auth-state error from Firebase", async () => {
    let capturedError: AuthErrorCallback = () => {};
    onAuthStateChangedMock.mockImplementation(
      (_auth: unknown, _onNext: AuthStateCallback, onError: AuthErrorCallback) => {
        capturedError = onError;
        return unsubscribe;
      },
    );

    render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );

    act(() => {
      capturedError({ message: "network offline" });
    });

    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("network offline"));
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("unsubscribes from auth state changes on unmount", () => {
    const { unmount } = render(
      <AuthProvider>
        <ContextProbe />
      </AuthProvider>,
    );
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("ProtectedRoute", () => {
  beforeEach(() => {
    firebaseConfigState.hasFirebaseConfig = true;
    firebaseConfigState.auth = {};
    installChromeStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a loading state while auth is resolving", () => {
    onAuthStateChangedMock.mockImplementation(() => () => {});
    render(
      <AuthProvider>
        <ProtectedRoute>
          <div>secret content</div>
        </ProtectedRoute>
      </AuthProvider>,
    );
    expect(screen.getByText("Loading session...")).toBeTruthy();
  });

  it("shows a configuration error when Firebase is not configured", async () => {
    firebaseConfigState.hasFirebaseConfig = false;
    firebaseConfigState.auth = null;
    render(
      <AuthProvider>
        <ProtectedRoute>
          <div>secret content</div>
        </ProtectedRoute>
      </AuthProvider>,
    );
    expect(await screen.findByText("Configuration Error")).toBeTruthy();
  });

  it("prompts sign-in and opens the web login tab when there is no user", async () => {
    onAuthStateChangedMock.mockImplementation((_auth: unknown, onNext: AuthStateCallback) => {
      onNext(null);
      return () => {};
    });
    const chromeStub = installChromeStub();

    render(
      <AuthProvider>
        <ProtectedRoute>
          <div>secret content</div>
        </ProtectedRoute>
      </AuthProvider>,
    );

    const button = await screen.findByText("Sign In on Website");
    button.click();

    expect(chromeStub.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining(`extensionId=${chromeStub.runtime.id}`),
      }),
    );
  });

  it("renders children once a user is present", async () => {
    onAuthStateChangedMock.mockImplementation((_auth: unknown, onNext: AuthStateCallback) => {
      onNext({ uid: "user-1", getIdToken: () => Promise.resolve("t") });
      return () => {};
    });

    render(
      <AuthProvider>
        <ProtectedRoute>
          <div>secret content</div>
        </ProtectedRoute>
      </AuthProvider>,
    );

    expect(await screen.findByText("secret content")).toBeTruthy();
  });
});
