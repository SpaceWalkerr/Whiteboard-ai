import { describe, expect, it } from "vitest";
import { THEME_SCRIPT } from "../src/site/theme";
import { buildCsp, cspMetaTag, scriptHash } from "./csp";

const production = {
  VITE_API_URL: "https://api.whiteboard.test",
  VITE_WS_URL: "wss://api.whiteboard.test",
  VITE_SUPABASE_URL: "https://abcd.supabase.co",
  VITE_POSTHOG_KEY: "phc_test",
  VITE_POSTHOG_HOST: "https://eu.i.posthog.com",
};

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split("; ").map((part) => {
      const [name = "", ...sources] = part.split(" ");
      return [name, sources];
    }),
  );
}

describe("Content Security Policy", () => {
  it("allows scripts only from our origin, Razorpay Checkout and the hashed theme script", () => {
    const csp = directives(buildCsp({ env: production, inlineScripts: [THEME_SCRIPT] }));
    expect(csp.get("script-src")).toEqual([
      "'self'",
      scriptHash(THEME_SCRIPT),
      "https://checkout.razorpay.com",
      "'wasm-unsafe-eval'",
    ]);
    const all = [...csp.values()].flat();
    expect(all).not.toContain("'unsafe-eval'");
    expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
    expect(all).not.toContain("*");
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
  });

  it("connects only to this environment's API, sync, Supabase, PostHog and Razorpay hosts", () => {
    const csp = directives(buildCsp({ env: production, inlineScripts: [] }));
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "https://api.whiteboard.test",
      "wss://api.whiteboard.test",
      "https://abcd.supabase.co",
      "https://api.razorpay.com",
      "https://lumberjack.razorpay.com",
      "https://eu.i.posthog.com",
    ]);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
  });

  it("leaves PostHog out without a key and doesn't upgrade local http", () => {
    const csp = directives(
      buildCsp({
        env: {
          ...production,
          VITE_API_URL: "http://localhost:4000",
          VITE_WS_URL: "ws://localhost:4000",
          VITE_POSTHOG_KEY: undefined,
        },
        inlineScripts: [],
      }),
    );
    expect(csp.get("connect-src")).not.toContain("https://eu.i.posthog.com");
    expect(csp.get("connect-src")).toContain("ws://localhost:4000");
    expect(csp.has("upgrade-insecure-requests")).toBe(false);
  });

  it("hashes the exact inline script text (base64 sha256)", () => {
    // echo -n 'alert(1)' | openssl dgst -sha256 -binary | base64
    expect(scriptHash("alert(1)")).toBe("'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
  });

  it("escapes quotes in the meta tag", () => {
    expect(cspMetaTag(`a "b"`)).toBe(
      '<meta http-equiv="Content-Security-Policy" content="a &quot;b&quot;" />',
    );
  });
});
