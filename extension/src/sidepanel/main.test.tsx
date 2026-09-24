import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

vi.mock("./App", () => ({
  App: () => <div>mounted-app</div>,
}));

vi.mock("../lib/auth", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

describe("sidepanel entry point", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("throws when the #root element is missing from the document", async () => {
    await expect(import("./main")).rejects.toThrow("Missing root element");
  });

  it("mounts the App into #root when present", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);

    await import("./main");

    await waitFor(() => expect(root.textContent).toBe("mounted-app"));
  });
});
