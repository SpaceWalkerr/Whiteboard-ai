/**
 * Titles and descriptions of the fixed public pages. Pages use the title for the tab on
 * client-side navigation; the prerender step writes all of it into each page's <head>.
 * Template and docs pages take theirs from their own content.
 */
export interface PageMeta {
  /** <title>: at most ~60 characters. */
  title: string;
  /** Meta description: at most 160 characters. */
  description: string;
  /** Large text on the page's Open Graph image. */
  ogHeading: string;
}

export const STATIC_PAGES = {
  "/": {
    title: "Whiteboard.ai — System design whiteboard with AI review",
    description:
      "A real-time collaborative whiteboard for system design. Draw your architecture and get an AI design review like a senior engineer. Free to start.",
    ogHeading: "System design whiteboard with AI review",
  },
  "/pricing": {
    title: "Pricing — Whiteboard.ai",
    description:
      "Free, Pro and Team plans for Whiteboard.ai. Unlimited boards, AI design reviews, private encrypted rooms and interview mode. Prices in INR.",
    ogHeading: "Plans and pricing",
  },
  "/templates": {
    title: "System design templates and diagrams — Whiteboard.ai",
    description:
      "Classic system design diagrams to start from: URL shortener, rate limiter, chat app, news feed, ride-hailing, video streaming and more.",
    ogHeading: "System design templates",
  },
  "/docs": {
    title: "Docs — Whiteboard.ai",
    description:
      "How to use Whiteboard.ai: getting started, keyboard shortcuts, sharing and permissions, AI review, interview mode, private rooms and billing.",
    ogHeading: "Documentation",
  },
  "/terms": {
    title: "Terms of Service — Whiteboard.ai",
    description:
      "The terms that apply when you use Whiteboard.ai, the collaborative system design whiteboard with AI review.",
    ogHeading: "Terms of Service",
  },
  "/privacy": {
    title: "Privacy Policy — Whiteboard.ai",
    description:
      "What personal data Whiteboard.ai collects, why, who processes it, how long it is kept, cookies, and your rights under Indian law.",
    ogHeading: "Privacy Policy",
  },
  "/refund-policy": {
    title: "Refund and Cancellation Policy — Whiteboard.ai",
    description:
      "How to cancel a Whiteboard.ai subscription, when refunds are given, and how long they take to reach your payment method.",
    ogHeading: "Refund & Cancellation Policy",
  },
  "/shipping-policy": {
    title: "Shipping and Delivery Policy — Whiteboard.ai",
    description:
      "Whiteboard.ai is a digital service: nothing is shipped. Paid plans are delivered to your account instantly after payment.",
    ogHeading: "Shipping & Delivery Policy",
  },
  "/contact": {
    title: "Contact us — Whiteboard.ai",
    description:
      "Contact Whiteboard.ai for support, billing and privacy questions: email, phone and postal address.",
    ogHeading: "Contact us",
  },
} as const satisfies Record<string, PageMeta>;

export type StaticPath = keyof typeof STATIC_PAGES;

/** <title> of a template page. */
export function templatePageTitle(template: { heading: string }): string {
  return `${template.heading} | Whiteboard.ai`;
}
