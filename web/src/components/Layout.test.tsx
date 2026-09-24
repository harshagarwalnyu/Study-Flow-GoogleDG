import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./Layout";
import * as authModule from "../lib/auth";
import * as apiModule from "../lib/api";
import * as firebaseModule from "../lib/firebase";
import styles from "./Layout.module.css";

vi.mock("../lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("../lib/api", () => ({ trackClientEvent: vi.fn() }));
vi.mock("../lib/firebase", () => ({ signOutCurrentUser: vi.fn() }));

function renderLayoutAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>Home stub</div>} />
          <Route path="/download" element={<div>Download stub</div>} />
          <Route path="/login" element={<div>Login stub</div>} />
          <Route path="/dashboard" element={<div>Dashboard stub</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("Layout", () => {

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiModule.trackClientEvent).mockResolvedValue({} as any);
    vi.mocked(firebaseModule.signOutCurrentUser).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows Log in / Sign up links and no Dashboard link or Sign out button when signed out", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    renderLayoutAt("/");

    expect(screen.getByRole("link", { name: /Log in/i })).toBeDefined();
    expect(screen.getByRole("link", { name: /Sign up/i })).toBeDefined();
    expect(screen.queryByRole("link", { name: /^Dashboard$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign out/i })).toBeNull();
  });

  it("does not track a page_view event when signed out", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    renderLayoutAt("/");

    await waitFor(() => {
      expect(screen.getByText("Home stub")).toBeDefined();
    });

    expect(apiModule.trackClientEvent).not.toHaveBeenCalled();
  });

  it("marks the Download nav link inactive off /download and active on /download", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    const { unmount } = renderLayoutAt("/");
    let downloadLink = screen.getByRole("link", { name: /Download/i });
    expect(downloadLink.classList.contains(styles.navActive)).toBe(false);
    unmount();

    renderLayoutAt("/download");
    downloadLink = screen.getByRole("link", { name: /Download/i });
    expect(downloadLink.classList.contains(styles.navActive)).toBe(true);
  });

  it("marks the Log in nav link active on /login", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    renderLayoutAt("/login");

    const loginLink = screen.getByRole("link", { name: /Log in/i });
    expect(loginLink.classList.contains(styles.navActive)).toBe(true);
  });

  it("shows the Dashboard link and Sign out button, and tracks a page_view, when signed in", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);

    renderLayoutAt("/");

    expect(screen.getByRole("link", { name: /^Dashboard$/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Sign out/i })).toBeDefined();
    expect(screen.queryByRole("link", { name: /Log in/i })).toBeNull();

    await waitFor(() => {
      expect(apiModule.trackClientEvent).toHaveBeenCalledWith({
        eventType: "page_view",
        content: "/",
        meta: { pathname: "/", search: "" },
      });
    });
  });

  it("marks the Dashboard nav link active on /dashboard and inactive elsewhere", () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);

    const { unmount } = renderLayoutAt("/");
    let dashboardLink = screen.getByRole("link", { name: /^Dashboard$/i });
    expect(dashboardLink.classList.contains(styles.navActive)).toBe(false);
    unmount();

    renderLayoutAt("/dashboard");
    dashboardLink = screen.getByRole("link", { name: /^Dashboard$/i });
    expect(dashboardLink.classList.contains(styles.navActive)).toBe(true);
  });

  it("swallows a rejected page_view tracking call without crashing", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);
    vi.mocked(apiModule.trackClientEvent).mockRejectedValueOnce(
      new Error("network down"),
    );

    renderLayoutAt("/");

    await waitFor(() => {
      expect(apiModule.trackClientEvent).toHaveBeenCalled();
    });

    // Still fully rendered, no unhandled crash.
    expect(screen.getByText("Home stub")).toBeDefined();
  });

  it("signs the user out and navigates home when Sign out is clicked", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);

    renderLayoutAt("/dashboard");

    await waitFor(() => {
      expect(apiModule.trackClientEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "page_view" }),
      );
    });

    vi.mocked(apiModule.trackClientEvent).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /Sign out/i }));

    await waitFor(() => {
      expect(apiModule.trackClientEvent).toHaveBeenCalledWith({
        eventType: "auth_logout",
        content: "logout",
      });
      expect(firebaseModule.signOutCurrentUser).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Home stub")).toBeDefined();
    });
  });

  it("still signs out and navigates home when the logout tracking call rejects", async () => {
    vi.mocked(authModule.useAuth).mockReturnValue({ uid: "u1" } as any);
    vi.mocked(apiModule.trackClientEvent).mockRejectedValue(
      new Error("logout tracking failed"),
    );

    renderLayoutAt("/dashboard");

    fireEvent.click(screen.getByRole("button", { name: /Sign out/i }));

    await waitFor(() => {
      expect(firebaseModule.signOutCurrentUser).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Home stub")).toBeDefined();
    });
  });

  it("renders the brand link, primary nav, and footer copy", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    renderLayoutAt("/");

    expect(screen.getByRole("link", { name: /Study Flow/i })).toBeDefined();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
    expect(
      screen.getByText(/persistent misconception graph/i),
    ).toBeDefined();
  });
});
