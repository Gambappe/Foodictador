import type { UserStore } from '../modules.js';
import type { JobHandle, MealLogEntry, UsualProfile } from '../types.js';

/** In-memory per-profile store. */
export class StubUserStore implements UserStore {
  private readonly usuals = new Map<string, UsualProfile>();
  private readonly logs = new Map<string, MealLogEntry[]>();
  private readonly prose = new Map<string, string[]>();
  private seq = 0;

  writeProse(profile: string, text: string): Promise<JobHandle> {
    this.prose.set(profile, [...(this.prose.get(profile) ?? []), text]);
    this.seq += 1;
    return Promise.resolve({ jobId: `prose-job-${this.seq}` });
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
