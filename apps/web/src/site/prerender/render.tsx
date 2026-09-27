import { QueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { prerender } from "react-dom/static";
import { StaticRouter } from "react-router";
import type { WebEnv } from "@whiteboard/shared/env/web";
import { App } from "@/App";
import { preloadPublicPage } from "@/routes";
import { seedQueryClient, type PublicData } from "../publicData";

/**
 * Renders one public page to HTML. Same tree as main.tsx with a StaticRouter, so the browser
 * can hydrate it.
 *
 * The page must come out in document order. A Suspense boundary that suspends, or that React
 * decides to outline because it is large, is emitted as a placeholder with the content at the
 * end of the document moved in by an inline script — the footer paints first and is then
 * shoved down the page (a large layout shift). So the page's module is loaded first and
 * outlining is off.
 */
export async function renderPage(url: string, env: WebEnv, data: PublicData): Promise<string> {
  await preloadPublicPage(new URL(url, "http://prerender.invalid").pathname);
  const queryClient = new QueryClient();
  seedQueryClient(queryClient, data);
  const { prelude } = await prerender(
    <StrictMode>
      <StaticRouter location={url}>
        <App env={env} queryClient={queryClient} />
      </StaticRouter>
    </StrictMode>,
    // React outlines any boundary larger than this (to stream it progressively), which emits
    // it out of order just like a suspended one. A static page is sent whole: never outline.
    { progressiveChunkSize: Number.MAX_SAFE_INTEGER },
  );
  return new Response(prelude).text();
}
