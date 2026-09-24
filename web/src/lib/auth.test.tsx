import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const getInitialAuthUserState = vi.fn();
const subscribeToAuthState = vi.fn();

vi.mock("@study-flow/client", () => ({
  getInitialAuthUserState,
  subscribeToAuthState,
}));

const fakeAuthState = { hasFirebaseConfig: false, auth: null };

vi.mock("./firebase", () => ({
  authState: fakeAuthState,
}));

describe("lib/auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
  });

  it("AuthProvider seeds context state from getInitialAuthUserState", async () => {
    getInitialAuthUserState.mockReturnValue(null);
    subscribeToAuthState.mockReturnValue(() => {});

    const { AuthProvider, useAuth } = await import("./auth");

    function Consumer() {
      const user = useAuth();
      return <div>state:{user === null ? "null" : String(user)}</div>;
    }

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    expect(getInitialAuthUserState).toHaveBeenCalledWith(fakeAuthState);
    expect(screen.getByText("state:null")).toBeDefined();
  });

  it("subscribes to auth state changes on mount and updates context when the user changes", async () => {
    getInitialAuthUserState.mockReturnValue(undefined);
    let capturedSetUser: ((user: unknown) => void) | undefined;
    subscribeToAuthState.mockImplementation((_authState, setUser) => {
      capturedSetUser = setUser;
      return vi.fn();
    });

    const { AuthProvider, useAuth } = await import("./auth");

    function Consumer() {
      const user = useAuth();
      return (
        <div>
          state:
          {user === undefined ? "undefined" : user === null ? "null" : (user as any).uid}
        </div>
      );
    }

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    expect(subscribeToAuthState).toHaveBeenCalledTimes(1);
    expect(subscribeToAuthState).toHaveBeenCalledWith(
      fakeAuthState,
      expect.any(Function),
    );
    expect(screen.getByText(/undefined/)).toBeDefined();

    act(() => {
      capturedSetUser?.({ uid: "user-42" });
    });

    expect(screen.getByText(/user-42/)).toBeDefined();
  });

  it("unsubscribes from auth state changes on unmount", async () => {
    getInitialAuthUserState.mockReturnValue(null);
    const unsubscribe = vi.fn();
    subscribeToAuthState.mockReturnValue(unsubscribe);

    const { AuthProvider } = await import("./auth");

    const { unmount } = render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>,
    );

    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("useAuth reads the current context value provided by AuthProvider", async () => {
    getInitialAuthUserState.mockReturnValue({ uid: "direct-user" });
    subscribeToAuthState.mockReturnValue(() => {});

    const { AuthProvider, useAuth } = await import("./auth");

    function Consumer() {
      const user = useAuth();
      return <div>uid:{(user as any)?.uid}</div>;
    }

    render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );

    expect(screen.getByText("uid:direct-user")).toBeDefined();
  });
});
