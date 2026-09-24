import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import React from "react";
import { ProtectedRoute } from "./ProtectedRoute";
import * as authModule from "../lib/auth";

vi.mock("../lib/auth", () => ({
  useAuth: vi.fn(),
}));

describe("ProtectedRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders null while auth state is loading (undefined)", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(undefined as any);

    const { container } = render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      </MemoryRouter>
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Protected Content")).toBeNull();
  });

  it("redirects to /login when user is unauthenticated (null)", () => {
    vi.mocked(authModule.useAuth).mockReturnValue(null);

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <Routes>
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <div>Protected Content</div>
              </ProtectedRoute>
            }
          />
          <Route path="/login" element={<div>Login Page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("Login Page")).toBeDefined();
    expect(screen.queryByText("Protected Content")).toBeNull();
  });

  it("renders children when user is authenticated", () => {
    vi.mocked(authModule.useAuth).mockReturnValue({
      uid: "user-123",
      email: "test@example.com",
    } as any);

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <ProtectedRoute>
          <div>Protected Content</div>
        </ProtectedRoute>
      </MemoryRouter>
    );

    expect(screen.getByText("Protected Content")).toBeDefined();
  });
});
