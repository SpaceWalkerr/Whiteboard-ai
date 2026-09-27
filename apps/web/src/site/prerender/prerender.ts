import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { catalogResponseSchema, type CatalogResponse } from "@whiteboard/shared/billing";
import type { WebEnv } from "@whiteboard/shared/env/web";
import { TEMPLATE_SLUGS } from "@whiteboard/shared/templates";
import { unfilledPlaceholders } from "../config";
import { buildOgImage } from "../og";
import { htmlFileFor, ogImageFor, publicPages } from "../pages";
import { templatePreviewSvg } from "../previews";
import { PUBLIC_DATA_ID, serializePublicData } from "../publicData";
import { headTags, robotsTxt, sitemapXml } from "../seo";
import { renderPage } from "./render";

/**
 * Writes the static public site into a finished browser build (dist/): one HTML file per
 * public page (dist/<page>.html, served without the extension by Vercel cleanUrls), app.html
 * (the empty shell for app routes), Open Graph images, template previews, sitemap.xml and
 * robots.txt.
 */

const HEAD_START = "<!--head:start-->";
const HEAD_END = "<!--head:end-->";
const ROOT = '<div id="root"></div>';

interface ManifestChunk {
  file: string;
  imports?: string[];
}

export interface PrerenderOptions {
  outDir: string;
  env: WebEnv;
  /** A production deploy: missing business details or prices fail the build. */
  production: boolean;
  log: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export async function fetchCatalog(
  apiUrl: string,
  {
    production,
    log,
    fetchImpl = fetch,
  }: Pick<PrerenderOptions, "production" | "log" | "fetchImpl">,
): Promise<CatalogResponse | null> {
  try {
    const response = await fetchImpl(`${apiUrl}/billing/plans`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
    return catalogResponseSchema.parse(await response.json());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (production)
      throw new Error(`couldn't load plans from ${apiUrl}/billing/plans (${reason})`, {
        cause: error,
      });
    log(
      `plans unavailable from ${apiUrl} (${reason}); prices show "—" until the browser loads them`,
    );
    return null;
  }
}

/** A module's chunk and every chunk it imports statically: what the page needs to hydrate. */
export function chunksFor(
  manifest: Record<string, ManifestChunk>,
  modules: readonly string[],
): string[] {
  const files = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || files.has(`/${chunk.file}`)) return;
    files.add(`/${chunk.file}`);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const module of modules) {
    if (!manifest[module]) throw new Error(`${module} is not in the build manifest`);
    visit(module);
  }
  return [...files];
}

export function replaceHead(shell: string, head: string): string {
  const start = shell.indexOf(HEAD_START);
  const end = shell.indexOf(HEAD_END);
  if (start < 0 || end < 0) throw new Error("index.html is missing the head markers");
  return `${shell.slice(0, start)}${head}${shell.slice(end + HEAD_END.length)}`;
}

async function writeOut(outDir: string, file: string, content: string | Buffer): Promise<void> {
  const target = path.join(outDir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/**
 * React puts resource hints for what the page uses (e.g. `<link rel="preload" as="image">`
 * for images) at the start of a rendered fragment. They belong in <head>: split them off.
 */
export function splitResourceHints(body: string): { hints: string; body: string } {
  const match = /^(?:<link [^>]*\/?>)+/.exec(body);
  if (!match) return { hints: "", body };
  return { hints: match[0], body: body.slice(match[0].length) };
}

export async function prerenderSite(options: PrerenderOptions): Promise<void> {
  const { outDir, env, production, log } = options;

  const unfilled = unfilledPlaceholders();
  if (unfilled.length > 0) {
    const message = `business details in src/site/config.ts are placeholders: ${unfilled.join(", ")}`;
    if (production) throw new Error(message);
    log(`${message} (allowed outside production deploys)`);
  }

  const catalog = await fetchCatalog(env.VITE_API_URL, options);
  const manifestDir = path.join(outDir, ".vite");
  const manifest = JSON.parse(
    await readFile(path.join(manifestDir, "manifest.json"), "utf8"),
  ) as Record<string, ManifestChunk>;
  const shell = await readFile(path.join(outDir, "index.html"), "utf8");
  if (!shell.includes(ROOT)) throw new Error("index.html has no empty #root");

  // App routes (dashboard, boards…) are client-rendered from an empty shell, never indexed.
  await writeOut(
    outDir,
    "app.html",
    replaceHead(
      shell,
      '<title>Whiteboard.ai</title>\n    <meta name="robots" content="noindex" />',
    ),
  );

  const pages = publicPages();
  const data = { catalog };
  const publicData = `<script id="${PUBLIC_DATA_ID}" type="application/json">${serializePublicData(data)}</script>`;
  for (const page of pages) {
    const { hints, body } = splitResourceHints(await renderPage(page.path, env, data));
    // A pending Suspense boundary means content streamed out of order (layout shift, and
    // text crawlers may not attach to its place): every page must render in one pass.
    if (body.includes("<!--$?-->"))
      throw new Error(`${page.path} suspended while prerendering; preload what it needs first`);
    const head = `${headTags(page, {
      siteUrl: env.VITE_SITE_URL,
      catalog,
      preload: chunksFor(manifest, page.modules),
    })}${hints ? `\n    ${hints}` : ""}`;
    const html = replaceHead(shell, head).replace(
      ROOT,
      `<div id="root">${body}</div>\n    ${publicData}`,
    );
    await writeOut(outDir, htmlFileFor(page.path), html);
    await writeOut(
      outDir,
      ogImageFor(page.path),
      await buildOgImage({ heading: page.ogHeading, label: page.ogLabel }),
    );
  }

  for (const slug of TEMPLATE_SLUGS) {
    const svg = templatePreviewSvg(slug);
    if (!svg) throw new Error(`no preview for template ${slug}`);
    await writeOut(outDir, `template-previews/${slug}.svg`, svg);
  }
  await writeOut(outDir, "sitemap.xml", sitemapXml(pages, env.VITE_SITE_URL));
  await writeOut(outDir, "robots.txt", robotsTxt(env.VITE_SITE_URL));
  // The manifest was only needed to find each page's chunks; don't publish it.
  await rm(manifestDir, { recursive: true, force: true });
  log(`${String(pages.length)} public pages written to ${outDir}`);
}
