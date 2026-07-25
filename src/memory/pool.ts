/**
 * PoolStore (M2) — the XTrace side of the collective pool at
 * `user_id: POOL_SCOPE`. **Induction only, under DAG §4 D-7.**
 *
 * The scope is generation-marked (M15) rather than a bare name: pre-M12 per-read episodes
 * were measured outranking the batched-prose episodes that replaced them, so the era had to
 * be abandonable. See `src/memory/scopes.ts`.
 *
 * The counting query used to live here. It is gone, and its absence is the
 * point: gate zero ingested one read and got back five prose facts
 * ("User's place is rosas_taqueria.") with nothing joining them, and no query —
 * not by read_id, not by place — returned the object that went in. A
 * `readsForDriver` on this store could only ever return an empty array while
 * looking like it worked, which is worse than not existing. Counting reads the
 * relay now (M6).
 *
 * What is left is the query XTrace is measurably good at ([E22], design v0.8
 * §8): synthesis across records it derived itself.
 */

import type { MemoryClient, PoolStore } from '../contracts/modules.js';
import type { Driver, JobHandle, Read } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';
import { readToProse, type PlaceName } from './readProse.js';
import { POOL_SCOPE } from './scopes.js';
import type { BatchHandle } from '../contracts/modules.js';
import { searchForEpisodes } from './episodes.js';

// Re-exported because every importer of the pool scope already imports it from here, and
// M15 moved the definition rather than the meaning. See src/memory/scopes.ts for why the
// name carries a generation.
export { POOL_SCOPE };

/**
 * Reads per conversation.
 *
 * Grouping is by driver first (below), so a conversation is already thematically coherent;
 * this only bounds how large one gets. Twelve reads in one conversation produced a claim
 * spanning four places in the M12 measurement, so this is comfortably inside what works —
 * and an unbounded conversation of 220 seeded reads is a shape nobody has measured.
 */
const READS_PER_CONVERSATION = 20;

/**
 * Induction reads episodes — the cross-record synthesis lives there (§14).
 *
 * The sizing constants that used to live here are gone, and so is the reasoning that named
 * them. It said "top-k headroom is what actually protects the claim", which M13 measured to be
 * false: `top_k` is **inert**. `top_k=1` returns thirteen rows, `episode_slots=0` and
 * `episode_slots=99` are indistinguishable, and every alternative name tried is inert too —
 * all with `200`. There was never any truncation to have headroom against.
 *
 * What protects the claim is client-side and lives in `src/memory/episodes.ts`, which also
 * carries the measurements. The short version: the search is non-deterministic, so an empty
 * answer is not an empty scope, and the reservation is a bounded retry rather than a parameter.
 */

export interface PoolStoreDeps {
  client: MemoryClient;
  logger: Logger;
  /**
   * Resolves a place id to its display name. Required, because the whole point of sending
   * prose is that the extractor never sees `rosas_taqueria` — feed it an id and the induced
   * claim comes back carrying the id, onto a card (L4).
   */
  placeName: PlaceName;
}

/** Reads grouped by driver, then chunked — one entry per conversation to be sent. */
function conversations(reads: readonly Read[]): Array<{ convId: string; reads: Read[] }> {
  const byDriver = new Map<Driver, Read[]>();
  for (const read of reads) {
    const bucket = byDriver.get(read.driver);
    if (bucket) bucket.push(read);
    else byDriver.set(read.driver, [read]);
  }
  const out: Array<{ convId: string; reads: Read[] }> = [];
  // Driver order follows insertion, and chunking follows input order, so the same seed
  // artifact produces the same conv_ids on every run — a re-seed reuses them rather than
  // scattering the same reads across new conversations.
  for (const [driver, bucket] of byDriver) {
    for (let start = 0; start < bucket.length; start += READS_PER_CONVERSATION) {
      const chunk = bucket.slice(start, start + READS_PER_CONVERSATION);
      out.push({
        convId: `${POOL_SCOPE}:${driver}:${String(start / READS_PER_CONVERSATION)}`,
        reads: chunk,
      });
    }
  }
  return out;
}

export function createPoolStore(deps: PoolStoreDeps): PoolStore {
  /** Prose or nothing: an unresolvable place is skipped and named, never sent as an id. */
  function renderOne(read: Read): string | null {
    const sentence = readToProse(read, deps.placeName);
    if (sentence === null) {
      deps.logger.line(
        `pool: skipping ${read.read_id} — place "${read.place}" is not in the corpus, and sending the id would put it on a card`,
      );
    }
    return sentence;
  }

  function render(reads: readonly Read[]): string[] {
    return reads.map(renderOne).filter((s): s is string => s !== null);
  }

  return {
    async writeRead(read: Read): Promise<JobHandle> {
      // Prose, not `JSON.stringify(read)` (M14). Before D-7 the JSON had to survive
      // verbatim because `readsForDriver` parsed it back; that path is gone, so the payload
      // is free — and notation is the substrate's worst input (guide R4).
      const [sentence] = render([read]);
      if (sentence === undefined) {
        throw new Error(`pool: cannot render ${read.read_id} as prose — unknown place ${read.place}`);
      }
      // One read is one conversation, so this cannot yield a cross-record claim. That is
      // the live-confession path; `writeReads` is what induction is built on.
      return deps.client.ingest(POOL_SCOPE, sentence);
    },

    async writeReads(reads: readonly Read[]): Promise<BatchHandle[]> {
      const handles: BatchHandle[] = [];
      for (const { convId, reads: chunk } of conversations(reads)) {
        // `render` drops a read it cannot name a place for, so the ids are taken from what
        // actually went into the payload rather than from the chunk — otherwise a dropped
        // read would be annotated with a job that never carried it.
        const rendered = chunk
          .map((read) => ({ read, prose: renderOne(read) }))
          .filter((r): r is { read: Read; prose: string } => r.prose !== null);
        if (rendered.length === 0) continue;
        const handle = await deps.client.ingestBatch(
          POOL_SCOPE,
          rendered.map((r) => r.prose),
          convId,
        );
        handles.push({ jobId: handle.jobId, readIds: rendered.map((r) => r.read.read_id) });
      }
      deps.logger.line(
        `pool: fed ${String(reads.length)} read(s) as ${String(handles.length)} conversation(s) for induction`,
      );
      return handles;
    },

    async inducedClaim(query: string): Promise<string> {
      // The reservation is client-side (M13): `top_k` and `episode_slots` are both measured
      // INERT — `top_k=1` returns thirteen rows — so nothing here may depend on them. What
      // does work is that the search is non-deterministic, so an empty answer is not an empty
      // scope; see src/memory/episodes.ts.
      const result = await searchForEpisodes({ ...deps, label: 'pool' }, POOL_SCOPE, query);
      // The episode is the induced relationship; a bare fact is just one read. An empty string
      // means "no claim", never a crash.
      return result.episodes[0]?.content ?? '';
    },
  };
}
