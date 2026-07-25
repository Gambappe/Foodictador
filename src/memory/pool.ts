/**
 * PoolStore (M2) — the XTrace side of the collective pool at
 * `user_id: "confit:pool"`. **Induction only, under DAG §4 D-7.**
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

export const POOL_SCOPE = 'confit:pool';

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
 * `INDUCTION_TOP_K` was 12, and that was **two rows from losing the claim entirely.**
 * Measured against a clean pool scope holding the full 220-read seed, with the exact query
 * `confit ask` issues: the API returns every fact before any episode, and the first episode
 * landed at **index 10**. A top-k of 12 left two rows of headroom on a number that moves
 * with how many facts the extractor happened to produce.
 *
 * Raised to 40 for headroom rather than tuned to the measurement, because the measurement is
 * of one corpus on one day. The cost is a larger response on a query that runs once per ask.
 *
 * `INDUCTION_EPISODE_SLOTS` is sent, and we cannot prove the server honours it: a made-up
 * parameter (`wibble_slots`) is also accepted with 200, so presence proves nothing (M13).
 * Client-side reservation is the fix; until then top-k headroom is what actually protects
 * the claim.
 */
const INDUCTION_TOP_K = 40;
const INDUCTION_EPISODE_SLOTS = 4;

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
        convId: `confit:pool:${driver}:${String(start / READS_PER_CONVERSATION)}`,
        reads: chunk,
      });
    }
  }
  return out;
}

export function createPoolStore(deps: PoolStoreDeps): PoolStore {
  /** Prose or nothing: an unresolvable place is skipped and named, never sent as an id. */
  function render(reads: readonly Read[]): string[] {
    const out: string[] = [];
    for (const read of reads) {
      const sentence = readToProse(read, deps.placeName);
      if (sentence === null) {
        deps.logger.line(
          `pool: skipping ${read.read_id} — place "${read.place}" is not in the corpus, and sending the id would put it on a card`,
        );
        continue;
      }
      out.push(sentence);
    }
    return out;
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

    async writeReads(reads: readonly Read[]): Promise<JobHandle[]> {
      const handles: JobHandle[] = [];
      for (const { convId, reads: chunk } of conversations(reads)) {
        const payloads = render(chunk);
        if (payloads.length === 0) continue;
        handles.push(await deps.client.ingestBatch(POOL_SCOPE, payloads, convId));
      }
      deps.logger.line(
        `pool: fed ${String(reads.length)} read(s) as ${String(handles.length)} conversation(s) for induction`,
      );
      return handles;
    },

    async inducedClaim(query: string): Promise<string> {
      const rows = await deps.client.search(POOL_SCOPE, query, {
        topK: INDUCTION_TOP_K,
        episodeSlots: INDUCTION_EPISODE_SLOTS,
      });
      // Prefer the episode — that is the induced relationship; a bare fact is
      // just one read. An empty string means "no claim", never a crash.
      const episode = rows.find((row) => row.kind === 'episode' && row.content !== '');
      if (episode) return episode.content;
      return '';
    },
  };
}
