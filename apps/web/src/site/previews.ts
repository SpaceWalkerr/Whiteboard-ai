import { templateBySlug, templateFrame } from "@whiteboard/shared/templates";
import { boardToSvg } from "@/features/board/export/svg";

/**
 * A template's diagram as a standalone SVG (build time: /template-previews/<slug>.svg). Drawn
 * by the same renderer as the board's "Export SVG", framed exactly as the pages expect.
 */
export function templatePreviewSvg(slug: string): string | null {
  const template = templateBySlug(slug);
  if (!template) return null;
  const result = boardToSvg(template.shapes, {
    frame: templateFrame(template.shapes),
    background: "#ffffff",
  });
  return result?.svg ?? null;
}
