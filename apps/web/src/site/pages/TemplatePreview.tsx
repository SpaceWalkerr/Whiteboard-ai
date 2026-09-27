import { templateFrame, type BoardTemplate } from "@whiteboard/shared/templates";

/** The template's diagram, drawn at build time into /template-previews/<slug>.svg. */
export function TemplatePreview({
  template,
  eager = false,
}: {
  template: BoardTemplate;
  /** The main image of a template page loads first; gallery thumbnails load lazily. */
  eager?: boolean;
}) {
  const frame = templateFrame(template.shapes);
  return (
    <img
      src={`/template-previews/${template.slug}.svg`}
      alt={`${template.name} system design diagram: ${template.components.map((c) => c.name).join(", ")}.`}
      width={frame.width}
      height={frame.height}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className="h-auto w-full rounded-md bg-white"
    />
  );
}
