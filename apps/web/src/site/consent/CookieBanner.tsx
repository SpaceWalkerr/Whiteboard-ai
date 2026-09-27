import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { applyAnalyticsConsent, type AnalyticsConfig } from "./analytics";
import {
  onConsentChange,
  onOpenConsentSettings,
  readConsent,
  saveConsent,
  type ConsentChoice,
} from "./consent";

function subscribeToConsent(onChange: () => void) {
  return onConsentChange(onChange);
}

/**
 * Asks once, on any page, whether analytics cookies are OK; "Cookie settings" in the site
 * footer asks again. Never shown in prerendered HTML: whether to show it depends on this
 * browser's stored choice, so the server snapshot is `undefined` ("unknown") and the banner
 * appears only after hydration.
 */
export function CookieBanner({ analytics }: { analytics: AnalyticsConfig }) {
  const consent = useSyncExternalStore(subscribeToConsent, readConsent, () => undefined);
  const [reopened, setReopened] = useState(false);

  useEffect(
    () =>
      onOpenConsentSettings(() => {
        setReopened(true);
      }),
    [],
  );

  useEffect(() => {
    if (consent !== undefined) void applyAnalyticsConsent(consent, analytics);
  }, [consent, analytics]);

  if (!reopened && consent !== null) return null;

  const choose = (choice: ConsentChoice) => {
    saveConsent(choice);
    setReopened(false);
  };

  return (
    <section
      aria-labelledby="cookie-banner-title"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-lg border bg-background p-4 text-sm shadow-lg"
    >
      <h2 id="cookie-banner-title" className="font-semibold">
        Cookies
      </h2>
      <p className="mt-1 text-muted-foreground">
        We use essential cookies to keep you signed in. With your permission we'd also use analytics
        cookies to learn which features people use. Read the{" "}
        <Link to="/privacy#cookies" className="underline">
          Privacy Policy
        </Link>
        .
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            choose("essential");
          }}
        >
          Essential only
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            choose("analytics");
          }}
        >
          Allow analytics
        </Button>
      </div>
    </section>
  );
}
