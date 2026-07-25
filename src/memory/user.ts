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
 * **The Usual and the meal log are NOT here any more** (M11, DAG §4 D-8). They are declared
 * settings, not experiences, so they live in a durable keyed store and this module only
 * parses them at the boundary on the way through.
 *
 * They used to be "tagged JSON records" in XTrace, which took three prostheses for three
 * missing primitives: a `kind` field used as a search query in place of addressing,
 * `written_at` ordering to arbitrate the duplicates a missing upsert guarantees, and a JSON
 * body to survive extraction. All three failed at once, because extraction drops the tag AND
 * the JSON — probed live, `0` rows carrying `confit:usual` and `0` verbatim-JSON rows across
 * three queries on two profiles. `usual()` returned null on every cross-process read, which
 * took out `confit ask` and `confit confess` together, the latter because it reads `usual()`
 * for the off-limits list. `findTagged`, `parseTagged`, `newestParsed`, `replaceTagged`,
 * `written_at` ordering and both write-through caches are gone with it: every one of them
 * existed only to work around the absence of a keyed store.
 *
 * `setUsual` is still the only write path for off-limits topics — G2, X7 and U4 all go
 * through it — and it now parses on the way IN as well as out, so a caller cannot put an
 * unhonourable constraint into durable storage.
 *
 * One question the integrator answered by moving the data: whether `usual() === null` may be
 * read as "no off-limits". It may not, and a read failure now PROPAGATES rather than being
 * softened to null — an unreachable store reported as an empty off-limits list is precisely
 * the failure D-8 exists to prevent.
 */

import type { MemoryClient, SettingsStore, UserStore } from '../contracts/modules.js';
import type { JobHandle, MealLogEntry, UsualProfile } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';

/**
 * Settings keys in the durable store (D-8).
 *
 * These used to be `confit:usual` / `confit:meal_log`, used as SEARCH QUERIES against XTrace
 * because it offers no addressing. They are now just keys, which is what they always wanted
 * to be — `settings.get(profile, 'usual')` addresses one record and returns its bytes.
 */
const USUAL_KEY = 'usual';
const MEAL_LOG_KEY = 'meal_log';

/** One verify-and-retry round per pending prose item, per §6. */
const MAX_PROSE_RETRIES = 1;

interface PendingProse {
  profile: string;
  text: string;
  jobId: string;
  retries: number;
}

export interface UserStoreDeps {
  /** XTrace, for the confession prose only — the EXPERIENCES half of D-8. */
  client: MemoryClient;
  /** The durable store, for what the user DECLARED. Not XTrace, and that is the point. */
  settings: SettingsStore;
  logger: Logger;
}

/** UserStore plus the process-lifetime prose bookkeeping the contract can't carry. */
export interface UserStoreHandle extends UserStore {
  /** Poll every pending prose job; re-ingest failures (once), keep the rest pending. */
  verifyPendingProse(): Promise<void>;
  /** Drop whatever is still unconfirmed — call at process end; warns per item. */
  dropUnconfirmedProse(): number;
}

/**
 * Boundary parsers (SL-04). DAG §1: parse external input at the boundary and
 * hand typed values inward. The predicate these replace checked `typeof` and
 * claimed `value is UsualProfile` — laundering `spiceTolerance: 42` into the
 * type system, where it silently disabled K4's budget and spice constraints.
 * These return a CLEAN object or null; they never cast.
 */
function parseUsualProfile(value: unknown): UsualProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const spiceTolerance = record['spiceTolerance'];
  const budgetBand = record['budgetBand'];
  const portionPref = record['portionPref'];
  const soloComfort = record['soloComfort'];
  const giConstraint = record['giConstraint'];
  const offLimits = record['offLimits'];
  if (spiceTolerance !== 0 && spiceTolerance !== 1 && spiceTolerance !== 2 && spiceTolerance !== 3)
    return null;
  if (budgetBand !== 1 && budgetBand !== 2 && budgetBand !== 3 && budgetBand !== 4) return null;
  if (portionPref !== 'small' && portionPref !== 'standard' && portionPref !== 'large') return null;
  if (typeof soloComfort !== 'boolean' || typeof giConstraint !== 'boolean') return null;
  if (!Array.isArray(offLimits) || offLimits.some((topic) => typeof topic !== 'string')) return null;

  const usual: UsualProfile = {
    spiceTolerance,
    budgetBand,
    portionPref,
    soloComfort,
    giConstraint,
    offLimits: [...(offLimits as string[])],
  };
  const defaultOrder = record['defaultOrder'];
  if (defaultOrder !== undefined) {
    if (typeof defaultOrder !== 'object' || defaultOrder === null) return null;
    const order = defaultOrder as Record<string, unknown>;
    const placeId = order['placeId'];
    const dishId = order['dishId'];
    if (typeof placeId !== 'string' || placeId === '' || typeof dishId !== 'string' || dishId === '')
      return null;
    usual.defaultOrder = { placeId, dishId };
  }
  return usual;
}

