/**
 * Drops undefined values. Konva's prop types don't accept explicit `undefined`, which our
 * strict `exactOptionalPropertyTypes` setting enforces, so optional props go through this.
 */
export function compact<T extends Record<string, unknown>>(
  props: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(props).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
