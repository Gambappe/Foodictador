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
 * no upsert, so a rewrite inside the settle window cannot see — and therefore
 * cannot remove — its predecessor, and duplicates WILL exist. Correctness does
 * not depend on removal: every record carries a monotonic `written_at` from an
 * injected clock, and reads select the NEWEST parsed record, so a duplicate is
 * benign rather than a coin flip (PR #22 review). Removal of whatever search
 * does surface is garbage collection only. The write-through cache is a
 * same-process convenience on top; cross-process reads are cold by
 * construction and rely on written_at ordering.
 *
 * `setUsual` is the only write path for off-limits topics — G2, X7 and U4 all
 * go through it. Two open questions raised to the integrator rather than
 * defaulted here: whether `usual() === null` may be treated as "no off-limits"
 * on the write path (X2's call today), and whether a bounded similarity query
 * can reliably retrieve a known-key record at all (a D-2/gate-zero question
 * for src/memory/README.md).
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
  /** Injectable clock stamping settings records; newest written_at wins on read. */
  now?: () => string;
}

/** UserStore plus the process-lifetime prose bookkeeping the contract can't carry. */
export interface UserStoreHandle extends UserStore {
  /** Poll every pending prose job; re-ingest failures (once), keep the rest pending. */
  verifyPendingProse(): Promise<void>;
  /** Drop whatever is still unconfirmed — call at process end; warns per item. */
  dropUnconfirmedProse(): number;
}

/**
 * Boundary parsers (SL-04). The substrate hands back JSON; these check the
 * DOMAINS, not the typeofs — `spiceTolerance: 42` used to launder itself into
 * `0|1|2|3` through a lying predicate and silently disable K4's constraints.
 * Same skip-and-log posture as pool.ts: a malformed record must never crash
 * the Ask, and must never pass as typed truth either.
 */
function parseUsualProfile(value: unknown): UsualProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const spice = record['spiceTolerance'];
  const band = record['budgetBand'];
  const portion = record['portionPref'];
  const solo = record['soloComfort'];
  const gi = record['giConstraint'];
  const offLimits = record['offLimits'];
  if (spice !== 0 && spice !== 1 && spice !== 2 && spice !== 3) return null;
  if (band !== 1 && band !== 2 && band !== 3 && band !== 4) return null;
  if (portion !== 'small' && portion !== 'standard' && portion !== 'large') return null;
  if (typeof solo !== 'boolean' || typeof gi !== 'boolean') return null;
  if (!Array.isArray(offLimits) || offLimits.some((topic) => typeof topic !== 'string')) {
    return null;
  }
  const usual: UsualProfile = {
    spiceTolerance: spice,
    budgetBand: band,
    portionPref: portion,
    soloComfort: solo,
    giConstraint: gi,
    offLimits: offLimits as string[],
  };
  const order = record['defaultOrder'];
  if (typeof order === 'object' && order !== null) {
    const orderRecord = order as Record<string, unknown>;
    const placeId = orderRecord['placeId'];
    const dishId = orderRecord['dishId'];
    if (typeof placeId === 'string' && typeof dishId === 'string') {
      usual.defaultOrder = { placeId, dishId };
    }
  }
  return usual;
}

function parseMealLogEntry(value: unknown): MealLogEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const dishId = record['dishId'];
  const placeId = record['placeId'];
  const at = record['at'];
  if (typeof dishId !== 'string' || dishId === '') return null;
  if (typeof placeId !== 'string' || placeId === '') return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  const entry: MealLogEntry = { dishId, placeId, at };
  const felt = record['felt'];
  if (felt === 'glad' || felt === 'fine' || felt === 'regret') entry.felt = felt;
  else if (felt !== undefined) return null;
  return entry;
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
  const now = deps.now ?? (() => new Date().toISOString());

  async function findTagged(
    profile: string,
    kind: string,
  ): Promise<Array<{ row: MemoryRow; record: Record<string, unknown> }>> {
    // topK is a bounded similarity query, not an exhaustive listing — whether it
    // reliably surfaces a known-key record in a prose-heavy scope is a
    // substrate question flagged for gate zero (D-2); 50 buys margin meanwhile.
    const rows = await deps.client.search(profile, kind, { topK: 50, episodeSlots: 0 });
    const found: Array<{ row: MemoryRow; record: Record<string, unknown> }> = [];
    for (const row of rows) {
      const record = parseTagged(row, kind);
      if (record !== null) found.push({ row, record });
    }
    return found;
  }

  /** ISO written_at sorts lexicographically; a legacy unstamped record loses. */
  function writtenAt(record: Record<string, unknown>): string {
    const value = record['written_at'];
    return typeof value === 'string' ? value : '';
  }

  /** Duplicates are expected (no upsert + settle window); the newest wins. */
  function newest(
    found: Array<{ row: MemoryRow; record: Record<string, unknown> }>,
    valid: (record: Record<string, unknown>) => boolean,
  ): Record<string, unknown> | null {
    let best: Record<string, unknown> | null = null;
    for (const { record } of found) {
      if (!valid(record)) continue;
      if (best === null || writtenAt(record) > writtenAt(best)) best = record;
    }
    return best;
  }

  async function replaceTagged(profile: string, kind: string, body: Record<string, unknown>) {
    // Removal is garbage collection, not the correctness mechanism: a
    // predecessor still inside the settle window is invisible here and
    // survives as a duplicate — which written_at ordering makes benign.
    for (const { row } of await findTagged(profile, kind)) {
      await deps.client.remove(profile, row.memoryId);
    }
    await deps.client.ingest(profile, JSON.stringify({ kind, written_at: now(), ...body }));
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
      const tagged = await findTagged(profile, USUAL_KIND);
      const rejected = tagged.filter(({ record }) => parseUsualProfile(record['usual']) === null).length;
      if (rejected > 0) {
        deps.logger.line(`user: skipped ${rejected} malformed usual record(s) for ${profile}`);
      }
      const record = newest(tagged, (r) => parseUsualProfile(r['usual']) !== null);
      const usual = record === null ? null : parseUsualProfile(record['usual']);
      if (usual !== null) {
        usualCache.set(profile, structuredClone(usual));
        return structuredClone(usual);
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
      const record = newest(await findTagged(profile, MEAL_LOG_KIND), (r) =>
        Array.isArray(r['entries']),
      );
      if (record !== null) {
        const raw = record['entries'] as unknown[];
        const log: MealLogEntry[] = [];
        let skipped = 0;
        for (const item of raw) {
          const entry = parseMealLogEntry(item);
          if (entry !== null) log.push(entry);
          else skipped += 1;
        }
        if (skipped > 0) {
          deps.logger.line(
            `user: skipped ${skipped} malformed meal-log entr${skipped === 1 ? 'y' : 'ies'} for ${profile} — a bad row must never crash the Ask`,
          );
        }
        mealLogCache.set(profile, structuredClone(log));
        return structuredClone(log);
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
