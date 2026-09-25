import type { IconNode } from "lucide";
import type { Shape } from "@whiteboard/shared/board";
import { isSystemShape } from "@whiteboard/shared/board";
import { resolveArrow, type ShapeLookup } from "../geometry/arrow";
import { unionRects, type Rect } from "../geometry/bounds";
import { shapeBounds } from "../geometry/shapeBounds";
import { systemShapeCaption, systemShapeIcon } from "../model/systemShapes";
import { approximateMeasure, wrapText, type MeasureText } from "./wrapText";
import {
  ARROW_DASH,
  FONT_FAMILY,
  LINE_HEIGHT,
  STROKE_DASH,
  SYSTEM_LAYOUT,
} from "../canvas/visuals";

export interface SvgExportOptions {
  padding?: number;
  background?: string | null;
  measure?: MeasureText;
  /**
   * Fixed area to show instead of fitting the content (session replay keeps one frame for
   * the whole session so the picture doesn't jump). An empty board then renders blank.
   */
  frame?: Rect;
}

export interface SvgExport {
  svg: string;
  bounds: Rect;
}

/**
 * Serializes the board to a standalone SVG. Konva has no SVG export, so this is a separate
 * renderer from the same model and visual constants as the canvas. `ordered` is render order.
 */
export function boardToSvg(
  ordered: readonly Shape[],
  options: SvgExportOptions = {},
): SvgExport | null {
  const padding = options.padding ?? 32;
  const measure = options.measure ?? approximateMeasure;
  const byId = new Map(ordered.map((s) => [s.id, s]));
  const lookup: ShapeLookup = (id) => byId.get(id);

  const content = unionRects(ordered.map((s) => expandForStroke(shapeBounds(s, lookup), s)));
  if (!content && !options.frame) return null;
  const bounds =
    options.frame ??
    (content && {
      x: content.x - padding,
      y: content.y - padding,
      width: content.width + padding * 2,
      height: content.height + padding * 2,
    });
  if (!bounds) return null;

  const body = ordered.map((shape) => renderShape(shape, lookup, measure)).join("\n");
  const background =
    options.background === null
      ? ""
      : `<rect x="${n(bounds.x)}" y="${n(bounds.y)}" width="${n(bounds.width)}" height="${n(bounds.height)}" fill="${options.background ?? "#ffffff"}"/>`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(bounds.width)}" height="${n(bounds.height)}" viewBox="${n(bounds.x)} ${n(bounds.y)} ${n(bounds.width)} ${n(bounds.height)}" font-family="${escapeXml(FONT_FAMILY)}">`,
    background,
    body,
    "</svg>",
  ].join("\n");
  return { svg, bounds };
}

function expandForStroke(rect: Rect, shape: Shape): Rect {
  const s = shape.style.strokeWidth / 2 + (shape.type === "arrow" ? 8 : 0);
  return { x: rect.x - s, y: rect.y - s, width: rect.width + s * 2, height: rect.height + s * 2 };
}

function renderShape(shape: Shape, lookup: ShapeLookup, measure: MeasureText): string {
  if (shape.type === "arrow") return renderArrow(shape, lookup, measure);

  const { style } = shape;
  const transform = `translate(${n(shape.x)} ${n(shape.y)})${shape.rotation ? ` rotate(${n(shape.rotation)})` : ""}`;
  const strokeAttrs = strokeAttributes(
    style.stroke,
    style.strokeWidth,
    STROKE_DASH[style.strokeStyle],
  );
  const fill = style.fill === "transparent" ? "none" : style.fill;
  const parts: string[] = [];

  switch (shape.type) {
    case "rectangle":
      parts.push(
        `<rect width="${n(shape.w)}" height="${n(shape.h)}" rx="4" fill="${fill}" ${strokeAttrs}/>`,
      );
      parts.push(
        centeredText(shape.label, shape.w, shape.h, style.fontSize, style.stroke, measure),
      );
      break;
    case "ellipse":
      parts.push(
        `<ellipse cx="${n(shape.w / 2)}" cy="${n(shape.h / 2)}" rx="${n(shape.w / 2)}" ry="${n(shape.h / 2)}" fill="${fill}" ${strokeAttrs}/>`,
      );
      parts.push(
        centeredText(shape.label, shape.w, shape.h, style.fontSize, style.stroke, measure),
      );
      break;
    case "text":
      parts.push(topText(shape.text, shape.w, 0, style.fontSize, style.stroke, measure, "start"));
      break;
    case "sticky":
      parts.push(`<rect width="${n(shape.w)}" height="${n(shape.h)}" rx="2" fill="${fill}"/>`);
      parts.push(
        topText(shape.text, shape.w - 24, 12, style.fontSize, style.stroke, measure, "start", 12),
      );
      break;
    case "freehand": {
      const pts: string[] = [];
      for (let i = 0; i < shape.points.length; i += 2)
        pts.push(`${n(shape.points[i] ?? 0)},${n(shape.points[i + 1] ?? 0)}`);
      parts.push(
        `<polyline points="${pts.join(" ")}" fill="none" stroke-linecap="round" stroke-linejoin="round" ${strokeAttrs}/>`,
      );
      break;
    }
    default:
      if (isSystemShape(shape)) {
        const dash =
          shape.type === "database" && shape.role === "replica"
            ? STROKE_DASH.dashed
            : STROKE_DASH[style.strokeStyle];
        parts.push(
          `<rect width="${n(shape.w)}" height="${n(shape.h)}" rx="${SYSTEM_LAYOUT.radius}" fill="${fill}" ${strokeAttributes(style.stroke, style.strokeWidth, dash)}/>`,
        );
        const iconSize = SYSTEM_LAYOUT.iconSize;
        parts.push(
          renderIcon(
            systemShapeIcon(shape),
            shape.w / 2 - iconSize / 2,
            SYSTEM_LAYOUT.iconTop,
            iconSize,
            style.stroke,
          ),
        );
        parts.push(
          singleLine(
            shape.label,
            shape.w / 2,
            SYSTEM_LAYOUT.labelTop + style.fontSize,
            style.fontSize,
            style.stroke,
            "600",
          ),
        );
        parts.push(
          singleLine(
            systemShapeCaption(shape),
            shape.w / 2,
            SYSTEM_LAYOUT.labelTop + style.fontSize * LINE_HEIGHT + SYSTEM_LAYOUT.captionSize,
            SYSTEM_LAYOUT.captionSize,
            SYSTEM_LAYOUT.captionColor,
          ),
        );
      }
  }
  return `<g transform="${transform}" opacity="${style.opacity}">${parts.join("")}</g>`;
}

