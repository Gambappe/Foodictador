/**
 * Relay entrypoint: `npx tsx infra/relay/main.ts`.
 *
 * Required: `RELAY_TOKEN`, and `RELAY_DUMP_PATH` unless `RELAY_EPHEMERAL=1`.
 * Optional: `RELAY_PORT` (default 8787).
 *
 * **D-7 made the relay the store of record, so durability is no longer opt-in** (P0.8).
 * P0.4 persisted only when `RELAY_DUMP_PATH` happened to be set, which meant the
 * difference between "keeps your data" and "loses all of it on restart" was an
 * environment variable nobody had to think about. Now the unsafe mode has to be asked
 * for by name: `RELAY_EPHEMERAL=1` is a statement in the command line, where a reviewer
 * can see it, rather than an omission nobody notices until a restart.
 *
 * Every mutation is written to disk before it is acknowledged — see store.ts and
 * durability.ts for why a periodic flush cannot provide that.
 */

import { RelayStore } from './store.js';
import { createRelayServer } from './server.js';
import { clearStaleTemp, readSnapshot, writeAtomic } from './durability.js';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const token = process.env['RELAY_TOKEN'];
if (token === undefined || token.trim() === '') {
  fail('Missing required environment variable(s): RELAY_TOKEN');
}

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

const port = numericEnv('RELAY_PORT', 8787);
const dumpPath = process.env['RELAY_DUMP_PATH']?.trim();
const ephemeral = process.env['RELAY_EPHEMERAL'] === '1';

if ((dumpPath === undefined || dumpPath === '') && !ephemeral) {
  fail(
    'RELAY_DUMP_PATH is required: D-7 makes the relay the store of record, so a restart ' +
      'must lose nothing. Set RELAY_EPHEMERAL=1 to run without persistence on purpose.',
  );
}

const persistTo = ephemeral ? undefined : dumpPath;

if (persistTo !== undefined && persistTo !== '') {
  // A leftover .tmp is a crash mid-write. The live snapshot is unaffected either way —
  // the rename is atomic — so dropping it just keeps the next crash legible.
  if (clearStaleTemp(persistTo)) {
    process.stderr.write('relay: cleared a leftover .tmp from an interrupted write\n');
  }
}

const store = new RelayStore(
  persistTo === undefined || persistTo === ''
    ? {}
    : { persist: (snapshot) => writeAtomic(persistTo, snapshot) },
);

if (persistTo !== undefined && persistTo !== '') {
  const outcome = readSnapshot(persistTo);
  if (outcome.kind === 'loaded') {
    const { restored, skipped } = store.restore(outcome.json);
    process.stderr.write(
      `relay: restored ${restored} entries from ${persistTo}` +
        `${skipped > 0 ? ` (skipped ${skipped} invalid)` : ''}\n`,
    );
  } else if (outcome.kind === 'unreadable') {
    // Refuse to start. Booting empty would begin overwriting the snapshot on the first
    // write, and on a store of record that turns "we cannot read the file" into "the
    // data is gone" without anyone deciding to.
    fail(
      `relay: ${persistTo} exists but could not be read: ${outcome.error}\n` +
        (outcome.quarantinedAs === null
          ? 'relay: could not move it aside; inspect or remove it before starting.\n'
          : `relay: moved aside to ${outcome.quarantinedAs}; inspect it, then start again.\n`) +
        'relay: refusing to start empty — that would overwrite it on the first write.',
    );
  }
} else {
  process.stderr.write('relay: RELAY_EPHEMERAL=1 — nothing is persisted; a restart loses everything\n');
}

const server = createRelayServer({ token, store }).listen(port, () => {
  process.stderr.write(
    `relay: listening on :${port} (${persistTo !== undefined && persistTo !== '' ? `durable → ${persistTo}` : 'EPHEMERAL'})\n`,
  );
});

// SIGTERM as well as SIGINT: `docker stop`, Kubernetes, and systemd all send SIGTERM,
// and P0.4 handled only SIGINT — so the ordinary way to stop this process was the one
// path that skipped the flush. There is nothing to flush now (every mutation is already
// durable), which is the point: shutdown is just a close, and no data rides on it.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stderr.write(`relay: ${signal} — closing\n`);
    server.close(() => process.exit(0));
    // Do not wait on keep-alive connections forever.
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
