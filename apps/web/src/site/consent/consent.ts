/**
 * Cookie consent. The default (no choice yet, or storage unavailable) is essential-only:
 * nothing that tracks the visitor loads until they accept analytics.
 *
 * The choice itself is stored in localStorage; that is strictly necessary to remember it and
 * needs no consent.
 */
export type ConsentChoice = "essential" | "analytics";

export const CONSENT_KEY = "whiteboard.consent.v1";
const CHANGE_EVENT = "whiteboard:consent";
const OPEN_EVENT = "whiteboard:consent-settings";

/** The choice made on this page view; used when localStorage is unavailable. */
let pageViewChoice: ConsentChoice | null = null;

export function readConsent(): ConsentChoice | null {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === "essential" || value === "analytics" ? value : pageViewChoice;
  } catch {
    return pageViewChoice;
  }
}

export function saveConsent(choice: ConsentChoice): void {
  pageViewChoice = choice;
  try {
    localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    // Applies to this page view only.
  }
  window.dispatchEvent(new CustomEvent<ConsentChoice>(CHANGE_EVENT, { detail: choice }));
}

export function onConsentChange(listener: (choice: ConsentChoice) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<ConsentChoice>).detail);
  };
  window.addEventListener(CHANGE_EVENT, handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
  };
}

/** "Cookie settings" in the footer reopens the banner. */
export function openConsentSettings(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenConsentSettings(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => {
    window.removeEventListener(OPEN_EVENT, listener);
  };
}
