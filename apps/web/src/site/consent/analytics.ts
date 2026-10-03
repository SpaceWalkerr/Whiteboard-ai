import type { PostHog } from "posthog-js";
import { scrubFragments } from "@/lib/privacy";
import type { ConsentChoice } from "./consent";

export interface AnalyticsConfig {
  key: string | undefined;
  host: string;
}

type Loader = () => Promise<PostHog>;

const loadPostHog: Loader = () => import("posthog-js").then((m) => m.default);

let client: Promise<PostHog> | null = null;

/**
 * Starts or stops product analytics for a consent choice. posthog-js is downloaded only after
 * the visitor accepts analytics and only when a key is configured; withdrawing consent opts
 * out (PostHog stops capturing and forgets the visitor's id).
 */
export async function applyAnalyticsConsent(
  choice: ConsentChoice | null,
  config: AnalyticsConfig,
  load: Loader = loadPostHog,
): Promise<void> {
  if (!config.key) return;
  if (choice === "analytics") {
    const key = config.key;
    client ??= load().then((posthog) => {
      posthog.init(key, {
        api_host: config.host,
        // Page views on client-side navigation too (the app is a single-page app).
        capture_pageview: "history_change",
        // Never record what people type or draw.
        disable_session_recording: true,
        autocapture: false,
        person_profiles: "identified_only",
        // No scripts from PostHog's CDN (surveys, toolbar, remote config): the CSP allows
        // scripts from our own origin only.
        disable_external_dependency_loading: true,
        // Page URLs can carry a private board's key or an interview token in the fragment
        // ($current_url, $referrer, initial URLs…): drop fragments before anything is sent.
        before_send: (event) => (event ? scrubFragments(event) : event),
      });
      return posthog;
    });
    const posthog = await client;
    if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
    return;
  }
  // Essential only: if PostHog was loaded earlier in this page view, turn it off.
  if (!client) return;
  const posthog = await client;
  posthog.opt_out_capturing();
  posthog.reset();
}

/** Tests only. */
export function resetAnalyticsForTests(): void {
  client = null;
}
