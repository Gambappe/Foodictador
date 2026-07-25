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
  private readonly texts = new Map<string, string[]>();
  private batches = 0;

  append(profile: string, text: string): Flush | null {
    this.texts.set(profile, [...(this.texts.get(profile) ?? []), text]);
    return null; // never flushes on append — see the note above
  }

  drain(): Flush[] {
    const flushes: Flush[] = [];
    for (const [profile, texts] of this.texts) {
      if (texts.length === 0) continue;
      this.batches += 1;
      flushes.push({ profile, texts: [...texts], convId: `stub:${profile}:${String(this.batches)}` });
    }
    this.texts.clear();
    return flushes;
  }

  pending(profile: string): number {
    return (this.texts.get(profile) ?? []).length;
  }
}
