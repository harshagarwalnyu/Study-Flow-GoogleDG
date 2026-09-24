import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import * as authModule from "./lib/auth";

vi.mock("./lib/auth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  trackClientEvent: vi.fn().mockResolvedValue({}),
}));

vi.mock("./lib/firebase", () => ({
  signOutCurrentUser: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pages/Dashboard", () => ({
  default: function MockDashboard() {
    return <div>Mock Dashboard Content</div>;
  },
}));

describe("App", () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the Home page inside the shared Layout at the root path", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getAllByText(/Study Flow/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/How Study Flow compares/i)).toBeDefined();
  });

  it("renders nothing for an unmatched route since there is no catch-all route", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    const { container } = render(
      <MemoryRouter initialEntries={["/this-route-does-not-exist"]}>
        <App />
      </MemoryRouter>,
    );

    expect(container.textContent).toBe("");
    expect(
      screen.queryByText(/How Study Flow compares/i),
    ).toBeNull();
  });

  it("shows the loading fallback then the lazy dashboard for an authenticated user", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "1" } as any);

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Loading dashboard/i)).toBeDefined();

    await waitFor(() => {
      expect(screen.getByText("Mock Dashboard Content")).toBeDefined();
    });
  });

  it("redirects unauthenticated users away from /dashboard to /login", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Welcome back/i)).toBeDefined();
    expect(screen.queryByText("Mock Dashboard Content")).toBeNull();
  });

  it("renders the signup page at /signup", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={["/signup"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Create your account/i)).toBeDefined();
  });

  it("renders the download page at /download", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={["/download"]}>
        <App />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Install Study Flow" }),
    ).toBeDefined();
  });

  it("catches render errors from a child route via the ErrorBoundary", () => {
    vi.mocked(authModule.useAuth).mockImplementation(() => {
      throw new Error("boom from useAuth");
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>,
    );

    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("boom from useAuth")).toBeDefined();
  });
});
