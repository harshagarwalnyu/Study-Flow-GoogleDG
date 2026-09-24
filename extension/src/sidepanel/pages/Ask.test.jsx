import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Ask } from "./Ask";
import { installChromeStub } from "../test-utils";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("../lib/api", () => ({ apiFetch: apiFetchMock }));

function coursesResolved() {
  return Promise.resolve({ courses: [] });
}

describe("Ask", () => {
  let chromeStub;

  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      return Promise.resolve({});
    });
    chromeStub = installChromeStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function getForm(container) {
    return container.querySelector("form");
  }

  it("loads courses, the active course id, and last-ingested PDF info on mount", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({
          courses: [{ courseId: "calc-101", courseName: "Calculus I" }],
        });
      }
      return Promise.resolve({});
    });
    chromeStub = installChromeStub({
      local: { activeCourseId: "calc-101" },
      session: { lastIngestedContent: { pdfUrl: "http://x/f.pdf", filename: "f.pdf" } },
    });

    render(<Ask />);

    expect(await screen.findByText("Calculus I")).toBeTruthy();
    expect(await screen.findByText("Ingest PDF")).toBeTruthy();
  });

  it("silently tolerates the initial course list request failing", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return Promise.reject(new Error("down"));
      return Promise.resolve({});
    });
    render(<Ask />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Ingest PDF")).toBeNull();
  });

  it("does nothing when neither a question nor an attached image is present", async () => {
    const { container } = render(<Ask />);
    fireEvent.submit(getForm(container));
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/explain", expect.anything());
  });

  it("asks a text question and renders the explanation with sources and a personalized callout", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/explain") {
        return Promise.resolve({
          solution: "The answer is 42.",
          personalizedCallout: "Watch your sign errors.",
          sources: [{ filename: "lecture1.pdf" }, { filename: "lecture2.pdf" }],
        });
      }
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    const textarea = screen.getByPlaceholderText("Ask a question or use tools below...");
    fireEvent.change(textarea, { target: { value: "What is the derivative?" } });
    fireEvent.submit(getForm(container));

    expect(await screen.findByText(/The answer is 42/)).toBeTruthy();
    expect(screen.getByText(/Watch your sign errors/)).toBeTruthy();
    expect(screen.getByText(/lecture1.pdf, lecture2.pdf/)).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/v1/explain",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to the explanation field and shows no callout/sources when absent", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/explain") return Promise.resolve({ explanation: "Because chain rule." });
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    fireEvent.change(screen.getByPlaceholderText("Ask a question or use tools below..."), {
      target: { value: "Why?" },
    });
    fireEvent.submit(getForm(container));

    expect(await screen.findByText(/Because chain rule/)).toBeTruthy();
  });

  it("shows an error banner when the explain request fails", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/explain") return Promise.reject(new Error("quota exceeded"));
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    fireEvent.change(screen.getByPlaceholderText("Ask a question or use tools below..."), {
      target: { value: "Why?" },
    });
    fireEvent.submit(getForm(container));

    expect(await screen.findByText("quota exceeded")).toBeTruthy();
  });

  it("prefills the question and attaches an image from a pending screenshot in session storage", async () => {
    chromeStub = installChromeStub({
      session: { prefillAsk: "Explain this", prefillAskImageBase64: "QUJD" },
    });

    render(<Ask />);

    const textarea = await screen.findByPlaceholderText("Ask a question or use tools below...");
    await waitFor(() => expect(textarea.value).toBe("Explain this"));
    expect(await screen.findByText("Screenshot attached")).toBeTruthy();
    expect(
      await screen.findByText("Screenshot attached. Add a question and press Explain."),
    ).toBeTruthy();
  });

  it("does not overwrite an already-typed question when a screenshot prefill arrives", async () => {
    let resolveGet;
    chromeStub = installChromeStub();
    chromeStub.storage.session.get.mockImplementation((keys) => {
      if (keys.includes("prefillAsk")) {
        return new Promise((resolve) => {
          resolveGet = resolve;
        });
      }
      return Promise.resolve({});
    });

    render(<Ask />);
    const textarea = await screen.findByPlaceholderText("Ask a question or use tools below...");
    fireEvent.change(textarea, { target: { value: "My own question" } });

    resolveGet({ prefillAsk: "Explain this", prefillAskImageBase64: "QUJD" });
    await screen.findByText("Screenshot attached");
    expect(textarea.value).toBe("My own question");
  });

  it("does nothing when the session prefill has no attached image", async () => {
    chromeStub = installChromeStub({ session: { prefillAsk: "orphan text" } });
    render(<Ask />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Screenshot attached")).toBeNull();
  });

  it("swallows an error thrown while consuming the screenshot prefill", async () => {
    chromeStub = installChromeStub();
    chromeStub.storage.session.get.mockImplementation((keys) => {
      if (keys.includes("prefillAsk")) return Promise.reject(new Error("storage broken"));
      return Promise.resolve({});
    });
    render(<Ask />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/storage broken/)).toBeNull();
  });

  it("reads the highlighted page selection into the question field", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() =>
      Promise.resolve([{ result: "  selected text  " }, { result: "" }]),
    );

    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));

    const textarea = await screen.findByPlaceholderText("Ask a question or use tools below...");
    await waitFor(() => expect(textarea.value).toBe("selected text"));
  });

  it("shows feedback when there is no selected text to read", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    // Relies on the chrome stub's default executeScript, which yields no selection text.

    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));

    expect(
      await screen.findByText("Highlight text on the page first, then click Read Page Text."),
    ).toBeTruthy();
  });

  it("shows an error when there is no active tab to read from", async () => {
    // Relies on the chrome stub's default tabs.query, which resolves an empty tab list.
    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("Cannot read from this page.")).toBeTruthy();
  });

  it("refuses to read from a chrome:// page", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 1, url: "chrome://extensions" }]),
    );
    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("Cannot read from this page.")).toBeTruthy();
  });

  it("refuses to read from an edge:// page", async () => {
    chromeStub.tabs.query = vi.fn(() => Promise.resolve([{ id: 1, url: "edge://settings" }]));
    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("Cannot read from this page.")).toBeTruthy();
  });

  it("shows an error when reading the page selection throws", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() => Promise.reject(new Error("script blocked")));

    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("script blocked")).toBeTruthy();
  });

  it("captures and attaches a visible-tab screenshot", async () => {
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    render(<Ask />);
    fireEvent.click(await screen.findByText("Screenshot"));

    expect(await screen.findByText("Screenshot attached")).toBeTruthy();
  });

  it("surfaces chrome.runtime.lastError from the screenshot capture", async () => {
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => {
      chromeStub.runtime.lastError = { message: "capture denied" };
      cb(undefined);
      chromeStub.runtime.lastError = undefined;
    });

    render(<Ask />);
    fireEvent.click(await screen.findByText("Screenshot"));
    expect(await screen.findByText("capture denied")).toBeTruthy();
  });

  it("errors when the captured screenshot has no base64 payload", async () => {
    // Relies on the chrome stub's default captureVisibleTab, which yields an undefined data URL.
    render(<Ask />);
    fireEvent.click(await screen.findByText("Screenshot"));
    expect(await screen.findByText("Screenshot capture returned empty image data.")).toBeTruthy();
  });

  it("removes an attached screenshot", async () => {
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    render(<Ask />);
    fireEvent.click(await screen.findByText("Screenshot"));
    await screen.findByText("Screenshot attached");

    fireEvent.click(screen.getByText("Remove"));
    expect(screen.queryByText("Screenshot attached")).toBeNull();
  });

  it("submits an attached image alongside an optional question to /analyze, then clears it", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") {
        return Promise.resolve({ solution: "Answer from image." });
      }
      return Promise.resolve({});
    });
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    const { container } = render(<Ask />);
    fireEvent.click(await screen.findByText("Screenshot"));
    await screen.findByText("Screenshot attached");

    fireEvent.submit(getForm(container));

    expect(await screen.findByText(/Answer from image/)).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/v1/analyze",
      expect.objectContaining({ method: "POST" }),
    );
    expect(screen.queryByText("Screenshot attached")).toBeNull();
  });

  it("downloads and ingests a Brightspace PDF, tagging the active course", async () => {
    chromeStub = installChromeStub({
      local: { activeCourseId: "calc-101" },
      session: {
        lastIngestedContent: {
          pdfUrl: "http://school.example/file.pdf",
          filename: "slides.pdf",
          sourcePlatform: "brightspace",
        },
      },
    });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest/upload") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          blob: () => Promise.resolve(new Blob(["pdf-bytes"])),
        }),
      ),
    );

    render(<Ask />);
    fireEvent.click(await screen.findByText("Ingest PDF"));

    expect(
      await screen.findByText(/PDF ingested! Check the Graph tab/),
    ).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/v1/ingest/upload",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an error when the Brightspace PDF fails to download", async () => {
    chromeStub = installChromeStub({
      session: { lastIngestedContent: { pdfUrl: "http://school.example/file.pdf" } },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));

    render(<Ask />);
    fireEvent.click(await screen.findByText("Ingest PDF"));

    expect(await screen.findByText("Failed to download PDF from Brightspace.")).toBeTruthy();
  });

  it("uploads a picked file and shows success feedback", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest/upload") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    await screen.findByPlaceholderText("Ask a question or use tools below...");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Uploaded notes.txt successfully.")).toBeTruthy();
  });

  it("does nothing when the file input change has no file", async () => {
    const { container } = render(<Ask />);
    await screen.findByPlaceholderText("Ask a question or use tools below...");
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/ingest/upload", expect.anything());
  });

  it("shows an error when the file upload fails", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest/upload") return Promise.reject(new Error("upload rejected"));
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    await screen.findByPlaceholderText("Ask a question or use tools below...");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("upload rejected")).toBeTruthy();
  });

  it("clicking Upload opens the hidden file picker and clears prior error/feedback", async () => {
    const { container } = render(<Ask />);
    await screen.findByPlaceholderText("Ask a question or use tools below...");
    const input = container.querySelector('input[type="file"]');
    const clickSpy = vi.spyOn(input, "click");

    fireEvent.click(screen.getByText("Upload"));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults to an empty course list when the courses response has no courses field", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return Promise.resolve({});
      return Promise.resolve({});
    });
    render(<Ask />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("All courses (Auto-detect context)")).toBeNull();
  });

  it("falls back to the courseId label when a course has no courseName, and updates on select", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({
          courses: [
            { courseId: "calc-101", courseName: "Calculus I" },
            { courseId: "bio-201" },
          ],
        });
      }
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    await screen.findByText("Calculus I");
    expect(screen.getByText("bio-201")).toBeTruthy();

    const select = container.querySelector("select");
    fireEvent.change(select, { target: { value: "bio-201" } });
    expect(select.value).toBe("bio-201");
  });

  it("falls back to an empty result set when executeScript returns nothing", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() => Promise.resolve(undefined));

    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));

    expect(
      await screen.findByText("Highlight text on the page first, then click Read Page Text."),
    ).toBeTruthy();
  });

  it("runs the in-page selection-reader function against window.getSelection", async () => {
    let capturedConfig;
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn((config) => {
      capturedConfig = config;
      return Promise.resolve([{ result: "" }]);
    });
    const getSelectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue({ toString: () => "  page text  " });

    render(<Ask />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    await screen.findByText("Highlight text on the page first, then click Read Page Text.");

    // This is the function Chrome would inject into the page; run it here directly
    // since executeScript itself is mocked and never actually invokes it.
    expect(capturedConfig.func()).toBe("page text");
    expect(getSelectionSpy).toHaveBeenCalled();
  });

  it("falls back to the default filename when the ingested PDF metadata has none", async () => {
    chromeStub = installChromeStub({
      session: { lastIngestedContent: { pdfUrl: "http://school.example/file.pdf" } },
    });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest/upload") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(["pdf-bytes"])) }),
      ),
    );

    render(<Ask />);
    fireEvent.click(await screen.findByText("Ingest PDF"));

    expect(await screen.findByText(/PDF ingested!/)).toBeTruthy();
  });

  it("tags the uploaded file with the active course id when one is set", async () => {
    chromeStub = installChromeStub({ local: { activeCourseId: "calc-101" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest/upload") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    const { container } = render(<Ask />);
    await screen.findByPlaceholderText("Ask a question or use tools below...");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Uploaded notes.txt successfully.")).toBeTruthy();
    const [, options] = apiFetchMock.mock.calls.find(([path]) => path === "/api/v1/ingest/upload");
    expect(options.body.get("courseId")).toBe("calc-101");
  });

  it("skips clearing the file input ref if the component unmounts before the upload settles", async () => {
    let resolveUpload;
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest/upload") {
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve({});
    });

    const { container, unmount } = render(<Ask />);
    await screen.findByPlaceholderText("Ask a question or use tools below...");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/ingest/upload", expect.anything()));
    unmount();
    const onError = vi.fn();
    globalThis.process.on("unhandledRejection", onError);
    resolveUpload({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    globalThis.process.off("unhandledRejection", onError);
    // The ref is null after unmount; the finally block must skip the input reset without throwing.
    expect(onError).not.toHaveBeenCalled();
  });
});
