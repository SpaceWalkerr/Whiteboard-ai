import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { catalogResponseSchema } from "@whiteboard/shared/billing";
import { CATALOG_KEY } from "@/features/billing/api";

/**
 * Data fetched at build time and embedded in prerendered pages, so the HTML shows real prices
 * and the browser starts from the same data (no hydration mismatch). The browser refetches it
 * right after loading, so a price change reaches visitors before the next deploy.
 */
export const PUBLIC_DATA_ID = "public-data";

const publicDataSchema = z.object({ catalog: catalogResponseSchema.nullable() });
export type PublicData = z.infer<typeof publicDataSchema>;

export function seedQueryClient(queryClient: QueryClient, data: PublicData | null): void {
  if (!data?.catalog) return;
  // Timestamped long ago: shown immediately, refetched as soon as a page uses it.
  queryClient.setQueryData(CATALOG_KEY, data.catalog, { updatedAt: 1 });
}

/** JSON for a <script type="application/json"> tag; `<` escaped so it can't close the tag. */
export function serializePublicData(data: PublicData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function readPublicData(): PublicData | null {
  const element = document.getElementById(PUBLIC_DATA_ID);
  if (!element?.textContent) return null;
  try {
    const parsed = publicDataSchema.safeParse(JSON.parse(element.textContent));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
