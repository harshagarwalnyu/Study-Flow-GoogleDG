import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { Login } from "./Login";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as firebaseAuth from "firebase/auth";
import * as extensionBridgeModule from "../lib/extensionBridge";
import * as authModule from "../lib/auth";
import * as apiModule from "../lib/api";

const firebaseTestState = vi.hoisted(() => ({
  auth: { currentUser: null } as any,
  hasFirebaseConfig: true,
}));

// Mock firebase
vi.mock("../lib/firebase", () => ({
  get auth() {
    return firebaseTestState.auth;
  },
  get hasFirebaseConfig() {
    return firebaseTestState.hasFirebaseConfig;
  },
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  trackClientEvent: vi.fn().mockResolvedValue({}),
}));

vi.mock("../lib/auth", () => ({
  useAuth: vi.fn(() => null),
}));

vi.mock("../lib/extensionBridge", () => ({
  getExtensionIdFromSearch: vi.fn(() => ""),
  sendAuthToExtension: vi.fn().mockResolvedValue({ ok: true }),
}));

function renderLoginAt(initialEntry = "/login") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<div>Dashboard Page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Login Page", () => {

  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    firebaseTestState.auth = { currentUser: null };
    firebaseTestState.hasFirebaseConfig = true;
    vi.mocked(extensionBridgeModule.getExtensionIdFromSearch).mockReturnValue(
      "",
    );
    vi.mocked(authModule.useAuth).mockReturnValue(null);
    vi.mocked(apiModule.trackClientEvent).mockResolvedValue({} as any);
    window.status = "";
  });

  it("renders correctly", () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    expect(screen.getByText(/Welcome back/i)).toBeDefined();
  });

  it("handles email/password submission", async () => {
    (firebaseAuth.signInWithEmailAndPassword as any).mockResolvedValue({ user: { uid: "123" } });

    renderLoginAt("/login");

    const emailInput = screen.getByPlaceholderText(/you@university.edu/i);
    const passInput = screen.getByPlaceholderText(/••••••••/);
    const form = screen.getByRole("form", { name: "login-form" });

    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(passInput, { target: { value: "password" } });

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(firebaseAuth.signInWithEmailAndPassword).toHaveBeenCalledWith(
        firebaseTestState.auth,
        "test@example.com",
        "password",
      );
      expect(screen.getByText(/Dashboard Page/i)).toBeDefined();
    });
  });

  it("handles google sign in", async () => {
    (firebaseAuth.signInWithPopup as any).mockResolvedValue({ user: { uid: "123" } });

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    const googleBtn = screen.getByText(/Continue with Google/i);
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(firebaseAuth.signInWithPopup).toHaveBeenCalled();
    });
  });

  it("shows error on failure", async () => {
    (firebaseAuth.signInWithEmailAndPassword as any).mockRejectedValue(new Error("Login failed"));

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    const form = screen.getByRole("form", { name: "login-form" });
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText(/Login failed/)).toBeDefined();
    }, { timeout: 2000 });
  });

  it("shows the thrown Error's message when Google sign-in fails", async () => {
    (firebaseAuth.signInWithPopup as any).mockRejectedValue(
      new Error("popup closed by user"),
    );

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const googleBtn = screen.getByText(/Continue with Google/i);
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("popup closed by user")).toBeDefined();
    });
  });

  it("shows a string thrown value directly as the error message on email/password failure", async () => {
    (firebaseAuth.signInWithEmailAndPassword as any).mockRejectedValue(
      "plain string failure",
    );

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const form = screen.getByRole("form", { name: "login-form" });
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("plain string failure")).toBeDefined();
    });
  });

  it("falls back to a generic message for a non-Error, non-string thrown value", async () => {
    (firebaseAuth.signInWithEmailAndPassword as any).mockRejectedValue({
      code: "weird",
    });

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const form = screen.getByRole("form", { name: "login-form" });
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(
        screen.getByText("An unexpected error occurred."),
      ).toBeDefined();
    });
  });

  it("shows a config error and skips Firebase when submitting the email/password form without a configured auth instance", async () => {
    firebaseTestState.hasFirebaseConfig = false;
    firebaseTestState.auth = null;

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const form = screen.getByRole("form", { name: "login-form" });
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Firebase is not configured yet/i),
      ).toBeDefined();
    });
    expect(firebaseAuth.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it("shows a config error and skips Firebase when clicking Google sign-in without a configured auth instance", async () => {
    firebaseTestState.hasFirebaseConfig = false;
    firebaseTestState.auth = null;

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const googleBtn = screen.getByText(/Continue with Google/i);
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Add web\/\.env\.local to test Google sign-in/i),
      ).toBeDefined();
    });
    expect(firebaseAuth.signInWithPopup).not.toHaveBeenCalled();
  });

  it("shows the extension-aware copy and preserves the extensionId through navigation when present", () => {
    vi.mocked(
      extensionBridgeModule.getExtensionIdFromSearch,
    ).mockReturnValue("ext-99");

    render(
      <MemoryRouter initialEntries={["/login?extensionId=ext-99"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(/use Connect to extension on your dashboard/i),
    ).toBeDefined();

    const signupLink = screen.getByRole("link", { name: /Sign up/i });
    expect(signupLink.getAttribute("href")).toBe(
      "/signup?extensionId=ext-99",
    );
  });

  it("renders a note when window.status is set (legacy browser status line)", () => {
    window.status = "loading page...";

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByText("loading page...")).toBeDefined();
  });

  it("redirects immediately to the dashboard when the user is already authenticated on mount", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "already-in" } as any);

    renderLoginAt("/login");

    await waitFor(() => {
      expect(screen.getByText(/Dashboard Page/i)).toBeDefined();
    });
  });

  it("swallows a rejected login-tracking call after a successful email/password sign-in", async () => {
    (firebaseAuth.signInWithEmailAndPassword as any).mockResolvedValue({
      user: { uid: "123" },
    });
    vi.mocked(apiModule.trackClientEvent).mockRejectedValue(
      new Error("tracking down"),
    );

    renderLoginAt("/login");

    const form = screen.getByRole("form", { name: "login-form" });
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText(/Dashboard Page/i)).toBeDefined();
    });
  });

  it("swallows a rejected login-tracking call after a successful Google sign-in", async () => {
    (firebaseAuth.signInWithPopup as any).mockResolvedValue({
      user: { uid: "123" },
    });
    vi.mocked(apiModule.trackClientEvent).mockRejectedValue(
      new Error("tracking down"),
    );

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    const googleBtn = screen.getByText(/Continue with Google/i);
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(firebaseAuth.signInWithPopup).toHaveBeenCalled();
    });
  });
});
