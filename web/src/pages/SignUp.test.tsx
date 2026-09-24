import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SignUp } from "./SignUp";
import * as firebaseAuth from "firebase/auth";
import * as authModule from "../lib/auth";
import * as apiModule from "../lib/api";
import * as extensionBridgeModule from "../lib/extensionBridge";

const firebaseTestState = vi.hoisted(() => ({
  auth: { currentUser: null } as any,
  hasFirebaseConfig: true,
}));

vi.mock("../lib/firebase", () => ({
  get auth() {
    return firebaseTestState.auth;
  },
  get hasFirebaseConfig() {
    return firebaseTestState.hasFirebaseConfig;
  },
}));

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  trackClientEvent: vi.fn().mockResolvedValue({}),
}));

vi.mock("../lib/auth", () => ({
  useAuth: vi.fn(() => null),
}));

vi.mock("../lib/extensionBridge", () => ({
  getExtensionIdFromSearch: vi.fn(() => ""),
}));

function renderSignUp(initialEntry = "/signup") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/signup" element={<SignUp />} />
        <Route path="/welcome" element={<div>Welcome stub</div>} />
        <Route path="/dashboard" element={<div>Dashboard stub</div>} />
        <Route path="/login" element={<div>Login stub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("SignUp Page", () => {

  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    firebaseTestState.auth = { currentUser: null };
    firebaseTestState.hasFirebaseConfig = true;
    vi.mocked(apiModule.trackClientEvent).mockResolvedValue({} as any);
    vi.mocked(authModule.useAuth).mockReturnValue(null);
    vi.mocked(extensionBridgeModule.getExtensionIdFromSearch).mockReturnValue(
      "",
    );
  });

  it("renders the signup form", () => {
    renderSignUp();

    expect(
      screen.getByRole("heading", { name: "Create your account" }),
    ).toBeDefined();
    expect(screen.getByPlaceholderText("Alex Chen")).toBeDefined();
    expect(screen.getByPlaceholderText(/you@university.edu/i)).toBeDefined();
    expect(
      screen.getByPlaceholderText(/At least 8 characters/i),
    ).toBeDefined();
  });

  it("shows the default lede copy when there is no extensionId", () => {
    renderSignUp();

    expect(
      screen.getByText(/We.ll build your misconception graph/i),
    ).toBeDefined();
  });

  it("shows extension-specific copy and preserves the extensionId on the login link when present", () => {
    vi.mocked(
      extensionBridgeModule.getExtensionIdFromSearch,
    ).mockReturnValue("ext-42");

    renderSignUp("/signup?extensionId=ext-42");

    expect(
      screen.getByText(/Create your account here, then use Connect/i),
    ).toBeDefined();

    const loginLink = screen.getByRole("link", { name: /Log in/i });
    expect(loginLink.getAttribute("href")).toBe(
      "/login?extensionId=ext-42",
    );
  });

  it("redirects an already-authenticated user to /welcome when there is no extensionId", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);

    renderSignUp();

    await waitFor(() => {
      expect(screen.getByText("Welcome stub")).toBeDefined();
    });
  });

  it("redirects an already-authenticated user to /dashboard with the extensionId when present", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);
    vi.mocked(
      extensionBridgeModule.getExtensionIdFromSearch,
    ).mockReturnValue("ext-77");

    renderSignUp("/signup?extensionId=ext-77");

    await waitFor(() => {
      expect(screen.getByText("Dashboard stub")).toBeDefined();
    });
  });

  it("shows a config error and never calls Firebase when there is no configured auth instance", async () => {
    firebaseTestState.hasFirebaseConfig = false;
    firebaseTestState.auth = null;

    renderSignUp();

    fireEvent.change(screen.getByPlaceholderText("Alex Chen"), {
      target: { value: "Ada" },
    });
    fireEvent.change(screen.getByPlaceholderText(/you@university.edu/i), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/At least 8 characters/i), {
      target: { value: "password1" },
    });

    const form = screen
      .getByRole("button", { name: /Create account/i })
      .closest("form")!;

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/Firebase is not configured yet/i),
      ).toBeDefined();
    });

    expect(firebaseAuth.createUserWithEmailAndPassword).not.toHaveBeenCalled();
  });

  it("creates the account, sets the display name, tracks signup, and navigates to /welcome", async () => {
    const createdUser = { uid: "new-user" };
    vi.mocked(firebaseAuth.createUserWithEmailAndPassword).mockResolvedValue({
      user: createdUser,
    } as any);
    vi.mocked(firebaseAuth.updateProfile).mockResolvedValue(undefined);

    renderSignUp();

    fireEvent.change(screen.getByPlaceholderText("Alex Chen"), {
      target: { value: "Ada Lovelace" },
    });
    fireEvent.change(screen.getByPlaceholderText(/you@university.edu/i), {
      target: { value: "ada@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/At least 8 characters/i), {
      target: { value: "password1" },
    });

    const form = screen
      .getByRole("button", { name: /Create account/i })
      .closest("form")!;

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("Welcome stub")).toBeDefined();
    });

    expect(firebaseAuth.createUserWithEmailAndPassword).toHaveBeenCalledWith(
      firebaseTestState.auth,
      "ada@example.com",
      "password1",
    );
    expect(firebaseAuth.updateProfile).toHaveBeenCalledWith(createdUser, {
      displayName: "Ada Lovelace",
    });
    expect(apiModule.trackClientEvent).toHaveBeenCalledWith({
      eventType: "auth_signup",
      content: "signup",
      meta: { provider: "password" },
    });
  });

  it("shows the thrown Error's message on signup failure", async () => {
    vi.mocked(firebaseAuth.createUserWithEmailAndPassword).mockRejectedValue(
      new Error("Email already in use"),
    );

    renderSignUp();

    fireEvent.change(screen.getByPlaceholderText(/you@university.edu/i), {
      target: { value: "dupe@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/At least 8 characters/i), {
      target: { value: "password1" },
    });

    const form = screen
      .getByRole("button", { name: /Create account/i })
      .closest("form")!;

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("Email already in use")).toBeDefined();
    });
  });

  it("shows a string thrown value directly as the error message", async () => {
    vi.mocked(firebaseAuth.createUserWithEmailAndPassword).mockRejectedValue(
      "plain string failure",
    );

    renderSignUp();

    const form = screen
      .getByRole("button", { name: /Create account/i })
      .closest("form")!;

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("plain string failure")).toBeDefined();
    });
  });

  it("falls back to a generic message for a non-Error, non-string thrown value", async () => {
    vi.mocked(firebaseAuth.createUserWithEmailAndPassword).mockRejectedValue({
      code: "weird",
    });

    renderSignUp();

    const form = screen
      .getByRole("button", { name: /Create account/i })
      .closest("form")!;

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(
        screen.getByText("An unexpected error occurred."),
      ).toBeDefined();
    });
  });

  it("the 'Back to home' link points at /", () => {
    renderSignUp();

    const backLink = screen.getByRole("link", { name: /Back to home/i });
    expect(backLink.getAttribute("href")).toBe("/");
  });

  it("swallows a rejected signup-tracking call after a successful account creation", async () => {
    const createdUser = { uid: "new-user-2" };
    vi.mocked(firebaseAuth.createUserWithEmailAndPassword).mockResolvedValue({
      user: createdUser,
    } as any);
    vi.mocked(firebaseAuth.updateProfile).mockResolvedValue(undefined);
    vi.mocked(apiModule.trackClientEvent).mockRejectedValue(
      new Error("tracking down"),
    );

    renderSignUp();

    fireEvent.change(screen.getByPlaceholderText(/you@university.edu/i), {
      target: { value: "ada2@example.com" },
    });
    fireEvent.change(screen.getByPlaceholderText(/At least 8 characters/i), {
      target: { value: "password1" },
    });

    const form = screen
      .getByRole("button", { name: /Create account/i })
      .closest("form")!;

    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(screen.getByText("Welcome stub")).toBeDefined();
    });
  });
});
