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
 * without holding text across processes. Hence the disk.
 *
 * ## One file per confession, claimed by rename (SL-39, SL-40)
 *
 * The first version of this was a single JSON document holding every profile's pending
 * texts, rewritten on every append. That is an unlocked read-modify-write across processes,
 * and it lost confessions in measurement: six concurrent `confess` runs destroyed three to
 * five of six, each one printing `held` first. The same window sent the same confessions
 * TWICE when two processes crossed the threshold together.
 *
 * Neither is D-10's accepted loss. D-10 sanctions losing the buffer — a disk that goes away,
 * a machine that never runs `pass sweep` again. It does not sanction destroying a confession
 * when nothing failed, and it certainly does not sanction duplicate ingestion, which puts
 * near-identical texts in one batch and reproduces the per-confession paraphrase this whole
 * task exists to remove.
 *
 * So there is no shared mutable document. Each confession is its own file, written once and
 * never rewritten:
 *
 *   <dir>/<profile>/<sortable-unique>.json
 *
 * A concurrent append cannot collide, because two processes never write the same path.
 * A batch is claimed by `renameSync` into a sibling `.taken` name — `rename` is atomic and
 * fails with `ENOENT` when another process got there first, so exactly one process owns any
 * given confession and the loser simply takes fewer. No lock file, no retry, no fsync.
 *
 * ## What this deliberately is NOT
 *
 * Not a spool, and not durable in any strong sense. DAG §4 D-10: **losing a confession is
 * acceptable.** That ruling is what keeps this small — no write-and-verify, no retrievability
 * check, no stuck-item escalation, no retry ledger. All of that would be machinery for a
 * delivery guarantee nobody wants to make. A claimed batch is deleted before the caller
 * ingests it, so a failed send loses it; a process that dies mid-flush leaves `.taken` files
 * that nothing will ever pick up. Both are the sanctioned cost.
 *
 * The rename is not ceremony against torn writes, which is what D-10 declined. It is what
 * makes concurrent operation correct at all, and it is three lines.
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

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Confessions per ingest call.
 *
 * Four, not one and not twenty. One is the defect. Twenty means a demo never reaches a flush,
 * because the threshold is only one of two triggers and the other (`pass sweep`) is operator
 * -driven. Twelve reads in one conversation produced a claim spanning four places in the M12
 * measurement, so a handful is comfortably enough material for a synthesis.
 */
export const BATCH_SIZE = 4;

/** Suffix a claimed file carries. Distinct from the pending suffix so a claim is one rename. */
const PENDING = '.json';
const TAKEN = '.taken';

export interface ProseBufferOptions {
  /**
   * Directory holding the per-profile subdirectories. Injectable so tests never touch a real
   * home directory.
   */
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

/**
 * A profile id becomes a directory name, so it must not be able to escape the buffer root or
 * collide with a sibling. Profiles are `A`/`B` today; this exists so that staying true is not
 * a property of the call sites.
 */
function safeProfileDir(profile: string): string {
  const encoded = Buffer.from(profile, 'utf8').toString('base64url');
  return encoded === '' ? 'empty' : encoded;
}

/**
 * Sortable so a flush sends confessions in the order they were made — the batch becomes one
 * conversation, and a conversation out of order reads as a different conversation. Unique so
 * two concurrent appends cannot write the same path, which is the whole point (SL-39).
 */
function entryName(seq: number): string {
  const stamp = String(Date.now()).padStart(15, '0');
  return `${stamp}-${String(seq).padStart(4, '0')}-${randomUUID()}`;
}

export function createProseBuffer(options: ProseBufferOptions): ProseBuffer {
  // Only ever incremented within one process; uniqueness across processes comes from the uuid.
  // This exists so two appends inside a single millisecond still sort in the order they were
  // made, which `Date.now()` alone does not give.
  let seq = 0;

  function dirFor(profile: string): string {
    return join(options.path, safeProfileDir(profile));
  }

  /** Pending entry names for a profile, oldest first. Missing directory means nothing waiting. */
  function pendingNames(profile: string): string[] {
    try {
      return readdirSync(dirFor(profile))
        .filter((name) => name.endsWith(PENDING))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Claims up to `limit` pending confessions and returns their text, oldest first.
   *
   * A file whose rename fails was claimed by another process — skipped, not retried, because
   * the other process is about to send it. A file that survives the rename but cannot be read
   * or parsed is dropped: it is one confession, and refusing to send the other three because
   * of it would let a single damaged file take the personal tier offline permanently (SL-46).
   */
  function claim(profile: string, limit: number): { texts: string[]; token: string } | null {
    const dir = dirFor(profile);
    const texts: string[] = [];
    let token = '';

    for (const name of pendingNames(profile).slice(0, limit)) {
      const from = join(dir, name);
      const to = `${from}${TAKEN}`;
      try {
        renameSync(from, to);
      } catch {
        continue; // Another process owns this one.
      }
      try {
        const parsed: unknown = JSON.parse(readFileSync(to, 'utf8'));
        const text =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['text']
            : undefined;
        if (typeof text === 'string') {
          texts.push(text);
          if (token === '') token = name.slice(0, -PENDING.length);
        }
      } catch {
        // Unreadable or not JSON. One lost confession, which D-10 accepts.
      }
      // Deleted BEFORE the caller ingests. If the ingest then fails the batch is gone — D-10's
      // accepted loss, and the alternative (hold until confirmed) is the delivery guarantee
      // this file exists not to build.
      try {
        rmSync(to, { force: true });
      } catch {
        // Nothing to do about it, and it does not change what the caller sends.
      }
    }

    return texts.length === 0 ? null : { texts, token };
  }

  /**
   * Derived from the claimed batch rather than from a counter.
   *
   * A counter would have to live in the buffer, which D-10 says may vanish — so it would
   * repeat `confit:prose:A:0` after a reset and, under the SL-40 race, for two live batches
   * at once (SL-47). The first claimed entry's name is unique by construction and already on
   * disk, so it identifies the batch without anything having to be remembered.
   */
  function convIdFor(profile: string, token: string): string {
    return `confit:prose:${profile}:${token}`;
  }

  return {
    append(profile, text) {
      const dir = dirFor(profile);
      mkdirSync(dir, { recursive: true });
      seq += 1;
      // Written once, at a path no other process can also choose. There is no read-modify-write
      // here and that is the fix for SL-39: concurrent appends cannot lose each other.
      writeFileSync(join(dir, `${entryName(seq)}${PENDING}`), JSON.stringify({ text }));

      if (pendingNames(profile).length < BATCH_SIZE) return null;

      const claimed = claim(profile, BATCH_SIZE);
      if (claimed === null) return null; // Another process took the batch; ours is in it.
      return {
        profile,
        texts: claimed.texts,
        convId: convIdFor(profile, claimed.token),
      };
    },

    drain() {
      let profiles: string[];
      try {
        profiles = readdirSync(options.path);
      } catch {
        return [];
      }
      const flushes: Flush[] = [];
      for (const encoded of profiles) {
        const profile = Buffer.from(encoded, 'base64url').toString('utf8');
        if (safeProfileDir(profile) !== encoded) continue; // Not ours; leave it alone.
        const claimed = claim(profile, Number.MAX_SAFE_INTEGER);
        if (claimed !== null) {
          flushes.push({
            profile,
            texts: claimed.texts,
            convId: convIdFor(profile, claimed.token),
          });
        }
      }
      return flushes;
    },

    pending(profile) {
      return pendingNames(profile).length;
    },
  };
}
