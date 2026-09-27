import { matchRoutes } from "react-router";
import { lazyPage } from "@/lib/lazyPage";

/**
 * Page modules, each loaded on demand so public pages ship little JavaScript. The public ones
 * are prerendered; site/pages.ts lists their source modules for <link rel="modulepreload">.
 */
export const LandingPage = lazyPage(() =>
  import("@/site/pages/LandingPage").then((m) => m.LandingPage),
);
export const PricingPage = lazyPage(() =>
  import("@/features/billing/PricingPage").then((m) => m.PricingPage),
);
export const TemplatesPage = lazyPage(() =>
  import("@/site/pages/TemplatesPage").then((m) => m.TemplatesPage),
);
export const TemplatePage = lazyPage(() =>
  import("@/site/pages/TemplatePage").then((m) => m.TemplatePage),
);
export const DocsIndexPage = lazyPage(() =>
  import("@/site/docs/DocsPages").then((m) => m.DocsIndexPage),
);
export const DocPage = lazyPage(() => import("@/site/docs/DocsPages").then((m) => m.DocPage));
export const TermsPage = lazyPage(() => import("@/site/legal/TermsPage").then((m) => m.TermsPage));
export const PrivacyPage = lazyPage(() =>
  import("@/site/legal/PrivacyPage").then((m) => m.PrivacyPage),
);
export const RefundPolicyPage = lazyPage(() =>
  import("@/site/legal/RefundPolicyPage").then((m) => m.RefundPolicyPage),
);
export const ShippingPolicyPage = lazyPage(() =>
  import("@/site/legal/ShippingPolicyPage").then((m) => m.ShippingPolicyPage),
);
export const ContactPage = lazyPage(() =>
  import("@/site/legal/ContactPage").then((m) => m.ContactPage),
);

/** The public (prerendered) routes, rendered inside the site layout. */
export const PUBLIC_ROUTES = [
  { path: "/", Page: LandingPage },
  { path: "/pricing", Page: PricingPage },
  { path: "/templates", Page: TemplatesPage },
  { path: "/templates/:slug", Page: TemplatePage },
  { path: "/docs", Page: DocsIndexPage },
  { path: "/docs/:slug", Page: DocPage },
  { path: "/terms", Page: TermsPage },
  { path: "/privacy", Page: PrivacyPage },
  { path: "/refund-policy", Page: RefundPolicyPage },
  { path: "/shipping-policy", Page: ShippingPolicyPage },
  { path: "/contact", Page: ContactPage },
] as const;

/** Loads the module of the public page at `pathname`, if it is one. */
export function preloadPublicPage(pathname: string): Promise<void> {
  const match = matchRoutes([...PUBLIC_ROUTES], pathname)?.[0];
  return match ? match.route.Page.preload() : Promise.resolve();
}
