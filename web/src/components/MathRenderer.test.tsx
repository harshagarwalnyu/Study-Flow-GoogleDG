import { describe, expect, it, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MathRenderer } from "./MathRenderer";

afterEach(() => {
  cleanup();
});

vi.mock("katex", () => ({
  default: {
    renderToString: vi.fn((latex: string, opts: { displayMode: boolean }) => {
      if (latex === "boom") {
        throw new Error("katex failure");
      }
      return `<span class="katex-mock" data-display="${opts.displayMode}">${latex}</span>`;
    }),
  },
}));

describe("MathRenderer", () => {
  it("renders an empty span when text is undefined", () => {
    const { container } = render(<MathRenderer />);
    expect(container.querySelector("span")?.innerHTML).toBe("");
  });

  it("renders an empty span when text is null", () => {
    const { container } = render(<MathRenderer text={null} />);
    expect(container.querySelector("span")?.innerHTML).toBe("");
  });

  it("renders an empty span when text is an empty string", () => {
    const { container } = render(<MathRenderer text="" />);
    expect(container.querySelector("span")?.innerHTML).toBe("");
  });

  it("renders plain text untouched when there is no math", () => {
    const { container } = render(<MathRenderer text="just plain text" />);
    expect(container.textContent).toBe("just plain text");
    expect(container.querySelector(".katex-mock")).toBeNull();
  });

  it("renders inline math delimited by single $ as KaTeX html", () => {
    const { container } = render(<MathRenderer text="Solve $x^2$ now" />);
    expect(container.textContent).toContain("Solve");
    expect(container.textContent).toContain("now");
    expect(container.textContent).toContain("x^2");
    expect(container.querySelector('[data-display="false"]')).not.toBeNull();
  });

  it("renders display math delimited by $$ inside a block-level wrapper", () => {
    const { container } = render(
      <MathRenderer text="Before $$y=mx+b$$ after" />,
    );

    const displayEl = container.querySelector('[data-display="true"]');
    expect(displayEl).not.toBeNull();
    expect(displayEl?.parentElement?.tagName).toBe("DIV");
    expect(container.textContent).toContain("Before");
    expect(container.textContent).toContain("after");
  });

  it("falls back to the raw delimited text when KaTeX throws", () => {
    const { container } = render(<MathRenderer text="Bad $boom$ math" />);
    expect(container.textContent).toContain("$boom$");
    expect(container.querySelector(".katex-mock")).toBeNull();
  });

  it("renders trailing plain text after the final math segment", () => {
    const { container } = render(<MathRenderer text="$x$ trailing text" />);
    expect(container.textContent).toContain("trailing text");
  });

  it("renders multiple inline math segments in one string", () => {
    const { container } = render(<MathRenderer text="$a$ and $b$" />);
    const rendered = container.querySelectorAll(".katex-mock");
    expect(rendered.length).toBe(2);
    expect(container.textContent).toContain("and");
  });
});
