import { FONT_FAMILY } from "./visuals";

let context: CanvasRenderingContext2D | null | undefined;

/** Text width in px using the canvas font engine (same one Konva uses). */
export function measureTextWidth(text: string, fontSize: number): number {
  if (context === undefined) context = document.createElement("canvas").getContext("2d");
  if (!context) return text.length * fontSize * 0.55;
  context.font = `${fontSize}px ${FONT_FAMILY}`;
  return context.measureText(text).width;
}
