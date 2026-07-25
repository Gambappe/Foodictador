/**
 * The confession buffer (M20) — why prose is ingested in batches, not one at a time.
 *
 * **XTrace generates an episode per ingest CALL, not per conversation.** Measured twice
 * against the live API: profile A's scope after seven confessions held 18 rows, 8 episodes
 * and 8 distinct `conv_id`s, every episode a paraphrase of a single confession ("The
 * conversation centered on a self-aware confession: the speaker keeps ordering the spicy
 * option to look tough"). And the obvious fix does not work — four *separate* POSTs sharing
 * *one* `conv_id` still produced per-POST paraphrases, with the shared id recorded on every
 * row. So the operational guide's R4 ("batch by session/day, group several related messages
 * into one `conv_id`") means **one POST carrying several messages**, which is exactly what
 * M12 did for the pool and why that worked.
 *
 * A confession arrives in its own CLI process, so batching at write time is impossible
 * without holding text across processes. Hence a file.
 *
 * ## What this deliberately is NOT
 *
 * Not a spool, and not durable in any strong sense. DAG §4 D-10: **losing a confession is
 * acceptable.** That ruling is what keeps this small — no atomic write-and-rename, no
 * retrievability verification, no stuck-item escalation, no retry ledger. All of that would
 * be machinery for a delivery guarantee nobody wants to make. This buffer exists so several
 * confessions can share one ingest call; if the file is lost, some confessions never reach
 * XTrace, and by D-10 that is a cost rather than a bug.
 *
 * `[E11]` still holds inside it: the text is stored byte-identical and sent byte-identical.
 * Buffering changes *when* a confession is ingested, never *what*.
 *
 * ## Local, not on the relay
 *
 * Unlike settings (`pass provision` writes on one machine, `ask` may read on another) and
 * unlike the pool (cross-device by design), a buffer is only ever flushed by a process on the
 * machine that wrote it — there is no cross-device requirement at all. Putting raw
 * confessions on the relay would place the most sensitive text in the product on a service
 * whose single shared token reads everything (see `infra/relay/README.md`), and buy nothing.
 *
 * Not encrypted at rest. The key would live on the same disk, which is theatre rather than
 * protection; doing it properly needs an OS keychain and is out of scope for a demo.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Confessions per ingest call.
 *
 * Four, not one and not twenty. One is the defect. Twenty means a demo never reaches a flush,
 * because the threshold is only one of two triggers and the other (`pass sweep`) is operator
 * -driven. Twelve reads in one conversation produced a claim spanning four places in the M12
 * measurement, so a handful is comfortably enough material for a synthesis.
 */
export const BATCH_SIZE = 4;

/** Per-profile: the texts waiting to be sent, and how many batches have gone before. */
interface BufferState {
  texts: string[];
  batches: number;
}

interface BufferFile {
  profiles?: Record<string, BufferState>;
}

export interface ProseBufferOptions {
  /** Where the buffer lives. Injectable so tests never touch a real home directory. */
  path: string;
}

export interface Flush {
  profile: string;
  texts: string[];
  /** Distinct per flush, so each batch is its own conversation and gets its own episode. */
  convId: string;
}

export interface ProseBuffer {
  /** Appends one confession. Returns a flush when the profile has reached `BATCH_SIZE`. */
  append(profile: string, text: string): Flush | null;
  /** Everything waiting, whatever the size — what `pass sweep` drains. */
  drain(): Flush[];
  /** How many confessions are waiting for this profile. */
  pending(profile: string): number;
}

export function createProseBuffer(options: ProseBufferOptions): ProseBuffer {
  function read(): Record<string, BufferState> {
    try {
      const parsed = JSON.parse(readFileSync(options.path, 'utf8')) as BufferFile;
      return parsed.profiles ?? {};
    } catch {
      // Missing, unreadable or corrupt all mean the same thing here: nothing is buffered.
      // Under D-10 that is a loss the product accepts, and refusing to start over a damaged
      // buffer would turn an accepted loss into a broken `confess`.
      return {};
    }
  }

  function write(profiles: Record<string, BufferState>): void {
    mkdirSync(dirname(options.path), { recursive: true });
    // A plain write, not temp-and-rename. P0.8 earned that ceremony because the relay is the
    // store of record; this is a buffer whose loss is sanctioned, and a torn write here costs
    // the same as no write at all.
    writeFileSync(options.path, JSON.stringify({ profiles }));
  }

  function stateFor(profiles: Record<string, BufferState>, profile: string): BufferState {
    return profiles[profile] ?? { texts: [], batches: 0 };
  }

  function flushFor(profile: string, state: BufferState): Flush {
    return {
      profile,
      texts: [...state.texts],
      convId: `confit:prose:${profile}:${String(state.batches)}`,
    };
  }

  return {
    append(profile, text) {
      const profiles = read();
      const state = stateFor(profiles, profile);
      state.texts.push(text);

      if (state.texts.length < BATCH_SIZE) {
        profiles[profile] = state;
        write(profiles);
        return null;
      }

      const flush = flushFor(profile, state);
      // Cleared and the counter advanced BEFORE the caller ingests. If the ingest then fails
      // the batch is gone — which is D-10's accepted loss, and the alternative (hold until
      // confirmed) is the delivery guarantee this file exists not to build.
      profiles[profile] = { texts: [], batches: state.batches + 1 };
      write(profiles);
      return flush;
    },

    drain() {
      const profiles = read();
      const flushes: Flush[] = [];
      const next: Record<string, BufferState> = {};
      for (const [profile, state] of Object.entries(profiles)) {
        if (state.texts.length === 0) {
          next[profile] = state;
          continue;
        }
        flushes.push(flushFor(profile, state));
        next[profile] = { texts: [], batches: state.batches + 1 };
      }
      if (flushes.length > 0) write(next);
      return flushes;
    },

    pending(profile) {
      return stateFor(read(), profile).texts.length;
    },
  };
}
