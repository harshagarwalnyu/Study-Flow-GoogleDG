import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";

type StorageData = Record<string, unknown>;
type StorageCallback = (result: StorageData) => void;

/**
 * Mirrors chrome.storage's dual calling convention (callback OR returned
 * promise), and the array/string key forms actually used by the sidepanel.
 */
function makeStorageArea(initial: StorageData = {}) {
  const data: StorageData = { ...initial };
  return {
    data,
    get: vi.fn((keys: string[], cb?: StorageCallback) => {
      const result: StorageData = {};
      for (const key of keys) {
        if (key in data) result[key] = data[key];
      }
      if (typeof cb === "function") {
        cb(result);
        return undefined;
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: StorageData) => {
      Object.assign(data, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
      return Promise.resolve();
    }),
  };
}

export type ChromeStub = {
  storage: {
    local: ReturnType<typeof makeStorageArea>;
    session: ReturnType<typeof makeStorageArea>;
    onChanged: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
      _fire: (changes: Record<string, { newValue?: unknown }>, area: string) => void;
    };
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    captureVisibleTab: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  scripting: {
    executeScript: ReturnType<typeof vi.fn>;
  };
  runtime: {
    id: string;
    lastError: { message: string } | undefined;
    sendMessage: ReturnType<typeof vi.fn>;
  };
};

/** Builds a fresh chrome stub. Call `vi.stubGlobal("chrome", stub)` with the result. */
export function createChromeStub(overrides?: { local?: StorageData; session?: StorageData }): ChromeStub {
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];

  return {
    storage: {
      local: makeStorageArea(overrides?.local),
      session: makeStorageArea(overrides?.session),
      onChanged: {
        addListener: vi.fn((fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
          listeners.push(fn);
        }),
        removeListener: vi.fn((fn: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
          listeners.splice(listeners.indexOf(fn), 1);
        }),
        _fire: (changes, area) => {
          for (const fn of [...listeners]) fn(changes, area);
        },
      },
    },
    tabs: {
      // Ask/Quiz await chrome.tabs.query(...) with no callback; SignIn passes one.
      query: vi.fn((_queryInfo: unknown, cb?: (tabs: unknown[]) => void) => {
        const tabs: unknown[] = [];
        if (typeof cb === "function") {
          cb(tabs);
          return undefined;
        }
        return Promise.resolve(tabs);
      }),
      captureVisibleTab: vi.fn(
        (_windowId: unknown, _options: unknown, cb: (dataUrl: string | undefined) => void) => {
          cb(undefined);
        },
      ),
      update: vi.fn((_tabId: unknown, _props: unknown, cb: (tab: unknown) => void) => {
        cb(undefined);
      }),
      create: vi.fn(),
    },
    scripting: {
      executeScript: vi.fn(() => Promise.resolve([{ result: "" }])),
    },
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
    },
  };
}

export function installChromeStub(overrides?: { local?: StorageData; session?: StorageData }): ChromeStub {
  const stub = createChromeStub(overrides);
  vi.stubGlobal("chrome", stub);
  return stub;
}

export function renderWithRouter(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}
