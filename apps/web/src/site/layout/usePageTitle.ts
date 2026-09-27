import { useEffect } from "react";

/**
 * Keeps the tab title right on client-side navigation. The prerendered HTML already has the
 * full <head> (title, description, canonical, Open Graph) for crawlers and first loads.
 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
