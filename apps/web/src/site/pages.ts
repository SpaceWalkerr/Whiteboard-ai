import type { CatalogResponse } from "@whiteboard/shared/billing";
import { BOARD_TEMPLATES } from "@whiteboard/shared/templates";
import { COMPANY, LEGAL_UPDATED } from "./config";
import { docPageTitle, DOCS } from "./docs/docsIndex";
import { STATIC_PAGES, templatePageTitle, type StaticPath } from "./meta";
import { LANDING_FAQ } from "./pages/landingContent";

/**
 * Every prerendered public page: what goes into its <head>, sitemap entry and Open Graph
 * image. Used at build time only (scripts/prerender.ts) and by tests — never by the browser.
 */
export interface PublicPage {
  path: string;
  title: string;
  description: string;
  /** Large text on the Open Graph image, and the small label above it. */
  ogHeading: string;
  ogLabel: string;
  /** Source modules the page needs, preloaded with <link rel="modulepreload">. */
  modules: readonly string[];
  /** Sitemap lastmod (YYYY-MM-DD). */
  updated: string;
  breadcrumbs?: readonly { name: string; path: string }[];
  /** schema.org objects for this page (the Organization is added to every page). */
  structuredData: (context: StructuredDataContext) => object[];
}

export interface StructuredDataContext {
  siteUrl: string;
  catalog: CatalogResponse | null;
  /** Absolute URL of this page's Open Graph image. */
  image: string;
}

/** Last time the marketing pages' own content changed (sitemap lastmod). */
const SITE_UPDATED = "2026-09-27";

const MODULES = {
  landing: "src/site/pages/LandingPage.tsx",
  pricing: "src/features/billing/PricingPage.tsx",
  templates: "src/site/pages/TemplatesPage.tsx",
  template: "src/site/pages/TemplatePage.tsx",
  docs: "src/site/docs/DocsPages.tsx",
  terms: "src/site/legal/TermsPage.tsx",
  privacy: "src/site/legal/PrivacyPage.tsx",
  refund: "src/site/legal/RefundPolicyPage.tsx",
  shipping: "src/site/legal/ShippingPolicyPage.tsx",
  contact: "src/site/legal/ContactPage.tsx",
} as const;

function staticPage(
  path: StaticPath,
  rest: Pick<PublicPage, "modules" | "updated" | "ogLabel"> &
    Partial<Pick<PublicPage, "structuredData" | "breadcrumbs">>,
): PublicPage {
  const meta = STATIC_PAGES[path];
  return {
    path,
    title: meta.title,
    description: meta.description,
    ogHeading: meta.ogHeading,
    structuredData: () => [],
    ...rest,
  };
}

/** The product with its plans as offers (monthly prices from the plans catalog). */
function softwareApplication({ siteUrl, catalog }: StructuredDataContext): object {
  const paid = (catalog?.plans ?? []).filter((plan) => plan.interval === "month");
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: COMPANY.productName,
    url: siteUrl,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web browser",
    description: STATIC_PAGES["/"].description,
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "INR" },
      ...paid.map((plan) => ({
        "@type": "Offer",
        name: plan.tier === "pro" ? "Pro (monthly)" : "Team (monthly, per seat)",
        price: (plan.amountMinor / 100).toFixed(2),
        priceCurrency: plan.currency,
        url: `${siteUrl}/pricing`,
      })),
    ],
  };
}

function breadcrumbList(siteUrl: string, crumbs: readonly { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: crumb.name,
      item: `${siteUrl}${crumb.path}`,
    })),
  };
}

export function organization(siteUrl: string): object {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: COMPANY.productName,
    legalName: COMPANY.legalName,
    url: siteUrl,
    logo: `${siteUrl}/favicon.svg`,
    email: COMPANY.supportEmail,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: COMPANY.supportEmail,
      telephone: COMPANY.phone,
      areaServed: "IN",
    },
  };
}

