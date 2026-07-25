import { cannedConfessions, type CannedConfession } from '../fixtures/index.js';
import type { Extractor } from '../modules.js';
import type { ProposedRead } from '../types.js';

/**
 * Keyword-matches the six canned confessions; also the `extraction: seeded` fallback.
 * The off-limits check here mirrors K2's contract shallowly (lowercased substring) —
 * the authoritative gate is M5's, this one only keeps the stub honest for UI flows.
 */
export class StubExtractor implements Extractor {
  constructor(private readonly canned: CannedConfession[] = cannedConfessions) {}

  propose(text: string, offLimits: string[]): Promise<ProposedRead | { blocked: true }> {
    const lower = text.toLowerCase();
    if (offLimits.some((topic) => topic !== '' && lower.includes(topic.toLowerCase()))) {
      return Promise.resolve({ blocked: true });
    }
    const hit = this.canned.find((c) => lower.includes(c.keyword)) ?? this.canned[0];
    if (!hit) return Promise.reject(new Error('stub extractor has no canned confessions'));
    return Promise.resolve({ chips: { ...hit.chips }, confidence: hit.confidence });
  }
}
