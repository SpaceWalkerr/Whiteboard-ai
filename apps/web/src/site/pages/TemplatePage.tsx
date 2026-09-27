import { Link, useParams } from "react-router";
import { BOARD_TEMPLATES, templateBySlug } from "@whiteboard/shared/templates";
import { Button } from "@/components/ui/button";
import { SiteNotFound } from "../layout/SiteNotFound";
import { usePageTitle } from "../layout/usePageTitle";
import { templatePageTitle } from "../meta";
import { TemplatePreview } from "./TemplatePreview";

export function TemplatePage() {
  const { slug = "" } = useParams();
  const template = templateBySlug(slug);
  usePageTitle(template ? templatePageTitle(template) : "Page not found — Whiteboard.ai");
  if (!template) return <SiteNotFound />;

  // The next three templates (wrapping around), so every template page is linked from others.
  const index = BOARD_TEMPLATES.indexOf(template);
  const related = [1, 2, 3].flatMap((step) => {
    const next = BOARD_TEMPLATES[(index + step) % BOARD_TEMPLATES.length];
    return next ? [next] : [];
  });

  return (
    <article className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <ol className="flex gap-2">
          <li>
            <Link to="/templates" className="hover:underline">
              Templates
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">{template.name}</li>
        </ol>
      </nav>
      <h1 className="mt-3 text-4xl font-bold tracking-tight">{template.heading}</h1>
      <p className="mt-4 max-w-3xl text-lg text-muted-foreground">{template.summary}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild size="lg">
          {/* Signs in first if needed; /app/new then creates the board. */}
          <Link to={`/app/new?template=${encodeURIComponent(template.slug)}`}>
            Use this template
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link to="/templates">All templates</Link>
        </Button>
      </div>

      <figure className="mt-10 rounded-lg border p-3">
        <TemplatePreview template={template} eager />
        <figcaption className="mt-2 text-center text-sm text-muted-foreground">
          Open it as a board to rearrange it, add your own components and run an AI design review.
        </figcaption>
      </figure>

      <div className="prose-site mt-10">
        <h2>Requirements</h2>
        <h3>Functional</h3>
        <ul>
          {template.functionalRequirements.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <h3>Non-functional</h3>
        <ul>
          {template.nonFunctionalRequirements.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>Components and why they're there</h2>
        <dl>
          {template.components.map((component) => (
            <div key={component.name}>
              <dt>{component.name}</dt>
              <dd>{component.why}</dd>
            </div>
          ))}
        </dl>

        <h2>How a request flows</h2>
        <ol>
          {template.flow.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        <h2>Trade-offs to discuss</h2>
        <ul>
          {template.tradeoffs.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        <h2>Follow-up questions interviewers ask</h2>
        <ul>
          {template.followUps.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <section aria-labelledby="related-heading" className="mt-12">
        <h2 id="related-heading" className="text-2xl font-semibold tracking-tight">
          More system design templates
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-3">
          {related.map((t) => (
            <li key={t.slug}>
              <Link
                to={`/templates/${t.slug}`}
                className="block h-full rounded-lg border p-4 hover:bg-accent"
              >
                <span className="font-medium">{t.name}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{t.heading}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
