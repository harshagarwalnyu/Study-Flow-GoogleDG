import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, type FakeChrome } from "./lib/test-chrome";
import { createContentHash } from "./lib/content-runtime";

const ATTR = "data-study-flow-content";
const originalLocation = window.location;
const originalGetSelection = window.getSelection;
const originalTop = window.top;

function stubLocation(url: string) {
  const parsed = new URL(url);
  Object.defineProperty(window, "location", {
    value: { href: parsed.href, origin: parsed.origin, hostname: parsed.hostname, pathname: parsed.pathname },
    configurable: true,
    writable: true,
  });
}

function restoreLocation() {
  Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true });
}

/** Captures the ShadowRoot even though content.ts attaches it with mode "closed". */
function spyOnAttachShadow() {
  return vi.spyOn(Element.prototype, "attachShadow");
}

async function importContent() {
  return import("./content");
}

/**
 * jsdom's built-in localStorage isn't available in this test environment (it warns
 * "not available because --localstorage-file was not provided"), so content.ts's bare
 * `localStorage` global needs a minimal in-memory stand-in.
 */
function createFakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("content.ts entry module", () => {
  let fakeChrome: FakeChrome;
  let fakeLocalStorage: Storage;

  beforeEach(() => {
    vi.resetModules();
    document.documentElement.removeAttribute(ATTR);
    document.body.innerHTML = "";
    document.title = "";
    fakeLocalStorage = createFakeLocalStorage();
    vi.stubGlobal("localStorage", fakeLocalStorage);
    fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreLocation();
    window.getSelection = originalGetSelection;
    Object.defineProperty(window, "top", { value: originalTop, configurable: true, writable: true });
    document.documentElement.removeAttribute(ATTR);
    document.body.innerHTML = "";
  });

  it("does nothing when the page was already injected (double-injection guard)", async () => {
    document.documentElement.setAttribute(ATTR, "1");
    stubLocation("https://school.brightspace.com/d2l/le/content/1/home");

    await importContent();

    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("studyflow-fab-host")).toBeNull();
  });

  it("does nothing inside a non-top frame (e.g. a PDF viewer iframe)", async () => {
    Object.defineProperty(window, "top", { value: {}, configurable: true, writable: true });
    stubLocation("https://school.brightspace.com/d2l/le/content/1/home");

    await importContent();

    expect(document.documentElement.getAttribute(ATTR)).toBe("1");
    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("studyflow-fab-host")).toBeNull();
  });

  it("does nothing on an unsupported platform", async () => {
    stubLocation("https://example.com/somewhere");

    await importContent();

    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("studyflow-fab-host")).toBeNull();
  });

  it("ingests extracted text immediately and shows the Ingested badge", async () => {
    document.body.innerHTML = '<div class="d2l-page-main">Hello Brightspace</div>';
    document.title = "My Course";
    stubLocation("https://school.brightspace.com/d2l/le/content/12345/view");
    const attachShadowSpy = spyOnAttachShadow();

    await importContent();

    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "INGEST_PAGE",
      payload: {
        rawContent: "Hello Brightspace",
        courseName: "brightspace-12345",
        sourcePlatform: "brightspace",
        pdfUrl: undefined,
        filename: undefined,
      },
    });
    expect(fakeLocalStorage.getItem("studyflow_last_hash")).toBe(createContentHash("Hello Brightspace"));

    const shadowRoot = attachShadowSpy.mock.results[0]?.value as ShadowRoot;
    const badge = shadowRoot.querySelector(".badge") as HTMLElement;
    expect(badge.style.display).toBe("block");
    expect(badge.textContent).toBe("Ingested");
  });

  it("skips sending a duplicate ingest when the content hash matches the last stored one", async () => {
    document.body.innerHTML = '<div class="d2l-page-main">Hello Brightspace</div>';
    stubLocation("https://school.brightspace.com/d2l/le/content/12345/view");
    fakeLocalStorage.setItem("studyflow_last_hash", createContentHash("Hello Brightspace"));
    const attachShadowSpy = spyOnAttachShadow();

    await importContent();

    expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    const shadowRoot = attachShadowSpy.mock.results[0]?.value as ShadowRoot;
    const badge = shadowRoot.querySelector(".badge") as HTMLElement;
    expect(badge.style.display).toBe("none");
  });

  it("ingests a detected PDF via INGEST_PDF when there is no extractable text", async () => {
    document.body.innerHTML =
      '<a href="https://school.brightspace.com/DirectFile/9" title="Download notes.pdf"></a>';
    stubLocation("https://school.brightspace.com/d2l/le/content/777/view");

    await importContent();

    expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "INGEST_PDF",
      payload: {
        pdfUrl: "https://school.brightspace.com/DirectFile/9",
        filename: "notes.pdf",
        courseName: "brightspace-777",
        sourcePlatform: "brightspace",
      },
    });
  });

  it("retries via a MutationObserver when no content is found immediately, and disconnects once it succeeds", async () => {
    stubLocation("https://school.brightspace.com/d2l/le/content/42/view");
    vi.useFakeTimers();
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");

    try {
      await importContent();
      expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();

      // A mutation that still doesn't yield content: the observer stays connected.
      const noise = document.createElement("div");
      noise.textContent = "irrelevant";
      document.body.appendChild(noise);
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
      expect(disconnectSpy).not.toHaveBeenCalled();

      // A mutation that adds matching content: tryIngest succeeds and the observer disconnects.
      const content = document.createElement("div");
      content.className = "d2l-page-main";
      content.textContent = "Now there is content";
      document.body.appendChild(content);
      await vi.advanceTimersByTimeAsync(0);

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "INGEST_PAGE",
        payload: {
          rawContent: "Now there is content",
          courseName: "brightspace-42",
          sourcePlatform: "brightspace",
          pdfUrl: undefined,
          filename: undefined,
        },
      });
      expect(disconnectSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-disconnects the observer after 30s if nothing is ever found", async () => {
    stubLocation("https://school.brightspace.com/d2l/le/content/42/view");
    vi.useFakeTimers();
    const disconnectSpy = vi.spyOn(MutationObserver.prototype, "disconnect");

    try {
      await importContent();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(disconnectSpy).toHaveBeenCalled();
      expect(fakeChrome.runtime.sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers mounting the widget and starting the observer until DOMContentLoaded when body is initially absent", async () => {
    stubLocation("https://school.brightspace.com/d2l/le/content/9/view");
    vi.useFakeTimers();
    const originalBody = document.body;
    originalBody.remove();

    try {
      await importContent();
      expect(document.getElementById("studyflow-fab-host")).toBeNull();

      const newBody = document.createElement("body");
      document.documentElement.appendChild(newBody);
      window.dispatchEvent(new Event("DOMContentLoaded"));
      await vi.advanceTimersByTimeAsync(0);

      expect(document.getElementById("studyflow-fab-host")).not.toBeNull();

      // The (now-started) observer still reacts to a matching mutation.
      const content = document.createElement("div");
      content.className = "d2l-page-main";
      content.textContent = "Deferred content";
      document.body.appendChild(content);
      await vi.advanceTimersByTimeAsync(0);

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "INGEST_PAGE" }),
      );
    } finally {
      vi.useRealTimers();
      document.body.innerHTML = "";
    }
  });

  it("the deferred startObserver bails out safely if body is still missing when DOMContentLoaded fires", async () => {
    stubLocation("https://school.brightspace.com/d2l/le/content/9/view");
    document.body.remove();

    await importContent();

    expect(() => window.dispatchEvent(new Event("DOMContentLoaded"))).not.toThrow();
    expect(document.getElementById("studyflow-fab-host")).toBeNull();

    // Restore a body so subsequent tests (and afterEach cleanup) have one to work with.
    const newBody = document.createElement("body");
    document.documentElement.appendChild(newBody);
  });

  describe("floating widget interactions", () => {
    async function setupWidget() {
      document.body.innerHTML = '<div class="d2l-page-main">Widget setup text</div>';
      stubLocation("https://school.brightspace.com/d2l/le/content/1/view");
      const attachShadowSpy = spyOnAttachShadow();
      await importContent();
      const shadowRoot = attachShadowSpy.mock.results[0]?.value as ShadowRoot;
      return {
        shadowRoot,
        fab: shadowRoot.querySelector(".fab") as HTMLButtonElement,
        panel: shadowRoot.querySelector(".panel") as HTMLDivElement,
        buttons: Array.from(shadowRoot.querySelectorAll(".panel button")) as HTMLButtonElement[],
      };
    }

    it("toggles the panel open and closed when the FAB is clicked", async () => {
      const { fab, panel } = await setupWidget();

      fab.click();
      expect(panel.classList.contains("open")).toBe(true);

      fab.click();
      expect(panel.classList.contains("open")).toBe(false);
    });

    it("'Explain this' sends OPEN_ASK_SCREENSHOT with the current selection and closes the panel", async () => {
      const { fab, panel, buttons } = await setupWidget();
      window.getSelection = (() => ({ toString: () => "selected math" })) as unknown as typeof window.getSelection;
      fab.click();

      buttons[0]!.click();

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "OPEN_ASK_SCREENSHOT",
        payload: { selectedText: "selected math" },
      });
      expect(panel.classList.contains("open")).toBe(false);
    });

    it("'Explain this' also falls back to an empty string when there is no selection API", async () => {
      const { fab, panel, buttons } = await setupWidget();
      window.getSelection = (() => null) as unknown as typeof window.getSelection;
      fab.click();

      buttons[0]!.click();

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "OPEN_ASK_SCREENSHOT",
        payload: { selectedText: "" },
      });
      expect(panel.classList.contains("open")).toBe(false);
    });

    it("'Ask me' sends OPEN_ASK_SCREENSHOT and falls back to an empty string when there is no selection API", async () => {
      const { fab, panel, buttons } = await setupWidget();
      window.getSelection = (() => null) as unknown as typeof window.getSelection;
      fab.click();

      buttons[1]!.click();

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "OPEN_ASK_SCREENSHOT",
        payload: { selectedText: "" },
      });
      expect(panel.classList.contains("open")).toBe(false);
    });

    it("'Quiz me' sends OPEN_QUIZ_SCREENSHOT and closes the panel", async () => {
      const { fab, panel, buttons } = await setupWidget();
      fab.click();

      buttons[2]!.click();

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "OPEN_QUIZ_SCREENSHOT" });
      expect(panel.classList.contains("open")).toBe(false);
    });
  });
});
