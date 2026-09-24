import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const fakeAuth = vi.hoisted(() => ({ currentUser: null as any }));

vi.mock("./firebase", () => ({
  auth: fakeAuth,
}));

import {
  getExtensionIdFromSearch,
  getConnectExtensionId,
  sendAuthToExtension,
} from "./extensionBridge";

const DEFAULT_EXTENSION_ID = "fajafcnfcebebbeahbofaihjgogooijhkj";

describe("extensionBridge", () => {
  beforeEach(() => {
    fakeAuth.currentUser = null;
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("getExtensionIdFromSearch", () => {
    it("reads extensionId from a query string", () => {
      expect(getExtensionIdFromSearch("?extensionId=abc123")).toBe("abc123");
    });

    it("returns an empty string when extensionId is absent", () => {
      expect(getExtensionIdFromSearch("?foo=bar")).toBe("");
    });
  });

  describe("getConnectExtensionId", () => {
    it("prefers the extensionId found in the search string", () => {
      expect(getConnectExtensionId("?extensionId=from-url")).toBe("from-url");
    });

    it("falls back to VITE_EXTENSION_ID when the search string has none", () => {
      vi.stubEnv("VITE_EXTENSION_ID", "env-configured-id");
      expect(getConnectExtensionId("")).toBe("env-configured-id");
    });

    it("falls back to the hardcoded default when neither the URL nor env provide one", () => {
      vi.stubEnv("VITE_EXTENSION_ID", "");
      expect(getConnectExtensionId("")).toBe(DEFAULT_EXTENSION_ID);
    });
  });

  describe("sendAuthToExtension", () => {
    it("fails fast when no extension ID is provided", async () => {
      const result = await sendAuthToExtension("");
      expect(result).toEqual({ ok: false, error: "Missing extension ID." });
    });

    it("fails when there is no signed-in user (explicit null and no fallback auth user)", async () => {
      fakeAuth.currentUser = null;
      const result = await sendAuthToExtension("ext-1", null);
      expect(result).toEqual({
        ok: false,
        error: "No signed-in user found.",
      });
    });

    it("falls back to auth.currentUser when signedInUser is not passed", async () => {
      vi.stubGlobal("chrome", undefined);
      fakeAuth.currentUser = null;

      const result = await sendAuthToExtension("ext-1");

      expect(result).toEqual({
        ok: false,
        error: "No signed-in user found.",
      });
    });

    it("fails when chrome extension messaging is unavailable", async () => {
      vi.stubGlobal("chrome", undefined);
      const user = { uid: "u1", getIdToken: vi.fn() };

      const result = await sendAuthToExtension("ext-1", user as any);

      expect(result).toEqual({
        ok: false,
        error: "Chrome extension messaging is unavailable in this browser.",
      });
      expect(user.getIdToken).not.toHaveBeenCalled();
    });

    it("fails when chrome.runtime.sendMessage is missing", async () => {
      vi.stubGlobal("chrome", { runtime: {} });
      const user = { uid: "u1", getIdToken: vi.fn() };

      const result = await sendAuthToExtension("ext-1", user as any);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("unavailable in this browser");
    });

    it("sends the ID token and user profile to the extension and reports success", async () => {
      const sendMessage = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("chrome", { runtime: { sendMessage } });

      const user = {
        uid: "u1",
        email: "u1@example.com",
        displayName: "User One",
        photoURL: "https://example.com/p.png",
        getIdToken: vi.fn().mockResolvedValue("id-token-123"),
      };

      const result = await sendAuthToExtension("ext-1", user as any);

      expect(user.getIdToken).toHaveBeenCalledWith(true);
      expect(sendMessage).toHaveBeenCalledWith("ext-1", {
        type: "AUTH_FROM_WEB",
        token: "id-token-123",
        user: {
          uid: "u1",
          email: "u1@example.com",
          displayName: "User One",
          photoURL: "https://example.com/p.png",
        },
      });
      expect(result).toEqual({ ok: true });
    });

    it("reports the extension's error message when the response is not ok", async () => {
      const sendMessage = vi
        .fn()
        .mockResolvedValue({ ok: false, error: "extension rejected" });
      vi.stubGlobal("chrome", { runtime: { sendMessage } });

      const user = { uid: "u1", getIdToken: vi.fn().mockResolvedValue("t") };
      const result = await sendAuthToExtension("ext-1", user as any);

      expect(result).toEqual({ ok: false, error: "extension rejected" });
    });

    it("falls back to a generic error message when the response has none", async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("chrome", { runtime: { sendMessage } });

      const user = { uid: "u1", getIdToken: vi.fn().mockResolvedValue("t") };
      const result = await sendAuthToExtension("ext-1", user as any);

      expect(result).toEqual({
        ok: false,
        error: "Failed to connect the website session to the extension.",
      });
    });
  });
});
