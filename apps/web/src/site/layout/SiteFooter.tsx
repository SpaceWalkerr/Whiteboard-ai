import { Link } from "react-router";
import { openConsentSettings } from "../consent/consent";
import { COMPANY } from "../config";
import { LEGAL_LINKS } from "../legalLinks";

const PRODUCT_LINKS = [
  { to: "/pricing", label: "Pricing" },
  { to: "/templates", label: "System design templates" },
  { to: "/docs", label: "Docs" },
  { to: "/docs/interview-mode", label: "Interview mode" },
] as const;

const linkClass = "rounded-sm text-muted-foreground hover:text-foreground hover:underline";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t bg-muted/40">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-3 sm:px-6">
        <div className="space-y-2">
          <p className="font-semibold">{COMPANY.productName}</p>
          <p className="text-muted-foreground">
            A collaborative whiteboard for system design, with an AI that reviews your architecture.
          </p>
        </div>
        <nav aria-label="Product">
          <h2 className="font-semibold">Product</h2>
          <ul className="mt-2 space-y-2">
            {PRODUCT_LINKS.map((link) => (
              <li key={link.to}>
                <Link to={link.to} className={linkClass}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Legal">
          <h2 className="font-semibold">Company & legal</h2>
          <ul className="mt-2 space-y-2">
            {LEGAL_LINKS.map((link) => (
              <li key={link.to}>
                <Link to={link.to} className={linkClass}>
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <button type="button" onClick={openConsentSettings} className={linkClass}>
                Cookie settings
              </button>
            </li>
          </ul>
        </nav>
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-xs text-muted-foreground sm:px-6">
        © {__BUILD_YEAR__} {COMPANY.legalName}. Prices in INR include applicable taxes.
      </p>
    </footer>
  );
}
