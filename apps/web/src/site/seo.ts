import { COMPANY } from "./config";
import { ogImageFor, organization, type PublicPage, type StructuredDataContext } from "./pages";
import { THEME_SCRIPT } from "./theme";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** JSON-LD inside <script>: `<` escaped so text can never close the tag. */
function jsonLd(data: object): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

export function canonicalUrl(siteUrl: string, path: string): string {
  return path === "/" ? `${siteUrl}/` : `${siteUrl}${path}`;
}

/**
 * Everything a prerendered page adds to <head>: title, description, canonical URL, Open Graph
 * and Twitter tags, structured data, module preloads and the dark-mode script.
 */
export function headTags(
  page: PublicPage,
  options: Omit<StructuredDataContext, "image"> & { preload: readonly string[] },
): string {
  const url = canonicalUrl(options.siteUrl, page.path);
  const image = `${options.siteUrl}/${ogImageFor(page.path)}`;
  const context: StructuredDataContext = { ...options, image };
  const tags = [
    `<title>${escapeHtml(page.title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta property="og:type" content="${page.path === "/" ? "website" : "article"}" />`,
    `<meta property="og:site_name" content="${escapeHtml(COMPANY.productName)}" />`,
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeHtml(page.ogHeading)}" />`,
    `<meta property="og:locale" content="en_IN" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    `<script>${THEME_SCRIPT}</script>`,
    ...options.preload.map(
      (href) => `<link rel="modulepreload" crossorigin href="${escapeHtml(href)}" />`,
    ),
    jsonLd(organization(options.siteUrl)),
    ...page.structuredData(context).map(jsonLd),
  ];
  return tags.join("\n    ");
}

export function sitemapXml(pages: readonly PublicPage[], siteUrl: string): string {
  const urls = pages
    .map(
      (page) =>
        `  <url>\n    <loc>${escapeHtml(canonicalUrl(siteUrl, page.path))}</loc>\n    <lastmod>${page.updated}</lastmod>\n  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** App areas are private (and useless to crawlers); everything else may be indexed. */
export const DISALLOWED_PATHS = [
  "/app",
  "/board/",
  "/s/",
  "/invite/",
  "/interviews/",
  "/auth/",
  "/sign-in",
] as const;

export function robotsTxt(siteUrl: string): string {
  return [
    "User-agent: *",
    ...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
    "",
    `Sitemap: ${siteUrl}/sitemap.xml`,
    "",
  ].join("\n");
}
