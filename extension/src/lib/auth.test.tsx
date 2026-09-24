import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createFakeChrome, type FakeChrome } from "./test-chrome";
import { STORAGE_KEYS } from "./messages";

const clientMock = vi.hoisted(() => ({
  createFirebaseAuthState: vi.fn(),
  subscribeToAuthState: vi.fn(),
}));
vi.mock("@study-flow/client", () => clientMock);

// This file's async effects (microtask-deferred chrome.storage callbacks, waitFor polling) can
// be slow under CPU contention when the full test suite runs in parallel; the default 5s test
// timeout is otherwise too tight and causes flaky failures unrelated to correctness.
vi.setConfig({ testTimeout: 20_000 });

function Probe() {
  // Imported dynamically per test below; this indirection lets each test re-import a fresh
  // "./auth" module (its `authState` is a module-level singleton built at import time).
  return null;
}
void Probe;

async function loadAuthModule() {
  return import("./auth");
}

function renderProbe(AuthProviderComp: any, useAuthHook: any) {
  function ProbeInner() {
    const user = useAuthHook();
    const label = user === undefined ? "loading" : user === null ? "signed-out" : JSON.stringify(user);
    return <div data-testid="state">{label}</div>;
  }
  return render(
    <AuthProviderComp>
      <ProbeInner />
    </AuthProviderComp>,
  );
}

