/**
 * URL fragments can hold secrets: a private board's key (`#key=…`) and interview summary
 * tokens live there precisely because browsers never send fragments to servers. Anything we
 * send to a third party ourselves (analytics, error reports) must drop them too.
 */
export function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

const URL_LIKE = /^(https?:)?\/\//i;

/**
 * Returns a copy of `value` with the fragment removed from every URL-looking string, at any
 * depth (event properties, `$set`, breadcrumbs…). Other values are unchanged.
 */
export function scrubFragments<T>(value: T): T {
  if (typeof value === "string")
    return (URL_LIKE.test(value) || value.startsWith("/") ? stripFragment(value) : value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => scrubFragments(item)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = scrubFragments(item);
    return copy as T;
  }
  return value;
}
