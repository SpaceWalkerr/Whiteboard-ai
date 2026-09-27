import type { ComponentType } from "react";
import { Link, NavLink, useParams } from "react-router";
import { SiteNotFound } from "../layout/SiteNotFound";
import { cn } from "@/lib/utils";
import { usePageTitle } from "../layout/usePageTitle";
import { STATIC_PAGES } from "../meta";
import { AiReview } from "./articles/AiReview";
import { BillingFaq } from "./articles/BillingFaq";
import { GettingStarted } from "./articles/GettingStarted";
import { InterviewMode } from "./articles/InterviewMode";
import { PrivateRooms } from "./articles/PrivateRooms";
import { Sharing } from "./articles/Sharing";
import { Shortcuts } from "./articles/Shortcuts";
import { docBySlug, docPageTitle, DOCS, type DocSlug } from "./docsIndex";

const ARTICLES: Record<DocSlug, ComponentType> = {
  "getting-started": GettingStarted,
  shortcuts: Shortcuts,
  "sharing-and-permissions": Sharing,
  "ai-review": AiReview,
  "interview-mode": InterviewMode,
  "private-rooms": PrivateRooms,
  "billing-faq": BillingFaq,
};

function DocsNav() {
  return (
    <nav aria-label="Docs" className="text-sm">
      <ul className="space-y-1">
        {DOCS.map((doc) => (
          <li key={doc.slug}>
            <NavLink
              to={`/docs/${doc.slug}`}
              className={({ isActive }) =>
                cn(
                  "block rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                  isActive && "bg-accent font-medium text-foreground",
                )
              }
            >
              {doc.title}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function DocsIndexPage() {
  usePageTitle(STATIC_PAGES["/docs"].title);
  return (
    <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
      <h1 className="text-4xl font-bold tracking-tight">Docs</h1>
      <p className="mt-3 text-lg text-muted-foreground">
        Everything you need to draw, share and review system designs on Whiteboard.ai.
      </p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {DOCS.map((doc) => (
          <li key={doc.slug}>
            <Link
              to={`/docs/${doc.slug}`}
              className="block h-full rounded-lg border p-5 hover:bg-accent"
            >
              <h2 className="font-semibold">{doc.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{doc.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DocPage() {
  const { slug = "" } = useParams();
  const doc = docBySlug(slug);
  usePageTitle(doc ? docPageTitle(doc) : "Page not found — Whiteboard.ai");
  if (!doc) return <SiteNotFound />;
  const Article = ARTICLES[doc.slug];
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[14rem_1fr]">
      <aside className="md:sticky md:top-6 md:self-start">
        <DocsNav />
      </aside>
      <article className="prose-site min-w-0">
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
          <Link to="/docs" className="hover:underline">
            Docs
          </Link>{" "}
          / <span aria-current="page">{doc.title}</span>
        </nav>
        <h1>{doc.title}</h1>
        <Article />
      </article>
    </div>
  );
}