function renderArrow(
  shape: Extract<Shape, { type: "arrow" }>,
  lookup: ShapeLookup,
  measure: MeasureText,
): string {
  const { start, end } = resolveArrow(shape, lookup);
  const { stroke, strokeWidth, opacity, fontSize } = shape.style;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = 10;
  const left = {
    x: end.x - head * Math.cos(angle - Math.PI / 7),
    y: end.y - head * Math.sin(angle - Math.PI / 7),
  };
  const right = {
    x: end.x - head * Math.cos(angle + Math.PI / 7),
    y: end.y - head * Math.sin(angle + Math.PI / 7),
  };
  const parts = [
    `<line x1="${n(start.x)}" y1="${n(start.y)}" x2="${n(end.x)}" y2="${n(end.y)}" ${strokeAttributes(stroke, strokeWidth, ARROW_DASH[shape.edgeType])} stroke-linecap="round"/>`,
    `<polygon points="${n(end.x)},${n(end.y)} ${n(left.x)},${n(left.y)} ${n(right.x)},${n(right.y)}" fill="${stroke}"/>`,
  ];
  if (shape.label) {
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const width = measure(shape.label, fontSize) + 12;
    parts.push(
      `<rect x="${n(mid.x - width / 2)}" y="${n(mid.y - fontSize * 0.8)}" width="${n(width)}" height="${n(fontSize * 1.6)}" rx="4" fill="#ffffff"/>`,
      singleLine(shape.label, mid.x, mid.y + fontSize * 0.35, fontSize, stroke),
    );
  }
  return `<g opacity="${opacity}">${parts.join("")}</g>`;
}

function strokeAttributes(stroke: string, width: number, dash: readonly number[]): string {
  if (width === 0) return 'stroke="none"';
  const dashAttr =
    dash.length > 0 ? ` stroke-dasharray="${dash.map((d) => n(d * width)).join(" ")}"` : "";
  return `stroke="${stroke}" stroke-width="${n(width)}"${dashAttr}`;
}

function renderIcon(icon: IconNode, x: number, y: number, size: number, color: string): string {
  const children = icon
    .map(([tag, attrs]) => {
      const attributes = Object.entries(attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}="${escapeXml(String(v))}"`)
        .join(" ");
      return `<${tag} ${attributes}/>`;
    })
    .join("");
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(size / 24)})" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</g>`;
}

function centeredText(
  text: string,
  w: number,
  h: number,
  fontSize: number,
  color: string,
  measure: MeasureText,
): string {
  if (!text) return "";
  const lines = wrapText(text, Math.max(1, w - 16), fontSize, measure);
  const lineHeight = fontSize * LINE_HEIGHT;
  const top = h / 2 - (lines.length * lineHeight) / 2 + fontSize;
  return lines
    .map((line, i) => singleLine(line, w / 2, top + i * lineHeight, fontSize, color))
    .join("");
}

function topText(
  text: string,
  width: number,
  top: number,
  fontSize: number,
  color: string,
  measure: MeasureText,
  anchor: "start" | "middle",
  left = 0,
): string {
  if (!text) return "";
  const lines = wrapText(text, Math.max(1, width), fontSize, measure);
  const lineHeight = fontSize * LINE_HEIGHT;
  return lines
    .map(
      (line, i) =>
        `<text x="${n(left)}" y="${n(top + fontSize + i * lineHeight)}" font-size="${n(fontSize)}" fill="${color}" text-anchor="${anchor}">${escapeXml(line)}</text>`,
    )
    .join("");
}

function singleLine(
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  weight = "400",
): string {
  if (!text) return "";
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(fontSize)}" font-weight="${weight}" fill="${color}" text-anchor="middle">${escapeXml(text)}</text>`;
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Rounds to 2 decimals to keep files small and diffs stable. */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}
