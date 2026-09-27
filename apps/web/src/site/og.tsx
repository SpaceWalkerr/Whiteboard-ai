import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

/**
 * Open Graph images (1200×630 PNG) drawn at build time: satori lays out the card and turns
 * text into paths, resvg rasterises it. Build-only — never part of the browser bundle.
 */
const require = createRequire(import.meta.url);
let fonts: Promise<{ regular: Buffer; bold: Buffer }> | null = null;

function loadFonts() {
  fonts ??= Promise.all([
    readFile(require.resolve("@fontsource/inter/files/inter-latin-400-normal.woff")),
    readFile(require.resolve("@fontsource/inter/files/inter-latin-700-normal.woff")),
  ]).then(([regular, bold]) => ({ regular, bold }));
  return fonts;
}

export async function buildOgImage({
  heading,
  label,
}: {
  heading: string;
  label: string;
}): Promise<Buffer> {
  const [{ default: satori }, { Resvg }, { regular, bold }] = await Promise.all([
    import("satori"),
    import("@resvg/resvg-js"),
    loadFonts(),
  ]);
  const svg = await satori(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        background: "#0a0a0a",
        backgroundImage:
          "radial-gradient(circle at 25px 25px, #262626 2px, transparent 0), radial-gradient(circle at 75px 75px, #262626 2px, transparent 0)",
        backgroundSize: "100px 100px",
        color: "#fafafa",
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", fontSize: 30, color: "#a3a3a3" }}>{label}</div>
      <div
        style={{
          display: "flex",
          fontSize: heading.length > 45 ? 60 : 72,
          fontWeight: 700,
          lineHeight: 1.1,
        }}
      >
        {heading}
      </div>
      <div style={{ display: "flex", alignItems: "center", fontSize: 32, fontWeight: 700 }}>
        <div
          style={{
            display: "flex",
            width: 44,
            height: 44,
            marginRight: 16,
            borderRadius: 10,
            border: "4px solid #fafafa",
          }}
        />
        Whiteboard.ai
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Inter", data: regular, weight: 400, style: "normal" },
        { name: "Inter", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
}
