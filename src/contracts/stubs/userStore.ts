import type { ProseWrite, UserStore } from '../modules.js';
import type { MealLogEntry, UsualProfile } from '../types.js';

/** In-memory per-profile store. */
export class StubUserStore implements UserStore {
  /** Overridable per test; '' means "no claim", which is the contract's absence value. */
  personalClaimText = '';

  personalClaim(_profile: string, _query: string): Promise<string> {
    return Promise.resolve(this.personalClaimText);
  }

  private readonly usuals = new Map<string, UsualProfile>();
  private readonly logs = new Map<string, MealLogEntry[]>();
  private readonly prose = new Map<string, string[]>();
  private seq = 0;

  /**
   * Records the text and reports it SENT.
   *
   * The stub does not model buffering, deliberately: batching is M20's policy and a stub that
   * reimplemented it would be a second copy free to drift from the real one. What a caller
   * needs from this stub is that the confession was accepted — `proseBuffer.test.ts` owns the
   * batching rules.
   */
  writeProse(profile: string, text: string): Promise<ProseWrite> {
    this.prose.set(profile, [...(this.prose.get(profile) ?? []), text]);
    this.seq += 1;
    return Promise.resolve({ buffered: 0, jobId: `prose-job-${this.seq}` });
  }

  usual(profile: string): Promise<UsualProfile | null> {
    return Promise.resolve(this.usuals.get(profile) ?? null);
  }

  setUsual(profile: string, usual: UsualProfile): Promise<void> {
    this.usuals.set(profile, usual);
    return Promise.resolve();
  }

  mealLog(profile: string): Promise<MealLogEntry[]> {
    return Promise.resolve([...(this.logs.get(profile) ?? [])]);
  }

  setMealLog(profile: string, entries: MealLogEntry[]): Promise<void> {
    this.logs.set(profile, [...entries]);
    return Promise.resolve();
  }
}
