/// <reference types="bun-types" />
import { describe, expect, it, vi } from "vitest";
import { badgeTextFor, badgeTitleFor, refreshDrillBadge, type BadgeApi } from "./drill-nudge";
import { STORAGE_KEYS } from "./messages";
import type { StorageAreaLike } from "./chrome-storage";

function storage(state: Record<string, unknown> = {}): StorageAreaLike {
  return {
    get: (keys) => {
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in state).map((k) => [k, state[k]]));
    },
    set: (items) => void Object.assign(state, items),
    remove: () => undefined,
  };
}

function badge(): BadgeApi & { text: string; title: string; color?: string } {
  const b = {
    text: "unset",
    title: "unset",
    color: undefined as string | undefined,
    setBadgeText: ({ text }: { text: string }) => void (b.text = text),
    setBadgeBackgroundColor: ({ color }: { color: string }) => void (b.color = color),
    setTitle: ({ title }: { title: string }) => void (b.title = title),
  };
  return b;
}

const queueResponse = (queue: unknown[]) =>
  new Response(JSON.stringify({ queue }), { status: 200, headers: { "Content-Type": "application/json" } });

describe("badge text", () => {
  it("is empty at zero and caps at 9+", () => {
    expect(badgeTextFor(0)).toBe("");
    expect(badgeTextFor(1)).toBe("1");
    expect(badgeTextFor(9)).toBe("9");
    expect(badgeTextFor(12)).toBe("9+");
    expect(badgeTitleFor(1)).toBe("Study Flow: 1 concept due for review");
    expect(badgeTitleFor(3)).toBe("Study Flow: 3 concepts due for review");
    expect(badgeTitleFor(0)).toBe("Open Study Flow");
  });
});

describe("refreshDrillBadge", () => {
  it("counts only due reviews, with the stored token, against the configured API", async () => {
    const action = badge();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      queueResponse([
        { conceptNode: "chain_rule", urgency: 14, due: true },
        { conceptNode: "limits", urgency: 12, due: true },
        { conceptNode: "new_topic", urgency: 5, due: false },
        { conceptNode: "legacy", urgency: 3 },
      ]),
    );

    const count = await refreshDrillBadge({
      localStorage: storage({ [STORAGE_KEYS.apiUrl]: "http://localhost:3000" }),
      sessionStorage: storage({ [STORAGE_KEYS.firebaseIdToken]: "tok" }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      mode: "development",
      action,
    });

    expect(count).toBe(2);
    expect(action.text).toBe("2");
    expect(action.color).toBe("#0f9f94");
    expect(action.title).toBe("Study Flow: 2 concepts due for review");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://localhost:3000/api/v1/graph/drill");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("clears the badge when signed out, without calling the API", async () => {
    const action = badge();
    const fetchImpl = vi.fn(async () => queueResponse([]));
    const count = await refreshDrillBadge({
      localStorage: storage(),
      sessionStorage: storage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      action,
    });
    expect(count).toBe(0);
    expect(action.text).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears the badge instead of showing a stale count when the request fails", async () => {
    const action = badge();
    const count = await refreshDrillBadge({
      localStorage: storage(),
      sessionStorage: storage({ [STORAGE_KEYS.firebaseIdToken]: "expired" }),
      fetchImpl: (async () => new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 })) as unknown as typeof fetch,
      mode: "development",
      action,
    });
    expect(count).toBe(0);
    expect(action.text).toBe("");
    expect(action.title).toBe("Open Study Flow");
  });
});
