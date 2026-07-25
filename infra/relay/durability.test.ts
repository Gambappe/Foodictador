/**
 * P0.8: the relay is the store of record, so a restart must lose nothing.
 *
 * The centrepiece is `survives SIGKILL` at the bottom: a real child process, a real
 * POST, `kill -9`, and a real restart reading the real file. Nothing else proves the
 * claim. Every in-process test here can only show that the pieces behave — a store that
 * persisted on a timer would pass most of them, and that store loses data.
 *
 * Red-verified against the P0.4 implementation this replaces:
 *   - `writeFileSync` in place of `writeAtomic`
 *       → "a failed write leaves the previous snapshot byte-for-byte intact"
 *   - the 10-second timer in place of persist-on-mutation
 *       → "persists inside put" and "survives SIGKILL"
 *
 * That second check is why the spawn below looks the way it does. The first version of
 * this test used `npx tsx`, and npx forks the real interpreter — so `child.kill()` reaped
 * the wrapper while the grandchild kept the port and its in-memory state. The
 * "restarted" relay was the original process answering, and the test passed against an
 * implementation with no durability whatsoever. A test that cannot fail is worse than no
 * test, because it is counted. Hence the direct binary, the process-group kill, and
 * `waitUntilDown` proving the port is free before the restart.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sampleRead } from '../../src/contracts/fixtures/index.js';
import type { Read } from '../../src/contracts/types.js';
import { clearStaleTemp, readSnapshot, writeAtomic } from './durability.js';
import { RelayStore } from './store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-durability-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (id: string): Read => ({ ...sampleRead, read_id: id });

// ---------------------------------------------------------------------------

describe('P0.8: writeAtomic never truncates the live file', () => {
  it('writes the contents where a plain write would', () => {
    const path = join(dir, 'snap.json');
    writeAtomic(path, '{"entries":[]}');
    expect(readFileSync(path, 'utf8')).toBe('{"entries":[]}');
  });

  it('leaves no temp file behind on success', () => {
    const path = join(dir, 'snap.json');
    writeAtomic(path, '{"entries":[]}');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('a failed write leaves the previous snapshot byte-for-byte intact', () => {
    // THE bug this replaces. `writeFileSync(path, …)` truncates the live file and then
    // writes, so a failure in between loses everything rather than just the pending
    // write. Here the write is forced to fail by making the *temp* path a directory,
    // which no writer that goes straight at `path` would even notice — and that is the
    // point: against the old implementation the target is happily overwritten and this
    // test fails.
    const path = join(dir, 'snap.json');
    writeAtomic(path, '{"entries":["first"]}');
    execFileSync('mkdir', ['-p', `${path}.tmp`]);

    expect(() => writeAtomic(path, '{"entries":["second"]}')).toThrow();

    expect(readFileSync(path, 'utf8')).toBe('{"entries":["first"]}');
  });

  it('repeated overwrites each land whole', () => {
    // A regression guard rather than a proof of atomicity — observing a torn write needs
    // a concurrent reader. The discriminating test is the one above.
    const path = join(dir, 'snap.json');
    for (let i = 0; i < 25; i += 1) {
      writeAtomic(path, JSON.stringify({ entries: Array.from({ length: i }, (_, n) => `e${n}`) }));
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        entries: Array.from({ length: i }, (_, n) => `e${n}`),
      });
    }
  });
});

describe('P0.8: readSnapshot tells absent apart from unreadable', () => {
  it('absent when there is no file — a first boot is not an error', () => {
    expect(readSnapshot(join(dir, 'nope.json')).kind).toBe('absent');
  });

  it('loaded returns the raw json', () => {
    const path = join(dir, 'snap.json');
    writeFileSync(path, '{"entries":[]}');
    const outcome = readSnapshot(path);
    expect(outcome.kind).toBe('loaded');
    expect(outcome.kind === 'loaded' && outcome.json).toBe('{"entries":[]}');
  });

  it('quarantines a corrupt snapshot instead of leaving it to be overwritten', () => {
    const path = join(dir, 'snap.json');
    writeFileSync(path, '{"entries":[{"read"'); // truncated, as a torn write would be
    const outcome = readSnapshot(path, { now: () => new Date('2026-07-25T10:00:00Z') });

    expect(outcome.kind).toBe('unreadable');
    const quarantined = outcome.kind === 'unreadable' ? outcome.quarantinedAs : null;
    expect(quarantined).not.toBeNull();
    // The bytes are preserved somewhere an operator can find them…
    expect(readFileSync(String(quarantined), 'utf8')).toBe('{"entries":[{"read"');
    // …and moved off the live path, so nothing can silently write over the evidence.
    expect(existsSync(path)).toBe(false);
  });

  it('two corrupt boots do not overwrite the first quarantine', () => {
    const path = join(dir, 'snap.json');
    writeFileSync(path, 'garbage-one');
    readSnapshot(path, { now: () => new Date('2026-07-25T10:00:00Z') });
    writeFileSync(path, 'garbage-two');
    readSnapshot(path, { now: () => new Date('2026-07-25T11:00:00Z') });

    const quarantines = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    expect(quarantines).toHaveLength(2);
  });
});

describe('P0.8: clearStaleTemp', () => {
  it('removes a leftover temp and reports it', () => {
    const path = join(dir, 'snap.json');
    writeFileSync(`${path}.tmp`, 'partial');
    expect(clearStaleTemp(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('is quiet when there is nothing to clear', () => {
    expect(clearStaleTemp(join(dir, 'snap.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('P0.8: the store persists before it returns, not after', () => {
  it('persists inside put, so an acknowledgement implies a durable write', () => {
    const order: string[] = [];
    const store = new RelayStore({
      persist: () => order.push('persisted'),
    });
    store.put(read('r1'));
    order.push('put returned');
    // A timer-based flush inverts these two, which is exactly how a client ends up
    // holding a 201 for a read that is not anywhere.
    expect(order).toEqual(['persisted', 'put returned']);
  });

  it('a persist failure rejects the mutation and rolls the entry back', () => {
    const store = new RelayStore({
      persist: () => {
        throw new Error('disk full');
      },
    });
    expect(() => store.put(read('r1'))).toThrow('disk full');
    // Not "accepted but unsaved": the caller gets an error AND the store agrees the
    // write did not happen, so a retry is not a duplicate and a read is not a lie.
    expect(store.list()).toHaveLength(0);
    expect(store.stats().count).toBe(0);
  });

  it('a persist failure rolls back a SETTING too, not just a read', () => {
    // D-8 put declared settings in this store, and they ride on the same mutate().
    // Rolling back only `entries` meant a failed settingsPut threw at the caller and
    // left the value in memory, where the next successful mutation would persist it:
    // "your change failed", then the change takes effect. For an allergy list that is
    // the worst inversion available.
    let fail = false;
    const store = new RelayStore({
      persist: () => {
        if (fail) throw new Error('disk full');
      },
    });
    store.settingsPut('A', 'allergies', ['peanut']);
    fail = true;
    expect(() => store.settingsPut('A', 'allergies', ['peanut', 'shellfish'])).toThrow();
    expect(store.settingsGet('A', 'allergies')).toEqual(['peanut']);

    // And the rejected value must not reappear on the next write that does persist.
    fail = false;
    store.put(read('r1'));
    expect(store.settingsGet('A', 'allergies')).toEqual(['peanut']);
  });

  it('a persist failure on a later write does not lose the earlier ones', () => {
    let fail = false;
    const store = new RelayStore({
      persist: () => {
        if (fail) throw new Error('disk full');
      },
    });
    store.put(read('r1'));
    fail = true;
    expect(() => store.put(read('r2'))).toThrow();
    expect(store.list().map((e) => e.read.read_id)).toEqual(['r1']);
  });

  it('persists on setJob, drop, seed, reset and settingsPut — not just put', () => {
    const snapshots: string[] = [];
    const store = new RelayStore({ persist: (s) => snapshots.push(s) });
    store.put(read('r1'));
    store.setJob('r1', 'job-1');
    store.seed([read('r2'), read('r3')]);
    store.drop('r2');
    store.settingsPut('A', 'usual', { offLimits: ['shellfish'] });
    store.reset();
    expect(snapshots).toHaveLength(6);
    // `reset` clears reads. It does NOT clear settings, and it must not: `pass reset` empties
    // the pool between demos, and silently wiping a user's declared allergies with it would
    // be the worst possible reading of "reset" (D-8).
    expect(JSON.parse(String(snapshots.at(-1)))).toEqual({
      entries: [],
      settings: { 'A\u0000usual': { offLimits: ['shellfish'] } },
    });
  });

  it('settings survive a restore, and a pre-settings snapshot restores as empty', () => {
    const written: string[] = [];
    const first = new RelayStore({ persist: (s) => written.push(s) });
    first.settingsPut('A', 'usual', { offLimits: ['shellfish'], giConstraint: true });
    first.settingsPut('B', 'meal_log', [{ dishId: 'pho', placeId: 'phos_deep', at: '2026-07-01' }]);

    const revived = new RelayStore();
    revived.restore(String(written.at(-1)));
    expect(revived.settingsGet('A', 'usual')).toEqual({
      offLimits: ['shellfish'],
      giConstraint: true,
    });
    expect(revived.settingsGet('B', 'meal_log')).toHaveLength(1);
    expect(revived.settingsGet('A', 'meal_log')).toBeNull();
    // One profile cannot read another's key, and an absent key is null rather than a throw.
    expect(revived.settingsGet('C', 'usual')).toBeNull();

    // A snapshot written before settings existed has no `settings` field at all. Restoring
    // it must mean "no settings", not a crash on boot — which for this store would mean
    // refusing to start (see the corrupt-snapshot path).
    const old = new RelayStore();
    expect(() => old.restore('{"entries":[]}')).not.toThrow();
    expect(old.settingsGet('A', 'usual')).toBeNull();
  });

  it('a NUL in a profile id cannot forge another profile\'s key', () => {
    // The keys are `profile\u0000key`. A naive `profile + ':' + key` join lets the profile
    // id `A:usual` collide with profile `A`'s `usual` — writing one would overwrite the
    // other's allergy list.
    const store = new RelayStore();
    store.settingsPut('A', 'usual', { real: true });
    store.settingsPut('A\u0000usual', 'x', { forged: true });
    expect(store.settingsGet('A', 'usual')).toEqual({ real: true });
  });

  it('does not rewrite the snapshot for a setJob on an unknown read', () => {
    let writes = 0;
    const store = new RelayStore({ persist: () => (writes += 1) });
    store.put(read('r1'));
    expect(store.setJob('nope', 'job-1')).toBe(false);
    expect(store.drop('nope')).toBe(false);
    expect(writes).toBe(1); // the put only
  });

  it('seeding a batch writes one snapshot, not one per read', () => {
    // The snapshot is a whole-file rewrite, so per-read persistence would make seeding
    // thousands of reads quadratic in earnest rather than in principle.
    let writes = 0;
    const store = new RelayStore({ persist: () => (writes += 1) });
    store.seed([read('r1'), read('r2'), read('r3')]);
    expect(writes).toBe(1);
    expect(store.list()).toHaveLength(3);
  });

  it('restore does not write back the file it just read', () => {
    let writes = 0;
    const store = new RelayStore({ persist: () => (writes += 1) });
    store.restore(JSON.stringify({ entries: [{ read: read('r1'), received_at: '2026-07-25T10:00:00Z' }] }));
    expect(writes).toBe(0);
    expect(store.list()).toHaveLength(1);
  });

  it('still works with no persist hook at all (ephemeral mode)', () => {
    const store = new RelayStore();
    store.put(read('r1'));
    expect(store.list()).toHaveLength(1);
  });

  it('keeps P0.4’s clock-only constructor working', () => {
    const store = new RelayStore(() => new Date('2026-07-25T10:00:00Z'));
    expect(store.put(read('r1')).received_at).toBe('2026-07-25T10:00:00.000Z');
  });
});

describe('P0.8: store + file, round trip', () => {
  it('a new store reading the file sees everything the old one wrote', () => {
    const path = join(dir, 'snap.json');
    const write = new RelayStore({
      now: () => new Date('2026-07-25T10:00:00Z'),
      persist: (snapshot) => writeAtomic(path, snapshot),
    });
    write.put(read('r1'));
    write.put(read('r2'));
    write.setJob('r2', 'job-2');

    const outcome = readSnapshot(path);
    expect(outcome.kind).toBe('loaded');
    const reloaded = new RelayStore();
    reloaded.restore(outcome.kind === 'loaded' ? outcome.json : '{}');

    expect(reloaded.list().map((e) => e.read.read_id).sort()).toEqual(['r1', 'r2']);
    // Metadata survives, so the stuck-entry signal and D-1's job annotation are not
    // quietly reset by a restart.
    expect(reloaded.list().find((e) => e.read.read_id === 'r2')?.ingest_job_id).toBe('job-2');
    expect(reloaded.list()[0]?.received_at).toBe('2026-07-25T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// The one that actually proves it.

// SL-14: `.pathname` URL-encodes spaces as `%20`, which spawn() cannot open —
// `fileURLToPath` decodes it back to a real path on any checkout.
const RELAY_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

/**
 * Spawned via the `tsx` binary directly and in its own process group.
 *
 * Not `npx tsx`: npx is a wrapper that forks the real interpreter, so `child.kill()`
 * reaps the wrapper and leaves a grandchild holding the port and its in-memory state.
 * The first version of this test did exactly that — the "restarted" relay was the
 * original process answering on the same port, so the test passed against an
 * implementation with no durability at all. Hence `detached` plus a group kill, and
 * `waitUntilDown` below to prove the port is genuinely free before restarting.
 */
