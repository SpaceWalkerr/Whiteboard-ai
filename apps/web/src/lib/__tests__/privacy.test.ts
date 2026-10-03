import type { PostHog } from "posthog-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSafeReturnPath } from "@/auth/localData";
import { scrubFragments, stripFragment } from "@/lib/privacy";
import { applyAnalyticsConsent, resetAnalyticsForTests } from "@/site/consent/analytics";

const KEY_URL = "https://whiteboard.test/board/5b0c6f1e-0000-4000-8000-000000000000#key=c2VjcmV0";

describe("URL fragments never leave the browser", () => {
  it("strips the fragment from URLs and paths", () => {
    expect(stripFragment(KEY_URL)).toBe(
      "https://whiteboard.test/board/5b0c6f1e-0000-4000-8000-000000000000",
    );
    expect(stripFragment("https://whiteboard.test/")).toBe("https://whiteboard.test/");
  });

  it("scrubs every URL at any depth and leaves other values alone", () => {
    const event = {
      event: "$pageview",
      properties: {
        $current_url: KEY_URL,
        $referrer: KEY_URL,
        $initial_current_url: KEY_URL,
        path: "/board/x#key=abc",
        count: 3,
        note: "hashtags #are fine in text",
        nested: [{ url: KEY_URL }],
      },
      $set_once: { $initial_referrer: KEY_URL },
    };
    const scrubbed = scrubFragments(event);
    expect(JSON.stringify(scrubbed)).not.toContain("key=");
    expect(scrubbed.properties.count).toBe(3);
    expect(scrubbed.properties.note).toBe("hashtags #are fine in text");
    // The input is not modified.
    expect(event.properties.$current_url).toBe(KEY_URL);
  });
});

describe("PostHog", () => {
  afterEach(() => {
    resetAnalyticsForTests();
  });

  it("is started with fragment scrubbing and without loading PostHog's remote scripts", async () => {
    const init = vi.fn();
    const fake = {
      init,
      has_opted_out_capturing: () => false,
      opt_in_capturing: vi.fn(),
    } as unknown as PostHog;
    await applyAnalyticsConsent(
      "analytics",
      { key: "phc_test", host: "https://eu.i.posthog.com" },
      () => Promise.resolve(fake),
    );
    const config = init.mock.calls[0]?.[1] as {
      before_send: (event: unknown) => unknown;
      disable_external_dependency_loading: boolean;
      disable_session_recording: boolean;
    };
    expect(config.disable_external_dependency_loading).toBe(true);
    expect(config.disable_session_recording).toBe(true);
    const sent = config.before_send({ event: "$pageview", properties: { $current_url: KEY_URL } });
    expect(JSON.stringify(sent)).not.toContain("key=");
  });
});

describe("return path after sign-in", () => {
  it.each(["/app", "/board/abc?x=1#key=k", "/pricing"])("allows %s", (path) => {
    expect(isSafeReturnPath(path)).toBe(true);
  });

  it.each(["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", ""])(
    "refuses %s (open redirect)",
    (path) => {
      expect(isSafeReturnPath(path)).toBe(false);
    },
  );
});
