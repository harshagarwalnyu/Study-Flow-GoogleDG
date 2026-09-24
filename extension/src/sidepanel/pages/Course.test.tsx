import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Course } from "./Course";

const { apiFetchParsedMock } = vi.hoisted(() => ({ apiFetchParsedMock: vi.fn() }));

vi.mock("../../lib/api", () => ({ apiFetchParsed: apiFetchParsedMock }));

describe("Course", () => {
  beforeEach(() => {
    apiFetchParsedMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a loading spinner before the first response arrives", () => {
    apiFetchParsedMock.mockReturnValue(new Promise(() => {}));
    render(<Course />);
    expect(screen.getByText("Loading courses...")).toBeTruthy();
  });

  it("shows the empty state when there are no courses", async () => {
    apiFetchParsedMock.mockResolvedValue({ courses: [] });
    render(<Course />);
    expect(await screen.findByText(/No courses yet/)).toBeTruthy();
  });

  it("defaults to an empty list when the courses field is missing", async () => {
    apiFetchParsedMock.mockResolvedValue({});
    render(<Course />);
    expect(await screen.findByText(/No courses yet/)).toBeTruthy();
  });

  it("shows an error banner when the course list fails to load", async () => {
    apiFetchParsedMock.mockRejectedValue(new Error("courses down"));
    render(<Course />);
    expect(await screen.findByText("courses down")).toBeTruthy();
    expect(screen.queryByText(/No courses yet/)).toBeNull();
  });

  it("renders one card per course and refetches on Refresh", async () => {
    apiFetchParsedMock.mockResolvedValue({
      courses: [{ courseId: "calc-101", courseName: "Calculus I" }],
    });
    render(<Course />);

    expect(await screen.findByText("Calculus I")).toBeTruthy();
    expect(apiFetchParsedMock).toHaveBeenCalledWith("/api/v1/courses", expect.anything());

    fireEvent.click(screen.getByText("Refresh"));
    expect(await screen.findByText("Refreshing...")).toBeTruthy();
  });

  it("falls back to the courseId as the card title when courseName is missing", async () => {
    apiFetchParsedMock.mockResolvedValue({ courses: [{ courseId: "calc-101" }] });
    render(<Course />);
    expect(await screen.findByText("calc-101")).toBeTruthy();
  });

  it("expands a card, fetches details once, and shows ingested docs and chunk count", async () => {
    apiFetchParsedMock.mockImplementation((path: string) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({ courses: [{ courseId: "calc-101", courseName: "Calculus I" }] });
      }
      return Promise.resolve({
        ingestedDocs: [{ fileId: "f1", filename: "notes.pdf" }],
        chunkCount: 12,
      });
    });

    render(<Course />);
    await screen.findByText("Calculus I");

    fireEvent.click(screen.getByText("Details"));
    expect(await screen.findByText("Loading details...")).toBeTruthy();
    expect(await screen.findByText("notes.pdf")).toBeTruthy();
    expect(screen.getByText("12 chunks indexed")).toBeTruthy();
    expect(apiFetchParsedMock).toHaveBeenCalledWith(
      "/api/v1/courses/calc-101",
      expect.anything(),
    );

    // Collapsing and re-expanding must not trigger a second fetch of already-cached details.
    const detailsCallCount = apiFetchParsedMock.mock.calls.filter(
      ([path]) => path === "/api/v1/courses/calc-101",
    ).length;
    fireEvent.click(screen.getByText("Hide"));
    fireEvent.click(screen.getByText("Details"));
    await screen.findByText("notes.pdf");
    const detailsCallCountAfter = apiFetchParsedMock.mock.calls.filter(
      ([path]) => path === "/api/v1/courses/calc-101",
    ).length;
    expect(detailsCallCountAfter).toBe(detailsCallCount);
  });

  it("falls back to the fileId when a doc has no filename, and 0 for a missing chunkCount", async () => {
    apiFetchParsedMock.mockImplementation((path: string) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({ courses: [{ courseId: "calc-101", courseName: "Calculus I" }] });
      }
      return Promise.resolve({ ingestedDocs: [{ fileId: "f1" }] });
    });

    render(<Course />);
    await screen.findByText("Calculus I");
    fireEvent.click(screen.getByText("Details"));

    expect(await screen.findByText("f1")).toBeTruthy();
    expect(screen.getByText("0 chunks indexed")).toBeTruthy();
  });

  it("omits the ingested-docs section when there are none", async () => {
    apiFetchParsedMock.mockImplementation((path: string) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({ courses: [{ courseId: "calc-101", courseName: "Calculus I" }] });
      }
      return Promise.resolve({ ingestedDocs: [], chunkCount: 0 });
    });

    render(<Course />);
    await screen.findByText("Calculus I");
    fireEvent.click(screen.getByText("Details"));

    expect(await screen.findByText("0 chunks indexed")).toBeTruthy();
    expect(screen.queryByText("Ingested Documents")).toBeNull();
  });

  it("shows an error inside the card when fetching details fails", async () => {
    apiFetchParsedMock.mockImplementation((path: string) => {
      if (path === "/api/v1/courses") {
        return Promise.resolve({ courses: [{ courseId: "calc-101", courseName: "Calculus I" }] });
      }
      return Promise.reject(new Error("details down"));
    });

    render(<Course />);
    await screen.findByText("Calculus I");
    fireEvent.click(screen.getByText("Details"));

    expect(await screen.findByText("details down")).toBeTruthy();
  });
});
