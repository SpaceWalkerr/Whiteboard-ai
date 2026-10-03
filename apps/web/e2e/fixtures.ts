import { expect, test as base, type BrowserContext } from "@playwright/test";

/**
 * Every E2E test runs against the production build, which carries the real Content Security
 * Policy. This fixture fails any test during which a page reported a CSP violation, so each
 * flow the suite covers (sign-in, boards, sync, sharing, private boards, reviews, interviews,
 * billing) also proves the policy doesn't break it. Contexts a test opens itself
 * (two-browser collaboration) are watched too.
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context, browser }, use) => {
      const violations: string[] = [];
      const watch = async (watched: BrowserContext) => {
        await watched.exposeBinding("__reportCspViolation", (_source, text: string) => {
          violations.push(text);
        });
        await watched.addInitScript(() => {
          document.addEventListener("securitypolicyviolation", (event) => {
            const report = (window as unknown as { __reportCspViolation: (t: string) => void })
              .__reportCspViolation;
            report(
              `${event.effectiveDirective} blocked ${event.blockedURI || "(inline)"} on ${location.pathname}`,
            );
          });
        });
      };
      await watch(context);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const created = await newContext(options);
        await watch(created);
        return created;
      };
      // Playwright's `use` returns after the test even when it failed, so this always runs.
      await use(violations);
      browser.newContext = newContext;
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
