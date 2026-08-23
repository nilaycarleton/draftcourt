/** Strips `undefined`-valued keys from an object. Needed because the
 * project's `exactOptionalPropertyTypes: true` setting distinguishes
 * "the key is absent" from "the key is present with value `undefined`" —
 * building an options object from a set of optional query params
 * otherwise fails to typecheck against an interface with `field?: T`
 * properties. */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
