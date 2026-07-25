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
 * ## Publication is a rename too (SL-39, re-opened)
 *
 * "Two processes never write the same path" is a statement about *writers*, and the first fix
 * mistook it for a proof. The loss that survived it was a **reader inside a writer's window**:
 * `writeFileSync` creates the directory entry before it writes the bytes, so a concurrent
 * `claim` could list a name whose file was still empty, rename it, fail to parse it, and drop
 * it as damaged. Measured on the "fixed" code: 427 of 30,000 claims raced an in-flight write,
 * and a six-process barrier destroyed 1 confession in 60.
 *
 * So an entry is written under a `.writing` name and then RENAMED into its pending name. The
 * pending name therefore never exists until the bytes are complete, because rename publishes
 * an already-finished file. Two lines, and it closes the window rather than narrowing it.
 *
 * The general shape, since it caught the same module twice: **on a shared directory, creating
 * a file and filling it are two events, and any name a reader can see is a name a reader can
 * act on.**
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

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Logger } from '../config/logger.js';

/**
 * Confessions per ingest call.
 *
 * Four, not one and not twenty. One is the defect. Twenty means a demo never reaches a flush,
 * because the threshold is only one of two triggers and the other (`pass sweep`) is operator
 * -driven. Twelve reads in one conversation produced a claim spanning four places in the M12
 * measurement, so a handful is comfortably enough material for a synthesis.
 */
export const BATCH_SIZE = 4;

/**
 * Three suffixes, and the transitions between them are all renames.
 *
 * `.writing` → `.json` publishes a complete file (SL-39's re-open: a reader must never see a
 * name whose bytes are still arriving). `.json` → `.taken` claims it for exactly one process.
 */
const WRITING = '.writing';
const PENDING = '.json';
const TAKEN = '.taken';

/**
 * How long a `.taken` file may sit before it is treated as abandoned and deleted.
 *
 * A process that dies between claiming and sending leaves one behind, holding raw confession
 * text that nothing will ever pick up (SL-54). Deleting it is right — the batch is already
 * lost by D-10 — and the delay only has to exceed a plausible ingest, so that a `.taken` file
 * belonging to a LIVE flush in another process is never removed underneath it.
 */
const TAKEN_TTL_MS = 10 * 60 * 1000;

export interface ProseBufferOptions {
  /**
   * Directory holding the per-profile subdirectories. Injectable so tests never touch a real
   * home directory.
   */
  path: string;
  /**
   * Where dropped confessions are reported.
   *
   * Required rather than optional: every catch in this file discards a confession, and §1
   * forbids a silent one. Without it the SL-39 recurrence was invisible — the product lost
   * data and said nothing, which is the reason it took a measurement to find rather than a
   * log line (SL-53).
   */
  logger: Logger;
}

/**
 * What one entry file holds.
 *
 * `readId` is here for `forget` (SL-50): a confession that has been forgotten must not be
 * ingested by the next flush, and without the id on the entry there is nothing to match on —
 * `forget` would report success over a copy it could not see.
 */
export interface BufferedConfession {
  text: string;
  readId?: string;
}

export interface Flush {
  profile: string;
  texts: string[];
  /** Distinct per flush, so each batch is its own conversation and gets its own episode. */
  convId: string;
}

export interface ProseBuffer {
  /**
   * Appends one confession. Returns a flush when the profile has reached `BATCH_SIZE`.
   *
   * `readId` ties the entry to the read it came from so `forget` can remove it before it is
   * ever sent.
   */
  append(profile: string, text: string, readId?: string): Flush | null;
  /** Everything waiting, whatever the size — what `pass sweep` drains. */
  drain(): Flush[];
  /**
   * How many confessions are waiting for this profile.
   *
   * A count of entry FILES. A file that turns out to be unparseable is counted here and will
   * not be delivered, so this is an upper bound rather than a promise (SL-54).
   */
  pending(profile: string): number;
  /**
   * Deletes every buffered confession carrying this read id, and reports how many went.
   *
   * `forget`'s fourth target (SL-50). Without it, `forget` reported success on all three of
   * its targets while a copy of the raw confession waited on disk for the next flush.
   */
  forget(readId: string): number;
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

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The buffer root must be a DIRECTORY, and a wrong one must say so once (SL-51).
 *
 * The layout changed from a single json file to a directory of them, and `CONFIT_PROSE_BUFFER`
 * is an operator-set path that may still point at the old file. Every `append` would then
 * throw `ENOTDIR` for ever — SL-46's blast radius arriving by a new route, with a symptom that
 * names a path rather than the reason. Checked once, at construction, with a message that says
 * what to do.
 */
function assertDirectory(path: string): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return; // Does not exist yet, which is normal — `append` creates it.
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `confession buffer path is a file, not a directory: ${path}. The buffer holds one file ` +
        `per confession (M20), so this must be a directory — point CONFIT_PROSE_BUFFER at one, ` +
        `or delete the old file if it is a pre-M20 buffer.`,
    );
  }
}

