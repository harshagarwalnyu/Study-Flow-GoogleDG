import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Shell } from "./Shell";
import { installChromeStub, renderWithRouter } from "./test-utils";
import { STORAGE_KEYS } from "../lib/messages";

const { signOutMock, firebaseState } = vi.hoisted(() => ({
  signOutMock: vi.fn(() => Promise.resolve()),
  firebaseState: { hasFirebaseConfig: true, auth: {} as unknown },
}));

vi.mock("./lib/firebase", () => ({
  get auth() {
    return firebaseState.auth;
  },
  get hasFirebaseConfig() {
    return firebaseState.hasFirebaseConfig;
  },
}));

vi.mock("firebase/auth", () => ({
  signOut: signOutMock,
}));

describe("Shell", () => {
  beforeEach(() => {
    firebaseState.hasFirebaseConfig = true;
    firebaseState.auth = {};
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(undefined);
    installChromeStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks the Hub tab active on the home route", () => {
    renderWithRouter(
      <Shell>
        <div>child content</div>
      </Shell>,
      { route: "/home" },
    );
    expect(screen.getByText("Hub").className).toContain("active");
    expect(screen.getByText("Ask").className).not.toContain("active");
  });

  it("marks the Ask tab active on the ask route", () => {
    renderWithRouter(
      <Shell>
        <div>child content</div>
      </Shell>,
      { route: "/ask" },
    );
    expect(screen.getByText("Ask").className).toContain("active");
  });

  it("renders the children passed to it", () => {
    renderWithRouter(
      <Shell>
        <div>unique child marker</div>
      </Shell>,
    );
    expect(screen.getByText("unique child marker")).toBeTruthy();
  });

  it("signs out via Firebase and clears local/session storage when configured", async () => {
    const chromeStub = installChromeStub();
    renderWithRouter(
      <Shell>
        <div>child</div>
      </Shell>,
    );

    fireEvent.click(screen.getByText("Sign Out"));

    await vi.waitFor(() => expect(signOutMock).toHaveBeenCalledWith(firebaseState.auth));
    await vi.waitFor(() =>
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({ extensionSignedOut: true }),
    );
    expect(chromeStub.storage.session.remove).toHaveBeenCalledWith([
      STORAGE_KEYS.firebaseIdToken,
      STORAGE_KEYS.authUser,
    ]);
  });

  it("skips the Firebase signOut call when Firebase is not configured, but still clears storage", async () => {
    firebaseState.hasFirebaseConfig = false;
    firebaseState.auth = null;
    const chromeStub = installChromeStub();
    renderWithRouter(
      <Shell>
        <div>child</div>
      </Shell>,
    );

    fireEvent.click(screen.getByText("Sign Out"));

    await vi.waitFor(() =>
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({ extensionSignedOut: true }),
    );
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("still clears storage even when Firebase signOut throws", async () => {
    signOutMock.mockRejectedValueOnce(new Error("network down"));
    const chromeStub = installChromeStub();
    renderWithRouter(
      <Shell>
        <div>child</div>
      </Shell>,
    );

    fireEvent.click(screen.getByText("Sign Out"));

    await vi.waitFor(() =>
      expect(chromeStub.storage.local.set).toHaveBeenCalledWith({ extensionSignedOut: true }),
    );
  });
});
