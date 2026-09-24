import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { Hub } from "./Hub";
import { renderWithRouter } from "../test-utils";

const { apiFetchParsedMock } = vi.hoisted(() => ({ apiFetchParsedMock: vi.fn() }));

vi.mock("../../lib/api", () => ({ apiFetchParsed: apiFetchParsedMock }));

describe("Hub", () => {
  beforeEach(() => {
    apiFetchParsedMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a loading spinner in the drill queue while data is in flight", () => {
    apiFetchParsedMock.mockReturnValue(new Promise(() => {}));
    renderWithRouter(<Hub />);
    expect(screen.getByText("Due for review")).toBeTruthy();
    expect(document.querySelector(".spinner")).not.toBeNull();
  });

  it("renders gamification stats and the drill queue once both requests resolve", async () => {
    apiFetchParsedMock.mockImplementation((path) => {
      if (path === "/api/v1/quiz/queue") {
        return Promise.resolve({
          queue: [
            { conceptNode: "chain_rule", accuracyRate: 0.42 },
            { conceptNode: "limits_basic" },
          ],
        });
      }
      return Promise.resolve({ level: 3, streak: 5 });
    });

    renderWithRouter(<Hub />);

    expect(await screen.findByText("chain rule")).toBeTruthy();
    expect(screen.getByText("(42% accuracy)")).toBeTruthy();
    expect(screen.getByText("limits basic")).toBeTruthy();
    expect(screen.getByText("(0% accuracy)")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText(/5/)).toBeTruthy();
  });

  it("caps the drill queue preview at 5 items", async () => {
    apiFetchParsedMock.mockImplementation((path) => {
      if (path === "/api/v1/quiz/queue") {
        return Promise.resolve({
          queue: Array.from({ length: 8 }, (_, i) => ({
            conceptNode: `topic_${i}`,
            accuracyRate: 0.5,
          })),
        });
      }
      return Promise.resolve(null);
    });

    renderWithRouter(<Hub />);

    expect(await screen.findByText("topic 0")).toBeTruthy();
    expect(screen.queryByText("topic 5")).toBeNull();
  });

  it("defaults to an empty queue when the response has no queue field", async () => {
    apiFetchParsedMock.mockImplementation((path) => {
      if (path === "/api/v1/quiz/queue") return Promise.resolve({});
      return Promise.resolve({ level: 1, streak: 0 });
    });

    renderWithRouter(<Hub />);
    expect(await screen.findByText(/No concepts tracked yet/)).toBeTruthy();
  });

  it("shows the empty-queue message and skips the gamification block when there is no data", async () => {
    apiFetchParsedMock.mockResolvedValue(null);
    renderWithRouter(<Hub />);
    expect(await screen.findByText(/No concepts tracked yet/)).toBeTruthy();
    expect(screen.queryByText("Level")).toBeNull();
  });

  it("silently tolerates the drill queue or gamification request failing", async () => {
    apiFetchParsedMock.mockImplementation((path) => {
      if (path === "/api/v1/quiz/queue") return Promise.reject(new Error("queue down"));
      return Promise.reject(new Error("gamification down"));
    });

    renderWithRouter(<Hub />);
    expect(await screen.findByText(/No concepts tracked yet/)).toBeTruthy();
  });

  it("links to the Ask and Quiz routes", () => {
    apiFetchParsedMock.mockReturnValue(new Promise(() => {}));
    renderWithRouter(<Hub />);
    expect(screen.getByText("Ask").getAttribute("href")).toBe("/ask");
    expect(screen.getByText("Quiz").getAttribute("href")).toBe("/quiz");
  });
});
