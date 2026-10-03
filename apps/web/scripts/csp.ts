import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import type { WebEnv } from "@whiteboard/shared/env/web";

/**
 * The web app's Content Security Policy, built from the deployment's public env so each
 * environment (preview, staging, production) allows exactly its own API, WebSocket, Supabase
 * and PostHog hosts.
 *
 * It ships as a `<meta http-equiv>` tag in every HTML file because the hosts differ per
 * environment and vercel.json is static. The directives a meta tag can't carry
 * (`frame-ancestors`, reporting) are sent as headers by vercel.json; browsers enforce both.
 *
 * - Scripts: our origin only, plus Razorpay Checkout (loaded only when someone pays) and the
 *   hash of the tiny dark-mode script in <head>. No 'unsafe-inline', no 'unsafe-eval'.
 *   'wasm-unsafe-eval' allows compiling WebAssembly (the PDF export's layout engine) and
 *   nothing else.
 * - Styles: 'unsafe-inline' because prerendered HTML has `style` attributes (React) and Radix
 *   positions popovers with inline styles. Style injection can't run code.
 * - Frames: Razorpay Checkout only. Objects/plugins: none. Forms post only to our origin.
 */
export interface CspSources {
  env: Pick<
    WebEnv,
    "VITE_API_URL" | "VITE_WS_URL" | "VITE_SUPABASE_URL" | "VITE_POSTHOG_KEY" | "VITE_POSTHOG_HOST"
  >;
  /** Inline scripts allowed by hash (their exact text). */
  inlineScripts: readonly string[];
}

export const RAZORPAY = {
  script: "https://checkout.razorpay.com",
  frames: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
  // Checkout.js reports its own errors/metrics from the page.
  connect: ["https://api.razorpay.com", "https://lumberjack.razorpay.com"],
} as const;

export function scriptHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
}

function origin(url: string): string {
  return new URL(url).origin;
}

export function buildCsp({ env, inlineScripts }: CspSources): string {
  const supabase = origin(env.VITE_SUPABASE_URL);
  const connect = [
    "'self'",
    origin(env.VITE_API_URL),
    // WebSocket origins (wss://) aren't covered by the https origin of the same host.
    origin(env.VITE_WS_URL),
    supabase,
    ...RAZORPAY.connect,
    ...(env.VITE_POSTHOG_KEY ? [origin(env.VITE_POSTHOG_HOST)] : []),
  ];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      ...inlineScripts.map(scriptHash),
      RAZORPAY.script,
      "'wasm-unsafe-eval'",
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    // data:/blob: for exported images and canvas snapshots; Supabase for signed thumbnail URLs.
    "img-src": ["'self'", "data:", "blob:", supabase],
    "font-src": ["'self'", "data:"],
    "connect-src": [...new Set(connect)],
    "frame-src": [...RAZORPAY.frames],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
  // Only when the app itself is served over https (never for local http development/E2E).
  const secure = env.VITE_API_URL.startsWith("https://");
  return [
    ...Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(" ")}`),
    ...(secure ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function cspMetaTag(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', "&quot;")}" />`;
}

/**
 * Adds the policy to index.html (and so to app.html and every prerendered page, which are
 * made from it) in production builds. Not in `vite dev`: the dev server injects inline
 * scripts (React Fast Refresh) that a strict policy would block.
 */
export function cspPlugin(sources: () => CspSources): Plugin {
  return {
    name: "whiteboard:csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const charset = /<meta charset="UTF-8" \/>/i;
        if (!charset.test(html))
          throw new Error("index.html must start <head> with <meta charset>");
        // Right after the charset: the policy must come before any script or stylesheet.
        return html.replace(charset, (tag) => `${tag}\n    ${cspMetaTag(buildCsp(sources()))}`);
      },
    },
  };
}
