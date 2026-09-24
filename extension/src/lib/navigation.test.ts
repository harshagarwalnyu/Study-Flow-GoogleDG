import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeChrome } from "./test-chrome";
import { STORAGE_KEYS } from "./messages";
import { consumePendingRoute } from "./navigation";

describe("consumePendingRoute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns and consumes a pending quiz route", async () => {
    const fakeChrome = createFakeChrome({ storage: { session: { [STORAGE_KEYS.navigateTo]: "quiz" } } });
    vi.stubGlobal("chrome", fakeChrome);

    await expect(consumePendingRoute()).resolves.toBe("quiz");
    expect(fakeChrome.storage.session.state[STORAGE_KEYS.navigateTo]).toBeUndefined();
  });

  it("returns null and leaves storage untouched when there is no pending quiz route", async () => {
    const fakeChrome = createFakeChrome({ storage: { session: { [STORAGE_KEYS.navigateTo]: "ask" } } });
    vi.stubGlobal("chrome", fakeChrome);

    await expect(consumePendingRoute()).resolves.toBeNull();
    expect(fakeChrome.storage.session.state[STORAGE_KEYS.navigateTo]).toBe("ask");
  });

  it("returns null when nothing is stored at all", async () => {
    const fakeChrome = createFakeChrome();
    vi.stubGlobal("chrome", fakeChrome);

    await expect(consumePendingRoute()).resolves.toBeNull();
  });
});
