/**
 * Durable snapshots for the relay (P0.8) — D-7 made the relay the store of record.
 *
 * P0.4 built persistence as `writeFileSync` on a 10-second timer, which was the right
 * amount of machinery for a settle-window buffer and is the wrong amount for a store of
 * record. It has two independent ways to lose data:
 *
 *   1. **The timer.** Up to ten seconds of accepted writes are in memory only. The
 *      client already has its 201.
 *   2. **The write itself.** `writeFileSync` truncates and then writes. A crash in
 *      between leaves a half-written file, `JSON.parse` throws on the next boot, and the
 *      loss is not ten seconds — it is *everything*.
 *
 * The second is the worse bug and the less obvious one: adding `fsync` or shortening the
 * interval would not fix it. Only never truncating the live file fixes it.
 *
 * So: write a temp file, fsync it, rename it over the target, then fsync the directory.
 * `rename(2)` is atomic within a filesystem, so a reader sees either the whole old
 * snapshot or the whole new one, never a splice of the two. The directory fsync is the
 * step that is usually skipped — without it the rename itself can still be in the page
 * cache when power is lost, and the file reverts.
 *
 * Cost, stated plainly: this rewrites the entire snapshot on every mutation, so writes
 * are O(n) in entries held and the relay is O(n²) over a run. At demo scale — thousands
 * of reads, a few hundred KB — that is microseconds per write and worth it for a
 * guarantee this simple to verify. An append-only journal with compaction is the shape
 * this wants at real volume; it is also several more failure modes (torn tail records,
 * replay ordering, compaction crashes), and none of them are worth taking on for a
 * relay that holds a demo.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Where a snapshot came from, so the caller can say something true at boot. */
export type LoadOutcome =
  | { kind: 'loaded'; json: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; error: string; quarantinedAs: string | null };

export interface SnapshotFileDeps {
  /** Only for naming a quarantined file, so a boot with a corrupt snapshot is reproducible. */
  now?: () => Date;
}

/**
 * Writes `contents` to `path` atomically.
 *
 * Throws rather than swallowing: the caller is a mutation that has not yet answered the
 * client, and a write it cannot persist is a write it must not acknowledge.
 */
export function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.tmp`;
  // Truncate-and-write is safe *here* precisely because this is not the live file.
  writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600 });

  // fsync the data before the rename publishes it, or the rename can land while the
  // bytes it points at are still only in the page cache.
  const fileFd = openSync(temp, 'r+');
  try {
    fsyncSync(fileFd);
  } finally {
    closeSync(fileFd);
  }

  renameSync(temp, path);

  // And fsync the directory, so the rename survives too. Skipping this is the classic
  // "I called fsync and still lost the file" bug.
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } catch {
    // Directory fsync is not permitted on every platform or filesystem (notably some
    // Windows and network mounts). The rename has already happened; degrading to "durable
    // once the OS flushes" beats refusing the write outright.
  } finally {
    closeSync(dirFd);
  }
}

/**
 * Reads a snapshot, distinguishing "no file yet" from "a file we could not use".
 *
 * A corrupt snapshot is never overwritten in place. It is renamed aside so an operator
 * can look at it, because the alternative — boot, ignore, and start writing — destroys
 * the only evidence of what went wrong on a store of record.
 */
export function readSnapshot(path: string, deps: SnapshotFileDeps = {}): LoadOutcome {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { kind: 'absent' };
    return { kind: 'unreadable', error: message(error), quarantinedAs: null };
  }

  try {
    JSON.parse(raw);
  } catch (error) {
    const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${path}.corrupt-${stamp}`;
    try {
      renameSync(path, quarantine);
      return { kind: 'unreadable', error: message(error), quarantinedAs: quarantine };
    } catch {
      return { kind: 'unreadable', error: message(error), quarantinedAs: null };
    }
  }

  return { kind: 'loaded', json: raw };
}

/**
 * Removes a leftover temp file from a crash mid-write.
 *
 * It is never the live snapshot — the rename either happened or it did not — so it is
 * always safe to drop, and leaving it means the next crash cannot be told from this one.
 */
export function clearStaleTemp(path: string): boolean {
  try {
    unlinkSync(`${path}.tmp`);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
