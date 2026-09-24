import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb({ message }: { message?: string }): never {
  throw message === undefined ? new Error() : new Error(message);
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders children when no error has occurred", () => {
    render(
      <ErrorBoundary>
        <div>All good</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("All good")).toBeDefined();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("renders the fallback UI with the error message once a child throws", () => {
    // Silence the expected React error-boundary console.error noise for this test.
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb message="custom failure" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("custom failure")).toBeDefined();
  });

  it("falls back to a generic message when the thrown error has no message", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );

    expect(
      screen.getByText("An unexpected error occurred."),
    ).toBeDefined();
  });

  it("clears the error and re-renders children after clicking Try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    function Toggle({ shouldThrow }: { shouldThrow: boolean }) {
      if (shouldThrow) {
        throw new Error("transient");
      }
      return <div>Recovered</div>;
    }

    const { rerender } = render(
      <ErrorBoundary>
        <Toggle shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeDefined();

    rerender(
      <ErrorBoundary>
        <Toggle shouldThrow={false} />
      </ErrorBoundary>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Recovered")).toBeDefined();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
