/**
 * UserStore (M3) — the per-profile personal tier, at the scope `personalScope(profile)`.
 *
 * The profile id used to BE the scope. It is namespaced and generation-marked now (M15): a
 * pre-M20 per-confession paraphrase was measured RANKING ABOVE the batched episode that
 * replaced it, so the scope had to be escapable. See `src/memory/scopes.ts`.
 *
 * Confession prose is ingested RAW and unmodified ([E11]): design v0.8 §14
 * measured an LLM pass that stripped conversational texture to "just the
 * signal" as the worst configuration of every one tested (2/10 vs 8/8 for raw
 * prose) — no pre-cleaning, no pre-structuring, the payload is the text.
 *
 * The prose has no relay copy by design (§6), and no delivery guarantee of any kind (D-10):
 * it is buffered locally until several confessions can share one ingest call, and a batch
 * that fails to send is lost. Acceptable for the personal tier — a lost confession is one
 * user's data, recoverable by re-confessing — and every loss logs its COUNT, because a lost
 * batch is not a lost confession.
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

import type { MemoryClient, ProseWrite, SettingsStore, UserStore } from '../contracts/modules.js';
import { BATCH_SIZE, type ProseBuffer } from './proseBuffer.js';
import { personalScope } from './scopes.js';
import type { MealLogEntry, UsualProfile } from '../contracts/types.js';
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

/**
 * Reservation for the personal synthesis query (M16).
 *
 * Sized like M2's pool query and for the same measured reason: the API returns every fact
 * before any episode, so a top-k that is merely "enough rows" is a top-k that returns only
 * facts. A personal scope is thick with prose facts — one confession yields several — so the
 * episode sits further down than instinct suggests. `episode_slots` is sent and cannot be
 * relied on (M13: the API accepts a made-up parameter with 200), which is why the headroom
 * carries the guarantee.
 */
const PERSONAL_TOP_K = 40;
const PERSONAL_EPISODE_SLOTS = 4;

export interface UserStoreDeps {
  /** XTrace, for the confession prose only — the EXPERIENCES half of D-8. */
  client: MemoryClient;
  /** Holds confessions until several can share one ingest call (M20, D-10). */
  buffer: ProseBuffer;
  /** The durable store, for what the user DECLARED. Not XTrace, and that is the point. */
  settings: SettingsStore;
  logger: Logger;
}

/**
 * UserStore plus the flush the contract cannot carry.
 *
 * `verifyPendingProse` and `dropUnconfirmedProse` used to live here. They are gone: they
 * implemented verify-and-retry against a delivery guarantee D-10 declined to make, and
 * `grep` found **no caller anywhere outside their own tests** — so the retry never ran in
 * production either. Deleting them is a simplification, not a regression.
 */
export interface UserStoreHandle extends UserStore {
  /** Send every buffered confession regardless of count. Returns how many were sent. */
  flushProse(): Promise<number>;
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

