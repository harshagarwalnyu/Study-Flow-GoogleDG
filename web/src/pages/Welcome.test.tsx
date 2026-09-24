import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import { Welcome } from "./Welcome";

describe("Welcome Page", () => {
  it("renders welcome content and navigation links", () => {
    render(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>
    );

    expect(screen.getByText("Hello!")).toBeDefined();
    expect(screen.getByRole("heading", { name: "You’re in" })).toBeDefined();
    expect(screen.getByText(/Open the extension side panel/i)).toBeDefined();
    expect(screen.getByText(/Side panel: capture, explain, quiz/i)).toBeDefined();

    const downloadLink = screen.getByRole("link", { name: /Get the extension/i });
    expect(downloadLink.getAttribute("href")).toBe("/download");

    const homeLink = screen.getByRole("link", { name: /Home/i });
    expect(homeLink.getAttribute("href")).toBe("/");
  });
});