describe("auth.tsx", () => {
  let fakeChrome: FakeChrome;

  beforeEach(() => {
    cleanup(); // belt-and-suspenders: guarantee a clean DOM even if a prior test was slow to unmount.
    vi.resetModules();
    clientMock.createFirebaseAuthState.mockReset();
    clientMock.subscribeToAuthState.mockReset();
    fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  describe("without Firebase config (UI-only mode)", () => {
    beforeEach(() => {
      clientMock.createFirebaseAuthState.mockReturnValue({
        auth: null,
        hasFirebaseConfig: false,
        firebaseConfig: {},
        env: {},
      });
      clientMock.subscribeToAuthState.mockReturnValue(() => undefined);
    });

    it("resolves to signed-out once storage confirms there is no session token", async () => {
      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("signed-out"));
    });

    it("hydrates a signed-in user from a valid, fully-populated stored session", async () => {
      fakeChrome = createFakeChrome({
        storage: {
          session: {
            [STORAGE_KEYS.firebaseIdToken]: "tok",
            [STORAGE_KEYS.authUser]: { uid: "u1", email: "e@x.com", displayName: "Dee", photoURL: "http://img" },
          },
        },
      });
      vi.stubGlobal("chrome", fakeChrome);

      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toEqual({
          uid: "u1",
          email: "e@x.com",
          displayName: "Dee",
          photoURL: "http://img",
        }),
      );
    });

    it("falls back to a generic web-session user when a token exists but authUser is absent", async () => {
      fakeChrome = createFakeChrome({
        storage: { session: { [STORAGE_KEYS.firebaseIdToken]: "tok" } },
      });
      vi.stubGlobal("chrome", fakeChrome);

      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toEqual({
          uid: "web-session",
          email: null,
          displayName: null,
          photoURL: null,
        }),
      );
    });

    it("falls back to a generic web-session user when the stored authUser is not an object", async () => {
      fakeChrome = createFakeChrome({
        storage: {
          session: { [STORAGE_KEYS.firebaseIdToken]: "tok", [STORAGE_KEYS.authUser]: "not-an-object" },
        },
      });
      vi.stubGlobal("chrome", fakeChrome);

      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").uid).toBe("web-session"),
      );
    });

    it("falls back to a generic web-session user when the stored authUser has no uid", async () => {
      fakeChrome = createFakeChrome({
        storage: {
          session: { [STORAGE_KEYS.firebaseIdToken]: "tok", [STORAGE_KEYS.authUser]: { email: "e@x.com" } },
        },
      });
      vi.stubGlobal("chrome", fakeChrome);

      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").uid).toBe("web-session"),
      );
    });

    it("defaults email/displayName/photoURL to null when the stored authUser omits them or has non-string values", async () => {
      fakeChrome = createFakeChrome({
        storage: {
          session: {
            [STORAGE_KEYS.firebaseIdToken]: "tok",
            [STORAGE_KEYS.authUser]: { uid: "u2", email: 42, displayName: null },
          },
        },
      });
      vi.stubGlobal("chrome", fakeChrome);

      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toEqual({
          uid: "u2",
          email: null,
          displayName: null,
          photoURL: null,
        }),
      );
    });

    it("clears the session and reports signed-out when the local signedOut flag is set", async () => {
      fakeChrome = createFakeChrome({
        storage: {
          local: { extensionSignedOut: true },
          session: { [STORAGE_KEYS.firebaseIdToken]: "tok", [STORAGE_KEYS.authUser]: { uid: "u1" } },
        },
      });
      vi.stubGlobal("chrome", fakeChrome);

      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);

      await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("signed-out"));
      expect(fakeChrome.storage.session.state[STORAGE_KEYS.firebaseIdToken]).toBeUndefined();
      expect(fakeChrome.storage.session.state[STORAGE_KEYS.authUser]).toBeUndefined();
    });

    it("re-syncs when the session token or authUser changes in storage", async () => {
      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);
      await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("signed-out"));

      // Token-only change.
      await act(async () => {
        await fakeChrome.storage.session.set({ [STORAGE_KEYS.firebaseIdToken]: "new-tok" });
      });
      // authUser-only change (separate call, so the `||` branch for authUser-in-changes fires alone).
      await act(async () => {
        await fakeChrome.storage.session.set({ [STORAGE_KEYS.authUser]: { uid: "u9" } });
      });

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").uid).toBe("u9"),
      );
    });

    it("ignores unrelated storage.onChanged events", async () => {
      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);
      await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("signed-out"));

      const getCallsBefore = vi.mocked(fakeChrome.storage.session.get).mock.calls.length;
      await act(async () => {
        await fakeChrome.storage.local.set({ someUnrelatedKey: "x" });
      });
      // Neither a session-area change nor the local signedOut key: no resync triggered.
      expect(vi.mocked(fakeChrome.storage.session.get).mock.calls.length).toBe(getCallsBefore);
      expect(screen.getByTestId("state").textContent).toBe("signed-out");
    });

    it("resyncs on an AUTH_UPDATED runtime message and ignores every other message shape", async () => {
      const { AuthProvider, useAuth } = await loadAuthModule();
      renderProbe(AuthProvider, useAuth);
      await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("signed-out"));

      // Ignored: wrong type, and no type at all (covers the optional-chaining fallback too).
      act(() => {
        fakeChrome.runtime.onMessage.emit({ type: "SOMETHING_ELSE" }, {}, () => {});
        fakeChrome.runtime.onMessage.emit(undefined, {}, () => {});
      });
      expect(screen.getByTestId("state").textContent).toBe("signed-out");

      fakeChrome.storage.session.state[STORAGE_KEYS.firebaseIdToken] = "via-message";
      fakeChrome.storage.session.state[STORAGE_KEYS.authUser] = { uid: "via-message-user" };
      await act(async () => {
        fakeChrome.runtime.onMessage.emit({ type: "AUTH_UPDATED" }, {}, () => {});
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").uid).toBe("via-message-user"),
      );
    });

    it("removes its listeners and does not crash when unmounted before pending storage reads resolve", async () => {
      const { AuthProvider, useAuth } = await loadAuthModule();
      const { unmount } = renderProbe(AuthProvider, useAuth);

      expect(fakeChrome.storage.onChanged.listeners.size).toBe(1);
      expect(fakeChrome.runtime.onMessage.listeners.size).toBe(1);

      // Unmount immediately, before the microtask-deferred chrome.storage.local.get callback
      // (from the initial syncSessionUser call) has a chance to run — exercises the `disposed`
      // guards inside the effect's async callbacks.
      unmount();
      expect(fakeChrome.storage.onChanged.listeners.size).toBe(0);
      expect(fakeChrome.runtime.onMessage.listeners.size).toBe(0);

      // Flush the deferred callback; it must not throw despite the component being gone.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("also guards the nested session-storage read when disposed between the two async reads", async () => {
      const { AuthProvider, useAuth } = await loadAuthModule();
      const { unmount } = renderProbe(AuthProvider, useAuth);

      // Let the first (local.get) callback run — it synchronously queues the second
      // (session.get) callback — then unmount before that second callback fires.
      await Promise.resolve();
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // No crash, and no listeners left behind.
      expect(fakeChrome.storage.onChanged.listeners.size).toBe(0);
    });
  });

  describe("with Firebase config", () => {
    it("maps the Firebase auth user, persists tokens via onUserChange/onRefresh, and unsubscribes on unmount", async () => {
      clientMock.createFirebaseAuthState.mockReturnValue({
        auth: {},
        hasFirebaseConfig: true,
        firebaseConfig: {},
        env: {},
      });

      let capturedSetUser: ((user: unknown) => void) | undefined;
      let capturedOptions: any;
      const unsubFirebase = vi.fn();
      clientMock.subscribeToAuthState.mockImplementation((_authState: unknown, setUser: (user: unknown) => void, options: unknown) => {
        capturedSetUser = setUser;
        capturedOptions = options;
        return unsubFirebase;
      });

      const { AuthProvider, useAuth } = await loadAuthModule();
      const { unmount } = renderProbe(AuthProvider, useAuth);

      // Loading until Firebase reports a user, since hasFirebaseConfig=true starts fbUser at undefined.
      expect(screen.getByTestId("state").textContent).toBe("loading");
      expect(capturedOptions.refreshIntervalMs).toBe(50 * 60 * 1000);

      act(() => {
        capturedSetUser?.({ uid: "fb1", email: "fb@x.com", displayName: "FB", photoURL: "http://p" });
      });
      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}")).toEqual({
          uid: "fb1",
          email: "fb@x.com",
          displayName: "FB",
          photoURL: "http://p",
        }),
      );

      // onUserChange: null user is a no-op (no token persisted).
      await act(async () => {
        await capturedOptions.onUserChange(null);
      });
      expect(fakeChrome.storage.session.state[STORAGE_KEYS.firebaseIdToken]).toBeUndefined();

      // onUserChange: real user persists the fresh ID token.
      const getIdToken = vi.fn(async () => "tok-from-change");
      await act(async () => {
        await capturedOptions.onUserChange({ uid: "fb2", getIdToken });
      });
      expect(fakeChrome.storage.session.state[STORAGE_KEYS.firebaseIdToken]).toBe("tok-from-change");

      // onRefresh: force-refreshes and persists the token.
      const getIdTokenRefresh = vi.fn(async () => "tok-refreshed");
      await act(async () => {
        await capturedOptions.onRefresh({ uid: "fb2", getIdToken: getIdTokenRefresh });
      });
      expect(getIdTokenRefresh).toHaveBeenCalledWith(true);
      expect(fakeChrome.storage.session.state[STORAGE_KEYS.firebaseIdToken]).toBe("tok-refreshed");

      // Firebase reports signed-out: falls through to the still-truthy sessionUser (the earlier
      // onUserChange/onRefresh calls persisted a session token, so the web-bridge session wins).
      act(() => {
        capturedSetUser?.(null);
      });
      await waitFor(() =>
        expect(JSON.parse(screen.getByTestId("state").textContent ?? "{}").uid).toBe("web-session"),
      );

      unmount();
      expect(unsubFirebase).toHaveBeenCalledTimes(1);
    });
  });

  it("exposes firebaseAuth and hasFirebaseConfig mirroring the created auth state", async () => {
    clientMock.createFirebaseAuthState.mockReturnValue({
      auth: { fake: "auth-object" },
      hasFirebaseConfig: true,
      firebaseConfig: {},
      env: {},
    });
    clientMock.subscribeToAuthState.mockReturnValue(() => undefined);

    const auth = await loadAuthModule();
    expect(auth.firebaseAuth).toEqual({ fake: "auth-object" });
    expect(auth.hasFirebaseConfig).toBe(true);
  });
});
