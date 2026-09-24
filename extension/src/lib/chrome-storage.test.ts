import { describe, expect, it } from "vitest";
import { storageGet, storageRemove, storageSet, type StorageAreaLike } from "./chrome-storage";

function syncArea(initial: Record<string, unknown> = {}): StorageAreaLike & { state: Record<string, unknown> } {
  const state = { ...initial };
  return {
    state,
    get: (keys) => {
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys as object);
      return list.reduce<Record<string, unknown>>((acc, key) => {
        if (key in state) acc[key] = state[key];
        return acc;
      }, {});
    },
    set: (items) => {
      Object.assign(state, items);
    },
    remove: (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

function asyncArea(initial: Record<string, unknown> = {}): StorageAreaLike & { state: Record<string, unknown> } {
  const sync = syncArea(initial);
  return {
    state: sync.state,
    get: async (keys) => sync.get(keys),
    set: async (items) => void sync.set(items),
    remove: async (keys) => void sync.remove(keys),
  };
}

describe("storageGet / storageSet / storageRemove", () => {
  it("reads values through a synchronous storage area", async () => {
    const area = syncArea({ apiUrl: "http://localhost:3000" });
    await expect(storageGet(area, ["apiUrl"])).resolves.toEqual({ apiUrl: "http://localhost:3000" });
  });

  it("reads values through an async (promise-returning) storage area", async () => {
    const area = asyncArea({ apiUrl: "http://localhost:4000" });
    await expect(storageGet(area, "apiUrl")).resolves.toEqual({ apiUrl: "http://localhost:4000" });
  });

  it("writes values via storageSet, synchronous and async areas alike", async () => {
    const sync = syncArea();
    await storageSet(sync, { apiUrl: "http://sync.example" });
    expect(sync.state.apiUrl).toBe("http://sync.example");

    const async_ = asyncArea();
    await storageSet(async_, { apiUrl: "http://async.example" });
    expect(async_.state.apiUrl).toBe("http://async.example");
  });

  it("removes keys via storageRemove, synchronous and async areas alike", async () => {
    const sync = syncArea({ apiUrl: "http://localhost:3000" });
    await storageRemove(sync, "apiUrl");
    expect(sync.state.apiUrl).toBeUndefined();

    const async_ = asyncArea({ apiUrl: "http://localhost:3000" });
    await storageRemove(async_, ["apiUrl"]);
    expect(async_.state.apiUrl).toBeUndefined();
  });
});
