import { afterEach, describe, expect, it } from "vitest";
import {
  createContentHash,
  createIngestPayload,
  deriveCourseId,
  detectPdfUrl,
  detectSupportedPlatform,
  extractText,
} from "./content-runtime";

describe("detectSupportedPlatform", () => {
  it("recognizes brightspace and gradescope hostnames, case-insensitively", () => {
    expect(detectSupportedPlatform("mycourse.brightspace.com")).toBe("brightspace");
    expect(detectSupportedPlatform("SCHOOL.BRIGHTSPACE.COM")).toBe("brightspace");
    expect(detectSupportedPlatform("www.gradescope.com")).toBe("gradescope");
  });

  it("returns null for unsupported hostnames", () => {
    expect(detectSupportedPlatform("canvas.instructure.com")).toBeNull();
  });
});

describe("deriveCourseId", () => {
  it("extracts a brightspace course id from /d2l/le/{ouId} paths", () => {
    expect(deriveCourseId("school.brightspace.com", "/d2l/le/123456/home", "fallback")).toBe(
      "brightspace-123456",
    );
  });

  it("extracts a brightspace course id from /d2l/le/content/{ouId} paths", () => {
    expect(
      deriveCourseId("school.brightspace.com", "/d2l/le/content/98765/Home", "fallback"),
    ).toBe("brightspace-98765");
  });

  it("extracts a gradescope course id from /courses/{id} paths", () => {
    expect(deriveCourseId("www.gradescope.com", "/courses/4242/assignments/1", "fallback")).toBe(
      "gradescope-4242",
    );
  });

  it("falls back to the provided fallback when no pattern matches", () => {
    expect(deriveCourseId("example.com", "/nothing/here", "Page Title")).toBe("Page Title");
  });
});

describe("extractText", () => {
  afterEach(() => {
    // jsdom doesn't compute layout-based innerText; undo any manual stub we installed.
    delete (document.body as unknown as { innerText?: string }).innerText;
  });

  it("prefers a selector element's innerText over its textContent when both are present", () => {
    document.body.innerHTML = '<div class="d2l-page-main">textContent value</div>';
    const el = document.querySelector(".d2l-page-main") as HTMLElement;
    Object.defineProperty(el, "innerText", { value: "  innerText value  ", configurable: true });
    expect(extractText(document, "brightspace")).toBe("innerText value");
  });

  it("falls through selectors, and falls back to textContent when innerText is unavailable", () => {
    document.body.innerHTML =
      '<div class="submissionContent"></div><div class="rubricContent">Rubric text</div>';
    expect(extractText(document, "gradescope")).toBe("Rubric text");
  });

  it("skips a selector whose matched element has only whitespace content", () => {
    document.body.innerHTML =
      '<div class="d2l-page-main">   </div><div class="d2l-content-container">Real content</div>';
    expect(extractText(document, "brightspace")).toBe("Real content");
  });

  it("falls back to document.body's innerText when no selector matches and innerText is present", () => {
    document.body.innerHTML = "<p>ignored textContent</p>";
    Object.defineProperty(document.body, "innerText", {
      value: "  Whole page fallback text  ",
      configurable: true,
    });
    expect(extractText(document, "gradescope")).toBe("Whole page fallback text");
  });

  it("returns an empty string when no selector matches and body.innerText is unavailable", () => {
    document.body.innerHTML = "<p>text jsdom won't expose via innerText</p>";
    expect(extractText(document, "brightspace")).toBe("");
  });

  it("returns an empty string when body is empty", () => {
    document.body.innerHTML = "";
    expect(extractText(document, "brightspace")).toBe("");
  });
});

describe("createContentHash", () => {
  it("combines a truncated prefix with the full length", () => {
    expect(createContentHash("short")).toBe("short|5");
    const long = "x".repeat(150);
    expect(createContentHash(long)).toBe(`${"x".repeat(100)}|150`);
  });
});

