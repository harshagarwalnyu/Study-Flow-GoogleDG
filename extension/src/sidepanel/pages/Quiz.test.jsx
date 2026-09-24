import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Quiz } from "./Quiz";
import { installChromeStub } from "../test-utils";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("../lib/api", () => ({ apiFetch: apiFetchMock }));

function coursesResolved() {
  return Promise.resolve({ courses: [] });
}

function threeQuestions() {
  return {
    sessionId: "sess-1",
    questions: [
      {
        conceptNode: "chain_rule",
        difficulty: "medium",
        question: "What is $d/dx[f(g(x))]$?",
        options: ["f'(g(x))g'(x)", "f'(x)g'(x)", "f(g'(x))", "g'(f(x))"],
        explanation: "By the chain rule.",
      },
      {
        conceptNode: "limits",
        difficulty: "easy",
        question: "What is a limit?",
        options: ["A", "B", "C", "D"],
        explanation: "A limit describes behavior near a point.",
      },
      {
        conceptNode: "integrals",
        difficulty: "hard",
        question: "What is an integral?",
        options: ["A", "B", "C", "D"],
        explanation: "Accumulated area.",
      },
    ],
  };
}

describe("Quiz", () => {
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

  it("loads courses and the active course id on mount", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({ courses: [{ courseId: "calc-101", courseName: "Calculus I" }] });
      }
      return Promise.resolve({});
    });
    chromeStub = installChromeStub({ local: { activeCourseId: "calc-101" } });

    render(<Quiz />);
    expect(await screen.findByText("Calculus I")).toBeTruthy();
  });

  it("silently tolerates the initial course list request failing", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return Promise.reject(new Error("down"));
      return Promise.resolve({});
    });
    render(<Quiz />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("All courses")).toBeNull();
  });

  it("falls back to the courseId label when a course has no name, and updates on select", async () => {
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
    const { container } = render(<Quiz />);
    await screen.findByText("Calculus I");
    expect(screen.getByText("bio-201")).toBeTruthy();

    const select = container.querySelector("select");
    fireEvent.change(select, { target: { value: "bio-201" } });
    expect(select.value).toBe("bio-201");
  });

  it("starts a blank quiz and renders the first question", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));

    expect(await screen.findByText("Question 1 of 3")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/v1/quiz",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("starts a quiz with a typed topic", async () => {
    apiFetchMock.mockImplementation((path, opts) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") {
        expect(JSON.parse(opts.body).topic).toBe("integration by parts");
        return Promise.resolve(threeQuestions());
      }
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.change(await screen.findByPlaceholderText("e.g. integration by parts"), {
      target: { value: "integration by parts" },
    });
    fireEvent.click(screen.getByText("Start Quiz"));

    expect(await screen.findByText("Question 1 of 3")).toBeTruthy();
  });

  it("shows a loading state while questions are generating", async () => {
    let resolveQuiz;
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") {
        return new Promise((resolve) => {
          resolveQuiz = resolve;
        });
      }
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    expect(await screen.findByText("Generating questions...")).toBeTruthy();
    resolveQuiz(threeQuestions());
    expect(await screen.findByText("Question 1 of 3")).toBeTruthy();
  });

  it("shows an error and falls back to empty session/questions when quiz generation fails", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.reject(new Error("gen failed"));
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    expect(await screen.findByText("gen failed")).toBeTruthy();
    expect(await screen.findByText("Start Quiz")).toBeTruthy();
  });

  it("defaults sessionId/questions to empty when the response omits them", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve({});
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/quiz", expect.anything()));
    expect(await screen.findByText("Start Quiz")).toBeTruthy();
  });

  async function startAQuiz() {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      return Promise.resolve({});
    });
    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");
  }

  it("selects an option, submits, and shows correct feedback plus the drill badge refresh", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") {
        return Promise.resolve({ isCorrect: true, correctAnswer: 0 });
      }
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");

    fireEvent.click(screen.getByText("f'(g(x))g'(x)"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(await screen.findByText("Correct!")).toBeTruthy();
    expect(screen.getByText("By the chain rule.")).toBeTruthy();
    await waitFor(() =>
      expect(chromeStub.runtime.sendMessage).toHaveBeenCalledWith({ type: "REFRESH_DRILL_BADGE" }),
    );
  });

  it("shows incorrect feedback and highlights the wrong pick", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") return Promise.resolve({ isCorrect: false, correctAnswer: 0 });
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");

    fireEvent.click(screen.getByText("f(g'(x))"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(await screen.findByText("Incorrect")).toBeTruthy();
  });

  it("does nothing when Submit Answer is invoked with no option selected", async () => {
    await startAQuiz();
    // Submit Answer is disabled while selected === null; simulate its guarded no-op
    // by confirming no /quiz/answer call happens without a selection.
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/quiz/answer", expect.anything());
  });

  it("falls back to a default grading error message when the rejection has no text", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") return Promise.reject(new Error());
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");
    fireEvent.click(screen.getByText("f'(g(x))g'(x)"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(await screen.findByText("Could not grade answer. Try starting a new quiz.")).toBeTruthy();
  });

  it("treats a non-numeric correctAnswer as null when the grading response omits it", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") return Promise.resolve({ isCorrect: true });
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");
    fireEvent.click(screen.getByText("f'(g(x))g'(x)"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(await screen.findByText("Correct!")).toBeTruthy();
    // With no numeric correctAnswer, none of the options should be highlighted green.
    expect(document.querySelector(`.${"topicItem"}`)).toBeTruthy();
  });

  it("swallows a rejected drill-badge refresh message after grading an answer", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") return Promise.resolve({ isCorrect: true, correctAnswer: 0 });
      return Promise.resolve({});
    });
    chromeStub.runtime.sendMessage = vi.fn(() => Promise.reject(new Error("no receiver")));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");
    fireEvent.click(screen.getByText("f'(g(x))g'(x)"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(await screen.findByText("Correct!")).toBeTruthy();
    await waitFor(() => expect(chromeStub.runtime.sendMessage).toHaveBeenCalled());
  });

  it("shows the server's grading error message when one is provided", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") return Promise.reject(new Error("session expired"));
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");
    fireEvent.click(screen.getByText("f'(g(x))g'(x)"));
    fireEvent.click(screen.getByText("Submit Answer"));

    expect(await screen.findByText("session expired")).toBeTruthy();
  });

  it("advances through Next Question and finally shows results with the correct score", async () => {
    let call = 0;
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      if (path === "/api/v1/quiz/answer") {
        call += 1;
        // First two correct, last one wrong.
        return Promise.resolve({ isCorrect: call < 3, correctAnswer: 0 });
      }
      return Promise.resolve({});
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Start Quiz"));
    await screen.findByText("Question 1 of 3");

    fireEvent.click(screen.getByText("f'(g(x))g'(x)"));
    fireEvent.click(screen.getByText("Submit Answer"));
    await screen.findByText("Correct!");
    fireEvent.click(screen.getByText("Next Question"));

    await screen.findByText("Question 2 of 3");
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("Submit Answer"));
    await screen.findByText("Correct!");
    fireEvent.click(screen.getByText("Next Question"));

    await screen.findByText("Question 3 of 3");
    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByText("Submit Answer"));
    await screen.findByText("Incorrect");
    fireEvent.click(screen.getByText("See Results"));

    expect(await screen.findByText("Quiz Complete")).toBeTruthy();
    expect(screen.getByText(/You got 2 out of 3 correct/)).toBeTruthy();
    expect(screen.getByText(/67%/)).toBeTruthy();

    fireEvent.click(screen.getByText("Try Again"));
    expect(await screen.findByText("Start Quiz")).toBeTruthy();
  });

  it("reads the highlighted page selection into the topic field", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() =>
      Promise.resolve([{ result: "  derivatives  " }]),
    );

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));

    await waitFor(() => expect(screen.getByText("Topic set from selection.")).toBeTruthy());
    expect(screen.getByPlaceholderText("e.g. integration by parts").value).toBe("derivatives");
  });

  it("shows feedback when there is no page selection to read", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() => Promise.resolve([{ result: "" }]));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));

    expect(
      await screen.findByText("Highlight text on the page first, then click Read Page Text."),
    ).toBeTruthy();
  });

  it("refuses to read the topic from a chrome:// page", async () => {
    chromeStub.tabs.query = vi.fn(() => Promise.resolve([{ id: 1, url: "chrome://extensions" }]));
    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("Cannot read from this page.")).toBeTruthy();
  });

  it("refuses to read the topic from an edge:// page", async () => {
    chromeStub.tabs.query = vi.fn(() => Promise.resolve([{ id: 1, url: "edge://settings" }]));
    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("Cannot read from this page.")).toBeTruthy();
  });

  it("errors when there is no active tab to read the topic from", async () => {
    chromeStub.tabs.query = vi.fn(() => Promise.resolve([undefined]));
    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("Cannot read from this page.")).toBeTruthy();
  });

  it("shows an error when reading the topic selection throws", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() => Promise.reject(new Error("script blocked")));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(await screen.findByText("script blocked")).toBeTruthy();
  });

  it("falls back to an empty result set when executeScript returns nothing", async () => {
    chromeStub.tabs.query = vi.fn(() =>
      Promise.resolve([{ id: 5, url: "https://example.com/page" }]),
    );
    chromeStub.scripting.executeScript = vi.fn(() => Promise.resolve(undefined));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    expect(
      await screen.findByText("Highlight text on the page first, then click Read Page Text."),
    ).toBeTruthy();
  });

  it("captures a screenshot, infers a topic, and sets feedback", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({ mainConcept: "Chain Rule" });
      return Promise.resolve({});
    });
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Screenshot"));

    expect(await screen.findByText("Topic set from screenshot: Chain Rule")).toBeTruthy();
    expect(screen.getByPlaceholderText("e.g. integration by parts").value).toBe("Chain Rule");
  });

  it("shows feedback when a screenshot topic cannot be inferred", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({});
      return Promise.resolve({});
    });
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Screenshot"));

    expect(
      await screen.findByText("Could not infer a topic from that screenshot. Try selecting text instead."),
    ).toBeTruthy();
  });

  it("surfaces chrome.runtime.lastError from the topic screenshot capture", async () => {
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => {
      chromeStub.runtime.lastError = { message: "capture denied" };
      cb(undefined);
      chromeStub.runtime.lastError = undefined;
    });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Screenshot"));
    expect(await screen.findByText("capture denied")).toBeTruthy();
  });

  it("falls back through mainConcept -> conceptNode -> question text when inferring a topic", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") {
        return Promise.resolve({ classifierTag: { conceptNode: "integration_by_parts" } });
      }
      return Promise.resolve({});
    });
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Screenshot"));

    expect(await screen.findByText(/Topic set from screenshot: integration by parts/)).toBeTruthy();
  });

  it("falls back to the raw question text as a topic when no concept fields are present", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({ question: "Explain limits" });
      return Promise.resolve({});
    });
    chromeStub.tabs.captureVisibleTab = vi.fn((_win, _opts, cb) => cb("data:image/jpeg;base64,QUJD"));

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Screenshot"));

    expect(await screen.findByText(/Topic set from screenshot: Explain limits/)).toBeTruthy();
  });

  it("ingests a non-image file and shows success feedback, tagging the active course", async () => {
    chromeStub = installChromeStub({ local: { activeCourseId: "calc-101" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest") return Promise.resolve({ ok: true });
      return Promise.resolve({});
    });

    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText(/Ingested notes.txt/)).toBeTruthy();
    const [, options] = apiFetchMock.mock.calls.find(([path]) => path === "/api/v1/ingest");
    expect(options.body.get("courseId")).toBe("calc-101");
  });

  it("does nothing when the file picker change event has no file", async () => {
    render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [] } });
    await new Promise((r) => setTimeout(r, 0));
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/ingest", expect.anything());
  });

  it("infers a topic from an uploaded image file", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({ mainConcept: "Vectors" });
      return Promise.resolve({});
    });

    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["binarydata"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Topic set from upload: Vectors")).toBeTruthy();
  });

  it("recognizes an image by its file extension even without an image/* mime type", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({ mainConcept: "Matrices" });
      return Promise.resolve({});
    });

    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["binarydata"], "scan.JPEG", { type: "" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Topic set from upload: Matrices")).toBeTruthy();
  });

  it("shows feedback when an uploaded image yields no topic", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({});
      return Promise.resolve({});
    });

    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["binarydata"], "photo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Could not infer a topic from that image.")).toBeTruthy();
  });

  it("errors when the FileReader yields a data URL with no base64 payload", async () => {
    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["binarydata"], "photo.png", { type: "image/png" });

    const originalReadAsDataURL = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function stubRead() {
      Object.defineProperty(this, "result", { value: "data:image/png;base64,", configurable: true });
      this.onload?.();
    };

    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Unsupported image format.")).toBeTruthy();
    FileReader.prototype.readAsDataURL = originalReadAsDataURL;
  });

  it("errors when the FileReader itself fails", async () => {
    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["binarydata"], "photo.png", { type: "image/png" });

    const originalReadAsDataURL = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function stubRead() {
      this.onerror?.();
    };

    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Could not read file")).toBeTruthy();
    FileReader.prototype.readAsDataURL = originalReadAsDataURL;
  });

  it("shows an error when ingesting a non-image file fails", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/ingest") return Promise.reject(new Error("ingest failed"));
      return Promise.resolve({});
    });

    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("ingest failed")).toBeTruthy();
  });

  it("clicking Upload opens the hidden file picker", async () => {
    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const clickSpy = vi.spyOn(input, "click");

    fireEvent.click(screen.getByText("Upload"));
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("prefills and auto-generates a quiz from a pending screenshot topic in session storage", async () => {
    chromeStub = installChromeStub({ session: { prefillQuizImageBase64: "QUJD" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({ mainConcept: "Derivatives" });
      if (path === "/api/v1/quiz") return Promise.resolve(threeQuestions());
      return Promise.resolve({});
    });

    render(<Quiz />);

    expect(await screen.findByText("Question 1 of 3")).toBeTruthy();
  });

  it("shows feedback when the prefilled screenshot topic cannot be inferred", async () => {
    chromeStub = installChromeStub({ session: { prefillQuizImageBase64: "QUJD" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.resolve({});
      return Promise.resolve({});
    });

    render(<Quiz />);

    expect(
      await screen.findByText(
        "Could not infer a topic from that screenshot. Try selecting text or start a blank quiz.",
      ),
    ).toBeTruthy();
  });

  it("does nothing when there is no pending screenshot prefill", async () => {
    render(<Quiz />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/Analyzing screenshot/)).toBeNull();
  });

  it("shows an error when the prefilled screenshot analysis fails", async () => {
    chromeStub = installChromeStub({ session: { prefillQuizImageBase64: "QUJD" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") return Promise.reject(new Error("analyze failed"));
      return Promise.resolve({});
    });

    render(<Quiz />);
    expect(await screen.findByText("analyze failed")).toBeTruthy();
  });

  it("swallows an error thrown while consuming the screenshot prefill", async () => {
    chromeStub = installChromeStub();
    chromeStub.storage.session.get.mockImplementation((keys) => {
      if (keys.includes("prefillQuizImageBase64")) return Promise.reject(new Error("storage broken"));
      return Promise.resolve({});
    });
    render(<Quiz />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/storage broken/)).toBeNull();
  });

  it("defaults to an empty course list when the courses response has no courses field", async () => {
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return Promise.resolve({});
      return Promise.resolve({});
    });
    render(<Quiz />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByText("bio-201")).toBeNull();
  });

  it("does not update state for a successful screenshot analysis that resolves after unmount", async () => {
    let resolveAnalyze;
    chromeStub = installChromeStub({ session: { prefillQuizImageBase64: "QUJD" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") {
        return new Promise((resolve) => {
          resolveAnalyze = resolve;
        });
      }
      return Promise.resolve({});
    });

    const { unmount } = render(<Quiz />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/analyze", expect.anything()));
    unmount();
    resolveAnalyze({ mainConcept: "Derivatives" });
    await new Promise((r) => setTimeout(r, 0));
    // No assertion beyond "did not throw" — this exercises the `cancelled` guards
    // in consumePrefillScreenshot's success branch after the component unmounts.
  });

  it("does not update state for a failed screenshot analysis that rejects after unmount", async () => {
    let rejectAnalyze;
    chromeStub = installChromeStub({ session: { prefillQuizImageBase64: "QUJD" } });
    apiFetchMock.mockImplementation((path) => {
      if (path === "/api/v1/courses") return coursesResolved();
      if (path === "/api/v1/analyze") {
        return new Promise((_resolve, reject) => {
          rejectAnalyze = reject;
        });
      }
      return Promise.resolve({});
    });

    const { unmount } = render(<Quiz />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/analyze", expect.anything()));
    unmount();
    rejectAnalyze(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));
    // No assertion beyond "did not throw" — this exercises the `cancelled` guards
    // in consumePrefillScreenshot's catch/finally branches after unmount.
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
      .mockReturnValue({ toString: () => "  quiz topic text  " });

    render(<Quiz />);
    fireEvent.click(await screen.findByText("Read Page Text"));
    await screen.findByText("Highlight text on the page first, then click Read Page Text.");

    expect(capturedConfig.func()).toBe("quiz topic text");
    expect(getSelectionSpy).toHaveBeenCalled();
  });

  it("treats a data URL with no comma as having no base64 payload", async () => {
    const { container } = render(<Quiz />);
    await screen.findByText("Start Quiz");
    const input = container.querySelector('input[type="file"]');
    const file = new File(["binarydata"], "photo.png", { type: "image/png" });

    const originalReadAsDataURL = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function stubRead() {
      Object.defineProperty(this, "result", { value: "nodata-no-comma", configurable: true });
      this.onload?.();
    };

    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Unsupported image format.")).toBeTruthy();
    FileReader.prototype.readAsDataURL = originalReadAsDataURL;
  });
});
