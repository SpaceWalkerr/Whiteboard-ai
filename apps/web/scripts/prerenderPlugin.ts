import { spawn } from "node:child_process";
import path from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";

/**
 * Prerenders the public pages at the end of the browser build.
 *
 * `pnpm build` first builds src/site/prerender/main.ts for Node (dist-ssr/), then the browser
 * bundle. When that is written, this plugin runs the Node bundle, which renders every public
 * page into dist/ (see src/site/prerender/prerender.ts). It runs in a child process because
 * the config's module runner is already closed at this point, and before vite-plugin-pwa
 * generates the service worker (closeBundle "pre" vs. the PWA's "post"), so the precache
 * holds the final files.
 */
const SSR_ENTRY = "dist-ssr/main.js";

function runNode(script: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`prerender failed (exit code ${String(code)})`));
    });
  });
}

/** In `vite dev`, template previews are drawn on request (they are files only in builds). */
function servePreviews(server: ViteDevServer): void {
  server.middlewares.use((req, res, next) => {
    const slug = /^\/template-previews\/([a-z0-9-]+)\.svg$/.exec(req.url ?? "")?.[1];
    if (!slug) {
      next();
      return;
    }
    void server
      .ssrLoadModule("/src/site/previews.ts")
      .then((module) => {
        const render = (module as { templatePreviewSvg: (slug: string) => string | null })
          .templatePreviewSvg;
        const svg = render(slug);
        if (!svg) {
          next();
          return;
        }
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(svg);
      })
      .catch(next);
  });
}

export function prerenderPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "whiteboard:prerender",
    configResolved(resolved) {
      config = resolved;
    },
    configureServer: servePreviews,
    closeBundle: {
      order: "pre",
      sequential: true,
      async handler() {
        if (config.command !== "build" || config.build.ssr) return;
        const outDir = path.resolve(config.root, config.build.outDir);
        await runNode(SSR_ENTRY, [outDir], config.root);
      },
    },
  };
}
