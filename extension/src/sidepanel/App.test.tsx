import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { installChromeStub, renderWithRouter } from "./test-utils";

const { authState } = vi.hoisted(() => ({
  authState: { user: undefined as unknown },
}));

vi.mock("../lib/auth", () => ({
  useAuth: () => authState.user,
}));

vi.mock("./Shell", () => ({
  Shell: ({ children }: { children: ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("./pages/Hub", () => ({ Hub: () => <div>hub-page</div> }));
vi.mock("./pages/Ask", () => ({ Ask: () => <div>ask-page</div> }));
vi.mock("./pages/Quiz", () => ({ Quiz: () => <div>quiz-page</div> }));
vi.mock("./pages/Graph", () => ({ Graph: () => <div>graph-page</div> }));
vi.mock("./pages/Course", () => ({ Course: () => <div>course-page</div> }));

describe("App", () => {
  beforeEach(() => {
    authState.user = undefined;
    installChromeStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows Loading while the auth state is resolving", () => {
    authState.user = undefined;
    renderWithRouter(<App />);
    expect(screen.getByText("loading...")).toBeTruthy();
  });

  it("shows SignIn when there is no signed-in user", () => {
    authState.user = null;
    renderWithRouter(<App />);
    expect(screen.getByText("Sign in to Study Flow")).toBeTruthy();
  });

  it("redirects the root route to /home and renders the Hub inside Shell", async () => {
    authState.user = { uid: "u1" };
    renderWithRouter(<App />, { route: "/" });
    expect(await screen.findByText("hub-page")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
  });

  it("redirects an unknown route to /home", async () => {
    authState.user = { uid: "u1" };
    renderWithRouter(<App />, { route: "/does-not-exist" });
    expect(await screen.findByText("hub-page")).toBeTruthy();
  });

  it("renders each known route", async () => {
    authState.user = { uid: "u1" };
    renderWithRouter(<App />, { route: "/quiz" });
    expect(await screen.findByText("quiz-page")).toBeTruthy();
    cleanup();

    renderWithRouter(<App />, { route: "/ask" });
    expect(await screen.findByText("ask-page")).toBeTruthy();
    cleanup();

    renderWithRouter(<App />, { route: "/graph" });
    expect(await screen.findByText("graph-page")).toBeTruthy();
    cleanup();

    renderWithRouter(<App />, { route: "/course" });
    expect(await screen.findByText("course-page")).toBeTruthy();
  });

  it("navigates to /ask when session storage has a pending navigateTo", async () => {
    authState.user = { uid: "u1" };
    installChromeStub({ session: { navigateTo: "ask" } });
    renderWithRouter(<App />, { route: "/home" });
    expect(await screen.findByText("ask-page")).toBeTruthy();
  });

  it("navigates to /quiz when session storage has a pending navigateTo", async () => {
    authState.user = { uid: "u1" };
    installChromeStub({ session: { navigateTo: "quiz" } });
    renderWithRouter(<App />, { route: "/home" });
    expect(await screen.findByText("quiz-page")).toBeTruthy();
  });

  it("navigates to /home when session storage has a pending navigateTo of home", async () => {
    authState.user = { uid: "u1" };
    installChromeStub({ session: { navigateTo: "home" } });
    renderWithRouter(<App />, { route: "/quiz" });
    expect(await screen.findByText("hub-page")).toBeTruthy();
  });

  it("does nothing for an unrecognized navigateTo value", async () => {
    authState.user = { uid: "u1" };
    installChromeStub({ session: { navigateTo: "somewhere-else" } });
    renderWithRouter(<App />, { route: "/home" });
    expect(await screen.findByText("hub-page")).toBeTruthy();
  });

  it("reacts to a storage change event and consumes the new navigateTo", async () => {
    authState.user = { uid: "u1" };
    const chromeStub = installChromeStub();
    renderWithRouter(<App />, { route: "/home" });
    await screen.findByText("hub-page");

    chromeStub.storage.session.data.navigateTo = "quiz";
    chromeStub.storage.onChanged._fire({ navigateTo: { newValue: "quiz" } }, "session");

    expect(await screen.findByText("quiz-page")).toBeTruthy();
  });

  it("ignores a storage change event from a different storage area", async () => {
    authState.user = { uid: "u1" };
    const chromeStub = installChromeStub();
    renderWithRouter(<App />, { route: "/home" });
    await screen.findByText("hub-page");

    chromeStub.storage.local.data.navigateTo = "quiz";
    chromeStub.storage.onChanged._fire({ navigateTo: { newValue: "quiz" } }, "local");

    await waitFor(() => expect(screen.getByText("hub-page")).toBeTruthy());
  });

  it("ignores a storage change event with no new navigateTo value", async () => {
    authState.user = { uid: "u1" };
    const chromeStub = installChromeStub();
    renderWithRouter(<App />, { route: "/home" });
    await screen.findByText("hub-page");

    chromeStub.storage.onChanged._fire({ someOtherKey: { newValue: "x" } }, "session");

    await waitFor(() => expect(screen.getByText("hub-page")).toBeTruthy());
  });

  it("swallows an error from chrome.storage.session.get without crashing", async () => {
    authState.user = { uid: "u1" };
    const chromeStub = installChromeStub();
    chromeStub.storage.session.get.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    renderWithRouter(<App />, { route: "/home" });
    expect(await screen.findByText("hub-page")).toBeTruthy();
  });

  it("removes the storage listener on unmount", async () => {
    authState.user = { uid: "u1" };
    const chromeStub = installChromeStub();
    const { unmount } = renderWithRouter(<App />, { route: "/home" });
    await screen.findByText("hub-page");
    unmount();
    expect(chromeStub.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
  });
});
