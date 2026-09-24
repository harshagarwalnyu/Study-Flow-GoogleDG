import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Loading } from "./Loading";

describe("Loading", () => {
  it("renders a loading indicator with status text", () => {
    render(<Loading />);
    expect(screen.getByText("loading...").textContent).toBe("loading...");
  });
});
