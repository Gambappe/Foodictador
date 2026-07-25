/**
 * Seed loader (S3) — pushes the S2 artifacts to the XTrace pool scope and the
 * relay, ahead of a demo (design v0.8 §11: induction operates over the pool,
 * so seed HOURS ahead — the closing message names when induction will be warm).
 *
 * Re-running is safe, but NOT because of upserts: XTrace ingest has none, so a
 * second run creates duplicate pool records. They carry the same `read_id`,
 * and K6's dedup is what keeps the census stable — do not attempt upsert
 * against an API that does not offer it. A detected re-run prints a warning.
 *
 * The relay is seeded FIRST (one bulk call): a pool write that then fails
 * leaves its relay entry in place, and M7's sweeper re-ingests from it — the
 * loader's failure report says exactly that.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { PoolStore, Relay } from '../../src/contracts/modules.js';
import type { Read } from '../../src/contracts/types.js';
import type { Logger } from '../../src/config/logger.js';
import { parseRead } from '../../src/kernel/read.js';

const BATCH_SIZE = 25;

export interface LoadSeedsDeps {
  pool: PoolStore;
  relay: Relay;
  logger: Logger;
  settleWindowSeconds: number;
  now: () => Date;
}

export interface LoadReport {
  total: number;
  relaySeeded: number;
  poolLoaded: number;
  /** read_ids whose POOL write failed — the relay copy remains, the sweeper recovers them. */
  failed: string[];
  rerunDetected: boolean;
  warmAt: string;
}

export function readSeedArtifact(path?: string): Read[] {
  const url = path ?? new URL('../../data/seeds/reads.json', import.meta.url).pathname;
  const raw = JSON.parse(readFileSync(url, 'utf8')) as { reads?: unknown[] };
  return (raw.reads ?? []).map((candidate) => parseRead(candidate));
}

export async function loadSeeds(reads: Read[], deps: LoadSeedsDeps): Promise<LoadReport> {
  const seedIds = new Set(reads.map((read) => read.read_id));
  const existing = await deps.relay.list();
  const rerunDetected = existing.some((entry) => seedIds.has(entry.read.read_id));
  if (rerunDetected) {
    deps.logger.line(
      'load-seeds: re-run detected (seed reads already on the relay) — pool duplicates will be created; K6 dedup keeps the census stable',
    );
  }

  const relaySeeded = await deps.relay.seed(reads);
  deps.logger.line(`load-seeds: relay seeded with ${relaySeeded} read(s)`);

  const failed: string[] = [];
  let poolLoaded = 0;
  for (let start = 0; start < reads.length; start += BATCH_SIZE) {
    const batch = reads.slice(start, start + BATCH_SIZE);
    for (const read of batch) {
      try {
        await deps.pool.writeRead(read);
        poolLoaded += 1;
      } catch (error) {
        failed.push(read.read_id);
        deps.logger.line(
          `load-seeds: pool write failed for ${read.read_id} (relay copy remains; sweeper will re-ingest): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    deps.logger.line(
      `load-seeds: batch ${Math.floor(start / BATCH_SIZE) + 1}/${Math.ceil(reads.length / BATCH_SIZE)} — ${poolLoaded}/${reads.length} pooled`,
    );
  }

  const warmAt = new Date(
    deps.now().getTime() + deps.settleWindowSeconds * 1000,
  ).toISOString();
  deps.logger.line(
    `load-seeds: done — ${poolLoaded}/${reads.length} pooled, ${failed.length} failed. ` +
      `Reads are countable NOW (the relay is the store, D-7). Only induction waits: ` +
      `settle window ${deps.settleWindowSeconds}s, warm no earlier than ${warmAt}. ` +
      `Seed hours ahead for a good induced claim, not to make the demo work.`,
  );
  return {
    total: reads.length,
    relaySeeded,
    poolLoaded,
    failed,
    rerunDetected,
    warmAt,
  };
}

async function main(): Promise<void> {
  const [{ loadConfig }, { createLogger }, clientModule, poolModule, relayModule] =
    await Promise.all([
      import('../../src/config/env.js'),
      import('../../src/config/logger.js'),
      import('../../src/memory/client.js'),
      import('../../src/memory/pool.js'),
      import('../../src/memory/relay.js'),
    ]);
  const config = loadConfig(); // throws naming any missing variable
  const logger = createLogger();
  const client = clientModule.createMemoryClient(
    clientModule.createFetchTransport({ baseUrl: config.xtraceBaseUrl, apiKey: config.xtraceApiKey }),
  );
  const report = await loadSeeds(readSeedArtifact(), {
    pool: poolModule.createPoolStore({ client, logger }),
    relay: relayModule.createRelayClient({ url: config.relayUrl, token: config.relayToken, logger }),
    logger,
    settleWindowSeconds: config.settleWindowSeconds,
    now: () => new Date(),
  });
  process.exit(report.failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
