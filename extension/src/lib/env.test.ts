import { afterEach, describe, expect, it } from "vitest";
import { getDefaultApiUrl, getExtensionEnv, getRuntimeMode } from "./env";

const originalMode = import.meta.env.MODE;
const originalProd = import.meta.env.PROD;

describe("env", () => {
  afterEach(() => {
    (import.meta.env as any).MODE = originalMode;
    (import.meta.env as any).PROD = originalProd;
  });

  it("reports test mode when Vite's MODE is test (the default under vitest)", () => {
    (import.meta.env as any).MODE = "test";
    expect(getRuntimeMode()).toBe("test");
  });

  it("reports production when not in test mode and PROD is set", () => {
    (import.meta.env as any).MODE = "production";
    (import.meta.env as any).PROD = true;
    expect(getRuntimeMode()).toBe("production");
  });

  it("reports development when not in test mode and PROD is unset", () => {
    (import.meta.env as any).MODE = "development";
    (import.meta.env as any).PROD = false;
    expect(getRuntimeMode()).toBe("development");
  });

  it("parses the extension environment from import.meta.env with safe defaults", () => {
    const env = getExtensionEnv();
    expect(env.VITE_API_URL).toBe("http://localhost:3000");
    // Calling twice returns the same parsed singleton.
    expect(getExtensionEnv()).toBe(env);
  });

  it("derives the default API URL from the parsed environment, normalized for the current mode", () => {
    (import.meta.env as any).MODE = "test";
    expect(getDefaultApiUrl()).toBe("http://localhost:3000");
  });
});
