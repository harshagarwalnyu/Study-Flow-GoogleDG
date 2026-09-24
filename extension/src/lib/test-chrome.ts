/**
 * A small, reusable fake `chrome` global for tests. Covers the surface actually used by the
 * extension: runtime messaging (including external messages), storage (local/session, with both
 * the promise-based and callback-based calling conventions real `chrome.storage` supports),
 * storage.onChanged, alarms, action badge APIs, identity, sidePanel and tabs/scripting.
 *
 * Usage:
 *   const fakeChrome = createFakeChrome({ storage: { session: { firebaseIdToken: "tok" } } });
 *   vi.stubGlobal("chrome", fakeChrome);
 *   // ...
 *   vi.unstubAllGlobals();
 */
import { vi } from "vitest";

type Listener = (...args: any[]) => any;

export interface FakeEvent<L extends Listener = Listener> {
  addListener: (listener: L) => void;
  removeListener: (listener: L) => void;
  hasListener: (listener: L) => boolean;
  /** Test helper: invoke every registered listener with the given args, sequentially. */
  emit: (...args: Parameters<L>) => Array<ReturnType<L>>;
  /** Test helper: like emit, but awaits any listener return values (for async listeners). */
  emitAsync: (...args: Parameters<L>) => Promise<Array<Awaited<ReturnType<L>>>>;
  listeners: Set<L>;
}

function createFakeEvent<L extends Listener = Listener>(): FakeEvent<L> {
  const listeners = new Set<L>();
  return {
    listeners,
    addListener: vi.fn((listener: L) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: L) => {
      listeners.delete(listener);
    }),
    hasListener: (listener: L) => listeners.has(listener),
    emit: (...args: Parameters<L>) => Array.from(listeners).map((listener) => listener(...args)),
    emitAsync: async (...args: Parameters<L>) => {
      const results: Array<Awaited<ReturnType<L>>> = [];
      for (const listener of listeners) {
        results.push(await listener(...args));
      }
      return results;
    },
  };
}

function normalizeKeys(keys: unknown): string[] {
  if (keys == null) return [];
  if (Array.isArray(keys)) return keys;
  if (typeof keys === "string") return [keys];
  if (typeof keys === "object") return Object.keys(keys as Record<string, unknown>);
  return [];
}

export interface FakeStorageArea {
  get(keys?: unknown, callback?: (items: Record<string, unknown>) => void): Promise<Record<string, unknown>> | undefined;
  set(items: Record<string, unknown>, callback?: () => void): Promise<void> | undefined;
  remove(keys: unknown, callback?: () => void): Promise<void> | undefined;
  clear(callback?: () => void): Promise<void> | undefined;
  /** Test helper: read the live backing state directly. */
  readonly state: Record<string, unknown>;
}

function createFakeStorageArea(
  areaName: string,
  initial: Record<string, unknown>,
  fireChanged: (areaName: string, changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void,
): FakeStorageArea {
  const state: Record<string, unknown> = { ...initial };

  const area: FakeStorageArea = {
    state,
    get: vi.fn((keys?: unknown, callback?: (items: Record<string, unknown>) => void) => {
      const result: Record<string, unknown> = {};
      if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        for (const [key, defaultValue] of Object.entries(keys as Record<string, unknown>)) {
          result[key] = key in state ? state[key] : defaultValue;
        }
      } else {
        for (const key of normalizeKeys(keys)) {
          if (key in state) result[key] = state[key];
        }
      }

      if (callback) {
        // Real chrome.storage callbacks always fire asynchronously; defer via a microtask so
        // tests can exercise "unmounted/disposed before the callback fires" race guards.
        queueMicrotask(() => callback(result));
        return undefined;
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: state[key], newValue: value };
        state[key] = value;
      }
      fireChanged(areaName, changes);

      if (callback) {
        callback();
        return undefined;
      }
      return Promise.resolve();
    }),
    remove: vi.fn((keys: unknown, callback?: () => void) => {
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const key of normalizeKeys(keys)) {
        if (key in state) {
          changes[key] = { oldValue: state[key] };
          delete state[key];
        }
      }
      fireChanged(areaName, changes);

      if (callback) {
        callback();
        return undefined;
      }
      return Promise.resolve();
    }),
    clear: vi.fn((callback?: () => void) => {
      const changes: Record<string, { oldValue?: unknown }> = {};
      for (const key of Object.keys(state)) {
        changes[key] = { oldValue: state[key] };
        delete state[key];
      }
      fireChanged(areaName, changes);

      if (callback) {
        callback();
        return undefined;
      }
      return Promise.resolve();
    }),
  };

  return area;
}

export interface FakeChromeOptions {
  storage?: {
    local?: Record<string, unknown>;
    session?: Record<string, unknown>;
    sync?: Record<string, unknown>;
  };
}

export function createFakeChrome(options: FakeChromeOptions = {}) {
  const onChanged = createFakeEvent<
    (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void
  >();

  const fireChanged = (
    areaName: string,
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  ) => {
    if (Object.keys(changes).length === 0) return;
    onChanged.emit(changes, areaName);
  };

  const storage = {
    local: createFakeStorageArea("local", options.storage?.local ?? {}, fireChanged),
    session: createFakeStorageArea("session", options.storage?.session ?? {}, fireChanged),
    sync: createFakeStorageArea("sync", options.storage?.sync ?? {}, fireChanged),
    onChanged,
  };

  const runtime = {
    onMessage: createFakeEvent<
      (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void
    >(),
    onMessageExternal: createFakeEvent<
      (message: any, sender: any, sendResponse: (response?: any) => void) => boolean | void
    >(),
    onInstalled: createFakeEvent(),
    onStartup: createFakeEvent(),
    sendMessage: vi.fn(() => Promise.resolve()),
    lastError: undefined as { message: string } | undefined,
  };

  const alarms = {
    create: vi.fn(),
    onAlarm: createFakeEvent<(alarm: { name: string }) => void>(),
  };

  const action = {
    setBadgeText: vi.fn((_details: unknown) => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn((_details: unknown) => Promise.resolve()),
    setTitle: vi.fn((_details: unknown) => Promise.resolve()),
    onClicked: createFakeEvent<(tab: { windowId?: number }) => void>(),
  };

  const identity = {
    getAuthToken: vi.fn((_details: unknown, callback: (token?: string) => void) => callback("fake-identity-token")),
  };

  const sidePanel = {
    setOptions: vi.fn(() => Promise.resolve()),
    setPanelBehavior: vi.fn(() => Promise.resolve()),
    open: vi.fn(() => Promise.resolve()),
  };

  const tabs = {
    query: vi.fn((): Promise<Array<Record<string, unknown>>> => Promise.resolve([])),
    captureVisibleTab: vi.fn(
      (_windowId: number, _options: unknown, callback: (dataUrl?: string) => void) =>
        callback("data:image/jpeg;base64,ZmFrZQ=="),
    ),
  };

  const scripting = {
    executeScript: vi.fn(() => Promise.resolve([{ result: "" }])),
  };

  return { runtime, storage, alarms, action, identity, sidePanel, tabs, scripting };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;
