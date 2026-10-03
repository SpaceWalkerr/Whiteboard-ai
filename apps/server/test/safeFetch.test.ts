import { describe, expect, it, vi } from "vitest";
import { BlockedFetchError, createSafeFetch } from "../src/http/safeFetch";

function recordingFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const base = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
  return { base, calls };
}

describe("safe outbound fetch", () => {
  it("reaches allowlisted origins with redirects refused and a timeout", async () => {
    const { base, calls } = recordingFetch();
    const safe = createSafeFetch(["https://api.razorpay.com/v1"], base);
    await safe("https://api.razorpay.com/v1/subscriptions/sub_1");
    expect(calls[0]?.url).toBe("https://api.razorpay.com/v1/subscriptions/sub_1");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "https://evil.test/",
    "http://api.razorpay.com/v1/x", // downgraded scheme is another origin
    "https://api.razorpay.com.evil.test/",
    "https://api.razorpay.com@evil.test/",
    "https://user:pass@api.razorpay.com/v1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:4000/internal/purge-trash",
    "not a url",
  ])("refuses %s without sending anything", async (url) => {
    const { base, calls } = recordingFetch();
    const safe = createSafeFetch(["https://api.razorpay.com/v1"], base);
    await expect(safe(url)).rejects.toBeInstanceOf(BlockedFetchError);
    expect(calls).toHaveLength(0);
  });

  it("stays on the host when user input in a path tries to leave it", async () => {
    const { base, calls } = recordingFetch();
    const safe = createSafeFetch(["https://project.supabase.co"], base);
    // Path tricks normalise to a path on the same host (or are refused), never another host.
    await safe(
      `https://project.supabase.co/storage/v1/object/b/${encodeURIComponent("//evil.test/x")}`,
    );
    await safe("https://project.supabase.co/storage/v1/../../x");
    for (const call of calls) expect(new URL(call.url).host).toBe("project.supabase.co");
  });

  it("never puts the path or query of a refused URL in the error", async () => {
    const safe = createSafeFetch(["https://api.razorpay.com"], recordingFetch().base);
    await expect(safe("https://evil.test/path?key=secret")).rejects.toThrow(
      "outbound request to a host that is not allowlisted: https://evil.test",
    );
    await expect(safe("https://evil.test/path?key=secret")).rejects.not.toThrow(/secret/);
  });
});