/** One meal-log entry, domain-checked — a bad date here throws out of K3 later. */
function parseMealLogEntry(value: unknown): MealLogEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const dishId = record['dishId'];
  const placeId = record['placeId'];
  const at = record['at'];
  const felt = record['felt'];
  if (typeof dishId !== 'string' || dishId === '') return null;
  if (typeof placeId !== 'string' || placeId === '') return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (felt !== undefined && felt !== 'glad' && felt !== 'fine' && felt !== 'regret') return null;
  const entry: MealLogEntry = { dishId, placeId, at };
  if (felt !== undefined) entry.felt = felt;
  return entry;
}

export function createUserStore(deps: UserStoreDeps): UserStoreHandle {
  const pending: PendingProse[] = [];

  return {
    async writeProse(profile: string, text: string): Promise<JobHandle> {
      // [E11]: the payload IS the text — byte-identical, nothing added.
      const handle = await deps.client.ingest(profile, text);
      pending.push({ profile, text, jobId: handle.jobId, retries: 0 });
      return handle;
    },

    /**
     * The declared profile, from the durable store (D-8).
     *
     * `null` means "not provisioned", and X2 relies on that reading — so a read FAILURE must
     * propagate rather than be softened into null. An unreachable relay reported as "no
     * off-limits topics" is the exact failure this data was moved to avoid.
     */
    async usual(profile: string): Promise<UsualProfile | null> {
      const raw = await deps.settings.get(profile, USUAL_KEY);
      if (raw === null) return null;
      const usual = parseUsualProfile(raw);
      if (usual === null) {
        // Stored-but-invalid is not the same as absent, and it must not read as absent: a
        // profile whose off-limits list failed to parse is a profile whose allergies we
        // cannot honour. Say so loudly and return null, which blocks rather than permits.
        deps.logger.line(
          `user: the stored profile for ${profile} failed the boundary parser — treating as unprovisioned`,
        );
        return null;
      }
      return usual;
    },

    async setUsual(profile: string, usual: UsualProfile): Promise<void> {
      // Parsed on the way IN as well as out. This is the only write path for off-limits
      // topics (G2, X7, U4 all come through here), so a caller with a hand-built object does
      // not get to put an unhonourable constraint into durable storage.
      const valid = parseUsualProfile(usual);
      if (valid === null) throw new Error('user: refusing to store a profile that fails parseUsualProfile');
      await deps.settings.put(profile, USUAL_KEY, valid);
    },

    async mealLog(profile: string): Promise<MealLogEntry[]> {
      const raw = await deps.settings.get(profile, MEAL_LOG_KEY);
      if (!Array.isArray(raw)) {
        if (raw !== null) {
          deps.logger.line(`user: stored meal log for ${profile} is not an array — ignoring it`);
        }
        return [];
      }
      // Per-entry parsing: one junk entry is skipped with a line (pool.ts precedent), not
      // handed to K3 to throw the whole Ask over.
      const log: MealLogEntry[] = [];
      for (const [index, entry] of raw.entries()) {
        const parsed = parseMealLogEntry(entry);
        if (parsed === null) {
          deps.logger.line(`user: skipping malformed meal-log entry #${String(index)} for ${profile}`);
          continue;
        }
        log.push(parsed);
      }
      return log;
    },

    async setMealLog(profile: string, entries: MealLogEntry[]): Promise<void> {
      await deps.settings.put(profile, MEAL_LOG_KEY, entries);
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
