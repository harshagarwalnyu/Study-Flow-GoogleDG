import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import { Download } from "./Download";

describe("Download Page", () => {
  it("renders download instructions and links", () => {
    render(
      <MemoryRouter>
        <Download />
      </MemoryRouter>
    );

    expect(screen.getByText(/Chrome · Manifest V3/i)).toBeDefined();
    expect(screen.getByRole("heading", { name: "Install Study Flow" })).toBeDefined();

    const downloadLink = screen.getByRole("link", { name: /Download extension package/i });
    expect(downloadLink.getAttribute("href")).toContain("/downloads/study-flow-extension.zip");
    expect(downloadLink.getAttribute("download")).toBe("study-flow-extension.zip");

    const loginLink = screen.getByRole("link", { name: /log in on the web/i });
    expect(loginLink.getAttribute("href")).toBe("/login");

    const homeLink = screen.getByRole("link", { name: /← Back to home/i });
    expect(homeLink.getAttribute("href")).toBe("/");
  });
});