export function publicPages(): PublicPage[] {
  const pages: PublicPage[] = [
    staticPage("/", {
      modules: [MODULES.landing],
      updated: SITE_UPDATED,
      ogLabel: "Whiteboard.ai",
      structuredData: (context) => [
        {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: COMPANY.productName,
          url: context.siteUrl,
        },
        softwareApplication(context),
        {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: LANDING_FAQ.map((item) => ({
            "@type": "Question",
            name: item.question,
            acceptedAnswer: { "@type": "Answer", text: item.answer },
          })),
        },
      ],
    }),
    staticPage("/pricing", {
      modules: [MODULES.pricing],
      updated: SITE_UPDATED,
      ogLabel: "Pricing",
      structuredData: (context) => [softwareApplication(context)],
    }),
    staticPage("/templates", {
      modules: [MODULES.templates],
      updated: SITE_UPDATED,
      ogLabel: "Templates",
    }),
    ...BOARD_TEMPLATES.map((template): PublicPage => {
      const breadcrumbs = [
        { name: "Templates", path: "/templates" },
        { name: template.name, path: `/templates/${template.slug}` },
      ];
      return {
        path: `/templates/${template.slug}`,
        title: templatePageTitle(template),
        description: template.description,
        ogHeading: template.heading,
        ogLabel: "System design template",
        modules: [MODULES.template],
        updated: template.updated,
        breadcrumbs,
        structuredData: ({ siteUrl, image }) => [
          breadcrumbList(siteUrl, breadcrumbs),
          {
            "@context": "https://schema.org",
            "@type": "TechArticle",
            headline: template.heading,
            description: template.description,
            image: [image, `${siteUrl}/template-previews/${template.slug}.svg`],
            dateModified: template.updated,
            author: { "@type": "Organization", name: COMPANY.productName, url: siteUrl },
            publisher: { "@type": "Organization", name: COMPANY.productName, url: siteUrl },
          },
        ],
      };
    }),
    staticPage("/docs", { modules: [MODULES.docs], updated: SITE_UPDATED, ogLabel: "Docs" }),
    ...DOCS.map((doc): PublicPage => {
      const breadcrumbs = [
        { name: "Docs", path: "/docs" },
        { name: doc.title, path: `/docs/${doc.slug}` },
      ];
      return {
        path: `/docs/${doc.slug}`,
        title: docPageTitle(doc),
        description: doc.description,
        ogHeading: doc.title,
        ogLabel: "Docs",
        modules: [MODULES.docs],
        updated: SITE_UPDATED,
        breadcrumbs,
        structuredData: ({ siteUrl }) => [breadcrumbList(siteUrl, breadcrumbs)],
      };
    }),
    staticPage("/terms", { modules: [MODULES.terms], updated: LEGAL_UPDATED, ogLabel: "Legal" }),
    staticPage("/privacy", {
      modules: [MODULES.privacy],
      updated: LEGAL_UPDATED,
      ogLabel: "Legal",
    }),
    staticPage("/refund-policy", {
      modules: [MODULES.refund],
      updated: LEGAL_UPDATED,
      ogLabel: "Legal",
    }),
    staticPage("/shipping-policy", {
      modules: [MODULES.shipping],
      updated: LEGAL_UPDATED,
      ogLabel: "Legal",
    }),
    staticPage("/contact", {
      modules: [MODULES.contact],
      updated: LEGAL_UPDATED,
      ogLabel: "Contact",
    }),
  ];
  return pages;
}

/** Where a page's HTML is written in dist/ (served without the .html by Vercel cleanUrls). */
export function htmlFileFor(path: string): string {
  return path === "/" ? "index.html" : `${path.slice(1)}.html`;
}

/** Open Graph image of a page, in dist/og/. */
export function ogImageFor(path: string): string {
  return path === "/" ? "og/home.png" : `og/${path.slice(1).replaceAll("/", "--")}.png`;
}
