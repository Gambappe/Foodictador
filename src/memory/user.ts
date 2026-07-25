/**
 * UserStore (M3) — the per-profile personal tier at `user_id: <profile>`.
 *
 * Confession prose is ingested RAW and unmodified ([E11]): design v0.8 §14
 * measured an LLM pass that stripped conversational texture to "just the
 * signal" as the worst configuration of every one tested (2/10 vs 8/8 for raw
 * prose) — no pre-cleaning, no pre-structuring, the payload is the text.
 *
 * The prose has no relay copy by design (§6): its verify-and-retry holds the
 * text in memory until the substrate confirms it and dies with the process.
 * Acceptable for the personal tier — a lost confession is one user's data,
 * recoverable by re-confessing — and each unconfirmed drop logs a warning.
 *
 * The Usual and the meal log are settings objects, not confessions, so they
 * are stored as tagged JSON records ([E11] does not apply to them). XTrace has
 * no upsert, so setUsual/setMealLog fake replace with remove-then-ingest, and
 * a write-through cache covers the ingest→retrievable settle gap within a
 * process. `setUsual` is the only write path for off-limits topics — G2, X7
 * and U4 all go through it.
 */

import type { MemoryClient, UserStore } from '../contracts/modules.js';
import type { JobHandle, MealLogEntry, MemoryRow, UsualProfile } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';

const USUAL_KIND = 'confit:usual';
const MEAL_LOG_KIND = 'confit:meal_log';

/** One verify-and-retry round per pending prose item, per §6. */
const MAX_PROSE_RETRIES = 1;

interface PendingProse {
  profile: string;
  text: string;
  jobId: string;
  retries: number;
}

export interface UserStoreDeps {
  client: MemoryClient;
  logger: Logger;
}

/** UserStore plus the process-lifetime prose bookkeeping the contract can't carry. */
export interface UserStoreHandle extends UserStore {
  /** Poll every pending prose job; re-ingest failures (once), keep the rest pending. */
  verifyPendingProse(): Promise<void>;
  /** Drop whatever is still unconfirmed — call at process end; warns per item. */
  dropUnconfirmedProse(): number;
}

function isUsualProfile(value: unknown): value is UsualProfile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['spiceTolerance'] === 'number' &&
    typeof record['budgetBand'] === 'number' &&
    typeof record['portionPref'] === 'string' &&
    typeof record['soloComfort'] === 'boolean' &&
    typeof record['giConstraint'] === 'boolean' &&
    Array.isArray(record['offLimits'])
  );
}

function parseTagged(row: MemoryRow, kind: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(row.content);
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    return record['kind'] === kind ? record : null;
  } catch {
    return null; // prose and foreign records simply aren't settings rows
  }
}

export function createUserStore(deps: UserStoreDeps): UserStoreHandle {
  const pending: PendingProse[] = [];
  const usualCache = new Map<string, UsualProfile>();
  const mealLogCache = new Map<string, MealLogEntry[]>();

  async function findTagged(
    profile: string,
    kind: string,
  ): Promise<Array<{ row: MemoryRow; record: Record<string, unknown> }>> {
    const rows = await deps.client.search(profile, kind, { topK: 20, episodeSlots: 0 });
    const found: Array<{ row: MemoryRow; record: Record<string, unknown> }> = [];
    for (const row of rows) {
      const record = parseTagged(row, kind);
      if (record !== null) found.push({ row, record });
    }
    return found;
  }

  async function replaceTagged(profile: string, kind: string, body: Record<string, unknown>) {
    for (const { row } of await findTagged(profile, kind)) {
      await deps.client.remove(profile, row.memoryId);
    }
    await deps.client.ingest(profile, JSON.stringify({ kind, ...body }));
  }

  return {
    async writeProse(profile: string, text: string): Promise<JobHandle> {
      // [E11]: the payload IS the text — byte-identical, nothing added.
      const handle = await deps.client.ingest(profile, text);
      pending.push({ profile, text, jobId: handle.jobId, retries: 0 });
      return handle;
    },

    async usual(profile: string): Promise<UsualProfile | null> {
      const cached = usualCache.get(profile);
      if (cached) return structuredClone(cached);
      for (const { record } of await findTagged(profile, USUAL_KIND)) {
        const usual = record['usual'];
        if (isUsualProfile(usual)) {
          usualCache.set(profile, structuredClone(usual));
          return structuredClone(usual);
        }
      }
      return null;
    },

    async setUsual(profile: string, usual: UsualProfile): Promise<void> {
      await replaceTagged(profile, USUAL_KIND, { usual });
      usualCache.set(profile, structuredClone(usual));
    },

    async mealLog(profile: string): Promise<MealLogEntry[]> {
      const cached = mealLogCache.get(profile);
      if (cached) return structuredClone(cached);
      for (const { record } of await findTagged(profile, MEAL_LOG_KIND)) {
        const entries = record['entries'];
        if (Array.isArray(entries)) {
          const log = entries as MealLogEntry[];
          mealLogCache.set(profile, structuredClone(log));
          return structuredClone(log);
        }
      }
      return [];
    },

    async setMealLog(profile: string, entries: MealLogEntry[]): Promise<void> {
      await replaceTagged(profile, MEAL_LOG_KIND, { entries });
      mealLogCache.set(profile, structuredClone(entries));
    },

    async verifyPendingProse(): Promise<void> {
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i];
        if (!item) continue;
        const status = await deps.client.jobStatus(item.jobId);
        if (status === 'complete') {
          pending.splice(i, 1);
        } else if (status === 'failed') {
          if (item.retries >= MAX_PROSE_RETRIES) {
            deps.logger.line(
              `user: prose for profile ${item.profile} failed after retry — dropped unconfirmed`,
            );
            pending.splice(i, 1);
          } else {
            // The retry half of verify-and-retry: same raw text, new job.
            const handle = await deps.client.ingest(item.profile, item.text);
            item.jobId = handle.jobId;
            item.retries += 1;
          }
        }
        // 'pending'/'unknown': keep holding the text — verified-drop, never TTL.
      }
    },

    dropUnconfirmedProse(): number {
      const dropped = pending.length;
      for (const item of pending) {
        deps.logger.line(
          `user: dropping unconfirmed prose for profile ${item.profile} — process ending before the substrate confirmed it`,
        );
      }
      pending.length = 0;
      return dropped;
    },
  };
}
