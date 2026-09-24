import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome, type FakeChrome } from "./lib/test-chrome";
import { STORAGE_KEYS } from "./lib/messages";

const backgroundRuntimeMock = vi.hoisted(() => ({
  handleExtensionMessage: vi.fn(),
  createMessageErrorResponse: vi.fn((err: unknown) => ({ ok: false, error: String(err) })),
}));
vi.mock("./lib/background-runtime", () => backgroundRuntimeMock);

const drillNudgeMock = vi.hoisted(() => ({
  DRILL_NUDGE_ALARM: "drill-nudge",
  DRILL_NUDGE_PERIOD_MINUTES: 60,
  refreshDrillBadge: vi.fn(async () => 2),
}));
vi.mock("./lib/drill-nudge", () => drillNudgeMock);

const originalWebUrl = import.meta.env.VITE_WEB_URL;
const originalMode = import.meta.env.MODE;

describe("background.ts entry module", () => {
  let fakeChrome: FakeChrome;

  beforeEach(() => {
    vi.resetModules();
    backgroundRuntimeMock.handleExtensionMessage.mockReset();
    backgroundRuntimeMock.handleExtensionMessage.mockResolvedValue({ ok: true });
    backgroundRuntimeMock.createMessageErrorResponse.mockClear();
    drillNudgeMock.refreshDrillBadge.mockReset();
    drillNudgeMock.refreshDrillBadge.mockResolvedValue(2);
    fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (import.meta.env as any).VITE_WEB_URL = originalWebUrl;
    (import.meta.env as any).MODE = originalMode;
  });

  it("defaults the runtime mode to 'development' when Vite's MODE is falsy", async () => {
    (import.meta.env as any).MODE = "";
    await import("./background");

    fakeChrome.alarms.onAlarm.emit({ name: "drill-nudge" });
    await Promise.resolve();

    expect(drillNudgeMock.refreshDrillBadge).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "development" }),
    );
  });

  it("registers every top-level listener and configures the side panel eagerly on import", async () => {
    await import("./background");

    expect(fakeChrome.alarms.onAlarm.listeners.size).toBe(1);
    expect(fakeChrome.storage.onChanged.listeners.size).toBe(1);
    expect(fakeChrome.runtime.onInstalled.listeners.size).toBe(1);
    expect(fakeChrome.runtime.onStartup.listeners.size).toBe(1);
    expect(fakeChrome.action.onClicked.listeners.size).toBe(1);
    expect(fakeChrome.runtime.onMessage.listeners.size).toBe(1);
    expect(fakeChrome.runtime.onMessageExternal.listeners.size).toBe(1);
    expect(fakeChrome.sidePanel.setOptions).toHaveBeenCalledWith({ path: "sidepanel.html", enabled: true });
    expect(fakeChrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it("skips setPanelBehavior gracefully when the browser doesn't support it", async () => {
    (fakeChrome.sidePanel as any).setPanelBehavior = undefined;

    await import("./background");

    expect(fakeChrome.sidePanel.setOptions).toHaveBeenCalledWith({ path: "sidepanel.html", enabled: true });
  });

  it("onInstalled re-configures the side panel and (re)schedules the drill nudge alarm", async () => {
    await import("./background");
    fakeChrome.sidePanel.setOptions.mockClear();
    fakeChrome.alarms.create.mockClear();

    fakeChrome.runtime.onInstalled.emit();

    expect(fakeChrome.sidePanel.setOptions).toHaveBeenCalledTimes(1);
    expect(fakeChrome.alarms.create).toHaveBeenCalledWith("drill-nudge", { periodInMinutes: 60, delayInMinutes: 1 });
  });

  it("onStartup re-configures the side panel and (re)schedules the drill nudge alarm", async () => {
    await import("./background");
    fakeChrome.sidePanel.setOptions.mockClear();
    fakeChrome.alarms.create.mockClear();

    fakeChrome.runtime.onStartup.emit();

    expect(fakeChrome.sidePanel.setOptions).toHaveBeenCalledTimes(1);
    expect(fakeChrome.alarms.create).toHaveBeenCalledWith("drill-nudge", { periodInMinutes: 60, delayInMinutes: 1 });
  });

  it("refreshes the drill badge only when the drill-nudge alarm fires", async () => {
    await import("./background");

    fakeChrome.alarms.onAlarm.emit({ name: "drill-nudge" });
    expect(drillNudgeMock.refreshDrillBadge).toHaveBeenCalledTimes(1);

    fakeChrome.alarms.onAlarm.emit({ name: "some-other-alarm" });
    expect(drillNudgeMock.refreshDrillBadge).toHaveBeenCalledTimes(1);
  });

  it("refreshes the drill badge only for a session-area firebaseIdToken change", async () => {
    await import("./background");

    fakeChrome.storage.onChanged.emit({ [STORAGE_KEYS.firebaseIdToken]: { newValue: "x" } }, "session");
    expect(drillNudgeMock.refreshDrillBadge).toHaveBeenCalledTimes(1);

    fakeChrome.storage.onChanged.emit({ [STORAGE_KEYS.firebaseIdToken]: { newValue: "x" } }, "local");
    fakeChrome.storage.onChanged.emit({ someOtherKey: { newValue: "x" } }, "session");
    expect(drillNudgeMock.refreshDrillBadge).toHaveBeenCalledTimes(1);
  });

  it("action.onClicked opens the side panel when the clicked tab has a windowId", async () => {
    await import("./background");
    fakeChrome.sidePanel.setOptions.mockClear();

    fakeChrome.action.onClicked.emit({ windowId: 7 });
    await Promise.resolve();

    expect(fakeChrome.sidePanel.setOptions).toHaveBeenCalledTimes(1);
    expect(fakeChrome.sidePanel.open).toHaveBeenCalledWith({ windowId: 7 });
  });

  it("action.onClicked does nothing when the clicked tab has no windowId", async () => {
    await import("./background");
    fakeChrome.sidePanel.open.mockClear();

    fakeChrome.action.onClicked.emit({});

    expect(fakeChrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it("action.onClicked swallows a rejected sidePanel.open() without throwing", async () => {
    await import("./background");
    fakeChrome.sidePanel.open.mockImplementationOnce(() => Promise.reject(new Error("not a user gesture")));

    expect(() => fakeChrome.action.onClicked.emit({ windowId: 3 })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("onMessage: resolves through handleExtensionMessage and calls sendResponse, keeping the channel open", async () => {
    await import("./background");
    backgroundRuntimeMock.handleExtensionMessage.mockResolvedValueOnce({ ok: true });
    const sendResponse = vi.fn();

    const [keepOpen] = fakeChrome.runtime.onMessage.emit({ type: "OPEN_QUIZ" }, { tab: { windowId: 1 } }, sendResponse);
    expect(keepOpen).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("onMessage: converts a handleExtensionMessage rejection into an error response", async () => {
    await import("./background");
    backgroundRuntimeMock.handleExtensionMessage.mockRejectedValueOnce(new Error("boom"));
    const sendResponse = vi.fn();

    fakeChrome.runtime.onMessage.emit({ type: "OPEN_QUIZ" }, {}, sendResponse);

    await Promise.resolve();
    await Promise.resolve();
    expect(backgroundRuntimeMock.createMessageErrorResponse).toHaveBeenCalledWith(new Error("boom"));
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Error: boom" });
  });

  describe("onMessageExternal (AUTH_FROM_WEB bridge)", () => {
    const allowedSender = { url: "http://localhost:5173/bridge" };

    it("ignores messages that are not AUTH_FROM_WEB", async () => {
      await import("./background");
      const sendResponse = vi.fn();

      const [handled] = fakeChrome.runtime.onMessageExternal.emit({ type: "SOMETHING_ELSE" }, allowedSender, sendResponse);

      expect(handled).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("rejects a request with no sender URL", async () => {
      await import("./background");
      const sendResponse = vi.fn();

      const [handled] = fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "t", user: {} },
        {},
        sendResponse,
      );

      expect(handled).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Unauthorized sender." });
    });

    it("rejects a request from a disallowed origin", async () => {
      await import("./background");
      const sendResponse = vi.fn();

      fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "t", user: {} },
        { url: "https://evil.example/bridge" },
        sendResponse,
      );

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Unauthorized sender." });
    });

    it("treats a malformed sender URL as unauthorized (URL parsing failure)", async () => {
      await import("./background");
      const sendResponse = vi.fn();

      fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "t", user: {} },
        { url: "not a url" },
        sendResponse,
      );

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Unauthorized sender." });
    });

    it("still rejects unauthorized senders when VITE_WEB_URL itself is malformed (covers its own catch)", async () => {
      (import.meta.env as any).VITE_WEB_URL = "://not-a-valid-url";
      await import("./background");
      const sendResponse = vi.fn();

      fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "t", user: {} },
        { url: "https://evil.example/bridge" },
        sendResponse,
      );

      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Unauthorized sender." });
    });

    it("falls back to the default web app URL when VITE_WEB_URL is not configured", async () => {
      (import.meta.env as any).VITE_WEB_URL = "";
      await import("./background");
      const sendResponse = vi.fn();

      fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "t", user: { uid: "u1" } },
        { url: "http://localhost:5173" },
        sendResponse,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    it("rejects a request missing the token or user payload", async () => {
      await import("./background");
      const sendResponse = vi.fn();

      const [handled] = fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", user: {} },
        allowedSender,
        sendResponse,
      );

      expect(handled).toBe(false);
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Missing auth payload." });
    });

    it("persists the token/user, clears the signed-out flag, notifies the sidepanel, and keeps the channel open", async () => {
      await import("./background");
      // Notifying the (possibly closed) sidepanel can fail; that failure must be swallowed.
      fakeChrome.runtime.sendMessage.mockImplementationOnce(() => Promise.reject(new Error("no listener")));
      const sendResponse = vi.fn();

      const [handled] = fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "web-token", user: { uid: "u1" } },
        allowedSender,
        sendResponse,
      );
      expect(handled).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fakeChrome.storage.session.state[STORAGE_KEYS.firebaseIdToken]).toBe("web-token");
      expect(fakeChrome.storage.session.state[STORAGE_KEYS.authUser]).toEqual({ uid: "u1" });
      expect(fakeChrome.storage.local.state.extensionSignedOut).toBeUndefined();
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "AUTH_UPDATED" });
    });

    it("reports an error response when persisting the session fails", async () => {
      await import("./background");
      (fakeChrome.storage.session.set as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
        Promise.reject(new Error("storage quota exceeded")),
      );
      const sendResponse = vi.fn();

      fakeChrome.runtime.onMessageExternal.emit(
        { type: "AUTH_FROM_WEB", token: "web-token", user: { uid: "u1" } },
        allowedSender,
        sendResponse,
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(backgroundRuntimeMock.createMessageErrorResponse).toHaveBeenCalledWith(new Error("storage quota exceeded"));
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "Error: storage quota exceeded" });
    });
  });
});
