/** The docs, in reading order. The slug is the URL (/docs/<slug>). */
export const DOCS = [
  {
    slug: "getting-started",
    title: "Getting started",
    description:
      "Create your first Whiteboard.ai board: sign in, draw an architecture with system design shapes, invite collaborators and run a design check.",
  },
  {
    slug: "shortcuts",
    title: "Keyboard shortcuts",
    description:
      "Every Whiteboard.ai keyboard shortcut: drawing tools, editing, arranging shapes, zoom and design reviews.",
  },
  {
    slug: "sharing-and-permissions",
    title: "Sharing and permissions",
    description:
      "Share Whiteboard.ai boards by email invite, share link or public read-only link; owner, editor and viewer roles; editor limits per plan.",
  },
  {
    slug: "ai-review",
    title: "AI design review",
    description:
      "How the Whiteboard.ai AI design review works: the rules engine, Claude's findings on your diagram, scores, monthly quotas and live hints.",
  },
  {
    slug: "interview-mode",
    title: "Interview mode",
    description:
      "Run live system design interviews on Whiteboard.ai: roles, question bank, timer, private notes, scorecards, session replay and summaries.",
  },
  {
    slug: "private-rooms",
    title: "Private rooms (end-to-end encryption)",
    description:
      "Whiteboard.ai private rooms are end-to-end encrypted: the key lives in the link and the server stores only ciphertext. What that means for you.",
  },
  {
    slug: "billing-faq",
    title: "Billing FAQ",
    description:
      "Answers about Whiteboard.ai plans and billing: payment methods, invoices, upgrades, cancellation, refunds, failed payments and student offers.",
  },
] as const;

export type DocSlug = (typeof DOCS)[number]["slug"];

export function docBySlug(slug: string) {
  return DOCS.find((doc) => doc.slug === slug);
}

/** <title> of a docs page. */
export function docPageTitle(doc: { title: string }): string {
  return `${doc.title} — Whiteboard.ai docs`;
}
