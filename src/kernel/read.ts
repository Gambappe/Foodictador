/**
 * Read validation and identity (K1). Pure kernel: no I/O, no clock.
 *
 * `parseRead` is the boundary parser every write path runs before a read touches
 * the pool or the relay — closed to extra properties against READ_KEYS (imported,
 * never re-declared), enums checked against the contract vocabularies, weight a
 * finite number in [0,1].
 */

import {
  CADENCES,
  DRIVERS,
  READ_KEYS,
  SIGNALS,
  type Cadence,
  type Driver,
  type Read,
  type ReadKey,
  type Signal,
} from '../contracts/types.js';

/** Client-minted at approval; identifies the read and nothing else ([E20]). */
export function mintReadId(): string {
  return crypto.randomUUID();
}

function isReadKey(key: string): key is ReadKey {
  return (READ_KEYS as readonly string[]).includes(key);
}

function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: ReadKey,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`read.${field} ${JSON.stringify(value)} is not a known ${field}`);
  }
  return value as T;
}

export function parseRead(value: unknown): Read {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('read must be a plain object');
  }
  const record = value as Record<string, unknown>;

  const extra = Object.keys(record).filter((key) => !isReadKey(key));
  if (extra.length > 0) {
    throw new Error(`read has unexpected field(s): ${extra.join(', ')}`);
  }
  for (const key of READ_KEYS) {
    if (!(key in record)) throw new Error(`read is missing "${key}"`);
  }

  const readId = record['read_id'];
  if (typeof readId !== 'string' || readId === '') {
    throw new Error('read.read_id must be a non-empty string');
  }
  const place = record['place'];
  if (typeof place !== 'string' || place === '') {
    throw new Error('read.place must be a non-empty corpus slug');
  }
  const signal: Signal = enumField(record['signal'], SIGNALS, 'signal');
  const driver: Driver = enumField(record['driver'], DRIVERS, 'driver');
  const cadence: Cadence = enumField(record['cadence'], CADENCES, 'cadence');

  const weight = record['weight'];
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new Error(`read.weight must be a finite number in [0,1], got ${JSON.stringify(weight)}`);
  }

  return { read_id: readId, place, signal, driver, cadence, weight };
}
