import type { SettingsStore } from '../modules.js';

/**
 * In-memory settings, keyed the way the real store keys them.
 *
 * Unlike the XTrace stubs this one is a FAITHFUL model, because a keyed store is a thing a Map
 * genuinely is — which is the whole argument of M11. The stub that came before it had to
 * pretend XTrace round-trips a record, and that pretence is what let the counting query and
 * the settings path both ship against a substrate that could serve neither.
 */
export class StubSettingsStore implements SettingsStore {
  private readonly values = new Map<string, unknown>();

  private static key(profile: string, key: string): string {
    return `${profile}\u0000${key}`;
  }

  get(profile: string, key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(StubSettingsStore.key(profile, key)) ?? null);
  }

  put(profile: string, key: string, value: unknown): Promise<void> {
    // Cloned in, so a caller mutating the object it stored does not reach back into the store
    // — the real one serialises over HTTP and cannot be reached that way.
    this.values.set(StubSettingsStore.key(profile, key), structuredClone(value));
    return Promise.resolve();
  }
}
