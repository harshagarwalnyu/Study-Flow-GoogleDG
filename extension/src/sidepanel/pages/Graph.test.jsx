import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Graph } from "./Graph";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("../lib/api", () => ({ apiFetch: apiFetchMock }));

describe("Graph", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a loading state before the graph resolves", () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}));
    render(<Graph />);
    expect(screen.getByText("Loading graph...")).toBeTruthy();
  });

  it("renders concept mastery rows with accuracy buckets and error type labels", async () => {
    apiFetchMock.mockResolvedValue({
      nodes: [
        { conceptNode: "derivatives_chain_rule", accuracyRate: 0.2, dominantErrorType: "knowledge_gap" },
        { conceptNode: "limits_basic", accuracyRate: 0.5, dominantErrorType: "procedural_error" },
        { conceptNode: "integrals_advanced", accuracyRate: 0.9, dominantErrorType: "reasoning_error" },
      ],
    });

    render(<Graph />);

    expect(await screen.findByText("derivatives chain rule")).toBeTruthy();
    expect(screen.getByText("mostly knowledge gaps")).toBeTruthy();
    expect(screen.getByText("mostly procedural slips")).toBeTruthy();
    expect(screen.getByText("mostly reasoning errors")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("90%")).toBeTruthy();
  });

  it("treats a missing accuracyRate as 0 and omits the error tag for an unknown error type", async () => {
    apiFetchMock.mockResolvedValue({
      nodes: [{ conceptNode: "new_topic", dominantErrorType: "totally_unknown" }],
    });

    render(<Graph />);

    expect(await screen.findByText("0%")).toBeTruthy();
    expect(screen.queryByText(/mostly/)).toBeNull();
  });

  it("shows the empty state when there are no tracked concepts", async () => {
    apiFetchMock.mockResolvedValue({ nodes: [] });
    render(<Graph />);
    expect(await screen.findByText(/No concepts tracked yet/)).toBeTruthy();
  });

  it("treats a missing nodes field as an empty list", async () => {
    apiFetchMock.mockResolvedValue({});
    render(<Graph />);
    expect(await screen.findByText(/No concepts tracked yet/)).toBeTruthy();
  });

  it("silently treats a 'No SMG data' error as an empty graph", async () => {
    apiFetchMock.mockRejectedValue(new Error("No SMG data found for this user"));
    render(<Graph />);
    expect(await screen.findByText(/No concepts tracked yet/)).toBeTruthy();
    expect(screen.queryByText("No SMG data found for this user")).toBeNull();
  });

  it("shows an error banner for any other failure", async () => {
    apiFetchMock.mockRejectedValue(new Error("network unreachable"));
    render(<Graph />);
    expect(await screen.findByText("network unreachable")).toBeTruthy();
  });
});
