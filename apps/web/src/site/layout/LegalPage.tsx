import type { ReactNode } from "react";
import { COMPANY, LEGAL_REVIEWED, LEGAL_UPDATED } from "../config";
import { STATIC_PAGES, type StaticPath } from "../meta";
import { usePageTitle } from "./usePageTitle";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "27 September 2026". Not toLocaleDateString: Node and browsers may format it differently. */
function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${String(day)} ${MONTHS[(month ?? 1) - 1] ?? ""} ${String(year)}`;
}

/** Shared frame for the policy pages: heading, date, draft notice and readable prose. */
export function LegalPage({
  path,
  title,
  children,
}: {
  path: StaticPath;
  title: string;
  children: ReactNode;
}) {
  usePageTitle(STATIC_PAGES[path].title);
  return (
    <article className="prose-site mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1>{title}</h1>
      <p className="text-sm text-muted-foreground">
        Last updated: {formatDate(LEGAL_UPDATED)} · {COMPANY.productName} is operated by{" "}
        {COMPANY.legalName}.
      </p>
      {!LEGAL_REVIEWED && (
        <p
          role="note"
          className="rounded-md border border-amber-600/40 bg-amber-100 px-4 py-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100"
        >
          <strong>Draft — review with a professional before launch.</strong> This text is a starting
          point, not legal advice.
        </p>
      )}
      {children}
    </article>
  );
}
