import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { StrictMode } from "react";
import { BrowserRouter } from "react-router-dom";

const { createRootMock, renderMock } = vi.hoisted(() => {
  const renderMock = vi.fn();
  const createRootMock = vi.fn(() => ({ render: renderMock }));
  return { createRootMock, renderMock };
});

vi.mock("react-dom/client", () => ({
  createRoot: createRootMock,
}));

vi.mock("./App", () => ({
  default: function MockApp() {
    return null;
  },
}));

vi.mock("./lib/auth", () => ({
  AuthProvider: function MockAuthProvider({ children }: { children: unknown }) {
    return children;
  },
}));

function collectTypes(node: unknown, acc: unknown[] = []): unknown[] {
  if (node === null || node === undefined) {
    return acc;
  }

  if (Array.isArray(node)) {
    node.forEach((child) => collectTypes(child, acc));
    return acc;
  }

  if (typeof node === "object" && "type" in (node as Record<string, unknown>)) {
    const element = node as { type: unknown; props?: { children?: unknown } };
    acc.push(element.type);
    collectTypes(element.props?.children, acc);
  }

  return acc;
}

describe("main.tsx entry point", () => {
  let getElementByIdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    createRootMock.mockClear();
    renderMock.mockClear();
    getElementByIdSpy = vi.spyOn(document, "getElementById");
  });

  afterEach(() => {
    getElementByIdSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("creates the React root on #root and renders the wrapped App tree", async () => {
    const rootDiv = document.createElement("div");
    getElementByIdSpy.mockReturnValue(rootDiv);

    await import("./main");

    expect(getElementByIdSpy).toHaveBeenCalledWith("root");
    expect(createRootMock).toHaveBeenCalledTimes(1);
    expect(createRootMock).toHaveBeenCalledWith(rootDiv);
    expect(renderMock).toHaveBeenCalledTimes(1);

    const [{ default: App }, { AuthProvider }] = await Promise.all([
      import("./App"),
      import("./lib/auth"),
    ]);

    const renderedTree = renderMock.mock.calls[0][0];
    const types = collectTypes(renderedTree);

    expect(types).toContain(StrictMode);
    expect(types).toContain(BrowserRouter);
    expect(types).toContain(AuthProvider);
    expect(types).toContain(App);
  });

  it("throws when the #root element is missing from the document", async () => {
    getElementByIdSpy.mockReturnValue(null);

    await expect(import("./main")).rejects.toThrow("Root element not found.");
    expect(createRootMock).not.toHaveBeenCalled();
  });
});
