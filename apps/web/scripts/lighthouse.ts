/**
 * `pnpm --filter @whiteboard/web lighthouse` — runs Lighthouse (mobile: emulated phone,
 * simulated slow 4G and CPU throttling, Lighthouse's defaults) on every page in the built
 * sitemap and fails if performance, accessibility or SEO scores below 90 anywhere.
 *
 * Needs a finished `pnpm build` (dist/) and Playwright's Chromium
 * (`pnpm exec playwright install chromium`). Serves dist/ with `vite preview`, the same
 * routing as production. Reports are written to lighthouse-report/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { preview } from "vite";

const MIN_SCORE = 0.9;
const CATEGORIES = ["performance", "accessibility", "seo"] as const;
const PORT = 4174;
const root = path.resolve(import.meta.dirname, "..");
const reportDir = path.join(root, "lighthouse-report");

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function pagePaths(): Promise<string[]> {
  const sitemap = await readFile(path.join(root, "dist", "sitemap.xml"), "utf8");
  const only = process.argv.slice(2);
  const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
    ([, loc = ""]) => new URL(loc).pathname,
  );
  return only.length > 0 ? paths.filter((p) => only.includes(p)) : paths;
}

async function main(): Promise<number> {
  const paths = await pagePaths();
  const server = await preview({
    root,
    configLoader: "runner",
    preview: { port: PORT, strictPort: true, open: false },
    logLevel: "warn",
  });
  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
  });
  await mkdir(reportDir, { recursive: true });
  const failures: string[] = [];
  try {
    for (const pagePath of paths) {
      const url = `http://localhost:${String(PORT)}${pagePath}`;
      const result = await lighthouse(
        url,
        { port: chrome.port, output: "html", logLevel: "error" },
        {
          extends: "lighthouse:default",
          settings: { onlyCategories: [...CATEGORIES], formFactor: "mobile" },
        },
      );
      if (!result) throw new Error(`Lighthouse returned nothing for ${url}`);
      const scores = CATEGORIES.map((id) => result.lhr.categories[id]?.score ?? 0);
      const line = CATEGORIES.map((id, i) => `${id} ${String(Math.round((scores[i] ?? 0) * 100))}`);
      const ok = scores.every((score) => score >= MIN_SCORE);
      log(`${ok ? "ok  " : "FAIL"} ${pagePath.padEnd(40)} ${line.join("  ")}`);
      if (!ok) failures.push(pagePath);
      const name = pagePath === "/" ? "home" : pagePath.slice(1).replaceAll("/", "--");
      const report = Array.isArray(result.report) ? result.report.join("") : result.report;
      await writeFile(path.join(reportDir, `${name}.html`), report);
    }
  } finally {
    chrome.kill();
    await server.close();
  }
  if (failures.length > 0) {
    log(
      `\n${String(failures.length)} page(s) below ${String(MIN_SCORE * 100)}: ${failures.join(", ")}`,
    );
    log(`Reports: ${reportDir}`);
    return 1;
  }
  log(
    `\nAll ${String(paths.length)} pages ≥ ${String(MIN_SCORE * 100)} (mobile). Reports: ${reportDir}`,
  );
  return 0;
}

process.exitCode = await main();
