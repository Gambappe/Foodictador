/**
 * Relay entrypoint: `npx tsx infra/relay/main.ts`.
 * RELAY_TOKEN is required; RELAY_PORT defaults to 8787. If RELAY_DUMP_PATH is set,
 * the store loads from it on boot and dumps periodically plus on SIGINT — in-memory
 * with a JSON dump is the specced durability level (the relay is transport, not
 * memory; XTrace remains the sole durable store).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { RelayStore } from './store.js';
import { createRelayServer } from './server.js';

const token = process.env['RELAY_TOKEN'];
if (token === undefined || token.trim() === '') {
  process.stderr.write('Missing required environment variable(s): RELAY_TOKEN\n');
  process.exit(1);
}

const port = Number(process.env['RELAY_PORT'] ?? '8787');
const dumpPath = process.env['RELAY_DUMP_PATH'];
const dumpIntervalMs = Number(process.env['RELAY_DUMP_INTERVAL_MS'] ?? '10000');

const store = new RelayStore();
if (dumpPath !== undefined && dumpPath !== '' && existsSync(dumpPath)) {
  store.restore(readFileSync(dumpPath, 'utf8'));
  process.stderr.write(`relay: restored ${store.stats().count} entries from ${dumpPath}\n`);
}

function dump(): void {
  if (dumpPath === undefined || dumpPath === '') return;
  writeFileSync(dumpPath, store.serialize());
}

if (dumpPath !== undefined && dumpPath !== '') {
  setInterval(dump, dumpIntervalMs).unref();
}

process.on('SIGINT', () => {
  dump();
  process.exit(0);
});

createRelayServer({ token, store }).listen(port, () => {
  process.stderr.write(`relay: listening on :${port}\n`);
});
