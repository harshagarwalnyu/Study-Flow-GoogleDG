import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MathRenderer } from "./MathRenderer";

describe("MathRenderer", () => {
  it("renders markdown text content", () => {
    render(<MathRenderer text="Hello **world**" />);
    const strong = screen.getByText("world");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders an inline math expression via KaTeX", () => {
    render(<MathRenderer text="The value is $x^2$ today." />);
    // KaTeX renders the formula into its own markup; the surrounding text stays plain.
    const paragraph = screen.getByText(/The value is/).closest("p");
    expect(paragraph?.querySelector(".katex")).not.toBeNull();
  });

  it("renders nothing but does not crash for an empty string", () => {
    const { container } = render(<MathRenderer text="" />);
    expect(container.textContent).toBe("");
  });
});
