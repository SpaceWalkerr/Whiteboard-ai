/**
 * The board model has no instance-count field, so how many instances a component stands for
 * is read from the drawing, using the two conventions people actually use:
 *   - an explicit count in the label: "API ×3", "API x3", "3x API", "API (3 instances)";
 *   - several shapes of the same kind whose labels differ only by a trailing number:
 *     "Order service 1", "Order service 2" (or "#2", "- 2", "instance 2").
 */

const MAX_EXPLICIT = 10_000;

const EXPLICIT_COUNT_PATTERNS: readonly RegExp[] = [
  // "×3", "x3", "* 3", "(x3)" — the marker must start a word so "box3" doesn't count.
  /(?:^|[\s([])[×x*]\s?(\d{1,5})\b/i,
  // "3x API", "3 × API"
  /(?:^|[\s([])(\d{1,5})\s?[×x](?=\s|$)/i,
  // "3 instances", "2 replicas", "4 nodes", "5 pods", "2 copies"
  /\b(\d{1,5})\s*(?:instances?|replicas?|nodes?|pods?|copies)\b/i,
];

/** The count written in a label, or null when there is none (or it is nonsensical). */
export function explicitInstanceCount(label: string): number | null {
  for (const pattern of EXPLICIT_COUNT_PATTERNS) {
    const match = pattern.exec(label);
    const count = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (Number.isInteger(count) && count >= 1 && count <= MAX_EXPLICIT) return count;
  }
  return null;
}

/**
 * Label with counts and trailing instance numbers removed, lower-cased, so that the shapes of
 * one horizontally scaled component share it. Empty for unlabeled shapes: two unlabeled
 * "Service" boxes are more likely two different services than two copies of one.
 */
export function instanceLabelKey(label: string): string {
  const tidy = (text: string) =>
    text
      .replace(/[()[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  let key = label.toLowerCase().normalize("NFKC");
  for (const pattern of EXPLICIT_COUNT_PATTERNS) key = key.replace(pattern, " ");
  const stripped = tidy(
    key.replace(/[\s\-_#:.]*(?:instance|replica|node|copy|pod)?[\s\-_#:.]*\d+\s*$/u, ""),
  );
  // A label that is only a number ("3") keeps it rather than collapsing to nothing.
  return stripped === "" ? tidy(key) : stripped;
}
