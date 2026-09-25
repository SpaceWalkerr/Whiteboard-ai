import type { Shape } from "@whiteboard/shared/board";
import { boardToSvg } from "./svg";
import type { MeasureText } from "./wrapText";

function canvasMeasure(): MeasureText {
  const context = document.createElement("canvas").getContext("2d");
  return (text, fontSize) => {
    if (!context) return text.length * fontSize * 0.55;
    context.font = `${fontSize}px ${getComputedStyle(document.body).fontFamily}`;
    return context.measureText(text).width;
  };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoke after the click has been processed.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

export function exportSvg(ordered: readonly Shape[], filename = "board.svg"): boolean {
  const result = boardToSvg(ordered, { measure: canvasMeasure() });
  if (!result) return false;
  triggerDownload(new Blob([result.svg], { type: "image/svg+xml" }), filename);
  return true;
}

/** PNG is rasterized from the SVG export, so it includes shapes currently culled off-screen. */
export async function exportPng(
  ordered: readonly Shape[],
  filename = "board.png",
  pixelRatio = 2,
): Promise<boolean> {
  const result = boardToSvg(ordered, { measure: canvasMeasure() });
  if (!result) return false;
  const url = URL.createObjectURL(new Blob([result.svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(result.bounds.width * pixelRatio);
    canvas.height = Math.ceil(result.bounds.height * pixelRatio);
    const context = canvas.getContext("2d");
    if (!context) return false;
    context.scale(pixelRatio, pixelRatio);
    context.drawImage(image, 0, 0, result.bounds.width, result.bounds.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) return false;
    triggerDownload(blob, filename);
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
