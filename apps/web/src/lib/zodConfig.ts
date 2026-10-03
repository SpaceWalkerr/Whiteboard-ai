import { z } from "zod";

/**
 * zod compiles fast object parsers with `new Function` when the page allows it. Our CSP
 * doesn't (no 'unsafe-eval'), so the probe would log a CSP violation on every page load;
 * jitless mode never tries. Imported first by main.tsx, before any schema parses.
 */
z.config({ jitless: true });
