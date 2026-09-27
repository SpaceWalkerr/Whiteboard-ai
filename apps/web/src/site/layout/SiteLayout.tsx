import { Suspense, useEffect } from "react";
import { Outlet } from "react-router";
import { applyTheme, prefersDark } from "../theme";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

/** Header, footer and dark mode for every public page (landing, pricing, templates, docs, legal). */
export function SiteLayout() {
  useEffect(() => {
    // Also covers client-side navigation from the app into the site.
    applyTheme(prefersDark());
    return () => {
      applyTheme(false);
      // App pages don't set a title of their own.
      document.title = "Whiteboard.ai";
    };
  }, []);

  return (
    <div className="flex min-h-svh flex-col">
      <a
        href="#main"
        className="sr-only rounded-md bg-background px-3 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {/* Page modules load on demand; prerendered HTML stays in place while they do. */}
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}
