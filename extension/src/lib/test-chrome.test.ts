import { describe, expect, it, vi } from "vitest";
import { createFakeChrome } from "./test-chrome";

describe("createFakeChrome: events", () => {
  it("hasListener reports whether a listener is currently registered", () => {
    const fakeChrome = createFakeChrome();
    const listener = vi.fn();

    expect(fakeChrome.runtime.onInstalled.hasListener(listener)).toBe(false);
    fakeChrome.runtime.onInstalled.addListener(listener);
    expect(fakeChrome.runtime.onInstalled.hasListener(listener)).toBe(true);
    fakeChrome.runtime.onInstalled.removeListener(listener);
    expect(fakeChrome.runtime.onInstalled.hasListener(listener)).toBe(false);
  });

  it("emitAsync awaits every listener's return value, in registration order", async () => {
    const fakeChrome = createFakeChrome();
    const order: string[] = [];
    fakeChrome.alarms.onAlarm.addListener(async (alarm) => {
      await Promise.resolve();
      order.push(`first:${alarm.name}`);
      return "first-result";
    });
    fakeChrome.alarms.onAlarm.addListener((alarm) => {
      order.push(`second:${alarm.name}`);
      return "second-result";
    });

    const results = await fakeChrome.alarms.onAlarm.emitAsync({ name: "drill-nudge" });

    expect(results).toEqual(["first-result", "second-result"]);
    expect(order).toEqual(["first:drill-nudge", "second:drill-nudge"]);
  });
});

describe("createFakeChrome: storage areas", () => {
  it("get() supports chrome's {key: default} calling convention, filling in defaults for missing keys", async () => {
    const fakeChrome = createFakeChrome({ storage: { local: { apiUrl: "http://stored" } } });

    const result = await fakeChrome.storage.local.get({ apiUrl: "http://default", otherKey: "fallback" });

    expect(result).toEqual({ apiUrl: "http://stored", otherKey: "fallback" });
  });

  it("get() supports the callback calling convention (deferred, like real chrome.storage)", async () => {
    const fakeChrome = createFakeChrome({ storage: { session: { firebaseIdToken: "tok" } } });
    const callback = vi.fn();

    const returnValue = fakeChrome.storage.session.get(["firebaseIdToken"], callback);

    expect(returnValue).toBeUndefined();
    expect(callback).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callback).toHaveBeenCalledWith({ firebaseIdToken: "tok" });
  });

  it("get() with no keys argument returns the empty object (keys == null)", async () => {
    const fakeChrome = createFakeChrome({ storage: { local: { apiUrl: "x" } } });

    await expect(fakeChrome.storage.local.get()).resolves.toEqual({});
  });

  it("normalizeKeys (exercised via remove) accepts a plain object of keys, using Object.keys", () => {
    const fakeChrome = createFakeChrome({ storage: { local: { a: 1, b: 2, c: 3 } } });

    // Not a shape chrome's real remove() accepts, but our normalizeKeys helper supports it —
    // covers the `typeof keys === "object"` branch that get()'s own {key: default} handling
    // never reaches (get() intercepts plain objects before normalizeKeys is called).
    fakeChrome.storage.local.remove({ a: true, b: true } as unknown as string[]);

    expect(fakeChrome.storage.local.state).toEqual({ c: 3 });
  });

  it("normalizeKeys falls back to an empty key list for a key shape that is neither null, an array, a string, nor an object", () => {
    const fakeChrome = createFakeChrome({ storage: { local: { a: 1 } } });

    fakeChrome.storage.local.remove(42 as unknown as string);

    expect(fakeChrome.storage.local.state).toEqual({ a: 1 });
  });

  it("set() supports the callback calling convention and still fires onChanged", () => {
    const fakeChrome = createFakeChrome();
    const changesSeen: unknown[] = [];
    fakeChrome.storage.onChanged.addListener((changes, area) => changesSeen.push({ changes, area }));
    const callback = vi.fn();

    const returnValue = fakeChrome.storage.local.set({ apiUrl: "http://new" }, callback);

    expect(returnValue).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fakeChrome.storage.local.state.apiUrl).toBe("http://new");
    expect(changesSeen).toEqual([
      { changes: { apiUrl: { oldValue: undefined, newValue: "http://new" } }, area: "local" },
    ]);
  });

  it("remove() supports the callback calling convention", () => {
    const fakeChrome = createFakeChrome({ storage: { local: { apiUrl: "x" } } });
    const callback = vi.fn();

    const returnValue = fakeChrome.storage.local.remove("apiUrl", callback);

    expect(returnValue).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fakeChrome.storage.local.state.apiUrl).toBeUndefined();
  });

  it("remove() of a key that isn't present does not fire onChanged", () => {
    const fakeChrome = createFakeChrome();
    const listener = vi.fn();
    fakeChrome.storage.onChanged.addListener(listener);

    fakeChrome.storage.local.remove("neverSet");

    expect(listener).not.toHaveBeenCalled();
  });

  it("clear() removes every key and fires onChanged, in both promise and callback form", async () => {
    const fakeChrome = createFakeChrome({ storage: { local: { a: 1, b: 2 } } });
    const listener = vi.fn();
    fakeChrome.storage.onChanged.addListener(listener);

    await fakeChrome.storage.local.clear();
    expect(fakeChrome.storage.local.state).toEqual({});
    expect(listener).toHaveBeenCalledWith({ a: { oldValue: 1 }, b: { oldValue: 2 } }, "local");

    fakeChrome.storage.local.state.c = 3;
    const callback = vi.fn();
    const returnValue = fakeChrome.storage.local.clear(callback);
    expect(returnValue).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(fakeChrome.storage.local.state).toEqual({});
  });

  it("the sync area behaves like local/session and accepts seed data", async () => {
    const fakeChrome = createFakeChrome({ storage: { sync: { theme: "dark" } } });

    await expect(fakeChrome.storage.sync.get(["theme"])).resolves.toEqual({ theme: "dark" });
  });

  it("normalizes a bare string key (not wrapped in an array)", async () => {
    const fakeChrome = createFakeChrome({ storage: { local: { apiUrl: "x" } } });

    await expect(fakeChrome.storage.local.get("apiUrl")).resolves.toEqual({ apiUrl: "x" });
  });
});

describe("createFakeChrome: action, identity, tabs, scripting default stubs", () => {
  it("action badge methods resolve", async () => {
    const fakeChrome = createFakeChrome();

    await expect(fakeChrome.action.setBadgeText({ text: "3" })).resolves.toBeUndefined();
    await expect(fakeChrome.action.setBadgeBackgroundColor({ color: "#000" })).resolves.toBeUndefined();
    await expect(fakeChrome.action.setTitle({ title: "Study Flow" })).resolves.toBeUndefined();
  });

  it("identity.getAuthToken invokes its callback with a fake token", () => {
    const fakeChrome = createFakeChrome();
    const callback = vi.fn();

    fakeChrome.identity.getAuthToken({ interactive: true }, callback);

    expect(callback).toHaveBeenCalledWith("fake-identity-token");
  });

  it("tabs.query defaults to resolving an empty array when not overridden", async () => {
    const fakeChrome = createFakeChrome();

    await expect(fakeChrome.tabs.query()).resolves.toEqual([]);
  });

  it("scripting.executeScript defaults to a single empty-result entry when not overridden", async () => {
    const fakeChrome = createFakeChrome();

    await expect(fakeChrome.scripting.executeScript()).resolves.toEqual([{ result: "" }]);
  });
});
