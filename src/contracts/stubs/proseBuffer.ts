import type { Flush, ProseBuffer } from '../../memory/proseBuffer.js';

/**
 * An in-memory confession buffer.
 *
 * Exists because `src/ui/**` must stay browser-safe — `purity.test.ts` fails the build on a
 * `node:` import anywhere under it, including tests, and the real buffer is file-backed. It
 * caught exactly that when the UI suites were first wired for M20.
 *
 * Batching POLICY is not modelled here: `append` never triggers a flush, so a caller under
 * test gets predictable "held" results and `proseBuffer.test.ts` remains the single place the
 * threshold is asserted. A stub that reimplemented the rule would be a second copy free to
 * drift from the real one.
 */
export class StubProseBuffer implements ProseBuffer {
  private readonly entries = new Map<string, Array<{ text: string; readId?: string }>>();
  private batches = 0;

  append(profile: string, text: string, readId?: string): Flush | null {
    const entry = readId === undefined ? { text } : { text, readId };
    this.entries.set(profile, [...(this.entries.get(profile) ?? []), entry]);
    return null; // never flushes on append — see the note above
  }

  drain(): Flush[] {
    const flushes: Flush[] = [];
    for (const [profile, entries] of this.entries) {
      if (entries.length === 0) continue;
      this.batches += 1;
      flushes.push({
        profile,
        texts: entries.map((e) => e.text),
        convId: `stub:${profile}:${String(this.batches)}`,
      });
    }
    this.entries.clear();
    return flushes;
  }

  pending(profile: string): number {
    return (this.entries.get(profile) ?? []).length;
  }

  /** Real, not a no-op: `forget`'s fourth target is behaviour a UI test may need to assert. */
  forget(readId: string): number {
    let removed = 0;
    for (const [profile, entries] of this.entries) {
      const kept = entries.filter((e) => e.readId !== readId);
      removed += entries.length - kept.length;
      this.entries.set(profile, kept);
    }
    return removed;
  }
}
