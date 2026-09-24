import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome } from "./test-chrome";
import { getSelectedTextFromActiveTab } from "./chrome-tabs";

describe("getSelectedTextFromActiveTab", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the empty string when there is no active tab", async () => {
    const fakeChrome = createFakeChrome();
    fakeChrome.tabs.query.mockResolvedValueOnce([]);
    vi.stubGlobal("chrome", fakeChrome);

    await expect(getSelectedTextFromActiveTab()).resolves.toBe("");
    expect(fakeChrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });

  it("executes a script in the active tab and returns the selected text", async () => {
    const fakeChrome = createFakeChrome();
    fakeChrome.tabs.query.mockResolvedValueOnce([{ id: 7 }]);
    // Really invoke the injected `func`, the way chrome would run it in the page context, so the
    // getSelection()-reading closure itself is exercised rather than just asserted about.
    (fakeChrome as any).scripting.executeScript.mockImplementationOnce(async (details: { func: () => string }) => {
      details.func();
      return [{ result: "chain rule" }];
    });
    vi.stubGlobal("chrome", fakeChrome);

    await expect(getSelectedTextFromActiveTab()).resolves.toBe("chain rule");
    expect((fakeChrome as any).scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it("returns the empty string when the executed script yields no result", async () => {
    const fakeChrome = createFakeChrome();
    fakeChrome.tabs.query.mockResolvedValueOnce([{ id: 9 }]);
    (fakeChrome as any).scripting.executeScript.mockResolvedValueOnce([{}]);
    vi.stubGlobal("chrome", fakeChrome);

    await expect(getSelectedTextFromActiveTab()).resolves.toBe("");
  });

  it("the injected page function falls back to an empty string when there is no selection API", async () => {
    const originalGetSelection = window.getSelection;
    (window as unknown as { getSelection: () => null }).getSelection = () => null;

    const fakeChrome = createFakeChrome();
    fakeChrome.tabs.query.mockResolvedValueOnce([{ id: 3 }]);
    let injectedResult: string | undefined;
    (fakeChrome as any).scripting.executeScript.mockImplementationOnce(async (details: { func: () => string }) => {
      injectedResult = details.func();
      return [{ result: injectedResult }];
    });
    vi.stubGlobal("chrome", fakeChrome);

    try {
      await expect(getSelectedTextFromActiveTab()).resolves.toBe("");
      expect(injectedResult).toBe("");
    } finally {
      window.getSelection = originalGetSelection;
    }
  });
});
