/// <reference types="vitest/config" />
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv as loadViteEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
// Workspace packages ship TypeScript source, so this config must be loaded with the
// module-runner loader (`--configLoader runner`, set in every package.json script).
import { loadEnv } from "@whiteboard/shared/env";
import { webEnvSchema } from "@whiteboard/shared/env/web";
import { prerenderPlugin } from "./scripts/prerenderPlugin";

/**
 * `vite preview` routes like Vercel (vercel.json): a prerendered page is served from
 * <path>.html (cleanUrls), every other extensionless path gets the app shell.
 */
function previewRouting(): Plugin {
  return {
    name: "whiteboard:preview-routing",
    configurePreviewServer(server) {
      const outDir = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use((req, _res, next) => {
        const [pathname = "/", query] = (req.url ?? "/").split("?");
        if (pathname !== "/" && !pathname.includes(".") && !pathname.startsWith("/assets/")) {
          const page = path.join(outDir, `${pathname.replace(/\/$/, "")}.html`);
          const target = existsSync(page) ? `${pathname.replace(/\/$/, "")}.html` : "/app.html";
          req.url = query ? `${target}?${query}` : target;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command, mode, isSsrBuild }) => {
  // Fail the production build (not just the page at runtime) when public env is missing.
  if (command === "build") {
    loadEnv(webEnvSchema, loadViteEnv(mode, process.cwd(), "VITE_"));
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Browser build only: the SSR build (dist-ssr/) is just the prerenderer's renderer.
      ...(isSsrBuild
        ? []
        : [
            prerenderPlugin(),
            previewRouting(),
            // Service worker: precaches the app shell and the prerendered pages, so a board
            // (whose data is in IndexedDB) can be opened with no network. Only built files are
            // cached — never API or sync traffic.
            VitePWA({
              registerType: "autoUpdate",
              injectRegister: "script-defer",
              manifest: false,
              // After the prerender plugin, so the precache lists the final HTML files.
              integration: { closeBundleOrder: "post" },
              workbox: {
                globPatterns: ["**/*.{js,css,html,svg}"],
                navigateFallback: "/app.html",
                // Opening a file (sitemap.xml, an OG image…) must not get the app shell.
                navigateFallbackDenylist: [/\.[a-z0-9]+$/i],
                cleanupOutdatedCaches: true,
                // The board chunk (Konva + Yjs) is ~650 kB.
                maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
              },
              devOptions: { enabled: false },
            }),
          ]),
    ],
    define: {
      __BUILD_YEAR__: JSON.stringify(new Date().getUTCFullYear()),
    },
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: {
      sourcemap: true,
      // The prerenderer reads it to preload each page's chunks (and then deletes it).
      manifest: !isSsrBuild,
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
    },
  };
});
