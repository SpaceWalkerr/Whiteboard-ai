/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv as loadViteEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
// Workspace packages ship TypeScript source, so this config must be loaded with the
// module-runner loader (`--configLoader runner`, set in every package.json script).
import { loadEnv } from "@whiteboard/shared/env";
import { webEnvSchema } from "@whiteboard/shared/env/web";

export default defineConfig(({ command, mode }) => {
  // Fail the production build (not just the page at runtime) when public env is missing.
  if (command === "build") {
    loadEnv(webEnvSchema, loadViteEnv(mode, process.cwd(), "VITE_"));
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      // Service worker: precaches the app shell so a board (whose data is in IndexedDB) can be
      // opened with no network. Only built files are cached — never API or sync traffic.
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: "script-defer",
        manifest: false,
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg}"],
          navigateFallback: "/index.html",
          cleanupOutdatedCaches: true,
          // The board chunk (Konva + Yjs) is ~650 kB.
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    build: { sourcemap: true },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
    },
  };
});