describe("detectPdfUrl", () => {
  const originalLocation = window.location;

  function stubLocation(url: string) {
    const parsed = new URL(url);
    Object.defineProperty(window, "location", {
      value: { href: parsed.href, origin: parsed.origin, hostname: parsed.hostname, pathname: parsed.pathname },
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(window, "location", { value: originalLocation, configurable: true, writable: true });
  });

  it("brightspace: finds a direct download link first", () => {
    document.body.innerHTML =
      '<a href="https://school.brightspace.com/DirectFile/123" title="Download syllabus.pdf">Download</a>';
    expect(detectPdfUrl(document, "brightspace")).toEqual({
      pdfUrl: "https://school.brightspace.com/DirectFile/123",
      filename: "syllabus.pdf",
    });
  });

  it("brightspace: falls back to a default filename when the title attribute is missing", () => {
    document.body.innerHTML = '<a href="https://school.brightspace.com/DirectFile/9">Download</a>';
    expect(detectPdfUrl(document, "brightspace")).toEqual({
      pdfUrl: "https://school.brightspace.com/DirectFile/9",
      filename: "brightspace-file.pdf",
    });
  });

  it("brightspace: constructs a URL from the lessons/content viewer route", () => {
    document.body.innerHTML = "<div>no download link here</div>";
    stubLocation("https://school.brightspace.com/d2l/le/lessons/111/topics/222");
    expect(detectPdfUrl(document, "brightspace")).toEqual({
      pdfUrl: "https://school.brightspace.com/d2l/le/content/111/topics/files/download/222/DirectFile",
      filename: "brightspace-captured.pdf",
    });
  });

  it("brightspace: falls back to a pdf.js viewer iframe with a file query param", () => {
    document.body.innerHTML =
      '<iframe src="https://school.brightspace.com/pdfjs/web/viewer.html?file=https%3A%2F%2Fcdn.example%2Fnotes.pdf"></iframe>';
    expect(detectPdfUrl(document, "brightspace")).toEqual({
      pdfUrl: "https://cdn.example/notes.pdf",
      filename: "embedded-pdf.pdf",
    });
  });

  it("brightspace: returns null when nothing matches", () => {
    document.body.innerHTML = "<div>nothing here</div>";
    expect(detectPdfUrl(document, "brightspace")).toBeNull();
  });

  it("brightspace: pdf.js iframe present but without a file query param yields no PDF", () => {
    document.body.innerHTML =
      '<iframe src="https://school.brightspace.com/pdfjs/web/viewer.html?other=1"></iframe>';
    expect(detectPdfUrl(document, "brightspace")).toBeNull();
  });

  it("gradescope: finds an S3-style submission upload iframe first", () => {
    document.body.innerHTML =
      '<iframe src="https://gradescope-uploads.s3.amazonaws.com/submission.pdf"></iframe>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://gradescope-uploads.s3.amazonaws.com/submission.pdf",
      filename: "gradescope-submission.pdf",
    });
  });

  it("gradescope: falls back to any iframe with .pdf in its src", () => {
    document.body.innerHTML = '<iframe src="https://cdn.example/handout.pdf"></iframe>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://cdn.example/handout.pdf",
      filename: "gradescope-submission.pdf",
    });
  });

  it("gradescope: falls back to a pdf.js viewer iframe with a file query param", () => {
    // The `.pdf` substring is percent-encoded (%2E for the dot) so this iframe's src does NOT
    // match the earlier `iframe[src*=".pdf"]` selector, exercising the pdf.js-specific branch.
    document.body.innerHTML =
      '<iframe src="https://www.gradescope.com/pdfjs/web/viewer.html?file=https%3A%2F%2Fcdn.example%2Fassignment%2Epdf"></iframe>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://cdn.example/assignment.pdf",
      filename: "gradescope-submission.pdf",
    });
  });

  it("gradescope: pdf.js iframe without a file query param falls through to the direct link check", () => {
    document.body.innerHTML =
      '<iframe src="https://www.gradescope.com/pdfjs/web/viewer.html?other=1"></iframe>' +
      '<a href="https://cdn.example/fallback.pdf"></a>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://cdn.example/fallback.pdf",
      filename: "gradescope.pdf",
    });
  });

  it("gradescope: falls back to a direct .pdf download link, using its text as the filename", () => {
    document.body.innerHTML = '<a href="https://cdn.example/report.pdf">final-report.pdf</a>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://cdn.example/report.pdf",
      filename: "final-report.pdf",
    });
  });

  it("gradescope: prefers the anchor's download attribute over its text", () => {
    document.body.innerHTML =
      '<a href="https://cdn.example/report.pdf" download="attachment.pdf">click here</a>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://cdn.example/report.pdf",
      filename: "attachment.pdf",
    });
  });

  it("gradescope: falls back to a default filename when the link has neither download nor text", () => {
    document.body.innerHTML = '<a href="https://cdn.example/report.pdf"></a>';
    expect(detectPdfUrl(document, "gradescope")).toEqual({
      pdfUrl: "https://cdn.example/report.pdf",
      filename: "gradescope.pdf",
    });
  });

  it("gradescope: returns null when nothing matches", () => {
    document.body.innerHTML = "<div>nothing here</div>";
    expect(detectPdfUrl(document, "gradescope")).toBeNull();
  });
});

describe("createIngestPayload", () => {
  it("builds a payload with the optional pdf fields omitted by default", () => {
    expect(createIngestPayload("raw text", "calc-101", "brightspace")).toEqual({
      rawContent: "raw text",
      courseName: "calc-101",
      sourcePlatform: "brightspace",
      pdfUrl: undefined,
      filename: undefined,
    });
  });

  it("builds a payload including the optional pdf fields when given", () => {
    expect(
      createIngestPayload("raw text", "calc-101", "gradescope", "https://cdn.example/a.pdf", "a.pdf"),
    ).toEqual({
      rawContent: "raw text",
      courseName: "calc-101",
      sourcePlatform: "gradescope",
      pdfUrl: "https://cdn.example/a.pdf",
      filename: "a.pdf",
    });
  });
});
