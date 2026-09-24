import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SignIn } from "./SignIn";
import { installChromeStub } from "../test-utils";

describe("SignIn", () => {
  let chromeStub;

  beforeEach(() => {
    chromeStub = installChromeStub();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the sign-in prompt", () => {
    render(<SignIn />);
    expect(screen.getByText("Sign in to Study Flow")).toBeTruthy();
    expect(screen.getByText("Login through webpage")).toBeTruthy();
  });

  it("reuses an existing web tab in the current window when one is open", async () => {
    chromeStub.tabs.query.mockImplementationOnce((_info, cb) =>
      cb([{ id: 7, url: "http://localhost:5173/dashboard" }]),
    );

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    await vi.waitFor(() =>
      expect(chromeStub.tabs.update).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ active: true }),
        expect.any(Function),
      ),
    );
    const [, props] = chromeStub.tabs.update.mock.calls[0];
    expect(props.url).toContain("/login?extensionId=test-extension-id");
    expect(chromeStub.storage.local.remove).toHaveBeenCalledWith("extensionSignedOut");
  });

  it("falls back to the active tab when it is a navigable http(s) page", async () => {
    chromeStub.tabs.query
      .mockImplementationOnce((_info, cb) => cb([{ id: 1, url: "https://google.com/search" }]))
      .mockImplementationOnce((_info, cb) => cb([{ id: 9, url: "https://example.com/page" }]));

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    await vi.waitFor(() =>
      expect(chromeStub.tabs.update).toHaveBeenCalledWith(
        9,
        expect.objectContaining({ active: true }),
        expect.any(Function),
      ),
    );
  });

  it("shows an error when there is no existing web tab and the active tab is not navigable", async () => {
    // Both tab queries rely on the chrome stub's default (an empty tab list),
    // so neither an existing web tab nor a navigable active tab is found.

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    expect(await screen.findByText("Open a normal web tab first, then try again.")).toBeTruthy();
  });

  it("treats a tab with no url as neither a web tab nor navigable", async () => {
    chromeStub.tabs.query
      .mockImplementationOnce((_info, cb) => cb([{ id: 3 }]))
      .mockImplementationOnce((_info, cb) => cb([{ id: 3 }]));

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    expect(await screen.findByText("Open a normal web tab first, then try again.")).toBeTruthy();
  });

  it("falls back to an empty tab list when the query callback yields none", async () => {
    chromeStub.tabs.query
      .mockImplementationOnce((_info, cb) => cb(undefined))
      .mockImplementationOnce((_info, cb) => cb(undefined));

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    expect(await screen.findByText("Open a normal web tab first, then try again.")).toBeTruthy();
  });

  it("surfaces chrome.runtime.lastError from the tab query as an Error message", async () => {
    chromeStub.tabs.query.mockImplementationOnce((_info, cb) => {
      chromeStub.runtime.lastError = { message: "permission denied" };
      cb([]);
      chromeStub.runtime.lastError = undefined;
    });

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    expect(await screen.findByText("permission denied")).toBeTruthy();
  });

  it("surfaces chrome.runtime.lastError from the tab update as an Error message", async () => {
    chromeStub.tabs.query.mockImplementationOnce((_info, cb) =>
      cb([{ id: 7, url: "http://localhost:5173/dashboard" }]),
    );
    chromeStub.tabs.update.mockImplementationOnce((_id, _props, cb) => {
      chromeStub.runtime.lastError = { message: "update blocked" };
      cb(undefined);
      chromeStub.runtime.lastError = undefined;
    });

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    expect(await screen.findByText("update blocked")).toBeTruthy();
  });

  it("shows a generic error when a non-Error value is thrown", async () => {
    chromeStub.storage.local.remove.mockImplementationOnce(() => Promise.reject("weird failure"));

    render(<SignIn />);
    fireEvent.click(screen.getByText("Login through webpage"));

    expect(await screen.findByText("Something went wrong.")).toBeTruthy();
  });
});
