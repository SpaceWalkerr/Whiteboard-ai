/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv as loadViteEnv } from "vite";
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
    plugins: [react(), tailwindcss()],
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
