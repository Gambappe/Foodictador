/**
 * The compile-time half of the false-receipt defence (SL-61).
 *
 * A `switch` over a discriminated union whose `default` calls this fails to COMPILE when a new
 * variant is added, because the unhandled variant is no longer assignable to `never`. That is
 * the difference between a rule people remember and a rule the build enforces.
 *
 * It throws as well, because a value can still arrive from outside the type system — a stale
 * payload over the wire, a fixture from an older build — and silently rendering nothing for it
 * would be the same class of defect this exists to prevent.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}