  return {
    /**
     * Buffers the confession, and sends the batch once one has accumulated (M20).
     *
     * NOT ingested immediately, and that is the change: XTrace generates an episode per ingest
     * call, so one-at-a-time ingests can only ever produce per-confession paraphrases —
     * measured, 8 confessions gave 8 episodes across 8 conv_ids. [E11] is untouched: the text
     * is buffered byte-identical and sent byte-identical, so buffering changes WHEN a
     * confession is ingested, never WHAT.
     */
    async writeProse(profile: string, text: string, readId?: string): Promise<ProseWrite> {
      const flush = deps.buffer.append(profile, text, readId);
      if (flush === null) {
        const held = deps.buffer.pending(profile);
        if (held === 0) {
          // Nothing held AND no flush: another `confess` running at the same time crossed the
          // threshold first and took this confession in its batch. Not lost — but this process
          // sent nothing, and reporting `buffered: 0` as "sent" is the false receipt SL-49
          // measured 9 times in 60.
          deps.logger.line(
            `user: confession for ${profile} was taken by a concurrent batch — another process ` +
              `is sending it, this one did not`,
          );
          return { buffered: 0, handedOff: true };
        }
        deps.logger.line(
          `user: confession held for ${profile} — ${String(held)}/${String(BATCH_SIZE)} until the batch is sent`,
        );
        return { buffered: held };
      }
      // The batch is already out of the buffer, so a failure here loses ALL of it — not the
      // one confession the caller just made. The count has to reach the operator, because
      // `writeRead`'s warning is about "this confession" and would report a batch of four
      // lost as a single write that did not happen (SL-41).
      const count = flush.texts.length;
      try {
        const handle = await deps.client.ingestBatch(
          personalScope(flush.profile),
          flush.texts,
          flush.convId,
        );
        deps.logger.line(
          `user: sent ${String(count)} confession(s) for ${profile} as one conversation (${flush.convId})`,
        );
        return { buffered: 0, jobId: handle.jobId };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        deps.logger.line(
          `user: LOST ${String(count)} buffered confession(s) for ${profile} — the batch left the ` +
            `buffer before the ingest and is not recoverable (D-10): ${reason}`,
        );
        throw new Error(`batch of ${String(count)} confession(s) lost: ${reason}`, { cause: error });
      }
    },

    /**
     * The declared profile, from the durable store (D-8).
     *
     * `null` means "not provisioned", and X2 relies on that reading — so a read FAILURE must
     * propagate rather than be softened into null. An unreachable relay reported as "no
     * off-limits topics" is the exact failure this data was moved to avoid.
     */
    /**
     * XTrace's synthesis over this user's own confessions — D-8's second input.
     *
     * The mirror of M2's `inducedClaim`, over the personal scope. Until this existed the
     * personal tier was write-only: `writeProse` ingested every confession and nothing ever
     * read one back, so the tier cost privacy and delivered nothing.
     *
     * **No floor**, by the product owner's ruling: a user with one confession gets whatever
     * synthesis one confession supports, including nothing. The count of facts behind the
     * claim is logged so a thin one is attributable rather than mysterious — that is what
     * makes "let's see what happens" produce evidence instead of an absence.
     *
     * Episodes only. A bare fact is one sentence the extractor lifted from one confession;
     * an episode is the synthesis across several, which is the thing worth putting on a card.
     */
    async personalClaim(profile: string, query: string): Promise<string> {
      const rows = await deps.client.search(personalScope(profile), query, {
        topK: PERSONAL_TOP_K,
        episodeSlots: PERSONAL_EPISODE_SLOTS,
      });
      const episodes = rows.filter((row) => row.kind === 'episode' && row.content !== '');
      const facts = rows.length - episodes.length;
      const claim = episodes[0]?.content ?? '';
      deps.logger.line(
        `user: personal claim for ${profile} — ${String(episodes.length)} episode(s) over ` +
          `${String(facts)} fact(s)${claim === '' ? '; none usable, card proceeds without it' : ''}`,
      );
      return claim;
    },

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

    /**
     * Sends every buffered confession, whatever the count — what `pass sweep` calls.
     *
     * One ingest call per profile per flush, which is the whole point (M20): XTrace generates
     * an episode per call, so a batch is what gives the personal synthesis something to
     * synthesise ACROSS. Failures are logged and the text is already gone from the buffer —
     * D-10 sanctions that loss, and holding until confirmed is the delivery guarantee this
     * design deliberately does not build.
     */
    async flushProse(): Promise<number> {
      let sent = 0;
      for (const flush of deps.buffer.drain()) {
        try {
          await deps.client.ingestBatch(personalScope(flush.profile), flush.texts, flush.convId);
          sent += flush.texts.length;
          deps.logger.line(
            `user: sent ${String(flush.texts.length)} confession(s) for ${flush.profile} as one conversation (${flush.convId})`,
          );
        } catch (error) {
          deps.logger.line(
            `user: flush FAILED for ${flush.profile} — ${String(flush.texts.length)} confession(s) lost, ` +
              `which D-10 accepts: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return sent;
    },
  };
}
