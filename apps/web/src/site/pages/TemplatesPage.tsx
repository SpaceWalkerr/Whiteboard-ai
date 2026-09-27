import { Link } from "react-router";
import { BOARD_TEMPLATES } from "@whiteboard/shared/templates";
import { usePageTitle } from "../layout/usePageTitle";
import { STATIC_PAGES } from "../meta";
import { TemplatePreview } from "./TemplatePreview";

export function TemplatesPage() {
  usePageTitle(STATIC_PAGES["/templates"].title);
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-4xl font-bold tracking-tight">System design templates</h1>
      <p className="mt-3 max-w-3xl text-lg text-muted-foreground">
        Classic system design interview questions, drawn as architecture diagrams you can open as a
        board, change with your team, and get reviewed by AI. Each one comes with requirements, the
        reasoning behind every component, and the trade-offs to discuss.
      </p>
      <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {BOARD_TEMPLATES.map((template) => (
          <li key={template.slug}>
            <article className="flex h-full flex-col rounded-lg border p-4">
              <TemplatePreview template={template} />
              <h2 className="mt-4 text-lg font-semibold">
                <Link to={`/templates/${template.slug}`} className="rounded-sm hover:underline">
                  {template.name}
                </Link>
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}