export function createProseBuffer(options: ProseBufferOptions): ProseBuffer {
  assertDirectory(options.path);
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

  /** Every profile directory under the root, decoded. Skips anything not written by us. */
  function profiles(): string[] {
    let names: string[];
    try {
      names = readdirSync(options.path);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const encoded of names) {
      const profile = Buffer.from(encoded, 'base64url').toString('utf8');
      if (safeProfileDir(profile) === encoded) out.push(profile);
    }
    return out;
  }

  /** One entry file, or `null` if it is not a readable confession. */
  function readEntry(path: string): BufferedConfession | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const text = record['text'];
      if (typeof text !== 'string') return null;
      const readId = record['readId'];
      return typeof readId === 'string' ? { text, readId } : { text };
    } catch {
      return null;
    }
  }

  /**
   * Removes `.taken` files old enough that no live flush can still own them (SL-54).
   *
   * A `.taken` file is raw confession text with nothing left to send it — the owning process
   * died between the claim and the ingest. Keeping it costs the most sensitive storage in the
   * product for nothing.
   */
  function sweepAbandoned(profile: string, now: number): void {
    const dir = dirFor(profile);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.filter((n) => n.endsWith(TAKEN))) {
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs < TAKEN_TTL_MS) continue;
        rmSync(path, { force: true });
        options.logger.line(
          `buffer: deleted an abandoned claimed confession for ${profile} — a process died ` +
            `between claiming and sending it, so it was already lost (D-10)`,
        );
      } catch (error) {
        options.logger.line(`buffer: could not clean ${name} for ${profile}: ${reason(error)}`);
      }
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
      const entry = readEntry(to);
      if (entry === null) {
        // One lost confession, which D-10 accepts — but NOT silently (§1, SL-53). This is the
        // line that would have made SL-39's recurrence visible without a measurement.
        options.logger.line(
          `buffer: DROPPED an unreadable confession for ${profile} (${name}) — one confession ` +
            `lost, which D-10 accepts; if this repeats, something is writing entries wrongly`,
        );
      } else {
        texts.push(entry.text);
        if (token === '') token = name.slice(0, -PENDING.length);
      }
      // Deleted BEFORE the caller ingests. If the ingest then fails the batch is gone — D-10's
      // accepted loss, and the alternative (hold until confirmed) is the delivery guarantee
      // this file exists not to build.
      try {
        rmSync(to, { force: true });
      } catch (error) {
        options.logger.line(
          `buffer: sent ${name} for ${profile} but could not delete it; it will be cleaned ` +
            `as abandoned: ${reason(error)}`,
        );
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
    append(profile, text, readId) {
      const dir = dirFor(profile);
      mkdirSync(dir, { recursive: true });
      seq += 1;
      const base = join(dir, entryName(seq));
      const entry: BufferedConfession = readId === undefined ? { text } : { text, readId };
      // Written under `.writing`, then RENAMED into the pending name. `writeFileSync` publishes
      // the directory entry before the bytes, so a concurrent claim could otherwise list a name
      // whose file was still empty, rename it, fail to parse it, and drop it as damaged —
      // measured, 427 of 30,000 claims hit that window (SL-39, re-opened). Rename publishes an
      // already-complete file, so the pending name never exists in a partial state.
      writeFileSync(`${base}${WRITING}`, JSON.stringify(entry));
      renameSync(`${base}${WRITING}`, `${base}${PENDING}`);

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
      const flushes: Flush[] = [];
      const now = Date.now();
      for (const profile of profiles()) {
        // Abandoned claims are cleaned here rather than on a timer: a sweep is already the
        // command that owns deferred substrate work, and it is the only thing that runs
        // regularly without a confession to trigger it.
        sweepAbandoned(profile, now);
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

    /**
     * `forget`'s fourth target (SL-50).
     *
     * `forget` deletes from the relay, the pool scope and the personal scope, and reported
     * success on all three while a copy of the raw confession sat here waiting for the next
     * flush — so a forgotten confession was ingested minutes later. Claimed by rename like any
     * other read, because a concurrent flush must not be able to send an entry this is removing.
     */
    forget(readId) {
      let removed = 0;
      for (const profile of profiles()) {
        const dir = dirFor(profile);
        for (const name of pendingNames(profile)) {
          const from = join(dir, name);
          const entry = readEntry(from);
          if (entry?.readId !== readId) continue;
          try {
            // Renamed out first, so a flush racing this cannot read it after the check.
            const taken = `${from}${TAKEN}`;
            renameSync(from, taken);
            rmSync(taken, { force: true });
            removed += 1;
          } catch (error) {
            options.logger.line(
              `buffer: could not forget a buffered confession for ${profile} — it may already ` +
                `be in flight: ${reason(error)}`,
            );
          }
        }
      }
      if (removed > 0) {
        options.logger.line(
          `buffer: forgot ${String(removed)} buffered confession(s) before they were sent`,
        );
      }
      return removed;
    },
  };
}