interface Started {
  pid: number;
  stop: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function isUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/stats`)).ok;
  } catch {
    return false;
  }
}

async function startRelay(port: number, env: Record<string, string>): Promise<Started> {
  const child = spawn(TSX, [RELAY_MAIN], {
    env: { ...process.env, RELAY_TOKEN: 't0ken', RELAY_PORT: String(port), ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const pid = child.pid ?? 0;
  const stop = (): void => {
    try {
      process.kill(-pid, 'SIGKILL'); // the whole group, not just the leader
    } catch {
      /* already gone */
    }
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`relay exited ${child.exitCode}: ${stderr}`);
    if (await isUp(port)) return { pid, stop };
    await sleep(100);
  }
  stop();
  throw new Error(`relay did not start: ${stderr}`);
}

/** Refuses to continue until nothing answers on the port. */
async function waitUntilDown(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!(await isUp(port))) return;
    await sleep(100);
  }
  throw new Error(`something is still serving :${port} — the kill did not take`);
}

describe('P0.8 acceptance: a restart loses nothing', () => {
  it(
    'survives SIGKILL with no graceful shutdown and comes back with the reads',
    async () => {
      const path = join(dir, 'relay.json');
      const port = 8900 + (process.pid % 80);

      const first = await startRelay(port, { RELAY_DUMP_PATH: path });
      const post = await fetch(`http://127.0.0.1:${port}/reads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 't0ken', read: read('survivor-1') }),
      });
      expect(post.status).toBe(201);

      // SIGKILL the whole group: no handler runs, no flush, no chance to tidy up. This
      // is the difference between "we write on shutdown" and "it is already written".
      first.stop();
      await waitUntilDown(port);

      // The write must be on disk already — nothing ran after the 201.
      expect(existsSync(path)).toBe(true);

      const second = await startRelay(port, { RELAY_DUMP_PATH: path });
      try {
        // A different process, so this cannot be the first one answering.
        expect(second.pid).not.toBe(first.pid);
        const entries = (await (await fetch(`http://127.0.0.1:${port}/reads`)).json()) as Array<{
          read: { read_id: string };
        }>;
        expect(entries.map((e) => e.read.read_id)).toEqual(['survivor-1']);
      } finally {
        second.stop();
        await waitUntilDown(port);
      }
    },
    120_000,
  );

  it(
    'refuses to start without a dump path, so losing everything cannot be an oversight',
    async () => {
      await expect(startRelay(8900 + (process.pid % 80) + 100, {})).rejects.toThrow(
        /RELAY_DUMP_PATH is required/,
      );
    },
    60_000,
  );

  it(
    'refuses to start on an unreadable snapshot rather than booting empty over it',
    async () => {
      // Booting empty would overwrite the file on the first write, turning "we could not
      // read it" into "it is gone" with nobody deciding to.
      const path = join(dir, 'corrupt.json');
      writeFileSync(path, '{"entries":[{"read"');
      await expect(
        startRelay(8900 + (process.pid % 80) + 200, { RELAY_DUMP_PATH: path }),
      ).rejects.toThrow(/could not be read/);
      // Preserved, not clobbered.
      expect(readdirSync(dir).filter((n) => n.includes('.corrupt-'))).toHaveLength(1);
    },
    60_000,
  );
});
